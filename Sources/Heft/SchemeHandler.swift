import AppKit
import WebKit
import PDFKit

// Eigenes URL-Schema "heft://" für den WebView.
//
//   heft://app/…                → Dateien der Oberfläche aus dem App-Paket
//   heft://item/<UUID>          → Datei eines DEVONthink-Datensatzes (Bilder, PDFs)
//   heft://pdfpage/<UUID>/<n>   → PDF-Seite als PNG (für eingebettete Arbeitsblätter)
//   heft://image/<UUID>?page=n&base=original → Bildseite (jedes Format, aufrecht gedreht)
//
// Ein eigenes Schema statt file:// ist nötig, weil WebKit ES-Module von
// file://-Adressen blockiert.

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let shared = SchemeHandler()

    let webRoot: URL = {
        if let r = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: r.path) { return r }
        // Beim Entwickeln direkt aus dem Quellordner
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("web")
    }()

    private var active = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private let work = DispatchQueue(label: "heft.scheme", qos: .userInitiated, attributes: .concurrent)
    private let pageCache = NSCache<NSString, NSData>()
    private let docCache = NSCache<NSString, PDFDocument>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); active.insert(ObjectIdentifier(task)); lock.unlock()
        guard let url = task.request.url else { fail(task, "Ungültige Adresse"); return }
        switch url.host {
        case "app":
            serveApp(url, task)
        case "item":
            let uuid = url.pathComponents.dropFirst().first ?? ""
            work.async { self.serveItem(uuid, task) }
        case "pdfpage":
            let parts = Array(url.pathComponents.dropFirst())
            let uuid = parts.first ?? ""
            let page = Int(parts.dropFirst().first ?? "1") ?? 1
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let width = q.first(where: { $0.name == "w" })?.value.flatMap(Int.init) ?? 1400
            let version = q.first(where: { $0.name == "v" })?.value ?? ""
            work.async { self.servePDFPage(uuid, page, width, version, task) }
        case "image":
            let uuid = url.pathComponents.dropFirst().first ?? ""
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let page = q.first(where: { $0.name == "page" })?.value.flatMap(Int.init) ?? 0
            let original = q.first(where: { $0.name == "base" })?.value == "original"
            work.async {
                do {
                    let (data, mime) = try ImageFiles.render(uuid: uuid, page: page, original: original)
                    self.finish(task, data: data, mime: mime)
                } catch { self.fail(task, error.localizedDescription) }
            }
        default:
            fail(task, "Unbekannt")
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); active.remove(ObjectIdentifier(task)); lock.unlock()
    }

    private func isActive(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active.contains(ObjectIdentifier(task))
    }

    private func finish(_ task: WKURLSchemeTask, data: Data, mime: String) {
        DispatchQueue.main.async {
            guard self.isActive(task) else { return }
            let resp = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"
            ])!
            task.didReceive(resp)
            task.didReceive(data)
            task.didFinish()
            self.lock.lock(); self.active.remove(ObjectIdentifier(task)); self.lock.unlock()
        }
    }

    private func fail(_ task: WKURLSchemeTask, _ message: String, status: Int = 404) {
        DispatchQueue.main.async {
            guard self.isActive(task) else { return }
            let resp = HTTPURLResponse(url: task.request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(resp)
            task.didReceive(Data(message.utf8))
            task.didFinish()
            self.lock.lock(); self.active.remove(ObjectIdentifier(task)); self.lock.unlock()
        }
    }

    private func serveApp(_ url: URL, _ task: WKURLSchemeTask) {
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = webRoot.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(webRoot.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            fail(task, "Nicht gefunden: \(path)")
            return
        }
        finish(task, data: data, mime: Self.mime(for: file.pathExtension))
    }

    private func serveItem(_ uuid: String, _ task: WKURLSchemeTask) {
        do {
            let path = try DEVONthink.shared.path(for: uuid)
            let url = URL(fileURLWithPath: path)
            let data = try Data(contentsOf: url)
            finish(task, data: data, mime: Self.mime(for: url.pathExtension))
        } catch {
            fail(task, error.localizedDescription)
        }
    }

    func invalidate(uuid: String) {
        docCache.removeObject(forKey: uuid as NSString)
        pageCache.removeAllObjects()
        DEVONthink.shared.forgetPath(uuid)
    }

    func document(for uuid: String) throws -> PDFDocument {
        if let d = docCache.object(forKey: uuid as NSString) { return d }
        let path = try DEVONthink.shared.path(for: uuid)
        // Über Data laden, nicht per URL – so bleibt die Datei im
        // DEVONthink-Paket nicht geöffnet, wenn DEVONthink sie ersetzt.
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let doc = PDFDocument(data: data) else { throw DTError.script("PDF kann nicht gelesen werden") }
        docCache.setObject(doc, forKey: uuid as NSString)
        return doc
    }

    // Neue Versionsnummer (Datei geändert, auch außerhalb von Heft) → PDF neu einlesen
    private var versions: [String: String] = [:]
    private func checkVersion(_ uuid: String, _ version: String) {
        guard !version.isEmpty else { return }
        lock.lock()
        let old = versions[uuid]
        versions[uuid] = version
        lock.unlock()
        if let old = old, old != version { docCache.removeObject(forKey: uuid as NSString) }
    }

    private func servePDFPage(_ uuid: String, _ page: Int, _ width: Int, _ version: String, _ task: WKURLSchemeTask) {
        checkVersion(uuid, version)
        let key = "\(uuid)/\(page)/\(width)/\(version)" as NSString
        if let cached = pageCache.object(forKey: key) { finish(task, data: cached as Data, mime: "image/png"); return }
        do {
            let doc = try document(for: uuid)
            guard let p = doc.page(at: max(0, page - 1)) else { fail(task, "Seite fehlt"); return }
            let png = Self.renderPNG(page: p, width: CGFloat(width))
            pageCache.setObject(png as NSData, forKey: key)
            finish(task, data: png, mime: "image/png")
        } catch {
            fail(task, error.localizedDescription)
        }
    }

    static func renderPNG(page: PDFPage, width: CGFloat) -> Data {
        let bounds = page.bounds(for: .mediaBox)
        let rotated = page.rotation % 180 != 0
        let pw = rotated ? bounds.height : bounds.width, ph = rotated ? bounds.width : bounds.height
        let scale = width / pw
        let size = NSSize(width: (pw * scale).rounded(), height: (ph * scale).rounded())
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return Data() }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        let cg = ctx.cgContext
        cg.setFillColor(NSColor.white.cgColor)
        cg.fill(CGRect(origin: .zero, size: size))
        cg.interpolationQuality = .high
        // thumbnail(of:) berücksichtigt auch gedrehte Seiten
        let img = page.thumbnail(of: size, for: .mediaBox)
        img.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:]) ?? Data()
    }

    static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "tif", "tiff": return "image/tiff"
        case "pdf": return "application/pdf"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "md": return "text/markdown; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
