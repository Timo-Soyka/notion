// Das "/"-Menü und das "@"-Menü (Verweise auf andere Einträge, Datum).

import { h, esc, popover, todayISO, formatDate } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { block, isEmptyHTML } from '../core/markdown.js';
import { htmlToSegs, segsToHTML, splitSegs, mergeSegs } from '../core/inline.js';
import * as caret from './caret.js';
import { CALLOUTS } from './callouts.js';
import { defaultPlotConfig } from './blocks/plot.js';
import { emptyTable } from './blocks/table.js';
import { openInlineMath, openFootnote } from './format.js';
import { itemLink } from '../bridge.js';

// Platzhalterzeichen für Atome, damit Positionen im Klartext stimmen
const OBJ = '\uFFFC';
function plainOf(el) {
  return htmlToSegs(el.innerHTML).map(s => s.t === 'text' ? s.text : s.t === 'br' ? '\n' : OBJ).join('');
}

const thumb = (t) => `<span style="font-family:var(--font-serif);font-weight:600">${t}</span>`;

function textCmd(type, props = {}) {
  return (ed, b) => {
    if (ed.isText(b)) ed.setType(b, type, props);
    else { const nb = block(type, props); ed.insertAfter(b, [nb]); ed.focusBlock(nb); }
  };
}

function atomCmd(type, propsFn) {
  return (ed, b) => {
    const props = propsFn ? propsFn() : {};
    return ed.setType(b, type, props);
  };
}

function calloutCmd(kind) {
  return (ed, b) => {
    const nb = ed.setType(b, 'callout', { kind, open: kind === 'loesung' ? true : undefined });
    // Direkt einen ersten Absatz im Kasten anlegen, dort tippt man meistens weiter
    if (!nb.children.length) {
      const p = block('p');
      ed.insertChildAt(nb, 0, [p]);
      if (isEmptyHTML(nb.html)) ed.focusBlock(p, 'start');
    }
  };
}

export const COMMANDS = [
  { group: 'Grundblöcke', id: 'p', label: 'Text', desc: 'Einfacher Absatz', thumb: thumb('Aa'), kw: 'text absatz paragraph normal', run: textCmd('p') },
  { group: 'Grundblöcke', id: 'h1', label: 'Überschrift 1', desc: 'Großer Abschnitt', thumb: thumb('H1'), kw: 'h1 heading überschrift titel abschnitt #', hint: '#', run: textCmd('h1') },
  { group: 'Grundblöcke', id: 'h2', label: 'Überschrift 2', desc: 'Mittlerer Abschnitt', thumb: thumb('H2'), kw: 'h2 heading überschrift unterabschnitt ##', hint: '##', run: textCmd('h2') },
  { group: 'Grundblöcke', id: 'h3', label: 'Überschrift 3', desc: 'Kleiner Abschnitt', thumb: thumb('H3'), kw: 'h3 heading überschrift ###', hint: '###', run: textCmd('h3') },
  { group: 'Grundblöcke', id: 'ul', label: 'Aufzählung', desc: 'Liste mit Punkten', icon: 'list', kw: 'liste bullet punkte ul aufzählung spiegelstrich', hint: '-', run: textCmd('ul') },
  { group: 'Grundblöcke', id: 'ol', label: 'Nummerierung', desc: 'Nummerierte Liste', icon: 'listOrdered', kw: 'nummer nummeriert ol numbered liste', hint: '1.', run: textCmd('ol') },
  { group: 'Grundblöcke', id: 'todo', label: 'To-do-Liste', desc: 'Zum Abhaken', icon: 'checkSquare', kw: 'todo checkbox haken erledigt aufgabe liste', hint: '[]', run: textCmd('todo', { checked: false }) },
  { group: 'Grundblöcke', id: 'toggle', label: 'Toggle', desc: 'Aufklappbarer Inhalt', icon: 'toggle', kw: 'toggle aufklappen einklappen details verstecken', hint: '>', run: textCmd('toggle', { open: true }) },
  { group: 'Grundblöcke', id: 'quote', label: 'Zitat', desc: 'Hervorgehobenes Zitat', icon: 'quote', kw: 'zitat quote', hint: '"', run: textCmd('quote') },
  { group: 'Grundblöcke', id: 'hr', label: 'Trennlinie', desc: 'Waagrechte Linie', icon: 'divider', kw: 'trennlinie divider linie hr trenner strich', hint: '---', run: atomCmd('hr') },
  { group: 'Grundblöcke', id: 'pagebreak', label: 'Seitenumbruch', desc: 'Neue Seite im PDF', icon: 'pagebreak', kw: 'seitenumbruch pagebreak neue seite umbruch', run: atomCmd('pagebreak') },
  { group: 'Grundblöcke', id: 'columns2', label: '2 Spalten', desc: 'Inhalt nebeneinander', icon: 'columns', kw: 'spalten columns nebeneinander grid zwei', run: columnsCmd(2) },
  { group: 'Grundblöcke', id: 'columns3', label: '3 Spalten', desc: 'Drei Spalten nebeneinander', icon: 'columns', kw: 'spalten columns nebeneinander grid drei', run: columnsCmd(3) },

  ...['merke', 'definition', 'satz', 'beispiel', 'aufgabe', 'loesung', 'hausaufgabe', 'achtung', 'tipp', 'beweis', 'zusammenfassung', 'versuch'].map(kind => ({
    group: 'Schule', id: 'callout-' + kind, label: CALLOUTS[kind].label,
    desc: { merke: 'Roter Merkkasten', definition: 'Begriff erklären', satz: 'Satz, Regel, Gesetz', beispiel: 'Beispiel zum Stoff', aufgabe: 'Aufgabenstellung', loesung: 'Lösung zum Aufklappen', hausaufgabe: 'Was bis wann zu tun ist', achtung: 'Typischer Fehler', tipp: 'Hilfe, Eselsbrücke', beweis: 'Mathematischer Beweis', zusammenfassung: 'Das Wichtigste kurz', versuch: 'Experiment / Versuch' }[kind],
    icon: CALLOUTS[kind].icon, kw: `${kind} kasten callout box ${CALLOUTS[kind].label.toLowerCase()} ${kind === 'satz' ? 'regel gesetz' : ''} ${kind === 'loesung' ? 'lösung loesung' : ''}`,
    run: calloutCmd(kind)
  })),

  { group: 'Mathe & Naturwissenschaften', id: 'math', label: 'Formel', desc: 'Formelblock (Typst oder LaTeX)', icon: 'sigma', kw: 'formel gleichung math equation latex typst mathe $$ term', hint: '$$', run: atomCmd('math', () => ({ tex: '' })) },
  { group: 'Mathe & Naturwissenschaften', id: 'imath', label: 'Formel im Text', desc: 'Formel mitten im Satz', icon: 'sigma', kw: 'inline formel math $ text', hint: '$…$', run: (ed, b) => { const t = ed.textElOf(b); if (t) openInlineMath(ed, null, t); } },
  { group: 'Mathe & Naturwissenschaften', id: 'umformung', label: 'Umformung', desc: 'Äquivalenzumformung Schritt für Schritt', icon: 'eq', kw: 'umformung äquivalenzumformung gleichung lösen aligned schritte', run: atomCmd('math', () => ({ tex: '\\begin{alignedat}{2}\nx+3 &=5 &\\qquad &\\vert\\; -3 \\\\\nx &=2\n\\end{alignedat}' })) },
  { group: 'Mathe & Naturwissenschaften', id: 'plot', label: 'Funktionsgraph', desc: 'Graph mit Nullstellen & Co.', icon: 'graph', kw: 'graph plot funktion koordinatensystem parabel gerade zeichnen', run: atomCmd('plot', () => ({ config: defaultPlotConfig() })) },
  { group: 'Mathe & Naturwissenschaften', id: 'chem', label: 'Reaktionsgleichung', desc: 'z. B. 2H₂ + O₂ → 2H₂O', icon: 'flask', kw: 'chemie reaktion reaktionsgleichung ce mhchem gleichung', run: atomCmd('chem', () => ({ tex: '' })) },
  { group: 'Mathe & Naturwissenschaften', id: 'ichem', label: 'Chemische Formel im Text', desc: 'z. B. H₂SO₄ mitten im Satz', icon: 'flask', kw: 'summenformel chemie inline formel text', run: (ed, b) => { const t = ed.textElOf(b); if (t) openInlineMath(ed, null, t, '\\ce{}'); } },
  { group: 'Mathe & Naturwissenschaften', id: 'smiles', label: 'Strukturformel', desc: 'Molekül zeichnen (Name oder SMILES)', icon: 'molecule', kw: 'strukturformel molekül smiles skelett struktur organisch', run: atomCmd('smiles', () => ({ smiles: '' })) },
  { group: 'Mathe & Naturwissenschaften', id: 'valenz', label: 'Valenzstrichformel', desc: 'Molekül mit allen H-Atomen und Elektronenpaaren', icon: 'molecule', kw: 'valenzstrichformel lewis strukturformel elektronenpaare organisch', run: atomCmd('smiles', () => ({ smiles: '', mode: 'valenz' })) },
  { group: 'Mathe & Naturwissenschaften', id: 'halbstruktur', label: 'Halbstrukturformel', desc: 'z. B. CH₃–CH₂–OH', icon: 'molecule', kw: 'halbstrukturformel rationale formel organisch', run: atomCmd('smiles', () => ({ smiles: '', mode: 'halb', info: true })) },
  { group: 'Mathe & Naturwissenschaften', id: 'table', label: 'Tabelle', desc: 'Zeilen und Spalten', icon: 'table', kw: 'tabelle table raster', run: atomCmd('table', () => emptyTable()) },
  { group: 'Mathe & Naturwissenschaften', id: 'code', label: 'Code', desc: 'Programmcode mit Farben', icon: 'code', kw: 'code programm python java quelltext informatik', hint: '```', run: atomCmd('code', () => ({ lang: '', text: '' })) },

  { group: 'Medien', id: 'image', label: 'Bild', desc: 'Foto, Skizze, Screenshot', icon: 'image', kw: 'bild foto image abbildung screenshot grafik', run: async (ed, b) => {
    const res = await ed.host.pickFiles('image');
    if (res && res.length) { const nb = ed.setType(b, 'image', { src: res[0].link, caption: '' }); ed.selectBlocks([nb]); }
    else ed.setType(b, 'image', { src: '' });
  } },
  { group: 'Medien', id: 'pdf', label: 'Arbeitsblatt (PDF)', desc: 'PDF-Seiten einbetten', icon: 'pdf', kw: 'pdf arbeitsblatt einbetten dokument blatt', run: async (ed, b) => {
    const res = await ed.host.pickFiles('pdf');
    if (res && res.length) ed.setType(b, 'pdf', { src: res[0].link, caption: res[0].name || '' });
    else ed.setType(b, 'pdf', { src: '' });
  } },
  { group: 'Medien', id: 'link', label: 'Verweis auf Eintrag', desc: 'Link zu einem anderen Eintrag', icon: 'link', kw: 'link verweis eintrag seite mention @ wiki', hint: '@', run: (ed, b) => { const t = ed.textElOf(b); if (t) ed.slash.openMention(b, t, null); } },

  { group: 'Dokument', id: 'toc', label: 'Inhaltsverzeichnis', desc: 'Alle Überschriften', icon: 'toc', kw: 'inhaltsverzeichnis toc gliederung inhalt', run: atomCmd('toc') },
  { group: 'Dokument', id: 'alignmark', label: 'Ausrichtungspunkt', desc: 'Text in Zeilen untereinander an derselben Stelle ausrichten', icon: 'alignLeft', hint: '&', kw: 'ausrichten ausrichtung ausrichtungspunkt tab tabulator tabstopp spalte &', run: (ed, b) => { const t = ed.textElOf(b); if (t) ed.insertAlignMark(t); } },
  { group: 'Dokument', id: 'footnote', label: 'Fußnote', desc: 'Anmerkung oder Quelle', icon: 'footnote', kw: 'fußnote fussnote footnote quelle anmerkung', run: (ed, b) => { const t = ed.textElOf(b); if (t) openFootnote(ed, null, t); } },
  { group: 'Dokument', id: 'date', label: 'Heutiges Datum', desc: formatDate(todayISO()), icon: 'calendar', kw: 'datum heute date', run: (ed, b) => insertText(ed, b, formatDate(todayISO())) },

  { group: 'Vorlagen', id: 'tpl-versuch', label: 'Versuchsprotokoll', desc: 'Frage, Material, Durchführung …', icon: 'beaker', kw: 'vorlage versuchsprotokoll protokoll experiment chemie physik bio', run: (ed, b) => insertTemplate(ed, b, 'versuch') },
  { group: 'Vorlagen', id: 'tpl-aufgabe', label: 'Aufgabe', desc: 'Nummer (z. B. 10a) mit eingerückter Rechnung darunter', icon: 'task', kw: 'aufgabe teilaufgabe lösung rechnung nummer einrücken übung', run: (ed, b) => insertTask(ed, b) },
  { group: 'Vorlagen', id: 'tpl-aufgaben', label: 'Übungsaufgaben', desc: 'Buch, Seite und Nummer – zentriert untereinander', icon: 'task', kw: 'vorlage übungen aufgaben buch seite nummer', run: (ed, b) => insertTemplate(ed, b, 'uebung') },
  { group: 'Vorlagen', id: 'tpl-vokabeln', label: 'Vokabeltabelle', desc: 'Wort · Übersetzung · Beispiel', icon: 'table', kw: 'vorlage vokabeln englisch latein französisch wörter', run: (ed, b) => insertTemplate(ed, b, 'vokabeln') }
];

function columnsCmd(n) {
  return (ed, b) => {
    const cols = Array.from({ length: n }, () => block('column', { children: [block('p')] }));
    const row = ed.setType(b, 'columns', { children: cols });
    ed.focusBlock(cols[0].children[0], 'start');
    return row;
  };
}

function insertText(ed, b, text) {
  document.execCommand('insertText', false, text);
}

export function templateBlocks(kind, opts = {}) {
  const p = (html = '') => block('p', { html });
  switch (kind) {
    case 'versuch': return [
      block('callout', { kind: 'versuch', html: 'Fragestellung', children: [p()] }),
      block('h2', { html: 'Material' }), block('ul', { html: '' }),
      block('h2', { html: 'Durchführung' }), block('ol', { html: '' }),
      block('h2', { html: 'Beobachtung' }), p(),
      block('h2', { html: 'Auswertung' }), p(),
      block('callout', { kind: 'merke', html: 'Ergebnis', children: [p()] })
    ];
    case 'uebung': {
      // Wie in Timos Einträgen: Überschrift, darunter zentriert "Buch" und die
      // Aufgaben, an einem Ausrichtungspunkt untereinander
      const am = '<span class="am" contenteditable="false" data-id="1"></span>';
      return [
        block(opts.headingType || 'h1', { html: 'Übungen' }),
        block('p', { html: `Buch ${am}Seite … Nummer …<br>${am}Seite … Nummer …`, align: 'center' })
      ];
    }
    case 'vokabeln': return [
      block('table', { rows: [['Wort', 'Übersetzung', 'Beispiel'], ['', '', ''], ['', '', '']], header: true, aligns: [] })
    ];
    default: return [];
  }
}

function insertTemplate(ed, b, kind) {
  // Überschrift in derselben Ebene wie die letzte Überschrift darüber
  const flat = ed.flat();
  const before = flat.slice(0, Math.max(0, flat.indexOf(b))).reverse().find(x => /^h[123]$/.test(x.type));
  const blocks = templateBlocks(kind, { headingType: before ? before.type : 'h1' });
  ed.checkpoint();
  ed.syncAll();
  if (ed.isText(b) && isEmptyHTML(b.html) && !b.children.length) {
    ed.insertAfter(b, blocks);
    ed.removeBlocks([b]);
  } else ed.insertAfter(b, blocks);
  const last = [...blocks].reverse().find(x => ed.isText(x));
  if (last) ed.focusBlock(last, 'end');
  ed.alignSoon && ed.alignSoon();
  ed.changed();
}

// ---------------------------------------------------------------------------
// Aufgabe: Nummer als Zeile, die Rechnung darunter eingerückt (wie pad(left)
// in Typst). Nummer und Rechnung bleiben so auch im PDF zusammen.
// ---------------------------------------------------------------------------

const TASK_RE = /^\s*(\d+)\s*([a-z])?\s*\)?\s*(?:\(\s*(\d+)\s*\))?\s*$/i;

function textOf(b) { return String(b.html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim(); }

// Nächste Nummer aus der letzten Aufgabe davor: 10a → 10b, 12a (1) → 12a (2), 3 → 4
export function nextTaskLabel(prev) {
  const m = prev && TASK_RE.exec(prev);
  if (!m) return '1a';
  const [, n, letter, sub] = m;
  if (sub) return `${n}${letter || ''} (${+sub + 1})`;
  if (letter) return letter.toLowerCase() === 'z' ? `${+n + 1}a` : `${n}${String.fromCharCode(letter.charCodeAt(0) + 1)}`;
  return String(+n + 1);
}

function insertTask(ed, b) {
  ed.syncAll();
  const flat = ed.flat();
  const idx = flat.indexOf(b);
  const prevTask = flat.slice(0, Math.max(0, idx)).reverse().find(x => x.type === 'p' && x !== b && TASK_RE.test(textOf(x)));
  const label = nextTaskLabel(prevTask && textOf(prevTask));
  const calc = block('math', { tex: '', align: 'left' });
  const task = block('p', { html: label, children: [calc] });
  ed.checkpoint();
  // Leere Zeile in einer Aufgabe: neue Aufgabe kommt hinter die Aufgabe, nicht hinein
  const parent = ed.parentOf(b);
  const empty = ed.isText(b) && isEmptyHTML(b.html) && !b.children.length;
  if (empty && parent && parent.type === 'p' && TASK_RE.test(textOf(parent))) {
    ed.insertAfter(parent, [task]);
    ed.removeBlocks([b]);
  } else if (empty) {
    ed.insertAfter(b, [task]);
    ed.removeBlocks([b]);
  } else ed.insertAfter(b, [task]);
  ed.changed();
  // Mit einer Aufgabe davor gleich rechnen, sonst erst die Nummer eintippen
  if (prevTask) requestAnimationFrame(() => ed.activate(calc));
  else requestAnimationFrame(() => {
    const t = ed.textElOf(task);
    if (!t) return;
    t.focus();
    const r = document.createRange();
    r.selectNodeContents(t);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

// ---------------------------------------------------------------------------
// Suche
// ---------------------------------------------------------------------------

function norm(s) {
  return String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9$#\-\[\]"@]/g, ' ');
}

function score(cmd, q) {
  if (!q) return 1;
  const label = norm(cmd.label), kw = norm(cmd.kw || ''), nq = norm(q).trim();
  if (!nq) return 1;
  if (label.startsWith(nq)) return 100 - label.length * 0.1;
  if (label.split(' ').some(w => w.startsWith(nq))) return 80;
  if (kw.split(' ').some(w => w.startsWith(nq))) return 60;
  if (label.includes(nq)) return 50;
  if (kw.includes(nq)) return 40;
  // Buchstaben in Reihenfolge (unscharf)
  let i = 0;
  for (const c of label) if (c === nq[i]) i++;
  return i === nq.length ? 10 : 0;
}

// ---------------------------------------------------------------------------
// Menü-Steuerung
// ---------------------------------------------------------------------------

export class SlashMenu {
  constructor(ed) {
    this.ed = ed;
    this.pop = null;
    this.mode = null; // 'slash' | 'mention'
  }

  isOpen() { return !!(this.pop && !this.pop.closed); }

  close() {
    if (this.pop) this.pop.close();
    this.pop = null;
    this.mode = null;
  }

  onInput(b, t, e) {
    const sel = caret.getSelectionIn(t);
    if (!sel) return;
    const plain = plainOf(t);
    if (this.isOpen() && this.block === b) {
      if (sel.start <= this.start) { this.close(); return; }
      const q = plain.slice(this.start + this.trigger.length, sel.start);
      if (/\n/.test(q) || q.length > 40 || (this.mode === 'slash' && /\s\s$/.test(q))) { this.close(); return; }
      this.query = q;
      this.refresh();
      return;
    }
    if (e.inputType !== 'insertText' || !e.data) return;
    const before = plain.slice(0, sel.start - 1);
    if (e.data === '/' && (before === '' || /[\s(]$/.test(before))) {
      this.open(b, t, sel.start - 1, 'slash', '/');
    } else if (e.data === '@' && (before === '' || /\s$/.test(before))) {
      this.open(b, t, sel.start - 1, 'mention', '@');
    } else if (e.data === '[' && before.endsWith('[')) {
      this.open(b, t, sel.start - 2, 'mention', '[[');
    }
  }

  openMention(b, t) {
    const sel = caret.getSelectionIn(t);
    this.open(b, t, sel ? sel.start : 0, 'mention', '');
  }

  open(b, t, start, mode, trigger) {
    this.close();
    this.block = b;
    this.el = t;
    this.start = start;
    this.mode = mode;
    this.trigger = trigger;
    this.query = '';
    this.active = 0;
    const list = h('div', { class: 'slash-list' });
    this.listEl = list;
    const rect = caret.caretRect() || t.getBoundingClientRect();
    this.pop = popover(rect, list, { class: 'slash-menu', onClose: () => { this.pop = null; this.mode = null; } });
    this.refresh();
  }

  items() {
    if (this.mode === 'slash') {
      return COMMANDS.map(c => ({ c, s: score(c, this.query) })).filter(x => x.s > 0)
        .sort((a, b) => (this.query ? b.s - a.s : 0)).map(x => x.c);
    }
    // Erwähnungen: Datum + Einträge
    const q = norm(this.query).trim();
    const out = [];
    const dates = [
      { label: 'Heute', date: todayISO() },
      { label: 'Morgen', date: isoPlus(1) },
      { label: 'Gestern', date: isoPlus(-1) }
    ];
    for (const d of dates) if (!q || norm(d.label).startsWith(q)) out.push({ id: 'date-' + d.label, label: `${d.label} – ${formatDate(d.date)}`, icon: 'calendar', group: 'Datum', run: () => this.insertAtTrigger(formatDate(d.date)) });
    const notes = (this.ed.host.listNotes ? this.ed.host.listNotes() : []);
    const hits = notes.map(n => ({ n, s: !q ? 1 : norm(n.name).includes(q) ? (norm(n.name).startsWith(q) ? 3 : 2) : 0 }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
    for (const { n } of hits) out.push({ id: n.uuid, label: n.name, desc: n.path, icon: n.kind === 'pdf' ? 'pdf' : 'note', group: 'Einträge', run: () => this.insertLink(n) });
    return out;
  }

  refresh() {
    const items = this.items();
    this.current = items;
    this.listEl.innerHTML = '';
    if (!items.length) {
      this.listEl.append(h('div', { class: 'slash-empty', text: this.mode === 'slash' ? 'Keine Treffer' : 'Kein Eintrag gefunden' }));
      if (this.mode === 'slash' && this.query.length > 3) this.close();
      return;
    }
    this.active = Math.min(this.active, items.length - 1);
    let group = null;
    items.forEach((it, i) => {
      if (it.group !== group && (!this.query || this.mode === 'mention')) {
        group = it.group;
        this.listEl.append(h('div', { class: 'menu-section', text: group }));
      }
      const el = h('div', { class: 'menu-item' + (i === this.active ? ' on' : '') });
      const th = h('div', { class: 'thumb' });
      th.innerHTML = it.thumb || icon(it.icon || 'text');
      el.append(th, h('div', { class: 'txt' }, h('span', { class: 't', text: it.label }), it.desc ? h('span', { class: 'd', text: it.desc }) : ''));
      if (it.hint) el.append(h('span', { class: 'hint', text: it.hint }));
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('mouseenter', () => this.setActive(i));
      el.addEventListener('click', () => this.choose(i));
      this.listEl.append(el);
    });
    this.pop && this.pop.reposition();
  }

  setActive(i) {
    this.active = i;
    const els = this.listEl.querySelectorAll('.menu-item');
    els.forEach((el, k) => el.classList.toggle('on', k === i));
    els[i] && els[i].scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    if (!this.isOpen()) return false;
    const n = this.current ? this.current.length : 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) this.setActive((this.active + 1) % n); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (n) this.setActive((this.active - 1 + n) % n); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!n) { this.close(); return false; }
      e.preventDefault();
      this.choose(this.active);
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return true; }
    return false;
  }

  // Tipptext "/abfrage" entfernen und Befehl ausführen
  async choose(i) {
    const it = this.current && this.current[i];
    if (!it) return;
    const ed = this.ed;
    const b = this.block, t = this.el;
    const sel = caret.getSelectionIn(t);
    const end = sel ? sel.start : this.start + this.trigger.length + this.query.length;
    const mode = this.mode;
    this.close();
    if (mode === 'mention') {
      this.removeRange(b, t, this.start, end);
      it.run();
      return;
    }
    ed.checkpoint();
    this.removeRange(b, t, this.start, end);
    ed.syncAll();
    try {
      await it.run(ed, b);
    } catch (err) {
      console.error(err);
      ed.ui.toast('Das hat nicht geklappt: ' + err.message, { type: 'error' });
    }
    ed.changed();
  }

  removeRange(b, t, from, to) {
    const segs = htmlToSegs(t.innerHTML);
    const [L, rest] = splitSegs(segs, from);
    const [, R] = splitSegs(rest, Math.max(0, to - from));
    this.ed.setTextHTML(b, segsToHTML(mergeSegs([...L, ...R])), { start: from });
    this.ed.dirtyText.add(b.id);
  }

  insertAtTrigger(text) {
    document.execCommand('insertText', false, text);
  }

  insertLink(n) {
    const ed = this.ed;
    const t = this.el;
    const sel = caret.getSelectionIn(t);
    const pos = sel ? sel.start : 0;
    const segs = htmlToSegs(t.innerHTML);
    const [L, R] = splitSegs(segs, pos);
    const link = { t: 'text', text: n.name, m: { a: itemLink(n.uuid) } };
    const space = { t: 'text', text: ' ', m: {} };
    ed.setTextHTML(this.block, segsToHTML(mergeSegs([...L, link, space, ...R])), { start: pos + n.name.length + 1 });
    ed.dirtyText.add(this.block.id);
    ed.changed();
  }
}

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
