import AppKit
import WebKit
import PDFKit
import UniformTypeIdentifiers
import ServiceManagement

// Brücke zwischen Oberfläche (JavaScript) und Mac-App.
//
// Jeder Aufruf aus JS kommt als {cmd, args} an und bekommt über den
// replyHandler eine Antwort – in JS ist das ein ganz normales Promise.
// Alles, was DEVONthink betrifft, läuft im Hintergrund.

protocol BridgeHost: AnyObject {
    var hostWindow: NSWindow? { get }
    func emit(_ name: String, _ payload: Any)
    func setDragRegions(_ regions: [CGRect], holes: [CGRect])
    func openPDF(uuid: String, rect: CGRect) throws -> Int
    func closePDF()
    func setPDFRect(_ rect: CGRect)
    func pdfTool(_ args: [String: Any])
    func pdfAction(_ args: [String: Any], reply: @escaping (Result<Any, Error>) -> Void)
    func pdfVisible(_ visible: Bool) -> String?
    func openOverlay(_ v: DocOverlay, rect: CGRect)
    func closeOverlay()
    func setOverlayRect(_ rect: CGRect)
    func overlayAction(_ a: [String: Any]) -> Any
    func overlayVisible(_ visible: Bool) -> String?
    func showScanMenu(parent: String, reply: @escaping (Result<Any, Error>) -> Void)
    func quitReady()
    func applyTheme(_ theme: String)
}

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: BridgeHost?
    private let printCallback: (([String: Any]) -> Void)?
    private let dt = DEVONthink.shared

    init(host: BridgeHost) {
        self.host = host
        self.printCallback = nil
    }

    init(printCallback: @escaping ([String: Any]) -> Void) {
        self.printCallback = printCallback
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "Ungültige Nachricht")
            return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        let reply: (Result<Any, Error>) -> Void = { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let v): replyHandler(Self.sanitize(v), nil)
                case .failure(let e): replyHandler(nil, e.localizedDescription)
                }
            }
        }
        handle(cmd, args, reply)
    }

    // JSON-taugliche Werte für WebKit
    static func sanitize(_ v: Any) -> Any {
        switch v {
        case let d as [String: Any]: return d.mapValues { sanitize($0) }
        case let a as [Any]: return a.map { sanitize($0) }
        case is NSNull: return NSNull()
        case let s as String: return s
        case let n as NSNumber: return n
        case let b as Bool: return b
        case let i as Int: return i
        case let d as Double: return d
        default: return String(describing: v)
        }
    }

    private func bg(_ reply: @escaping (Result<Any, Error>) -> Void, _ work: @escaping () throws -> Any) {
        dt.async(work, completion: reply)
    }

    private var settings: [String: Any] { Store.shared.get() }

    // MARK: - Befehle

    private func handle(_ cmd: String, _ a: [String: Any], _ reply: @escaping (Result<Any, Error>) -> Void) {
        let s = { (k: String) -> String in (a[k] as? String) ?? "" }
        switch cmd {

        case "app.info":
            reply(.success(["version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0", "native": true]))

        case "settings.get":
            reply(.success(settings))

        case "settings.set":
            let patch = a["settings"] as? [String: Any] ?? [:]
            let merged = Store.shared.merge(patch)
            if patch["ipadSync"] as? Bool == true { Mirror.shared.start() }
            if patch["ipadSync"] as? Bool == false { Mirror.shared.stop() }
            Mirror.shared.syncSoon()
            reply(.success(merged))

        case "sync.now":
            Mirror.shared.syncNow { result in
                switch result {
                case .success(let r): reply(.success(r))
                case .failure(let e): reply(.failure(e))
                }
            }

        case "sync.info":
            let m = Mirror.shared
            var info: [String: Any] = ["enabled": m.enabled, "folder": m.root.path, "log": m.lastLog, "loginItem": SMAppService.mainApp.status == .enabled]
            if let d = m.lastRun { info["lastRun"] = ISO8601DateFormatter().string(from: d) }
            if let e = m.lastError { info["error"] = e }
            reply(.success(info))

        case "app.loginItem":
            // Heft beim Anmelden starten (für den Abgleich im Hintergrund)
            do {
                if (a["enabled"] as? Bool) == true { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                reply(.success(SMAppService.mainApp.status == .enabled))
            } catch { reply(.failure(error)) }

        case "print.ready":
            printCallback?(a)
            reply(.success(true))

        // ---------------- DEVONthink ----------------

        case "dt.status":
            let launch = (a["launch"] as? Bool) ?? false
            bg(reply) {
                if !self.dt.isRunning {
                    if launch { try self.dt.launchIfNeeded() } else { return ["running": false, "databases": []] }
                }
                return try self.dt.run(Scripts.status)
            }

        case "dt.groups":
            let db = s("database").isEmpty ? (settings["database"] as? String ?? "") : s("database")
            bg(reply) { try self.dt.run(Scripts.groups, [db]) }

        case "lib.tree":
            let db = settings["database"] as? String ?? ""
            let root = settings["root"] as? String ?? ""
            bg(reply) { try self.dt.run(Scripts.tree, [db, root]) }

        case "note.read":
            let uuid = s("uuid")
            bg(reply) {
                guard var r = try self.dt.run(Scripts.read, [uuid]) as? [String: Any] else { throw DTError.script("Eintrag nicht lesbar") }
                var md = r["text"] as? String ?? ""
                if md.isEmpty, let p = r["path"] as? String, !p.isEmpty {
                    let url = URL(fileURLWithPath: p)
                    if let text = try? String(contentsOf: url, encoding: .utf8) { md = text }
                }
                r["markdown"] = md
                r["text"] = nil
                r["path"] = nil
                return r
            }

        case "note.write":
            let uuid = s("uuid"), md = s("markdown"), name = s("name")
            let tags = a["tags"] as? [String]
            Store.shared.backup(uuid: uuid, markdown: md)
            bg(reply) {
                let tmp = Store.shared.tempFile("eintrag.md")
                try md.write(to: tmp, atomically: true, encoding: .utf8)
                defer { try? FileManager.default.removeItem(at: tmp) }
                var tagsJSON = ""
                if let tags = tags, let d = try? JSONSerialization.data(withJSONObject: tags) { tagsJSON = String(decoding: d, as: UTF8.self) }
                let r = try self.dt.run(Scripts.write, [uuid, tmp.path, name, tagsJSON])
                if let d = r as? [String: Any], d["treeChanged"] as? Bool == true {
                    DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                }
                Mirror.shared.syncSoon(after: 5)
                return r
            }

        case "note.create":
            let parent = s("parent"), name = s("name").isEmpty ? "Unbenannt" : s("name"), md = s("markdown")
            let bundle = (a["bundle"] as? Bool) ?? false
            bg(reply) {
                let tmp = Store.shared.tempFile("neu.md")
                try md.write(to: tmp, atomically: true, encoding: .utf8)
                defer { try? FileManager.default.removeItem(at: tmp) }
                return try self.dt.run(Scripts.createNote, [parent, name, tmp.path, bundle ? "1" : "0"])
            }

        case "group.create":
            let parent = s("parent"), name = s("name")
            bg(reply) { try self.dt.run(Scripts.createGroup, [parent, name]) }

        case "record.rename":
            let uuid = s("uuid"), name = s("name")
            bg(reply) { try self.dt.run(Scripts.rename, [uuid, name]) }

        case "record.move":
            let uuid = s("uuid"), to = s("to")
            bg(reply) { try self.dt.run(Scripts.move, [uuid, to]) }

        case "record.trash":
            let uuid = s("uuid")
            bg(reply) { try self.dt.run(Scripts.trash, [uuid]) }

        case "record.reveal":
            if let url = URL(string: "x-devonthink-item://\(s("uuid"))?reveal=1") { NSWorkspace.shared.open(url) }
            reply(.success(true))

        case "record.openExternal":
            if let url = URL(string: "x-devonthink-item://\(s("uuid"))") { NSWorkspace.shared.open(url) }
            reply(.success(true))

        case "record.info":
            let uuid = s("uuid")
            bg(reply) { try self.dt.run(Scripts.info, [uuid]) }

        case "search":
            let q = s("query"), root = settings["root"] as? String ?? ""
            bg(reply) { try self.dt.run(Scripts.search, [q, root]) }

        // ---------------- Dateien ----------------

        case "asset.add":
            let note = s("note"), name = s("name"), mime = s("mime")
            guard let data = Data(base64Encoded: s("data")) else { reply(.failure(DTError.script("Datei beschädigt"))); return }
            bg(reply) {
                let ext = Self.fileExtension(name: name, mime: mime)
                let base = (name as NSString).deletingPathExtension
                let clean = base.isEmpty || base == "image" ? "Bild \(Self.stamp())" : base
                let tmp = Store.shared.tempFile("\(clean).\(ext)")
                try data.write(to: tmp)
                defer { try? FileManager.default.removeItem(at: tmp) }
                guard let r = try self.dt.run(Scripts.importAsset, [note, tmp.path, clean]) as? [String: Any] else { throw DTError.script("Import fehlgeschlagen") }
                DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                let uuid = r["uuid"] as? String ?? ""
                return ["uuid": uuid, "link": "x-devonthink-item://\(uuid)", "name": r["name"] as? String ?? clean]
            }

        case "asset.pick":
            let note = s("note"), kind = s("kind")
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.allowsMultipleSelection = kind != "pdf"
                panel.canChooseDirectories = false
                panel.allowedContentTypes = kind == "pdf" ? [.pdf] : [.image]
                panel.message = kind == "pdf" ? "Arbeitsblatt (PDF) auswählen" : "Bild auswählen"
                panel.prompt = "Einfügen"
                self.runPanel(panel) { urls in
                    guard !urls.isEmpty else { reply(.success([])); return }
                    self.bg(reply) {
                        var out: [[String: Any]] = []
                        for u in urls {
                            let name = u.deletingPathExtension().lastPathComponent
                            if let r = try self.dt.run(Scripts.importAsset, [note, u.path, name]) as? [String: Any] {
                                let id = r["uuid"] as? String ?? ""
                                out.append(["uuid": id, "link": "x-devonthink-item://\(id)", "name": name, "kind": kind == "pdf" ? "pdf" : "image"])
                            }
                        }
                        DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                        return out
                    }
                }
            }

        case "pdf.import":
            let parent = s("parent")
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.allowsMultipleSelection = true
                panel.canChooseDirectories = false
                panel.allowedContentTypes = [.pdf, .image]
                panel.message = "Arbeitsblätter importieren – sie landen im gewählten Ordner in DEVONthink."
                panel.prompt = "Importieren"
                self.runPanel(panel) { urls in
                    guard !urls.isEmpty else { reply(.success([])); return }
                    self.bg(reply) { try self.importFiles(urls, into: parent) }
                }
            }

        case "files.import":
            let parent = s("parent")
            let files = a["files"] as? [[String: Any]] ?? []
            bg(reply) {
                var urls: [URL] = []
                for f in files {
                    guard let d = Data(base64Encoded: (f["data"] as? String) ?? "") else { continue }
                    let tmp = Store.shared.tempFile((f["name"] as? String) ?? "Datei")
                    try d.write(to: tmp)
                    urls.append(tmp)
                }
                defer { urls.forEach { try? FileManager.default.removeItem(at: $0) } }
                return try self.importFiles(urls, into: parent)
            }

        case "scan.phone":
            host?.showScanMenu(parent: s("parent"), reply: reply)

        // ---------------- PDF ----------------

        case "pdf.info":
            let uuid = s("uuid")
            bg(reply) { ["pages": try SchemeHandler.shared.document(for: uuid).pageCount] }

        case "pdf.open":
            do {
                let pages = try host?.openPDF(uuid: s("uuid"), rect: Self.rect(a["rect"])) ?? 0
                reply(.success(["ok": true, "pages": pages]))
            } catch { reply(.success(["ok": false, "reason": error.localizedDescription])) }

        case "pdf.close":
            host?.closePDF()
            reply(.success(true))

        case "pdf.rect":
            host?.setPDFRect(Self.rect(a["rect"]))
            reply(.success(true))

        case "pdf.tool":
            host?.pdfTool(a)
            reply(.success(true))

        case "pdf.action":
            if let host = host { host.pdfAction(a, reply: reply) } else { reply(.success(false)) }

        case "pdf.visible":
            let snap = host?.pdfVisible((a["visible"] as? Bool) ?? true)
            reply(.success(["snapshot": snap.map { $0 as Any } ?? NSNull()]))

        // ---------------- Andere Dateien ----------------

        case "file.info":
            let uuid = s("uuid")
            bg(reply) {
                guard var r = try self.dt.run(Scripts.info, [uuid]) as? [String: Any] else { throw DTError.script("Datei nicht gefunden") }
                let path = (r["path"] as? String) ?? ""
                r["ext"] = URL(fileURLWithPath: path).pathExtension.lowercased()
                r["bytes"] = ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber)?.intValue ?? 0
                if path.isEmpty { r["url"] = (try? self.dt.run(Scripts.recordURL, [uuid])) ?? "" }
                return r
            }

        case "file.text":
            let uuid = s("uuid")
            bg(reply) {
                let path = try self.dt.path(for: uuid)
                let (text, enc) = try TextFiles.read(URL(fileURLWithPath: path))
                return ["text": text, "encoding": enc]
            }

        case "file.saveText":
            let uuid = s("uuid"), text = s("text")
            bg(reply) {
                // Nur echte Textdokumente – bei anderen Typen würde DEVONthink die Datei umwandeln
                guard let info = try self.dt.run(Scripts.info, [uuid]) as? [String: Any], (info["type"] as? String) == "txt" else {
                    throw DTError.script("Diese Datei kann Heft nicht speichern")
                }
                let tmp = Store.shared.tempFile("text.txt")
                try text.write(to: tmp, atomically: true, encoding: .utf8)
                defer { try? FileManager.default.removeItem(at: tmp) }
                _ = try self.dt.run(Scripts.setPlainText, [uuid, tmp.path])
                self.dt.forgetPath(uuid)
                return ["ok": true]
            }

        case "links.companions":
            let uuids = (a["uuids"] as? [String]) ?? []
            bg(reply) {
                let json = String(decoding: try JSONSerialization.data(withJSONObject: uuids), as: UTF8.self)
                return try self.dt.run(Scripts.companions, [json])
            }

        case "sheet.read":
            let uuid = s("uuid")
            bg(reply) { try self.dt.run(Scripts.sheetRead, [uuid]) }

        case "sheet.write":
            let uuid = s("uuid")
            let cells = a["cells"] ?? []
            bg(reply) {
                let tmp = Store.shared.tempFile("zellen.json")
                try JSONSerialization.data(withJSONObject: cells).write(to: tmp)
                defer { try? FileManager.default.removeItem(at: tmp) }
                return try self.dt.run(Scripts.sheetWrite, [uuid, tmp.path])
            }

        case "file.apps":
            let uuid = s("uuid")
            bg(reply) { Apps.forFile(URL(fileURLWithPath: try self.dt.path(for: uuid))) }

        case "file.openWith":
            // Über DEVONthink öffnen – so bleibt die Datei beim Bearbeiten mit der Datenbank verbunden
            var link = "x-devonthink-item://\(s("uuid"))?openexternally=1"
            if !s("app").isEmpty, let app = s("app").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { link += "&app=\(app)" }
            if let url = URL(string: link) { NSWorkspace.shared.open(url) }
            reply(.success(true))

        case "image.info":
            let uuid = s("uuid")
            bg(reply) { try ImageFiles.info(uuid: uuid) }

        case "image.save":
            let uuid = s("uuid")
            let pages = (a["pages"] as? [[String: Any]]) ?? []
            let layer = a["layer"] ?? NSNull()
            bg(reply) {
                let r = try ImageFiles.save(uuid: uuid, pages: pages, layer: layer)
                DispatchQueue.main.async { SchemeHandler.shared.invalidate(uuid: uuid) }
                return r
            }

        case "image.revert":
            let uuid = s("uuid")
            bg(reply) {
                let ok = try ImageFiles.revert(uuid: uuid)
                DispatchQueue.main.async { SchemeHandler.shared.invalidate(uuid: uuid) }
                return ok
            }

        case "image.copy":
            let uuid = s("uuid"), parent = s("parent")
            bg(reply) {
                let tmp = try ImageFiles.pngCopy(uuid: uuid)
                defer { try? FileManager.default.removeItem(at: tmp) }
                return try self.importFiles([tmp], into: parent).first ?? [:]
            }

        case "rich.copy":
            // Word/OpenOffice → bearbeitbare RTF-Kopie daneben
            let uuid = s("uuid"), parent = s("parent")
            bg(reply) {
                let path = try self.dt.path(for: uuid)
                let url = URL(fileURLWithPath: path)
                let text = try NSAttributedString(url: url, options: [:], documentAttributes: nil)
                guard let data = text.rtf(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]) else {
                    throw DTError.script("Dokument kann nicht umgewandelt werden")
                }
                let tmp = Store.shared.tempFile(url.deletingPathExtension().lastPathComponent + " (bearbeitbar).rtf")
                try data.write(to: tmp)
                defer { try? FileManager.default.removeItem(at: tmp) }
                return try self.importFiles([tmp], into: parent).first ?? [:]
            }

        case "overlay.open":
            let uuid = s("uuid"), mode = s("mode"), rect = Self.rect(a["rect"])
            let editable = (a["editable"] as? Bool) ?? false
            bg(reply) {
                let path = try self.dt.path(for: uuid)
                DispatchQueue.main.async {
                    guard let host = self.host as? MainWindowController else { return }
                    do {
                        let url = URL(fileURLWithPath: path)
                        let v: DocOverlay = mode == "rich" ? try RichTextOverlay(uuid: uuid, url: url, editable: editable, host: host)
                            : mode == "media" ? MediaOverlay(uuid: uuid, url: url) : QuickLookOverlay(uuid: uuid, url: url)
                        self.host?.openOverlay(v, rect: rect)
                    } catch {
                        self.host?.emit("toast", ["message": "Datei kann nicht angezeigt werden: \(error.localizedDescription)", "type": "error"])
                    }
                }
                return ["ok": true]
            }

        case "overlay.close":
            host?.closeOverlay()
            reply(.success(true))

        case "overlay.rect":
            host?.setOverlayRect(Self.rect(a["rect"]))
            reply(.success(true))

        case "overlay.action":
            reply(.success(host?.overlayAction(a) ?? false))

        case "overlay.visible":
            let snap = host?.overlayVisible((a["visible"] as? Bool) ?? true)
            reply(.success(["snapshot": snap.map { $0 as Any } ?? NSNull()]))

        // ---------------- Export ----------------

        case "export.companion":
            let uuid = s("uuid")
            let quiet = (a["quiet"] as? Bool) ?? false
            Exporter.makePDF(uuid: uuid) { result in
                switch result {
                case .failure(let e): reply(.failure(e))
                case .success(let (data, _)):
                    self.bg(reply) {
                        let target = try self.dt.run(Scripts.companionTarget, [uuid]) as? [String: Any] ?? [:]
                        let name = (target["name"] as? String) ?? "Eintrag"
                        let tmp = Store.shared.tempFile("\(Self.safeFileName(name)).pdf")
                        try data.write(to: tmp)
                        defer { try? FileManager.default.removeItem(at: tmp) }
                        if let pdf = target["pdf"] as? String {
                            try self.dt.replaceData(uuid: pdf, with: tmp)
                            DispatchQueue.main.async { SchemeHandler.shared.invalidate(uuid: pdf) }
                            return ["pdf": pdf, "created": false]
                        }
                        let r = try self.dt.run(Scripts.companionImport, [uuid, tmp.path]) as? [String: Any] ?? [:]
                        if !quiet { DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) } }
                        return ["pdf": r["uuid"] as? String ?? "", "created": target["bundle"] as? Bool != true]
                    }
                }
            }

        case "export.pdf":
            let uuid = s("uuid")
            Exporter.makePDF(uuid: uuid) { result in
                switch result {
                case .failure(let e): reply(.failure(e))
                case .success(let (data, meta)):
                    let panel = NSSavePanel()
                    panel.allowedContentTypes = [.pdf]
                    panel.nameFieldStringValue = Self.safeFileName(meta.title.isEmpty ? "Eintrag" : meta.title) + ".pdf"
                    panel.message = "PDF sichern"
                    self.runSavePanel(panel) { url in
                        guard let url = url else { reply(.success(false)); return }
                        do { try data.write(to: url); reply(.success(true)) } catch { reply(.failure(error)) }
                    }
                }
            }

        case "print":
            let uuid = s("uuid")
            Exporter.makePDF(uuid: uuid) { result in
                switch result {
                case .failure(let e): reply(.failure(e))
                case .success(let (data, _)):
                    guard let doc = PDFDocument(data: data) else { reply(.failure(DTError.script("PDF fehlerhaft"))); return }
                    let info = NSPrintInfo.shared.copy() as! NSPrintInfo
                    info.topMargin = 0; info.bottomMargin = 0; info.leftMargin = 0; info.rightMargin = 0
                    guard let op = doc.printOperation(for: info, scalingMode: .pageScaleNone, autoRotate: true) else {
                        reply(.failure(DTError.script("Drucken nicht möglich"))); return
                    }
                    op.showsPrintPanel = true
                    op.showsProgressPanel = true
                    if let w = self.host?.hostWindow { op.runModal(for: w, delegate: nil, didRun: nil, contextInfo: nil) } else { op.run() }
                    reply(.success(true))
                }
            }

        // ---------------- Sonstiges ----------------

        case "open.url":
            if let url = URL(string: s("url")) { NSWorkspace.shared.open(url) }
            reply(.success(true))

        case "chem.lookup":
            Chem.lookup(name: s("name")) { reply(.success($0 ?? NSNull())) }

        case "window.dragRegions":
            let regions = (a["regions"] as? [Any] ?? []).map { Self.rect($0) }
            let holes = (a["holes"] as? [Any] ?? []).map { Self.rect($0) }
            host?.setDragRegions(regions, holes: holes)
            reply(.success(true))

        case "window.theme":
            host?.applyTheme(s("theme"))
            reply(.success(true))

        case "app.quitReady":
            host?.quitReady()
            reply(.success(true))

        default:
            reply(.failure(DTError.script("Unbekannter Befehl: \(cmd)")))
        }
    }

    // MARK: - Hilfen

    private func importFiles(_ urls: [URL], into parent: String) throws -> [[String: Any]] {
        var out: [[String: Any]] = []
        for u in urls {
            let name = u.deletingPathExtension().lastPathComponent.replacingOccurrences(of: #"^[0-9A-F-]{36}-"#, with: "", options: .regularExpression)
            if let r = try dt.run(Scripts.importInto, [parent, u.path, name]) as? [String: Any] { out.append(r) }
        }
        DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
        return out
    }

    private func runPanel(_ panel: NSOpenPanel, _ done: @escaping ([URL]) -> Void) {
        if let w = host?.hostWindow {
            panel.beginSheetModal(for: w) { resp in done(resp == .OK ? panel.urls : []) }
        } else {
            done(panel.runModal() == .OK ? panel.urls : [])
        }
    }

    private func runSavePanel(_ panel: NSSavePanel, _ done: @escaping (URL?) -> Void) {
        if let w = host?.hostWindow {
            panel.beginSheetModal(for: w) { resp in done(resp == .OK ? panel.url : nil) }
        } else {
            done(panel.runModal() == .OK ? panel.url : nil)
        }
    }

    static func rect(_ any: Any?) -> CGRect {
        guard let d = any as? [String: Any] else { return .zero }
        let v = { (k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        return CGRect(x: v("x"), y: v("y"), width: v("width"), height: v("height"))
    }

    static func fileExtension(name: String, mime: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if !ext.isEmpty { return ext }
        if let t = UTType(mimeType: mime), let e = t.preferredFilenameExtension { return e }
        return mime == "application/pdf" ? "pdf" : "png"
    }

    static func safeFileName(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "/:\\?%*|\"<>")
        return s.components(separatedBy: bad).joined(separator: "-").trimmingCharacters(in: .whitespaces)
    }

    static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return f.string(from: Date())
    }
}

// MARK: - Strukturformeln über PubChem

enum Chem {
    static func lookup(name: String, completion: @escaping ([String: Any]?) -> Void) {
        let q = name.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let enc = q.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/\(enc)/property/IsomericSMILES,CanonicalSMILES,MolecularFormula,IUPACName/JSON") else {
            completion(nil); return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let table = obj["PropertyTable"] as? [String: Any],
                  let props = (table["Properties"] as? [[String: Any]])?.first else { completion(nil); return }
            let smiles = (props["IsomericSMILES"] as? String) ?? (props["SMILES"] as? String) ?? (props["CanonicalSMILES"] as? String) ?? (props["ConnectivitySMILES"] as? String)
            guard let sm = smiles else { completion(nil); return }
            completion(["smiles": sm, "formula": props["MolecularFormula"] as? String ?? "", "name": props["IUPACName"] as? String ?? q])
        }.resume()
    }
}
