// Einstellungen und Ersteinrichtung.

import { h, esc, dialog, toast, menu } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { call, isNative, isPad } from '../bridge.js';
import { headingNumbers, listLabel, HEADING_STYLES, LIST_STYLES, ENTRY_FORMATS } from '../core/numbering.js';
import { subjectColor, colorDot, SUBJECT_COLORS, COLOR_LABELS } from '../core/subjects.js';

// Voreinstellungen – angelehnt an Timos Typst-Vorlage für Hefteinträge
// (SF Mono, nummerierte Überschriften in Dunkelblau, "1 von N" unten mittig).
export const DEFAULTS = {
  name: '',
  theme: 'system',
  subjects: ['Mathe', 'Deutsch', 'Englisch', 'Latein', 'Französisch', 'Physik', 'Chemie', 'Biologie', 'Geschichte', 'Geographie', 'Ethik', 'Religion', 'Informatik', 'Wirtschaft', 'Sozialkunde', 'Kunst', 'Musik', 'Sport'],
  subjectColors: {},
  bundleNotes: false,
  autoPdf: true,
  syncTags: true,
  font: 'mono',
  fontSize: null,   // Punkt (pt) im PDF; null = je nach Schrift 12 bzw. 12,8 pt
  imageWidth: 100,  // Breite neuer Bilder in % – wenn der Eintrag noch kein Bild hat
  numbering: '1.1',
  numberDepth: 3,
  numberPrefix: false,
  listStyle: '1.',
  listNested: true,
  captionNumbers: false,
  entryNumbers: 'off',
  textAlignMarks: true,
  headingColor: true,
  typography: true,
  mathSyntax: 'auto',
  favorites: [],
  pdf: { paper: 'A4', top: 3, bottom: 3, left: 2.5, right: 2.5, pageNumbers: 'von', header: 'none', titleCentered: true, openToggles: true }
};

export function withDefaults(s) {
  const out = { ...DEFAULTS, ...(s || {}) };
  out.pdf = { ...DEFAULTS.pdf, ...((s && s.pdf) || {}) };
  return out;
}

// Standard-Schriftgröße in Punkt (pt) – so groß steht der Text im PDF.
// Am Bildschirm entspricht 1 pt 1,25 Pixeln (wie beim Drucken).
export const defaultFontPt = (font) => (font === 'mono' ? 12 : 12.8);
const fmtPt = (v) => String(Math.round(v * 10) / 10).replace('.', ',');

function fontSizeControl(app) {
  const box = h('div', { class: 'fs-control' });
  const value = h('span', { class: 'fs-value' });
  const preview = h('div', { class: 'fs-preview', text: 'Die Zelle ist die kleinste Einheit des Lebens.' });
  const reset = h('button', { class: 'btn sm', text: 'Standard' });
  const paint = () => {
    const s = app.settings;
    const pt = s.fontSize || defaultFontPt(s.font);
    value.textContent = `${fmtPt(pt)} pt`;
    reset.style.visibility = s.fontSize ? 'visible' : 'hidden';
    preview.style.fontSize = pt * 1.25 + 'px';
    preview.style.fontFamily = s.font === 'mono' ? 'var(--font-mono)' : s.font === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)';
  };
  const set = async (pt) => {
    await app.updateSettings({ fontSize: pt });
    app.refreshEditorSettings();
    paint();
  };
  const step = (d) => {
    const cur = app.settings.fontSize || defaultFontPt(app.settings.font);
    const next = Math.min(20, Math.max(8, Math.round((cur + d) * 2) / 2));
    set(next);
  };
  const minus = h('button', { class: 'btn sm outline fs-step', 'data-tip': 'Kleiner', text: '−' });
  const plus = h('button', { class: 'btn sm outline fs-step', 'data-tip': 'Größer', text: '+' });
  minus.addEventListener('click', () => step(-0.5));
  plus.addEventListener('click', () => step(0.5));
  reset.addEventListener('click', () => set(null));
  box.append(h('div', { class: 'fs-row' }, minus, value, plus, reset), preview);
  paint();
  return box;
}

function row(title, desc, control) {
  return h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('div', { class: 't', text: title }), desc ? h('div', { class: 'd', text: desc }) : ''), h('div', { class: 'r' }, control));
}

function sw(value, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span'));
}

function select(options, value, onChange) {
  const s = h('select', { class: 'select' });
  for (const [v, l] of options) {
    const o = h('option', { value: v, text: l });
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function seg(options, value, onChange) {
  const box = h('div', { class: 'segmented' });
  for (const [v, l] of options) {
    const b = h('button', { class: String(v) === String(value) ? 'on' : '' }, l);
    b.addEventListener('click', () => { box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); onChange(v); });
    box.append(b);
  }
  return box;
}

export function openSettings(app, section = 'general') {
  const s = app.settings;
  const nav = h('div', { class: 'settings-nav' }, h('div', { class: 't', text: 'Einstellungen' }));
  const body = h('div', { class: 'settings-body' });
  const box = h('div', { class: 'row', style: { alignItems: 'stretch', height: '100%', gap: '0' } }, nav, body);
  const d = dialog({ body: box, class: 'settings', center: true });
  d.el.querySelector('.dialog-body').style.cssText = 'padding:0;height:100%;overflow:hidden';
  const save = (patch) => app.updateSettings(patch);
  const savePdf = (patch) => app.updateSettings({ pdf: { ...app.settings.pdf, ...patch } });

  const pages = {
    general: ['Allgemein', 'gear', () => [
      h('h3', { text: 'Allgemein' }), h('p', { class: 'desc', text: 'Name, Aussehen und deine Fächer.' }),
      row('Dein Name', 'Erscheint auf Wunsch in der Kopfzeile der PDFs.', (() => { const i = h('input', { class: 'input', value: s.name || '', placeholder: 'z. B. Timo S.' }); i.addEventListener('change', () => save({ name: i.value.trim() })); return i; })()),
      row('Erscheinungsbild', '', seg([['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']], s.theme, (v) => { save({ theme: v }); app.applyTheme(); }))
    ]],
    subjects: ['Fächer', 'cap', () => [
      h('h3', { text: 'Fächer' }),
      h('p', { class: 'desc', text: 'Deine Fächer mit Farbe. Die Farbe zeigt sich in der Seitenleiste (Ordner mit dem Namen des Fachs und alles darin), beim Fach im Eintrag und unter „Zuletzt geöffnet“. Die Reihenfolge gilt auch in der Fach-Auswahl.' }),
      subjectEditor(app)
    ]],
    devonthink: ['DEVONthink', 'database', () => {
      const status = h('div', { class: 'd', text: 'Wird geprüft …' });
      const dbSel = h('select', { class: 'select' });
      const groupLabel = h('span', { class: 'badge', text: s.rootName || '–' });
      call('dt.status').then(st => {
        status.textContent = st.running ? 'DEVONthink läuft und ist verbunden.' : 'DEVONthink ist nicht gestartet.';
        dbSel.innerHTML = '';
        for (const db of st.databases || []) {
          const o = h('option', { value: db.uuid, text: db.name });
          if (db.uuid === s.database) o.selected = true;
          dbSel.append(o);
        }
      }).catch(() => { status.textContent = 'Keine Verbindung zu DEVONthink.'; });
      dbSel.addEventListener('change', async () => {
        const name = dbSel.options[dbSel.selectedIndex].textContent;
        const groups = await call('dt.groups', { database: dbSel.value });
        pickGroup(groups, null, async (g) => {
          await save({ database: dbSel.value, databaseName: name, root: g.uuid, rootName: g.name, roots: { ...(app.settings.roots || {}), [dbSel.value]: { root: g.uuid, rootName: g.name } } });
          groupLabel.textContent = g.name;
          app.lib.refresh();
        });
      });
      const changeGroup = h('button', { class: 'btn sm outline' }, 'Ändern …');
      changeGroup.addEventListener('click', async () => {
        const groups = await call('dt.groups', { database: s.database });
        pickGroup(groups, s.root, async (g) => {
          await save({ root: g.uuid, rootName: g.name, roots: { ...(app.settings.roots || {}), [app.settings.database]: { root: g.uuid, rootName: g.name } } });
          groupLabel.textContent = g.name;
          app.lib.refresh();
        });
      });
      return [
        h('h3', { text: 'DEVONthink' }), h('p', { class: 'desc', text: 'Alle Einträge liegen direkt in deiner DEVONthink-Datenbank – dort werden sie auch synchronisiert und durchsucht.' }),
        h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('div', { class: 't', text: 'Verbindung' }), status), h('div', { class: 'r' }, h('span', { html: icon('database') }))),
        row('Datenbank', 'In welcher Datenbank Heft arbeitet.', dbSel),
        row('Ordner', 'Dieser Ordner (und alles darunter) erscheint in der Seitenleiste.', h('div', { class: 'row' }, groupLabel, changeGroup)),
        h('div', { class: 'set-group-title', text: 'Ablage' }),
        row('Neue Einträge als Ordner anlegen', 'Jeder Eintrag bekommt einen eigenen Ordner für PDF, Bilder und Arbeitsblatt – wie bisher „Original / PDF / Typst“.', sw(s.bundleNotes, (v) => save({ bundleNotes: v }))),
        row('PDF-Fassung aktuell halten', 'Hat ein Eintrag schon eine PDF-Fassung, wird sie beim Verlassen des Eintrags automatisch erneuert.', sw(s.autoPdf, (v) => save({ autoPdf: v }))),
        row('Schlagwörter übernehmen', 'Fach und Schlagwörter werden als Tags in DEVONthink gesetzt.', sw(s.syncTags, (v) => save({ syncTags: v })))
      ];
    }],
    editor: ['Editor', 'pencil', () => [
      h('h3', { text: 'Editor' }), h('p', { class: 'desc', text: 'Voreinstellungen für neue Einträge. Einzelne Einträge kannst du über „⋯“ oben rechts anpassen.' }),
      row('Schrift', 'Standard, Serifen oder Monospace (SF Mono).', seg([['sans', 'Standard'], ['serif', 'Serif'], ['mono', 'Mono']], s.font, (v) => { save({ font: v }); app.refreshEditorSettings(); })),
      row('Schriftgröße', 'Gilt für alle Einträge ohne eigene Größe. Angabe in Punkt wie im PDF (und wie in Word) – am Bildschirm entsprechend größer.', fontSizeControl(app)),
      row('Größe neuer Bilder', 'Gilt für das erste Bild in einem Eintrag. Jedes weitere Bild bekommt automatisch die Größe des Bildes davor – so bleiben alle Bilder gleich groß.', seg([['33.3', 'Klein'], ['50', 'Mittel'], ['75', 'Groß'], ['100', 'Ganze Breite']], String(s.imageWidth || 100), (v) => { save({ imageWidth: Number(v) }); if (app.editor) app.editor.settings = app.settings; })),
      row('Überschriften farbig', 'Dunkelblaue Überschriften wie in deiner Vorlage.', sw(s.headingColor, (v) => { save({ headingColor: v }); app.refreshEditorSettings(); })),
      row('Typografie beim Tippen', '-> wird →, "…" wird „…“, ... wird …', sw(s.typography !== false, (v) => save({ typography: v }))),
      row('„&“ im Text ausrichten', '„&“ setzt einen farbigen Ausrichtungspunkt (Zahl danach = ID). Zweimal „&“ ergibt ein normales &.', sw(s.textAlignMarks !== false, (v) => save({ textAlignMarks: v })))
    ]],
    numbering: ['Nummerierung', 'listOrdered', () => {
      const re = (patch) => { save(patch); app.refreshEditorSettings(); };
      const example = h('div', { class: 'num-example' });
      const paint = () => {
        const st = app.settings.numbering || '';
        const o = { style: st, depth: app.settings.numberDepth || 3, prefix: app.settings.numberPrefix ? '2' : '' };
        const hs = headingNumbers([{ id: 1, level: 1 }, { id: 2, level: 2 }, { id: 3, level: 3 }, { id: 4, level: 1 }], o);
        const ls = app.settings.listStyle || '1.', nest = app.settings.listNested !== false;
        example.innerHTML = '';
        example.append(
          h('div', { class: 'h1', text: `${hs.get(1) ? hs.get(1) + ' ' : ''}Einleitung` }),
          h('div', { class: 'h2', text: `${hs.get(2) ? hs.get(2) + ' ' : ''}Grundbegriffe` }),
          h('div', { class: 'h3', text: `${hs.get(3) ? hs.get(3) + ' ' : ''}Beispiel` }),
          h('div', { class: 'li', text: `${listLabel(1, 0, ls, nest)} erster Punkt` }),
          h('div', { class: 'li sub', text: `${listLabel(1, 1, ls, nest)} Unterpunkt` }),
          h('div', { class: 'h1', text: `${hs.get(4) ? hs.get(4) + ' ' : ''}Übungen` }));
      };
      const live = (patch) => { re(patch); paint(); };
      paint();
      return [
        h('h3', { text: 'Nummerierung' }),
        h('p', { class: 'desc', text: 'Standard für alle Einträge. Einzelne Einträge änderst du über „⋯“ oben rechts; einzelne Nummern mit einem Klick auf die Nummer (z. B. „weiter mit 5“ oder „ohne Nummer“).' }),
        example,
        h('h4', { text: 'Überschriften' }),
        row('Schreibweise', '', seg(HEADING_STYLES, s.numbering || '', (v) => live({ numbering: v }))),
        row('Nummerieren bis Ebene', 'Tiefere Überschriften bleiben ohne Nummer.', seg([[1, '1'], [2, '2'], [3, '3']], s.numberDepth || 3, (v) => live({ numberDepth: Number(v) }))),
        row('Eintragsnummer davor', 'Im Eintrag „2 Wurzeln“ heißt Abschnitt 1 dann „2.1“.', sw(s.numberPrefix, (v) => live({ numberPrefix: v }))),
        h('h4', { text: 'Nummerierte Listen' }),
        row('Schreibweise', '', seg(LIST_STYLES, s.listStyle || '1.', (v) => live({ listStyle: v }))),
        row('Unterlisten abwechselnd', '1. → a) → i.', sw(s.listNested !== false, (v) => live({ listNested: v }))),
        h('h4', { text: 'Abbildungen und Tabellen' }),
        row('Beschriftungen nummerieren', '„Abbildung 1: …“ und „Tabelle 1: …“ vor jeder Beschriftung.', sw(s.captionNumbers, (v) => live({ captionNumbers: v }))),
        h('h4', { text: 'Neue Einträge' }),
        row('Automatisch nummerieren', '„Nach Thema“: Die Nummer setzt sich aus Thema und Unterthemen zusammen und nimmt den nächsten freien Platz – im Unterthema 1.1 mit einem Eintrag also 1.1.2. Du kannst sie jederzeit ändern (Klick auf die Nummer über dem Titel).', seg(ENTRY_FORMATS, s.entryNumbers || 'off', (v) => save({ entryNumbers: v })))
      ];
    }],
    pdf: ['PDF & Druck', 'printer', () => {
      const p = s.pdf;
      const num = (key, label) => { const i = h('input', { class: 'input', type: 'number', step: '0.5', min: '0.5', max: '6', value: p[key] }); i.style.width = '70px'; i.addEventListener('change', () => savePdf({ [key]: parseFloat(i.value) || DEFAULTS.pdf[key] })); return h('label', { class: 'row', style: { gap: '6px', fontSize: '13px' } }, label, i); };
      return [
        h('h3', { text: 'PDF & Druck' }), h('p', { class: 'desc', text: 'So sehen die PDF-Fassungen deiner Einträge aus.' }),
        row('Papierformat', '', seg([['A4', 'A4'], ['A5', 'A5'], ['Letter', 'Letter']], p.paper, (v) => savePdf({ paper: v }))),
        h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('div', { class: 't', text: 'Ränder (cm)' })), h('div', { class: 'r', style: { flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '340px' } }, num('top', 'oben'), num('bottom', 'unten'), num('left', 'links'), num('right', 'rechts'))),
        row('Seitenzahlen', '', seg([['von', '1 von 3'], ['seite', 'Seite 1'], ['plain', '1'], ['none', 'Aus']], p.pageNumbers, (v) => savePdf({ pageNumbers: v }))),
        row('Kopfzeile', 'Oben auf jeder Seite.', select([['none', 'Keine'], ['title', 'Titel'], ['subject', 'Fach · Titel'], ['full', 'Name · Fach · Datum']], p.header, (v) => savePdf({ header: v }))),
        row('Titel zentriert', '', sw(p.titleCentered, (v) => savePdf({ titleCentered: v }))),
        row('Toggles und Lösungen aufklappen', 'Zugeklappte Inhalte erscheinen im PDF ausgeklappt.', sw(p.openToggles, (v) => savePdf({ openToggles: v })))
      ];
    }],
    keys: ['Tastenkürzel', 'type', () => {
      const t = h('table', { class: 'shortcut-table' });
      const rows = [
        ['Befehlsmenü', '/'], ['Verweis auf Eintrag', '@ oder [['], ['Suchen', '⌘ K'], ['Neuer Eintrag', '⌘ N'], ['Neuer Ordner', '⌘ ⇧ N'],
        ['Fett / Kursiv / Unterstrichen', '⌘ B · ⌘ I · ⌘ U'], ['Durchgestrichen', '⌘ ⇧ S'], ['Code', '⌘ E'], ['Formel im Text', '⌘ ⇧ E oder $…$'],
        ['Markieren', '⌘ ⇧ H oder ==…=='], ['Link', '⌘ K (mit Auswahl)'], ['Hoch- / Tiefgestellt', '⌃ ⌘ + · ⌃ ⌘ -'],
        ['Text / Überschrift 1–3', '⌘ ⌥ 0 · 1 · 2 · 3'], ['To-do / Liste / Nummerierung', '⌘ ⌥ 4 · 5 · 6'], ['Toggle / Code / Formel', '⌘ ⌥ 7 · 8 · 9'],
        ['Block auswählen', 'Esc'], ['Block verschieben', '⌘ ⇧ ↑ / ↓'], ['Block duplizieren', '⌘ D'], ['Einrücken / Ausrücken', '⇥ · ⇧ ⇥'],
        ['Weicher Zeilenumbruch', '⇧ ↵'], ['To-do abhaken / Toggle öffnen', '⌘ ↵'], ['Rückgängig / Wiederholen', '⌘ Z · ⌘ ⇧ Z'],
        ['Als PDF ablegen', '⌘ ⇧ P'], ['Drucken', '⌘ P'], ['Seitenleiste', '⌘ \\'], ['Griechische Buchstaben & Symbole', '\\alpha + Leertaste']
      ];
      for (const [a, b] of rows) t.append(h('tr', {}, h('td', { text: a }), h('td', { html: b.split(' ').map(k => k === '·' || k === '/' || k === 'oder' || k === '+' && false ? esc(k) : `<kbd>${esc(k)}</kbd>`).join(' ') })));
      return [h('h3', { text: 'Tastenkürzel' }), h('p', { class: 'desc', text: 'Fast alles wie in Notion.' }), t];
    }],
    ipad: ['iPad', 'panelRight', () => ipadPage(app, save)],
    about: ['Über Heft', 'info', () => [
      h('h3', { text: 'Heft' }),
      h('p', { class: 'desc', text: 'Hefteinträge mit Blöcken, Formeln, Graphen und Chemie – gespeichert als Markdown in DEVONthink.' }),
      row('Speicherformat', 'Markdown mit Typst-/LaTeX-Formeln. Lesbar auch ohne diese App.', h('span', { class: 'badge', text: '.md' })),
      row('Mitgelieferte Bausteine', 'KaTeX (Formeln, MIT), mhchem (Chemie), SmilesDrawer (Strukturformeln, MIT), highlight.js (Code, BSD).', h('span'))
    ]]
  };

  const show = (key) => {
    section = key;
    nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === key));
    body.innerHTML = '';
    body.append(...pages[key][2]());
  };
  // Auf dem iPad gibt es keine direkte Verbindung zu DEVONthink – das macht der Mac
  if (isPad) delete pages.devonthink;
  if (!isNative) delete pages.ipad;
  for (const [key, [label, ic]] of Object.entries(pages)) {
    const b = h('button', { 'data-k': key, html: icon(ic) + esc(label) });
    b.addEventListener('click', () => show(key));
    nav.append(b);
  }
  show(section);
}

// Abgleich mit dem iPad über iCloud Drive (am Mac einschalten, auf dem iPad Stand zeigen)
function ipadPage(app, save) {
  const s = app.settings;
  const status = h('div', { class: 'd', text: 'Wird geprüft …' });
  const fmt = (iso) => {
    if (!iso) return 'noch nie';
    const sec = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (sec < 60) return 'gerade eben';
    if (sec < 3600) return `vor ${Math.round(sec / 60)} Min.`;
    return new Date(iso).toLocaleString('de-DE', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const refresh = () => call('sync.info').then(info => {
    if (isPad) { status.textContent = info.label || ''; return; }
    if (!info.enabled) { status.textContent = 'Ausgeschaltet.'; return; }
    status.textContent = info.error ? `Fehler: ${info.error}` : `Zuletzt abgeglichen: ${fmt(info.lastRun)}` + (info.log && info.log.length ? ` · ${info.log[info.log.length - 1]}` : '');
    login.querySelector('input').checked = !!info.loginItem;
  }).catch(() => { status.textContent = 'Nicht verfügbar.'; });
  const now = h('button', { class: 'btn sm outline' }, 'Jetzt abgleichen');
  now.addEventListener('click', async () => {
    now.disabled = true;
    try {
      const r = await call('sync.now');
      toast(r && r.orders ? `${r.orders} Änderung(en) vom iPad eingetragen.` : 'Abgeglichen.', { type: 'success' });
    } catch (e) { toast('Abgleich fehlgeschlagen: ' + e.message, { type: 'error' }); }
    now.disabled = false;
    refresh();
  });
  const login = sw(false, async (v) => {
    try { await call('app.loginItem', { enabled: v }); } catch (e) { toast('Nicht möglich: ' + e.message, { type: 'error' }); }
    refresh();
  });
  refresh();
  if (isPad) {
    const change = h('button', { class: 'btn sm outline' }, 'Anderen Ordner wählen …');
    change.addEventListener('click', () => call('mirror.reset'));
    return [
      h('h3', { text: 'Abgleich mit dem Mac' }),
      h('p', { class: 'desc', text: 'Deine Einträge kommen über iCloud Drive vom Mac. Was du hier änderst, trägt Heft am Mac sofort in DEVONthink ein – dafür muss der Mac an sein und Heft dort laufen (auch im Hintergrund). Es gilt immer die zuletzt gespeicherte Fassung; Kopien wie „… (iPad)“ entstehen nicht mehr.' }),
      h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('div', { class: 't', text: 'Stand' }), status), h('div', { class: 'r' }, change)),
      h('h3', { text: 'Eingabe' }),
      row('Mathe-Tastatur', 'Beim Tippen in eine Formel (auch in Graphen) erscheint statt der normalen Bildschirmtastatur eine eigene Tastatur mit Bruch, Wurzel, Hochzahl, Funktionen, Integralen, griechischen Buchstaben und Einheiten. Mit ⌄ lässt sie sich einklappen, etwa wenn eine Hardware-Tastatur angeschlossen ist.',
        sw(s.mathKeyboard !== false, (v) => save({ mathKeyboard: v }))),
      row('Pencil-Schreibfeld', 'Reaktionsgleichungen und Strukturformeln bekommen ein Feld, in das du mit dem Apple Pencil schreibst. Nach einer kurzen Pause landet das Geschriebene im Block.',
        sw(s.pencilPad !== false, (v) => save({ pencilPad: v })))
    ];
  }
  return [
    h('h3', { text: 'iPad' }),
    h('p', { class: 'desc', text: 'Heft auf dem iPad arbeitet mit einer Kopie deiner Einträge in iCloud Drive (Ordner „Heft“). Was du auf dem iPad änderst, trägt Heft hier sofort in DEVONthink ein. Es gilt immer die zuletzt gespeicherte Fassung – egal ob vom Mac oder vom iPad.' }),
    row('Abgleich mit dem iPad', 'Legt die Kopie in iCloud Drive an und hält sie aktuell. Heft läuft dann beim Schließen des Fensters im Hintergrund weiter (beenden mit ⌘Q).', sw(s.ipadSync, async (v) => { await save({ ipadSync: v }); refresh(); })),
    h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('div', { class: 't', text: 'Stand' }), status), h('div', { class: 'r' }, now)),
    row('Beim Anmelden starten', 'Heft startet mit dem Mac, damit Änderungen vom iPad auch ohne geöffnetes Fenster ankommen.', login)
  ];
}

// Liste der Fächer mit Farbe, Name und Reihenfolge
function subjectEditor(app) {
  const box = h('div');
  const list = h('div', { class: 'subject-list' });
  const commit = async (subjects, colors) => {
    await app.updateSettings({ subjects, subjectColors: colors });
    app.sidebar && app.sidebar.renderTree();
    if (app.editor) app.editor.renderHeader();
    render();
  };
  const render = () => {
    list.innerHTML = '';
    const subjects = [...(app.settings.subjects || [])];
    const colors = { ...(app.settings.subjectColors || {}) };
    subjects.forEach((name, i) => {
      const c = subjectColor(app.settings, name);
      const sw = h('button', { class: 'swatch-btn', 'data-tip': 'Farbe wählen', html: colorDot(c, 14) });
      sw.addEventListener('click', () => menu(sw, [
        ...SUBJECT_COLORS.map(k => ({ label: COLOR_LABELS[k], html: colorDot(k), checked: c === k, onSelect: () => commit(subjects, { ...colors, [name]: k }) })),
        '-',
        { label: 'Keine Farbe', html: colorDot(null), checked: !c, onSelect: () => commit(subjects, { ...colors, [name]: '' }) }
      ]));
      const input = h('input', { class: 'input', value: name, spellcheck: 'false' });
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (!v || v === name) { input.value = name; return; }
        const next = subjects.map((x, k) => (k === i ? v : x));
        const nc = { ...colors };
        nc[v] = c || '';
        delete nc[name];
        commit(next, nc);
      });
      const move = (d) => { const next = [...subjects]; const j = i + d; if (j < 0 || j >= next.length) return; [next[i], next[j]] = [next[j], next[i]]; commit(next, colors); };
      const up = h('button', { class: 'btn icon-only', 'data-tip': 'Nach oben', html: icon('arrowUp', 'sm') });
      const down = h('button', { class: 'btn icon-only', 'data-tip': 'Nach unten', html: icon('arrowDown', 'sm') });
      const del = h('button', { class: 'btn icon-only', 'data-tip': 'Entfernen', html: icon('trash', 'sm') });
      up.disabled = i === 0;
      down.disabled = i === subjects.length - 1;
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      del.addEventListener('click', () => { const nc = { ...colors }; delete nc[name]; commit(subjects.filter((_, k) => k !== i), nc); });
      list.append(h('div', { class: 'subject-row' }, sw, input, up, down, del));
    });
  };
  const addInput = h('input', { class: 'input', placeholder: 'Neues Fach, z. B. Spanisch' });
  const addBtn = h('button', { class: 'btn outline' }, icon('plus', 'sm'), 'Hinzufügen');
  const add = () => {
    const v = addInput.value.trim();
    const subjects = [...(app.settings.subjects || [])];
    if (!v || subjects.some(x => x.toLowerCase() === v.toLowerCase())) return;
    // Noch unbenutzte Farbe vorschlagen
    const used = new Set(subjects.map(x => subjectColor(app.settings, x)));
    const free = SUBJECT_COLORS.find(k => !used.has(k)) || 'gray';
    addInput.value = '';
    commit([...subjects, v], { ...(app.settings.subjectColors || {}), [v]: subjectColor(app.settings, v) || free });
  };
  addBtn.addEventListener('click', add);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  render();
  box.append(list, h('div', { class: 'subject-add' }, addInput, addBtn));
  return box;
}

// Gruppen-Auswahl (für Datenbank-Ordner)
export function groupPicker(groups, selected, onSelect) {
  const box = h('div', { class: 'group-picker' });
  let current = selected;
  const walk = (list, depth) => {
    for (const g of list) {
      const r = h('div', { class: 'gp-row' + (g.uuid === current ? ' on' : ''), style: { paddingLeft: 6 + depth * 16 + 'px' } }, h('span', { html: icon('folder', 'sm') }), h('span', { text: g.name }));
      r.addEventListener('click', () => {
        current = g.uuid;
        box.querySelectorAll('.gp-row').forEach(x => x.classList.remove('on'));
        r.classList.add('on');
        onSelect(g);
      });
      box.append(r);
      if (g.children && g.children.length && depth < 6) walk(g.children, depth + 1);
    }
  };
  walk(groups, 0);
  return box;
}

function pickGroup(groups, selected, onDone) {
  let chosen = null;
  const picker = groupPicker(groups, selected, (g) => { chosen = g; });
  const d = dialog({
    title: 'Ordner wählen', description: 'Welcher Ordner der Datenbank soll in der Seitenleiste erscheinen?', body: picker, center: true,
    actions: [{ label: 'Abbrechen', value: false }, { label: 'Übernehmen', primary: true, onClick: () => { if (!chosen) return false; onDone(chosen); } }]
  });
  return d;
}

// ---------------------------------------------------------------------------
// Ersteinrichtung
// ---------------------------------------------------------------------------

export async function renderOnboarding(app, container) {
  container.innerHTML = '';
  const wrap = h('div', { class: 'onboarding' });
  container.append(wrap);
  wrap.append(h('div', { class: 'logo', html: icon('book', 'lg') }), h('h1', { text: 'Willkommen bei Heft' }),
    h('p', { class: 'lead', text: 'Deine Hefteinträge landen direkt in DEVONthink – durchsuchbar, synchronisiert und als PDF abgelegt. Wähle einmal aus, wo sie hin sollen.' }));
  const card = h('div', { class: 'card' });
  wrap.append(card);
  card.append(h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { text: 'Verbinde mit DEVONthink …' })));
  let st;
  try { st = await call('dt.status', { launch: true }); } catch (e) { st = { running: false, error: e.message }; }
  card.innerHTML = '';
  if (!st.running || !(st.databases || []).length) {
    card.append(h('p', { text: st.error || 'DEVONthink läuft nicht oder hat keine geöffnete Datenbank.' }));
    const retry = h('button', { class: 'btn primary' }, 'Erneut versuchen');
    retry.addEventListener('click', () => renderOnboarding(app, container));
    card.append(retry);
    return;
  }
  const dbSel = h('select', { class: 'select' });
  for (const db of st.databases) {
    const o = h('option', { value: db.uuid, text: db.name });
    if (/schule/i.test(db.name)) o.selected = true;
    dbSel.append(o);
  }
  const pickerHost = h('div');
  let chosen = null;
  const loadGroups = async () => {
    pickerHost.innerHTML = '';
    pickerHost.append(h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'hint', text: 'Ordner werden geladen …' })));
    const groups = await call('dt.groups', { database: dbSel.value });
    pickerHost.innerHTML = '';
    // "01 Fächer" o. Ä. vorschlagen, falls vorhanden
    const flat = [];
    const walk = (l) => { for (const g of l) { flat.push(g); walk(g.children || []); } };
    walk(groups);
    chosen = flat.find(g => /fächer|faecher/i.test(g.name)) || groups[0];
    pickerHost.append(groupPicker(groups, chosen && chosen.uuid, (g) => { chosen = g; }));
  };
  dbSel.addEventListener('change', loadGroups);
  const go = h('button', { class: 'btn primary lg' }, 'Los geht’s', icon('arrowRight', 'sm'));
  go.addEventListener('click', async () => {
    if (!chosen) { toast('Bitte einen Ordner wählen.', { type: 'error' }); return; }
    await app.updateSettings({ configured: true, database: dbSel.value, databaseName: dbSel.options[dbSel.selectedIndex].textContent, root: chosen.uuid, rootName: chosen.name, roots: { ...(app.settings.roots || {}), [dbSel.value]: { root: chosen.uuid, rootName: chosen.name } } });
    app.start();
  });
  card.append(
    h('div', { class: 'field' }, h('label', { text: 'Datenbank' }), dbSel),
    h('div', { class: 'field' }, h('label', { text: 'Ordner für deine Einträge' }), pickerHost, h('div', { class: 'hint', text: 'Du siehst in Heft genau diesen Ordner mit allen Unterordnern. Neue Einträge und PDFs landen dort.' })),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, go));
  await loadGroups();
}

// ---------------------------------------------------------------------------
// Datenbank wählen – bei jedem Start. Der Ordner wird pro Datenbank gemerkt,
// danach genügt ein Klick (oder Enter für die zuletzt benutzte).
// ---------------------------------------------------------------------------

export async function renderDatabasePicker(app, container) {
  container.innerHTML = '';
  const s = app.settings;
  const roots = { ...(s.roots || {}) };
  if (s.database && s.root && !roots[s.database]) roots[s.database] = { root: s.root, rootName: s.rootName };
  const wrap = h('div', { class: 'onboarding db-picker' });
  container.append(wrap);
  wrap.append(h('div', { class: 'logo', html: icon('database', 'lg') }), h('h1', { text: 'Welche Datenbank?' }),
    h('p', { class: 'lead', text: 'Wähle, mit welcher DEVONthink-Datenbank Heft diesmal arbeitet.' }));
  const card = h('div', { class: 'card' });
  wrap.append(card);
  card.append(h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { text: 'Verbinde mit DEVONthink …' })));
  let st;
  try { st = await call('dt.status', { launch: true }); } catch (e) { st = { running: false, error: e.message }; }
  card.innerHTML = '';
  if (!st.running || !(st.databases || []).length) {
    card.append(h('p', { text: st.error || 'DEVONthink läuft nicht oder hat keine geöffnete Datenbank.' }));
    const retry = h('button', { class: 'btn primary' }, 'Erneut versuchen');
    retry.addEventListener('click', () => renderDatabasePicker(app, container));
    card.append(retry);
    return;
  }
  const open = async (db, root) => {
    roots[db.uuid] = { root: root.uuid, rootName: root.name };
    await app.updateSettings({ configured: true, database: db.uuid, databaseName: db.name, root: root.uuid, rootName: root.name, roots });
    document.removeEventListener('keydown', onKey, true);
    app.start();
  };
  // Ordner für eine Datenbank wählen (beim ersten Mal oder auf Wunsch)
  const chooseFolder = async (db) => {
    card.innerHTML = '';
    card.append(h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'hint', text: 'Ordner werden geladen …' })));
    const groups = await call('dt.groups', { database: db.uuid });
    const flat = [];
    const walk = (l) => { for (const g of l) { flat.push(g); walk(g.children || []); } };
    walk(groups);
    const known = roots[db.uuid] && flat.find(g => g.uuid === roots[db.uuid].root);
    let chosen = known || flat.find(g => /fächer|faecher/i.test(g.name)) || groups[0];
    card.innerHTML = '';
    const back = h('button', { class: 'btn ghost' }, icon('chevronLeft', 'sm'), 'Zurück');
    back.addEventListener('click', () => renderDatabasePicker(app, container));
    const go = h('button', { class: 'btn primary lg' }, 'Öffnen', icon('arrowRight', 'sm'));
    go.addEventListener('click', () => { if (chosen) open(db, chosen); });
    card.append(
      h('div', { class: 'field' }, h('label', { text: `Ordner für deine Einträge in „${db.name}“` }),
        groupPicker(groups, chosen && chosen.uuid, (g) => { chosen = g; }),
        h('div', { class: 'hint', text: 'Heft zeigt genau diesen Ordner mit allen Unterordnern. Die Wahl wird für diese Datenbank gemerkt.' })),
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, back, go));
  };
  const list = h('div', { class: 'db-list' });
  const rows = [];
  const dbs = [...st.databases].sort((a, b) => (b.uuid === s.database) - (a.uuid === s.database));
  for (const db of dbs) {
    const r = roots[db.uuid];
    const row = h('button', { class: 'db-row' + (db.uuid === s.database ? ' last' : '') },
      h('span', { class: 'ic', html: icon('database') }),
      h('span', { class: 'tx' },
        h('span', { class: 'n', text: db.name }),
        h('span', { class: 's', text: r ? `Ordner: ${r.rootName}` : 'Ordner beim ersten Öffnen wählen' })),
      db.uuid === s.database ? h('span', { class: 'badge', text: 'Zuletzt' }) : null);
    const change = h('span', { class: 'change', 'data-tip': 'Anderen Ordner wählen', html: icon('folder', 'sm') });
    change.addEventListener('click', (e) => { e.stopPropagation(); chooseFolder(db); });
    if (r) row.append(change);
    row.addEventListener('click', () => (r ? open(db, { uuid: r.root, name: r.rootName }) : chooseFolder(db)));
    rows.push(row);
    list.append(row);
  }
  card.append(list, h('div', { class: 'hint', html: '<kbd>Enter</kbd> öffnet die zuletzt benutzte Datenbank.' }));
  const onKey = (e) => {
    if (!list.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, i - 1)].focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => rows[0] && rows[0].focus());
}
