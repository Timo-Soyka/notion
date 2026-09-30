import AppKit
import PDFKit
import Vision

// Arbeitsblätter bearbeiten.
//
// PDFKit (dieselbe Technik wie in Vorschau) zeigt die Seiten an; die Werkzeuge
// erzeugen echte PDF-Anmerkungen: Text zum Ausfüllen, Stift, Textmarker,
// Unter-/Durchstreichen, Formen. Gespeichert wird automatisch, sobald man kurz
// innehält, und beim Verlassen des Blatts – über DEVONthink, damit die Datei
// in der Datenbank sauber aktualisiert und synchronisiert wird.

final class PDFEditorView: NSView {
    let uuid: String
    let document: PDFDocument
    let pdfView = HeftPDFView()
    let undoManagerForPDF = UndoManager()
    weak var host: MainWindowController?

    var tool = "select" { didSet { pdfView.tool = tool; window?.invalidateCursorRects(for: pdfView) } }
    var color = NSColor(srgbRed: 0.11, green: 0.31, blue: 0.85, alpha: 1)
    var lineWidth: CGFloat = 2
    var fontSize: CGFloat = 14

    private var dirty = false
    private var saveWork: DispatchWorkItem?
    private var saving = false
    private var lastSave = Date.distantPast
    private var firstUnsaved: Date?
    // Dateigröße in Bytes – bestimmt, wie oft automatisch gespeichert wird
    private var fileBytes: Int

    init(uuid: String, document: PDFDocument, fileBytes: Int, host: MainWindowController) {
        self.uuid = uuid
        self.document = document
        self.fileBytes = fileBytes
        self.host = host
        super.init(frame: .zero)
        wantsLayer = true
        autoresizingMask = []
        pdfView.frame = bounds
        pdfView.autoresizingMask = [.width, .height]
        pdfView.document = document
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displaysPageBreaks = true
        pdfView.pageBreakMargins = NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        pdfView.backgroundColor = NSColor(name: nil) { ap in
            ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.13, alpha: 1) : NSColor(white: 0.97, alpha: 1)
        }
        pdfView.editor = self
        addSubview(pdfView)
        NotificationCenter.default.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdfView)
        NotificationCenter.default.addObserver(self, selector: #selector(appDeactivated), name: NSApplication.didResignActiveNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(macWillSleep), name: NSWorkspace.willSleepNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    @objc private func pageChanged() {
        guard let page = pdfView.currentPage else { return }
        let idx = document.index(for: page) + 1
        host?.emit("pdf-state", ["uuid": uuid, "page": idx, "pages": document.pageCount])
    }

    // MARK: - Werkzeuge

    func setTool(_ a: [String: Any]) {
        tool = (a["tool"] as? String) ?? "select"
        if let hex = a["color"] as? String, let c = NSColor(hex: hex) { color = c }
        if let w = a["width"] as? NSNumber { lineWidth = CGFloat(w.doubleValue) }
        if let f = a["fontSize"] as? NSNumber { fontSize = CGFloat(f.doubleValue) }
        pdfView.endTextEditing(commit: true)
    }

    // MARK: - Anmerkungen hinzufügen/entfernen (mit Rückgängig)

    func add(_ ann: PDFAnnotation, to page: PDFPage) {
        page.addAnnotation(ann)
        undoManagerForPDF.registerUndo(withTarget: self) { $0.remove(ann, from: page) }
        changed()
    }

    func remove(_ ann: PDFAnnotation, from page: PDFPage) {
        page.removeAnnotation(ann)
        undoManagerForPDF.registerUndo(withTarget: self) { $0.add(ann, to: page) }
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
    // Jede Sicherung schreibt das ganze PDF neu – bei eingescannten Blättern
    // Dutzende MB. Früher geschah das 1,5 s nach jedem Strich; beim Ausfüllen
    // eines großen Scans kamen so in einer halben Stunde über 2 GB zusammen.
    // Jetzt wird gespeichert, wenn man kurz innehält, bei großen Dateien aber
    // nur alle paar Minuten. Sofort gespeichert wird beim Verlassen des Blatts,
    // beim Wechsel in ein anderes Programm, vor dem Ruhezustand und beim Beenden.

    private var megabytes: Double { Double(fileBytes) / 1_048_576 }
    // Pause nach der letzten Änderung: 3 s, bei großen Dateien bis 10 s
    private var savePause: TimeInterval { min(10, 3 + megabytes / 5) }
    // Mindestabstand zwischen zwei Sicherungen: 8 s je MB (30 MB → 4 min), höchstens 10 min
    private var saveSpacing: TimeInterval { min(600, max(5, megabytes * 8)) }
    // Wer ohne Pause weiterschreibt, bekommt trotzdem spätestens nach einer
    // Minute eine Sicherung (bzw. sobald der Mindestabstand um ist)
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

    // Nicht mitten ins Tippen hinein speichern: der Textkasten landete sonst
    // leer und ausgeblendet in der Datei, und das Eingabefeld ginge zu
    private func autosave() {
        guard dirty else { return }
        if pdfView.isEditingText { planAutosave(after: savePause); return }
        saveNow()
    }

    @objc private func appDeactivated() { autosave() }

    @objc private func macWillSleep() { saveNow() }

    func saveNow() {
        pdfView.endTextEditing(commit: true)
        saveWork?.cancel()
        saveWork = nil
        guard dirty else { return }
        let tmp = Store.shared.tempFile("arbeitsblatt.pdf")
        // write(to:) schreibt direkt in die Datei. dataRepresentation() hielte bei
        // jedem Aufruf eine komplette Kopie des PDFs im Speicher fest, die PDFKit
        // nie wieder freigibt – bei großen Scans wuchs Heft so auf mehrere GB.
        guard document.write(to: tmp) else {
            try? FileManager.default.removeItem(at: tmp)
            host?.emit("toast", ["message": "Arbeitsblatt nicht gespeichert: Die Datei ließ sich nicht schreiben.", "type": "error"])
            return
        }
        dirty = false
        firstUnsaved = nil
        lastSave = Date()
        if let size = (try? tmp.resourceValues(forKeys: [.fileSizeKey]))?.fileSize { fileBytes = size }
        saving = true
        host?.emit("pdf-state", ["uuid": uuid, "saved": false, "saving": true])
        let uuid = self.uuid
        Self.beginSaving(uuid, document, fileBytes)
        DEVONthink.shared.async({ try DEVONthink.shared.replaceData(uuid: uuid, with: tmp) }) { [weak self, weak host = self.host] result in
            try? FileManager.default.removeItem(at: tmp)
            DispatchQueue.main.async {
                Self.endSaving(uuid)
                SchemeHandler.shared.invalidate(uuid: uuid)
                self?.saving = false
                switch result {
                // Auch wenn das Blatt schon verlassen wurde: eingebettete Seiten im Eintrag auffrischen
                case .success: host?.emit("pdf-state", ["uuid": uuid, "saved": true, "dirty": self?.dirty ?? false])
                case .failure(let e):
                    if let me = self {
                        me.dirty = true
                        if me.firstUnsaved == nil { me.firstUnsaved = Date() }
                    }
                    host?.emit("toast", ["message": "Arbeitsblatt nicht gespeichert: \(e.localizedDescription)", "type": "error"])
                }
            }
        }
    }

    // Stände, die gerade zu DEVONthink unterwegs sind. Öffnet man das Blatt
    // vorher wieder, geht es mit diesem Stand weiter – die Datei in DEVONthink
    // ist dann ja noch die alte, und der nächste Speichervorgang würde die
    // letzten Änderungen sonst überschreiben.
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
        let name = (a["action"] as? String) ?? ""
        switch name {
        case "undo": undoManagerForPDF.undo(); reply(.success(true))
        case "redo": undoManagerForPDF.redo(); reply(.success(true))
        case "zoomIn": pdfView.zoomIn(nil); reply(.success(true))
        case "zoomOut": pdfView.zoomOut(nil); reply(.success(true))
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
        undoManagerForPDF.registerUndo(withTarget: self) { $0.rotate(page, by: -deg) }
        changed()
    }

    private func deletePage(_ page: PDFPage) {
        let idx = document.index(for: page)
        document.removePage(at: idx)
        undoManagerForPDF.registerUndo(withTarget: self) { me in
            me.document.insert(page, at: idx)
            me.changed()
        }
        changed()
        pageChanged()
    }

    // Leere, karierte oder linierte Seite anfügen – Platz für Rechnungen
    private func addPage(style: String) {
        let ref = pdfView.currentPage ?? document.page(at: 0)
        let size = ref?.bounds(for: .mediaBox).size ?? NSSize(width: 595.28, height: 841.89)
        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: size)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return }
        ctx.beginPDFPage(nil)
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(box)
        let mm: CGFloat = 72 / 25.4
        let margin = 12 * mm
        if style == "grid" {
            ctx.setStrokeColor(NSColor(srgbRed: 0.72, green: 0.8, blue: 0.9, alpha: 1).cgColor)
            ctx.setLineWidth(0.4)
            var x = margin
            while x <= size.width - margin + 0.1 { ctx.move(to: CGPoint(x: x, y: margin)); ctx.addLine(to: CGPoint(x: x, y: size.height - margin)); x += 5 * mm }
            var y = margin
            while y <= size.height - margin + 0.1 { ctx.move(to: CGPoint(x: margin, y: y)); ctx.addLine(to: CGPoint(x: size.width - margin, y: y)); y += 5 * mm }
            ctx.strokePath()
        } else if style == "lines" {
            ctx.setStrokeColor(NSColor(srgbRed: 0.72, green: 0.8, blue: 0.9, alpha: 1).cgColor)
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
        undoManagerForPDF.registerUndo(withTarget: self) { me in
            let i = me.document.index(for: page)
            if i != NSNotFound { me.document.removePage(at: i) }
            me.changed()
        }
        changed()
        pdfView.go(to: page)
    }

    // MARK: - Texterkennung

    private func runOCR(reply: @escaping (Result<Any, Error>) -> Void) {
        let existing = (document.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pages = (0..<document.pageCount).compactMap { document.page(at: $0) }
        let uuid = self.uuid
        DispatchQueue.global(qos: .userInitiated).async {
            var texts: [String] = []
            for page in pages {
                let b = page.bounds(for: .mediaBox)
                let scale: CGFloat = 2.5
                let img = page.thumbnail(of: NSSize(width: b.width * scale, height: b.height * scale), for: .mediaBox)
                guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
                let req = VNRecognizeTextRequest()
                req.recognitionLevel = .accurate
                req.recognitionLanguages = ["de-DE", "en-US", "fr-FR", "la"]
                req.usesLanguageCorrection = true
                try? VNImageRequestHandler(cgImage: cg).perform([req])
                let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                texts.append(lines.joined(separator: "\n"))
            }
            var text = texts.joined(separator: "\n\n")
            if text.count < existing.count { text = existing }
            guard !text.isEmpty else { reply(.success(["chars": 0])); return }
            let tmp = Store.shared.tempFile("ocr.txt")
            do {
                try text.write(to: tmp, atomically: true, encoding: .utf8)
                _ = try DEVONthink.shared.run(Scripts.setPlainText, [uuid, tmp.path])
                try? FileManager.default.removeItem(at: tmp)
                reply(.success(["chars": text.count]))
            } catch { reply(.failure(error)) }
        }
    }
}

// MARK: - PDFView mit Zeichenwerkzeugen

final class HeftPDFView: PDFView {
    weak var editor: PDFEditorView?
    var tool = "select"

    private let overlay = CAShapeLayer()
    private var points: [NSPoint] = []      // in Seitenkoordinaten
    private var dragStart: NSPoint?
    private var dragPage: PDFPage?
    private var textField: NSTextField?
    private var editingAnnotation: PDFAnnotation?
    private var editingPage: PDFPage?
    private var selectedAnnotation: PDFAnnotation?

    var isEditingText: Bool { textField != nil }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        overlay.fillColor = nil
        overlay.lineCap = .round
        overlay.lineJoin = .round
        layer?.addSublayer(overlay)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        overlay.frame = bounds
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        switch tool {
        case "pen", "rect", "ellipse", "line", "arrow": addCursorRect(bounds, cursor: .crosshair)
        case "text": addCursorRect(bounds, cursor: .iBeam)
        case "eraser": addCursorRect(bounds, cursor: .disappearingItem)
        default: break
        }
    }

    private var isMarkupTool: Bool { ["highlight", "underline", "strike"].contains(tool) }

    private func pagePoint(_ event: NSEvent) -> (PDFPage, NSPoint)? {
        let vp = convert(event.locationInWindow, from: nil)
        guard let page = page(for: vp, nearest: true) else { return nil }
        return (page, convert(vp, to: page))
    }

    // MARK: Maus

    override func mouseDown(with event: NSEvent) {
        guard let ed = editor else { super.mouseDown(with: event); return }
        if tool == "select" || isMarkupTool {
            if let (page, p) = pagePoint(event), let ann = page.annotation(at: p), ann.type != "Link", ann.type != "Widget" {
                // Doppelklick auf einen Textkasten: bearbeiten
                if event.clickCount == 2, ann.type == "FreeText" { beginEditing(ann, on: page); return }
                selectedAnnotation = ann
            } else {
                selectedAnnotation = nil
            }
            super.mouseDown(with: event)
            return
        }
        guard let (page, p) = pagePoint(event) else { return }
        endTextEditing(commit: true)
        switch tool {
        case "pen":
            points = [p]
            dragPage = page
            overlay.strokeColor = ed.color.cgColor
            overlay.lineWidth = ed.lineWidth * scaleFactor
            overlay.lineDashPattern = nil
        case "rect", "ellipse", "line", "arrow":
            dragStart = p
            dragPage = page
            overlay.strokeColor = ed.color.cgColor
            overlay.lineWidth = ed.lineWidth * scaleFactor
            overlay.lineDashPattern = nil
        case "text":
            if let ann = page.annotation(at: p), ann.type == "FreeText" { beginEditing(ann, on: page); return }
            let h = ed.fontSize * 1.5
            let ann = PDFAnnotation(bounds: NSRect(x: p.x, y: p.y - h / 2, width: 180, height: h), forType: .freeText, withProperties: nil)
            ann.font = NSFont.systemFont(ofSize: ed.fontSize)
            ann.fontColor = ed.color
            ann.color = .clear
            let border = PDFBorder()
            border.lineWidth = 0
            ann.border = border
            ann.contents = ""
            page.addAnnotation(ann)
            beginEditing(ann, on: page, isNew: true)
        case "eraser":
            if let ann = page.annotation(at: p), ann.type != "Link", ann.type != "Widget" {
                ed.remove(ann, from: page)
            }
        default:
            super.mouseDown(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let ed = editor, let page = dragPage else { super.mouseDragged(with: event); return }
        let vp = convert(event.locationInWindow, from: nil)
        let p = convert(vp, to: page)
        switch tool {
        case "pen":
            points.append(p)
            overlay.path = viewPath(for: points, on: page)
        case "rect", "ellipse", "line", "arrow":
            guard let s = dragStart else { return }
            let a = convert(s, from: page), b = convert(p, from: page)
            let path = CGMutablePath()
            let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            if tool == "rect" { path.addRect(r) }
            else if tool == "ellipse" { path.addEllipse(in: r) }
            else { path.move(to: a); path.addLine(to: b) }
            overlay.path = path
        default:
            super.mouseDragged(with: event)
        }
        _ = ed
    }

    override func mouseUp(with event: NSEvent) {
        guard let ed = editor else { super.mouseUp(with: event); return }
        if isMarkupTool {
            super.mouseUp(with: event)
            if let sel = currentSelection, !(sel.string ?? "").isEmpty { markup(sel) }
            return
        }
        guard let page = dragPage else { super.mouseUp(with: event); return }
        let vp = convert(event.locationInWindow, from: nil)
        let p = convert(vp, to: page)
        overlay.path = nil
        dragPage = nil
        switch tool {
        case "pen":
            points.append(p)
            if points.count >= 2 { addInk(points, on: page) }
            points = []
        case "rect", "ellipse", "line", "arrow":
            guard let s = dragStart else { return }
            dragStart = nil
            if abs(s.x - p.x) + abs(s.y - p.y) < 4 { return }
            addShape(from: s, to: p, on: page)
        default:
            super.mouseUp(with: event)
        }
        _ = ed
    }

    // Bildschirmpfad (für die Live-Vorschau beim Zeichnen)
    private func viewPath(for pts: [NSPoint], on page: PDFPage) -> CGPath {
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

    // MARK: Anmerkungen erzeugen

    private func addInk(_ pts: [NSPoint], on page: PDFPage) {
        guard let ed = editor else { return }
        let xs = pts.map(\.x), ys = pts.map(\.y)
        let pad = ed.lineWidth * 2 + 2
        let bounds = NSRect(x: xs.min()! - pad, y: ys.min()! - pad, width: xs.max()! - xs.min()! + 2 * pad, height: ys.max()! - ys.min()! + 2 * pad)
        let ann = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        let path = NSBezierPath()
        let rel = pts.map { NSPoint(x: $0.x - bounds.minX, y: $0.y - bounds.minY) }
        path.move(to: rel[0])
        for i in 1..<rel.count {
            let mid = NSPoint(x: (rel[i - 1].x + rel[i].x) / 2, y: (rel[i - 1].y + rel[i].y) / 2)
            path.curve(to: mid, controlPoint1: rel[i - 1], controlPoint2: rel[i - 1])
        }
        path.line(to: rel[rel.count - 1])
        path.lineWidth = ed.lineWidth
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        ann.add(path)
        let border = PDFBorder()
        border.lineWidth = ed.lineWidth
        ann.border = border
        ann.color = ed.color
        ed.add(ann, to: page)
    }

    private func addShape(from a: NSPoint, to b: NSPoint, on page: PDFPage) {
        guard let ed = editor else { return }
        let r = NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
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
            ann.startPoint = NSPoint(x: a.x - bounds.minX, y: a.y - bounds.minY)
            ann.endPoint = NSPoint(x: b.x - bounds.minX, y: b.y - bounds.minY)
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
                // Viereckspunkte relativ zu den Grenzen – so zeigen auch
                // andere Programme die Markierung richtig an
                ann.quadrilateralPoints = [
                    NSValue(point: NSPoint(x: 0, y: b.height)), NSValue(point: NSPoint(x: b.width, y: b.height)),
                    NSValue(point: NSPoint(x: 0, y: 0)), NSValue(point: NSPoint(x: b.width, y: 0))
                ]
                ed.add(ann, to: page)
            }
        }
        clearSelection()
    }

    // MARK: Textfelder

    private func beginEditing(_ ann: PDFAnnotation, on page: PDFPage, isNew: Bool = false) {
        endTextEditing(commit: true)
        editingAnnotation = ann
        editingPage = page
        let r = convert(ann.bounds, from: page)
        let field = NSTextField(frame: r.insetBy(dx: -2, dy: -2))
        field.isBordered = false
        field.drawsBackground = true
        // Das Blatt ist immer weiß – auch im Dunkelmodus soll das Feld wie Papier aussehen
        field.appearance = NSAppearance(named: .aqua)
        field.backgroundColor = NSColor.white.withAlphaComponent(0.92)
        field.focusRingType = .exterior
        field.font = NSFont.systemFont(ofSize: (ann.font?.pointSize ?? 14) * scaleFactor)
        field.textColor = ann.fontColor ?? .black
        field.stringValue = ann.contents ?? ""
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.usesSingleLineMode = false
        field.target = self
        field.action = #selector(fieldCommitted(_:))
        field.placeholderString = "Text …"
        addSubview(field)
        textField = field
        // Während des Tippens die Anmerkung selbst ausblenden
        ann.shouldDisplay = false
        window?.makeFirstResponder(field)
        if isNew { ann.setValue("new", forAnnotationKey: PDFAnnotationKey(rawValue: "/HeftNew")) }
    }

    @objc private func fieldCommitted(_ sender: NSTextField) {
        endTextEditing(commit: true)
    }

    func endTextEditing(commit: Bool) {
        guard let field = textField, let ann = editingAnnotation, let page = editingPage else { return }
        textField = nil
        editingAnnotation = nil
        editingPage = nil
        field.removeFromSuperview()
        ann.shouldDisplay = true
        let text = field.stringValue
        let wasNew = ann.value(forAnnotationKey: PDFAnnotationKey(rawValue: "/HeftNew")) != nil
        ann.removeValue(forAnnotationKey: PDFAnnotationKey(rawValue: "/HeftNew"))
        guard let ed = editor else { return }
        if !commit || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            page.removeAnnotation(ann)
            if !wasNew { ed.undoManagerForPDF.registerUndo(withTarget: ed) { $0.add(ann, to: page) }; ed.changed() }
            return
        }
        let old = ann.contents ?? ""
        let oldBounds = ann.bounds
        ann.contents = text
        // Kasten an den Text anpassen
        let font = ann.font ?? NSFont.systemFont(ofSize: 14)
        let maxW = max(60, page.bounds(for: .mediaBox).maxX - ann.bounds.minX - 10)
        let size = (text as NSString).boundingRect(with: NSSize(width: maxW, height: 10000), options: [.usesLineFragmentOrigin], attributes: [.font: font]).size
        let top = ann.bounds.maxY
        ann.bounds = NSRect(x: ann.bounds.minX, y: top - ceil(size.height) - 6, width: ceil(size.width) + 12, height: ceil(size.height) + 6)
        if wasNew {
            ed.undoManagerForPDF.registerUndo(withTarget: ed) { $0.remove(ann, from: page) }
        } else if old != text {
            ed.undoManagerForPDF.registerUndo(withTarget: ed) { e in ann.contents = old; e.changed() }
        }
        // Nur hineingeklickt und wieder heraus: nichts zu speichern
        if wasNew || old != text || ann.bounds != oldBounds { ed.changed() }
    }

    override func keyDown(with event: NSEvent) {
        // Entf löscht eine angeklickte Anmerkung im Auswahlmodus
        if (event.keyCode == 51 || event.keyCode == 117), let ann = selectedAnnotation, let page = ann.page {
            selectedAnnotation = nil
            editor?.remove(ann, from: page)
            return
        }
        super.keyDown(with: event)
    }
}

extension NSColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
