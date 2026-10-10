import Foundation
import FileProvider
import UIKit
import UniformTypeIdentifiers

// Prüfung für den Abgleich ohne Mac: Was sieht Heft von DEVONthink To Go über
// die Dateien-App? Man wählt eine Datenbank (oder eine Gruppe darin); Heft
// liest die Ordnerstruktur, sucht nach DEVONthink-Kennungen, schreibt eine
// Probedatei, liest sie zurück, ändert sie und löscht sie wieder. Der Bericht
// enthält keine Inhalte von Einträgen, nur Namen, Größen und Kennungen.

enum DTTGProbe {
    /// Gewählt wurde eine einzelne Datei (DEVONthink To Go lässt Ordner nicht wählen):
    /// Kennungen, Lesen, Zugriff auf den Ordner daneben und – nur bei „Heft-Test…“ –
    /// eine angehängte Zeile und ein Lesezeichen für die nächste Prüfung
    static func run(file: URL) -> String {
        var out: [String] = []
        let fm = FileManager.default
        func ms(_ since: Date) -> String { String(format: "%.0f ms", Date().timeIntervalSince(since) * 1000) }
        let scoped = file.startAccessingSecurityScopedResource()
        defer { if scoped { file.stopAccessingSecurityScopedResource() } }
        out.append("Heft \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?") · iPadOS \(UIDevice.current.systemVersion)")
        out.append("Datei: \(file.lastPathComponent) · Zugriff: \(scoped ? "ja" : "nein")")
        out.append("Pfad: \(file.path)")
        out.append(contentsOf: describe(file, label: "Datei"))
        out.append("")
        out.append(contentsOf: checkBookmark())

        let tRead = Date()
        let text = read(file)
        out.append("")
        out.append("— Lesen: " + (text.map { "\($0.count) Zeichen in \(ms(tRead))" } ?? "fehlgeschlagen"))
        if let text { out.append("Verweise x-devonthink-item: \(text.components(separatedBy: "x-devonthink-item://").count - 1)") }

        // Kommt Heft an den Ordner daneben (die Gruppe)?
        let dir = file.deletingLastPathComponent()
        out.append("")
        do {
            let kids = try fm.contentsOfDirectory(atPath: dir.path)
            out.append("— Gruppe daneben lesbar: ja (\(kids.count) Einträge)")
        } catch {
            out.append("— Gruppe daneben lesbar: nein (\(error.localizedDescription))")
        }
        out.append(contentsOf: describe(dir, label: "Gruppe " + dir.lastPathComponent))

        out.append("")
        if file.lastPathComponent.hasPrefix("Heft-Test"), let text {
            // Echte Änderung: eine Zeile anhängen, damit man in DEVONthink To Go
            // (und danach auf dem Mac) sieht, ob sie ankommt
            let line = "Heft " + DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .medium)
            let changed = text + (text.hasSuffix("\n") || text.isEmpty ? "" : "\n") + line + "\n"
            out.append("— Zeile angehängt („\(line)“): " + write(changed, to: file))
            out.append("Danach lesen: " + (read(file) == changed ? "neuer Inhalt" : "anders/fehlt"))
            out.append(contentsOf: describe(file, label: "Datei danach"))
            out.append("")
            out.append(contentsOf: keepBookmark(file))
        } else {
            out.append("— Schreiben übersprungen (nur bei Dateien, die mit „Heft-Test“ beginnen)")
        }
        return out.joined(separator: "\n")
    }

    static func run(folder: URL) -> String {
        var out: [String] = []
        let fm = FileManager.default
        let t0 = Date()
        func ms(_ since: Date) -> String { String(format: "%.0f ms", Date().timeIntervalSince(since) * 1000) }
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }

        out.append("Heft \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?") · iPadOS \(UIDevice.current.systemVersion)")
        out.append("Ordner: \(folder.lastPathComponent) · Zugriff: \(scoped ? "ja" : "nein")")
        out.append("Pfad: \(folder.path)")
        out.append(contentsOf: describe(folder, label: "Ordner selbst"))

        // 1. Ordnerstruktur lesen (höchstens 300 Einträge, 4 Ebenen)
        var items: [(url: URL, depth: Int)] = []
        var queue: [(URL, Int)] = [(folder, 0)]
        var readErrors: [String] = []
        let tList = Date()
        while let (dir, depth) = queue.first, items.count < 300 {
            queue.removeFirst()
            var kids: [URL] = []
            var e: NSError?
            NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: dir, options: [], error: &e) { u in
                do { kids = try fm.contentsOfDirectory(at: u, includingPropertiesForKeys: [.isDirectoryKey], options: []) }
                catch { readErrors.append("\(dir.lastPathComponent): \(error.localizedDescription)") }
            }
            if let e { readErrors.append("\(dir.lastPathComponent): \(e.localizedDescription)") }
            for k in kids.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                items.append((k, depth + 1))
                let isDir = (try? k.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                if isDir && depth < 3 { queue.append((k, depth + 1)) }
            }
        }
        out.append("")
        out.append("— Struktur: \(items.count) Einträge in \(ms(tList))")
        for e in readErrors.prefix(5) { out.append("Lesefehler: \(e)") }
        let dirs = items.filter { (try? $0.url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        let files = items.filter { (try? $0.url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true }
        var byExt: [String: Int] = [:]
        for f in files { byExt[f.url.pathExtension.lowercased(), default: 0] += 1 }
        out.append("Ordner: \(dirs.count) · Dateien: \(files.count) · Endungen: " + byExt.sorted { $0.value > $1.value }.map { "\($0.key.isEmpty ? "–" : $0.key) \($0.value)" }.joined(separator: ", "))
        for (u, d) in items.prefix(25) {
            let isDir = (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            out.append(String(repeating: "  ", count: d) + (isDir ? "▸ " : "· ") + u.lastPathComponent)
        }

        // 2. Kennungen: Was verrät eine Markdown-Datei über sich?
        let mds = files.map(\.url).filter { $0.pathExtension.lowercased() == "md" }
        out.append("")
        out.append("— Kennungen (\(min(mds.count, 3)) von \(mds.count) Markdown-Dateien)")
        for u in mds.prefix(3) { out.append(contentsOf: describe(u, label: u.lastPathComponent)) }
        if let d = dirs.first?.url { out.append(contentsOf: describe(d, label: "Ordner " + d.lastPathComponent)) }

        // 3. Inhalt lesen: Länge, Verweise (ohne Text)
        if let u = mds.first {
            let tRead = Date()
            var text: String?
            var e: NSError?
            NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: u, options: [], error: &e) { text = try? String(contentsOf: $0, encoding: .utf8) }
            out.append("")
            out.append("— Lesen „\(u.lastPathComponent)“: " + (text.map { "\($0.count) Zeichen in \(ms(tRead))" } ?? "fehlgeschlagen \(e?.localizedDescription ?? "")"))
            if let text {
                let links = text.components(separatedBy: "x-devonthink-item://").count - 1
                out.append("Verweise x-devonthink-item: \(links)")
            }
        }

        // 4. Schreiben: Probedatei anlegen, zurücklesen, ändern, löschen
        out.append("")
        out.append("— Schreiben")
        let stamp = Int(Date().timeIntervalSince1970)
        let probe = folder.appendingPathComponent("Heft-Probe-\(stamp).md")
        let first = "# Heft-Probe\n\nAngelegt von Heft auf dem iPad. Kann gelöscht werden.\n"
        let second = first + "\nGeändert.\n"
        out.append("Anlegen: " + write(first, to: probe))
        out.append("Zurücklesen: " + (read(probe) == first ? "gleich" : "anders/fehlt"))
        out.append(contentsOf: describe(probe, label: "Probedatei"))
        out.append("Ändern: " + write(second, to: probe))
        out.append("Zurücklesen: " + (read(probe) == second ? "gleich" : "anders/fehlt"))
        let siblings = (try? fm.contentsOfDirectory(atPath: folder.path)) ?? []
        let named = siblings.filter { $0.hasPrefix("Heft-Probe-\(stamp)") }
        out.append("Im Ordner sichtbar als: " + (named.isEmpty ? "nicht gefunden" : named.joined(separator: ", ")))
        var e: NSError?
        var delErr: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: probe, options: .forDeleting, error: &e) { u in
            do { try fm.removeItem(at: u) } catch { delErr = error }
        }
        out.append("Löschen: " + ((e ?? delErr).map { "Fehler \($0.localizedDescription)" } ?? "ok"))

        out.append("")
        out.append("Gesamt: \(ms(t0))")
        return out.joined(separator: "\n")
    }

    private static let bookmarkKey = "dttg.probe.bookmark"

    /// Merkt sich die Datei als Lesezeichen, damit die nächste Prüfung (auch nach
    /// Neustart der App) zeigt, ob Heft ohne erneute Auswahl wieder herankommt
    private static func keepBookmark(_ url: URL) -> [String] {
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(data, forKey: bookmarkKey)
            return ["— Lesezeichen gespeichert (\(data.count) Bytes)"]
        } catch {
            return ["— Lesezeichen: Fehler \(error.localizedDescription)"]
        }
    }

    /// Lesezeichen aus der vorigen Prüfung auflösen und ohne Auswahl lesen
    private static func checkBookmark() -> [String] {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return ["— Lesezeichen von vorher: keins"] }
        var stale = false
        do {
            let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let text = read(url)
            return ["— Lesezeichen von vorher: \(url.lastPathComponent) · veraltet: \(stale ? "ja" : "nein") · Zugriff: \(scoped ? "ja" : "nein")",
                    "Lesen ohne Auswahl: " + (text.map { "ok, \($0.count) Zeichen, letzte Zeile „\($0.split(separator: "\n").last ?? "")“" } ?? "fehlgeschlagen")]
        } catch {
            return ["— Lesezeichen von vorher: Fehler \(error.localizedDescription)"]
        }
    }

    private static func write(_ text: String, to url: URL) -> String {
        let t = Date()
        var e: NSError?
        var inner: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forReplacing, error: &e) { u in
            do { try Data(text.utf8).write(to: u, options: .atomic) } catch { inner = error }
        }
        if let x = e ?? inner { return "Fehler \(x.localizedDescription)" }
        return String(format: "ok (%.0f ms)", Date().timeIntervalSince(t) * 1000)
    }

    private static func read(_ url: URL) -> String? {
        var text: String?
        var e: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &e) { text = try? String(contentsOf: $0, encoding: .utf8) }
        return text
    }

    /// Alles, was das System über eine Datei an Kennungen herausgibt
    private static func describe(_ url: URL, label: String) -> [String] {
        var out = ["[\(label)]"]
        let keys: Set<URLResourceKey> = [.fileResourceIdentifierKey, .documentIdentifierKey, .fileContentIdentifierKey,
                                         .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .contentModificationDateKey,
                                         .creationDateKey, .fileSizeKey, .isWritableKey]
        if let v = try? url.resourceValues(forKeys: keys) {
            if let id = v.fileResourceIdentifier { out.append("resourceId: \(id)") }
            if let id = v.documentIdentifier { out.append("documentId: \(id)") }
            if let id = v.fileContentIdentifier { out.append("contentId: \(id)") }
            out.append("ubiquitous: \(v.isUbiquitousItem.map { "\($0)" } ?? "–") · download: \(v.ubiquitousItemDownloadingStatus?.rawValue ?? "–") · schreibbar: \(v.isWritable.map { "\($0)" } ?? "–")")
            out.append("geändert: \(v.contentModificationDate.map { "\($0)" } ?? "–") · Größe: \(v.fileSize.map { "\($0)" } ?? "–")")
        }
        // Erweiterte Attribute (Namen und, wenn kurz, Wert)
        let size = listxattr(url.path, nil, 0, 0)
        if size > 0 {
            var buf = [CChar](repeating: 0, count: size)
            listxattr(url.path, &buf, size, 0)
            let names = buf.split(separator: 0).map { String(cString: Array($0) + [0]) }
            for n in names {
                let len = getxattr(url.path, n, nil, 0, 0, 0)
                var value = ""
                if len > 0 && len <= 200 {
                    var b = [UInt8](repeating: 0, count: len)
                    getxattr(url.path, n, &b, len, 0, 0)
                    value = String(decoding: b, as: UTF8.self).filter { !$0.isNewline }
                }
                out.append("xattr \(n) (\(len))\(value.isEmpty ? "" : ": \(value)")")
            }
        } else {
            out.append("xattr: keine")
        }
        // Kennung beim Dateianbieter (bei DEVONthink To Go womöglich die UUID)
        let sem = DispatchSemaphore(value: 0)
        var fp = "–"
        NSFileProviderManager.getIdentifierForUserVisibleFile(at: url) { item, domain, error in
            fp = error.map { "Fehler \($0.localizedDescription)" } ?? "\(item?.rawValue ?? "nil") · Domäne \(domain?.rawValue ?? "nil")"
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 5)
        out.append("FileProvider-Kennung: \(fp)")
        return out
    }
}

/// Bericht anzeigen und zum Kopieren/Teilen anbieten
final class ProbeReportController: UIViewController {
    private let text: String
    init(text: String) { self.text = text; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "DEVONthink To Go – Prüfung"
        view.backgroundColor = .systemBackground
        let tv = UITextView()
        tv.text = text
        tv.isEditable = false
        tv.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        tv.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tv)
        NSLayoutConstraint.activate([
            tv.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            tv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            tv.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            tv.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12)
        ])
        navigationItem.rightBarButtonItems = [
            UIBarButtonItem(title: "Kopieren", style: .done, target: self, action: #selector(copyText)),
            UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(share))
        ]
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(close))
    }

    @objc private func copyText() { UIPasteboard.general.string = text }
    @objc private func share() {
        let vc = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        vc.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItems?.last
        present(vc, animated: true)
    }
    @objc private func close() { dismiss(animated: true) }
}

/// Ordner wählen (ohne SwiftUI, für die Brücke)
final class ProbeFolderPicker: NSObject, UIDocumentPickerDelegate {
    private var done: ((URL?) -> Void)?
    private static var current: ProbeFolderPicker?

    static func pick(from vc: UIViewController, done: @escaping (URL?) -> Void) {
        let p = ProbeFolderPicker()
        p.done = done
        current = p
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder, .item], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = p
        vc.present(picker, animated: true)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls.first) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }
    private func finish(_ url: URL?) { done?(url); done = nil; Self.current = nil }
}
