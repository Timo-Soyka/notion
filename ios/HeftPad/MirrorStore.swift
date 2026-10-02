import Foundation
import CryptoKit

// Ablage der iPad-App: arbeitet auf der Kopie, die Heft am Mac in
// „iCloud Drive/Heft“ ablegt (siehe Sources/Heft/Mirror.swift).
//
// Lesen: Heft.json (Ordnerbaum, Dateien) und Dateien/<uuid>.<endung>.
// Schreiben: nie direkt in die Kopie, sondern als Auftrag nach Aufträge/ –
// der Mac trägt ihn in DEVONthink ein. Bis dahin hält die App ihre
// Änderungen selbst vor („ausstehend“) und zeigt sie sofort an.
//
// Neue Dinge bekommen eine vorläufige Kennung (NEU-…). Sobald der Mac sie
// angelegt hat, steht die echte Kennung in Heft.json unter „aliases“.

final class MirrorStore {
    static let shared = MirrorStore()

    private let fm = FileManager.default
    private let lock = NSRecursiveLock()
    private(set) var root: URL?
    private var manifest: [String: Any] = [:]
    private var manifestStamp: Date?
    private var state = PadState()

    struct Pending: Codable {
        var id: String            // Name der Auftragsdatei
        var op: String
        var uuid: String?         // betroffener Datensatz (echt oder vorläufig)
        var parent: String?
        var name: String?
        var markdown: String?
        var localFile: String?    // Kopie eines neuen Anhangs im App-Speicher
        var bundle: Bool?
        var tempGroup: String?
        var kind: String?
        var created: Date
    }

    struct PadState: Codable {
        var pending: [Pending] = []
        var baseHash: [String: String] = [:]     // Inhalt, auf dem die iPad-Änderungen aufbauen
        var settings: [String: AnyCodable] = [:] // eigene Einstellungen (vor denen vom Mac)
    }

    // MARK: - Ordner

    private let bookmarkKey = "mirrorBookmark"
    var hasFolder: Bool { UserDefaults.standard.data(forKey: bookmarkKey) != nil }

    func setFolder(_ url: URL) throws {
        _ = url.startAccessingSecurityScopedResource()
        let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        UserDefaults.standard.set(data, forKey: bookmarkKey)
        root = url
        loadState()
        // Anderer Ordner (z. B. andere Datenbank): Offenes vom alten nicht mitnehmen
        if UserDefaults.standard.string(forKey: "mirrorPath") != url.standardizedFileURL.path {
            resetState()
            UserDefaults.standard.set(url.standardizedFileURL.path, forKey: "mirrorPath")
        }
    }

    private func resetState() {
        lock.lock(); defer { lock.unlock() }
        state = PadState()
        saveState()
        manifest = [:]
        manifestStamp = nil
        for f in (try? fm.contentsOfDirectory(at: localDir, includingPropertiesForKeys: nil)) ?? []
        where f.lastPathComponent.hasPrefix("NEU-") { try? fm.removeItem(at: f) }
    }

    /// Ordner aus dem Lesezeichen wieder öffnen (beim Start)
    @discardableResult
    func openFolder() -> Bool {
        #if DEBUG
        // Zum Testen im Simulator: Ordner direkt angeben (Startargument -HeftFolder /Pfad)
        if let path = UserDefaults.standard.string(forKey: "HeftFolder") {
            root = URL(fileURLWithPath: path, isDirectory: true)
            loadState()
            return true
        }
        #endif
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return false }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return false }
        _ = url.startAccessingSecurityScopedResource()
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: bookmarkKey)
        }
        root = url
        loadState()
        return true
    }

    func forgetFolder() {
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
        root = nil
    }

    /// Ist das wirklich der Heft-Ordner vom Mac?
    func looksValid() -> Bool {
        guard let root else { return false }
        var ok = false
        coordinateRead(root.appendingPathComponent("Heft.json")) { ok = self.fm.fileExists(atPath: $0.path) }
        return ok
    }

    // MARK: - Verzeichnis vom Mac

    /// Heft.json neu lesen; true, wenn es sich geändert hat
    @discardableResult
    func reloadManifest() -> Bool {
        guard let root else { return false }
        let url = root.appendingPathComponent("Heft.json")
        try? fm.startDownloadingUbiquitousItem(at: url)
        var data: Data?
        coordinateRead(url) { data = try? Data(contentsOf: $0) }
        guard let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        lock.lock(); defer { lock.unlock() }
        let changed = (obj["generated"] as? String) != (manifest["generated"] as? String)
        manifest = obj
        if changed { prunePending() }
        return changed
    }

    var aliases: [String: String] { lock.lock(); defer { lock.unlock() }; return manifest["aliases"] as? [String: String] ?? [:] }
    private var files: [String: [String: Any]] { manifest["files"] as? [String: [String: Any]] ?? [:] }

    func resolve(_ id: String) -> String { aliases[id] ?? id }

    var lastSync: String? { manifest["generated"] as? String }
    var macName: String? { manifest["mac"] as? String }
    var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return state.pending.count }

    /// Erledigte Aufträge vergessen: Die Auftragsdatei ist weg und der Mac hat danach ein neues Verzeichnis geschrieben
    private func prunePending() {
        guard let root, let generated = (manifest["generated"] as? String).flatMap({ ISO8601DateFormatter().date(from: $0) }) else { return }
        let before = state.pending.count
        let al = manifest["aliases"] as? [String: String] ?? [:]
        state.pending.removeAll { p in
            let orderGone = !fm.fileExists(atPath: root.appendingPathComponent("Aufträge/\(p.id)").path)
            guard orderGone && generated > p.created else { return false }
            // Text erst vergessen, wenn der Mac genau diese Fassung zurückgemeldet hat
            // (oder nach zwei Minuten – dann gab es einen Konflikt und die Fassung liegt daneben)
            if p.op == "write" || p.op == "create-note", let md = p.markdown, let u = p.uuid {
                let real = al[u] ?? u
                let hash = (manifest["files"] as? [String: [String: Any]])?[real]?["hash"] as? String
                return hash == Self.noteHash(md) || generated.timeIntervalSince(p.created) > 120
            }
            return true
        }
        if state.pending.count != before { saveState() }
    }

    // MARK: - Ordnerbaum (mit eigenen, noch nicht übernommenen Änderungen)

    func tree() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var tree = manifest["tree"] as? [String: Any] ?? ["root": ["uuid": "", "name": "Heft"], "nodes": []]
        var nodes = tree["nodes"] as? [[String: Any]] ?? []
        let rootId = (tree["root"] as? [String: Any])?["uuid"] as? String ?? ""
        let al = manifest["aliases"] as? [String: String] ?? [:]
        let iso = ISO8601DateFormatter().string(from: Date())
        for p in state.pending {
            // Schon vom Mac übernommen (echte Kennung bekannt und im Baum)? Dann nichts mehr tun
            let target = p.uuid.map { al[$0] ?? $0 }
            switch p.op {
            case "create-note":
                guard let tmp = p.uuid, al[tmp] == nil else { continue }
                let note: [String: Any] = ["uuid": tmp, "name": p.name ?? "Unbenannt", "kind": "note", "type": "markdown", "ext": "md", "modified": iso]
                let parent = (p.parent.map { al[$0] ?? $0 }) ?? rootId
                if p.bundle == true {
                    let group: [String: Any] = ["uuid": p.tempGroup ?? tmp + "-G", "name": p.name ?? "Unbenannt", "kind": "bundle", "note": tmp, "modified": iso, "children": []]
                    insert(group, into: parent, nodes: &nodes, root: rootId)
                } else {
                    insert(note, into: parent, nodes: &nodes, root: rootId)
                }
            case "create-group":
                guard let tmp = p.uuid, al[tmp] == nil else { continue }
                let group: [String: Any] = ["uuid": tmp, "name": p.name ?? "Neuer Ordner", "kind": "group", "modified": iso, "children": []]
                insert(group, into: (p.parent.map { al[$0] ?? $0 }) ?? rootId, nodes: &nodes, root: rootId)
            case "create-file":
                guard let tmp = p.uuid, al[tmp] == nil else { continue }
                let ext = ((p.localFile ?? "") as NSString).pathExtension.lowercased()
                let kind = ext == "pdf" ? "pdf" : "image"
                let file: [String: Any] = ["uuid": tmp, "name": p.name ?? "Datei", "kind": kind, "type": kind == "pdf" ? "PDF document" : "picture", "ext": ext, "modified": iso]
                insert(file, into: (p.parent.map { al[$0] ?? $0 }) ?? rootId, nodes: &nodes, root: rootId)
            case "rename":
                if let target { update(target, in: &nodes) { $0["name"] = p.name ?? $0["name"] } }
            case "write":
                if let target, let name = p.name, !name.isEmpty { update(target, in: &nodes) { $0["name"] = name; $0["modified"] = iso } }
            case "move":
                if let target, let node = remove(target, from: &nodes) { insert(node, into: (p.parent.map { al[$0] ?? $0 }) ?? rootId, nodes: &nodes, root: rootId) }
            case "trash":
                if let target { _ = remove(target, from: &nodes) }
            default: break
            }
        }
        tree["nodes"] = nodes
        return tree
    }

    private func insert(_ node: [String: Any], into parent: String, nodes: inout [[String: Any]], root: String) {
        if parent == root || parent.isEmpty || !insertDeep(node, into: parent, nodes: &nodes) { nodes.append(node) }
    }

    @discardableResult
    private func insertDeep(_ node: [String: Any], into parent: String, nodes: inout [[String: Any]]) -> Bool {
        for i in nodes.indices {
            // Ordner selbst – oder Eintrags-Ordner, wenn der Eintrag gemeint ist
            let hit = nodes[i]["uuid"] as? String == parent || (nodes[i]["kind"] as? String == "bundle" && nodes[i]["note"] as? String == parent)
            if hit {
                var kids = nodes[i]["children"] as? [[String: Any]] ?? []
                kids.append(node)
                nodes[i]["children"] = kids
                return true
            }
            if var kids = nodes[i]["children"] as? [[String: Any]], insertDeep(node, into: parent, nodes: &kids) {
                nodes[i]["children"] = kids
                return true
            }
        }
        return false
    }

    private func update(_ uuid: String, in nodes: inout [[String: Any]], _ change: (inout [String: Any]) -> Void) {
        for i in nodes.indices {
            if nodes[i]["uuid"] as? String == uuid || nodes[i]["note"] as? String == uuid { change(&nodes[i]); return }
            if var kids = nodes[i]["children"] as? [[String: Any]] { update(uuid, in: &kids, change); nodes[i]["children"] = kids }
        }
    }

    private func remove(_ uuid: String, from nodes: inout [[String: Any]]) -> [String: Any]? {
        for i in nodes.indices {
            if nodes[i]["uuid"] as? String == uuid || nodes[i]["note"] as? String == uuid { return nodes.remove(at: i) }
            if var kids = nodes[i]["children"] as? [[String: Any]], let hit = remove(uuid, from: &kids) {
                nodes[i]["children"] = kids
                return hit
            }
        }
        return nil
    }

    // MARK: - Einträge lesen und schreiben

    /// Text eines Eintrags: eigene ausstehende Fassung zuerst, sonst die Kopie vom Mac
    func readNote(_ id: String) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let uuid = resolve(id)
        if let p = state.pending.last(where: { ($0.op == "write" || $0.op == "create-note") && ($0.uuid == id || $0.uuid == uuid) }), let md = p.markdown {
            return ["markdown": md, "name": p.name ?? "", "modified": isoNow(), "uuid": uuid]
        }
        guard let info = files[uuid], let rel = info["file"] as? String else { throw err("Eintrag ist noch nicht auf dem iPad – bitte Heft am Mac öffnen") }
        let md = try readText(rel)
        if state.baseHash[uuid] == nil { state.baseHash[uuid] = info["hash"] as? String ?? Self.noteHash(md) }
        return ["markdown": md, "name": info["name"] as? String ?? "", "modified": info["modified"] as? String ?? "", "uuid": uuid]
    }

    func writeNote(_ id: String, markdown: String, name: String, tags: [String]?) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let uuid = resolve(id)
        // Noch nicht vom Mac angelegt: den ausstehenden Neu-Auftrag aktualisieren genügt nicht (er
        // könnte gerade eingetragen werden) – also einen Schreibauftrag hinterher
        let base = state.baseHash[uuid] ?? (files[uuid]?["hash"] as? String) ?? ""
        var order: [String: Any] = ["op": "write", "uuid": uuid, "kind": "note", "name": name, "markdown": markdown]
        if !base.isEmpty { order["baseHash"] = base }
        if let tags { order["tags"] = tags }
        let id = try writeOrder(order)
        state.pending.append(Pending(id: id, op: "write", uuid: uuid, name: name, markdown: markdown, kind: "note", created: Date()))
        state.baseHash[uuid] = Self.noteHash(markdown)
        saveState()
        return ["modified": isoNow(), "treeChanged": false]
    }

    func createNote(parent: String, name: String, markdown: String, bundle: Bool) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let tmp = newId()
        let group = bundle ? newId() : nil
        var order: [String: Any] = ["op": "create-note", "tempId": tmp, "parent": parent, "name": name, "markdown": markdown, "bundle": bundle]
        if let group { order["tempGroup"] = group }
        let id = try writeOrder(order)
        state.pending.append(Pending(id: id, op: "create-note", uuid: tmp, parent: parent, name: name, markdown: markdown, bundle: bundle, tempGroup: group, kind: "note", created: Date()))
        state.baseHash[tmp] = Self.noteHash(markdown)
        saveState()
        return ["uuid": tmp, "group": group ?? parent]
    }

    func createGroup(parent: String, name: String) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let tmp = newId()
        let id = try writeOrder(["op": "create-group", "tempId": tmp, "parent": parent, "name": name])
        state.pending.append(Pending(id: id, op: "create-group", uuid: tmp, parent: parent, name: name, created: Date()))
        saveState()
        return ["uuid": tmp]
    }

    func rename(_ uuid: String, to name: String) throws {
        lock.lock(); defer { lock.unlock() }
        let id = try writeOrder(["op": "rename", "uuid": uuid, "name": name])
        state.pending.append(Pending(id: id, op: "rename", uuid: uuid, name: name, created: Date()))
        saveState()
    }

    func move(_ uuid: String, to parent: String) throws {
        lock.lock(); defer { lock.unlock() }
        let id = try writeOrder(["op": "move", "uuid": uuid, "to": parent])
        state.pending.append(Pending(id: id, op: "move", uuid: uuid, parent: parent, created: Date()))
        saveState()
    }

    func trash(_ uuid: String) throws {
        lock.lock(); defer { lock.unlock() }
        let id = try writeOrder(["op": "trash", "uuid": uuid])
        state.pending.append(Pending(id: id, op: "trash", uuid: uuid, created: Date()))
        saveState()
    }

    /// Neues Bild/PDF (z. B. eingefügt in einen Eintrag): Anhang + Auftrag, sofort nutzbar
    func addFile(parent: String, name: String, ext: String, data: Data) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard let root else { throw err("Kein Heft-Ordner gewählt") }
        let tmp = newId()
        let cleanExt = ext.isEmpty ? "png" : ext.lowercased()
        // eigene Kopie im App-Speicher – der Anhang in iCloud wird nach dem Eintragen gelöscht
        let local = localDir.appendingPathComponent("\(tmp).\(cleanExt)")
        try data.write(to: local)
        let rel = "Aufträge/Anhänge/\(tmp).\(cleanExt)"
        let dir = root.appendingPathComponent("Aufträge/Anhänge", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try coordinateWrite(data, to: root.appendingPathComponent(rel))
        let id = try writeOrder(["op": "create-file", "tempId": tmp, "parent": parent, "name": name, "attachment": rel, "hash": Self.sha256(data)])
        state.pending.append(Pending(id: id, op: "create-file", uuid: tmp, parent: parent, name: name, localFile: local.lastPathComponent, created: Date()))
        saveState()
        return ["uuid": tmp, "link": "x-devonthink-item://\(tmp)", "name": name]
    }

    /// Geänderte Datei (Bild nach Bearbeitung, ausgefülltes PDF)
    func writeFile(_ id: String, data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard let root else { throw err("Kein Heft-Ordner gewählt") }
        let uuid = resolve(id)
        // Noch nicht beim Mac angekommene neue Datei: Endung aus der eigenen Kopie
        let pendingExt = state.pending.last(where: { $0.uuid == uuid && $0.localFile != nil }).map { ($0.localFile! as NSString).pathExtension }
        let ext = (files[uuid]?["ext"] as? String) ?? pendingExt ?? "dat"
        let att = "\(newId()).\(ext)"
        let local = localDir.appendingPathComponent(att)
        try data.write(to: local)
        let rel = "Aufträge/Anhänge/\(att)"
        try? fm.createDirectory(at: root.appendingPathComponent("Aufträge/Anhänge", isDirectory: true), withIntermediateDirectories: true)
        try coordinateWrite(data, to: root.appendingPathComponent(rel))
        var order: [String: Any] = ["op": "write", "uuid": uuid, "attachment": rel, "hash": Self.sha256(data)]
        if let base = state.baseHash[uuid] ?? files[uuid]?["hash"] as? String { order["baseHash"] = base }
        let oid = try writeOrder(order)
        state.pending.append(Pending(id: oid, op: "write", uuid: uuid, localFile: att, created: Date()))
        state.baseHash[uuid] = Self.sha256(data)
        saveState()
    }

    /// Erkannter Text eines Scans (Texterkennung) – der Mac hinterlegt ihn in DEVONthink
    func setPlainText(_ id: String, text: String) throws {
        lock.lock(); defer { lock.unlock() }
        _ = try writeOrder(["op": "plaintext", "uuid": resolve(id), "text": text])
    }

    // MARK: - Dateien für die Anzeige

    /// Datei zu einer Kennung: eigene neue/geänderte Fassung, sonst die Kopie vom Mac
    func fileURL(for id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        let uuid = resolve(id)
        if let p = state.pending.last(where: { ($0.uuid == id || $0.uuid == uuid) && $0.localFile != nil }), let lf = p.localFile {
            let url = localDir.appendingPathComponent(lf)
            if fm.fileExists(atPath: url.path) { return url }
        }
        guard let root, let rel = files[uuid]?["file"] as? String else { return nil }
        let url = root.appendingPathComponent(rel)
        try? fm.startDownloadingUbiquitousItem(at: url)
        return url
    }

    func fileData(for id: String) -> Data? {
        guard let url = fileURL(for: id) else { return nil }
        var out: Data?
        coordinateRead(url) { out = try? Data(contentsOf: $0) }
        return out
    }

    func info(for id: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let uuid = resolve(id)
        var out = files[uuid] ?? [:]
        out["uuid"] = uuid
        if out["ext"] == nil, let lf = state.pending.last(where: { $0.uuid == uuid && $0.localFile != nil })?.localFile {
            out["ext"] = (lf as NSString).pathExtension.lowercased()
        }
        return out
    }

    /// Lokale Kopie zum Anzeigen (Quick Look, Audio/Video brauchen eine echte Datei)
    func viewingCopy(for id: String, name: String) -> URL? {
        guard let src = fileURL(for: id) else { return nil }
        let dir = fm.temporaryDirectory.appendingPathComponent("Ansicht", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let clean = name.replacingOccurrences(of: "/", with: "-")
        let target = dir.appendingPathComponent(clean.isEmpty ? src.lastPathComponent : "\(clean).\(src.pathExtension)")
        var ok = false
        coordinateRead(src) { u in
            try? self.fm.removeItem(at: target)
            ok = (try? self.fm.copyItem(at: u, to: target)) != nil
        }
        return ok ? target : nil
    }

    private func readText(_ rel: String) throws -> String {
        guard let root else { throw err("Kein Heft-Ordner gewählt") }
        let url = root.appendingPathComponent(rel)
        try? fm.startDownloadingUbiquitousItem(at: url)
        var text: String?
        coordinateRead(url) { text = try? String(contentsOf: $0, encoding: .utf8) }
        guard let text else { throw err("Datei ist noch nicht heruntergeladen") }
        return text
    }

    // MARK: - Einstellungen

    func settings() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var out: [String: Any] = [:]
        if let root {
            var data: Data?
            coordinateRead(root.appendingPathComponent("Einstellungen.json")) { data = try? Data(contentsOf: $0) }
            if let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { out = obj }
        }
        for (k, v) in state.settings { out[k] = v.value }
        out["configured"] = true
        return out
    }

    func setSettings(_ patch: [String: Any]) -> [String: Any] {
        lock.lock()
        for (k, v) in patch { state.settings[k] = AnyCodable(v) }
        saveState()
        lock.unlock()
        _ = try? writeOrder(["op": "settings", "settings": patch])
        return settings()
    }

    // MARK: - Aufträge

    private func writeOrder(_ order: [String: Any]) throws -> String {
        guard let root else { throw err("Kein Heft-Ordner gewählt") }
        var o = order
        o["at"] = isoNow()
        o["from"] = "iPad"
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        // Laufende Nummer, damit Aufträge aus derselben Sekunde in der richtigen Reihenfolge bleiben
        counter += 1
        let name = "\(stamp)-\(String(format: "%05d", counter % 100000))-\(UUID().uuidString.prefix(6)).json"
        let dir = root.appendingPathComponent("Aufträge", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted])
        try coordinateWrite(data, to: dir.appendingPathComponent(name))
        return name
    }

    private var counter: Int {
        get { UserDefaults.standard.integer(forKey: "orderCounter") }
        set { UserDefaults.standard.set(newValue, forKey: "orderCounter") }
    }

    // MARK: - Eigener Zustand (App-Speicher)

    private var localDir: URL {
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Heft", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private var stateURL: URL { localDir.appendingPathComponent("zustand.json") }

    private func loadState() {
        if let data = try? Data(contentsOf: stateURL), let s = try? JSONDecoder().decode(PadState.self, from: data) { state = s }
    }

    private func saveState() {
        if let data = try? JSONEncoder().encode(state) { try? data.write(to: stateURL, options: .atomic) }
    }

    // MARK: - Hilfen

    private func newId() -> String { "NEU-" + UUID().uuidString }
    private func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }
    private func err(_ msg: String) -> NSError { NSError(domain: "Heft", code: 1, userInfo: [NSLocalizedDescriptionKey: msg]) }

    private func coordinateRead(_ url: URL, _ body: (URL) -> Void) {
        var e: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &e, byAccessor: body)
    }

    private func coordinateWrite(_ data: Data, to url: URL) throws {
        var e: NSError?
        var inner: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forReplacing, error: &e) { u in
            do { try data.write(to: u, options: .atomic) } catch { inner = error }
        }
        if let x = e ?? inner { throw x }
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Gleiche Rechnung wie Mirror.noteHash am Mac
    static func noteHash(_ text: String) -> String {
        let t = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return sha256(Data(t.utf8))
    }
}

// Beliebiger JSON-Wert zum Speichern der Einstellungen
struct AnyCodable: Codable {
    let value: Any
    init(_ value: Any) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let b = try? c.decode(Bool.self) { value = b }
        else if let i = try? c.decode(Int.self) { value = i }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if let a = try? c.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? c.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { value = NSNull() }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try c.encode(b)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let a as [Any]: try c.encode(a.map { AnyCodable($0) })
        case let o as [String: Any]: try c.encode(o.mapValues { AnyCodable($0) })
        default: try c.encodeNil()
        }
    }
}
