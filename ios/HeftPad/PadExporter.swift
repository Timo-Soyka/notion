import UIKit
import WebKit
import PDFKit

// PDF-Fassung eines Eintrags erzeugen – wie am Mac (Sources/Heft/Exporter.swift):
// Eine unsichtbare Web-Ansicht lädt den Eintrag in der Druckansicht, WebKit
// setzt ihn auf Seiten, danach kommen Seitenzahlen und Kopfzeile dazu.

struct PrintMeta {
    var title = ""
    var subject = ""
    var date = ""
    var name = ""
    var font = "sans"
}

final class PadExporter: NSObject, WKNavigationDelegate {
    private static var running: [PadExporter] = []

    private var webView: WKWebView!
    private var bridge: PadBridge!
    private let uuid: String
    private let completion: (Result<(Data, PrintMeta), Error>) -> Void
    private var timeoutWork: DispatchWorkItem?
    private var finished = false

    private init(uuid: String, completion: @escaping (Result<(Data, PrintMeta), Error>) -> Void) {
        self.uuid = uuid
        self.completion = completion
    }

    static func makePDF(uuid: String, completion: @escaping (Result<(Data, PrintMeta), Error>) -> Void) {
        DispatchQueue.main.async {
            let e = PadExporter(uuid: uuid, completion: completion)
            running.append(e)
            e.start()
        }
    }

    // MARK: - Seiteneinstellungen

    static var pdfSettings: [String: Any] { MirrorStore.shared.settings()["pdf"] as? [String: Any] ?? [:] }

    static func paperSize() -> CGSize {
        switch (pdfSettings["paper"] as? String) ?? "A4" {
        case "A5": return CGSize(width: 419.53, height: 595.28)
        case "Letter": return CGSize(width: 612, height: 792)
        default: return CGSize(width: 595.28, height: 841.89)
        }
    }

    static func margins() -> UIEdgeInsets {
        let p = pdfSettings
        let cm: (String, Double) -> CGFloat = { key, def in CGFloat(((p[key] as? NSNumber)?.doubleValue ?? def) * 28.3465) }
        return UIEdgeInsets(top: cm("top", 3), left: cm("left", 2.5), bottom: cm("bottom", 3), right: cm("right", 2.5))
    }

    private func start() {
        let paper = Self.paperSize()
        let m = Self.margins()
        // So breit wie am Mac vorbereiten, damit der Text gleich umbricht
        let cssWidth = (paper.width - m.left - m.right) * 1.25
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(PadSchemeHandler(), forURLScheme: "heft")
        bridge = PadBridge(printCallback: { [weak self] meta in self?.ready(meta) })
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "heft")
        cfg.userContentController.addUserScript(WKUserScript(source: "window.HeftPlatform = 'ipad';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: cssWidth, height: 1200), configuration: cfg)
        webView.navigationDelegate = self
        webView.overrideUserInterfaceStyle = .light
        webView.isUserInteractionEnabled = false
        // Muss im Fenster hängen, damit WebKit zeichnet – unsichtbar hinter allem
        webView.alpha = 0.01
        if let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first {
            window.insertSubview(webView, at: 0)
        }
        webView.load(URLRequest(url: URL(string: "heft://app/index.html?print=\(uuid)")!))
        let t = DispatchWorkItem { [weak self] in self?.fail(Self.err("Die Druckansicht wurde nicht rechtzeitig fertig.")) }
        timeoutWork = t
        DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: t)
    }

    static func err(_ msg: String) -> NSError { NSError(domain: "Heft", code: 4, userInfo: [NSLocalizedDescriptionKey: msg]) }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }

    private func ready(_ info: [String: Any]) {
        guard !finished else { return }
        if let ok = info["ok"] as? Bool, !ok {
            fail(Self.err((info["error"] as? String) ?? "Eintrag konnte nicht geladen werden"))
            return
        }
        var meta = PrintMeta()
        meta.title = info["title"] as? String ?? ""
        meta.subject = info["subject"] as? String ?? ""
        meta.date = info["date"] as? String ?? ""
        meta.name = info["name"] as? String ?? ""
        meta.font = info["font"] as? String ?? "sans"
        // Einen Moment warten, damit KaTeX-Schriften sicher gezeichnet sind
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.printToPDF(meta) }
    }

    private func printToPDF(_ meta: PrintMeta) {
        let paper = CGRect(origin: .zero, size: Self.paperSize())
        let m = Self.margins()
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: paper.inset(by: m)), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
        for i in 0..<renderer.numberOfPages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: i, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        let raw = data as Data
        guard renderer.numberOfPages > 0 else { fail(Self.err("Drucken in PDF fehlgeschlagen.")); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let out = Self.decorate(raw, meta: meta)
            DispatchQueue.main.async { self.succeed(out, meta) }
        }
    }

    private func succeed(_ data: Data, _ meta: PrintMeta) {
        guard !finished else { return }
        finished = true
        timeoutWork?.cancel()
        completion(.success((data, meta)))
        cleanup()
    }

    private func fail(_ error: Error) {
        guard !finished else { return }
        finished = true
        timeoutWork?.cancel()
        completion(.failure(error))
        cleanup()
    }

    private func cleanup() {
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView?.removeFromSuperview()
        Self.running.removeAll { $0 === self }
    }

    // MARK: - Seitenzahlen und Kopfzeile

    static func decorate(_ pdf: Data, meta: PrintMeta) -> Data {
        guard let doc = PDFDocument(data: pdf), doc.pageCount > 0 else { return pdf }
        let p = pdfSettings
        let numbering = (p["pageNumbers"] as? String) ?? "von"
        let header = (p["header"] as? String) ?? "none"
        let m = margins()
        let out = NSMutableData()
        guard let consumer = CGDataConsumer(data: out as CFMutableData) else { return pdf }
        var first = doc.page(at: 0)!.bounds(for: .mediaBox)
        let info: [CFString: Any] = [
            kCGPDFContextTitle: meta.title, kCGPDFContextCreator: "Heft",
            kCGPDFContextAuthor: meta.name, kCGPDFContextSubject: meta.subject
        ]
        guard let ctx = CGContext(consumer: consumer, mediaBox: &first, info as CFDictionary) else { return pdf }
        let total = doc.pageCount
        // Links einsammeln und beim Neuzeichnen direkt ins PDF schreiben
        var urlLinks: [Int: [(CGRect, URL)]] = [:]
        var jumpLinks: [Int: [(CGRect, String)]] = [:]
        var targets: [Int: [String: CGPoint]] = [:]
        for i in 0..<total {
            guard let page = doc.page(at: i) else { continue }
            for ann in page.annotations where ann.type == "Link" {
                if let url = ann.url ?? (ann.action as? PDFActionURL)?.url {
                    urlLinks[i, default: []].append((ann.bounds, url))
                } else if let dest = (ann.action as? PDFActionGoTo)?.destination ?? ann.destination, let tp = dest.page {
                    let idx = doc.index(for: tp)
                    guard idx != NSNotFound else { continue }
                    let top = tp.bounds(for: .mediaBox).maxY
                    let y = dest.point.y.isFinite && dest.point.y < 1e6 ? min(dest.point.y + 6, top) : top
                    let name = "ziel-\(idx)-\(Int(y))"
                    targets[idx, default: [:]][name] = CGPoint(x: 0, y: y)
                    jumpLinks[i, default: []].append((ann.bounds, name))
                }
            }
        }
        let font: UIFont = meta.font == "mono" ? UIFont.monospacedSystemFont(ofSize: 9.5, weight: .regular)
            : meta.font == "serif" ? (UIFont(name: "NewYork-Regular", size: 9.5) ?? UIFont.systemFont(ofSize: 9.5))
            : UIFont.systemFont(ofSize: 9.5)
        let grey = UIColor(white: 0.35, alpha: 1)
        for i in 0..<total {
            guard let page = doc.page(at: i) else { continue }
            var box = page.bounds(for: .mediaBox)
            let boxData = Data(bytes: &box, count: MemoryLayout<CGRect>.size) as CFData
            ctx.beginPDFPage([kCGPDFContextMediaBox: boxData] as CFDictionary)
            page.draw(with: .mediaBox, to: ctx)
            for (name, point) in targets[i] ?? [:] { ctx.addDestination(name as CFString, at: point) }
            for (rect, url) in urlLinks[i] ?? [] { ctx.setURL(url as CFURL, for: rect) }
            for (rect, name) in jumpLinks[i] ?? [] { ctx.setDestination(name as CFString, for: rect) }
            // UIKit zeichnet von oben nach unten – Koordinaten umdrehen
            ctx.saveGState()
            ctx.translateBy(x: 0, y: box.height)
            ctx.scaleBy(x: 1, y: -1)
            UIGraphicsPushContext(ctx)
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: grey, .paragraphStyle: para]
            var pageText = ""
            switch numbering {
            case "von": pageText = "\(i + 1) von \(total)"
            case "seite": pageText = "Seite \(i + 1)"
            case "plain": pageText = "\(i + 1)"
            default: break
            }
            if !pageText.isEmpty {
                let y = max(14, m.bottom / 2 - 5)
                (pageText as NSString).draw(in: CGRect(x: 0, y: box.height - y - 14, width: box.width, height: 14), withAttributes: attrs)
            }
            var headText = ""
            switch header {
            case "title": headText = meta.title
            case "subject": headText = [meta.subject, meta.title].filter { !$0.isEmpty }.joined(separator: " · ")
            case "full": headText = [meta.name, meta.subject, meta.date].filter { !$0.isEmpty }.joined(separator: " · ")
            default: break
            }
            if !headText.isEmpty && !(i == 0 && header == "title") {
                let y = box.height - max(24, m.top / 2 + 4)
                (headText as NSString).draw(in: CGRect(x: m.left, y: box.height - y - 14, width: box.width - m.left - m.right, height: 14), withAttributes: attrs)
            }
            UIGraphicsPopContext()
            ctx.restoreGState()
            ctx.endPDFPage()
        }
        ctx.closePDF()
        return out as Data
    }
}
