import AppKit
import WebKit
import PDFKit

// PDF-Fassung eines Eintrags erzeugen.
//
// Ein unsichtbarer WebView lädt den Eintrag in der Druckansicht (dieselbe
// Darstellung wie im Editor, nur ohne Bedienelemente) und druckt ihn über
// WebKit in eine PDF-Datei – mit echtem Seitenumbruch und Text, der
// durchsuchbar bleibt. Seitenzahlen und Kopfzeile kommen danach dazu, weil
// WebKit keine Druckränder mit Inhalt kennt.

struct PrintMeta {
    var title = ""
    var subject = ""
    var date = ""
    var name = ""
    var font = "sans"
}

final class Exporter: NSObject, WKNavigationDelegate {
    private static var running: [Exporter] = []

    private var window: NSWindow!
    private var webView: WKWebView!
    private var bridge: Bridge!
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
            let e = Exporter(uuid: uuid, completion: completion)
            running.append(e)
            e.start()
        }
    }

    // MARK: - Seiteneinstellungen

    static func paperSize() -> NSSize {
        switch (Store.shared.pdfSettings["paper"] as? String) ?? "A4" {
        case "A5": return NSSize(width: 419.53, height: 595.28)
        case "Letter": return NSSize(width: 612, height: 792)
        default: return NSSize(width: 595.28, height: 841.89)
        }
    }

    static func margins() -> NSEdgeInsets {
        let p = Store.shared.pdfSettings
        let cm: (String, Double) -> CGFloat = { key, def in CGFloat(((p[key] as? NSNumber)?.doubleValue ?? def) * 28.3465) }
        return NSEdgeInsets(top: cm("top", 3), left: cm("left", 2.5), bottom: cm("bottom", 3), right: cm("right", 2.5))
    }

    private func start() {
        let paper = Self.paperSize()
        let m = Self.margins()
        // WebKit setzt die Seite beim Drucken mit der druckbaren Breite in Punkten
        // × 1,25 (sein fester Verkleinerungsfaktor). Genau so breit wird hier
        // vorbereitet – sonst bricht der Text beim Drucken anders um, und alles,
        // was vorher vermessen wurde (Tabellen, Ausrichtung, Zeilennummern), verrutscht.
        let cssWidth = (paper.width - m.left - m.right) * 1.25
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(SchemeHandler.shared, forURLScheme: "heft")
        bridge = Bridge(printCallback: { [weak self] meta in self?.ready(meta) })
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "heft")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: cssWidth, height: 1200), configuration: cfg)
        webView.navigationDelegate = self
        webView.appearance = NSAppearance(named: .aqua)
        window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: cssWidth, height: 1200), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.orderBack(nil)
        webView.load(URLRequest(url: URL(string: "heft://app/index.html?print=\(uuid)")!))
        let t = DispatchWorkItem { [weak self] in self?.fail(DTError.script("Die Druckansicht wurde nicht rechtzeitig fertig.")) }
        timeoutWork = t
        DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: t)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }

    private func ready(_ info: [String: Any]) {
        guard !finished else { return }
        if let ok = info["ok"] as? Bool, !ok {
            fail(DTError.script((info["error"] as? String) ?? "Eintrag konnte nicht geladen werden"))
            return
        }
        var meta = PrintMeta()
        meta.title = info["title"] as? String ?? ""
        meta.subject = info["subject"] as? String ?? ""
        meta.date = info["date"] as? String ?? ""
        meta.name = info["name"] as? String ?? ""
        meta.font = info["font"] as? String ?? "sans"
        // Einen Moment warten, damit KaTeX-Schriften sicher gezeichnet sind
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.printToPDF(meta) }
    }

    private func printToPDF(_ meta: PrintMeta) {
        let out = Store.shared.tempFile("druck.pdf")
        let pi = NSPrintInfo()
        let paper = Self.paperSize()
        let m = Self.margins()
        pi.paperSize = paper
        pi.topMargin = m.top
        pi.bottomMargin = m.bottom
        pi.leftMargin = m.left
        pi.rightMargin = m.right
        pi.horizontalPagination = .fit
        pi.verticalPagination = .automatic
        pi.isHorizontallyCentered = false
        pi.isVerticallyCentered = false
        pi.jobDisposition = .save
        pi.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = out
        let op = webView.printOperation(with: pi)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: self, didRun: #selector(printDone(_:success:context:)), contextInfo: nil)
        pendingMeta = meta
        pendingFile = out
    }

    private var pendingMeta = PrintMeta()
    private var pendingFile: URL?

    // Wird von AppKit auf einem Hintergrund-Thread aufgerufen – alles, was
    // Fenster berührt, muss zurück auf den Haupt-Thread.
    @objc private func printDone(_ op: NSPrintOperation, success: Bool, context: UnsafeMutableRawPointer?) {
        DispatchQueue.main.async {
            guard let file = self.pendingFile, success, let raw = try? Data(contentsOf: file) else {
                self.fail(DTError.script("Drucken in PDF fehlgeschlagen."))
                return
            }
            try? FileManager.default.removeItem(at: file)
            let meta = self.pendingMeta
            DispatchQueue.global(qos: .userInitiated).async {
                let data = Self.decorate(raw, meta: meta)
                DispatchQueue.main.async { self.succeed(data, meta) }
            }
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
        window?.orderOut(nil)
        window?.contentView = nil
        Self.running.removeAll { $0 === self }
    }

    // MARK: - Seitenzahlen und Kopfzeile

    static func decorate(_ pdf: Data, meta: PrintMeta) -> Data {
        guard let doc = PDFDocument(data: pdf), doc.pageCount > 0 else { return pdf }
        let p = Store.shared.pdfSettings
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
        // Links der Druckfassung einsammeln: Adressen (DEVONthink, Web) und Sprünge im Dokument.
        // Sie werden beim Neuzeichnen direkt ins PDF geschrieben – kopierte PDFKit-Anmerkungen
        // verlieren ihr Ziel.
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
        let font: NSFont = meta.font == "mono" ? NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular)
            : meta.font == "serif" ? (NSFont(name: "NewYork-Regular", size: 9.5) ?? NSFont.systemFont(ofSize: 9.5))
            : NSFont.systemFont(ofSize: 9.5)
        let grey = NSColor(white: 0.35, alpha: 1)
        for i in 0..<total {
            guard let page = doc.page(at: i) else { continue }
            var box = page.bounds(for: .mediaBox)
            let boxData = Data(bytes: &box, count: MemoryLayout<CGRect>.size) as CFData
            ctx.beginPDFPage([kCGPDFContextMediaBox: boxData] as CFDictionary)
            page.draw(with: .mediaBox, to: ctx)
            for (name, point) in targets[i] ?? [:] { ctx.addDestination(name as CFString, at: point) }
            for (rect, url) in urlLinks[i] ?? [] { ctx.setURL(url as CFURL, for: rect) }
            for (rect, name) in jumpLinks[i] ?? [] { ctx.setDestination(name as CFString, for: rect) }
            let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = gc
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: grey, .paragraphStyle: para]
            // Seitenzahl unten mittig – wie "numbering: \"1 von 1\"" in Typst
            var pageText = ""
            switch numbering {
            case "von": pageText = "\(i + 1) von \(total)"
            case "seite": pageText = "Seite \(i + 1)"
            case "plain": pageText = "\(i + 1)"
            default: break
            }
            if !pageText.isEmpty {
                let y = max(14, m.bottom / 2 - 5)
                (pageText as NSString).draw(in: NSRect(x: 0, y: y, width: box.width, height: 14), withAttributes: attrs)
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
                (headText as NSString).draw(in: NSRect(x: m.left, y: y, width: box.width - m.left - m.right, height: 14), withAttributes: attrs)
            }
            NSGraphicsContext.restoreGraphicsState()
            ctx.endPDFPage()
        }
        ctx.closePDF()
        return out as Data
    }
}
