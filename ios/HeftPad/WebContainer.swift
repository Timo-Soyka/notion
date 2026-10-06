import SwiftUI
import WebKit
import PDFKit

// Die Heft-Oberfläche (web/) in einer Web-Ansicht – dieselbe wie am Mac.
// Swift spricht mit ihr über PadBridge („heft“) und meldet Ereignisse per
// window.HeftNative.emit(name, daten).

struct WebContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebController { WebController() }
    func updateUIViewController(_ vc: WebController, context: Context) {}
}

final class WebController: UIViewController, PadHost, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!
    private var bridge: PadBridge!
    private var timer: Timer?
    var presenter: UIViewController? { self }
    private let focusPolicy = FocusPolicy()
    private(set) var pdfEditor: PadPDFEditor?
    private(set) var overlay: PadOverlay?

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(PadSchemeHandler(), forURLScheme: "heft")
        bridge = PadBridge(host: self)
        let ucc = WKUserContentController()
        ucc.addScriptMessageHandler(bridge, contentWorld: .page, name: "heft")
        // Die Oberfläche soll wissen, dass sie auf dem iPad läuft
        // Ist ein Apple Pencil gekoppelt? („Nur mit Apple Pencil zeichnen“ ist dann meist an)
        let pencil = UIPencilInteraction.prefersPencilOnlyDrawing ? "true" : "false"
        ucc.addUserScript(WKUserScript(source: "window.HeftPlatform = 'ipad'; window.HeftPencil = \(pencil); document.documentElement.classList.add('ipad');",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
        // Fehler der Oberfläche sammeln (zum Abfragen über die Testschnittstelle)
        ucc.addUserScript(WKUserScript(source: """
            window.__heftErrors = [];
            window.addEventListener('error', e => __heftErrors.push('Fehler: ' + e.message + ' @' + (e.filename||'').split('/').pop() + ':' + e.lineno));
            window.addEventListener('unhandledrejection', e => __heftErrors.push('Promise: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
            const ce = console.error.bind(console);
            console.error = (...a) => { __heftErrors.push('console: ' + a.map(String).join(' ')); ce(...a); };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isInspectable = true
        webView.allowsLinkPreview = false
        view.addSubview(webView)
        view.backgroundColor = .systemBackground
        // Tastatur auch dann zeigen, wenn ein Feld erst kurz nach dem Antippen
        // den Fokus bekommt (Formelfelder entstehen erst nach dem Tippen)
        let watcher = TouchWatcher()
        // Erste Berührung mit dem Pencil: der Oberfläche Bescheid geben (Schreibfeld für Formeln)
        watcher.onPencil = { [weak self] in self?.emit("pencil-seen", [:]) }
        webView.addGestureRecognizer(watcher)
        let setter = NSSelectorFromString("_setInputDelegate:")
        if webView.responds(to: setter) { webView.perform(setter, with: focusPolicy) }
        webView.load(URLRequest(url: URL(string: "heft://app/index.html")!))

        // Neues vom Mac: iCloud meldet ein neues Verzeichnis sofort; dazu als Rückfall alle 15 s nachsehen
        MirrorStore.shared.onManifestChange = { [weak self] in DispatchQueue.main.async { self?.checkMirrorSoon() } }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.checkMirror() }
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        #if DEBUG
        DebugHooks.start(controller: self)
        #endif
    }

    @objc private func becameActive() {
        emit("app-active", [:])
        checkMirror()
    }

    // Mehrere Meldungen kurz hintereinander zählen einmal
    private var checkWork: DispatchWorkItem?
    private func checkMirrorSoon() {
        checkWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.checkMirror() }
        checkWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
    }

    private func checkMirror() {
        DispatchQueue.global(qos: .utility).async {
            let changed = MirrorStore.shared.reloadManifest().treeChanged
            let up = MirrorStore.shared.takeNews()
            DispatchQueue.main.async {
                if changed { self.emit("tree-changed", [:]) }
                // Offener Eintrag vom Mac geändert: neu laden (wenn hier nichts Ungesichertes ist)
                if !up.notes.isEmpty { self.emit("notes-changed", ["uuids": up.notes]) }
                for f in up.failures {
                    self.emit("toast", ["message": "Der Mac konnte eine Änderung nicht in DEVONthink eintragen – \(f)", "type": "error"])
                }
            }
        }
    }

    func emit(_ name: String, _ payload: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: PadBridge.sanitize(payload), options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8),
              let nameData = try? JSONSerialization.data(withJSONObject: name, options: [.fragmentsAllowed]),
              let nameJSON = String(data: nameData, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.HeftNative && window.HeftNative.emit(\(nameJSON), \(json))", completionHandler: nil)
    }

    // MARK: - Arbeitsblatt (PDF-Editor über der Oberfläche)

    // Stellen aus der Oberfläche (CSS-Pixel im WebView) in eigene Koordinaten
    private func frame(for rect: CGRect) -> CGRect { webView.convert(rect, to: view) }

    func openPDF(uuid: String, rect: CGRect) throws -> Int {
        closePDF()
        let document: PDFDocument
        let bytes: Int
        if let pending = PadPDFEditor.documentBeingSaved(uuid) {
            (document, bytes) = pending
        } else {
            guard let data = MirrorStore.shared.fileData(for: uuid) else {
                throw NSError(domain: "Heft", code: 5, userInfo: [NSLocalizedDescriptionKey: "Das Blatt ist noch nicht aus iCloud geladen – gleich noch einmal versuchen"])
            }
            guard let copy = PDFDocument(data: data) else {
                throw NSError(domain: "Heft", code: 5, userInfo: [NSLocalizedDescriptionKey: "PDF kann nicht geöffnet werden"])
            }
            (document, bytes) = (copy, data.count)
        }
        let editor = PadPDFEditor(uuid: uuid, document: document, fileBytes: bytes, host: self)
        editor.frame = frame(for: rect)
        view.addSubview(editor)
        pdfEditor = editor
        return document.pageCount
    }

    func closePDF() {
        guard let e = pdfEditor else { return }
        e.saveNow()
        e.removeFromSuperview()
        pdfEditor = nil
    }

    func setPDFRect(_ rect: CGRect) { pdfEditor?.frame = frame(for: rect) }

    func pdfVisible(_ visible: Bool) -> String? {
        guard let e = pdfEditor else { return nil }
        if visible { e.isHidden = false; return nil }
        let snap = e.snapshot()
        e.isHidden = true
        return snap
    }

    // MARK: - Weitere Dateiansichten

    func openOverlay(_ o: PadOverlay, rect: CGRect) {
        closeOverlay()
        o.attach(to: self)
        o.view.frame = frame(for: rect)
        (o as? RichTextOverlay)?.layout()
        overlay = o
    }

    func closeOverlay() {
        guard let o = overlay else { return }
        o.detach()
        overlay = nil
    }

    func setOverlayRect(_ rect: CGRect) {
        overlay?.view.frame = frame(for: rect)
        (overlay as? RichTextOverlay)?.layout()
    }

    func overlayVisible(_ visible: Bool) -> String? {
        guard let o = overlay else { return nil }
        if visible { o.view.isHidden = false; return nil }
        let snap = o.snapshot()
        o.view.isHidden = true
        return snap
    }

    // Links nach außen im Browser öffnen, heft:// bleibt in der App
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme != "heft", action.navigationType == .linkActivated {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // alert/confirm aus der Oberfläche
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }
}

// Merkt sich das letzte Antippen mit dem Finger – erkennt selbst nie etwas
final class TouchWatcher: UIGestureRecognizer {
    static var lastFingerTouch = Date.distantPast
    var onPencil: (() -> Void)?
    private var pencilSeen = false

    override init(target: Any? = nil, action: Selector? = nil) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if touches.contains(where: { $0.type == .direct }) { Self.lastFingerTouch = Date() }
        if touches.contains(where: { $0.type == .pencil }), !pencilSeen {
            pencilSeen = true
            onPencil?()
        }
        state = .failed
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}

// WebKit fragt hier, ob ein Feld die Tastatur bekommt. Normalerweise nur, wenn
// der Fokus direkt aus dem Antippen kommt – Formelfelder bekommen ihn aber erst
// einen Moment später. Kurz nach einem Finger-Tipp deshalb ja, sonst wie immer
// (beim Schreiben mit dem Pencil entscheidet weiter iPadOS).
final class FocusPolicy: NSObject {
    /// Bis dahin kommt die Tastatur auf jeden Fall – die Oberfläche bittet darum
    /// (Taste „Text“ der Mathe-Tastatur), auch wenn sie mit dem Pencil gedrückt wurde
    static var allowUntil = Date.distantPast

    @objc(_webView:decidePolicyForFocusedElement:)
    func decidePolicy(_ webView: WKWebView, focusedElement info: AnyObject) -> Int {
        if Date() < Self.allowUntil { return 1 }
        return Date().timeIntervalSince(TouchWatcher.lastFingerTouch) < 1.5 ? 1 : 0   // 1 = zeigen, 0 = wie immer
    }
}

#if DEBUG
// Testzugang (nur in Entwicklungsversionen): JavaScript-Dateien in
// „<Heft-Ordner>/Debug/*.js“ werden ausgeführt, das Ergebnis landet daneben als
// .json; eine leere „*.snap“-Datei erzeugt ein Bildschirmfoto „*.png“.
enum DebugHooks {
    private static var timer: Timer?

    static func start(controller: WebController) {
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            guard let root = MirrorStore.shared.root else { return }
            let dir = root.appendingPathComponent("Debug", isDirectory: true)
            let fm = FileManager.default
            try? fm.startDownloadingUbiquitousItem(at: dir)
            var names: [String] = []
            NSFileCoordinator().coordinate(readingItemAt: dir, options: [], error: nil) { u in
                names = (try? fm.contentsOfDirectory(atPath: u.path)) ?? []
            }
            for n in names {
                // iCloud-Platzhalter (.name.icloud) erst herunterladen
                if n.hasPrefix("."), n.hasSuffix(".icloud") {
                    let real = String(n.dropFirst().dropLast(7))
                    try? fm.startDownloadingUbiquitousItem(at: dir.appendingPathComponent(real))
                    continue
                }
                let url = dir.appendingPathComponent(n)
                if n.hasSuffix(".js") {
                    var js: String?
                    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: nil) { u in js = try? String(contentsOf: u, encoding: .utf8) }
                    try? fm.removeItem(at: url)
                    guard let js else { continue }
                    let out = url.deletingPathExtension().appendingPathExtension("json")
                    controller.webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                        var obj: Any
                        switch result {
                        case .success(let v): obj = ["ok": true, "result": PadBridge.sanitize(v)]
                        case .failure(let e): obj = ["ok": false, "error": "\(e)"]
                        }
                        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .fragmentsAllowed]) {
                            NSFileCoordinator().coordinate(writingItemAt: out, options: .forReplacing, error: nil) { u in try? data.write(to: u) }
                        }
                    }
                } else if n.hasSuffix(".snap") {
                    try? fm.removeItem(at: url)
                    let out = url.deletingPathExtension().appendingPathExtension("png")
                    // Ganze Ansicht samt PDF-Editor und anderen nativen Ebenen
                    let v: UIView = controller.view
                    let image = UIGraphicsImageRenderer(bounds: v.bounds).image { _ in v.drawHierarchy(in: v.bounds, afterScreenUpdates: true) }
                    if let png = image.pngData() {
                        NSFileCoordinator().coordinate(writingItemAt: out, options: .forReplacing, error: nil) { u in try? png.write(to: u) }
                    }
                }
            }
        }
    }
}
#endif
