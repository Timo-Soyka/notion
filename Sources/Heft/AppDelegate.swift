import AppKit

// App-Start, Menüleiste, heft://-Links und das saubere Beenden
// (erst speichern, dann schließen).

final class AppDelegate: NSObject, NSApplicationDelegate {
    var main: MainWindowController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMenu()
        main = MainWindowController()
        if let theme = Store.shared.string("theme") { main.applyTheme(theme) }
        main.showWindow(nil)
        main.window?.makeKeyAndOrderFront(nil)
        DebugHooks.startPolling(main: main)
        NSApp.activate(ignoringOtherApps: true)
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let main = main else { return .terminateNow }
        return main.prepareQuit() ? .terminateNow : .terminateLater
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        main?.emit("app-active", [:])
    }

    // heft://open?uuid=… (z. B. aus dem URL-Feld eines Datensatzes in DEVONthink)
    @objc func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let comps = URLComponents(string: s) else { return }
        if DebugHooks.handle(comps, main: main) { return }
        var uuid = comps.queryItems?.first(where: { $0.name == "uuid" })?.value
        if uuid == nil, comps.host == "open" { uuid = comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        if let u = uuid, !u.isEmpty { main?.emit("open-record", ["uuid": u]) }
        main?.window?.makeKeyAndOrderFront(nil)
    }

    // "Öffnen mit → Heft" für Markdown-Dateien aus DEVONthink
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            DEVONthink.shared.async({ try DEVONthink.shared.run(Scripts.lookupPath, [url.path]) }) { result in
                DispatchQueue.main.async {
                    if case .success(let r) = result, let d = r as? [String: Any], let u = d["uuid"] as? String {
                        self.main?.emit("open-record", ["uuid": u])
                    } else {
                        self.main?.emit("toast", ["message": "Heft öffnet nur Einträge, die in DEVONthink liegen.", "type": "error"])
                    }
                }
            }
        }
    }

    // MARK: - Menüleiste

    private func item(_ title: String, _ cmd: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(MainWindowController.menuCommand(_:)), keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        it.representedObject = cmd
        return it
    }

    private func buildMenu() -> NSMenu {
        let bar = NSMenu()

        // Heft
        let appItem = NSMenuItem()
        let app = NSMenu(title: "Heft")
        app.addItem(withTitle: "Über Heft", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(item("Einstellungen …", "settings", ","))
        app.addItem(.separator())
        let services = NSMenuItem(title: "Dienste", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Dienste")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        app.addItem(services)
        app.addItem(.separator())
        app.addItem(withTitle: "Heft ausblenden", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Andere ausblenden", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Alle einblenden", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Heft beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        bar.addItem(appItem)

        // Ablage
        let fileItem = NSMenuItem()
        let file = NSMenu(title: "Ablage")
        file.addItem(item("Neuer Eintrag", "newNote", "n"))
        file.addItem(item("Neuer Ordner", "newFolder", "n", [.command, .shift]))
        file.addItem(item("Suchen …", "search", "o"))
        file.addItem(.separator())
        file.addItem(item("Arbeitsblatt importieren …", "importPDF", "i", [.command, .shift]))
        let scan = NSMenuItem(title: "Vom iPhone oder iPad importieren", action: nil, keyEquivalent: "")
        scan.identifier = NSMenuItem.importFromDeviceIdentifier
        file.addItem(scan)
        file.addItem(.separator())
        file.addItem(item("Als PDF ablegen", "companion", "p", [.command, .shift]))
        file.addItem(item("Als PDF exportieren …", "exportPDF", "p", [.command, .option]))
        file.addItem(item("Drucken …", "print", "p"))
        file.addItem(.separator())
        file.addItem(item("In DEVONthink zeigen", "revealDT", "d", [.command, .shift]))
        file.addItem(item("Datenbank wechseln …", "switchDB"))
        file.addItem(.separator())
        file.addItem(withTitle: "Fenster schließen", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file
        bar.addItem(fileItem)

        // Bearbeiten
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Bearbeiten")
        edit.addItem(withTitle: "Widerrufen", action: #selector(MainWindowController.heftUndo(_:)), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Wiederholen", action: #selector(MainWindowController.heftRedo(_:)), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Ausschneiden", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Einsetzen", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let plain = edit.addItem(withTitle: "Einsetzen und Stil anpassen", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        plain.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        let spelling = NSMenuItem(title: "Rechtschreibung und Grammatik", action: nil, keyEquivalent: "")
        let spellMenu = NSMenu(title: "Rechtschreibung und Grammatik")
        spellMenu.addItem(withTitle: "Rechtschreibung und Grammatik einblenden", action: #selector(NSText.showGuessPanel(_:)), keyEquivalent: ":")
        spellMenu.addItem(withTitle: "Dokument jetzt prüfen", action: #selector(NSText.checkSpelling(_:)), keyEquivalent: ";")
        spellMenu.addItem(.separator())
        spellMenu.addItem(withTitle: "Während der Texteingabe prüfen", action: #selector(NSTextView.toggleContinuousSpellChecking(_:)), keyEquivalent: "")
        spellMenu.addItem(withTitle: "Grammatik mit Rechtschreibung prüfen", action: #selector(NSTextView.toggleGrammarChecking(_:)), keyEquivalent: "")
        spelling.submenu = spellMenu
        edit.addItem(spelling)
        let emoji = edit.addItem(withTitle: "Emoji & Symbole", action: #selector(NSApplication.orderFrontCharacterPalette(_:)), keyEquivalent: " ")
        emoji.keyEquivalentModifierMask = [.command, .control]
        editItem.submenu = edit
        bar.addItem(editItem)

        // Darstellung
        let viewItem = NSMenuItem()
        let view = NSMenu(title: "Darstellung")
        view.addItem(item("Seitenleiste ein/aus", "toggleSidebar", "\\"))
        view.addItem(item("Startseite", "home", "h", [.command, .shift]))
        view.addItem(.separator())
        let fs = view.addItem(withTitle: "Vollbild", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view
        bar.addItem(viewItem)

        // Fenster
        let winItem = NSMenuItem()
        let win = NSMenu(title: "Fenster")
        win.addItem(withTitle: "Im Dock ablegen", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoomen", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(.separator())
        win.addItem(withTitle: "Alle nach vorne bringen", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.windowsMenu = win
        bar.addItem(winItem)

        // Hilfe
        let helpItem = NSMenuItem()
        let help = NSMenu(title: "Hilfe")
        help.addItem(item("Tastenkürzel", "settings", ""))
        helpItem.submenu = help
        NSApp.helpMenu = help
        bar.addItem(helpItem)
        return bar
    }
}
