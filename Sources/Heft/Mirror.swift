import Foundation
import CryptoKit

// Abgleich mit dem iPad über iCloud Drive.
//
// DEVONthink bleibt die eigentliche Ablage. Heft legt eine Kopie aller
// Einträge und Dateien in „iCloud Drive/Heft“ ab; das iPad arbeitet darauf.
// Seine Änderungen schreibt das iPad als kleine Aufträge nach „Aufträge/“ –
// der Mac trägt sie über dieselben Wege in DEVONthink ein wie seine eigenen
// Änderungen (mit Sicherung) und frischt danach die Kopie auf.
//
//   Heft.json          Verzeichnis: Ordnerbaum, Dateien, Prüfsummen, Zuordnung neuer Kennungen
//   Einstellungen.json Heft-Einstellungen für das iPad
//   Dateien/<uuid>.<endung>
//   Aufträge/*.json    Änderungen vom iPad (werden nach dem Eintragen gelöscht).
//                      Text von Einträgen steht direkt im Auftrag – so kommen
//                      Auftrag und Inhalt garantiert zusammen an.
//   Aufträge/Anhänge/  neue oder geänderte Bilder/PDFs vom iPad (mit Prüfsumme
//                      im Auftrag: ist die Datei noch nicht ganz übertragen,
//                      wartet der Mac auf den nächsten Durchgang)
//   Aufträge/Fehler/   Aufträge, die nicht eingetragen werden konnten
//
// Haben Mac und iPad denselben Eintrag geändert, gewinnt nichts still: die
// Fassung vom iPad landet als eigener Eintrag „… (iPad)“ daneben.

final class Mirror {
    static let shared = Mirror()

    private let dt = DEVONthink.shared
    private let fm = FileManager.default
    private var timer: Timer?
    private var pending: DispatchWorkItem?
    private var busy = false
    private var again = false
    /// Meldet geänderte Einträge an die Oberfläche (Baum neu laden)
    var onChange: (() -> Void)?
    /// Letzter Durchgang (für die Anzeige in den Einstellungen)
    private(set) var lastRun: Date?
    private(set) var lastError: String?
    private(set) var lastLog: [String] = []

    private var settings: [String: Any] { Store.shared.get() }
    var enabled: Bool { (settings["ipadSync"] as? Bool) ?? false }

    /// iCloud Drive/Heft (bzw. der eingestellte Ordner, z. B. für Tests)
    var root: URL {
        let name = (settings["ipadSyncFolder"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Heft"
        return fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
    }
    private var manifestURL: URL { root.appendingPathComponent("Heft.json") }
    private var filesDir: URL { root.appendingPathComponent("Dateien", isDirectory: true) }
    private var ordersDir: URL { root.appendingPathComponent("Aufträge", isDirectory: true) }
    private var failedDir: URL { ordersDir.appendingPathComponent("Fehler", isDirectory: true) }

    // MARK: - Steuerung

    func start() {
        DispatchQueue.main.async {
            self.timer?.invalidate()
            self.timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in self?.syncSoon(after: 0) }
            self.syncSoon(after: 2)
        }
    }

    func syncSoon(after delay: TimeInterval = 3) {
        guard enabled else { return }
        DispatchQueue.main.async {
            self.pending?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.syncNow() }
            self.pending = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    func syncNow(completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        guard enabled else { completion?(.success(["enabled": false])); return }
        if busy { again = true; completion?(.success(["queued": true])); return }
        busy = true
        dt.async({ try self.run() }) { result in
            DispatchQueue.main.async {
                self.busy = false
                self.lastRun = Date()
                switch result {
                case .success(let r):
                    self.lastError = nil
                    if let log = r["log"] as? [String], !log.isEmpty { self.lastLog = log }
                    if (r["changedTree"] as? Bool) == true { self.onChange?() }
                case .failure(let e):
                    self.lastError = e.localizedDescription
                    NSLog("Heft-Abgleich: \(e.localizedDescription)")
                }
                completion?(result)
                if self.again { self.again = false; self.syncSoon(after: 1) }
            }
        }
    }

    // MARK: - Ein Durchgang

    private func run() throws -> [String: Any] {
        let s = settings
        guard let database = s["database"] as? String, !database.isEmpty else { throw DTError.script("Keine Datenbank gewählt") }
        let rootGroup = s["root"] as? String ?? ""
        for d in [root, filesDir, ordersDir] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }

        var manifest = readJSON(manifestURL) ?? [:]
        var files = manifest["files"] as? [String: [String: Any]] ?? [:]
        var aliases = manifest["aliases"] as? [String: String] ?? [:]
        var log: [String] = []

        // 1. Aufträge vom iPad eintragen (in der Reihenfolge, in der sie entstanden sind)
        let orders = ((try? fm.contentsOfDirectory(at: ordersDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        var appliedAny = false
        for url in orders {
            guard let order = readJSON(url) else { continue }
            do {
                let note = try apply(order, files: &files, aliases: &aliases)
                log.append(note)
                try coordinatedDelete(url)
                appliedAny = true
            } catch is NotYet {
                // Anhang noch unterwegs – Reihenfolge wahren, Rest beim nächsten Mal
                log.append("Warte auf Anhang")
                break
            } catch {
                var failed = order
                failed["error"] = error.localizedDescription
                try? fm.createDirectory(at: failedDir, withIntermediateDirectories: true)
                if let data = try? JSONSerialization.data(withJSONObject: failed, options: [.prettyPrinted]) {
                    try? coordinatedWrite(data, to: failedDir.appendingPathComponent(url.lastPathComponent))
                }
                try? coordinatedDelete(url)
                log.append("Fehler bei \(order["op"] as? String ?? "?"): \(error.localizedDescription)")
            }
        }

        // 2. Stand aus DEVONthink holen und geänderte Dateien in die Kopie schreiben
        guard let tree = try dt.run(Scripts.tree, [database, rootGroup]) as? [String: Any] else { throw DTError.script("Ordnerbaum nicht lesbar") }
        var current: [String: [String: Any]] = [:]   // uuid → { modified, ext, kind, name }
        func collect(_ nodes: [[String: Any]]) {
            for n in nodes {
                let kind = n["kind"] as? String ?? ""
                if kind == "bundle", let note = n["note"] as? String {
                    current[note] = ["modified": n["modified"] ?? "", "ext": "md", "kind": "note", "name": n["name"] ?? ""]
                }
                if kind != "group" && kind != "bundle", let u = n["uuid"] as? String {
                    current[u] = ["modified": n["modified"] ?? "", "ext": n["ext"] ?? "", "kind": kind, "name": n["name"] ?? ""]
                }
                if let kids = n["children"] as? [[String: Any]] { collect(kids) }
            }
        }
        collect(tree["nodes"] as? [[String: Any]] ?? [])

        let stale = current.filter { uuid, info in
            guard let known = files[uuid] else { return true }
            if (known["modified"] as? String) != (info["modified"] as? String) { return true }
            return !fm.fileExists(atPath: root.appendingPathComponent(known["file"] as? String ?? "").path)
        }.map(\.key)
        var exported = 0
        if !stale.isEmpty {
            let paths = try dt.run(Scripts.paths, [jsonString(stale)]) as? [String: [String: Any]] ?? [:]
            for uuid in stale {
                guard let info = current[uuid], let p = paths[uuid]?["path"] as? String, !p.isEmpty,
                      let data = try? Data(contentsOf: URL(fileURLWithPath: p)) else { continue }
                let ext = (info["ext"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? URL(fileURLWithPath: p).pathExtension.lowercased()
                let rel = "Dateien/\(uuid)\(ext.isEmpty ? "" : "." + ext)"
                try coordinatedWrite(data, to: root.appendingPathComponent(rel))
                let isNote = (info["kind"] as? String) == "note"
                files[uuid] = ["file": rel, "modified": paths[uuid]?["modified"] ?? info["modified"] ?? "", "hash": isNote ? Self.noteHash(data) : sha256(data),
                               "size": data.count, "kind": info["kind"] ?? "", "name": info["name"] ?? "", "ext": ext]
                exported += 1
            }
        }

        // 3. Gelöschtes aus der Kopie entfernen
        var removed = 0
        for (uuid, info) in files where current[uuid] == nil {
            if let rel = info["file"] as? String { try? coordinatedDelete(root.appendingPathComponent(rel)) }
            files[uuid] = nil
            removed += 1
        }

        // 4. Verzeichnis und Einstellungen schreiben
        let iso = ISO8601DateFormatter().string(from: Date())
        let previousTree = manifest["tree"].flatMap { jsonString($0) }
        manifest = [
            "version": 1,
            "generated": iso,
            "database": database,
            "tree": tree,
            "files": files,
            "aliases": aliases,
            "mac": Host.current().localizedName ?? "Mac"
        ]
        try coordinatedWrite(try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]), to: manifestURL)
        var shared = s
        for k in ["roots"] { shared[k] = nil }
        try coordinatedWrite(try JSONSerialization.data(withJSONObject: shared, options: [.prettyPrinted, .sortedKeys]), to: root.appendingPathComponent("Einstellungen.json"))

        let changedTree = appliedAny || previousTree != jsonString(tree)
        return ["orders": orders.count, "exported": exported, "removed": removed, "log": log, "changedTree": changedTree]
    }

    // MARK: - Aufträge vom iPad

    private struct NotYet: Error {}

    /// Trägt einen Auftrag in DEVONthink ein und gibt eine kurze Beschreibung zurück
    private func apply(_ o: [String: Any], files: inout [String: [String: Any]], aliases: inout [String: String]) throws -> String {
        let op = o["op"] as? String ?? ""
        let map = aliases   // Stand vor diesem Auftrag (Kennungen, die das iPad vorläufig vergeben hat)
        let resolve = { (id: String?) -> String in
            guard let id, !id.isEmpty else { return "" }
            return map[id] ?? id
        }
        // Inhalt des Auftrags: Text direkt, Bilder/PDFs als Anhang mit Prüfsumme
        let content = { () throws -> Data in
            if let md = o["markdown"] as? String { return Data(md.utf8) }
            guard let rel = o["attachment"] as? String, !rel.isEmpty else { throw DTError.script("Inhalt fehlt im Auftrag") }
            let url = self.root.appendingPathComponent(rel)
            guard self.fm.fileExists(atPath: url.path) || self.fm.fileExists(atPath: url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud").path) else { throw NotYet() }
            let data = try self.coordinatedRead(url)
            if let want = o["hash"] as? String, !want.isEmpty, self.sha256(data) != want { throw NotYet() }
            return data
        }
        let dropAttachment = {
            if let rel = o["attachment"] as? String, !rel.isEmpty { try? self.coordinatedDelete(self.root.appendingPathComponent(rel)) }
        }
        let fixLinks = { (md: String) -> String in
            var out = md
            for (tmp, real) in map { out = out.replacingOccurrences(of: "x-devonthink-item://\(tmp)", with: "x-devonthink-item://\(real)") }
            return out
        }

        switch op {
        case "write":
            let uuid = resolve(o["uuid"] as? String)
            let data = try content()
            let known = files[uuid]
            let info = try dt.run(Scripts.paths, [jsonString([uuid])]) as? [String: [String: Any]]
            let nowModified = info?[uuid]?["modified"] as? String
            let isNote = (known?["kind"] as? String) == "note" || (o["kind"] as? String) == "note"
            // Hat sich der Eintrag am Mac geändert, seit das iPad ihn geöffnet hat?
            // Verglichen wird der Inhalt (Prüfsumme), nicht das Datum – sonst sähe
            // jede Zwischenspeicherung des iPads nach einem Konflikt aus.
            let changedOnMac: Bool
            if let baseHash = o["baseHash"] as? String, !baseHash.isEmpty,
               let p = info?[uuid]?["path"] as? String, let current = try? Data(contentsOf: URL(fileURLWithPath: p)) {
                // (ältere Verzeichnisse enthalten noch die einfache Prüfsumme – beide gelten)
                changedOnMac = baseHash != sha256(current) && !(isNote && baseHash == Self.noteHash(current))
            } else {
                let base = (o["base"] as? String) ?? (known?["modified"] as? String)
                changedOnMac = base != nil && nowModified != nil && base != nowModified
            }
            if changedOnMac {
                // Beide Seiten haben geändert: iPad-Fassung als eigenen Eintrag daneben legen
                let parentInfo = try dt.run(Scripts.info, [uuid]) as? [String: Any]
                let parent = parentInfo?["group"] as? String ?? ""
                let name = "\(o["name"] as? String ?? known?["name"] as? String ?? "Eintrag") (iPad)"
                let ext = (known?["ext"] as? String) ?? (isNote ? "md" : "dat")
                let tmp = Store.shared.tempFile("\(name).\(ext)")
                try data.write(to: tmp)
                defer { try? fm.removeItem(at: tmp) }
                _ = try dt.run(Scripts.importInto, [parent, tmp.path, name])
                dropAttachment()
                return "Konflikt: iPad-Fassung von „\(name)“ daneben gelegt"
            }
            if isNote {
                let md = fixLinks(String(decoding: data, as: UTF8.self))
                Store.shared.backup(uuid: uuid, markdown: md)
                let tmp = Store.shared.tempFile("eintrag.md")
                try md.write(to: tmp, atomically: true, encoding: .utf8)
                defer { try? fm.removeItem(at: tmp) }
                var tagsJSON = ""
                if let tags = o["tags"] as? [String], let d = try? JSONSerialization.data(withJSONObject: tags) { tagsJSON = String(decoding: d, as: UTF8.self) }
                _ = try dt.run(Scripts.write, [uuid, tmp.path, o["name"] as? String ?? (known?["name"] as? String ?? ""), tagsJSON])
            } else {
                let tmp = Store.shared.tempFile("datei.\((known?["ext"] as? String) ?? "dat")")
                try data.write(to: tmp)
                defer { try? fm.removeItem(at: tmp) }
                try dt.replaceData(uuid: uuid, with: tmp)
                DispatchQueue.main.async { SchemeHandler.shared.invalidate(uuid: uuid) }
                dropAttachment()
            }
            return "Geändert: \(uuid)"

        case "create-note":
            let parent = resolve(o["parent"] as? String)
            let name = o["name"] as? String ?? "Unbenannt"
            let md = fixLinks(String(decoding: try content(), as: UTF8.self))
            let tmp = Store.shared.tempFile("neu.md")
            try md.write(to: tmp, atomically: true, encoding: .utf8)
            defer { try? fm.removeItem(at: tmp) }
            let r = try dt.run(Scripts.createNote, [parent, name, tmp.path, (o["bundle"] as? Bool) == true ? "1" : "0"]) as? [String: Any]
            if let tmpId = o["tempId"] as? String, let real = r?["uuid"] as? String {
                aliases[tmpId] = real
                if let g = r?["group"] as? String, let tmpGroup = o["tempGroup"] as? String { aliases[tmpGroup] = g }
            }
            return "Neuer Eintrag: \(name)"

        case "create-file":
            let parent = resolve(o["parent"] as? String)
            let name = o["name"] as? String ?? "Datei"
            let data = try content()
            let ext = ((o["attachment"] as? String ?? "") as NSString).pathExtension
            let tmp = Store.shared.tempFile("\(name)\(ext.isEmpty ? "" : "." + ext)")
            try data.write(to: tmp)
            defer { try? fm.removeItem(at: tmp) }
            let r = try dt.run(Scripts.importInto, [parent, tmp.path, name]) as? [String: Any]
            if let tmpId = o["tempId"] as? String, let real = r?["uuid"] as? String { aliases[tmpId] = real }
            dropAttachment()
            return "Neue Datei: \(name)"

        case "create-group":
            let parent = resolve(o["parent"] as? String)
            let name = o["name"] as? String ?? "Neuer Ordner"
            let r = try dt.run(Scripts.createGroup, [parent, name]) as? [String: Any]
            if let tmpId = o["tempId"] as? String, let real = r?["uuid"] as? String { aliases[tmpId] = real }
            return "Neuer Ordner: \(name)"

        case "rename":
            _ = try dt.run(Scripts.rename, [resolve(o["uuid"] as? String), o["name"] as? String ?? ""])
            return "Umbenannt"

        case "move":
            _ = try dt.run(Scripts.move, [resolve(o["uuid"] as? String), resolve(o["to"] as? String)])
            return "Verschoben"

        case "trash":
            // Nur in den Papierkorb von DEVONthink – nichts geht endgültig verloren
            _ = try dt.run(Scripts.trash, [resolve(o["uuid"] as? String)])
            return "In den Papierkorb gelegt"

        case "plaintext":
            // Texterkennung vom iPad: Text des Scans in DEVONthink hinterlegen
            let tmp = Store.shared.tempFile("ocr.txt")
            try (o["text"] as? String ?? "").write(to: tmp, atomically: true, encoding: .utf8)
            defer { try? fm.removeItem(at: tmp) }
            _ = try dt.run(Scripts.setPlainText, [resolve(o["uuid"] as? String), tmp.path])
            return "Text erkannt"

        case "settings":
            if let patch = o["settings"] as? [String: Any] {
                var clean = patch
                for k in ["database", "root", "roots", "ipadSync", "ipadSyncFolder"] { clean[k] = nil }
                _ = Store.shared.merge(clean)
            }
            return "Einstellungen übernommen"

        default:
            throw DTError.script("Unbekannter Auftrag „\(op)“")
        }
    }

    // MARK: - Dateien in iCloud Drive (immer koordiniert, damit iCloud nichts dazwischenfunkt)

    private func coordinatedWrite(_ data: Data, to url: URL) throws {
        var err: NSError?
        var inner: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forReplacing, error: &err) { u in
            do { try data.write(to: u, options: .atomic) } catch { inner = error }
        }
        if let e = err ?? inner { throw e }
    }

    private func coordinatedRead(_ url: URL) throws -> Data {
        var err: NSError?
        var out: Data?
        var inner: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &err) { u in
            do { out = try Data(contentsOf: u) } catch { inner = error }
        }
        if let e = err ?? inner { throw e }
        return out ?? Data()
    }

    private func coordinatedDelete(_ url: URL) throws {
        guard fm.fileExists(atPath: url.path) else { return }
        var err: NSError?
        var inner: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forDeleting, error: &err) { u in
            do { try self.fm.removeItem(at: u) } catch { inner = error }
        }
        if let e = err ?? inner { throw e }
    }

    private func readJSON(_ url: URL) -> [String: Any]? {
        guard fm.fileExists(atPath: url.path), let data = try? coordinatedRead(url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func jsonString(_ v: Any) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys, .fragmentsAllowed]) else { return "" }
        return String(decoding: d, as: UTF8.self)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Prüfsumme eines Eintrags: Zeilenenden vereinheitlicht, Leerraum am Ende
    /// egal – so zählt nur der Inhalt (gleiche Rechnung wie auf dem iPad)
    static func noteHash(_ data: Data) -> String {
        let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
        let trimmed = text.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return SHA256.hash(data: Data(trimmed.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
