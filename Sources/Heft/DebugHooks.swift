import AppKit
import WebKit

// Testzugang für die Entwicklung.
//
// Nur aktiv, wenn die App mit "--debug-bridge" gestartet wird (normale Starts
// über Finder/Dock haben diesen Schalter nie). Damit lassen sich über
// heft://debug/…-Links JavaScript in der Oberfläche ausführen und Bilder des
// Fensters speichern – für automatische Tests ohne Bildschirmsteuerung.

enum DebugHooks {
    static let enabled = CommandLine.arguments.contains("--debug-bridge")
    static let inbox = URL(fileURLWithPath: "/tmp/heft-debug", isDirectory: true)
    private static var timer: Timer?

    // Befehlsdateien abholen: /tmp/heft-debug/<name>.js → <name>.json,
    // <name>.snap → <name>.png (unabhängig davon, welche App-Kopie Links bekommt)
    static func startPolling(main: MainWindowController) {
        guard enabled else { return }
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak main] _ in
            guard let main = main else { return }
            let files = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
            for f in files {
                let ext = f.pathExtension
                if ext == "js", let js = try? String(contentsOf: f, encoding: .utf8) {
                    try? FileManager.default.removeItem(at: f)
                    let out = f.deletingPathExtension().appendingPathExtension("json")
                    main.webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                        var obj: Any
                        switch result {
                        case .success(let v): obj = ["ok": true, "result": Bridge.sanitize(v)]
                        case .failure(let e): obj = ["ok": false, "error": "\(e)"]
                        }
                        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .fragmentsAllowed])) ?? Data()
                        try? data.write(to: out)
                    }
                } else if ext == "snap" {
                    try? FileManager.default.removeItem(at: f)
                    snapshot(main: main, to: f.deletingPathExtension().appendingPathExtension("png"))
                }
            }
        }
    }

    static func handle(_ comps: URLComponents, main: MainWindowController?) -> Bool {
        guard enabled, comps.host == "debug", let main = main else { return false }
        let q = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        let out = URL(fileURLWithPath: q["out"] ?? "/tmp/heft-debug.json")
        switch comps.path {
        case "/eval":
            let js = q["js"].flatMap { Data(base64Encoded: $0) }.map { String(decoding: $0, as: UTF8.self) } ?? "null"
            main.webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                var obj: Any
                switch result {
                case .success(let v): obj = ["ok": true, "result": Bridge.sanitize(v)]
                case .failure(let e): obj = ["ok": false, "error": "\(e)"]
                }
                let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .fragmentsAllowed])) ?? Data()
                try? data.write(to: out)
            }
        case "/snapshot":
            snapshot(main: main, to: out)
        default:
            break
        }
        return true
    }

    // Fensterinhalt als PNG: WebView-Schnappschuss plus natives PDF darüber
    static func snapshot(main: MainWindowController, to url: URL) {
        let cfg = WKSnapshotConfiguration()
        main.webView.takeSnapshot(with: cfg) { image, _ in
            guard let image = image, let content = main.window?.contentView else { return }
            let size = content.bounds.size
            let composed = NSImage(size: size)
            composed.lockFocus()
            image.draw(in: NSRect(origin: .zero, size: size))
            for sub in content.subviews where sub !== main.webView && !sub.isHidden {
                if let rep = sub.bitmapImageRepForCachingDisplay(in: sub.bounds) {
                    sub.cacheDisplay(in: sub.bounds, to: rep)
                    let f = sub.frame
                    rep.draw(in: NSRect(x: f.minX, y: size.height - f.maxY, width: f.width, height: f.height))
                }
            }
            composed.unlockFocus()
            if let tiff = composed.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: url)
            }
        }
    }
}
