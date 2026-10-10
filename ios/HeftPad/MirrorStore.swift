import Foundation
import CryptoKit

// Ablage der iPad-App: arbeitet auf der Kopie, die Heft am Mac in
// „iCloud Drive/Heft“ ablegt (siehe Sources/Heft/Mirror.swift).
//
// Lesen: Heft.json (Ordnerbaum, Dateien) und Dateien/<uuid>.<endung>.
// Schreiben: nie direkt in die Kopie, sondern als Auftrag nach Aufträge/ –
// Heft am Mac bemerkt ihn sofort und trägt ihn in DEVONthink ein. Bis die
// Kopie den neuen Stand enthält, zeigt die App ihre eigene Fassung.
//
// Es gibt keine Versionen und keine Konfliktkopien: Die zuletzt gespeicherte
// Fassung gilt. Welche Aufträge erledigt sind, steht in Heft.json („applied“).
//
// Speicherstände sammeln sich nicht in der Cloud: Liegt der letzte Auftrag für
// denselben Eintrag noch unabgeholt da, ersetzt der neue ihn (samt Anhang).
// Ohne Mac bleibt so pro Eintrag ein Auftrag, und iCloud muss nicht jede
// Zwischenspeicherung einzeln hochladen.
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
    private var presenter: ManifestPresenter?
    /// iCloud hat ein neues Verzeichnis vom Mac geliefert (kommt auf einer Hintergrund-Warteschlange)
    var onManifestChange: (() -> Void)?

    struct Pending: Codable {
        var id: String            // Name der Auftragsdatei
        var op: String
        var uuid: String?         // betroffener Datensatz (echt oder vorläufig)
        var parent: String?
        var name: String?
        var markdown: String?
        var localFile: String?    // Kopie eines neuen/geänderten Anhangs im App-Speicher
        var bundle: Bool?
        var tempGroup: String?
        var kind: String?
        var created: Date
        var hash: String?         // Prüfsumme des Inhalts – daran sieht man, wann die Kopie ihn enthält
        var applied: Bool?        // vom Mac eingetragen
        var failed: Bool?         // vom Mac abgelehnt – eigene Fassung bleibt sichtbar …
        var base: String?         // … solange die Kopie vom Mac noch diesen Stand hat (höchstens einen Tag)
        var dttg: Bool?           // über DEVONthink To Go eingetragen (sichtbar, bis die Kopie vom Mac es zeigt)
    }

    struct PadState: Codable {
        var pending: [Pending] = []
        var settings: [String: AnyCodable] = [:] // eigene Einstellungen (vor denen vom Mac)
        var lastOrder: String? = nil             // zuletzt geschriebene Auftragsdatei
        var aliases: [String: String]? = nil     // vorläufige → echte Kennung, von DEVONthink To Go gemeldet
    }

    /// Ergebnis einer Prüfung von Heft.json
    struct Update {
        var treeChanged = false
        var notes: [String] = []      // Einträge mit neuem Stand vom Mac (offene laden neu)
        var failures: [String] = []   // Änderungen, die der Mac nicht eintragen konnte
    }
    // Gesammelt, bis die Oberfläche sie abholt (lib.tree liest das Verzeichnis auch, meldet aber nichts)
    private var newsNotes = Set<String>()
    private var newsFailures: [String] = []

    /// Seit dem letzten Abholen vom Mac geänderte Einträge und gescheiterte Aufträge
    func takeNews() -> Update {
        lock.lock(); defer { lock.unlock() }
        let up = Update(treeChanged: false, notes: Array(newsNotes), failures: newsFailures)
        newsNotes = []
        newsFailures = []
        return up
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
        observe()
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
            observe()
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
        observe()
        return true
    }

    func forgetFolder() {
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
        presenter?.stop()
        presenter = nil
        root = nil
    }

    /// Ist das wirklich der Heft-Ordner vom Mac?
    func looksValid() -> Bool {
        guard let root else { return false }
        var ok = false
        coordinateRead(root.appendingPathComponent("Heft.json")) { ok = self.fm.fileExists(atPath: $0.path) }
        return ok
    }

    /// Heft.json beobachten: Schreibt der Mac ein neues Verzeichnis, meldet iCloud
    /// das sofort – kein Warten auf den nächsten Takt
    private func observe() {
        presenter?.stop()
        presenter = nil
        guard let root else { return }
        presenter = ManifestPresenter(url: root.appendingPathComponent("Heft.json")) { [weak self] in self?.onManifestChange?() }
    }

    // MARK: - Verzeichnis vom Mac

    /// Heft.json neu lesen, erledigte Aufträge abhaken. Geänderte Einträge und
    /// Fehler sammelt takeNews(); hier nur: hat sich der Baum geändert?
    /// Immer nur einer zugleich (Zeitgeber, iCloud-Meldung und Oberfläche rufen das)
    private let reloading = NSLock()
    @discardableResult
    func reloadManifest() -> Update {
        reloading.lock(); defer { reloading.unlock() }
        guard let root else { return Update() }
        let url = root.appendingPathComponent("Heft.json")
        try? fm.startDownloadingUbiquitousItem(at: url)
        var up = Update()
        // Nur neu einlesen, wenn sich die Datei geändert hat (sie kann groß sein)
        var u = url
        u.removeAllCachedResourceValues()
        let stamp = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        lock.lock()
        let needsRead = stamp == nil || stamp != manifestStamp || manifest.isEmpty
        lock.unlock()
        if needsRead {
            var data: Data?
            coordinateRead(url) { data = try? Data(contentsOf: $0) }
            if let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                lock.lock()
                manifestStamp = stamp
                if manifest.isEmpty || Self.isNewer(obj, than: manifest) {
                    let oldFiles = files
                    let contentChanged = Self.changeMark(obj) != Self.changeMark(manifest)
                    manifest = obj
                    if contentChanged {
                        up.treeChanged = true
                        // Einträge mit neuem Inhalt (offene laden neu, wenn sie dort unverändert sind) –
                        // auch unter ihrer vorläufigen Kennung, falls sie auf dem iPad angelegt wurden
                        let al = aliasMap
                        for (uuid, info) in files where (info["kind"] as? String) == "note" {
                            guard let old = oldFiles[uuid], (old["hash"] as? String) != (info["hash"] as? String) else { continue }
                            newsNotes.insert(uuid)
                            for (tmp, real) in al where real == uuid { newsNotes.insert(tmp) }
                        }
                    }
                    newsFailures += markApplied()
                }
                lock.unlock()
            }
        }
        if settle() { up.treeChanged = true }
        return up
    }

    /// Ist dieses Verzeichnis neuer als das bekannte? Nie auf einen älteren Stand
    /// zurückfallen (iCloud liefert gelegentlich einen alten nach) – aber einem Mac,
    /// dessen Uhr zurückgestellt wurde, trotzdem folgen: Er zählt jedes Verzeichnis
    /// hoch („seq“), ältere Fassungen kennen nur den Zeitpunkt.
    private static func isNewer(_ a: [String: Any], than b: [String: Any]) -> Bool {
        let ga = a["generated"] as? String ?? "", gb = b["generated"] as? String ?? ""
        let sa = (a["seq"] as? Int) ?? 0, sb = (b["seq"] as? Int) ?? 0
        if sa != sb { return sa > sb || ga > gb }
        return ga > gb
    }

    /// Zeitpunkt der letzten inhaltlichen Änderung (ältere Verzeichnisse kennen nur „generated“)
    private static func changeMark(_ m: [String: Any]) -> String? {
        (m["changed"] as? String) ?? (m["generated"] as? String)
    }

    private var aliasMap: [String: String] {
        var a = manifest["aliases"] as? [String: String] ?? [:]
        for (k, v) in state.aliases ?? [:] where a[k] == nil { a[k] = v }
        return a
    }
    var aliases: [String: String] { lock.lock(); defer { lock.unlock() }; return aliasMap }
    private var files: [String: [String: Any]] { manifest["files"] as? [String: [String: Any]] ?? [:] }

    func resolve(_ id: String) -> String { aliases[id] ?? id }

    var lastSync: String? { lock.lock(); defer { lock.unlock() }; return manifest["generated"] as? String }
    var macName: String? { lock.lock(); defer { lock.unlock() }; return manifest["mac"] as? String }
    /// Heft am Mac noch auf dem alten Stand (vor 1.16)? Dann kämen wieder Konfliktkopien
    var macOutdated: Bool { lock.lock(); defer { lock.unlock() }; return !manifest.isEmpty && ((manifest["version"] as? Int) ?? 1) < 2 }
    var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return state.pending.filter { $0.applied != true }.count }

    /// Aufträge abhaken, die der Mac eingetragen hat; gibt die gescheiterten zurück
    private func markApplied() -> [String] {
        guard let root else { return [] }
        let done = Set(manifest["applied"] as? [String] ?? [])
        let failed = manifest["failed"] as? [String: String] ?? [:]
        let generated = (manifest["generated"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) } ?? .distantPast
        var failures: [String] = []
        var changed = false
        for i in state.pending.indices where state.pending[i].applied != true {
            let p = state.pending[i]
            var ok = done.contains(p.id)
            // Rückfall (z. B. Mac mitten im Abgleich beendet): Auftrag ist weg und das Verzeichnis deutlich jünger
            if !ok, generated.timeIntervalSince(p.created) > 600,
               !fm.fileExists(atPath: root.appendingPathComponent("Aufträge/\(p.id)").path),
               p.dttg != true, !DTTGSync.isQueued(p.id) { ok = true }
            guard ok else { continue }
            state.pending[i].applied = true
            changed = true
            if let msg = failed[p.id] {
                state.pending[i].failed = true
                let target = p.uuid.map { aliasMap[$0] ?? $0 } ?? ""
                state.pending[i].base = files[target]?["hash"] as? String
                let what = p.name.map { "„\($0)“" } ?? "Eine Änderung"
                failures.append("\(what): \(msg)")
            }
        }
        if changed { saveState() }
        return failures
    }

    /// Erledigte Aufträge vergessen – eigene Inhalte erst, wenn die Kopie in iCloud
    /// wirklich den Stand vom Mac enthält (sonst zeigte das iPad kurz den alten Stand
    /// und speicherte ihn womöglich wieder). Dateien werden ohne Sperre geprüft.
    @discardableResult
    private func settle() -> Bool {
        // 1. Unter der Sperre: was ist zu entscheiden?
        lock.lock()
        let al = aliasMap
        let fs = files
        let real = { (id: String?) -> String? in id.map { al[$0] ?? $0 } }
        var drop = Set<String>()                          // Auftragsnamen
        var check: [(id: String, info: [String: Any], hash: String, note: Bool, target: String)] = []
        var staleFailed = Set<String>()                   // abgelehnte Fassungen, die nun dem Mac weichen
        let now = Date()
        let shown = mirrorPlaces()
        for (i, p) in state.pending.enumerated() where p.applied == true {
            guard p.markdown != nil || p.localFile != nil, let target = real(p.uuid) else {
                // Über DEVONthink To Go eingetragen: sichtbar lassen, bis die Kopie vom Mac es zeigt
                if p.dttg == true, p.failed != true, !Self.mirrorShows(p, places: shown, aliases: al),
                   now.timeIntervalSince(p.created) < 30 * 86_400 { continue }
                drop.insert(p.id); continue
            }
            // Eine neuere eigene Fassung desselben Eintrags zeigt ohnehin die
            if state.pending[(i + 1)...].contains(where: { real($0.uuid) == target && ($0.markdown != nil || $0.localFile != nil) }) { drop.insert(p.id); continue }
            // Vom Mac abgelehnt: eigene Fassung noch einen Tag zeigen (zum Abschreiben)
            // … aber nur, solange der Mac den Eintrag nicht inzwischen selbst geändert hat
            if p.failed == true {
                if now.timeIntervalSince(p.created) > 86_400 || (fs[target]?["hash"] as? String) != p.base {
                    drop.insert(p.id)
                    staleFailed.insert(target)
                }
                continue
            }
            guard let info = fs[target], let want = info["hash"] as? String else {
                // Mac kennt den Eintrag nicht (mehr) – nicht ewig festhalten
                // (über DEVONthink To Go Eingetragenes kommt erst mit dessen Abgleich zum Mac)
                if now.timeIntervalSince(p.created) > (p.dttg == true ? 30 * 86_400 : 600) { drop.insert(p.id) }
                continue
            }
            check.append((p.id, info, want, p.markdown != nil, target))
        }
        lock.unlock()

        // 2. Ohne Sperre: Hat die Kopie auf diesem iPad den Stand, den das Verzeichnis nennt?
        //    (Egal ob es die eigene Fassung ist oder eine neuere vom Mac)
        var reload = staleFailed
        for c in check where mirrorHas(c.info, hash: c.hash, note: c.note) {
            drop.insert(c.id)
            reload.insert(c.target)
        }
        guard !drop.isEmpty else { return false }

        // 3. Unter der Sperre: vergessen (die Liste kann sich inzwischen geändert haben)
        lock.lock()
        defer { lock.unlock() }
        var gone: [Pending] = []
        state.pending.removeAll { p in
            guard drop.contains(p.id) else { return false }
            gone.append(p)
            return true
        }
        for p in gone { deleteLocal(p.localFile) }
        // Offene Einträge laden dann den Stand der Kopie (nur wenn er sich vom eigenen unterscheidet)
        for t in reload {
            newsNotes.insert(t)
            for (tmp, r) in aliasMap where r == t { newsNotes.insert(tmp) }
        }
        saveState()
        return true
    }

    /// Enthält die Datei in der Kopie (auf diesem iPad, fertig geladen) genau diesen Inhalt?
    private func mirrorHas(_ info: [String: Any], hash: String, note: Bool) -> Bool {
        guard let root, let rel = info["file"] as? String else { return false }
        let url = root.appendingPathComponent(rel)
        guard isCurrent(url) else { try? fm.startDownloadingUbiquitousItem(at: url); return false }
        var u = url
        u.removeAllCachedResourceValues()
        if let size = (info["size"] as? NSNumber)?.intValue, let local = (try? u.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size != local { return false }
        var data: Data?
        coordinateRead(url) { data = try? Data(contentsOf: $0) }
        guard let data else { return false }
        return (note ? Self.noteHash(String(decoding: data, as: UTF8.self)) : Self.sha256(data)) == hash
    }

    // MARK: - Ordnerbaum (mit eigenen, noch nicht übernommenen Änderungen)

    func tree() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var tree = manifest["tree"] as? [String: Any] ?? ["root": ["uuid": "", "name": "Heft"], "nodes": []]
        var nodes = tree["nodes"] as? [[String: Any]] ?? []
        let rootId = (tree["root"] as? [String: Any])?["uuid"] as? String ?? ""
        let al = aliasMap
        let known = Self.ids(in: nodes)
        for p in state.pending {
            // Über DEVONthink To Go eingetragen: zeigen, bis die Kopie vom Mac es enthält
            let viaDTTG = p.applied == true && p.dttg == true && p.failed != true
            guard p.applied != true || viaDTTG else { continue }
            // Schon vom Mac übernommen (echte Kennung bekannt und im Baum)? Dann nichts mehr tun
            let target = p.uuid.map { al[$0] ?? $0 }
            let iso = isoString(p.created)
            // Neu Angelegtes: unter welcher Kennung zeigen – oder gar nicht (schon in der Kopie)?
            func shownId(_ tmp: String?) -> String? {
                guard let tmp else { return nil }
                guard let real = al[tmp] else { return tmp }
                return viaDTTG && !known.contains(real) ? real : nil
            }
            switch p.op {
            case "create-note":
                guard let id = shownId(p.uuid) else { continue }
                let note: [String: Any] = ["uuid": id, "name": p.name ?? "Unbenannt", "kind": "note", "type": "markdown", "ext": "md", "modified": iso]
                let parent = (p.parent.map { al[$0] ?? $0 }) ?? rootId
                if p.bundle == true {
                    let gid = p.tempGroup.map { al[$0] ?? $0 } ?? id + "-G"
                    let group: [String: Any] = ["uuid": gid, "name": p.name ?? "Unbenannt", "kind": "bundle", "note": id, "modified": iso, "children": []]
                    insert(group, into: parent, nodes: &nodes, root: rootId)
                } else {
                    insert(note, into: parent, nodes: &nodes, root: rootId)
                }
            case "create-group":
                guard let id = shownId(p.uuid) else { continue }
                let group: [String: Any] = ["uuid": id, "name": p.name ?? "Neuer Ordner", "kind": "group", "modified": iso, "children": []]
                insert(group, into: (p.parent.map { al[$0] ?? $0 }) ?? rootId, nodes: &nodes, root: rootId)
            case "create-file":
                guard let id = shownId(p.uuid) else { continue }
                let ext = ((p.localFile ?? "") as NSString).pathExtension.lowercased()
                let kind = ext == "pdf" ? "pdf" : "image"
                let file: [String: Any] = ["uuid": id, "name": p.name ?? "Datei", "kind": kind, "type": kind == "pdf" ? "PDF document" : "picture", "ext": ext, "modified": iso]
                insert(file, into: (p.parent.map { al[$0] ?? $0 }) ?? rootId, nodes: &nodes, root: rootId)
            case "rename":
                if let target { update(target, in: &nodes) { $0["name"] = p.name ?? $0["name"] } }
            case "write":
                if let target {
                    update(target, in: &nodes) { n in
                        if let name = p.name, !name.isEmpty { n["name"] = name }
                        n["modified"] = iso
                    }
                }
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

    /// Alle Kennungen im Baum (Ordner, Einträge, Eintrags-Ordner)
    private static func ids(in nodes: [[String: Any]]) -> Set<String> {
        var out = Set<String>()
        func walk(_ ns: [[String: Any]]) {
            for n in ns {
                if let u = n["uuid"] as? String { out.insert(u) }
                if let u = n["note"] as? String { out.insert(u) }
                if let kids = n["children"] as? [[String: Any]] { walk(kids) }
            }
        }
        walk(nodes)
        return out
    }

    /// Wo steht was in der Kopie vom Mac: Kennung → (Name, übergeordneter Ordner)
    private func mirrorPlaces() -> [String: (name: String?, parent: String)] {
        let tree = manifest["tree"] as? [String: Any] ?? [:]
        let rootId = (tree["root"] as? [String: Any])?["uuid"] as? String ?? ""
        var out: [String: (name: String?, parent: String)] = [:]
        func walk(_ ns: [[String: Any]], _ parent: String) {
            for n in ns {
                guard let u = n["uuid"] as? String else { continue }
                out[u] = (n["name"] as? String, parent)
                if let note = n["note"] as? String { out[note] = (n["name"] as? String, parent) }
                if let kids = n["children"] as? [[String: Any]] { walk(kids, u) }
            }
        }
        walk(tree["nodes"] as? [[String: Any]] ?? [], rootId)
        return out
    }

    /// Zeigt die Kopie vom Mac schon, was über DEVONthink To Go eingetragen wurde?
    private static func mirrorShows(_ p: Pending, places: [String: (name: String?, parent: String)], aliases al: [String: String]) -> Bool {
        guard let target = p.uuid.map({ al[$0] ?? $0 }) else { return true }
        switch p.op {
        case "create-group", "create-note", "create-file": return places[target] != nil
        case "rename": return places[target].map { $0.name == p.name } ?? false
        case "move":
            guard let place = places[target] else { return false }
            return p.parent.map { (al[$0] ?? $0) == place.parent } ?? true
        case "trash": return places[target] == nil
        default: return true
        }
    }

    // MARK: - Einträge lesen und schreiben

    /// Jüngste eigene Fassung (Text oder Datei) eines Datensatzes, solange die Kopie sie noch nicht hat
    private func ownContent(_ id: String, text: Bool) -> Pending? {
        let al = aliasMap
        let uuid = al[id] ?? id
        return state.pending.last { p in
            guard let pu = p.uuid, pu == id || pu == uuid || al[pu] == uuid else { return false }
            if text { return p.markdown != nil }
            guard let lf = p.localFile else { return false }
            return fm.fileExists(atPath: localDir.appendingPathComponent(lf).path)
        }
    }

    /// Text eines Eintrags: eigene Fassung zuerst, sonst die Kopie vom Mac.
    /// wait: kurz warten, bis iCloud einen neueren Stand geladen hat (nicht bei der Suche)
    func readNote(_ id: String, wait: Bool = true) throws -> [String: Any] {
        lock.lock()
        let uuid = resolve(id)
        if let p = ownContent(id, text: true), let md = p.markdown {
            lock.unlock()
            return ["markdown": md, "name": p.name ?? "", "modified": isoString(p.created), "uuid": uuid]
        }
        guard let info = files[uuid], let rel = info["file"] as? String else {
            lock.unlock()
            throw err("Eintrag ist noch nicht auf dem iPad – bitte Heft am Mac öffnen")
        }
        lock.unlock()
        let md = try readText(rel, wait: wait)
        return ["markdown": md, "name": info["name"] as? String ?? "", "modified": info["modified"] as? String ?? "", "uuid": uuid]
    }

    func writeNote(_ id: String, markdown: String, name: String, tags: [String]?) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let uuid = resolve(id)
        // Noch nicht vom Mac angelegt: den ausstehenden Neu-Auftrag aktualisieren genügt nicht (er
        // könnte gerade eingetragen werden) – also einen Schreibauftrag hinterher
        var order: [String: Any] = ["op": "write", "uuid": uuid, "kind": "note", "name": name, "markdown": markdown]
        if let tags { order["tags"] = tags }
        let prev = replaceable(uuid, text: true)
        let oid = try writeOrder(order)
        if let prev { drop(prev) }
        let now = Date()
        thinOut(uuid)
        state.pending.append(Pending(id: oid, op: "write", uuid: uuid, name: name, markdown: markdown, kind: "note", created: now, hash: Self.noteHash(markdown)))
        saveState()
        return ["modified": isoString(now), "treeChanged": false]
    }

    /// Ältere, noch offene Speicherstände desselben Eintrags brauchen ihren Inhalt
    /// nicht mehr – angezeigt wird ohnehin der jüngste, und der Mac trägt nur den
    /// jüngsten ein. So sammeln sich keine Kopien im App-Speicher.
    private func thinOut(_ uuid: String) {
        let al = aliasMap
        for i in state.pending.indices where state.pending[i].op == "write" {
            guard let pu = state.pending[i].uuid, pu == uuid || al[pu] == uuid else { continue }
            state.pending[i].markdown = nil
            deleteLocal(state.pending[i].localFile)
            state.pending[i].localFile = nil
        }
    }

    func createNote(parent: String, name: String, markdown: String, bundle: Bool) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let tmp = newId()
        let group = bundle ? newId() : nil
        var order: [String: Any] = ["op": "create-note", "tempId": tmp, "parent": parent, "name": name, "markdown": markdown, "bundle": bundle]
        if let group { order["tempGroup"] = group }
        let id = try writeOrder(order)
        state.pending.append(Pending(id: id, op: "create-note", uuid: tmp, parent: parent, name: name, markdown: markdown, bundle: bundle, tempGroup: group, kind: "note", created: Date(), hash: Self.noteHash(markdown)))
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
        // Bilder und PDFs trägt immer Heft am Mac ein (die Kurzbefehle von DEVONthink To Go legen nur Text an)
        guard let root else { throw err("Kein Heft-Ordner gewählt") }
        let tmp = newId()
        let cleanExt = ext.isEmpty ? "png" : ext.lowercased()
        // eigene Kopie im App-Speicher – der Anhang in iCloud wird nach dem Eintragen gelöscht
        let local = localDir.appendingPathComponent("\(tmp).\(cleanExt)")
        try data.write(to: local)
        let rel = "Aufträge/Anhänge/\(tmp).\(cleanExt)"
        let dir = root.appendingPathComponent("Aufträge/Anhänge", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let hash = Self.sha256(data)
        try coordinateWrite(data, to: root.appendingPathComponent(rel))
        let id = try writeOrder(["op": "create-file", "tempId": tmp, "parent": parent, "name": name, "attachment": rel, "hash": hash], mac: true)
        state.pending.append(Pending(id: id, op: "create-file", uuid: tmp, parent: parent, name: name, localFile: local.lastPathComponent, created: Date(), hash: hash))
        saveState()
        return ["uuid": tmp, "link": "x-devonthink-item://\(tmp)", "name": name]
    }

    /// Geänderte Datei (Bild nach Bearbeitung, ausgefülltes PDF)
    func writeFile(_ id: String, data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        // Bilder und PDFs trägt immer Heft am Mac ein (die Kurzbefehle von DEVONthink To Go legen nur Text an)
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
        let hash = Self.sha256(data)
        try coordinateWrite(data, to: root.appendingPathComponent(rel))
        let prev = replaceable(uuid, text: false)
        let oid = try writeOrder(["op": "write", "uuid": uuid, "attachment": rel, "hash": hash], mac: true)
        if let prev { drop(prev) }
        thinOut(uuid)
        state.pending.append(Pending(id: oid, op: "write", uuid: uuid, localFile: att, created: Date(), hash: hash))
        saveState()
    }

    /// Erkannter Text eines Scans (Texterkennung) – der Mac hinterlegt ihn in DEVONthink
    func setPlainText(_ id: String, text: String) throws {
        lock.lock(); defer { lock.unlock() }
        _ = try writeOrder(["op": "plaintext", "uuid": resolve(id), "text": text], mac: true)
    }

    // MARK: - Dateien für die Anzeige

    /// Datei zu einer Kennung: eigene neue/geänderte Fassung, sonst die Kopie vom Mac
    func fileURL(for id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        if let lf = ownContent(id, text: false)?.localFile { return localDir.appendingPathComponent(lf) }
        guard let root, let rel = files[resolve(id)]?["file"] as? String else { return nil }
        let url = root.appendingPathComponent(rel)
        try? fm.startDownloadingUbiquitousItem(at: url)
        return url
    }

    /// Vor dem Öffnen (nicht auf dem Hauptthread): einen gerade geänderten Stand aus iCloud abwarten
    func prepareFile(_ id: String) {
        guard let url = fileURL(for: id), !url.path.hasPrefix(localDir.path) else { return }
        waitUntilCurrent(url, timeout: 3)
    }

    func fileData(for id: String) -> Data? {
        guard let url = fileURL(for: id) else { return nil }
        // Kopie vom Mac: einen gerade geänderten Stand kurz abwarten – nie auf dem
        // Hauptthread (z. B. beim Öffnen eines Arbeitsblatts), die Oberfläche stünde sonst
        if !Thread.isMainThread && !url.path.hasPrefix(localDir.path) { waitUntilCurrent(url, timeout: 3) }
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

    private func readText(_ rel: String, wait: Bool) throws -> String {
        guard let root else { throw err("Kein Heft-Ordner gewählt") }
        let url = root.appendingPathComponent(rel)
        if wait { waitUntilCurrent(url, timeout: 4) } else { try? fm.startDownloadingUbiquitousItem(at: url) }
        var text: String?
        coordinateRead(url) { text = try? String(contentsOf: $0, encoding: .utf8) }
        guard let text else { throw err("Datei ist noch nicht heruntergeladen") }
        return text
    }

    /// Ist die Datei auf dem neuesten Stand aus iCloud? (Ordner außerhalb von iCloud: ja)
    private func isCurrent(_ url: URL) -> Bool {
        var u = url
        u.removeAllCachedResourceValues()
        guard let v = try? u.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]), v.isUbiquitousItem == true else {
            return fm.fileExists(atPath: url.path)
        }
        return v.ubiquitousItemDownloadingStatus == .current
    }

    /// Neueren Stand aus iCloud anfordern und kurz darauf warten – je Datei
    /// höchstens einmal pro Minute (ohne Netz soll nicht jedes Bild bremsen)
    private var recentWaits: [String: Date] = [:]
    private func waitUntilCurrent(_ url: URL, timeout: TimeInterval) {
        if isCurrent(url) { return }
        try? fm.startDownloadingUbiquitousItem(at: url)
        lock.lock()
        let waitedRecently = recentWaits[url.path].map { Date().timeIntervalSince($0) < 60 } ?? false
        if !waitedRecently { recentWaits[url.path] = Date() }
        lock.unlock()
        if waitedRecently { return }
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            Thread.sleep(forTimeInterval: 0.2)
            if isCurrent(url) { return }
        }
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
        _ = try? writeOrder(["op": "settings", "settings": patch], mac: true)
        return settings()
    }

    // MARK: - Aufträge

    /// Wohin Aufträge gehen: über iCloud zum Mac – oder, beim Abgleich über
    /// DEVONthink To Go, in den App-Speicher (der Kurzbefehl trägt sie dann ein)
    private var orderRoot: URL? { DTTGSync.enabled ? DTTGSync.queueRoot : root }

    /// mac: Aufträge, die nur Heft am Mac ausführen kann (Einstellungen, Texterkennung)
    private func writeOrder(_ order: [String: Any], mac: Bool = false) throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard let root = mac ? root : orderRoot else { throw err("Kein Heft-Ordner gewählt") }
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
        state.lastOrder = name
        return name
    }

    /// Schreibauftrag, den ein neuer Speicherstand ersetzen darf: der zuletzt geschriebene
    /// Auftrag, für denselben Eintrag und dieselbe Art (Text/Datei), vom Mac noch nicht
    /// abgeholt. Nur der letzte – sonst käme der neue Stand vor Aufträge, auf die er sich
    /// stützt (z. B. ein gerade eingefügtes Bild).
    private func replaceable(_ uuid: String, text: Bool) -> Pending? {
        guard let root = orderRoot, let p = state.pending.last, p.id == state.lastOrder,
              p.op == "write", p.applied != true, (p.kind == "note") == text,
              let pu = p.uuid, pu == uuid || aliasMap[pu] == uuid,
              fm.fileExists(atPath: root.appendingPathComponent("Aufträge/\(p.id)").path) else { return nil }
        return p
    }

    /// Ersetzten Auftrag samt Anhang und lokaler Kopie entfernen. Hat der Mac ihn gerade
    /// doch noch eingetragen, schadet das nicht: Der neue Stand folgt gleich danach.
    private func drop(_ p: Pending) {
        state.pending.removeAll { $0.id == p.id }
        guard let root = orderRoot else { return }
        try? coordinateDelete(root.appendingPathComponent("Aufträge/\(p.id)"))
        if let lf = p.localFile {
            try? coordinateDelete(root.appendingPathComponent("Aufträge/Anhänge/\(lf)"))
            deleteLocal(lf)
        }
    }

    private func coordinateDelete(_ url: URL) throws {
        guard fm.fileExists(atPath: url.path) else { return }
        var e: NSError?
        var inner: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forDeleting, error: &e) { u in
            do { try self.fm.removeItem(at: u) } catch { inner = error }
        }
        if let x = e ?? inner { throw x }
    }

    private var counter: Int {
        get { UserDefaults.standard.integer(forKey: "orderCounter") }
        set { UserDefaults.standard.set(newValue, forKey: "orderCounter") }
    }

    // MARK: - Abgleich über DEVONthink To Go

    /// Nächster Stapel für den Kurzbefehl, in der Reihenfolge der Aufträge – bis zum
    /// ersten, der auf etwas verweist, das DEVONthink noch nicht kennt (vorläufige
    /// Kennung). Der kommt in der nächsten Runde, wenn die echte Kennung zurück ist.
    /// files: Anhänge, die der Kurzbefehl unter diesem Namen in „Anhänge/“ findet
    func dttgBatch() -> (items: [[String: Any]], files: [(from: URL, name: String)]) {
        lock.lock(); defer { lock.unlock() }
        let base = DTTGSync.queueRoot
        let q = base.appendingPathComponent("Aufträge", isDirectory: true)
        let names = ((try? fm.contentsOfDirectory(atPath: q.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
        let al = aliasMap
        let rootId = ((manifest["tree"] as? [String: Any])?["root"] as? [String: Any])?["uuid"] as? String ?? ""
        func res(_ v: Any?) -> String? { (v as? String).flatMap { $0.isEmpty ? nil : (al[$0] ?? $0) } }
        func known(_ id: String?) -> Bool { !(id?.hasPrefix("NEU-") ?? false) }
        // Wartet ein Auftrag auf etwas, das nie angelegt wird (Anlegen gescheitert)? Dann fällt er weg
        func orphan(_ ids: String?...) -> Bool {
            ids.contains { id in
                guard let id, id.hasPrefix("NEU-") else { return false }
                return !state.pending.contains { $0.applied != true && ($0.uuid == id || $0.tempGroup == id) }
            }
        }
        var orphans: [String] = []
        defer {
            for n in orphans {
                try? fm.removeItem(at: q.appendingPathComponent(n))
                if let i = state.pending.firstIndex(where: { $0.id == n }) {
                    state.pending[i].applied = true
                    state.pending[i].failed = true
                    state.pending[i].dttg = true
                }
            }
            if !orphans.isEmpty { saveState() }
        }
        var items: [[String: Any]] = []
        var files: [(from: URL, name: String)] = []
        func attach(_ o: [String: Any], into it: inout [String: Any]) {
            guard let rel = o["attachment"] as? String else { return }
            let name = (rel as NSString).lastPathComponent
            files.append((base.appendingPathComponent(rel), name))
            it["file"] = "Anhänge/" + name
        }
        for n in names {
            guard let data = try? Data(contentsOf: q.appendingPathComponent(n)),
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let op = o["op"] as? String else { continue }
            var it: [String: Any] = ["id": n, "op": op]
            let parent = res(o["parent"]) ?? rootId
            let uuid = res(o["uuid"])
            if orphan(parent, uuid, res(o["to"])) { orphans.append(n); continue }
            switch op {
            case "create-note":
                var into = parent
                if o["bundle"] as? Bool == true, let g = o["tempGroup"] as? String {
                    // Eintrags-Ordner zuerst; der Eintrag folgt, sobald der Ordner seine Kennung hat
                    guard let real = al[g] else {
                        guard known(parent) else { return (items, files) }
                        items.append(["id": n + "#G", "op": "create-group", "parent": parent, "name": o["name"] as? String ?? "Unbenannt"])
                        return (items, files)
                    }
                    into = real
                }
                guard known(into) else { return (items, files) }
                it["parent"] = into
                it["name"] = o["name"] as? String ?? "Unbenannt"
                it["markdown"] = o["markdown"] as? String ?? ""
            case "create-group":
                guard known(parent) else { return (items, files) }
                it["parent"] = parent
                it["name"] = o["name"] as? String ?? "Neuer Ordner"
            case "create-file":
                guard known(parent) else { return (items, files) }
                it["parent"] = parent
                it["name"] = o["name"] as? String ?? "Datei"
                attach(o, into: &it)
            case "write":
                guard let uuid, known(uuid) else { return (items, files) }
                it["uuid"] = uuid
                if let md = o["markdown"] as? String {
                    it["markdown"] = md
                    if let name = o["name"] as? String, !name.isEmpty { it["name"] = name }
                } else {
                    it["op"] = "write-file"
                    attach(o, into: &it)
                }
            case "rename":
                guard let uuid, known(uuid) else { return (items, files) }
                it["uuid"] = uuid
                it["name"] = o["name"] as? String ?? ""
            case "move":
                let to = res(o["to"]) ?? rootId
                guard let uuid, known(uuid), known(to) else { return (items, files) }
                it["uuid"] = uuid
                it["to"] = to
            case "trash":
                guard let uuid, known(uuid) else { return (items, files) }
                it["uuid"] = uuid
            default:
                continue
            }
            items.append(it)
        }
        return (items, files)
    }

    /// Rückmeldung des Kurzbefehls eintragen: je Auftrag die Kennung in DEVONthink
    /// (oder „FEHLER …“). progress: Es wurde etwas erledigt (dann lohnt die nächste Runde)
    func dttgApply(_ results: [(id: String, value: String)]) -> (progress: Bool, failures: [String]) {
        lock.lock(); defer { lock.unlock() }
        let base = DTTGSync.queueRoot
        var progress = false
        var failures: [String] = []
        var aliases = state.aliases ?? [:]
        func removeOrder(_ id: String) {
            let url = base.appendingPathComponent("Aufträge/\(id)")
            if let data = try? Data(contentsOf: url),
               let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let rel = o["attachment"] as? String { try? fm.removeItem(at: base.appendingPathComponent(rel)) }
            try? fm.removeItem(at: url)
        }
        for (id, raw) in results {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let isGroup = id.hasSuffix("#G")
            let oid = isGroup ? String(id.dropLast(2)) : id
            guard let i = state.pending.firstIndex(where: { $0.id == oid }) else {
                if !isGroup { removeOrder(oid); progress = true }
                continue
            }
            let p = state.pending[i]
            if value.uppercased().hasPrefix("FEHLER") || value.isEmpty {
                let msg = value.isEmpty ? "keine Kennung zurückgemeldet" : String(value.dropFirst(6)).trimmingCharacters(in: CharacterSet(charactersIn: ": ").union(.whitespaces))
                state.pending[i].applied = true
                state.pending[i].failed = true
                state.pending[i].dttg = true
                state.pending[i].base = p.uuid.flatMap { files[aliasMap[$0] ?? $0]?["hash"] as? String }
                failures.append("\(p.name.map { "„\($0)“" } ?? "Eine Änderung"): \(msg.isEmpty ? "unbekannter Fehler" : msg)")
                removeOrder(oid)
                continue
            }
            let uuid = Self.dtUUID(value)
            if isGroup {
                if let g = p.tempGroup { aliases[g] = uuid; progress = true }
                continue
            }
            if p.op.hasPrefix("create"), let tmp = p.uuid { aliases[tmp] = uuid }
            state.pending[i].applied = true
            state.pending[i].dttg = true
            removeOrder(oid)
            progress = true
        }
        state.aliases = aliases
        saveState()
        return (progress, failures)
    }

    /// „x-devonthink-item://UUID?…“ oder die UUID selbst → UUID
    static func dtUUID(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = t.range(of: "x-devonthink-item://") { t = String(t[r.upperBound...]) }
        if let q = t.firstIndex(where: { $0 == "?" || $0 == "/" }) { t = String(t[..<q]) }
        return t
    }

    // MARK: - Eigener Zustand (App-Speicher)

    private var localDir: URL {
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Heft", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private var stateURL: URL { localDir.appendingPathComponent("zustand.json") }

    private func loadState() {
        lock.lock(); defer { lock.unlock() }
        if let data = try? Data(contentsOf: stateURL), let s = try? JSONDecoder().decode(PadState.self, from: data) { state = s }
        removeStrayCopies()
    }

    private func saveState() {
        if let data = try? JSONEncoder().encode(state) { try? data.write(to: stateURL, options: .atomic) }
    }

    private func deleteLocal(_ name: String?) {
        guard let name, !name.isEmpty else { return }
        try? fm.removeItem(at: localDir.appendingPathComponent(name))
    }

    /// Frühere Fassungen haben jede Sicherung eines Bildes oder Arbeitsblatts als
    /// eigene Kopie im App-Speicher behalten – alles, was kein offener Auftrag mehr
    /// braucht, kommt weg
    private func removeStrayCopies() {
        let used = Set(state.pending.compactMap(\.localFile))
        for f in (try? fm.contentsOfDirectory(at: localDir, includingPropertiesForKeys: nil)) ?? []
        where f.lastPathComponent.hasPrefix("NEU-") && !used.contains(f.lastPathComponent) {
            try? fm.removeItem(at: f)
        }
    }

    // MARK: - Hilfen

    private func newId() -> String { "NEU-" + UUID().uuidString }
    private func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }
    private func isoString(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
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

/// Meldet Änderungen an Heft.json, sobald iCloud sie auf das iPad bringt
final class ManifestPresenter: NSObject, NSFilePresenter {
    let presentedItemURL: URL?
    let presentedItemOperationQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private let onChange: () -> Void

    init(url: URL, onChange: @escaping () -> Void) {
        presentedItemURL = url
        self.onChange = onChange
        super.init()
        NSFileCoordinator.addFilePresenter(self)
    }

    func presentedItemDidChange() { onChange() }
    func presentedItemDidGain(_ version: NSFileVersion) { onChange() }

    func stop() { NSFileCoordinator.removeFilePresenter(self) }
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
