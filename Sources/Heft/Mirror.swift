import Foundation
import CryptoKit

// Abgleich mit dem iPad über iCloud Drive.
//
// DEVONthink bleibt die eigentliche Ablage. Heft legt eine Kopie aller
// Einträge und Dateien in „iCloud Drive/Heft“ ab; das iPad arbeitet darauf.
// Seine Änderungen schreibt das iPad als kleine Aufträge nach „Aufträge/“ –
// Heft am Mac bemerkt jeden neuen Auftrag sofort (Ordnerüberwachung, kein
// Warten auf einen Takt), trägt ihn direkt in DEVONthink ein und frischt
// danach die Kopie auf.
//
//   Heft.json          Verzeichnis: Ordnerbaum, Dateien, Prüfsummen, Zuordnung
//                      neuer Kennungen und die zuletzt erledigten Aufträge
//   Einstellungen.json Heft-Einstellungen für das iPad
//   Dateien/<uuid>.<endung>
//   Aufträge/*.json    Änderungen vom iPad (werden nach dem Eintragen gelöscht).
//                      Text von Einträgen steht direkt im Auftrag – so kommen
//                      Auftrag und Inhalt garantiert zusammen an.
//   Aufträge/Anhänge/  neue oder geänderte Bilder/PDFs vom iPad (mit Prüfsumme
//                      im Auftrag: ist die Datei noch nicht ganz übertragen,
//                      wartet der Mac darauf – höchstens eine halbe Stunde)
//   Aufträge/Fehler/   Aufträge, die nicht eingetragen werden konnten
//
// Es gibt keine Versionen und keine Konfliktkopien: Die zuletzt gespeicherte
// Fassung gilt – egal ob sie vom Mac oder vom iPad kommt.

final class Mirror {
    static let shared = Mirror()

    private let dt = DEVONthink.shared
    private let fm = FileManager.default
    private var timer: Timer?
    private var watchers: [FolderWatcher] = []
    private var activity: NSObjectProtocol?
    private var pending: DispatchWorkItem?
    /// Dateinamen in Aufträge/ und Anhänge/ nach dem letzten Durchgang (nur Hauptthread):
    /// Die Ordnerüberwachung reagiert auf neue Dateien, nicht auf das eigene Löschen
    private var knownNames = Set<String>()
    private var busy = false
    private var again = false
    /// Meldet geänderte Einträge an die Oberfläche (Baum neu laden)
    var onChange: (() -> Void)?
    /// Letzter Durchgang (für die Anzeige in den Einstellungen)
    private(set) var lastRun: Date?
    private(set) var lastError: String?
    private(set) var lastLog: [String] = []

    /// Ein Auftrag, der so lange nicht vollständig ankommt, wird aufgegeben
    private let giveUpAfter: TimeInterval = 30 * 60
    /// So viele erledigte Aufträge stehen im Verzeichnis (das iPad erkennt daran, was eingetragen ist)
    private let keepApplied = 300

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
    private var attachmentsDir: URL { ordersDir.appendingPathComponent("Anhänge", isDirectory: true) }
    private var failedDir: URL { ordersDir.appendingPathComponent("Fehler", isDirectory: true) }

    // MARK: - Steuerung

    func start() {
        DispatchQueue.main.async {
            // Läuft Heft nur im Hintergrund (Fenster zu), würde macOS es sonst
            // schlafen legen („App Nap“) – Aufträge vom iPad blieben dann liegen
            if self.activity == nil {
                self.activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .automaticTerminationDisabled],
                                                                      reason: "Abgleich mit dem iPad")
            }
            self.timer?.invalidate()
            // Nur noch als Rückfall und für Änderungen in DEVONthink selbst – Aufträge kommen über die Ordnerüberwachung
            self.timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.syncSoon(after: 0) }
            self.watch()
            self.syncSoon(after: 1)
        }
    }

    func stop() {
        DispatchQueue.main.async {
            self.timer?.invalidate()
            self.timer = nil
            self.watchers = []
            self.pending?.cancel()
            if let a = self.activity { ProcessInfo.processInfo.endActivity(a); self.activity = nil }
        }
    }

    /// Neue Aufträge und Anhänge sofort bemerken
    private func watch() {
        guard enabled else { return }
        for d in [ordersDir, attachmentsDir] { try? fm.createDirectory(at: d, withIntermediateDirectories: true) }
        // Ordner neu angelegt, verschoben oder anderer Ordner eingestellt? Dann neu beobachten
        let dirs = [ordersDir, attachmentsDir]
        if watchers.map(\.url) == dirs && watchers.allSatisfy({ $0.isCurrent }) { return }
        watchers = dirs.compactMap { FolderWatcher(url: $0) { [weak self] in self?.folderChanged() } }
    }

    /// Nur neue Dateien lösen einen Durchgang aus – das Löschen erledigter Aufträge nicht
    private func folderChanged() {
        let now = pendingNames()
        if now.isSubset(of: knownNames) { knownNames = now; return }
        syncSoon(after: 1)
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
                    self.lastError = r["error"] as? String
                    if let log = r["log"] as? [String], !log.isEmpty { self.lastLog = log }
                    if (r["changedTree"] as? Bool) == true { self.onChange?() }
                    if let names = r["known"] as? [String] { self.knownNames = Set(names) }
                case .failure(let e):
                    self.lastError = e.localizedDescription
                    NSLog("Heft-Abgleich: \(e.localizedDescription)")
                }
                self.watch()
                completion?(result)
                if self.again { self.again = false; self.syncSoon(after: 1) }
            }
        }
    }

    // MARK: - Ein Durchgang

    // Nur auf der DEVONthink-Warteschlange benutzt (ein Durchgang nach dem anderen):
    /// Seit wann der Mac einen noch unvollständigen Auftrag kennt – gemessen auf der
    /// Uhr des Macs (ein offline geschriebener Auftrag käme sonst schon „zu alt“ an)
    private var firstSeen: [String: Date] = [:]
    /// Wie oft ein Auftrag an einem vorübergehenden Fehler hängen blieb (Zeitüberschreitung …)
    private var attempts: [String: Int] = [:]

    /// Eigener Stand des Abgleichs: neue Kennungen und erledigte Aufträge, nach jedem
    /// Auftrag gesichert – wird Heft mitten im Durchgang beendet, ist nichts verloren
    private var localURL: URL { Store.shared.supportDir.appendingPathComponent("ipad-abgleich.json") }

    private func loadLocal() -> (aliases: [String: String], applied: [String], failed: [String: String]) {
        guard let data = try? Data(contentsOf: localURL),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (o["folder"] as? String) == root.path else { return ([:], [], [:]) }
        return (o["aliases"] as? [String: String] ?? [:], o["applied"] as? [String] ?? [], o["failed"] as? [String: String] ?? [:])
    }

    private func saveLocal(_ aliases: [String: String], _ applied: [String], _ failed: [String: String]) {
        let o: [String: Any] = ["folder": root.path, "aliases": aliases, "applied": applied, "failed": failed]
        if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: localURL, options: .atomic) }
    }

    /// Wie lange wartet der Mac schon auf diesen Auftrag (bzw. seinen Anhang)?
    private func waited(_ name: String) -> TimeInterval {
        let first = firstSeen[name] ?? Date()
        firstSeen[name] = first
        return Date().timeIntervalSince(first)
    }

    private func run() throws -> [String: Any] {
        let s = settings
        guard let database = s["database"] as? String, !database.isEmpty else { throw DTError.script("Keine Datenbank gewählt") }
        let rootGroup = s["root"] as? String ?? ""
        for d in [root, filesDir, ordersDir] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }

        // Ein vorhandenes, aber gerade nicht lesbares Verzeichnis nicht überschreiben
        var previous: [String: Any] = [:]
        if fm.fileExists(atPath: manifestURL.path) {
            guard let p = readJSON(manifestURL) else { throw DTError.script("Heft.json ist gerade nicht lesbar") }
            previous = p
        }
        var files = previous["files"] as? [String: [String: Any]] ?? [:]
        let local = loadLocal()
        var aliases = (previous["aliases"] as? [String: String] ?? [:]).merging(local.aliases) { _, mine in mine }
        var applied = previous["applied"] as? [String] ?? []
        for n in local.applied where !applied.contains(n) { applied.append(n) }
        var failed = (previous["failed"] as? [String: String] ?? [:]).merging(local.failed) { _, mine in mine }
        var log: [String] = []

        // 1. Aufträge vom iPad eintragen – streng in der Reihenfolge, in der sie entstanden sind
        let urls = ((try? fm.contentsOfDirectory(at: ordersDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        let present = Set(urls.map(\.lastPathComponent))
        firstSeen = firstSeen.filter { present.contains($0.key) }
        attempts = attempts.filter { present.contains($0.key) }
        var transientError: Error?
        if !urls.isEmpty {
            // Datenbank wirklich offen? Sonst schlüge jeder Auftrag mit „Datensatz nicht
            // gefunden“ fehl – dann lieber warten, bis sie wieder offen ist
            do { _ = try dt.run("function main(argv) { db(argv[0]); return true; }", [database]) }
            catch { transientError = error; log.append("DEVONthink: \(error.localizedDescription)") }
        }
        var orders: [(url: URL, order: [String: Any])] = []
        if transientError == nil {
            for url in urls {
                let name = url.lastPathComponent
                // Schon eingetragen (Heft wurde vor dem Löschen beendet): nur noch aufräumen
                if applied.contains(name) { try? coordinatedDelete(url); continue }
                if let order = readJSON(url) { orders.append((url, order)); continue }
                // Noch nicht ganz da: später weiter, damit nichts überholt wird
                if waited(name) < giveUpAfter { log.append("Warte auf einen Auftrag"); break }
                fail(url, order: ["op": "?"], message: "Auftrag ist unlesbar", failed: &failed, applied: &applied, log: &log)
            }
        }
        // Mehrere Speicherstände desselben Eintrags (das iPad speichert laufend):
        // nur der jüngste muss in DEVONthink ankommen. Nur bei Text – er steht
        // vollständig im Auftrag; ein Bild/PDF könnte noch unterwegs sein.
        let known0 = aliases
        let noteTarget = { (o: [String: Any]) -> String? in
            guard (o["op"] as? String) == "write", o["markdown"] is String else { return nil }
            return (o["uuid"] as? String).map { known0[$0] ?? $0 }
        }
        var latestWrite: [String: Int] = [:]
        for (i, o) in orders.enumerated() { if let u = noteTarget(o.order) { latestWrite[u] = i } }
        var appliedAny = false
        for (i, item) in orders.enumerated() {
            let (url, order) = item
            let name = url.lastPathComponent
            if let u = noteTarget(order), let last = latestWrite[u], last > i {
                applied.append(name)
                saveLocal(aliases, applied, failed)
                try? coordinatedDelete(url)
                continue
            }
            do {
                let note = try apply(order, retry: (attempts[name] ?? 0) > 0, files: &files, aliases: &aliases)
                log.append(note)
                applied.append(name)
                appliedAny = true
            } catch is NotYet {
                // Anhang noch unterwegs – Reihenfolge wahren, Rest beim nächsten Mal
                if waited(name) < giveUpAfter { log.append("Warte auf einen Anhang"); break }
                fail(url, order: order, message: "Der Anhang (Bild/PDF) ist nicht in iCloud angekommen", failed: &failed, applied: &applied, log: &log)
            } catch let e as DTError where e.isTransient {
                // DEVONthink gerade nicht erreichbar: nichts verwerfen, beim nächsten Durchgang
                // weiter – nach drei Versuchen aber aufgeben, sonst hinge die Warteschlange
                let n = (attempts[name] ?? 0) + 1
                attempts[name] = n
                if n < 3 { log.append(e.localizedDescription); transientError = e; break }
                fail(url, order: order, message: e.localizedDescription, failed: &failed, applied: &applied, log: &log)
            } catch {
                fail(url, order: order, message: error.localizedDescription, failed: &failed, applied: &applied, log: &log)
            }
            // Erst sichern, dann den Auftrag löschen
            saveLocal(aliases, applied, failed)
            try? coordinatedDelete(url)
        }
        if applied.count > keepApplied { applied.removeFirst(applied.count - keepApplied) }
        let known = Set(applied)
        failed = failed.filter { known.contains($0.key) }
        saveLocal(aliases, applied, failed)

        // 2.+3. Stand aus DEVONthink in die Kopie. Klappt das nicht, bleibt das Verzeichnis,
        // wie es ist: Das iPad zeigt seine Änderungen weiter selbst an, bis die Kopie sie
        // enthält (Kennungen und erledigte Aufträge sind am Mac gesichert, siehe saveLocal).
        let (tree, exported, removed) = try refreshCopy(database: database, rootGroup: rootGroup, files: &files)

        // 4. Verzeichnis und Einstellungen schreiben – nur, wenn sich etwas geändert hat
        //    (jedes Schreiben ist ein Hochladen nach iCloud und ein Neuladen auf dem iPad),
        //    spätestens aber alle zehn Minuten als Lebenszeichen für das iPad
        var manifest: [String: Any] = [
            "version": 2,
            "database": database,
            "tree": tree,
            "files": files,
            "aliases": aliases,
            "applied": applied,
            "failed": failed,
            "mac": Host.current().localizedName ?? "Mac"
        ]
        var unchanged = previous
        unchanged["generated"] = nil
        unchanged["changed"] = nil
        let now = Date()
        let iso = ISO8601DateFormatter()
        let contentChanged = jsonString(unchanged) != jsonString(manifest)
        let lastWrite = (previous["generated"] as? String).flatMap { iso.date(from: $0) }
        if contentChanged || lastWrite == nil || now.timeIntervalSince(lastWrite ?? now) > 600 {
            manifest["changed"] = contentChanged ? iso.string(from: now)
                : (previous["changed"] as? String) ?? (previous["generated"] as? String) ?? iso.string(from: now)
            manifest["generated"] = iso.string(from: now)
            try coordinatedWrite(try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]), to: manifestURL)
        }
        var shared = s
        for k in ["roots"] { shared[k] = nil }
        let settingsData = try JSONSerialization.data(withJSONObject: shared, options: [.prettyPrinted, .sortedKeys])
        let settingsURL = root.appendingPathComponent("Einstellungen.json")
        if (try? coordinatedRead(settingsURL)) != settingsData { try coordinatedWrite(settingsData, to: settingsURL) }

        if let transientError, !appliedAny { throw transientError }
        let changedTree = appliedAny || jsonString(previous["tree"] ?? NSNull()) != jsonString(tree)
        var result: [String: Any] = ["orders": orders.count, "exported": exported, "removed": removed, "log": log,
                                     "changedTree": changedTree, "known": Array(pendingNames())]
        if let transientError { result["error"] = transientError.localizedDescription }
        return result
    }

    /// Namen der Dateien in Aufträge/ und Anhänge/ (für die Ordnerüberwachung)
    private func pendingNames() -> Set<String> {
        var out = Set<String>()
        for d in [ordersDir, attachmentsDir] {
            for n in (try? fm.contentsOfDirectory(atPath: d.path)) ?? [] { out.insert(n) }
        }
        return out
    }

    /// Stand aus DEVONthink in die Kopie: geänderte Dateien schreiben, gelöschte entfernen
    private func refreshCopy(database: String, rootGroup: String, files: inout [String: [String: Any]]) throws -> ([String: Any], Int, Int) {
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
                let isNote = (info["kind"] as? String) == "note"
                let hash = isNote ? Self.noteHash(data) : sha256(data)
                // Inhalt gleich (z. B. nur das Datum hat sich geändert): Datei nicht neu hochladen
                let target = root.appendingPathComponent(rel)
                if (files[uuid]?["hash"] as? String) != hash || (files[uuid]?["file"] as? String) != rel || !fm.fileExists(atPath: target.path) {
                    try coordinatedWrite(data, to: target)
                    exported += 1
                }
                files[uuid] = ["file": rel, "modified": paths[uuid]?["modified"] ?? info["modified"] ?? "", "hash": hash,
                               "size": data.count, "kind": info["kind"] ?? "", "name": info["name"] ?? "", "ext": ext]
            }
        }

        // 3. Gelöschtes aus der Kopie entfernen
        var removed = 0
        for (uuid, info) in files where current[uuid] == nil {
            if let rel = info["file"] as? String { try? coordinatedDelete(root.appendingPathComponent(rel)) }
            files[uuid] = nil
            removed += 1
        }
        return (tree, exported, removed)
    }

    /// Auftrag, der sich nicht eintragen lässt: nach Aufträge/Fehler legen und dem iPad melden
    private func fail(_ url: URL, order: [String: Any], message: String, failed: inout [String: String], applied: inout [String], log: inout [String]) {
        var copy = order
        copy["error"] = message
        try? fm.createDirectory(at: failedDir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: copy, options: [.prettyPrinted]) {
            try? coordinatedWrite(data, to: failedDir.appendingPathComponent(url.lastPathComponent))
        }
        try? coordinatedDelete(url)
        let name = url.lastPathComponent
        applied.append(name)
        failed[name] = message
        log.append("Fehler bei \(order["op"] as? String ?? "?"): \(message)")
    }

    private func dropAttachment(of order: [String: Any]) {
        if let rel = order["attachment"] as? String, !rel.isEmpty { try? coordinatedDelete(root.appendingPathComponent(rel)) }
    }

    // MARK: - Aufträge vom iPad

    private struct NotYet: Error {}

    /// Trägt einen Auftrag in DEVONthink ein und gibt eine kurze Beschreibung zurück
    private func apply(_ o: [String: Any], retry: Bool, files: inout [String: [String: Any]], aliases: inout [String: String]) throws -> String {
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
        // Nach einer Zeitüberschreitung: Hat DEVONthink den Datensatz vielleicht doch
        // schon angelegt? Dann nicht ein zweites Mal
        let existing = { (parent: String, name: String, type: String, bundle: Bool) throws -> [String: Any]? in
            guard retry else { return nil }
            return try self.dt.run(Self.findRecent, [parent, name, type, bundle ? "1" : "0"]) as? [String: Any]
        }
        let fixLinks = { (md: String) -> String in
            var out = md
            for (tmp, real) in map { out = out.replacingOccurrences(of: "x-devonthink-item://\(tmp)", with: "x-devonthink-item://\(real)") }
            return out
        }

        switch op {
        case "write":
            // Die Fassung vom iPad gilt – ohne Vergleich mit älteren Ständen
            let uuid = resolve(o["uuid"] as? String)
            let data = try content()
            let known = files[uuid]
            let isNote = (known?["kind"] as? String) == "note" || (o["kind"] as? String) == "note" || o["markdown"] != nil
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
                dropAttachment(of: o)
            }
            return "Geändert: \(o["name"] as? String ?? known?["name"] as? String ?? uuid)"

        case "create-note":
            let parent = resolve(o["parent"] as? String)
            let name = o["name"] as? String ?? "Unbenannt"
            if let r = try existing(parent, name, "markdown", (o["bundle"] as? Bool) == true), let real = r["uuid"] as? String {
                if let tmpId = o["tempId"] as? String { aliases[tmpId] = real }
                if let g = r["group"] as? String, let tmpGroup = o["tempGroup"] as? String { aliases[tmpGroup] = g }
                return "Schon angelegt: \(name)"
            }
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
            if let r = try existing(parent, name, "", false), let real = r["uuid"] as? String {
                if let tmpId = o["tempId"] as? String { aliases[tmpId] = real }
                dropAttachment(of: o)
                return "Schon angelegt: \(name)"
            }
            let data = try content()
            let ext = ((o["attachment"] as? String ?? "") as NSString).pathExtension
            let tmp = Store.shared.tempFile("\(name)\(ext.isEmpty ? "" : "." + ext)")
            try data.write(to: tmp)
            defer { try? fm.removeItem(at: tmp) }
            let r = try dt.run(Scripts.importInto, [parent, tmp.path, name]) as? [String: Any]
            if let tmpId = o["tempId"] as? String, let real = r?["uuid"] as? String { aliases[tmpId] = real }
            dropAttachment(of: o)
            return "Neue Datei: \(name)"

        case "create-group":
            let parent = resolve(o["parent"] as? String)
            let name = o["name"] as? String ?? "Neuer Ordner"
            if let r = try existing(parent, name, "group", false), let real = r["uuid"] as? String {
                if let tmpId = o["tempId"] as? String { aliases[tmpId] = real }
                return "Schon angelegt: \(name)"
            }
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

    /// Kürzlich (in der letzten Stunde) angelegter Datensatz dieses Namens im Ordner?
    /// bundle = "1": Eintrags-Ordner mit gleichnamigem Eintrag darin
    private static let findRecent = #"""
    function main(argv) {
      const [parent, name, type, bundle] = argv;
      const g = rec(parent);
      const kids = g.children;
      const n = kids.name(), u = kids.uuid(), t = kids.recordType();
      let c = []; try { c = kids.creationDate(); } catch (e) {}
      const now = Date.now();
      for (let i = n.length - 1; i >= 0; i--) {
        if (n[i] !== name) continue;
        if (c[i] && now - c[i].getTime() > 3600 * 1000) continue;
        if (bundle === '1') {
          if (t[i] !== 'group') continue;
          const md = noteInBundle(rec(u[i]));
          if (md) return { uuid: md.uuid(), group: u[i] };
          continue;
        }
        if (type && t[i] !== type) continue;
        return { uuid: u[i], group: g.uuid() };
      }
      return null;
    }
    """#

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

/// Meldet, wenn in einem Ordner Dateien dazukommen, verschwinden oder umbenannt
/// werden – auch wenn iCloud sie von einem anderen Gerät hineinlegt
final class FolderWatcher {
    let url: URL
    private let source: DispatchSourceFileSystemObject
    private var gone = false

    init?(url: URL, onChange: @escaping () -> Void) {
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        self.url = url
        source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .link, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            // Ordner selbst gelöscht oder verschoben: beim nächsten Durchgang neu anlegen und beobachten
            if !self.source.data.intersection([.delete, .rename]).isEmpty { self.gone = true }
            onChange()
        }
        source.setCancelHandler { close(fd) }
        source.resume()
    }

    var isCurrent: Bool { !gone && FileManager.default.fileExists(atPath: url.path) }

    deinit { source.cancel() }
}
