import AppKit
import WebKit
import PDFKit
import UniformTypeIdentifiers

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
            reply(.success(Store.shared.merge(patch)))

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
