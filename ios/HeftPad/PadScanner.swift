import UIKit
import VisionKit
import PDFKit

// Arbeitsblätter mit der iPad-Kamera scannen (Kanten werden automatisch
// erkannt und gerade gerückt) – das Ergebnis wird ein PDF.

final class PadScanner: NSObject, VNDocumentCameraViewControllerDelegate {
    private static var current: PadScanner?
    private let done: (Data?) -> Void

    private init(done: @escaping (Data?) -> Void) { self.done = done }

    static func scan(from vc: UIViewController, done: @escaping (Data?) -> Void) {
        guard VNDocumentCameraViewController.isSupported else { done(nil); return }
        let s = PadScanner(done: { data in current = nil; done(data) })
        current = s
        let cam = VNDocumentCameraViewController()
        cam.delegate = s
        vc.present(cam, animated: true)
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        controller.dismiss(animated: true)
        let pdf = PDFDocument()
        for i in 0..<scan.pageCount {
            // etwas verkleinern und als JPEG – Scans werden sonst sehr groß
            let img = scan.imageOfPage(at: i)
            let maxSide: CGFloat = 2200
            let k = min(1, maxSide / max(img.size.width, img.size.height))
            let size = CGSize(width: img.size.width * k, height: img.size.height * k)
            // Maßstab 1: sonst rechnet der Renderer mit der Bildschirmauflösung (doppelt so viele Pixel)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
            // Seite in A4-Größe (lange Seite 842 pt) statt 1 Pixel = 1 pt – sonst wird
            // das Blatt über einen Meter groß, und Stift und Textfelder sind darauf winzig
            let pt = 842 / max(size.width, size.height)
            let box = CGRect(x: 0, y: 0, width: (size.width * pt).rounded(), height: (size.height * pt).rounded())
            if let page = PDFPage(image: small, options: [.mediaBox: box, .compressionQuality: 0.75]) {
                pdf.insert(page, at: pdf.pageCount)
            }
        }
        done(pdf.dataRepresentation())
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true)
        done(nil)
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true)
        done(nil)
    }
}

extension Notification.Name {
    static let heftResetFolder = Notification.Name("HeftResetFolder")
}
