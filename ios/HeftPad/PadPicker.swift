import UIKit
import PhotosUI
import UniformTypeIdentifiers

// Bilder und Dateien holen: aus Fotos, direkt mit der Kamera oder aus der
// Dateien-App. Liefert die Daten zurück – abgelegt wird über MirrorStore.

struct PickedFile {
    let name: String
    let ext: String
    let data: Data
}

final class PadPicker: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private static var current: PadPicker?
    private let done: ([PickedFile]) -> Void

    private init(done: @escaping ([PickedFile]) -> Void) { self.done = done }

    /// kind: "image" (Fotos/Kamera/Dateien), "pdf" (Dateien), "files" (Bilder und PDFs aus Dateien)
    static func pick(from vc: UIViewController, kind: String, done: @escaping ([PickedFile]) -> Void) {
        let picker = PadPicker(done: { files in current = nil; done(files) })
        current = picker
        if kind == "pdf" || kind == "files" {
            picker.presentFiles(from: vc, types: kind == "pdf" ? [.pdf] : [.pdf, .image])
            return
        }
        let sheet = UIAlertController(title: "Bild einfügen", message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Aus Fotos", style: .default) { _ in picker.presentPhotos(from: vc) })
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "Foto aufnehmen", style: .default) { _ in picker.presentCamera(from: vc) })
        }
        sheet.addAction(UIAlertAction(title: "Aus Dateien", style: .default) { _ in picker.presentFiles(from: vc, types: [.image]) })
        sheet.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in picker.done([]) })
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = vc.view
            pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        vc.present(sheet, animated: true)
    }

    private func presentPhotos(from vc: UIViewController) {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 0
        let p = PHPickerViewController(configuration: config)
        p.delegate = self
        vc.present(p, animated: true)
    }

    private func presentCamera(from vc: UIViewController) {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.delegate = self
        vc.present(p, animated: true)
    }

    private func presentFiles(from vc: UIViewController, types: [UTType]) {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        p.allowsMultipleSelection = true
        p.delegate = self
        vc.present(p, animated: true)
    }

    // Fotos
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { done([]); return }
        var files: [PickedFile] = []
        let group = DispatchGroup()
        let lock = NSLock()
        for r in results {
            group.enter()
            let provider = r.itemProvider
            let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) ?? UTType.jpeg.identifier
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                defer { group.leave() }
                guard let data else { return }
                // HEIC in JPEG umwandeln – das zeigt jeder Browser und DEVONthink
                var out = data, ext = UTType(type)?.preferredFilenameExtension ?? "jpg"
                if ext == "heic" || ext == "heif", let img = UIImage(data: data), let jpg = img.jpegData(compressionQuality: 0.88) { out = jpg; ext = "jpg" }
                let name = (provider.suggestedName ?? "Foto \(PadBridge.stamp())")
                lock.lock(); files.append(PickedFile(name: name, ext: ext, data: out)); lock.unlock()
            }
        }
        group.notify(queue: .main) { self.done(files) }
    }

    // Kamera
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let img = info[.originalImage] as? UIImage, let jpg = img.jpegData(compressionQuality: 0.88) else { done([]); return }
        done([PickedFile(name: "Foto \(PadBridge.stamp())", ext: "jpg", data: jpg)])
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        done([])
    }

    // Dateien
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        var files: [PickedFile] = []
        for u in urls {
            let scoped = u.startAccessingSecurityScopedResource()
            if let data = try? Data(contentsOf: u) {
                files.append(PickedFile(name: u.deletingPathExtension().lastPathComponent, ext: u.pathExtension.lowercased(), data: data))
            }
            if scoped { u.stopAccessingSecurityScopedResource() }
        }
        done(files)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { done([]) }
}
