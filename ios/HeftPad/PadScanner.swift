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
            let small = UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
            if let jpg = small.jpegData(compressionQuality: 0.75), let page = UIImage(data: jpg).flatMap({ PDFPage(image: $0) }) {
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
