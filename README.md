# Heft

Heft ist eine Mac-App für Hefteinträge im Stil von Notion. Man schreibt in Blöcken, die man mit `/` einfügt. Die Einträge werden in einer DEVONthink-Datenbank gespeichert und darüber synchronisiert.

## Funktionen

- **Blockeditor**: Überschriften, Listen, To-do-Listen, aufklappbare Abschnitte, Zitate, Code, Bilder, Fußnoten und Inhaltsverzeichnis. Zeilenumbruch ohne neuen Absatz mit Shift+Enter. Blöcke lassen sich in Spalten **nebeneinander** anordnen. Die Breiten gibt man als Verhältnis (1 : 2) oder als feste Werte (5 cm) an.
- **Formeln**: Eingabefelder mit deutschen Kürzeln wie `wurzel`, `bruch`, `integral` oder `pfeil`. Einheiten wie cm oder kg werden automatisch erkannt, auch mit Potenzen. Mit `&` richtet man Zeilen aus, mit `||` setzt man einen Kommandostrich für Äquivalenzumformungen, und `~` erzeugt ein Wurzelzeichen ohne Radikand. `stapel` schreibt zwei Zeilen übereinander (wie ein Bruch ohne Bruchstrich), `isotop` setzt Nuklide wie ¹⁴₆C – Massenzahl, Tab, Ordnungszahl, Tab, Element.
- **Chemie**: Summenformeln, Reaktionsgleichungen und organische Moleküle als Strukturformel (aus SMILES). Kernreaktionen mit Isotopen (`^{235}_{92}U`) werden geprüft: Massen- und Ordnungszahlen links = rechts, und passt die Ordnungszahl zum Element?
- **Graphen**: Funktionsgraphen mit frei einstellbarem Ausschnitt. Die Größe lässt sich durch Ziehen an der Ecke ändern.
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
| `Sources/Heft` | Das Mac-Programm in Swift: Fenster, Verbindung zu DEVONthink, PDF-Export und PDF-Bearbeitung |
| `web` | Die Oberfläche (HTML, CSS, JavaScript) mit Editor, Formeln, Graphen und Einstellungen |
| `web/vendor` | Fremdbibliotheken: KaTeX, MathLive, highlight.js und SmilesDrawer, jeweils mit Lizenzdatei |
| `tests` | Tests für Markdown, Formeln, Tabellen, Nummerierung und Breiten (`node tests/….test.mjs`) |
| `scripts` | Skripte zum Bauen, für die Installationsdatei und für den Entwicklungsserver |

Jeder Eintrag wird in DEVONthink als Markdown-Datei gespeichert, zusammen mit einem PDF in einem gemeinsamen Ordner. So lassen sich die Einträge auch ohne Heft lesen.
