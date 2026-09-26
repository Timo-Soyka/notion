// Zeichnet das App-Symbol: kariertes Heftpapier mit rotem Rand, Achsen und
// einer blauen Parabel. Aufruf: swift scripts/make-icon.swift <Zielordner>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.clear(CGRect(x: 0, y: 0, width: s, height: s))

    // Squircle mit Rand (wie macOS-Symbole: 824/1024 Fläche)
    let inset = s * 100 / 1024
    let rect = CGRect(x: inset, y: inset + s * 0.01, width: s - 2 * inset, height: s - 2 * inset)
    let radius = rect.width * 0.225
    let shape = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: NSColor(white: 0, alpha: 0.28).cgColor)
    NSColor.white.setFill()
    shape.fill()
    ctx.restoreGState()

    ctx.saveGState()
    shape.addClip()
    // Papier mit leichtem Verlauf
    let paper = NSGradient(starting: NSColor(srgbRed: 1, green: 1, blue: 0.995, alpha: 1), ending: NSColor(srgbRed: 0.94, green: 0.95, blue: 0.97, alpha: 1))!
    paper.draw(in: rect, angle: -90)
    // Karos
    let step = rect.width / 13
    ctx.setStrokeColor(NSColor(srgbRed: 0.55, green: 0.68, blue: 0.86, alpha: 0.55).cgColor)
    ctx.setLineWidth(max(1, s / 700))
    var x = rect.minX + step * 0.5
    while x < rect.maxX { ctx.move(to: CGPoint(x: x, y: rect.minY)); ctx.addLine(to: CGPoint(x: x, y: rect.maxY)); x += step }
    var y = rect.minY + step * 0.5
    while y < rect.maxY { ctx.move(to: CGPoint(x: rect.minX, y: y)); ctx.addLine(to: CGPoint(x: rect.maxX, y: y)); y += step }
    ctx.strokePath()
    // Roter Heftrand rechts
    ctx.setStrokeColor(NSColor(srgbRed: 0.86, green: 0.2, blue: 0.2, alpha: 0.85).cgColor)
    ctx.setLineWidth(max(1.5, s / 220))
    let mx = rect.maxX - step * 2.2
    ctx.move(to: CGPoint(x: mx, y: rect.minY)); ctx.addLine(to: CGPoint(x: mx, y: rect.maxY))
    ctx.strokePath()

    // Achsen
    let ox = rect.minX + step * 5.5, oy = rect.minY + step * 3.5
    let axis = NSColor(srgbRed: 0.12, green: 0.23, blue: 0.43, alpha: 1)
    ctx.setStrokeColor(axis.cgColor)
    ctx.setFillColor(axis.cgColor)
    ctx.setLineWidth(max(1.5, s / 150))
    ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: rect.minX + step * 1.2, y: oy)); ctx.addLine(to: CGPoint(x: mx - step * 0.6, y: oy))
    ctx.move(to: CGPoint(x: ox, y: rect.minY + step * 1.2)); ctx.addLine(to: CGPoint(x: ox, y: rect.maxY - step * 1.3))
    ctx.strokePath()
    let ah = step * 0.45
    func arrow(_ tip: CGPoint, _ dx: CGFloat, _ dy: CGFloat) {
        ctx.move(to: tip)
        ctx.addLine(to: CGPoint(x: tip.x - dx * ah + dy * ah * 0.6, y: tip.y - dy * ah - dx * ah * 0.6))
        ctx.addLine(to: CGPoint(x: tip.x - dx * ah - dy * ah * 0.6, y: tip.y - dy * ah + dx * ah * 0.6))
        ctx.closePath()
        ctx.fillPath()
    }
    arrow(CGPoint(x: mx - step * 0.45, y: oy), 1, 0)
    arrow(CGPoint(x: ox, y: rect.maxY - step * 1.1), 0, 1)

    // Parabel
    let blue = NSColor(srgbRed: 0.15, green: 0.39, blue: 0.92, alpha: 1)
    ctx.setStrokeColor(blue.cgColor)
    ctx.setLineWidth(max(2, s / 55))
    ctx.setLineJoin(.round)
    let path = CGMutablePath()
    var first = true
    var t: CGFloat = -2.35
    while t <= 2.35 {
        let px = ox + t * step * 1.55
        let py = oy - step * 1.4 + t * t * step * 1.05
        if first { path.move(to: CGPoint(x: px, y: py)); first = false } else { path.addLine(to: CGPoint(x: px, y: py)) }
        t += 0.02
    }
    ctx.addPath(path)
    ctx.strokePath()
    // Tiefpunkt
    ctx.setFillColor(NSColor(srgbRed: 0.86, green: 0.2, blue: 0.2, alpha: 1).cgColor)
    let r = max(2, s / 60)
    ctx.fillEllipse(in: CGRect(x: ox - r, y: oy - step * 1.4 - r, width: 2 * r, height: 2 * r))
    ctx.restoreGState()

    // Feiner Rand
    NSColor(white: 0, alpha: 0.08).setStroke()
    shape.lineWidth = max(1, s / 512)
    shape.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
print("ok")
