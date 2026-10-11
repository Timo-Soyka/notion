# Kurzbefehl „Heft-Abgleich“ (iPad, ohne Mac)

Heft (iPad, Einstellung „Über DEVONthink To Go“) übergibt seine Änderungen diesem
Kurzbefehl; er trägt sie mit den Aktionen von DEVONthink To Go ein. Gegenstück in
Heft: `ios/HeftPad/DTTGSync.swift`, `MirrorStore.dttgBatch()/dttgApply()`.

## Aufruf

`shortcuts://x-callback-url/run-shortcut?name=Heft-Abgleich&x-success=heftpad://dttg/fertig&x-error=heftpad://dttg/fehler&x-cancel=heftpad://dttg/abbruch`

Zusätzlich `&input=text&text=<Inhalt von Abgleich.json>`: Der Kurzbefehl kann die
Aufträge also auch direkt aus der „Kurzbefehleingabe“ lesen (Wörterbuch aus Eingabe)
statt aus der Datei. Der Rücksprung zu Heft geschieht über x-callback von selbst.

## Dateien („Auf meinem iPad → Heft → DEVONthink“ = Documents/DEVONthink der App)

| Datei | Wer | Inhalt |
|---|---|---|
| `Abgleich.json` | Heft schreibt | `{"items": [ … ]}` in der Reihenfolge, in der sie auszuführen sind |
| `Ergebnis.txt` | Kurzbefehl hängt an | je erledigtem Auftrag eine Zeile `id<Tab>Kennung` bzw. `id<Tab>FEHLER Text` |

Kennung = UUID oder `x-devonthink-item://UUID` (Heft nimmt beides). Für Ändern,
Umbenennen, Verschieben, Löschen genügt irgendein Wert (z. B. die UUID des Eintrags);
für alles Neu-Angelegte muss es die Kennung des neuen Eintrags sein.

Wichtig: Auch „An Textdatei anhängen“ muss auf den Ordner Heft → DEVONthink zeigen
(ohne Ordner landet `Ergebnis.txt` in iCloud Drive → Kurzbefehle, Heft sieht dann
nichts und meldet „keine Ergebnis.txt“; selbst wiederholt wird dann erst nach
„Jetzt abgleichen“, damit nichts doppelt angelegt wird). Alternativ oder zusätzlich
kann der Kurzbefehl am Ende dieselben Zeilen mit „Ausgabe stoppen und ausgeben“
zurückgeben; Heft liest sie aus dem `result` von x-success.

Die Zeile wird **nach jedem Auftrag** angehängt („An Textdatei anhängen“), damit bei
einem Abbruch mitten im Stapel nichts doppelt angelegt wird.

## Aufträge (`items[]`)

Verweise (`uuid`, `parent`, `to`) sind immer echte DEVONthink-UUIDs. Objekt dazu:
„Objekt abrufen“ mit dem Text `x-devonthink-item://<uuid>`.

| op | Felder | Aktionen |
|---|---|---|
| `write` | uuid, markdown, name? | Objekt abrufen → Inhalt aktualisieren (markdown); wenn name: Objektinfos aktualisieren (Name) |
| `create-note` | parent, name, markdown | Objekt abrufen (parent) → Objekt erstellen (Typ Markdown, Name, Inhalt, Ziel = parent) → Kennung des neuen Objekts |
| `create-group` | parent, name | Objekt erstellen (Typ Gruppe, Name, Ziel = parent) → Kennung |
| `rename` | uuid, name | Objektinfos aktualisieren (Name) |
| `move` | uuid, to | Objekt bewegen (Ziel = to) |
| `trash` | uuid | Objekt löschen |

Beispiel:

```json
{"items": [
  {"id": "2026-10-10T21-50-00Z-00042-AB12CD.json", "op": "write",
   "uuid": "5B0E…", "name": "Latein Übersetzung", "markdown": "# …"},
  {"id": "2026-10-10T21-50-05Z-00043-EF34GH.json", "op": "create-note",
   "parent": "9A1C…", "name": "Neu", "markdown": "Hallo"}
]}
```

`Ergebnis.txt` danach:

```
2026-10-10T21-50-00Z-00042-AB12CD.json	5B0E…
2026-10-10T21-50-05Z-00043-EF34GH.json	x-devonthink-item://C77D…
```

Bilder und PDFs (`create-file`, `write-file`) gehen vorerst weiter über Heft am Mac;
der Kurzbefehl bekommt nur die Text-Aufträge oben.

## DTTG-Aktionen (com.devon-technologies.thinktogo4, aus Timos Vorlage)

| Aktion | Parameter | Ausgabe |
|---|---|---|
| DTTGGetItemIntent („Objekt abrufen“) | uuid (Text, nimmt `x-devonthink-item://UUID`) | Objekt |
| DTTGUpdateContentIntent („Inhalt aktualisieren“) | item, type `text`, text | |
| DTTGUpdateItemMetadataIntent („Objektinfos aktualisieren“) | item, title, tags, comment, url, label, rating, flagged, unread, dateCreated, dateModified | |
| DTTGCreateItemIntent („Objekt erstellen“) | group (Objekt), type (`markdown`, Gruppe?), title, markdown, tags, comment, url, label, flagged | Erstelltes Objekt |
| DTTGMoveItemIntent („Objekt bewegen“) | item, toGroup (Objekt) | |
| DTTGTrashItemIntent („Objekt löschen“) | item | |

Objekt-Eigenschaften: `uuid`, `itemLink`, `title`, `json` … – für `Ergebnis.txt`
die Eigenschaft `uuid` des erstellten bzw. geänderten Objekts.
