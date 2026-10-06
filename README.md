# Heft

Heft ist eine Mac-App für Hefteinträge im Stil von Notion. Man schreibt in Blöcken, die man mit `/` einfügt. Die Einträge werden in einer DEVONthink-Datenbank gespeichert und darüber synchronisiert. Dazu gibt es Heft fürs iPad – mit derselben Oberfläche und Apple-Pencil-Unterstützung.

## Funktionen

- **Blockeditor**: Überschriften, Listen, To-do-Listen, aufklappbare Abschnitte, Zitate, Code, Bilder, Fußnoten und Inhaltsverzeichnis. Zeilenumbruch ohne neuen Absatz mit Shift+Enter. Blöcke lassen sich in Spalten **nebeneinander** anordnen. Die Breiten gibt man als Verhältnis (1 : 2) oder als feste Werte (5 cm) an.
- **Formeln**: Eingabefelder mit deutschen Kürzeln wie `wurzel`, `bruch`, `integral` oder `pfeil`. Einheiten wie cm oder kg werden automatisch erkannt, auch mit Potenzen. Mit `&` richtet man Zeilen aus, mit `||` setzt man einen Kommandostrich für Äquivalenzumformungen, und `~` erzeugt ein Wurzelzeichen ohne Radikand. `stapel` schreibt zwei Zeilen übereinander (wie ein Bruch ohne Bruchstrich), `isotop` setzt Nuklide wie ¹⁴₆C – Massenzahl, Tab, Ordnungszahl, Tab, Element. Für die Analysis: `integral`, `unbestimmt`, `stammfunktion` ([F(x)] in Grenzen), `ableitung` (d/dx), `intervall` und `offen`. ⌘Z nimmt im Formelfeld die letzte Eingabe zurück, ohne die Formel zu schließen.
- **Chemie**: Summenformeln, Reaktionsgleichungen und organische Moleküle als Strukturformel (aus SMILES) – als Skelett-, Halbstruktur- oder Valenzstrichformel, auch für Ringe wie Zucker oder Benzol (mit allen H-Atomen und Elektronenpaaren). Kernreaktionen mit Isotopen (`^{235}_{92}U`) werden geprüft: Massen- und Ordnungszahlen links = rechts, und passt die Ordnungszahl zum Element?
- **Graphen**: Funktionsgraphen mit frei einstellbarem Ausschnitt. Die Größe lässt sich durch Ziehen an der Ecke ändern. Die Funktionszeilen sind Formelfelder wie bei Formeln (`wurzel`, `/`, `int` … zeigen gleich die fertige Schreibweise). Funktionen lassen sich einschränken – auch mehrfach (`für x > 0; x < 4`, `x < -1 oder x > 1`, `x ∈ [0; 3[`), mit offenen/geschlossenen Randpunkten – und abschnittsweise definieren. Senkrechte Geraden schränkt man über y ein (`x = 3 für 0 ≤ y ≤ 4`). `f'(x)` zeichnet die Ableitung (der Term steht ausgerechnet in der Legende), `tangente(f, 1)` die Tangente, `∫_0^2 f(x) dx` färbt die Fläche ein und nennt den exakten Wert mit Rechenweg ([⅓x³]₀² = 8/3) – auch zwischen zwei Graphen.
- **Tabellen**: Zellen lassen sich verbinden, einfärben und mit Kopfspalte versehen. Spaltenbreiten gehen als Verhältnis oder als feste Werte.
- **Nummerierung**: Überschriften, Listen und Beschriftungen werden automatisch nummeriert. Man kann die Nummer auch von Hand anpassen und in den Einstellungen Standards festlegen.
- **Ausrichtungspunkte** (`&`) auch im Fließtext, zum Beispiel für Buchangaben untereinander.
- **Vorlagen**: `/Aufgabe` (mit fortlaufender Nummer: 10a → 10b), `/Übungsaufgaben`, `/Umformung`, `/Versuchsprotokoll` und `/Vokabeltabelle`.
- **PDF**: Arbeitsblätter importieren, darauf schreiben und markieren, Seiten drehen, löschen oder hinzufügen und Text erkennen lassen (OCR). Jeder Eintrag bekommt ein passendes PDF zum Ausdrucken.
- **Fächer und Themen**: Mit „Fach“ wählt man Fach und Thema, Unterthema usw. (beliebig tief). Der Eintrag wandert in den passenden Ordner. Neue Themen legt man direkt dort an. Die Nummer nimmt den nächsten freien Platz (1.1 → 1.1.2). Fächer haben eigene Farben.
- **Verweise**: Links auf Einträge, PDFs, Bilder und andere Dateien – per `/Verweis`, `@` oder ⌘K. Dabei kann man Ordner durchblättern oder suchen. Die Links funktionieren auch im PDF: Verweise auf Einträge öffnen deren PDF-Fassung, Inhaltsverzeichnis und Überschrift-Verweise springen innerhalb der Datei.
- **Bildgrößen**: Beim Ziehen rastet die Größe auf festen Stufen (25–100 %) und auf der Größe der anderen Bilder ein, mit ⌥ stufenlos. Neue Bilder übernehmen die Größe des Bildes davor; „Alle Bilder auf …“ macht alle gleich groß.
- **Bilder bearbeiten**: Textfelder (verschiebbar, mit Schrift, Größe, Hintergrund und Rahmen), Pfeile, Linien, Formen, Stift, Textmarker, Nummern zum Beschriften und Abdecken. Dazu Zuschneiden, Drehen und Spiegeln. Das Format bleibt erhalten (TIFF bleibt TIFF, auch mehrseitig), das Original wird aufgehoben. Bearbeitete Bilder erscheinen sofort im Eintrag – auch wenn sie außerhalb von Heft geändert wurden.
- **Alle Dateitypen**: Text- und Code-Dateien sowie CSV-Tabellen lassen sich bearbeiten, RTF-Dokumente mit Formatierung. Word, Pages, Excel, Keynote, Audio und Video zeigt Heft an; bearbeitet werden sie per Klick im passenden Programm.
- **Zeilennummern** am Rand (jede, jede 5. oder jede 10. Zeile), auch im PDF.
- **Schriftgröße** für alle Einträge in den Einstellungen, pro Eintrag anpassbar.
- **Typst**: Formeln in Typst-Schreibweise werden beim Öffnen automatisch umgewandelt.
- **iPad**: Dieselbe Oberfläche mit allen Einträgen, PDFs und Bildern. Mit dem Apple Pencil schreibt man Einträge per Hand (Scribble macht Maschinenschrift daraus). Für Formeln und Graphen gibt es eine eigene **Mathe-Tastatur**: Ziffern und Rechenzeichen, Bruch, Wurzel, Hochzahl, Index, Betrag, Funktionen (sin, ln, log …), Ableitung, Integral, Grenzwert, Summe, Mengen und Pfeile, griechische Buchstaben, Buchstaben für Variablen, Einheiten sowie Ausrichtungspunkt, Kommandostrich, Isotop und Stapel; dazu Pfeiltasten, „nächstes Kästchen“, „neue Zeile“, Rückgängig/Wiederholen, „ohne“ (∖) und `\` für LaTeX-Befehle (`\alpha`, Leerzeichen übernimmt); eine eigene Seite **Mengen** (ℕ, ℕ₀, ℤ, ℚ, ℝ, ℝ⁺, ℝ₀⁺, ℂ, 𝕃, ∈, ⊂, ∪, ∩, ∖, ∅, Intervalle, {x | …}, D = …, ∀, ∃, ⇒, ⇔); „Text“ öffnet für Wörter ein Eingabefeld mit der normalen iPad-Tastatur (auch mit gekoppeltem Pencil, dort geht auch Handschrift) – „Einfügen“ oder ↵ setzt den Text in die Formel; die Rücktaste löscht „für“, „und“, „oder“ als ganzes Wort. Man kann beliebig schnell und mit mehreren Fingern tippen; Pfeile und „Kästchen“ wechseln höchstens die Zeile und schließen die Formel nie versehentlich. Einklappbar (z. B. mit Hardware-Tastatur) und abschaltbar unter Einstellungen → iPad. Reaktionsgleichungen und Strukturformeln haben ein Pencil-Schreibfeld. Arbeitsblätter füllt man mit Stift, Textmarker, Formen und Radierer aus (Doppeltippen auf den Stift wechselt dorthin); im Text-Werkzeug einfach aufs Blatt schreiben – an der Stelle entsteht ein Textfeld mit dem erkannten Text. Textfelder, Zeichnungen und Formen lassen sich verschieben (kurz halten und ziehen). Im Bildeditor zoomen und verschieben zwei Finger. Arbeitsblätter mit der Kamera scannen; in der Seitenleiste öffnet Halten und Loslassen das Menü, Halten und Ziehen verschiebt. Blöcke verschiebt man, indem man den Griff ⋮⋮ links neben dem Block mit Finger oder Pencil anfasst und zieht – auch ohne den Block vorher anzutippen; Antippen des sichtbaren Griffs öffnet das Blockmenü (erneutes Antippen schließt es), dort gibt es auch Kopieren und Ausschneiden.

## iPad-Abgleich

Das iPad arbeitet mit einer Kopie der Einträge in iCloud Drive. Am Mac in **Einstellungen → iPad** den „Abgleich mit dem iPad“ einschalten: Heft legt den Ordner „Heft“ in iCloud Drive an und hält ihn aktuell. Was man auf dem iPad ändert, landet als Auftrag in diesem Ordner; Heft am Mac bemerkt ihn sofort (Ordnerüberwachung statt Takt) und trägt ihn direkt in DEVONthink ein. Umgekehrt meldet iCloud dem iPad ein neues Verzeichnis vom Mac sofort, ein offener Eintrag übernimmt Änderungen vom Mac von selbst. Dafür muss Heft am Mac laufen – mit eingeschaltetem Abgleich läuft es nach dem Schließen des Fensters im Hintergrund weiter, ohne von macOS schlafen gelegt zu werden (beenden mit ⌘Q), auf Wunsch auch ab der Anmeldung. Es gibt keine Versionen und keine Konfliktkopien: Es gilt immer die zuletzt gespeicherte Fassung. Ist DEVONthink gerade nicht erreichbar, bleiben die Aufträge liegen und werden später eingetragen; kann ein Auftrag gar nicht eingetragen werden, meldet das iPad es.

## Installation

**Voraussetzungen:** ein Mac mit Apple-Chip (M1 oder neuer), macOS 14 Sonoma oder neuer und [DEVONthink 4](https://www.devontechnologies.com/apps/devonthink).

1. Die neueste `Heft-….dmg` unter [Releases](../../releases/latest) herunterladen und öffnen.
2. Doppelklick auf **„Heft installieren.command“**. Das Skript kopiert Heft nach „Programme“, gibt die App frei und startet sie.
   Alternativ: „Heft“ auf den Ordner „Programme“ ziehen.
3. Blockiert macOS den Start mit „Entwickler kann nicht überprüft werden“, gehe zu **Systemeinstellungen → Datenschutz & Sicherheit** und klicke unten auf **„Trotzdem öffnen“**. Das ist nur beim ersten Mal nötig.
4. Beim ersten Speichern fragt macOS, ob Heft DEVONthink steuern darf. Bestätige mit **„Erlauben“**.

Der Grund für Schritt 3: Heft ist nicht bei Apple registriert (notarisiert). Dafür bräuchte man ein kostenpflichtiges Entwicklerkonto.

Wer lieber das Terminal nutzt, kann die App nach dem Hineinziehen mit diesem Befehl freigeben:

```bash
xattr -dr com.apple.quarantine /Applications/Heft.app
```

### iPad

Die iPad-App wird mit Xcode installiert (kostenloser Apple-Account genügt):

1. iPad per Kabel an den Mac anschließen, „Diesem Computer vertrauen“ bestätigen und auf dem iPad den Entwicklermodus einschalten (Einstellungen → Datenschutz & Sicherheit).
2. Im Terminal:
   ```bash
   cd ios && xcodegen generate && open HeftPad.xcodeproj
   ```
   In Xcode unter „Signing & Capabilities“ das eigene Team wählen, das iPad als Ziel auswählen und auf ▶ klicken.
3. Beim ersten Start auf dem iPad: Einstellungen → Allgemein → VPN & Geräteverwaltung → dem eigenen Entwicklerzertifikat vertrauen.
4. In Heft auf dem iPad den Ordner „Heft“ in iCloud Drive auswählen.

Mit einem kostenlosen Account läuft die App 7 Tage und muss dann neu aufgespielt werden (Schritt 2 genügt). Mit einem bezahlten Entwicklerkonto gilt sie ein Jahr.

## Selbst bauen

Dafür braucht man die Xcode Command Line Tools (`xcode-select --install`) und [Node.js](https://nodejs.org) für die Tests.

```bash
scripts/build.sh              # testen, bauen und nach /Applications installieren
scripts/build.sh --no-install # nur bauen → build/Heft.app
scripts/make-dmg.sh           # Installationsdatei → dist/Heft-<Version>.dmg
```

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `Sources/Heft` | Das Mac-Programm in Swift: Fenster, Verbindung zu DEVONthink, PDF-Export, PDF-Bearbeitung und iPad-Abgleich |
| `ios` | Die iPad-App in Swift (XcodeGen-Projekt): Abgleich über iCloud Drive, PDF-Editor mit Apple Pencil, Scannen, Export |
| `web` | Die Oberfläche (HTML, CSS, JavaScript) mit Editor, Formeln, Graphen und Einstellungen – auf Mac und iPad dieselbe |
| `web/vendor` | Fremdbibliotheken: KaTeX, MathLive, highlight.js und SmilesDrawer, jeweils mit Lizenzdatei |
| `tests` | Tests für Markdown, Formeln, Tabellen, Nummerierung und Breiten (`node tests/….test.mjs`) |
| `scripts` | Skripte zum Bauen, für die Installationsdatei, den Entwicklungsserver und zum Testen der laufenden Apps (`scripts/debug`) |

Jeder Eintrag wird in DEVONthink als Markdown-Datei gespeichert, zusammen mit einem PDF in einem gemeinsamen Ordner. So lassen sich die Einträge auch ohne Heft lesen.
