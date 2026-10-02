import UIKit
import AVKit
import QuickLook

// Native Ansichten über der Oberfläche – wie am Mac (Sources/Heft/FileOverlays.swift):
// Quick Look für alles, was Heft nicht selbst darstellt (Pages, Word, Excel …),
// ein Abspieler für Audio und Video und eine Textverarbeitung für RTF.

protocol PadOverlay: AnyObject {
    var uuid: String { get }
    var view: UIView { get }
    func attach(to parent: UIViewController)
    func detach()
    func saveNow()
    func action(_ a: [String: Any]) -> Any
}

extension PadOverlay {
    func snapshot() -> String? {
        let v = view
        guard v.bounds.width > 0, v.bounds.height > 0 else { return nil }
        let img = UIGraphicsImageRenderer(bounds: v.bounds).image { _ in v.drawHierarchy(in: v.bounds, afterScreenUpdates: false) }
        return img.jpegData(compressionQuality: 0.8).map { "data:image/jpeg;base64," + $0.base64EncodedString() }
    }
}

// Eingebettete View-Controller (Quick Look, Abspieler) sauber ein- und aushängen
private func embed(_ child: UIViewController, in parent: UIViewController) {
    parent.addChild(child)
    parent.view.addSubview(child.view)
    child.didMove(toParent: parent)
}

private func unembed(_ child: UIViewController) {
    child.willMove(toParent: nil)
    child.view.removeFromSuperview()
    child.removeFromParent()
}

// MARK: - Quick Look

final class QuickLookOverlay: NSObject, PadOverlay, QLPreviewControllerDataSource {
    let uuid: String
    private let url: URL
    private let controller = QLPreviewController()
    var view: UIView { controller.view }

    init(uuid: String, url: URL) {
        self.uuid = uuid
        self.url = url
        super.init()
        controller.dataSource = self
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }

    func attach(to parent: UIViewController) { embed(controller, in: parent) }
    func detach() { unembed(controller) }
    func saveNow() {}
    func action(_ a: [String: Any]) -> Any { false }
}

// MARK: - Audio und Video

final class MediaOverlay: PadOverlay {
    let uuid: String
    private let controller = AVPlayerViewController()
    private let player: AVPlayer
    var view: UIView { controller.view }

    init(uuid: String, url: URL) {
        self.uuid = uuid
        player = AVPlayer(url: url)
        controller.player = player
    }

    func attach(to parent: UIViewController) { embed(controller, in: parent) }
    func detach() { player.pause(); controller.player = nil; unembed(controller) }
    func saveNow() {}

    func action(_ a: [String: Any]) -> Any {
        switch (a["cmd"] as? String) ?? "" {
        case "play": player.play(); return true
        case "pause": player.pause(); return true
        case "status":
            let d = player.currentItem.map { CMTimeGetSeconds($0.duration) } ?? 0
            return ["duration": d.isFinite ? d : 0, "ready": player.currentItem?.status == .readyToPlay]
        default: return false
        }
    }
}

// MARK: - RTF

final class RichTextOverlay: NSObject, PadOverlay, UITextViewDelegate {
    let uuid: String
    let editable: Bool
    private let textView = UITextView()
    private weak var host: PadHost?
    private var dirty = false
    private var saveWork: DispatchWorkItem?
    private let pageWidth: CGFloat = 720
    var view: UIView { textView }

    init(uuid: String, url: URL, editable: Bool, host: PadHost) throws {
        self.uuid = uuid
        self.editable = editable
        self.host = host
        let text: NSAttributedString
        if url.pathExtension.lowercased() == "rtfd" || (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            text = try NSAttributedString(url: url, options: [.documentType: NSAttributedString.DocumentType.rtfd], documentAttributes: nil)
        } else {
            text = try NSAttributedString(data: Data(contentsOf: url), options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
        }
        super.init()
        // Das Blatt bleibt immer weiß – Dokumente sind für Papier gemacht
        textView.overrideUserInterfaceStyle = .light
        textView.backgroundColor = .white
        textView.attributedText = text
        textView.isEditable = editable
        textView.isSelectable = true
        textView.allowsEditingTextAttributes = true
        textView.alwaysBounceVertical = true
        textView.delegate = self
        if text.length == 0 { textView.typingAttributes = [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: UIColor.black] }
    }

    func attach(to parent: UIViewController) {
        parent.view.addSubview(textView)
        textView.becomeFirstResponder()
    }

    func detach() {
        saveNow()
        textView.removeFromSuperview()
    }

    // Schmale Textspalte in der Mitte, wie eine Seite
    func layout() {
        let pad = max(28, (textView.bounds.width - pageWidth) / 2)
        textView.textContainerInset = UIEdgeInsets(top: 36, left: pad, bottom: 36, right: pad)
    }

    // MARK: Speichern

    func textViewDidChange(_ tv: UITextView) {
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
        guard editable, dirty else { return }
        dirty = false
        let storage = textView.textStorage
        guard let data = try? storage.data(from: NSRange(location: 0, length: storage.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]) else { return }
        host?.emit("rich-state", ["uuid": uuid, "saving": true, "saved": false])
        let uuid = self.uuid
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try MirrorStore.shared.writeFile(uuid, data: data) }
            DispatchQueue.main.async {
                switch result {
                case .success: self?.host?.emit("rich-state", ["uuid": uuid, "saved": true, "dirty": self?.dirty ?? false])
                case .failure(let e):
                    self?.dirty = true
                    self?.host?.emit("toast", ["message": "Dokument nicht gespeichert: \(e.localizedDescription)", "type": "error"])
                }
            }
        }
    }

    // MARK: Formatieren (aus der Werkzeugleiste)

    func textViewDidChangeSelection(_ tv: UITextView) { emitState() }

    private func currentAttributes() -> [NSAttributedString.Key: Any] {
        let r = textView.selectedRange
        if r.length == 0 || r.location >= textView.textStorage.length { return textView.typingAttributes }
        return textView.textStorage.attributes(at: r.location, effectiveRange: nil)
    }

    private func emitState() {
        let at = currentAttributes()
        let font = (at[.font] as? UIFont) ?? UIFont.systemFont(ofSize: 13)
        let traits = font.fontDescriptor.symbolicTraits
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
            "bold": traits.contains(.traitBold), "italic": traits.contains(.traitItalic),
            "underline": ((at[.underlineStyle] as? Int) ?? 0) != 0, "strike": ((at[.strikethroughStyle] as? Int) ?? 0) != 0,
            "size": Double(font.pointSize), "family": font.familyName, "align": align,
            "list": !(para?.textLists.isEmpty ?? true)
        ])
    }

    // Auf die Auswahl anwenden – oder auf das, was als Nächstes getippt wird
    private func apply(_ change: (NSMutableAttributedString, NSRange) -> Void, typing: ([NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any]) {
        guard editable else { return }
        let r = textView.selectedRange
        if r.length == 0 {
            textView.typingAttributes = typing(textView.typingAttributes)
            emitState()
            return
        }
        let storage = textView.textStorage
        let before = storage.attributedSubstring(from: r)
        storage.beginEditing()
        change(storage, r)
        storage.endEditing()
        registerUndo(range: r, before: before)
        textViewDidChange(textView)
        emitState()
    }

    private func registerUndo(range: NSRange, before: NSAttributedString) {
        textView.undoManager?.registerUndo(withTarget: self) { me in
            let after = me.textView.textStorage.attributedSubstring(from: NSRange(location: range.location, length: before.length))
            me.textView.textStorage.replaceCharacters(in: NSRange(location: range.location, length: before.length), with: before)
            me.registerUndo(range: range, before: after)
            me.textViewDidChange(me.textView)
        }
    }

    private func changeFont(_ f: @escaping (UIFont) -> UIFont) {
        apply({ s, r in
            s.enumerateAttribute(.font, in: r) { v, sub, _ in
                s.addAttribute(.font, value: f((v as? UIFont) ?? UIFont.systemFont(ofSize: 13)), range: sub)
            }
        }, typing: { t in
            var t = t
            t[.font] = f((t[.font] as? UIFont) ?? UIFont.systemFont(ofSize: 13))
            return t
        })
    }

    private static func withTrait(_ font: UIFont, _ trait: UIFontDescriptor.SymbolicTraits, _ on: Bool) -> UIFont {
        var t = font.fontDescriptor.symbolicTraits
        if on { t.insert(trait) } else { t.remove(trait) }
        guard let d = font.fontDescriptor.withSymbolicTraits(t) else { return font }
        return UIFont(descriptor: d, size: font.pointSize)
    }

    private func toggleTrait(_ trait: UIFontDescriptor.SymbolicTraits) {
        let on = ((currentAttributes()[.font] as? UIFont) ?? UIFont.systemFont(ofSize: 13)).fontDescriptor.symbolicTraits.contains(trait)
        changeFont { Self.withTrait($0, trait, !on) }
    }

    private func toggleAttribute(_ key: NSAttributedString.Key) {
        let on = ((currentAttributes()[key] as? Int) ?? 0) != 0
        let value = on ? 0 : NSUnderlineStyle.single.rawValue
        apply({ s, r in s.addAttribute(key, value: value, range: r) }, typing: { t in var t = t; t[key] = value; return t })
    }

    private func setAttribute(_ key: NSAttributedString.Key, _ value: Any?) {
        apply({ s, r in
            if let v = value { s.addAttribute(key, value: v, range: r) } else { s.removeAttribute(key, range: r) }
        }, typing: { t in var t = t; t[key] = value; return t })
    }

    private func changeParagraphs(_ f: (NSMutableParagraphStyle) -> Void) {
        guard editable else { return }
        let storage = textView.textStorage
        let text = storage.string as NSString
        let r = text.paragraphRange(for: textView.selectedRange)
        if r.length == 0 {
            let p = ((textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle) ?? .default).mutableCopy() as! NSMutableParagraphStyle
            f(p)
            textView.typingAttributes[.paragraphStyle] = p
            emitState()
            return
        }
        let before = storage.attributedSubstring(from: r)
        storage.beginEditing()
        storage.enumerateAttribute(.paragraphStyle, in: r) { v, sub, _ in
            let p = ((v as? NSParagraphStyle) ?? .default).mutableCopy() as! NSMutableParagraphStyle
            f(p)
            storage.addAttribute(.paragraphStyle, value: p, range: sub)
        }
        storage.endEditing()
        registerUndo(range: r, before: before)
        textViewDidChange(textView)
        emitState()
    }

    private func toggleList(numbered: Bool) {
        guard editable else { return }
        let storage = textView.textStorage
        let text = storage.string as NSString
        let whole = text.paragraphRange(for: textView.selectedRange)
        let hasList = !((currentAttributes()[.paragraphStyle] as? NSParagraphStyle)?.textLists.isEmpty ?? true)
        let list = NSTextList(markerFormat: numbered ? .decimal : .disc, options: 0)
        var paras: [NSRange] = []
        text.enumerateSubstrings(in: whole, options: .byParagraphs) { _, _, enclosing, _ in paras.append(enclosing) }
        if paras.isEmpty { paras = [whole] }
        storage.beginEditing()
        var n = paras.count
        for p in paras.reversed() {
            let line = text.substring(with: p)
            let markerLen = (line.range(of: "^\\t?[^\\t]{1,4}\\t", options: .regularExpression).map { line.distance(from: line.startIndex, to: $0.upperBound) }) ?? 0
            let style = ((storage.attribute(.paragraphStyle, at: min(p.location, max(0, storage.length - 1)), effectiveRange: nil) as? NSParagraphStyle) ?? .default).mutableCopy() as! NSMutableParagraphStyle
            if hasList {
                if markerLen > 0 { storage.deleteCharacters(in: NSRange(location: p.location, length: markerLen)) }
                style.textLists = []
                style.headIndent = 0
                style.firstLineHeadIndent = 0
            } else {
                let marker = "\t" + list.marker(forItemNumber: n) + "\t"
                let attrs = storage.length > 0 ? storage.attributes(at: min(p.location, storage.length - 1), effectiveRange: nil) : textView.typingAttributes
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
        textViewDidChange(textView)
        emitState()
    }

    // Hoch-/Tiefgestellt: kleinere Schrift, verschobene Grundlinie
    private func toggleScript(up: Bool) {
        let at = currentAttributes()
        let current = (at[.baselineOffset] as? NSNumber)?.doubleValue ?? 0
        let isOn = up ? current > 0 : current < 0
        apply({ s, r in
            s.enumerateAttribute(.font, in: r) { v, sub, _ in
                let f = (v as? UIFont) ?? UIFont.systemFont(ofSize: 13)
                if isOn {
                    s.addAttribute(.font, value: f.withSize(f.pointSize / 0.7), range: sub)
                    s.removeAttribute(.baselineOffset, range: sub)
                } else {
                    s.addAttribute(.font, value: f.withSize(f.pointSize * 0.7), range: sub)
                    s.addAttribute(.baselineOffset, value: (up ? 0.4 : -0.15) * f.pointSize, range: sub)
                }
            }
        }, typing: { t in
            var t = t
            let f = (t[.font] as? UIFont) ?? UIFont.systemFont(ofSize: 13)
            if isOn { t[.font] = f.withSize(f.pointSize / 0.7); t[.baselineOffset] = nil }
            else { t[.font] = f.withSize(f.pointSize * 0.7); t[.baselineOffset] = (up ? 0.4 : -0.15) * f.pointSize }
            return t
        })
    }

    func action(_ a: [String: Any]) -> Any {
        let cmd = (a["cmd"] as? String) ?? ""
        switch cmd {
        case "bold": toggleTrait(.traitBold)
        case "italic": toggleTrait(.traitItalic)
        case "underline": toggleAttribute(.underlineStyle)
        case "strike": toggleAttribute(.strikethroughStyle)
        case "size":
            let size = CGFloat((a["value"] as? NSNumber)?.doubleValue ?? 13)
            changeFont { $0.withSize(size) }
        case "family":
            let fam = (a["value"] as? String) ?? "Helvetica"
            changeFont { f in
                let d = UIFontDescriptor(fontAttributes: [.family: fam])
                let withTraits = d.withSymbolicTraits(f.fontDescriptor.symbolicTraits) ?? d
                return UIFont(descriptor: withTraits, size: f.pointSize)
            }
        case "style":
            let v = (a["value"] as? String) ?? "body"
            let size: CGFloat = v == "title" ? 24 : v == "heading" ? 18 : v == "subheading" ? 15 : 13
            changeFont { Self.withTrait($0.withSize(size), .traitBold, v != "body") }
        case "color":
            setAttribute(.foregroundColor, (a["value"] as? String).flatMap { UIColor(hex: $0) } ?? UIColor.black)
        case "highlight":
            setAttribute(.backgroundColor, (a["value"] as? String).flatMap { UIColor(hex: $0) })
        case "align":
            let v = (a["value"] as? String) ?? "left"
            changeParagraphs { $0.alignment = v == "center" ? .center : v == "right" ? .right : v == "justify" ? .justified : .natural }
        case "indent": changeParagraphs { $0.headIndent += 28; $0.firstLineHeadIndent += 28 }
        case "outdent": changeParagraphs { $0.headIndent = max(0, $0.headIndent - 28); $0.firstLineHeadIndent = max(0, $0.firstLineHeadIndent - 28) }
        case "bullets": toggleList(numbered: false)
        case "numbers": toggleList(numbered: true)
        case "superscript": toggleScript(up: true)
        case "subscript": toggleScript(up: false)
        case "undo": textView.undoManager?.undo()
        case "redo": textView.undoManager?.redo()
        case "focus": textView.becomeFirstResponder()
        case "selectAll": textView.selectAll(nil)
        case "save": saveNow()
        default: return false
        }
        return true
    }
}
