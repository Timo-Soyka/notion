import AppKit

// Anbindung an DEVONthink.
//
// Alle Zugriffe laufen über `osascript` (JavaScript for Automation) in einem
// eigenen Prozess auf einer seriellen Warteschlange. Dadurch friert die
// Oberfläche nie ein, auch wenn DEVONthink gerade synchronisiert und langsam
// antwortet. Dateien in der Datenbank werden nie direkt verändert – nur über
// DEVONthinks eigene Befehle, sonst droht Datenverlust.

enum DTError: LocalizedError {
    case notRunning
    case permission
    case script(String)

    var errorDescription: String? {
        switch self {
        case .notRunning: return "DEVONthink läuft nicht."
        case .permission: return "Heft darf DEVONthink noch nicht steuern. Bitte in den Systemeinstellungen unter Datenschutz & Sicherheit → Automation erlauben."
        case .script(let m): return m
        }
    }
}

final class DEVONthink {
    static let shared = DEVONthink()
    static let bundleID = "com.devon-technologies.think"

    private let queue = DispatchQueue(label: "heft.devonthink", qos: .userInitiated)
    private var pathCache: [String: String] = [:]
    private let cacheLock = NSLock()

    var isRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).isEmpty
    }

    // DEVONthink im Hintergrund starten und warten, bis es Befehle annimmt
    func launchIfNeeded() throws {
        if isRunning { return }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) else {
            throw DTError.script("DEVONthink ist nicht installiert.")
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        cfg.hides = true
        let sem = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in sem.signal() }
        _ = sem.wait(timeout: .now() + 20)
        for _ in 0..<40 {
            if (try? runJXA(Scripts.ping, []))?.contains("true") == true { return }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    // MARK: - Ausführen

    /// Führt ein JXA-Skript aus. Das Skript definiert `main(argv)`; das Ergebnis
    /// kommt als JSON zurück.
    @discardableResult
    func run(_ body: String, _ args: [String] = [], launch: Bool = true, timeout: TimeInterval = 60) throws -> Any {
        if !isRunning {
            if launch { try launchIfNeeded() } else { throw DTError.notRunning }
        }
        let out = try runJXA(Scripts.prelude + body + Scripts.epilogue, args, timeout: timeout)
        guard let data = out.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any] else {
            throw DTError.script("Unerwartete Antwort von DEVONthink: \(out.prefix(200))")
        }
        if let ok = obj["ok"] as? Bool, ok { return obj["result"] ?? NSNull() }
        throw DTError.script((obj["error"] as? String) ?? "Unbekannter Fehler in DEVONthink")
    }

    func runAsync(_ body: String, _ args: [String] = [], completion: @escaping (Result<Any, Error>) -> Void) {
        queue.async {
            do { completion(.success(try self.run(body, args))) }
            catch { completion(.failure(error)) }
        }
    }

    /// Serialisiert beliebige Arbeit hinter die DEVONthink-Warteschlange.
    func async<T>(_ work: @escaping () throws -> T, completion: @escaping (Result<T, Error>) -> Void) {
        queue.async {
            do { completion(.success(try work())) }
            catch { completion(.failure(error)) }
        }
    }

    private func runJXA(_ source: String, _ args: [String], timeout: TimeInterval = 60) throws -> String {
        try runOSA(source, args, language: "JavaScript", timeout: timeout)
    }

    func runAppleScript(_ source: String, _ args: [String], timeout: TimeInterval = 120) throws -> String {
        try runOSA(source, args, language: "AppleScript", timeout: timeout)
    }

    private func runOSA(_ source: String, _ args: [String], language: String, timeout: TimeInterval) throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("heft-scripts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(UUID().uuidString + (language == "JavaScript" ? ".js" : ".applescript"))
        try source.write(to: file, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: file) }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-l", language, file.path] + args
        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async { outData = outPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        group.enter()
        DispatchQueue.global().async { errData = errPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        try p.run()
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        if p.isRunning {
            p.terminate()
            throw DTError.script("DEVONthink antwortet nicht (Zeitüberschreitung).")
        }
        group.wait()
        let out = String(data: outData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if p.terminationStatus != 0 {
            let err = String(data: errData, encoding: .utf8) ?? ""
            if err.contains("-1743") || err.contains("Nicht berechtigt") || err.contains("Not authorized") { throw DTError.permission }
            if err.contains("-600") || err.contains("-609") { throw DTError.notRunning }
            throw DTError.script(Self.cleanError(err))
        }
        return out
    }

    private static func cleanError(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = t.range(of: "execution error: ") { t = String(t[r.upperBound...]) }
        if let r = t.range(of: "Error: ", options: .backwards) { t = String(t[r.upperBound...]) }
        return t.isEmpty ? "Fehler in DEVONthink" : t
    }

    // MARK: - Pfade (für Bilder/PDFs im WebView)

    func path(for uuid: String) throws -> String {
        cacheLock.lock()
        if let p = pathCache[uuid], FileManager.default.fileExists(atPath: p) { cacheLock.unlock(); return p }
        cacheLock.unlock()
        // DEVONthink benennt Dateien nach dem Umbenennen verzögert um – kurz
        // warten und neu fragen, falls der gemeldete Pfad (noch) nicht existiert
        for attempt in 0..<4 {
            let res = try run(Scripts.info, [uuid]) as? [String: Any]
            guard let p = res?["path"] as? String, !p.isEmpty else { throw DTError.script("Datei nicht gefunden") }
            if FileManager.default.fileExists(atPath: p) {
                cacheLock.lock(); pathCache[uuid] = p; cacheLock.unlock()
                return p
            }
            Thread.sleep(forTimeInterval: 0.25 * Double(attempt + 1))
        }
        throw DTError.script("Datei ist gerade nicht erreichbar")
    }

    func forgetPath(_ uuid: String) {
        cacheLock.lock(); pathCache[uuid] = nil; cacheLock.unlock()
    }

    // MARK: - Daten einer Datei ersetzen (PDF nach Bearbeitung)

    func replaceData(uuid: String, with file: URL) throws {
        let script = """
        on run argv
            set u to item 1 of argv
            set f to item 2 of argv
            set d to read (POSIX file f) as data
            tell application id "com.devon-technologies.think"
                set r to get record with uuid u
                if r is missing value then error "Datei nicht gefunden"
                set data of r to d
            end tell
            return "ok"
        end run
        """
        if !isRunning { try launchIfNeeded() }
        _ = try runAppleScript(script, [uuid, file.path])
        forgetPath(uuid)
    }
}

// MARK: - JXA-Skripte

enum Scripts {
    static let prelude = #"""
    ObjC.import('Foundation');
    const dt = Application('com.devon-technologies.think');
    function readFile(p) { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? '' : s.js; }
    function rec(u) {
      const r = dt.getRecordWithUuid(u);
      try { r.uuid(); } catch (e) { throw new Error('Datensatz nicht gefunden (' + u + ')'); }
      return r;
    }
    function db(u) {
      const d = dt.getDatabaseWithUuid(u);
      try { d.uuid(); } catch (e) { throw new Error('Datenbank ist nicht geöffnet'); }
      return d;
    }
    function kindOf(t, name) {
      t = String(t || '');
      if (t === 'markdown') return 'note';
      if (t === 'PDF document') return 'pdf';
      if (t === 'picture') return 'image';
      if (t === 'group') return 'group';
      return 'file';
    }
    function iso(d) { try { return d ? d.toISOString() : null; } catch (e) { return null; } }
    function isBundle(g) {
      // Eintrags-Ordner: enthält ein Markdown-Dokument mit gleichem Namen
      const kids = g.children;
      const names = kids.name(), types = kids.recordType();
      for (let i = 0; i < names.length; i++) if (types[i] === 'markdown' && names[i] === g.name()) return true;
      return false;
    }
    function noteInBundle(g) {
      const kids = g.children;
      const names = kids.name(), types = kids.recordType(), uuids = kids.uuid();
      for (let i = 0; i < names.length; i++) if (types[i] === 'markdown' && names[i] === g.name()) return rec(uuids[i]);
      return null;
    }
    // Stellt sicher, dass ein Eintrag in einem eigenen Ordner liegt, und gibt den Ordner zurück
    function ensureBundle(md) {
      const g = md.locationGroup();
      if (g.name() === md.name() && g.recordType() === 'group') return g;
      const bundle = dt.createRecordWith({ name: md.name(), type: 'group' }, { in: g });
      dt.move({ record: md, to: bundle });
      return bundle;
    }
    """#

    static let epilogue = #"""

    function run(argv) {
      try { return JSON.stringify({ ok: true, result: main(argv) }); }
      catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
    }
    """#

    static let ping = prelude + #"""
    function run(argv) { try { dt.databases.uuid(); return 'true'; } catch (e) { return 'false'; } }
    """#

    static let status = #"""
    function main(argv) {
      const dbs = dt.databases;
      const u = dbs.uuid(), n = dbs.name(), p = dbs.path();
      const out = [];
      for (let i = 0; i < u.length; i++) out.push({ uuid: u[i], name: n[i], path: p[i] });
      return { running: true, databases: out };
    }
    """#

    // Gruppenbaum einer Datenbank (für die Ordnerauswahl)
    static let groups = #"""
    function main(argv) {
      const d = db(argv[0]);
      const rootU = d.root().uuid();
      const skip = new Set([d.trashGroup().uuid(), d.tagsGroup().uuid()]);
      try { skip.add(d.versionsGroup().uuid()); } catch (e) {}
      const P = d.parents;
      const pu = P.uuid(), pn = P.name(), pt = P.recordType();
      let pp;
      try { pp = P.locationGroup.uuid(); } catch (e) { pp = pu.map(x => { try { return dt.getRecordWithUuid(x).locationGroup().uuid(); } catch (e2) { return rootU; } }); }
      const byParent = {};
      for (let i = 0; i < pu.length; i++) {
        if (pt[i] !== 'group' || skip.has(pu[i])) continue;
        (byParent[pp[i]] = byParent[pp[i]] || []).push({ uuid: pu[i], name: pn[i] });
      }
      const build = (u, depth) => (byParent[u] || []).filter(g => !skip.has(g.uuid)).map(g => ({ uuid: g.uuid, name: g.name, children: depth < 12 ? build(g.uuid, depth + 1) : [] }));
      return [{ uuid: rootU, name: d.name(), children: build(rootU, 0) }];
    }
    """#

    // Der komplette Baum unterhalb des gewählten Ordners, in wenigen Sammelabfragen
    static let tree = #"""
    function main(argv) {
      const d = db(argv[0]);
      const rootU = argv[1] || d.root().uuid();
      const root = rec(rootU);
      const skip = new Set([d.trashGroup().uuid(), d.tagsGroup().uuid()]);
      try { skip.add(d.versionsGroup().uuid()); } catch (e) {}
      const P = d.parents, C = d.contents;
      const pu = P.uuid(), pn = P.name(), pt = P.recordType();
      let pp; try { pp = P.locationGroup.uuid(); } catch (e) { pp = pu.map(x => { try { return dt.getRecordWithUuid(x).locationGroup().uuid(); } catch (e2) { return null; } }); }
      let pm; try { pm = P.modificationDate(); } catch (e) { pm = []; }
      const cu = C.uuid(), cn = C.name(), ct = C.recordType();
      let cf; try { cf = C.filename(); } catch (e) { cf = []; }
      let cp; try { cp = C.locationGroup.uuid(); } catch (e) { cp = cu.map(x => { try { return dt.getRecordWithUuid(x).locationGroup().uuid(); } catch (e2) { return null; } }); }
      let cm; try { cm = C.modificationDate(); } catch (e) { cm = []; }
      const kids = {};
      const add = (parent, node) => { (kids[parent] = kids[parent] || []).push(node); };
      for (let i = 0; i < pu.length; i++) {
        if (pt[i] !== 'group' || skip.has(pu[i])) continue;
        add(pp[i], { uuid: pu[i], name: pn[i], kind: 'group', modified: iso(pm[i]) });
      }
      for (let i = 0; i < cu.length; i++) {
        const ext = ((/\.([A-Za-z0-9]{1,6})$/.exec(cf[i] || '') || [])[1] || '').toLowerCase();
        add(cp[i], { uuid: cu[i], name: cn[i], kind: kindOf(ct[i]), type: ct[i], ext, modified: iso(cm[i]) });
      }
      const build = (u, depth) => {
        const list = (kids[u] || []).slice();
        for (const n of list) {
          if (n.kind !== 'group') continue;
          n.children = depth < 20 ? build(n.uuid, depth + 1) : [];
          // Eintrags-Ordner erkennen: Ordner mit gleichnamigem Markdown-Dokument
          const md = n.children.find(c => c.kind === 'note' && c.name === n.name);
          if (md) {
            n.kind = 'bundle';
            n.note = md.uuid;
            n.modified = md.modified || n.modified;
            n.children = n.children.filter(c => c !== md);
            n.hasPdf = n.children.some(c => c.kind === 'pdf' && c.name === n.name);
          }
        }
        return list;
      };
      return { root: { uuid: rootU, name: root.name() }, nodes: build(rootU, 0) };
    }
    """#

    // Pfade und Änderungsdaten mehrerer Datensätze auf einmal (für den iPad-Abgleich)
    static let paths = #"""
    function main(argv) {
      const ids = JSON.parse(argv[0] || '[]');
      const out = {};
      for (const u of ids) {
        try {
          const r = dt.getRecordWithUuid(u);
          let path = ''; try { path = r.path() || ''; } catch (e) {}
          out[u] = { path, modified: iso(r.modificationDate()) };
        } catch (e) {}
      }
      return out;
    }
    """#

    static let info = #"""
    function main(argv) {
      const r = rec(argv[0]);
      let path = ''; try { path = r.path() || ''; } catch (e) {}
      const g = r.locationGroup();
      return { uuid: r.uuid(), name: r.name(), type: r.recordType(), kind: kindOf(r.recordType()), path, filename: r.filename(),
               modified: iso(r.modificationDate()), group: g.uuid(), groupName: g.name(), database: r.database().uuid(),
               pages: (function () { try { return r.pageCount(); } catch (e) { return 0; } })() };
    }
    """#

    // Text immer über DEVONthink lesen: Die Datei im Paket kann kurz nach
    // einem Umbenennen noch unter altem Namen gemeldet werden.
    static let read = #"""
    function main(argv) {
      const r = rec(argv[0]);
      let path = ''; try { path = r.path() || ''; } catch (e) {}
      let text = null;
      try { text = r.plainText(); } catch (e) { text = null; }
      const g = r.locationGroup();
      return { uuid: r.uuid(), name: r.name(), type: r.recordType(), path, text, modified: iso(r.modificationDate()),
               group: g.uuid(), bundle: g.name() === r.name() && g.recordType() === 'group' };
    }
    """#

    // Speichern: Text setzen, bei Bedarf umbenennen (samt Eintrags-Ordner), Schlagwörter pflegen
    static let write = #"""
    function main(argv) {
      const [uuid, file, name, tagsJSON] = argv;
      const r = rec(uuid);
      const text = readFile(file);
      r.plainText = text;
      let treeChanged = false;
      const verify = () => {
        // Prüfen, ob DEVONthink den Text wirklich übernommen hat
        let back = null; try { back = r.plainText(); } catch (e) {}
        if (back !== text) { delay(0.3); r.plainText = text; try { back = r.plainText(); } catch (e) {} }
        if (back !== text) throw new Error('DEVONthink hat den Text nicht übernommen – deine Fassung liegt als Sicherung in ~/Library/Application Support/Heft/Sicherungen.');
      };
      if (name && r.name() !== name) {
        const g = r.locationGroup();
        const oldName = r.name();
        const wasBundle = g.name() === oldName && g.recordType() === 'group';
        r.name = name;
        if (wasBundle) {
          g.name = name;
          // Die PDF-Fassung heißt wie der Eintrag
          const kids = g.children, n = kids.name(), t = kids.recordType(), u = kids.uuid();
          for (let i = 0; i < n.length; i++) if (t[i] === 'PDF document' && n[i] === oldName) rec(u[i]).name = name;
        }
        treeChanged = true;
      }
      if (tagsJSON) {
        const wanted = JSON.parse(tagsJSON);
        let cmd = {}; try { cmd = r.customMetaData() || {}; } catch (e) {}
        const managed = String(cmd.mdhefttags || '').split('\n').filter(Boolean);
        const current = r.tags() || [];
        const keep = current.filter(t => !managed.includes(t));
        const merged = Array.from(new Set(keep.concat(wanted)));
        if (merged.join('\n') !== current.join('\n')) r.tags = merged;
        dt.addCustomMetaData(wanted.join('\n'), { for: 'hefttags', to: r });
      }
      try { if (!r.url()) r.url = 'heft://open?uuid=' + uuid; } catch (e) {}
      verify();
      return { modified: iso(r.modificationDate()), name: r.name(), treeChanged };
    }
    """#

    static let createNote = #"""
    function main(argv) {
      const [parent, name, file, bundle] = argv;
      let g = rec(parent);
      if (bundle === '1') g = dt.createRecordWith({ name, type: 'group' }, { in: g });
      const text = readFile(file);
      const r = dt.createRecordWith({ name, type: 'markdown', content: text }, { in: g });
      try { r.url = 'heft://open?uuid=' + r.uuid(); } catch (e) {}
      return { uuid: r.uuid(), group: g.uuid() };
    }
    """#

    static let createGroup = #"""
    function main(argv) {
      const [parent, name] = argv;
      const g = dt.createRecordWith({ name, type: 'group' }, { in: rec(parent) });
      return { uuid: g.uuid() };
    }
    """#

    static let rename = #"""
    function main(argv) {
      const [uuid, name] = argv;
      const r = rec(uuid);
      const old = r.name();
      if (r.recordType() === 'group') {
        const md = noteInBundle(r);
        r.name = name;
        if (md) {
          md.name = name;
          const kids = r.children, n = kids.name(), t = kids.recordType(), u = kids.uuid();
          for (let i = 0; i < n.length; i++) if (t[i] === 'PDF document' && n[i] === old) rec(u[i]).name = name;
        }
      } else {
        const g = r.locationGroup();
        const wasBundle = g.name() === old && g.recordType() === 'group' && r.recordType() === 'markdown';
        r.name = name;
        if (wasBundle) {
          // Ordner und PDF-Fassung heißen immer wie der Eintrag
          g.name = name;
          const kids = g.children, n = kids.name(), t = kids.recordType(), u = kids.uuid();
          for (let i = 0; i < n.length; i++) if (t[i] === 'PDF document' && n[i] === old) rec(u[i]).name = name;
        }
      }
      return { ok: true };
    }
    """#

    static let move = #"""
    function main(argv) {
      const [uuid, to] = argv;
      let r = rec(uuid);
      // Ein Eintrag in seinem eigenen Ordner wandert samt Ordner
      if (r.recordType() === 'markdown') {
        const g = r.locationGroup();
        if (g.name() === r.name() && g.recordType() === 'group') r = g;
      }
      if (r.uuid() === to) return { ok: false };
      dt.move({ record: r, to: rec(to) });
      return { ok: true };
    }
    """#

    static let trash = #"""
    function main(argv) {
      let r = rec(argv[0]);
      if (r.recordType() === 'markdown') {
        const g = r.locationGroup();
        if (g.name() === r.name() && g.recordType() === 'group') r = g;
      }
      dt.move({ record: r, to: r.database().trashGroup() });
      return { ok: true };
    }
    """#

    // Datei in den Eintrags-Ordner importieren (Bilder, PDFs)
    static let importAsset = #"""
    function main(argv) {
      const [note, file, name] = argv;
      const md = rec(note);
      const g = ensureBundle(md);
      const r = dt.importPath(file, { to: g });
      if (name) r.name = name;
      return { uuid: r.uuid(), name: r.name(), bundle: g.uuid() };
    }
    """#

    static let importInto = #"""
    function main(argv) {
      const [parent, file, name] = argv;
      const r = dt.importPath(file, { to: rec(parent) });
      if (name) r.name = name;
      return { uuid: r.uuid(), name: r.name(), kind: kindOf(r.recordType()) };
    }
    """#

    // PDF-Fassung neben den Eintrag legen bzw. aktualisieren
    static let companionTarget = #"""
    function main(argv) {
      const md = rec(argv[0]);
      const g = md.locationGroup();
      const isBundle = g.name() === md.name() && g.recordType() === 'group';
      if (!isBundle) return { bundle: false, pdf: null, name: md.name() };
      const kids = g.children, n = kids.name(), t = kids.recordType(), u = kids.uuid();
      for (let i = 0; i < n.length; i++) if (t[i] === 'PDF document' && n[i] === md.name()) return { bundle: true, pdf: u[i], group: g.uuid(), name: md.name() };
      return { bundle: true, pdf: null, group: g.uuid(), name: md.name() };
    }
    """#

    static let companionImport = #"""
    function main(argv) {
      const [note, file] = argv;
      const md = rec(note);
      const g = ensureBundle(md);
      const r = dt.importPath(file, { to: g });
      r.name = md.name();
      return { uuid: r.uuid(), group: g.uuid() };
    }
    """#

    static let search = #"""
    function main(argv) {
      const [query, scope] = argv;
      const opts = scope ? { in: rec(scope) } : {};
      const res = dt.search(query, opts) || [];
      const out = [];
      for (let i = 0; i < Math.min(res.length, 40); i++) {
        const r = res[i];
        try {
          const t = r.recordType();
          if (t === 'group' || t === 'smart group') continue;
          let name = r.name(), uuid = r.uuid(), loc = r.location();
          out.push({ uuid, name, kind: kindOf(t), location: loc.replace(/\/$/, '') });
        } catch (e) {}
      }
      return out;
    }
    """#

    // Zu Einträgen die PDF-Fassung finden (Eintrags-Ordner mit gleichnamiger PDF)
    static let companions = #"""
    function main(argv) {
      const out = {};
      for (const u of JSON.parse(argv[0])) {
        out[u] = null;
        try {
          const r = dt.getRecordWithUuid(u);
          if (!r || r.recordType() !== 'markdown') continue;
          const g = r.locationGroup();
          if (g.recordType() !== 'group' || g.name() !== r.name()) continue;
          const kids = g.children, n = kids.name(), t = kids.recordType(), id = kids.uuid();
          for (let i = 0; i < n.length; i++) if (t[i] === 'PDF document' && n[i] === r.name()) { out[u] = id[i]; break; }
        } catch (e) {}
      }
      return out;
    }
    """#

    // Tabellen (CSV/TSV) – DEVONthink schreibt die Datei selbst im richtigen Format
    // Lesezeichen und andere Datensätze ohne Datei
    static let recordURL = #"""
    function main(argv) { const r = rec(argv[0]); let u = ''; try { u = r.URL() || ''; } catch (e) {} return u; }
    """#

    static let sheetRead = #"""
    function main(argv) {
      const r = rec(argv[0]);
      let columns = [], cells = [];
      try { columns = r.columns() || []; } catch (e) {}
      try { cells = r.cells() || []; } catch (e) {}
      return { columns, cells, type: r.recordType() };
    }
    """#

    static let sheetWrite = #"""
    function main(argv) {
      const r = rec(argv[0]);
      if (r.recordType() !== 'sheet') throw new Error('Keine Tabelle');
      r.cells = JSON.parse(readFile(argv[1]));
      return { ok: true };
    }
    """#

    static let setPlainText = #"""
    function main(argv) {
      const r = rec(argv[0]);
      r.plainText = readFile(argv[1]);
      return { ok: true };
    }
    """#

    static let lookupPath = #"""
    function main(argv) {
      const res = dt.lookupRecordsWithPath(argv[0]) || [];
      return res.length ? { uuid: res[0].uuid(), kind: kindOf(res[0].recordType()) } : null;
    }
    """#
}
