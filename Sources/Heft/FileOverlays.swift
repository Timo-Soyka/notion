import AppKit
import AVKit
import Quartz

// Native Ansichten, die über dem WebView liegen (wie der PDF-Editor):
// Quick Look für alles, was Heft nicht selbst darstellt (Pages, Excel, Audio,
// Video …), und ein Textverarbeitungsfeld für RTF-Dokumente.

protocol DocOverlay: NSView {
    var uuid: String { get }
    func saveNow()
    func shutdown()
    func action(_ a: [String: Any]) -> Any
}

// MARK: - Quick Look

final class QuickLookOverlay: NSView, DocOverlay {
    let uuid: String
    private let preview: QLPreviewView

    init(uuid: String, url: URL) {
        self.uuid = uuid
        preview = QLPreviewView(frame: .zero, style: .normal)!
        super.init(frame: .zero)
        preview.frame = bounds
        preview.autoresizingMask = [.width, .height]
        preview.autostarts = false
        preview.shouldCloseWithWindow = false
        addSubview(preview)
        preview.previewItem = url as NSURL
    }

    required init?(coder: NSCoder) { fatalError() }

    func saveNow() {}
    func shutdown() { preview.close() }
    func action(_ a: [String: Any]) -> Any { false }
}

// MARK: - Audio und Video

final class MediaOverlay: NSView, DocOverlay {
    let uuid: String
    private let playerView = AVPlayerView()
    private let player: AVPlayer

    init(uuid: String, url: URL) {
        self.uuid = uuid
        player = AVPlayer(url: url)
        super.init(frame: .zero)
        playerView.player = player
        playerView.controlsStyle = .inline
        playerView.showsFullScreenToggleButton = true
        playerView.frame = bounds
        playerView.autoresizingMask = [.width, .height]
        addSubview(playerView)
    }

    required init?(coder: NSCoder) { fatalError() }

    func saveNow() {}
    func shutdown() { player.pause(); playerView.player = nil }

    func action(_ a: [String: Any]) -> Any {
        switch (a["cmd"] as? String) ?? "" {
        case "play": player.play(); return true
        case "pause": player.pause(); return true
        case "status":
            let d = player.currentItem.map { CMTimeGetSeconds($0.asset.duration) } ?? 0
            return ["duration": d.isFinite ? d : 0, "ready": player.currentItem?.status == .readyToPlay]
        default: return false
        }
    }
}

// MARK: - RTF

final class RichTextOverlay: NSView, DocOverlay, NSTextViewDelegate {
    let uuid: String
    let editable: Bool
    private let scroll = NSScrollView()
    private let textView: NSTextView
    private weak var host: MainWindowController?
    private var dirty = false
    private var saveWork: DispatchWorkItem?
    private let pageWidth: CGFloat = 720

    init(uuid: String, url: URL, editable: Bool, host: MainWindowController) throws {
        self.uuid = uuid
        self.editable = editable
        self.host = host
        let data = try Data(contentsOf: url)
        var attrs: NSDictionary?
        let text: NSAttributedString
        if url.pathExtension.lowercased() == "rtfd" || (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            text = try NSAttributedString(url: url, options: [:], documentAttributes: &attrs)
        } else {
            text = try NSAttributedString(data: data, options: [:], documentAttributes: &attrs)
        }
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        textView = NSTextView(frame: .zero, textContainer: container)
        super.init(frame: .zero)
        // Das Blatt bleibt immer weiß – Dokumente sind für Papier gemacht
        appearance = NSAppearance(named: .aqua)
        textView.isRichText = true
        textView.importsGraphics = true
        textView.allowsImageEditing = true
        textView.allowsUndo = true
        textView.isEditable = editable
        textView.isSelectable = true
        textView.usesFontPanel = true
        textView.usesInspectorBar = false
        textView.isContinuousSpellCheckingEnabled = editable
        textView.drawsBackground = true
        textView.backgroundColor = .white
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.delegate = self
        if storage.length == 0 { textView.typingAttributes = [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.black] }
        scroll.documentView = textView
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .white
        scroll.frame = bounds
        scroll.autoresizingMask = [.width, .height]
        addSubview(scroll)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        // Schmale Textspalte in der Mitte, wie eine Seite
        let pad = max(28, (scroll.contentSize.width - pageWidth) / 2)
        textView.textContainerInset = NSSize(width: pad, height: 36)
    }

    func focus() { window?.makeFirstResponder(textView) }

    // MARK: Speichern

    func textDidChange(_ notification: Notification) {
        guard editable else { return }
        dirty = true
        host?.emit("rich-state", ["uuid": uuid, "saved": false, "dirty": true])
        saveWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: w)
    }

    func saveNow() {
        saveWork?.cancel()
        guard editable, dirty, let storage = textView.textStorage else { return }
        dirty = false
        guard let data = storage.rtf(from: NSRange(location: 0, length: storage.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]) else { return }
        host?.emit("rich-state", ["uuid": uuid, "saving": true, "saved": false])
        let tmp = Store.shared.tempFile("dokument.rtf")
        do { try data.write(to: tmp) } catch { return }
        let uuid = self.uuid
        DEVONthink.shared.async({ try DEVONthink.shared.replaceData(uuid: uuid, with: tmp) }) { [weak self] result in
            try? FileManager.default.removeItem(at: tmp)
            DispatchQueue.main.async {
                DEVONthink.shared.forgetPath(uuid)
                switch result {
                case .success: self?.host?.emit("rich-state", ["uuid": uuid, "saved": true, "dirty": self?.dirty ?? false])
                case .failure(let e):
                    self?.dirty = true
                    self?.host?.emit("toast", ["message": "Dokument nicht gespeichert: \(e.localizedDescription)", "type": "error"])
                }
            }
        }
    }

    func shutdown() { saveNow() }

    // MARK: Formatieren (aus der Werkzeugleiste)

    func textViewDidChangeSelection(_ notification: Notification) { emitState() }

    private func currentAttributes() -> [NSAttributedString.Key: Any] {
        let r = textView.selectedRange()
        if r.length == 0 || textView.textStorage == nil { return textView.typingAttributes }
        return textView.textStorage!.attributes(at: r.location, effectiveRange: nil)
    }

    private func emitState() {
        let at = currentAttributes()
        let font = (at[.font] as? NSFont) ?? NSFont.systemFont(ofSize: 13)
        let traits = NSFontManager.shared.traits(of: font)
        let para = at[.paragraphStyle] as? NSParagraphStyle
        let align: String
        switch para?.alignment ?? .natural {
        case .center: align = "center"
        case .right: align = "right"
        case .justified: align = "justify"
        default: align = "left"
        }
        host?.emit("rich-state", [
            "uuid": uuid,
            "bold": traits.contains(.boldFontMask), "italic": traits.contains(.italicFontMask),
            "underline": ((at[.underlineStyle] as? Int) ?? 0) != 0, "strike": ((at[.strikethroughStyle] as? Int) ?? 0) != 0,
            "size": Double(font.pointSize), "family": font.familyName ?? "", "align": align,
            "list": !(para?.textLists.isEmpty ?? true)
        ])
    }

    // Auf die Auswahl anwenden – oder auf das, was als Nächstes getippt wird
    private func applyToSelection(_ change: (NSMutableAttributedString, NSRange) -> Void, typing: ([NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any]) {
        let ranges = textView.selectedRanges.map { $0.rangeValue }.filter { $0.length > 0 }
        guard let storage = textView.textStorage, editable else { return }
        if ranges.isEmpty {
            textView.typingAttributes = typing(textView.typingAttributes)
            emitState()
            return
        }
        for r in ranges where textView.shouldChangeText(in: r, replacementString: nil) {
            storage.beginEditing()
            change(storage, r)
            storage.endEditing()
            textView.didChangeText()
        }
        emitState()
    }

    private func changeFont(_ f: @escaping (NSFont) -> NSFont) {
        applyToSelection({ s, r in
            s.enumerateAttribute(.font, in: r) { v, sub, _ in
                s.addAttribute(.font, value: f((v as? NSFont) ?? NSFont.systemFont(ofSize: 13)), range: sub)
            }
        }, typing: { t in
            var t = t
            t[.font] = f((t[.font] as? NSFont) ?? NSFont.systemFont(ofSize: 13))
            return t
        })
    }

    private func toggleTrait(_ trait: NSFontTraitMask) {
        let on = NSFontManager.shared.traits(of: (currentAttributes()[.font] as? NSFont) ?? NSFont.systemFont(ofSize: 13)).contains(trait)
        changeFont { font in
            on ? NSFontManager.shared.convert(font, toNotHaveTrait: trait) : NSFontManager.shared.convert(font, toHaveTrait: trait)
        }
    }

    private func toggleAttribute(_ key: NSAttributedString.Key) {
        let on = ((currentAttributes()[key] as? Int) ?? 0) != 0
        let value = on ? 0 : NSUnderlineStyle.single.rawValue
        applyToSelection({ s, r in s.addAttribute(key, value: value, range: r) }, typing: { t in var t = t; t[key] = value; return t })
    }

    private func setAttribute(_ key: NSAttributedString.Key, _ value: Any?) {
        applyToSelection({ s, r in
            if let v = value { s.addAttribute(key, value: v, range: r) } else { s.removeAttribute(key, range: r) }
        }, typing: { t in var t = t; t[key] = value; return t })
    }

    private func changeParagraphs(_ f: (NSMutableParagraphStyle) -> Void) {
        guard let storage = textView.textStorage, editable else { return }
        let text = storage.string as NSString
        var r = text.paragraphRange(for: textView.selectedRange())
        if r.length == 0 && r.location == text.length {
            let p = ((textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle) ?? .default).mutableCopy() as! NSMutableParagraphStyle
            f(p)
            textView.typingAttributes[.paragraphStyle] = p
            emitState()
            return
        }
        if r.length == 0 { r = NSRange(location: r.location, length: 0) }
        guard textView.shouldChangeText(in: r, replacementString: nil) else { return }
        storage.beginEditing()
        storage.enumerateAttribute(.paragraphStyle, in: r) { v, sub, _ in
            let p = ((v as? NSParagraphStyle) ?? .default).mutableCopy() as! NSMutableParagraphStyle
            f(p)
            storage.addAttribute(.paragraphStyle, value: p, range: sub)
        }
        storage.endEditing()
        textView.didChangeText()
        emitState()
    }

    private func toggleList(numbered: Bool) {
        guard let storage = textView.textStorage, editable else { return }
        let text = storage.string as NSString
        let whole = text.paragraphRange(for: textView.selectedRange())
        let hasList = !((currentAttributes()[.paragraphStyle] as? NSParagraphStyle)?.textLists.isEmpty ?? true)
        let list = NSTextList(markerFormat: numbered ? .decimal : .disc, options: 0)
        // Absätze von hinten nach vorn bearbeiten, damit die Bereiche stimmen
        var paras: [NSRange] = []
        text.enumerateSubstrings(in: whole, options: .byParagraphs) { _, _, enclosing, _ in paras.append(enclosing) }
        if paras.isEmpty { paras = [whole] }
        guard textView.shouldChangeText(in: whole, replacementString: nil) else { return }
        storage.beginEditing()
        var n = paras.count
        for p in paras.reversed() {
            let line = text.substring(with: p)
            let markerLen = (line.range(of: "^\\t?[^\\t]{1,4}\\t", options: .regularExpression).map { line.distance(from: line.startIndex, to: $0.upperBound) }) ?? 0
            let style = ((storage.attribute(.paragraphStyle, at: p.location, effectiveRange: nil) as? NSParagraphStyle) ?? .default).mutableCopy() as! NSMutableParagraphStyle
            if hasList {
                if markerLen > 0 { storage.deleteCharacters(in: NSRange(location: p.location, length: markerLen)) }
                style.textLists = []
                style.headIndent = 0
                style.firstLineHeadIndent = 0
            } else {
                let marker = "\t" + list.marker(forItemNumber: n) + "\t"
                let attrs = storage.attributes(at: p.location, effectiveRange: nil)
                storage.insert(NSAttributedString(string: marker, attributes: attrs), at: p.location)
                style.textLists = [list]
                style.tabStops = [NSTextTab(textAlignment: .left, location: 11), NSTextTab(textAlignment: .left, location: 28)]
                style.headIndent = 28
                style.firstLineHeadIndent = 0
            }
            n -= 1
            let len = (storage.string as NSString).paragraphRange(for: NSRange(location: p.location, length: 0)).length
            storage.addAttribute(.paragraphStyle, value: style, range: NSRange(location: p.location, length: len))
        }
        storage.endEditing()
        textView.didChangeText()
        emitState()
    }

    func action(_ a: [String: Any]) -> Any {
        let cmd = (a["cmd"] as? String) ?? ""
        switch cmd {
        case "bold": toggleTrait(.boldFontMask)
        case "italic": toggleTrait(.italicFontMask)
        case "underline": toggleAttribute(.underlineStyle)
        case "strike": toggleAttribute(.strikethroughStyle)
        case "size":
            let size = CGFloat((a["value"] as? NSNumber)?.doubleValue ?? 13)
            changeFont { NSFontManager.shared.convert($0, toSize: size) }
        case "family":
            let fam = (a["value"] as? String) ?? "Helvetica"
            changeFont { f in
                let traits = NSFontManager.shared.traits(of: f)
                return NSFontManager.shared.font(withFamily: fam, traits: traits, weight: 5, size: f.pointSize) ?? f
            }
        case "style":
            let v = (a["value"] as? String) ?? "body"
            let size: CGFloat = v == "title" ? 24 : v == "heading" ? 18 : v == "subheading" ? 15 : 13
            let bold = v != "body"
            changeFont { f in
                let sized = NSFontManager.shared.convert(f, toSize: size)
                return bold ? NSFontManager.shared.convert(sized, toHaveTrait: .boldFontMask) : NSFontManager.shared.convert(sized, toNotHaveTrait: .boldFontMask)
            }
        case "color":
            setAttribute(.foregroundColor, (a["value"] as? String).flatMap { NSColor(hex: $0) } ?? NSColor.black)
        case "highlight":
            setAttribute(.backgroundColor, (a["value"] as? String).flatMap { NSColor(hex: $0) })
        case "align":
            let v = (a["value"] as? String) ?? "left"
            changeParagraphs { $0.alignment = v == "center" ? .center : v == "right" ? .right : v == "justify" ? .justified : .natural }
        case "indent": changeParagraphs { $0.headIndent += 28; $0.firstLineHeadIndent += 28 }
        case "outdent": changeParagraphs { $0.headIndent = max(0, $0.headIndent - 28); $0.firstLineHeadIndent = max(0, $0.firstLineHeadIndent - 28) }
        case "bullets": toggleList(numbered: false)
        case "numbers": toggleList(numbered: true)
        case "superscript": textView.superscript(nil)
        case "subscript": textView.subscript(nil)
        case "undo": textView.undoManager?.undo()
        case "redo": textView.undoManager?.redo()
        case "focus": focus()
        case "selectAll": textView.selectAll(nil)
        case "save": saveNow()
        case "zoomIn", "zoomOut":
            let f: CGFloat = cmd == "zoomIn" ? 1.15 : 1 / 1.15
            scroll.allowsMagnification = true
            scroll.magnification = min(3, max(0.5, scroll.magnification * f))
        default: return false
        }
        return true
    }
}
