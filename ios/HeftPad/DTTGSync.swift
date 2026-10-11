import UIKit

// Abgleich ohne Mac über DEVONthink To Go.
//
// Heft sammelt seine Änderungen als Aufträge im App-Speicher (statt in iCloud
// für den Mac) und übergibt sie dem Kurzbefehl „Heft-Abgleich“. Der trägt sie
// mit den Kurzbefehl-Aktionen von DEVONthink To Go ein; DTTG gleicht danach
// selbst mit DEVONthink am Mac ab. Heft am Mac sieht diese Aufträge nie, es
// entstehen also keine doppelten Einträge.
//
// Austausch über „Auf meinem iPad → Heft → DEVONthink“:
//   Abgleich.json  {"items": [{"id", "op", "uuid"/"parent"/"to", "name", "markdown", "file"}, …]}
//                  op: create-note, create-group, create-file, write, write-file, rename, move, trash
//   Anhänge/       Bilder und PDFs, auf die „file“ verweist
//   Ergebnis.txt   je erledigtem Auftrag eine Zeile „id<Tab>Kennung“ (UUID oder
//                  x-devonthink-item-Link) oder „id<Tab>FEHLER …“
// Am Ende springt der Kurzbefehl per heftpad://dttg/fertig zurück (x-callback).
// Aufträge, die auf etwas Neues verweisen, kommen in der nächsten Runde dran,
// sobald dessen Kennung zurück ist; Heft startet sie selbst.

enum DTTGSync {
    static let shortcutName = "Heft-Abgleich"
    static let doneNotification = Notification.Name("HeftDTTGDone")
    private static let enabledKey = "dttgSync"

    static var enabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }

    /// Aufträge, bis der Kurzbefehl sie abholt (nur für Heft)
    static var queueRoot: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Heft/DEVONthink To Go", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("Aufträge/Anhänge", isDirectory: true), withIntermediateDirectories: true)
        return dir
    }

    /// Austauschordner – in der Dateien-App unter „Auf meinem iPad → Heft → DEVONthink“
    static var exchangeDir: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DEVONthink", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Austauschordner anlegen, damit „Heft → DEVONthink“ in der Dateien-App erscheint
    /// (die Dateien-App zeigt den Ordner der App erst, wenn darin etwas liegt) –
    /// so lässt er sich im Kurzbefehl auswählen, bevor der erste Abgleich läuft
    static func prepare() {
        let note = exchangeDir.appendingPathComponent("Liesmich.txt")
        guard !FileManager.default.fileExists(atPath: note.path) else { return }
        let text = "Austauschordner zwischen Heft und dem Kurzbefehl „\(shortcutName)“.\nIm Kurzbefehl bei „Datei abrufen“ und „An Textdatei anhängen“ diesen Ordner wählen.\n"
        try? Data(text.utf8).write(to: note, options: .atomic)
    }

    private static var orderDir: URL { queueRoot.appendingPathComponent("Aufträge", isDirectory: true) }

    static func isQueued(_ id: String) -> Bool {
        FileManager.default.fileExists(atPath: orderDir.appendingPathComponent(id).path)
    }

    static var queuedCount: Int {
        ((try? FileManager.default.contentsOfDirectory(atPath: orderDir.path)) ?? []).filter { $0.hasSuffix(".json") }.count
    }

    /// Umschalten. Beim Zurückschalten auf den Mac wandern noch offene Aufträge
    /// (samt Anhängen) nach iCloud – dort trägt Heft am Mac sie ein.
    static func setEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: enabledKey)
        guard !on, let root = MirrorStore.shared.root else { return }
        let fm = FileManager.default
        let target = root.appendingPathComponent("Aufträge", isDirectory: true)
        try? fm.createDirectory(at: target.appendingPathComponent("Anhänge", isDirectory: true), withIntermediateDirectories: true)
        for sub in ["Anhänge/", ""] {
            let from = orderDir.appendingPathComponent(sub, isDirectory: true)
            for name in (try? fm.contentsOfDirectory(atPath: from.path)) ?? [] where name != "Anhänge" {
                let dest = target.appendingPathComponent(sub + name)
                var e: NSError?
                NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: dest, options: .forReplacing, error: &e) { u in
                    try? fm.removeItem(at: u)
                    try? fm.moveItem(at: from.appendingPathComponent(name), to: u)
                }
            }
        }
    }

    // MARK: - Ablauf

    private static var startedAt: Date?
    private static var rounds = 0

    /// Kurzbefehl starten (Hauptthread). false: nichts zu tun, ausgeschaltet oder läuft schon
    @discardableResult
    static func start(nextRound: Bool = false) -> Bool {
        guard enabled else { return false }
        if let t = startedAt, Date().timeIntervalSince(t) < 60 { return false }
        rounds = nextRound ? rounds + 1 : 0
        let batch = MirrorStore.shared.dttgBatch()
        guard !batch.items.isEmpty else { return false }

        let fm = FileManager.default
        let dir = exchangeDir
        let att = dir.appendingPathComponent("Anhänge", isDirectory: true)
        try? fm.removeItem(at: att)
        try? fm.removeItem(at: dir.appendingPathComponent("Ergebnis.txt"))
        do {
            if !batch.files.isEmpty { try fm.createDirectory(at: att, withIntermediateDirectories: true) }
            for f in batch.files { try fm.copyItem(at: f.from, to: att.appendingPathComponent(f.name)) }
            let data = try JSONSerialization.data(withJSONObject: ["items": batch.items], options: [.prettyPrinted, .sortedKeys])
            try data.write(to: dir.appendingPathComponent("Abgleich.json"), options: .atomic)
        } catch {
            finish(messages: ["Abgleich konnte nicht vorbereitet werden: \(error.localizedDescription)"])
            return false
        }

        var c = URLComponents()
        c.scheme = "shortcuts"
        c.host = "x-callback-url"
        c.path = "/run-shortcut"
        c.queryItems = [
            URLQueryItem(name: "name", value: shortcutName),
            URLQueryItem(name: "x-success", value: "heftpad://dttg/fertig"),
            URLQueryItem(name: "x-error", value: "heftpad://dttg/fehler"),
            URLQueryItem(name: "x-cancel", value: "heftpad://dttg/abbruch"),
        ]
        guard let url = c.url else { return false }
        startedAt = Date()
        UIApplication.shared.open(url) { ok in
            guard !ok else { return }
            startedAt = nil
            finish(messages: ["Kurzbefehle lässt sich nicht öffnen."])
        }
        return true
    }

    /// Rücksprung vom Kurzbefehl (heftpad://dttg/fertig|fehler|abbruch)
    @discardableResult
    static func handle(_ url: URL) -> Bool {
        guard url.scheme == "heftpad", url.host == "dttg" else { return false }
        startedAt = nil
        let fm = FileManager.default
        let resultURL = exchangeDir.appendingPathComponent("Ergebnis.txt")
        let text = (try? String(contentsOf: resultURL, encoding: .utf8)) ?? ""
        let results: [(id: String, value: String)] = text.split(whereSeparator: \.isNewline).compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
            guard parts.count == 2, !parts[0].isEmpty else { return nil }
            return (parts[0].trimmingCharacters(in: .whitespaces), parts[1])
        }
        try? fm.removeItem(at: resultURL)
        try? fm.removeItem(at: exchangeDir.appendingPathComponent("Abgleich.json"))
        try? fm.removeItem(at: exchangeDir.appendingPathComponent("Anhänge"))

        let r = MirrorStore.shared.dttgApply(results)
        var messages = r.failures
        switch url.path {
        case "/fehler":
            let why = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "errorMessage" }?.value
            messages.append("Kurzbefehl „\(shortcutName)“ ist mit einem Fehler beendet" + (why.map { ": \($0)" } ?? "."))
        case "/abbruch":
            messages.append("Abgleich mit DEVONthink To Go abgebrochen.")
        default:
            break
        }
        finish(messages: messages, done: results.count)
        // Weitere Runde, wenn neu Angelegtes jetzt seine Kennung hat (höchstens fünf am Stück)
        if url.path == "/fertig", r.progress, rounds < 4 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { start(nextRound: true) }
        }
        return true
    }

    private static func finish(messages: [String], done: Int = 0) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: doneNotification, object: nil, userInfo: ["messages": messages, "done": done])
        }
    }
}
