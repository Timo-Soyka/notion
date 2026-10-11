# Kurzbefehl „Heft-Abgleich“ (iPad, ohne Mac)

Heft (iPad, Einstellung „Über DEVONthink To Go“) übergibt seine Änderungen diesem
Kurzbefehl; er trägt sie mit den Aktionen von DEVONthink To Go ein. Gegenstück in
Heft: `ios/HeftPad/DTTGSync.swift`, `MirrorStore.dttgBatch()/dttgApply()`.

## Aufruf

`shortcuts://x-callback-url/run-shortcut?name=Heft-Abgleich&input=text&text=<JSON>&x-success=heftpad://dttg/fertig&x-error=heftpad://dttg/fehler&x-cancel=heftpad://dttg/abbruch`

**Der Kurzbefehl braucht keine Datei-Aktionen** (kein „Datei abrufen“, kein „An
Textdatei anhängen“, also auch keine Ordnerwahl):

1. Aufträge lesen: „Wörterbuch abrufen“ aus **Kurzbefehleingabe** → `items`.
2. „Wiederholen mit jedem Objekt“ in `items`: Auftrag ausführen (Tabelle unten), danach
   die Zeile `id<Tab>Kennung` bzw. `id<Tab>FEHLER Text` an eine Textvariable `Ergebnis`
   anhängen („Zur Variable hinzufügen“). Fehler einer DTTG-Aktion möglichst abfangen
   (sonst bricht der ganze Lauf ab, siehe unten).
3. Letzte Aktion: **„Ausgabe stoppen und ausgeben“** mit `Ergebnis` (Zeilen mit Zeilenumbruch
   verbunden, „Text kombinieren“). Shortcuts hängt die Ausgabe an x-success als `result`
   an; Heft liest sie daraus.

Zum Testen per ▶ ohne Eingabe darf der Kurzbefehl einfach mit leerer Ausgabe enden.

## Rückmeldung

Kennung = UUID oder `x-devonthink-item://UUID` (Heft nimmt beides). Für Ändern,
Umbenennen, Verschieben, Löschen genügt irgendein Wert (z. B. die UUID des Eintrags);
für alles Neu-Angelegte muss es die Kennung des neuen Eintrags sein.

Heft liest zusätzlich (Altvariante) `Ergebnis.txt` aus „Auf meinem iPad → Heft →
DEVONthink“ und schreibt dort weiterhin `Abgleich.json`; beides ist optional.
Kommt ein Lauf erfolgreich zurück, aber ohne eine einzige Rückmeldezeile, meldet Heft
das und startet nicht mehr selbst neu (sonst würde Neues doppelt angelegt), bis
„Jetzt abgleichen“ getippt wird. Bricht der Kurzbefehl mitten im Stapel ab, gehen die
Rückmeldungen dieses Laufs verloren – bereits Angelegtes würde beim nächsten Lauf
erneut angelegt. Darum Fehler je Auftrag abfangen und als `FEHLER` melden.

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

Ausgabe (`result`) danach:

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

Objekt-Eigenschaften: `uuid`, `itemLink`, `title`, `json` … – für die Rückmeldung
die Eigenschaft `uuid` des erstellten bzw. geänderten Objekts.
