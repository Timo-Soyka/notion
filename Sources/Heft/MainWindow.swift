import AppKit
import WebKit
import PDFKit

// Das Hauptfenster: ein WebView über die ganze Fläche (Seitenleiste und
// Editor im Notion-Stil), darüber bei Bedarf der native PDF-Editor.

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

// WebView, an dem man das Fenster an der Kopfzeile verschieben kann.
// WKWebView kennt kein "-webkit-app-region: drag"; deshalb meldet die
// Oberfläche, wo die Kopfzeilen liegen, und hier wird entschieden.
final class HeftWebView: WKWebView {
    var dragRegions: [CGRect] = []
    var dragHoles: [CGRect] = []

    private func cssPoint(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return isFlipped ? p : CGPoint(x: p.x, y: bounds.height - p.y)
    }

    override func mouseDown(with event: NSEvent) {
        let p = cssPoint(event)
        if dragRegions.contains(where: { $0.contains(p) }) && !dragHoles.contains(where: { $0.contains(p) }) {
            if event.clickCount == 2 {
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
                return
            }
            window?.performDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }
}

final class MainWindowController: NSWindowController, NSWindowDelegate, BridgeHost, NSServicesMenuRequestor {
    let webView: HeftWebView
    private(set) var bridge: Bridge!
    private var pdfEditor: PDFEditorView?
    private var docOverlay: DocOverlay?
    private var pendingScanParent: String?
    private var quitPending = false

    var hostWindow: NSWindow? { window }

    init() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(SchemeHandler.shared, forURLScheme: "heft")
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = HeftWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: cfg)
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                           backing: .buffered, defer: false)
        super.init(window: win)
        bridge = Bridge(host: self)
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "heft")

        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true
        win.title = "Heft"
        win.minSize = NSSize(width: 760, height: 480)
        win.isMovableByWindowBackground = false
        win.backgroundColor = NSColor(name: nil) { ap in
            ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.098, alpha: 1) : .white
        }
        win.delegate = self
        win.tabbingMode = .disallowed

        let content = FlippedView(frame: win.contentRect(forFrameRect: win.frame))
        content.autoresizesSubviews = true
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        content.addSubview(webView)
        win.contentView = content
        if !win.setFrameUsingName("HeftHauptfenster") { win.center() }
        win.setFrameAutosaveName("HeftHauptfenster")
        webView.load(URLRequest(url: URL(string: "heft://app/index.html")!))
        DispatchQueue.main.async { self.layoutTrafficLights() }
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: - Ampelknöpfe mittig in der 44 pt hohen Kopfzeile

    func layoutTrafficLights() {
        guard let win = window, !win.styleMask.contains(.fullScreen),
              let close = win.standardWindowButton(.closeButton),
              let mini = win.standardWindowButton(.miniaturizeButton),
              let zoom = win.standardWindowButton(.zoomButton),
              let titlebar = close.superview?.superview else { return }
        let barHeight: CGFloat = 44
        var f = titlebar.frame
        f.size.height = barHeight
        f.origin.y = win.frame.height - barHeight
        titlebar.frame = f
        let y = (barHeight - close.frame.height) / 2
        for (i, b) in [close, mini, zoom].enumerated() {
            b.setFrameOrigin(NSPoint(x: 18 + CGFloat(i) * 20, y: y))
        }
    }

    func windowDidResize(_ notification: Notification) { layoutTrafficLights() }
    func windowDidExitFullScreen(_ notification: Notification) { layoutTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { layoutTrafficLights() }

    // MARK: - Ereignisse an die Oberfläche

    func emit(_ name: String, _ payload: Any) {
        let json: String
        if let d = try? JSONSerialization.data(withJSONObject: Bridge.sanitize(payload), options: [.fragmentsAllowed]) {
            json = String(decoding: d, as: UTF8.self)
        } else { json = "null" }
        let nameJSON = String(decoding: try! JSONSerialization.data(withJSONObject: name, options: [.fragmentsAllowed]), as: UTF8.self)
        webView.evaluateJavaScript("window.HeftNative && window.HeftNative.emit(\(nameJSON), \(json))", completionHandler: nil)
    }

    func setDragRegions(_ regions: [CGRect], holes: [CGRect]) {
        webView.dragRegions = regions
        webView.dragHoles = holes
    }

    func applyTheme(_ theme: String) {
        switch theme {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }

    // MARK: - PDF-Editor

    func openPDF(uuid: String, rect: CGRect) throws -> Int {
        closePDF()
        let doc = try SchemeHandler.shared.document(for: uuid)
        // Eigene Kopie, damit die Vorschaubilder unabhängig bleiben
        guard let data = doc.dataRepresentation(), let copy = PDFDocument(data: data) else { throw DTError.script("PDF kann nicht geöffnet werden") }
        let editor = PDFEditorView(uuid: uuid, document: copy, host: self)
        editor.frame = rect
        window?.contentView?.addSubview(editor, positioned: .above, relativeTo: webView)
        pdfEditor = editor
        window?.makeFirstResponder(editor.pdfView)
        return copy.pageCount
    }

    func closePDF() {
        guard let e = pdfEditor else { return }
        e.saveNow()
        e.removeFromSuperview()
        pdfEditor = nil
        window?.makeFirstResponder(webView)
    }

    func setPDFRect(_ rect: CGRect) {
        pdfEditor?.frame = rect
    }

    func pdfTool(_ args: [String: Any]) {
        pdfEditor?.setTool(args)
    }

    func pdfAction(_ args: [String: Any], reply: @escaping (Result<Any, Error>) -> Void) {
        guard let e = pdfEditor else { reply(.success(false)); return }
        e.action(args, reply: reply)
    }

    func pdfVisible(_ visible: Bool) -> String? {
        guard let e = pdfEditor else { return nil }
        if visible { e.isHidden = false; return nil }
        var snapshot: String?
        if let rep = e.bitmapImageRepForCachingDisplay(in: e.bounds) {
            e.cacheDisplay(in: e.bounds, to: rep)
            if let png = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) {
                snapshot = "data:image/jpeg;base64," + png.base64EncodedString()
            }
        }
        e.isHidden = true
        return snapshot
    }

    // MARK: - Weitere Dateiansichten (Quick Look, RTF)

    func openOverlay(_ v: DocOverlay, rect: CGRect) {
        closeOverlay()
        v.frame = rect
        window?.contentView?.addSubview(v, positioned: .above, relativeTo: webView)
        docOverlay = v
        (v as? RichTextOverlay)?.focus()
    }

    func closeOverlay() {
        guard let v = docOverlay else { return }
        v.shutdown()
        v.removeFromSuperview()
        docOverlay = nil
        window?.makeFirstResponder(webView)
    }

    func setOverlayRect(_ rect: CGRect) { docOverlay?.frame = rect }

    func overlayAction(_ a: [String: Any]) -> Any { docOverlay?.action(a) ?? false }

    func overlayVisible(_ visible: Bool) -> String? {
        guard let e = docOverlay else { return nil }
        if visible { e.isHidden = false; return nil }
        var snapshot: String?
        if let rep = e.bitmapImageRepForCachingDisplay(in: e.bounds) {
            e.cacheDisplay(in: e.bounds, to: rep)
            if let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) {
                snapshot = "data:image/jpeg;base64," + jpg.base64EncodedString()
            }
        }
        e.isHidden = true
        return snapshot
    }

    // MARK: - Beenden

    func prepareQuit() -> Bool {
        if quitPending { return true }
        quitPending = true
        pdfEditor?.saveNow()
        docOverlay?.saveNow()
        emit("will-quit", [:])
        // Falls die Oberfläche nicht antwortet, trotzdem beenden
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.quitReady() }
        return false
    }

    func quitReady() {
        guard quitPending else { return }
        quitPending = false
        pdfEditor?.saveNow()
        docOverlay?.saveNow()
        // Warten, bis DEVONthink alle Speicheraufträge abgearbeitet hat
        DEVONthink.shared.async({ true }) { _ in
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
    }

    // MARK: - Integrations-Kamera (iPhone-Scan)

    func showScanMenu(parent: String, reply: @escaping (Result<Any, Error>) -> Void) {
        DispatchQueue.main.async {
            self.pendingScanParent = parent
            let menu = NSMenu()
            let item = NSMenuItem(title: "Vom iPhone oder iPad importieren", action: nil, keyEquivalent: "")
            item.identifier = NSMenuItem.importFromDeviceIdentifier
            menu.addItem(item)
            let loc = self.window?.mouseLocationOutsideOfEventStream ?? .zero
            menu.popUp(positioning: nil, at: loc, in: self.window?.contentView?.superview ?? self.window?.contentView)
            reply(.success([]))
        }
    }

    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
        if sendType == nil, let rt = returnType, [.pdf, .tiff, .png, NSPasteboard.PasteboardType("public.jpeg"), NSPasteboard.PasteboardType("public.heic")].contains(rt) {
            return self
        }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }

    func readSelection(from pboard: NSPasteboard) -> Bool {
        let parent = pendingScanParent ?? (Store.shared.string("root") ?? "")
        var file: URL?
        if let pdf = pboard.data(forType: .pdf) {
            file = Store.shared.tempFile("Scan \(Bridge.stamp()).pdf")
            try? pdf.write(to: file!)
        } else if let img = NSImage(pasteboard: pboard), let tiff = img.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff), let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) {
            file = Store.shared.tempFile("Foto \(Bridge.stamp()).jpg")
            try? jpg.write(to: file!)
        }
        guard let f = file else { return false }
        let name = f.deletingPathExtension().lastPathComponent.replacingOccurrences(of: #"^[0-9A-F-]{36}-"#, with: "", options: .regularExpression)
        DEVONthink.shared.async({ try DEVONthink.shared.run(Scripts.importInto, [parent, f.path, name]) }) { result in
            try? FileManager.default.removeItem(at: f)
            DispatchQueue.main.async {
                switch result {
                case .success(let r):
                    self.emit("tree-changed", [:])
                    if let d = r as? [String: Any], let u = d["uuid"] as? String { self.emit("open-record", ["uuid": u]) }
                case .failure(let e):
                    self.emit("toast", ["message": "Scan konnte nicht abgelegt werden: \(e.localizedDescription)", "type": "error"])
                }
            }
        }
        return true
    }

    func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool { false }

    // MARK: - Menübefehle

    @objc func menuCommand(_ sender: NSMenuItem) {
        guard let cmd = sender.representedObject as? String else { return }
        emit("menu", ["cmd": cmd])
    }

    // ⌘Z geht an unseren eigenen Verlauf, außer in nativen Textfeldern
    @objc func heftUndo(_ sender: Any?) {
        if let fr = window?.firstResponder, fr is NSTextView { NSApp.sendAction(Selector(("undo:")), to: nil, from: sender); return }
        if pdfEditor != nil && window?.firstResponder !== webView { pdfEditor?.undoManagerForPDF.undo(); return }
        emit("menu", ["cmd": "undo"])
    }

    @objc func heftRedo(_ sender: Any?) {
        if let fr = window?.firstResponder, fr is NSTextView { NSApp.sendAction(Selector(("redo:")), to: nil, from: sender); return }
        if pdfEditor != nil && window?.firstResponder !== webView { pdfEditor?.undoManagerForPDF.redo(); return }
        emit("menu", ["cmd": "redo"])
    }

    // Fenster schließen = App beenden; so läuft das Speichern über denselben Weg
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        pdfEditor?.saveNow()
        docOverlay?.saveNow()
        NSApp.terminate(sender)
        return false
    }
}
