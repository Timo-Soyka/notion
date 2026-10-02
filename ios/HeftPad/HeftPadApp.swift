import SwiftUI
import UniformTypeIdentifiers

// Heft für das iPad.
//
// Beim ersten Start wählt man einmal den Ordner „Heft“ in iCloud Drive, den
// Heft am Mac anlegt (Einstellungen → iPad). Danach zeigt die App dieselbe
// Oberfläche wie am Mac und arbeitet auf dieser Kopie.

@main
struct HeftPadApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    @State private var ready = MirrorStore.shared.openFolder() && MirrorStore.shared.looksValid()

    var body: some View {
        Group {
            if ready {
                WebContainer().ignoresSafeArea(.container, edges: .bottom)
            } else {
                SetupView { ready = true }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .heftResetFolder)) { _ in ready = false }
    }
}

struct SetupView: View {
    let done: () -> Void
    @State private var picking = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Heft auf dem iPad").font(.largeTitle.bold())
            Text("Deine Einträge kommen über iCloud Drive vom Mac. Heft am Mac legt dafür den Ordner „Heft“ in iCloud Drive an und trägt alles, was du hier änderst, in DEVONthink ein.")
                .font(.body)
            VStack(alignment: .leading, spacing: 8) {
                Label("Am Mac: Heft öffnen → Einstellungen → iPad → „Abgleich mit dem iPad“ einschalten", systemImage: "1.circle")
                Label("Hier: unten tippen und in iCloud Drive den Ordner „Heft“ auswählen", systemImage: "2.circle")
            }
            .font(.callout)
            Button {
                picking = true
            } label: {
                Label("Ordner „Heft“ auswählen", systemImage: "folder.badge.plus").font(.headline).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            if let problem {
                Text(problem).foregroundStyle(.red).font(.callout)
            }
            Spacer()
        }
        .padding(40)
        .frame(maxWidth: 640)
        .sheet(isPresented: $picking) {
            FolderPicker { url in
                picking = false
                guard let url else { return }
                do {
                    try MirrorStore.shared.setFolder(url)
                    if MirrorStore.shared.looksValid() { done() }
                    else {
                        MirrorStore.shared.forgetFolder()
                        problem = "In diesem Ordner fehlt „Heft.json“. Bitte den Ordner „Heft“ wählen, den Heft am Mac in iCloud Drive angelegt hat."
                    }
                } catch {
                    problem = "Ordner kann nicht geöffnet werden: \(error.localizedDescription)"
                }
            }
        }
    }
}

// Ordnerauswahl über die Dateien-App
struct FolderPicker: UIViewControllerRepresentable {
    let done: (URL?) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let done: (URL?) -> Void
        init(done: @escaping (URL?) -> Void) { self.done = done }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { done(urls.first) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { done(nil) }
    }
}
