import Foundation

// Einstellungen und Sicherheitskopien.
//
// Einstellungen liegen als JSON in ~/Library/Application Support/Heft.
// Zusätzlich wird jeder gespeicherte Eintrag dort als Kopie abgelegt, bevor er
// an DEVONthink geht – falls DEVONthink einmal hängt oder abstürzt, geht so
// nichts verloren.

final class Store {
    static let shared = Store()

    let supportDir: URL
    private let settingsURL: URL
    let backupDir: URL
    private(set) var settings: [String: Any] = [:]
    private let lock = NSLock()

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        supportDir = base.appendingPathComponent("Heft", isDirectory: true)
        backupDir = supportDir.appendingPathComponent("Sicherungen", isDirectory: true)
        settingsURL = supportDir.appendingPathComponent("settings.json")
        try? FileManager.default.createDirectory(at: backupDir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: settingsURL),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            settings = obj
        }
    }

    func get() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return settings
    }

    func merge(_ patch: [String: Any]) -> [String: Any] {
        lock.lock()
        for (k, v) in patch {
            if v is NSNull { settings.removeValue(forKey: k) } else { settings[k] = v }
        }
        let snapshot = settings
        lock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: settingsURL, options: .atomic)
        }
        return snapshot
    }

    func string(_ key: String) -> String? { get()[key] as? String }

    var pdfSettings: [String: Any] { (get()["pdf"] as? [String: Any]) ?? [:] }

    // Letzte 5 Fassungen je Eintrag aufheben
    func backup(uuid: String, markdown: String) {
        let dir = backupDir.appendingPathComponent(uuid, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try? markdown.write(to: dir.appendingPathComponent("\(stamp).md"), atomically: true, encoding: .utf8)
        if let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            let sorted = files.sorted { $0.lastPathComponent > $1.lastPathComponent }
            for f in sorted.dropFirst(5) { try? FileManager.default.removeItem(at: f) }
        }
    }

    func tempFile(_ name: String) -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("heft", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(UUID().uuidString + "-" + name)
    }
}
