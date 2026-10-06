import Foundation
import WebKit
import PDFKit
import UIKit

// Brücke zwischen Oberfläche (JavaScript) und iPad-App – dieselben Befehle
// wie am Mac (Sources/Heft/Bridge.swift), nur arbeitet sie auf der
// iCloud-Kopie (MirrorStore) statt direkt mit DEVONthink.

protocol PadHost: AnyObject {
    var presenter: UIViewController? { get }
    func emit(_ name: String, _ payload: Any)
    // Arbeitsblatt (PDF) und andere Dateien über der Oberfläche
    func openPDF(uuid: String, rect: CGRect) throws -> Int
    func closePDF()
    func setPDFRect(_ rect: CGRect)
    var pdfEditor: PadPDFEditor? { get }
    func pdfVisible(_ visible: Bool) -> String?
    func openOverlay(_ o: PadOverlay, rect: CGRect)
    func closeOverlay()
    func setOverlayRect(_ rect: CGRect)
    var overlay: PadOverlay? { get }
    func overlayVisible(_ visible: Bool) -> String?
}

final class PadBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: PadHost?
    private let store = MirrorStore.shared
    private let work = DispatchQueue(label: "heft.bridge", qos: .userInitiated)
    private let printCallback: (([String: Any]) -> Void)?

    init(host: PadHost) { self.host = host; printCallback = nil }

    // Für die unsichtbare Druckansicht (PadExporter)
    init(printCallback: @escaping ([String: Any]) -> Void) { self.printCallback = printCallback }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "Ungültige Nachricht"); return
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

    private func bg(_ reply: @escaping (Result<Any, Error>) -> Void, _ job: @escaping () throws -> Any) {
        work.async {
            do { reply(.success(try job())) } catch { reply(.failure(error)) }
        }
    }

    private func err(_ msg: String) -> NSError { NSError(domain: "Heft", code: 2, userInfo: [NSLocalizedDescriptionKey: msg]) }

    // MARK: - Befehle

    private func handle(_ cmd: String, _ a: [String: Any], _ reply: @escaping (Result<Any, Error>) -> Void) {
        let s = { (k: String) -> String in (a[k] as? String) ?? "" }
        switch cmd {
        case "app.info":
            reply(.success(["version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1", "native": true, "platform": "ipad"]))

        case "settings.get":
            bg(reply) { self.store.settings() }

        case "settings.set":
            let patch = a["settings"] as? [String: Any] ?? [:]
            bg(reply) { self.store.setSettings(patch) }

        case "dt.status":
            bg(reply) {
                self.store.reloadManifest()
                let st = self.store.settings()
                let db: [String: Any] = ["uuid": st["database"] ?? "", "name": st["databaseName"] ?? "Heft"]
                return ["running": true, "databases": [db], "ipad": true, "label": self.syncLabel()]
            }

        case "dt.groups":
            bg(reply) {
                let tree = self.store.tree()
                func groups(_ nodes: [[String: Any]]) -> [[String: Any]] {
                    nodes.filter { ($0["kind"] as? String) == "group" }.map { ["uuid": $0["uuid"] ?? "", "name": $0["name"] ?? "", "children": groups($0["children"] as? [[String: Any]] ?? [])] }
                }
                let root = tree["root"] as? [String: Any] ?? [:]
                return [["uuid": root["uuid"] ?? "", "name": root["name"] ?? "Heft", "children": groups(tree["nodes"] as? [[String: Any]] ?? [])]]
            }

        case "lib.tree":
            bg(reply) { self.store.reloadManifest(); return self.store.tree() }

        case "note.read":
            let uuid = s("uuid")
            bg(reply) { try self.store.readNote(uuid) }

        case "note.write":
            let uuid = s("uuid"), md = s("markdown"), name = s("name")
            let tags = a["tags"] as? [String]
            bg(reply) { try self.store.writeNote(uuid, markdown: md, name: name, tags: tags) }

        case "note.create":
            let parent = s("parent"), name = s("name").isEmpty ? "Unbenannt" : s("name"), md = s("markdown")
            let bundle = (a["bundle"] as? Bool) ?? false
            bg(reply) {
                let r = try self.store.createNote(parent: parent, name: name, markdown: md, bundle: bundle)
                DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                return r
            }

        case "group.create":
            let parent = s("parent"), name = s("name")
            bg(reply) {
                let r = try self.store.createGroup(parent: parent, name: name)
                DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                return r
            }

        case "record.rename":
            let uuid = s("uuid"), name = s("name")
            bg(reply) { try self.store.rename(uuid, to: name); return ["name": name] }

        case "record.move":
            let uuid = s("uuid"), to = s("to")
            bg(reply) { try self.store.move(uuid, to: to); return true }

        case "record.trash":
            let uuid = s("uuid")
            bg(reply) { try self.store.trash(uuid); return true }

        case "record.info":
            let uuid = s("uuid")
            bg(reply) {
                var info = self.store.info(for: uuid)
                if let parent = self.parent(of: uuid) { info["group"] = parent["uuid"]; info["groupName"] = parent["name"] }
                return info
            }

        case "record.reveal", "record.openExternal", "file.openWith":
            // In DEVONthink To Go öffnen – die Links gelten auf Mac und iPad gleich
            let uuid = store.resolve(s("uuid"))
            if uuid.hasPrefix("NEU-") { reply(.failure(err("Noch nicht in DEVONthink – kommt beim nächsten Abgleich mit dem Mac an"))); return }
            DispatchQueue.main.async {
                guard let url = URL(string: "x-devonthink-item://\(uuid)") else { reply(.success(false)); return }
                UIApplication.shared.open(url) { ok in
                    if ok { reply(.success(true)) } else { reply(.failure(self.err("DEVONthink To Go ist nicht installiert"))) }
                }
            }

        case "search":
            let q = s("query")
            bg(reply) { self.search(q) }

        case "asset.add":
            let note = s("note"), name = s("name"), mime = s("mime")
            guard let data = Data(base64Encoded: s("data")) else { reply(.failure(err("Datei beschädigt"))); return }
            bg(reply) {
                let ext = Self.fileExtension(name: name, mime: mime)
                let base = (name as NSString).deletingPathExtension
                let clean = base.isEmpty || base == "image" ? "Bild \(Self.stamp())" : base
                let parent = self.assetParent(for: note)
                let r = try self.store.addFile(parent: parent, name: clean, ext: ext, data: data)
                DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                return r
            }

        case "asset.pick":
            let note = s("note"), kind = s("kind")
            DispatchQueue.main.async {
                guard let vc = self.host?.presenter else { reply(.success([])); return }
                PadPicker.pick(from: vc, kind: kind) { items in
                    self.bg(reply) {
                        var out: [[String: Any]] = []
                        let parent = self.assetParent(for: note)
                        for it in items {
                            let r = try self.store.addFile(parent: parent, name: it.name, ext: it.ext, data: it.data)
                            out.append(["uuid": r["uuid"] ?? "", "link": r["link"] ?? "", "name": it.name, "kind": it.ext == "pdf" ? "pdf" : "image"])
                        }
                        if !out.isEmpty { DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) } }
                        return out
                    }
                }
            }

        case "pdf.import", "files.import":
            let parent = s("parent")
            DispatchQueue.main.async {
                guard let vc = self.host?.presenter else { reply(.success([])); return }
                PadPicker.pick(from: vc, kind: "files") { items in
                    self.bg(reply) {
                        var out: [[String: Any]] = []
                        for it in items {
                            let r = try self.store.addFile(parent: parent, name: it.name, ext: it.ext, data: it.data)
                            out.append(["uuid": r["uuid"] ?? "", "name": it.name, "kind": it.ext == "pdf" ? "pdf" : "image"])
                        }
                        if !out.isEmpty { DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) } }
                        return out
                    }
                }
            }

        case "pdf.info":
            let uuid = s("uuid")
            bg(reply) {
                guard let data = self.store.fileData(for: uuid), let doc = PDFDocument(data: data) else { throw self.err("PDF nicht gefunden") }
                return ["pages": doc.pageCount]
            }

        case "file.info":
            let uuid = s("uuid")
            bg(reply) {
                var info = self.store.info(for: uuid)
                info["size"] = self.store.fileData(for: uuid)?.count ?? 0
                return info
            }

        case "file.text":
            let uuid = s("uuid")
            bg(reply) {
                guard let data = self.store.fileData(for: uuid) else { throw self.err("Datei nicht gefunden") }
                return ["text": String(decoding: data, as: UTF8.self), "encoding": "utf-8"]
            }

        case "links.companions":
            let uuids = (a["uuids"] as? [String]) ?? []
            bg(reply) {
                var out: [String: Any] = [:]
                for u in uuids { out[u] = self.companion(of: u).pdf ?? NSNull() }
                return out
            }

        case "open.url":
            if let url = URL(string: s("url")) { DispatchQueue.main.async { UIApplication.shared.open(url) } }
            reply(.success(true))

        case "print.ready":
            printCallback?(a)
            reply(.success(true))

        case "window.dragRegions", "window.theme", "app.quitReady":
            reply(.success(true))

        // ---------------- PDF ----------------

        case "pdf.open":
            DispatchQueue.main.async {
                do {
                    let pages = try self.host?.openPDF(uuid: s("uuid"), rect: Self.rect(a["rect"])) ?? 0
                    reply(.success(["ok": true, "pages": pages]))
                } catch { reply(.success(["ok": false, "reason": error.localizedDescription])) }
            }

        case "pdf.close":
            DispatchQueue.main.async { self.host?.closePDF(); reply(.success(true)) }

        case "pdf.rect":
            DispatchQueue.main.async { self.host?.setPDFRect(Self.rect(a["rect"])); reply(.success(true)) }

        case "pdf.tool":
            DispatchQueue.main.async { self.host?.pdfEditor?.setTool(a); reply(.success(true)) }

        case "pdf.action":
            DispatchQueue.main.async {
                if let e = self.host?.pdfEditor { e.action(a, reply: reply) } else { reply(.success(false)) }
            }

        case "pdf.visible":
            let visible = (a["visible"] as? Bool) ?? true
            DispatchQueue.main.async {
                let snap = self.host?.pdfVisible(visible)
                reply(.success(["snapshot": snap.map { $0 as Any } ?? NSNull()]))
            }

        // ---------------- Andere Dateien ----------------

        case "overlay.open":
            let uuid = s("uuid"), mode = s("mode"), rect = Self.rect(a["rect"])
            let editable = (a["editable"] as? Bool) ?? false
            bg(reply) {
                let name = (self.store.info(for: uuid)["name"] as? String) ?? "Datei"
                guard let url = self.store.viewingCopy(for: uuid, name: name) else { throw self.err("Datei ist noch nicht heruntergeladen") }
                DispatchQueue.main.async {
                    guard let host = self.host else { return }
                    do {
                        let o: PadOverlay
                        switch mode {
                        case "rich": o = try RichTextOverlay(uuid: uuid, url: url, editable: editable, host: host)
                        case "media": o = MediaOverlay(uuid: uuid, url: url)
                        default: o = QuickLookOverlay(uuid: uuid, url: url)
                        }
                        host.openOverlay(o, rect: rect)
                    } catch {
                        // Lässt sich nicht als Text öffnen: wenigstens anzeigen
                        host.openOverlay(QuickLookOverlay(uuid: uuid, url: url), rect: rect)
                    }
                }
                return ["ok": true]
            }

        case "overlay.close":
            DispatchQueue.main.async { self.host?.closeOverlay(); reply(.success(true)) }

        case "overlay.rect":
            DispatchQueue.main.async { self.host?.setOverlayRect(Self.rect(a["rect"])); reply(.success(true)) }

        case "overlay.action":
            DispatchQueue.main.async { reply(.success(self.host?.overlay?.action(a) ?? false)) }

        case "overlay.visible":
            let visible = (a["visible"] as? Bool) ?? true
            DispatchQueue.main.async {
                let snap = self.host?.overlayVisible(visible)
                reply(.success(["snapshot": snap.map { $0 as Any } ?? NSNull()]))
            }

        case "file.saveText":
            let uuid = s("uuid"), text = s("text")
            bg(reply) {
                try self.store.writeFile(uuid, data: Data(text.utf8))
                return ["ok": true]
            }

        case "sheet.read":
            let uuid = s("uuid")
            bg(reply) {
                guard let data = self.store.fileData(for: uuid) else { throw self.err("Tabelle ist noch nicht heruntergeladen") }
                let ext = (self.store.info(for: uuid)["ext"] as? String) ?? "csv"
                let rows = Sheets.parse(String(decoding: data, as: UTF8.self), ext: ext)
                return ["columns": rows.first ?? [], "cells": Array(rows.dropFirst()), "type": ext == "tsv" ? "TSV" : "CSV"]
            }

        case "sheet.write":
            let uuid = s("uuid")
            let cells = (a["cells"] as? [[Any]]) ?? []
            bg(reply) {
                guard let data = self.store.fileData(for: uuid) else { throw self.err("Tabelle ist noch nicht heruntergeladen") }
                let ext = (self.store.info(for: uuid)["ext"] as? String) ?? "csv"
                let text = String(decoding: data, as: UTF8.self)
                let header = Sheets.parse(text, ext: ext).first ?? []
                let out = Sheets.write([header] + cells.map { $0.map { "\($0)" } }, sep: Sheets.separator(text, ext: ext))
                try self.store.writeFile(uuid, data: Data(out.utf8))
                return true
            }

        case "file.apps":
            reply(.success([]))

        case "image.info":
            let uuid = s("uuid")
            bg(reply) { try ImageFiles.info(uuid: uuid) }

        case "image.save":
            let uuid = s("uuid")
            let pages = (a["pages"] as? [[String: Any]]) ?? []
            let layer = a["layer"] ?? NSNull()
            bg(reply) {
                let r = try ImageFiles.save(uuid: uuid, pages: pages, layer: layer)
                PadSchemeHandler.invalidate(uuid)
                return r
            }

        case "image.revert":
            let uuid = s("uuid")
            bg(reply) {
                let ok = try ImageFiles.revert(uuid: uuid)
                PadSchemeHandler.invalidate(uuid)
                return ok
            }

        case "image.copy":
            let uuid = s("uuid"), parent = s("parent")
            bg(reply) {
                let png = try ImageFiles.pngCopy(uuid: uuid)
                let base = (self.store.info(for: uuid)["name"] as? String) ?? "Bild"
                let r = try self.store.addFile(parent: parent, name: "\(base) (bearbeitet)", ext: "png", data: png)
                DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                return r
            }

        case "rich.copy":
            // RTFD (Text mit Bildern) → bearbeitbare RTF-Kopie daneben
            let uuid = s("uuid"), parent = s("parent")
            bg(reply) {
                let name = (self.store.info(for: uuid)["name"] as? String) ?? "Dokument"
                guard let url = self.store.viewingCopy(for: uuid, name: name) else { throw self.err("Datei ist noch nicht heruntergeladen") }
                let text = try NSAttributedString(url: url, options: [:], documentAttributes: nil)
                let data = try text.data(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
                let r = try self.store.addFile(parent: parent, name: "\(name) (bearbeitbar)", ext: "rtf", data: data)
                DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                return r
            }

        // ---------------- Export ----------------

        case "export.companion":
            let uuid = s("uuid")
            let quiet = (a["quiet"] as? Bool) ?? false
            PadExporter.makePDF(uuid: uuid) { result in
                switch result {
                case .failure(let e): reply(.failure(e))
                case .success(let (data, _)):
                    self.bg(reply) {
                        let r = try self.saveCompanion(of: uuid, data: data)
                        if !quiet { DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) } }
                        return r
                    }
                }
            }

        case "export.pdf":
            let uuid = s("uuid")
            PadExporter.makePDF(uuid: uuid) { result in
                switch result {
                case .failure(let e): reply(.failure(e))
                case .success(let (data, meta)):
                    let name = Self.safeFileName(meta.title.isEmpty ? "Eintrag" : meta.title) + ".pdf"
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                    do { try data.write(to: url) } catch { reply(.failure(error)); return }
                    // Teilen-Menü: In Dateien sichern, AirDrop, Mail …
                    guard let vc = self.host?.presenter else { reply(.success(false)); return }
                    let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                    share.completionWithItemsHandler = { _, done, _, _ in reply(.success(done)) }
                    if let pop = share.popoverPresentationController {
                        pop.sourceView = vc.view
                        pop.sourceRect = CGRect(x: vc.view.bounds.maxX - 60, y: 50, width: 1, height: 1)
                    }
                    vc.present(share, animated: true)
                }
            }

        case "print":
            let uuid = s("uuid")
            PadExporter.makePDF(uuid: uuid) { result in
                switch result {
                case .failure(let e): reply(.failure(e))
                case .success(let (data, meta)):
                    let pc = UIPrintInteractionController.shared
                    let info = UIPrintInfo.printInfo()
                    info.jobName = meta.title.isEmpty ? "Heft" : meta.title
                    info.outputType = .general
                    pc.printInfo = info
                    pc.printingItem = data
                    pc.present(animated: true) { _, done, _ in reply(.success(done)) }
                }
            }

        case "chem.lookup":
            Chem.lookup(name: s("name")) { reply(.success($0 ?? NSNull())) }

        case "sync.now":
            bg(reply) {
                self.store.reloadManifest()
                let up = self.store.takeNews()
                DispatchQueue.main.async {
                    self.host?.emit("tree-changed", [:])
                    if !up.notes.isEmpty { self.host?.emit("notes-changed", ["uuids": up.notes]) }
                    for f in up.failures {
                        self.host?.emit("toast", ["message": "Der Mac konnte eine Änderung nicht in DEVONthink eintragen – \(f)", "type": "error"])
                    }
                }
                return ["ok": true]
            }

        case "mirror.reset":
            DispatchQueue.main.async {
                MirrorStore.shared.forgetFolder()
                NotificationCenter.default.post(name: .heftResetFolder, object: nil)
            }
            reply(.success(true))

        case "scan.phone":
            let parent = s("parent")
            DispatchQueue.main.async {
                guard let vc = self.host?.presenter else { reply(.success([])); return }
                PadScanner.scan(from: vc) { data in
                    guard let data else { reply(.success([])); return }
                    self.bg(reply) {
                        let r = try self.store.addFile(parent: parent, name: "Scan \(Self.stamp())", ext: "pdf", data: data)
                        DispatchQueue.main.async { self.host?.emit("tree-changed", [:]) }
                        return [["uuid": r["uuid"] ?? "", "name": r["name"] ?? "", "kind": "pdf"]]
                    }
                }
            }

        case "sync.info":
            bg(reply) { ["enabled": true, "label": self.syncLabel(), "pending": self.store.pendingCount] }

        default:
            reply(.failure(err("Auf dem iPad noch nicht verfügbar (\(cmd))")))
        }
    }

    // MARK: - Hilfen

    /// „iCloud · Mac vor 3 Min. · 2 Änderungen warten“ – der Mac meldet sich
    /// mindestens alle zehn Minuten; bleibt das aus, läuft Heft dort wohl nicht
    private func syncLabel() -> String {
        var parts = ["iCloud"]
        if let g = store.lastSync, let date = ISO8601DateFormatter().date(from: g) {
            let f = RelativeDateTimeFormatter()
            f.locale = Locale(identifier: "de_DE")
            let when = f.localizedString(for: date, relativeTo: Date())
            parts.append(Date().timeIntervalSince(date) > 20 * 60 ? "Mac zuletzt \(when) – läuft Heft am Mac?" : "Mac \(when)")
        }
        let n = store.pendingCount
        if n > 0 { parts.append(n == 1 ? "1 Änderung wartet" : "\(n) Änderungen warten") }
        return parts.joined(separator: " · ")
    }

    static func rect(_ v: Any?) -> CGRect {
        guard let d = v as? [String: Any] else { return .zero }
        let n = { (k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        return CGRect(x: n("x"), y: n("y"), width: n("width"), height: n("height"))
    }

    static func safeFileName(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        return s.components(separatedBy: bad).joined(separator: "-").trimmingCharacters(in: .whitespaces)
    }

    /// PDF-Fassung eines Eintrags: liegt neben ihm im Eintrags-Ordner und heißt wie er
    private func companion(of note: String) -> (bundle: [String: Any]?, pdf: String?) {
        let target = store.resolve(note)
        func find(_ nodes: [[String: Any]]) -> [String: Any]? {
            for n in nodes {
                if (n["kind"] as? String) == "bundle", n["note"] as? String == target { return n }
                if let hit = find(n["children"] as? [[String: Any]] ?? []) { return hit }
            }
            return nil
        }
        guard let b = find(store.tree()["nodes"] as? [[String: Any]] ?? []) else { return (nil, nil) }
        let name = b["name"] as? String ?? ""
        let pdf = (b["children"] as? [[String: Any]] ?? []).first { ($0["kind"] as? String) == "pdf" && ($0["name"] as? String) == name }
        return (b, pdf?["uuid"] as? String)
    }

    private func saveCompanion(of note: String, data: Data) throws -> [String: Any] {
        let (bundle, pdf) = companion(of: note)
        if let pdf {
            try store.writeFile(pdf, data: data)
            PadSchemeHandler.invalidate(pdf)
            return ["pdf": pdf, "created": false]
        }
        if let bundle, let g = bundle["uuid"] as? String {
            let r = try store.addFile(parent: g, name: bundle["name"] as? String ?? "Eintrag", ext: "pdf", data: data)
            return ["pdf": r["uuid"] ?? "", "created": false]
        }
        // Noch kein Eintrags-Ordner: anlegen, Eintrag hineinlegen, PDF dazu
        let info = store.info(for: note)
        let name = (info["name"] as? String) ?? (try? store.readNote(note)["name"] as? String) ?? "Eintrag"
        guard let parent = parent(of: note)?["uuid"] as? String else { throw err("Ordner des Eintrags nicht gefunden") }
        let g = try store.createGroup(parent: parent, name: name)
        guard let gid = g["uuid"] as? String else { throw err("Ordner konnte nicht angelegt werden") }
        try store.move(note, to: gid)
        let r = try store.addFile(parent: gid, name: name, ext: "pdf", data: data)
        return ["pdf": r["uuid"] ?? "", "created": true]
    }

    /// Ordner, in dem ein Datensatz liegt (für neue Bilder: Ordner des Eintrags)
    private func parent(of uuid: String) -> [String: Any]? {
        let tree = store.tree()
        let target = store.resolve(uuid)
        func find(_ nodes: [[String: Any]], _ parent: [String: Any]?) -> [String: Any]? {
            for n in nodes {
                if n["uuid"] as? String == target { return parent }
                if n["note"] as? String == target { return n }   // Eintrags-Ordner
                if let hit = find(n["children"] as? [[String: Any]] ?? [], n) { return hit }
            }
            return nil
        }
        return find(tree["nodes"] as? [[String: Any]] ?? [], tree["root"] as? [String: Any])
    }

    private func assetParent(for note: String) -> String {
        if note.isEmpty { return (store.tree()["root"] as? [String: Any])?["uuid"] as? String ?? "" }
        return parent(of: note)?["uuid"] as? String ?? ""
    }

    /// Suche in Namen und Einträgen (einfach, ohne Index – die Ablage ist klein)
    private func search(_ q: String) -> [[String: Any]] {
        let words = q.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return [] }
        var out: [[String: Any]] = []
        let tree = store.tree()
        func walk(_ nodes: [[String: Any]], _ path: String) {
            for n in nodes {
                let name = n["name"] as? String ?? ""
                let kind = n["kind"] as? String ?? ""
                let uuid = (kind == "bundle" ? n["note"] : n["uuid"]) as? String ?? ""
                var hay = name.lowercased()
                // Suche wartet nicht auf iCloud – was noch nicht geladen ist, findet sie beim nächsten Mal
                var text: String?
                if kind == "note" || kind == "bundle" { text = (try? store.readNote(uuid, wait: false))?["markdown"] as? String }
                if let text { hay += " " + text.lowercased() }
                if kind != "group", words.allSatisfy({ hay.contains($0) }) {
                    var snippet = ""
                    if let text, let r = text.lowercased().range(of: words[0]) {
                        let start = text.index(r.lowerBound, offsetBy: -40, limitedBy: text.startIndex) ?? text.startIndex
                        let end = text.index(r.upperBound, offsetBy: 80, limitedBy: text.endIndex) ?? text.endIndex
                        snippet = String(text[start..<end]).replacingOccurrences(of: "\n", with: " ")
                    }
                    out.append(["uuid": uuid, "name": name, "kind": kind == "bundle" ? "note" : kind, "path": path, "text": snippet])
                }
                walk(n["children"] as? [[String: Any]] ?? [], path.isEmpty ? name : "\(path) / \(name)")
            }
        }
        walk(tree["nodes"] as? [[String: Any]] ?? [], "")
        return Array(out.prefix(60))
    }

    static func fileExtension(name: String, mime: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if !ext.isEmpty { return ext }
        switch mime {
        case "image/jpeg": return "jpg"
        case "image/heic": return "heic"
        case "image/gif": return "gif"
        case "application/pdf": return "pdf"
        default: return "png"
        }
    }

    static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return f.string(from: Date())
    }
}

// MARK: - Tabellen (CSV/TSV)

enum Sheets {
    static func separator(_ text: String, ext: String) -> Character {
        if ext == "tsv" { return "\t" }
        let first = text.split(separator: "\n", maxSplits: 1).first ?? ""
        return first.filter { $0 == ";" }.count > first.filter { $0 == "," }.count ? ";" : ","
    }

    static func parse(_ text: String, ext: String) -> [[String]] {
        let sep = separator(text, ext: ext)
        var rows: [[String]] = [], row: [String] = [], field = ""
        var quoted = false
        var it = Array(text.replacingOccurrences(of: "\r\n", with: "\n")).makeIterator()
        var pending: Character? = nil
        while let c = pending ?? it.next() {
            pending = nil
            if quoted {
                if c == "\"" {
                    if let n = it.next() { if n == "\"" { field.append("\"") } else { quoted = false; pending = n } } else { quoted = false }
                } else { field.append(c) }
            } else if c == "\"" && field.isEmpty {
                quoted = true
            } else if c == sep {
                row.append(field); field = ""
            } else if c == "\n" {
                row.append(field); rows.append(row); row = []; field = ""
            } else {
                field.append(c)
            }
        }
        if !field.isEmpty || !row.isEmpty { row.append(field); rows.append(row) }
        return rows
    }

    static func write(_ rows: [[String]], sep: Character) -> String {
        rows.map { r in
            r.map { f in
                f.contains(sep) || f.contains("\"") || f.contains("\n") ? "\"" + f.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : f
            }.joined(separator: String(sep))
        }.joined(separator: "\n") + "\n"
    }
}

// MARK: - Strukturformeln über PubChem (wie am Mac)

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
