import UIKit
import PDFKit
import Vision

// Arbeitsblätter auf dem iPad bearbeiten – wie am Mac (Sources/Heft/PDFEditor.swift),
// nur für Finger und Apple Pencil gemacht:
//
//   • Mit dem Stift wird gezeichnet, markiert und radiert, mit dem Finger
//     geblättert und gezoomt.
//   • Im Text-Werkzeug wird Handschrift über Scribble gleich zu Maschinen-
//     schrift: einfach irgendwo aufs Blatt schreiben, dort entsteht ein Textfeld.
//   • Doppeltippen auf den Apple Pencil wechselt zum Radierer und zurück.
//
// Die Anmerkungen sind echte PDF-Anmerkungen (wie am Mac). Gespeichert wird
// über die iCloud-Kopie; Heft am Mac trägt das Blatt dann in DEVONthink ein.

final class PadPDFEditor: UIView, UIPencilInteractionDelegate {
    let uuid: String
    let document: PDFDocument
    let pdfView = PadPDFView()
    let undo = UndoManager()
    weak var host: PadHost?

    private(set) var tool = "select"
    private var previousTool = "select"
    private var lastDrawingTool = "pen"
    var color = UIColor(red: 0.11, green: 0.31, blue: 0.85, alpha: 1)
    var lineWidth: CGFloat = 2
    var fontSize: CGFloat = 14

    private var dirty = false
    private var saveWork: DispatchWorkItem?
    private var lastSave = Date.distantPast
    private var firstUnsaved: Date?
    private var fileBytes: Int

    init(uuid: String, document: PDFDocument, fileBytes: Int, host: PadHost) {
        self.uuid = uuid
        self.document = document
        self.fileBytes = fileBytes
        self.host = host
        super.init(frame: .zero)
        pdfView.frame = bounds
        pdfView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pdfView.document = document
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displaysPageBreaks = true
        pdfView.pageBreakMargins = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        pdfView.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.13, alpha: 1) : UIColor(white: 0.97, alpha: 1) }
        pdfView.editor = self
        addSubview(pdfView)
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        addInteraction(pencil)
        NotificationCenter.default.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdfView)
        NotificationCenter.default.addObserver(self, selector: #selector(appResigned), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func pageChanged() {
        guard let page = pdfView.currentPage else { return }
        host?.emit("pdf-state", ["uuid": uuid, "page": document.index(for: page) + 1, "pages": document.pageCount])
    }

    // MARK: - Werkzeuge

    static let drawingTools: Set<String> = ["pen", "rect", "ellipse", "line", "arrow", "highlight", "underline", "strike"]

    func setTool(_ a: [String: Any]) {
        if let hex = a["color"] as? String, let c = UIColor(hex: hex) { color = c }
        if let w = a["width"] as? NSNumber { lineWidth = CGFloat(w.doubleValue) }
        if let f = a["fontSize"] as? NSNumber { fontSize = CGFloat(f.doubleValue) }
        use((a["tool"] as? String) ?? "select")
    }

    private func use(_ t: String) {
        pdfView.endTextEditing(commit: true)
        if t != tool { previousTool = tool }
        tool = t
        if Self.drawingTools.contains(t) { lastDrawingTool = t }
        pdfView.toolChanged()
    }

    // Doppeltippen auf den Apple Pencil – so, wie es in den Einstellungen gewählt ist
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        let next: String
        switch UIPencilInteraction.preferredTapAction {
        case .ignore: return
        case .switchPrevious: next = previousTool
        default: next = tool == "eraser" ? lastDrawingTool : "eraser"
        }
        use(next)
        host?.emit("pdf-state", ["uuid": uuid, "tool": next])
    }

    // MARK: - Anmerkungen hinzufügen/entfernen (mit Rückgängig)

    func add(_ ann: PDFAnnotation, to page: PDFPage) {
        page.addAnnotation(ann)
        undo.registerUndo(withTarget: self) { $0.remove(ann, from: page) }
        changed()
    }

    func remove(_ ann: PDFAnnotation, from page: PDFPage) {
        page.removeAnnotation(ann)
        undo.registerUndo(withTarget: self) { $0.add(ann, to: page) }
        changed()
    }

    func moved(_ ann: PDFAnnotation, on page: PDFPage, from old: CGRect) {
        let now = ann.bounds
        undo.registerUndo(withTarget: self) { me in
            ann.bounds = old
            me.pdfView.annotationsChanged(on: page)
            me.moved(ann, on: page, from: now)
        }
        changed()
    }

    func changed() {
        dirty = true
        if firstUnsaved == nil { firstUnsaved = Date() }
        host?.emit("pdf-state", ["uuid": uuid, "saved": false, "dirty": true])
        scheduleSave()
    }

    // MARK: - Speichern
    //
    // Wie am Mac: Jede Sicherung schreibt das ganze PDF neu (und lädt es nach
    // iCloud). Gespeichert wird, wenn man kurz innehält – bei großen Scans nur
    // alle paar Minuten. Sofort beim Verlassen des Blatts und wenn Heft in den
    // Hintergrund geht.

    private var megabytes: Double { Double(fileBytes) / 1_048_576 }
    private var savePause: TimeInterval { min(10, 3 + megabytes / 5) }
    private var saveSpacing: TimeInterval { min(600, max(5, megabytes * 8)) }
    private let saveMaxWait: TimeInterval = 60

    private func scheduleSave() {
        let now = Date()
        let earliest = lastSave.addingTimeInterval(saveSpacing)
        var due = max(now.addingTimeInterval(savePause), earliest)
        if let first = firstUnsaved { due = min(due, max(first.addingTimeInterval(saveMaxWait), earliest)) }
        planAutosave(after: due.timeIntervalSince(now))
    }

    private func planAutosave(after delay: TimeInterval) {
        saveWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.autosave() }
        saveWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay), execute: w)
    }

    private func autosave() {
        guard dirty else { return }
        if pdfView.isEditingText { planAutosave(after: savePause); return }
        saveNow()
    }

    @objc private func appResigned() { autosave() }
    @objc private func appBackground() { saveNow() }

    func saveNow() {
        pdfView.endTextEditing(commit: true)
        saveWork?.cancel()
        saveWork = nil
        guard dirty else { return }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("arbeitsblatt-\(UUID().uuidString).pdf")
        guard document.write(to: tmp) else {
            try? FileManager.default.removeItem(at: tmp)
            host?.emit("toast", ["message": "Arbeitsblatt nicht gespeichert: Die Datei ließ sich nicht schreiben.", "type": "error"])
            return
        }
        dirty = false
        firstUnsaved = nil
        lastSave = Date()
        if let size = (try? tmp.resourceValues(forKeys: [.fileSizeKey]))?.fileSize { fileBytes = size }
        host?.emit("pdf-state", ["uuid": uuid, "saved": false, "saving": true])
        let uuid = self.uuid
        Self.beginSaving(uuid, document, fileBytes)
        // Auch wenn Heft gerade in den Hintergrund geht: fertig schreiben
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "Arbeitsblatt sichern") { UIApplication.shared.endBackgroundTask(task) }
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak host = self.host] in
            let result = Result { try MirrorStore.shared.writeFile(uuid, data: Data(contentsOf: tmp, options: .mappedIfSafe)) }
            try? FileManager.default.removeItem(at: tmp)
            DispatchQueue.main.async {
                Self.endSaving(uuid)
                PadSchemeHandler.invalidate(uuid)
                switch result {
                case .success: host?.emit("pdf-state", ["uuid": uuid, "saved": true, "dirty": self?.dirty ?? false])
                case .failure(let e):
                    if let me = self {
                        me.dirty = true
                        if me.firstUnsaved == nil { me.firstUnsaved = Date() }
                    }
                    host?.emit("toast", ["message": "Arbeitsblatt nicht gespeichert: \(e.localizedDescription)", "type": "error"])
                }
                UIApplication.shared.endBackgroundTask(task)
            }
        }
    }

    // Stände, die gerade gesichert werden – öffnet man das Blatt sofort wieder,
    // geht es mit diesem Stand weiter
    private static var inFlight: [String: (document: PDFDocument, bytes: Int, count: Int)] = [:]

    static func documentBeingSaved(_ uuid: String) -> (document: PDFDocument, bytes: Int)? {
        inFlight[uuid].map { ($0.document, $0.bytes) }
    }

    private static func beginSaving(_ uuid: String, _ document: PDFDocument, _ bytes: Int) {
        inFlight[uuid] = (document, bytes, (inFlight[uuid]?.count ?? 0) + 1)
    }

    private static func endSaving(_ uuid: String) {
        guard let e = inFlight[uuid] else { return }
        inFlight[uuid] = e.count > 1 ? (e.document, e.bytes, e.count - 1) : nil
    }

    // MARK: - Aktionen aus der Werkzeugleiste

    func action(_ a: [String: Any], reply: @escaping (Result<Any, Error>) -> Void) {
        switch (a["action"] as? String) ?? "" {
        case "undo": pdfView.endTextEditing(commit: true); undo.undo(); reply(.success(true))
        case "redo": pdfView.endTextEditing(commit: true); undo.redo(); reply(.success(true))
        case "zoomIn": pdfView.scaleFactor = min(pdfView.maxScaleFactor, pdfView.scaleFactor * 1.25); reply(.success(true))
        case "zoomOut": pdfView.scaleFactor = max(pdfView.minScaleFactor, pdfView.scaleFactor / 1.25); reply(.success(true))
        case "save": saveNow(); reply(.success(true))
        case "rotate":
            if let p = pdfView.currentPage { rotate(p, by: 90) }
            reply(.success(true))
        case "deletePage":
            if let p = pdfView.currentPage, document.pageCount > 1 { deletePage(p) }
            reply(.success(true))
        case "addPage":
            addPage(style: (a["style"] as? String) ?? "blank")
            reply(.success(true))
        case "ocr":
            runOCR(reply: reply)
        default:
            reply(.success(false))
        }
    }

    private func rotate(_ page: PDFPage, by deg: Int) {
        page.rotation = (page.rotation + deg + 360) % 360
        undo.registerUndo(withTarget: self) { $0.rotate(page, by: -deg) }
        changed()
    }

    private func deletePage(_ page: PDFPage) {
        let idx = document.index(for: page)
        document.removePage(at: idx)
        undo.registerUndo(withTarget: self) { me in
            me.document.insert(page, at: idx)
            me.changed()
        }
        changed()
        pageChanged()
    }

    // Leere, karierte oder linierte Seite anfügen – Platz für Rechnungen
    private func addPage(style: String) {
        let ref = pdfView.currentPage ?? document.page(at: 0)
        let size = ref?.bounds(for: .mediaBox).size ?? CGSize(width: 595.28, height: 841.89)
        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: size)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return }
        ctx.beginPDFPage(nil)
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(box)
        let mm: CGFloat = 72 / 25.4
        let margin = 12 * mm
        let lineColor = UIColor(red: 0.72, green: 0.8, blue: 0.9, alpha: 1).cgColor
        if style == "grid" {
            ctx.setStrokeColor(lineColor)
            ctx.setLineWidth(0.4)
            var x = margin
            while x <= size.width - margin + 0.1 { ctx.move(to: CGPoint(x: x, y: margin)); ctx.addLine(to: CGPoint(x: x, y: size.height - margin)); x += 5 * mm }
            var y = margin
            while y <= size.height - margin + 0.1 { ctx.move(to: CGPoint(x: margin, y: y)); ctx.addLine(to: CGPoint(x: size.width - margin, y: y)); y += 5 * mm }
            ctx.strokePath()
        } else if style == "lines" {
            ctx.setStrokeColor(lineColor)
            ctx.setLineWidth(0.5)
            var y = margin
            while y <= size.height - margin { ctx.move(to: CGPoint(x: margin, y: y)); ctx.addLine(to: CGPoint(x: size.width - margin, y: y)); y += 8 * mm }
            ctx.strokePath()
        }
        ctx.endPDFPage()
        ctx.closePDF()
        guard let tmp = PDFDocument(data: data as Data), let page = tmp.page(at: 0) else { return }
        let idx = (ref.map { document.index(for: $0) } ?? document.pageCount - 1) + 1
        document.insert(page, at: idx)
        undo.registerUndo(withTarget: self) { me in
            let i = me.document.index(for: page)
            if i != NSNotFound { me.document.removePage(at: i) }
            me.changed()
        }
        changed()
        pdfView.go(to: page)
    }

    // MARK: - Texterkennung
    //
    // Der erkannte Text geht als Auftrag an den Mac, der ihn in DEVONthink
    // hinterlegt – danach ist das Blatt dort durchsuchbar.

    private func runOCR(reply: @escaping (Result<Any, Error>) -> Void) {
        let existing = (document.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let images: [CGImage] = (0..<document.pageCount).compactMap { i in
            guard let page = document.page(at: i) else { return nil }
            let b = page.bounds(for: .mediaBox)
            return page.thumbnail(of: CGSize(width: b.width * 2.5, height: b.height * 2.5), for: .mediaBox).cgImage
        }
        let uuid = self.uuid
        DispatchQueue.global(qos: .userInitiated).async {
            var texts: [String] = []
            for cg in images {
                let req = VNRecognizeTextRequest()
                req.recognitionLevel = .accurate
                req.recognitionLanguages = ["de-DE", "en-US", "fr-FR", "la"]
                req.usesLanguageCorrection = true
                try? VNImageRequestHandler(cgImage: cg).perform([req])
                texts.append((req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
            }
            var text = texts.joined(separator: "\n\n")
            if text.count < existing.count { text = existing }
            guard !text.isEmpty else { reply(.success(["chars": 0])); return }
            do {
                try MirrorStore.shared.setPlainText(uuid, text: text)
                reply(.success(["chars": text.count]))
            } catch { reply(.failure(error)) }
        }
    }

    // Bild des Blatts, solange ein HTML-Menü darüber liegt
    func snapshot() -> String? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let img = UIGraphicsImageRenderer(bounds: bounds).image { _ in drawHierarchy(in: bounds, afterScreenUpdates: false) }
        return img.jpegData(compressionQuality: 0.8).map { "data:image/jpeg;base64," + $0.base64EncodedString() }
    }
}

// MARK: - Stift-Geste

// Nimmt nur den Apple Pencil an (oder auch den Finger, wenn in den Einstellungen
// „Nur mit Apple Pencil zeichnen“ aus ist). Weil sie sofort beginnt, kommen
// Blättern und Textauswahl für diese Berührung gar nicht erst zum Zug.
final class DrawGesture: UIGestureRecognizer {
    private(set) var samples: [CGPoint] = []
    private var tracked: UITouch?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard tracked == nil, let t = touches.first else {
            for t in touches where t !== tracked { ignore(t, for: event) }
            return
        }
        tracked = t
        samples = [t.preciseLocation(in: view)]
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        samples = (event.coalescedTouches(for: t) ?? [t]).map { $0.preciseLocation(in: view) }
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        samples = [t.preciseLocation(in: view)]
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        state = .cancelled
    }

    override func reset() {
        tracked = nil
        samples = []
    }
}

// PDFView ist selbst Delegate seiner Gesten – eigene Gesten bekommen einen eigenen
final class GestureGate: NSObject, UIGestureRecognizerDelegate {
    var shouldBegin: (UIGestureRecognizer) -> Bool = { _ in true }
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool { shouldBegin(g) }
}

// MARK: - PDF-Ansicht mit Werkzeugen

final class PadPDFView: PDFView, UITextViewDelegate, UIIndirectScribbleInteractionDelegate {
    weak var editor: PadPDFEditor?

    private let previewView = UIView()
    private let preview = CAShapeLayer()
    private var points: [CGPoint] = []        // in Seitenkoordinaten
    private var dragPage: PDFPage?
    private var drawGesture: DrawGesture!
    private var textTap: UITapGestureRecognizer!
    private var editTap: UITapGestureRecognizer!
    private let editGate = GestureGate()
    private var moveGesture: UILongPressGestureRecognizer!
    private let moveGate = GestureGate()
    private var moving: (ann: PDFAnnotation, page: PDFPage, start: CGPoint, orig: CGRect)?
    private let moveFrame = CAShapeLayer()
    private var lastMoveEnd = Date.distantPast

    private(set) var textView: UITextView?
    private var editingAnnotation: PDFAnnotation?
    private var editingPage: PDFPage?
    private var scrollObservations: [NSKeyValueObservation] = []

    var isEditingText: Bool { textView != nil }
    private var tool: String { editor?.tool ?? "select" }

    override init(frame: CGRect) {
        super.init(frame: frame)
        previewView.isUserInteractionEnabled = false
        previewView.backgroundColor = .clear
        preview.fillColor = nil
        preview.lineCap = .round
        preview.lineJoin = .round
        previewView.layer.addSublayer(preview)
        addSubview(previewView)

        drawGesture = DrawGesture(target: self, action: #selector(handleDraw(_:)))
        drawGesture.isEnabled = false
        addGestureRecognizer(drawGesture)

        textTap = UITapGestureRecognizer(target: self, action: #selector(handleTextTap(_:)))
        textTap.isEnabled = false
        addGestureRecognizer(textTap)

        editTap = UITapGestureRecognizer(target: self, action: #selector(handleEditTap(_:)))
        editTap.numberOfTapsRequired = 2
        editGate.shouldBegin = { [weak self] g in self?.editTapShouldBegin(g) ?? false }
        editTap.delegate = editGate
        addGestureRecognizer(editTap)

        // Kurz gedrückt halten und ziehen: Textfeld, Zeichnung oder Form verschieben
        moveGesture = UILongPressGestureRecognizer(target: self, action: #selector(handleMove(_:)))
        moveGesture.minimumPressDuration = 0.3
        moveGesture.allowableMovement = 14
        moveGesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        moveGate.shouldBegin = { [weak self] g in self?.movableAnnotation(at: g.location(in: g.view)) != nil }
        moveGesture.delegate = moveGate
        addGestureRecognizer(moveGesture)
        moveFrame.fillColor = nil
        moveFrame.strokeColor = UIColor.systemBlue.cgColor
        moveFrame.lineWidth = 1.5
        moveFrame.lineDashPattern = [5, 3]
        previewView.layer.addSublayer(moveFrame)

        addInteraction(UIIndirectScribbleInteraction(delegate: self))
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(viewMoved), name: .PDFViewScaleChanged, object: self)
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewView.frame = bounds
        bringSubviewToFront(previewView)
        if let tv = textView { bringSubviewToFront(tv) }
        if scrollObservations.isEmpty, let sv = innerScrollView {
            // Textfeld beim Blättern und Zoomen mitführen
            scrollObservations = [
                sv.observe(\.contentOffset) { [weak self] _, _ in self?.viewMoved() },
                sv.observe(\.zoomScale) { [weak self] _, _ in self?.viewMoved() }
            ]
        }
    }

    private var innerScrollView: UIScrollView? {
        func find(_ v: UIView) -> UIScrollView? {
            for s in v.subviews {
                if let sv = s as? UIScrollView { return sv }
                if let sv = find(s) { return sv }
            }
            return nil
        }
        return find(self)
    }

    func toolChanged() {
        // Eine übrig gebliebene Textauswahl samt Menü nicht mitnehmen
        if tool != "select" { clearSelection() }
        let drawing = PadPDFEditor.drawingTools.contains(tool) || tool == "eraser"
        drawGesture.isEnabled = drawing
        // Mit dem Finger nur zeichnen, wenn das iPad nicht auf „Nur Apple Pencil“ steht
        var types = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        if !UIPencilInteraction.prefersPencilOnlyDrawing { types.append(NSNumber(value: UITouch.TouchType.direct.rawValue)) }
        drawGesture.allowedTouchTypes = types
        textTap.isEnabled = tool == "text"
        if !drawing { preview.path = nil; dragPage = nil }
    }

    // MARK: Verschieben

    // Was sich verschieben lässt: alles, was man selbst hinzugefügt hat – außer
    // Textmarkierungen (die gehören zum Text darunter), Links und Formularfeldern
    private func movableAnnotation(at vp: CGPoint) -> (PDFPage, PDFAnnotation)? {
        guard !PadPDFEditor.drawingTools.contains(tool), tool != "eraser",
              let (page, p) = pagePoint(vp), let ann = page.annotation(at: p) else { return nil }
        let fixed: Set<String> = ["Link", "Widget", "Highlight", "Underline", "StrikeOut", "Squiggly", "Popup"]
        return fixed.contains(ann.type ?? "") ? nil : (page, ann)
    }

    @objc private func handleMove(_ g: UILongPressGestureRecognizer) {
        guard let ed = editor else { return }
        let vp = g.location(in: self)
        switch g.state {
        case .began:
            guard let (page, ann) = movableAnnotation(at: vp) else { return }
            endTextEditing(commit: true)
            moving = (ann, page, convert(vp, to: page), ann.bounds)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showMoveFrame()
        case .changed:
            guard let m = moving else { return }
            let p = convert(vp, to: m.page)
            var r = m.orig.offsetBy(dx: p.x - m.start.x, dy: p.y - m.start.y)
            // Auf der Seite bleiben
            let box = m.page.bounds(for: .cropBox)
            r.origin.x = min(max(r.minX, box.minX - r.width / 2), box.maxX - r.width / 2)
            r.origin.y = min(max(r.minY, box.minY - r.height / 2), box.maxY - r.height / 2)
            m.ann.bounds = r
            annotationsChanged(on: m.page)
            showMoveFrame()
        case .ended, .cancelled, .failed:
            moveFrame.path = nil
            guard let m = moving else { return }
            moving = nil
            lastMoveEnd = Date()
            if m.ann.bounds != m.orig { ed.moved(m.ann, on: m.page, from: m.orig) }
        default:
            break
        }
    }

    private func showMoveFrame() {
        guard let m = moving else { moveFrame.path = nil; return }
        moveFrame.path = UIBezierPath(rect: convert(m.ann.bounds, from: m.page).insetBy(dx: -3, dy: -3)).cgPath
    }

    // Doppeltippen auf ein Textfeld im Auswahlmodus: bearbeiten
    private func editTapShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard tool == "select", let (page, p) = pagePoint(g.location(in: self)), let ann = page.annotation(at: p) else { return false }
        return ann.type == "FreeText"
    }

    private func pagePoint(_ vp: CGPoint) -> (PDFPage, CGPoint)? {
        guard let page = page(for: vp, nearest: true) else { return nil }
        return (page, convert(vp, to: page))
    }

    // MARK: Zeichnen

    private var isMarkupTool: Bool { ["highlight", "underline", "strike"].contains(tool) }

    private func strokeStyle() -> (UIColor, CGFloat) {
        guard let ed = editor else { return (.black, 2) }
        if tool == "highlight" { return (ed.color.withAlphaComponent(0.45), 14) }
        return (ed.color, ed.lineWidth)
    }

    @objc private func handleDraw(_ g: DrawGesture) {
        guard let ed = editor else { return }
        switch g.state {
        case .began:
            endTextEditing(commit: true)
            guard let first = g.samples.first, let (page, p) = pagePoint(first) else { return }
            dragPage = page
            points = [p]
            let (c, w) = strokeStyle()
            preview.strokeColor = c.cgColor
            preview.lineWidth = w * scaleFactor
            if tool == "eraser" { erase(at: p, on: page) }
        case .changed:
            guard let page = dragPage else { return }
            let fresh = g.samples.map { convert($0, to: page) }
            points.append(contentsOf: fresh)
            switch tool {
            case "eraser":
                for p in fresh { erase(at: p, on: page) }
            case "rect", "ellipse", "line", "arrow":
                preview.path = shapePath(from: points[0], to: points[points.count - 1], on: page)
            default:
                preview.path = viewPath(for: points, on: page)
            }
        case .ended:
            guard let page = dragPage else { return }
            points.append(contentsOf: g.samples.map { convert($0, to: page) })
            preview.path = nil
            dragPage = nil
            let pts = points
            points = []
            switch tool {
            case "pen":
                if pts.count >= 2 { addInk(pts, on: page, color: ed.color, width: ed.lineWidth) }
            case "rect", "ellipse", "line", "arrow":
                guard let a = pts.first, let b = pts.last, abs(a.x - b.x) + abs(a.y - b.y) >= 4 else { return }
                addShape(from: a, to: b, on: page)
            case "highlight", "underline", "strike":
                // Über Text gezogen: echte Markierung. Auf Scans (ohne Text): Freihand.
                if let a = pts.first, let b = pts.last, let sel = page.selection(from: a, to: b),
                   !(sel.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, abs(b.y - a.y) < 40 || abs(b.x - a.x) > 20 {
                    markup(sel)
                } else if pts.count >= 2 {
                    let (c, w) = strokeStyle()
                    addInk(pts, on: page, color: c, width: w)
                }
            default:
                break
            }
        default:
            preview.path = nil
            dragPage = nil
            points = []
        }
    }

    // Bildschirmpfad für die Vorschau beim Zeichnen
    private func viewPath(for pts: [CGPoint], on page: PDFPage) -> CGPath {
        let path = CGMutablePath()
        let vpts = pts.map { convert($0, from: page) }
        guard let first = vpts.first else { return path }
        path.move(to: first)
        for i in 1..<max(1, vpts.count) {
            let mid = CGPoint(x: (vpts[i - 1].x + vpts[i].x) / 2, y: (vpts[i - 1].y + vpts[i].y) / 2)
            path.addQuadCurve(to: mid, control: vpts[i - 1])
        }
        if let last = vpts.last { path.addLine(to: last) }
        return path
    }

    private func shapePath(from s: CGPoint, to e: CGPoint, on page: PDFPage) -> CGPath {
        let a = convert(s, from: page), b = convert(e, from: page)
        let path = CGMutablePath()
        let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
        if tool == "rect" { path.addRect(r) }
        else if tool == "ellipse" { path.addEllipse(in: r) }
        else { path.move(to: a); path.addLine(to: b) }
        return path
    }

    // MARK: Anmerkungen erzeugen

    private func addInk(_ pts: [CGPoint], on page: PDFPage, color: UIColor, width: CGFloat) {
        guard let ed = editor else { return }
        let xs = pts.map(\.x), ys = pts.map(\.y)
        let pad = width * 2 + 2
        let bounds = CGRect(x: xs.min()! - pad, y: ys.min()! - pad, width: xs.max()! - xs.min()! + 2 * pad, height: ys.max()! - ys.min()! + 2 * pad)
        let ann = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        let path = UIBezierPath()
        let rel = pts.map { CGPoint(x: $0.x - bounds.minX, y: $0.y - bounds.minY) }
        path.move(to: rel[0])
        for i in 1..<rel.count {
            let mid = CGPoint(x: (rel[i - 1].x + rel[i].x) / 2, y: (rel[i - 1].y + rel[i].y) / 2)
            path.addQuadCurve(to: mid, controlPoint: rel[i - 1])
        }
        path.addLine(to: rel[rel.count - 1])
        path.lineWidth = width
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        ann.add(path)
        let border = PDFBorder()
        border.lineWidth = width
        ann.border = border
        ann.color = color
        ed.add(ann, to: page)
    }

    private func addShape(from a: CGPoint, to b: CGPoint, on page: PDFPage) {
        guard let ed = editor else { return }
        let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
        let border = PDFBorder()
        border.lineWidth = ed.lineWidth
        let ann: PDFAnnotation
        switch tool {
        case "rect":
            ann = PDFAnnotation(bounds: r.insetBy(dx: -ed.lineWidth, dy: -ed.lineWidth), forType: .square, withProperties: nil)
        case "ellipse":
            ann = PDFAnnotation(bounds: r.insetBy(dx: -ed.lineWidth, dy: -ed.lineWidth), forType: .circle, withProperties: nil)
        default:
            let pad = ed.lineWidth * 4 + 6
            let bounds = r.insetBy(dx: -pad, dy: -pad)
            ann = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
            ann.startPoint = CGPoint(x: a.x - bounds.minX, y: a.y - bounds.minY)
            ann.endPoint = CGPoint(x: b.x - bounds.minX, y: b.y - bounds.minY)
            if tool == "arrow" { ann.endLineStyle = .closedArrow; ann.interiorColor = ed.color }
        }
        ann.border = border
        ann.color = ed.color
        ed.add(ann, to: page)
    }

    private func markup(_ sel: PDFSelection) {
        guard let ed = editor else { return }
        let type: PDFAnnotationSubtype = tool == "highlight" ? .highlight : tool == "underline" ? .underline : .strikeOut
        for line in sel.selectionsByLine() {
            for page in line.pages {
                let b = line.bounds(for: page)
                if b.width < 1 { continue }
                let ann = PDFAnnotation(bounds: b, forType: type, withProperties: nil)
                ann.color = tool == "highlight" ? ed.color.withAlphaComponent(0.45) : ed.color
                ann.quadrilateralPoints = [
                    NSValue(cgPoint: CGPoint(x: 0, y: b.height)), NSValue(cgPoint: CGPoint(x: b.width, y: b.height)),
                    NSValue(cgPoint: CGPoint(x: 0, y: 0)), NSValue(cgPoint: CGPoint(x: b.width, y: 0))
                ]
                ed.add(ann, to: page)
            }
        }
    }

    // Radierer: Striche genau am Strich treffen, alles andere an seiner Fläche
    private func erase(at p: CGPoint, on page: PDFPage) {
        guard let ed = editor else { return }
        let tolerance = max(8, 14 / max(scaleFactor, 0.1))
        for ann in page.annotations.reversed() where ann.type != "Link" && ann.type != "Widget" {
            guard ann.bounds.insetBy(dx: -tolerance, dy: -tolerance).contains(p) else { continue }
            if ann.type == "Ink", let paths = ann.paths {
                let local = CGPoint(x: p.x - ann.bounds.minX, y: p.y - ann.bounds.minY)
                let w = max(ann.border?.lineWidth ?? 2, 1)
                let hit = paths.contains { $0.cgPath.copy(strokingWithWidth: w + tolerance, lineCap: .round, lineJoin: .round, miterLimit: 1).contains(local) }
                if !hit { continue }
            } else if !ann.bounds.contains(p) {
                continue
            }
            ed.remove(ann, from: page)
        }
    }

    // MARK: Textfelder

    @objc private func handleTextTap(_ g: UITapGestureRecognizer) {
        // Das Loslassen nach dem Verschieben ist kein neues Textfeld
        if moving != nil || Date().timeIntervalSince(lastMoveEnd) < 0.4 { return }
        guard let (page, p) = pagePoint(g.location(in: self)) else { return }
        if let ann = page.annotation(at: p), ann.type == "FreeText", ann !== editingAnnotation {
            beginEditing(ann, on: page)
            return
        }
        if textView != nil { endTextEditing(commit: true); return }
        _ = newTextField(at: p, on: page)
    }

    @objc private func handleEditTap(_ g: UITapGestureRecognizer) {
        guard let (page, p) = pagePoint(g.location(in: self)), let ann = page.annotation(at: p), ann.type == "FreeText" else { return }
        beginEditing(ann, on: page)
    }

    @discardableResult
    private func newTextField(at p: CGPoint, on page: PDFPage) -> UITextView? {
        guard let ed = editor else { return nil }
        let h = ed.fontSize * 1.5
        let ann = PDFAnnotation(bounds: CGRect(x: p.x, y: p.y - h / 2, width: 180, height: h), forType: .freeText, withProperties: nil)
        // Helvetica statt Systemschrift: die kennt jedes PDF-Programm (sonst erscheint Times)
        ann.font = UIFont(name: "Helvetica", size: ed.fontSize) ?? UIFont.systemFont(ofSize: ed.fontSize)
        ann.fontColor = ed.color
        ann.color = .clear
        let border = PDFBorder()
        border.lineWidth = 0
        ann.border = border
        ann.contents = ""
        page.addAnnotation(ann)
        return beginEditing(ann, on: page, isNew: true)
    }

    @discardableResult
    private func beginEditing(_ ann: PDFAnnotation, on page: PDFPage, isNew: Bool = false) -> UITextView {
        endTextEditing(commit: true)
        editingAnnotation = ann
        editingPage = page
        let tv = UITextView()
        // Das Blatt ist immer weiß – auch im Dunkelmodus soll das Feld wie Papier aussehen
        tv.overrideUserInterfaceStyle = .light
        tv.backgroundColor = UIColor.white.withAlphaComponent(0.92)
        tv.layer.borderColor = UIColor.systemBlue.withAlphaComponent(0.6).cgColor
        tv.layer.borderWidth = 1
        tv.layer.cornerRadius = 3
        tv.textContainerInset = UIEdgeInsets(top: 1, left: 1, bottom: 1, right: 1)
        tv.textContainer.lineFragmentPadding = 2
        tv.isScrollEnabled = false
        tv.textColor = ann.fontColor ?? .black
        tv.text = ann.contents ?? ""
        tv.autocorrectionType = .default
        tv.delegate = self
        addSubview(tv)
        textView = tv
        if isNew { ann.setValue("new", forAnnotationKey: PDFAnnotationKey(rawValue: "/HeftNew")) }
        // Während des Schreibens die Anmerkung selbst ausblenden
        ann.shouldDisplay = false
        positionTextView()
        tv.becomeFirstResponder()
        return tv
    }

    // Feld an die Stelle auf der Seite legen (auch nach Blättern/Zoomen)
    private func positionTextView() {
        guard let tv = textView, let ann = editingAnnotation, let page = editingPage else { return }
        let fontSize = (ann.font?.pointSize ?? 14) * scaleFactor
        if tv.font?.pointSize != fontSize { tv.font = ann.font?.withSize(fontSize) ?? UIFont.systemFont(ofSize: fontSize) }
        let topLeft = convert(CGPoint(x: ann.bounds.minX, y: ann.bounds.maxY), from: page)
        let pageRight = convert(CGPoint(x: page.bounds(for: .cropBox).maxX, y: 0), from: page).x
        let maxW = max(80, pageRight - topLeft.x - 4)
        let font = tv.font ?? UIFont.systemFont(ofSize: fontSize)
        let text = (tv.text ?? "").isEmpty ? "Text …" : tv.text! + " "
        let measured = (text as NSString).boundingRect(with: CGSize(width: maxW - 8, height: .greatestFiniteMagnitude),
                                                        options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil)
        let w = min(maxW, max(120 * scaleFactor, ceil(measured.width) + 12))
        let fit = tv.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude))
        tv.frame = CGRect(x: topLeft.x - 3, y: topLeft.y - 3, width: w, height: max(fit.height, font.lineHeight + 6))
    }

    @objc private func viewMoved() { positionTextView() }

    func textViewDidChange(_ tv: UITextView) { positionTextView() }

    func textViewDidEndEditing(_ tv: UITextView) {
        if tv === textView { endTextEditing(commit: true) }
    }

    func endTextEditing(commit: Bool) {
        guard let tv = textView, let ann = editingAnnotation, let page = editingPage else { return }
        textView = nil
        editingAnnotation = nil
        editingPage = nil
        let text = tv.text ?? ""
        tv.delegate = nil
        tv.removeFromSuperview()
        ann.shouldDisplay = true
        let wasNew = ann.value(forAnnotationKey: PDFAnnotationKey(rawValue: "/HeftNew")) != nil
        ann.removeValue(forAnnotationKey: PDFAnnotationKey(rawValue: "/HeftNew"))
        guard let ed = editor else { return }
        if !commit || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            page.removeAnnotation(ann)
            if !wasNew { ed.undo.registerUndo(withTarget: ed) { $0.add(ann, to: page) }; ed.changed() }
            return
        }
        let old = ann.contents ?? ""
        let oldBounds = ann.bounds
        ann.contents = text
        // Kasten an den Text anpassen
        let font = ann.font ?? UIFont.systemFont(ofSize: 14)
        let maxW = max(60, page.bounds(for: .mediaBox).maxX - ann.bounds.minX - 10)
        let size = (text as NSString).boundingRect(with: CGSize(width: maxW, height: 10000), options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil).size
        let top = ann.bounds.maxY
        ann.bounds = CGRect(x: ann.bounds.minX, y: top - ceil(size.height) - 6, width: ceil(size.width) + 12, height: ceil(size.height) + 6)
        if wasNew {
            ed.undo.registerUndo(withTarget: ed) { $0.remove(ann, from: page) }
        } else if old != text {
            ed.undo.registerUndo(withTarget: ed) { e in ann.contents = old; e.changed() }
        }
        if wasNew || old != text || ann.bounds != oldBounds { ed.changed() }
    }

    // Tastatur: Textfeld sichtbar halten
    @objc private func keyboardChanged(_ n: Notification) {
        guard let tv = textView, let sv = innerScrollView, let window,
              let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let kb = convert(window.convert(end, from: nil), from: window)
        let overlap = tv.frame.maxY + 20 - kb.minY
        guard kb.minY < bounds.maxY, overlap > 0 else { return }
        var o = sv.contentOffset
        o.y += overlap
        sv.setContentOffset(o, animated: true)
    }

    // MARK: Scribble – mit dem Apple Pencil aufs Blatt schreiben
    //
    // Im Text-Werkzeug ist das ganze Blatt ein Schreibfeld: Wo man anfängt zu
    // schreiben, entsteht ein Textfeld, und die Handschrift landet darin als Text.
    // Schreibt man auf ein vorhandenes Textfeld, geht es dort weiter.

    func indirectScribbleInteraction(_ interaction: UIInteraction, requestElementsIn rect: CGRect, completion: @escaping ([String]) -> Void) {
        guard tool == "text" else { completion([]); return }
        var ids: [String] = []
        if let tv = textView, tv.frame.insetBy(dx: -24, dy: -16).intersects(rect) { ids.append("edit") }
        for page in visiblePages {
            let pi = document?.index(for: page) ?? 0
            for (i, ann) in page.annotations.enumerated() where ann.type == "FreeText" && ann !== editingAnnotation {
                if convert(ann.bounds, from: page).insetBy(dx: -6, dy: -6).intersects(rect) { ids.append("ann:\(pi):\(i)") }
            }
        }
        if ids.isEmpty { ids.append("new") }
        completion(ids)
    }

    func indirectScribbleInteraction(_ interaction: UIInteraction, isElementFocused id: String) -> Bool {
        id == "edit" && textView?.isFirstResponder == true
    }

    func indirectScribbleInteraction(_ interaction: UIInteraction, frameForElement id: String) -> CGRect {
        if id == "edit", let tv = textView { return tv.frame }
        if let (page, ann) = annotation(for: id) { return convert(ann.bounds, from: page).insetBy(dx: -6, dy: -6) }
        return bounds
    }

    func indirectScribbleInteraction(_ interaction: UIInteraction, focusElementIfNeeded id: String, referencePoint: CGPoint,
                                     completion: @escaping ((UIResponder & UITextInput)?) -> Void) {
        if id == "edit", let tv = textView {
            if !tv.isFirstResponder { tv.becomeFirstResponder() }
            completion(tv)
        } else if let (page, ann) = annotation(for: id) {
            completion(beginEditing(ann, on: page))
        } else if let (page, p) = pagePoint(referencePoint) {
            completion(newTextField(at: p, on: page))
        } else {
            completion(nil)
        }
    }

    func indirectScribbleInteraction(_ interaction: UIInteraction, didFinishWritingInElement id: String) {
        positionTextView()
    }

    private func annotation(for id: String) -> (PDFPage, PDFAnnotation)? {
        let parts = id.split(separator: ":")
        guard parts.count == 3, parts[0] == "ann", let pi = Int(parts[1]), let ai = Int(parts[2]),
              let page = document?.page(at: pi), ai < page.annotations.count else { return nil }
        return (page, page.annotations[ai])
    }
}

extension UIColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
