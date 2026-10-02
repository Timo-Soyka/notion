import UIKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

// Bilder bearbeiten – dieselbe Logik wie am Mac (Sources/Heft/FileSupport.swift),
// nur kommt die Datei aus der iCloud-Kopie und geht als Auftrag zurück an den Mac.
//
// Die Ebenen (Textfelder, Pfeile …) liegen hier im App-Speicher unter
// „Bildebenen/<UUID>“; bearbeitet man ein Bild am iPad weiter, das zuletzt am
// iPad gespeichert wurde, bleiben die Textfelder bearbeitbar.

enum ImageFiles {
    static let layerDir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Heft/Bildebenen", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    static func dir(_ uuid: String) -> URL { layerDir.appendingPathComponent(uuid, isDirectory: true) }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    struct Stored {
        let original: URL
        let layer: Any
    }

    // Gültige gespeicherte Ebenen für die aktuelle Datei?
    static func stored(uuid: String, current: Data) -> Stored? {
        let d = dir(uuid)
        guard let meta = try? Data(contentsOf: d.appendingPathComponent("layer.json")),
              let obj = try? JSONSerialization.jsonObject(with: meta) as? [String: Any],
              let hash = obj["outputHash"] as? String, hash == sha256(current),
              let name = obj["original"] as? String else { return nil }
        let orig = d.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: orig.path) else { return nil }
        return Stored(original: orig, layer: obj["layer"] ?? NSNull())
    }

    static func source(_ data: Data) -> CGImageSource? {
        CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
    }

    // Seite als aufrecht gedrehtes Bild (EXIF-Ausrichtung angewendet)
    static func frame(_ src: CGImageSource, _ index: Int) -> CGImage? {
        guard let props = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any] else {
            return CGImageSourceCreateImageAtIndex(src, index, nil)
        }
        let w = (props[kCGImagePropertyPixelWidth] as? Int) ?? 0, h = (props[kCGImagePropertyPixelHeight] as? Int) ?? 0
        let orientation = (props[kCGImagePropertyOrientation] as? Int) ?? 1
        if orientation == 1 { return CGImageSourceCreateImageAtIndex(src, index, nil) }
        return CGImageSourceCreateThumbnailAtIndex(src, index, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(w, h)
        ] as CFDictionary)
    }

    static func frameCount(_ src: CGImageSource, type: String) -> Int {
        let n = CGImageSourceGetCount(src)
        // Nur TIFF hat echte Seiten; bei GIF sind es Animationsbilder
        return type == UTType.tiff.identifier ? max(1, n) : 1
    }

    static func writableTypes() -> Set<String> {
        Set((CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? [])
    }

    static func current(_ uuid: String) throws -> Data {
        guard let d = MirrorStore.shared.fileData(for: uuid) else { throw err("Bild ist noch nicht heruntergeladen") }
        return d
    }

    static func ext(_ uuid: String) -> String {
        ((MirrorStore.shared.info(for: uuid)["ext"] as? String) ?? MirrorStore.shared.fileURL(for: uuid)?.pathExtension ?? "").lowercased()
    }

    static func err(_ msg: String) -> NSError { NSError(domain: "Heft", code: 3, userInfo: [NSLocalizedDescriptionKey: msg]) }

    static func info(uuid: String) throws -> [String: Any] {
        let data = try current(uuid)
        let stored = stored(uuid: uuid, current: data)
        let baseData = stored.flatMap { try? Data(contentsOf: $0.original) } ?? data
        guard let src = source(baseData), let type = CGImageSourceGetType(src) as String? else { throw err("Bild kann nicht gelesen werden") }
        let count = frameCount(src, type: type)
        var pages: [[String: Any]] = []
        for i in 0..<count {
            guard let img = frame(src, i) else { continue }
            var dpi: Double = 72
            if let p = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any], let d = p[kCGImagePropertyDPIWidth] as? Double, d > 0 { dpi = d }
            pages.append(["width": img.width, "height": img.height, "dpi": dpi])
        }
        let animated = CGImageSourceGetCount(src) > 1 && type != UTType.tiff.identifier
        return [
            "ext": ext(uuid),
            "uti": type,
            "pages": pages,
            "writable": writableTypes().contains(type) && !animated,
            "animated": animated,
            "base": stored != nil ? "original" : "current",
            "layer": stored?.layer ?? NSNull(),
            "bytes": data.count
        ]
    }

    // Seite als PNG/JPEG für die Oberfläche
    static func render(uuid: String, page: Int, original: Bool) throws -> (Data, String) {
        let data = try current(uuid)
        var base = data
        if original, let s = stored(uuid: uuid, current: data), let o = try? Data(contentsOf: s.original) { base = o }
        guard let src = source(base), let type = CGImageSourceGetType(src) as String? else { throw err("Bild kann nicht gelesen werden") }
        // Übliche Web-Formate ohne Drehung unverändert weitergeben
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let orientation = (props?[kCGImagePropertyOrientation] as? Int) ?? 1
        if page == 0, orientation == 1, CGImageSourceGetCount(src) == 1 {
            if type == UTType.png.identifier { return (base, "image/png") }
            if type == UTType.jpeg.identifier { return (base, "image/jpeg") }
        }
        guard let img = frame(src, min(page, max(0, CGImageSourceGetCount(src) - 1))) else { throw err("Seite fehlt") }
        let isPhoto = type == UTType.jpeg.identifier || type == UTType.heic.identifier || type == "public.heif"
        let out = encode(img, type: isPhoto ? UTType.jpeg.identifier : UTType.png.identifier, quality: 0.95) ?? Data()
        return (out, isPhoto ? "image/jpeg" : "image/png")
    }

    static func encode(_ img: CGImage, type: String, quality: Double = 0.92) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    // Drehen (Vielfache von 90°), spiegeln, zuschneiden, Ebene darüberlegen
    static func compose(_ base: CGImage, rot: Int, flipX: Bool, crop: CGRect?, overlay: CGImage?) -> CGImage? {
        let W = CGFloat(base.width), H = CGFloat(base.height)
        let r = ((rot % 360) + 360) % 360
        let RW = r % 180 == 0 ? W : H, RH = r % 180 == 0 ? H : W
        let c = (crop ?? CGRect(x: 0, y: 0, width: RW, height: RH)).integral.intersection(CGRect(x: 0, y: 0, width: RW, height: RH))
        guard c.width >= 1, c.height >= 1 else { return nil }
        let space = base.colorSpace?.model == .rgb ? base.colorSpace! : CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: Int(c.width), height: Int(c.height), bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        // Koordinaten wie in der Oberfläche: Ursprung oben links, y nach unten
        ctx.translateBy(x: 0, y: c.height)
        ctx.scaleBy(x: 1, y: -1)
        ctx.translateBy(x: -c.minX, y: -c.minY)
        ctx.saveGState()
        // Bild in den gedrehten Raum (RW × RH) legen
        switch r {
        case 90: ctx.translateBy(x: RW, y: 0); ctx.rotate(by: .pi / 2)
        case 180: ctx.translateBy(x: RW, y: RH); ctx.rotate(by: .pi)
        case 270: ctx.translateBy(x: 0, y: RH); ctx.rotate(by: -.pi / 2)
        default: break
        }
        if flipX { ctx.translateBy(x: W, y: 0); ctx.scaleBy(x: -1, y: 1) }
        // CGContext.draw zeichnet von unten nach oben – im gekippten System zurückkippen
        ctx.translateBy(x: 0, y: H)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: W, height: H))
        ctx.restoreGState()
        if let o = overlay {
            ctx.saveGState()
            ctx.translateBy(x: c.minX, y: c.minY + c.height)
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(o, in: CGRect(x: 0, y: 0, width: c.width, height: c.height))
            ctx.restoreGState()
        }
        return ctx.makeImage()
    }

    // Speichern: jede bearbeitete Seite neu zusammensetzen, im Originalformat schreiben
    static func save(uuid: String, pages: [[String: Any]], layer: Any) throws -> [String: Any] {
        let current = try current(uuid)
        let d = dir(uuid)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let ext = ext(uuid)
        // Original sichern (beim ersten Bearbeiten oder wenn die Datei anderswo geändert wurde)
        var originalURL: URL
        if let s = stored(uuid: uuid, current: current) { originalURL = s.original }
        else {
            for f in (try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: f) }
            originalURL = d.appendingPathComponent("original." + (ext.isEmpty ? "img" : ext))
            try current.write(to: originalURL)
        }
        let origData = try Data(contentsOf: originalURL)
        guard let src = source(origData), let type = CGImageSourceGetType(src) as String? else { throw err("Bild kann nicht gelesen werden") }
        let count = frameCount(src, type: type)
        let byIndex = Dictionary(uniqueKeysWithValues: pages.compactMap { p -> (Int, [String: Any])? in
            guard let i = (p["index"] as? NSNumber)?.intValue else { return nil }
            return (i, p)
        })
        let outType = type
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, outType as CFString, count, nil) else {
            throw err("Dieses Bildformat kann nicht geschrieben werden")
        }
        for i in 0..<count {
            guard let base = frame(src, i) else { continue }
            var props = (CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]) ?? [:]
            props[kCGImagePropertyOrientation] = 1
            if var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] { tiff[kCGImagePropertyTIFFOrientation] = 1; props[kCGImagePropertyTIFFDictionary] = tiff }
            props[kCGImagePropertyPixelWidth] = nil
            props[kCGImagePropertyPixelHeight] = nil
            var img = base
            if let p = byIndex[i] {
                let rot = (p["rot"] as? NSNumber)?.intValue ?? 0
                let flip = (p["flipX"] as? Bool) ?? false
                var crop: CGRect?
                if let c = p["crop"] as? [String: Any] {
                    crop = CGRect(x: (c["x"] as? NSNumber)?.doubleValue ?? 0, y: (c["y"] as? NSNumber)?.doubleValue ?? 0,
                                  width: (c["w"] as? NSNumber)?.doubleValue ?? 0, height: (c["h"] as? NSNumber)?.doubleValue ?? 0)
                }
                var overlay: CGImage?
                if let b64 = p["overlay"] as? String, let od = Data(base64Encoded: b64), let os = source(od) { overlay = CGImageSourceCreateImageAtIndex(os, 0, nil) }
                if let composed = compose(base, rot: rot, flipX: flip, crop: crop, overlay: overlay) { img = composed }
            }
            // JPEG kennt keine Transparenz – auf Weiß legen
            if outType == UTType.jpeg.identifier, img.alphaInfo != .none, img.alphaInfo != .noneSkipLast, img.alphaInfo != .noneSkipFirst {
                img = flatten(img) ?? img
            }
            props[kCGImageDestinationLossyCompressionQuality] = 0.93
            CGImageDestinationAddImage(dest, img, props as CFDictionary)
        }
        guard CGImageDestinationFinalize(dest) else { throw err("Bild konnte nicht geschrieben werden") }
        let result = out as Data
        try MirrorStore.shared.writeFile(uuid, data: result)
        let meta: [String: Any] = ["outputHash": sha256(result), "original": originalURL.lastPathComponent, "layer": layer, "saved": ISO8601DateFormatter().string(from: Date())]
        let json = try JSONSerialization.data(withJSONObject: meta)
        try json.write(to: d.appendingPathComponent("layer.json"), options: .atomic)
        return ["ok": true, "bytes": result.count]
    }

    // Für Formate, die sich nicht zurückschreiben lassen (z. B. RAW-Fotos):
    // PNG-Kopie des Originals, die dann bearbeitet wird
    static func pngCopy(uuid: String) throws -> Data {
        let data = try current(uuid)
        guard let src = source(data), let img = frame(src, 0), let png = encode(img, type: UTType.png.identifier) else {
            throw err("Bild kann nicht gelesen werden")
        }
        return png
    }

    static func flatten(_ img: CGImage) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: img.width, height: img.height))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        return ctx.makeImage()
    }

    // Alle Änderungen verwerfen: das gesicherte Original zurückschreiben
    static func revert(uuid: String) throws -> Bool {
        let current = try current(uuid)
        guard let s = stored(uuid: uuid, current: current) else { return false }
        try MirrorStore.shared.writeFile(uuid, data: Data(contentsOf: s.original))
        try? FileManager.default.removeItem(at: dir(uuid))
        return true
    }
}
