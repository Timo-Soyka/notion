import Foundation
import WebKit
import PDFKit
import UIKit
import UniformTypeIdentifiers

// heft://-Adressen auf dem iPad – wie am Mac (Sources/Heft/SchemeHandler.swift):
//
//   heft://app/…              → die Oberfläche (web/ im App-Paket)
//   heft://item/<UUID>        → Datei eines Datensatzes (aus der iCloud-Kopie)
//   heft://pdfpage/<UUID>/<n> → PDF-Seite als PNG (für eingebettete Arbeitsblätter)
//   heft://image/<UUID>       → Bild (aufrecht gedreht, für den Bildeditor)

final class PadSchemeHandler: NSObject, WKURLSchemeHandler {
    private let webRoot: URL = {
        #if DEBUG
        // Zum Testen im Simulator: Oberfläche direkt aus dem Quellordner (-HeftWebRoot /Pfad/web)
        if let path = UserDefaults.standard.string(forKey: "HeftWebRoot") { return URL(fileURLWithPath: path, isDirectory: true) }
        #endif
        return Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    }()
    private let work = DispatchQueue(label: "heft.scheme", qos: .userInitiated, attributes: .concurrent)
    private var active = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private let pageCache = NSCache<NSString, NSData>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); active.insert(ObjectIdentifier(task)); lock.unlock()
        guard let url = task.request.url else { fail(task, "Ungültige Adresse"); return }
        let parts = Array(url.pathComponents.dropFirst())
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        switch url.host {
        case "app":
            serveApp(url, task)
        case "item":
            let uuid = parts.first ?? ""
            work.async {
                guard let data = MirrorStore.shared.fileData(for: uuid), let fileURL = MirrorStore.shared.fileURL(for: uuid) else {
                    self.fail(task, "Datei nicht gefunden"); return
                }
                self.finish(task, data: data, mime: Self.mime(for: fileURL.pathExtension))
            }
        case "image":
            let uuid = parts.first ?? ""
            let page = q.first(where: { $0.name == "page" })?.value.flatMap(Int.init) ?? 0
            let original = q.first(where: { $0.name == "base" })?.value == "original"
            work.async {
                do {
                    let (data, mime) = try ImageFiles.render(uuid: uuid, page: page, original: original)
                    self.finish(task, data: data, mime: mime)
                } catch { self.fail(task, error.localizedDescription) }
            }
        case "pdfpage":
            let uuid = parts.first ?? ""
            let page = Int(parts.dropFirst().first ?? "1") ?? 1
            let width = q.first(where: { $0.name == "w" })?.value.flatMap(Int.init) ?? 1400
            let version = q.first(where: { $0.name == "v" })?.value ?? ""
            work.async { self.servePDFPage(uuid, page, width, version, task) }
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

    // Nach dem Speichern eines Blatts die zwischengespeicherten Seitenbilder verwerfen
    private static var generations: [String: Int] = [:]
    private static let genLock = NSLock()

    static func invalidate(_ uuid: String) {
        genLock.lock(); generations[uuid, default: 0] += 1; genLock.unlock()
    }

    private static func generation(_ uuid: String) -> Int {
        genLock.lock(); defer { genLock.unlock() }
        return generations[uuid] ?? 0
    }

    private func servePDFPage(_ uuid: String, _ page: Int, _ width: Int, _ version: String, _ task: WKURLSchemeTask) {
        let key = "\(uuid)/\(page)/\(width)/\(version)/\(Self.generation(uuid))" as NSString
        if let cached = pageCache.object(forKey: key) { finish(task, data: cached as Data, mime: "image/png"); return }
        guard let data = MirrorStore.shared.fileData(for: uuid), let doc = PDFDocument(data: data),
              let p = doc.page(at: max(0, page - 1)) else { fail(task, "Seite fehlt"); return }
        let png = Self.renderPNG(page: p, width: CGFloat(width))
        pageCache.setObject(png as NSData, forKey: key)
        finish(task, data: png, mime: "image/png")
    }

    static func renderPNG(page: PDFPage, width: CGFloat) -> Data {
        let bounds = page.bounds(for: .mediaBox)
        let rotated = page.rotation % 180 != 0
        let pw = rotated ? bounds.height : bounds.width, ph = rotated ? bounds.width : bounds.height
        let scale = width / max(pw, 1)
        let size = CGSize(width: (pw * scale).rounded(), height: (ph * scale).rounded())
        // thumbnail beachtet Drehung und Ausrichtung der Seite selbst
        let thumb = page.thumbnail(of: size, for: .mediaBox)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: thumb.size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: thumb.size))
            thumb.draw(at: .zero)
        }
        return img.pngData() ?? Data()
    }

    static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
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
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
