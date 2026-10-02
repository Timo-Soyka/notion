// Ansicht für alle Dateien, die kein Eintrag und kein PDF sind.
//
// Je nach Dateityp (siehe core/filetypes.js): Bildeditor, Text- und
// Code-Editor, Tabelle, RTF-Textverarbeitung oder Quick-Look-Vorschau.
// Was Heft nicht verlustfrei speichern kann, lässt sich mit einem Klick im
// passenden Programm bearbeiten – über DEVONthink, damit die Datei mit der
// Datenbank verbunden bleibt.

import { h, esc, menu, toast, debounce } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { call, on, isNative, isPad } from '../bridge.js';
import { classify } from '../core/filetypes.js';
import { ImageEditor } from './imageeditor.js';

export class FileView {
  constructor(app, uuid, node, opts = {}) {
    this.app = app;
    this.uuid = uuid;
    this.node = node || { name: 'Datei', kind: 'file' };
    this.opts = opts;
    this.el = h('div', { class: 'fileview' });
  }

  async mount(container) {
    container.innerHTML = '';
    container.classList.add('no-scroll');
    container.append(this.el);
    let info = {};
    try { info = await call('file.info', { uuid: this.uuid }); } catch (e) { info = {}; }
    this.info = info;
    this.cls = classify({ ...this.node, type: info.type || this.node.type, ext: info.ext || this.node.ext, name: info.name || this.node.name });
    const V = { image: ImageEditor, text: TextView, sheet: SheetView, rich: RichView, link: LinkView }[this.cls.view] || PreviewView;
    this.impl = V === ImageEditor ? new ImageEditor(this.app, this.uuid, this.node, this.opts) : new V(this);
    await this.impl.mount(this.el);
  }

  switchTo(View) {
    const old = this.impl;
    Promise.resolve(old && old.close && old.close()).finally(() => {
      this.el.innerHTML = '';
      this.impl = new View(this);
      this.impl.mount(this.el);
    });
  }

  close() { return this.impl && this.impl.close ? this.impl.close() : undefined; }
  sendRect() { this.impl && this.impl.sendRect && this.impl.sendRect(); }
  undo() { this.impl && this.impl.undo && this.impl.undo(); }
  redo() { this.impl && this.impl.redo && this.impl.redo(); }

  // Leiste „Nur Ansicht“ mit Knöpfen zum Bearbeiten
  banner(text, actions = []) {
    const b = h('div', { class: 'file-banner' }, h('span', { html: icon('info', 'sm') }), h('span', { class: 'grow', text }));
    for (const a of actions) {
      const btn = h('button', { class: 'btn sm ' + (a.primary ? 'primary' : 'outline'), html: (a.icon ? icon(a.icon, 'sm') : '') + esc(a.label) });
      btn.addEventListener('click', (e) => a.onClick(e));
      b.append(btn);
    }
    return b;
  }

  openWithAction(label = 'Bearbeiten in …') {
    return { label, icon: 'external', primary: true, onClick: (e) => this.app.openWithMenu(e.currentTarget, this.uuid) };
  }

  rtfCopyAction() {
    return {
      label: 'Bearbeitbare Kopie (RTF)', icon: 'copy', onClick: async () => {
        const parent = this.app.lib.parentOf(this.uuid);
        try {
          const r = await call('rich.copy', { uuid: this.uuid, parent: parent ? parent.uuid : this.app.lib.root.uuid });
          await this.app.lib.refresh();
          toast(`Kopie „${r.name}“ angelegt – das Original bleibt unverändert.`, { type: 'success' });
          if (r.uuid) this.app.openRecord(r.uuid);
        } catch (e) { toast('Kopie fehlgeschlagen: ' + e.message, { type: 'error' }); }
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Native Ansicht über dem WebView (Quick Look, RTF)
// ---------------------------------------------------------------------------

class NativeOverlay {
  constructor(host) { this.host = host; }

  async open(args) {
    if (!isNative) return false;
    await new Promise(r => requestAnimationFrame(r));
    await call('overlay.open', { ...args, rect: this.rect() });
    this.ro = new ResizeObserver(() => this.sendRect());
    this.ro.observe(this.host);
    // Menüs und Dialoge liegen im HTML – solange eins offen ist, die native Ansicht ausblenden
    this.mo = new MutationObserver(() => this.check());
    this.mo.observe(document.body, { childList: true });
    return true;
  }

  rect() {
    const r = this.host.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  sendRect() { if (!this.closed && isNative) call('overlay.rect', { rect: this.rect() }); }

  async check() {
    const covered = !!document.querySelector('body > .overlay, body > .popover');
    if (covered === this.covered) return;
    this.covered = covered;
    const res = await call('overlay.visible', { visible: !covered });
    let snap = this.host.querySelector('.pdf-snapshot');
    if (covered && res && res.snapshot) {
      if (!snap) { snap = h('div', { class: 'pdf-snapshot' }); this.host.append(snap); }
      snap.style.backgroundImage = `url(${res.snapshot})`;
      snap.style.backgroundSize = '100% 100%';
    } else if (snap) snap.remove();
  }

  close() {
    this.closed = true;
    this.ro && this.ro.disconnect();
    this.mo && this.mo.disconnect();
    if (isNative) return call('overlay.close', {});
  }
}

// ---------------------------------------------------------------------------
// Vorschau (Quick Look) – Pages, Word, Excel, Audio, Video, Webseiten …
// ---------------------------------------------------------------------------

class PreviewView {
  constructor(fv) { this.fv = fv; }

  async mount(root) {
    const { cls } = this.fv;
    const bar = [];
    if (cls.office || cls.toRtf || cls.alt) {
      const acts = [this.fv.openWithAction()];
      if (cls.toRtf) acts.push(this.fv.rtfCopyAction());
      if (cls.alt === 'text') acts.push({ label: 'Quelltext', icon: 'code', onClick: () => this.fv.switchTo(TextView) });
      const what = cls.office ? `${cls.label}: Heft zeigt es an. Zum Bearbeiten öffnest du es im passenden Programm – DEVONthink übernimmt die Änderungen.`
        : `${cls.label}: Vorschau.`;
      bar.push(this.fv.banner(what, acts));
    }
    this.host = h('div', { class: 'pdf-host file-preview' + (cls.media ? ' media' : '') });
    root.append(...bar, this.host);
    this.overlay = new NativeOverlay(this.host);
    if (!await this.overlay.open({ uuid: this.fv.uuid, mode: cls.media ? 'media' : 'quicklook' })) {
      this.host.append(h('div', { class: 'file-empty' }, h('span', { html: icon('file') }), h('p', { text: `${cls.label} – die Vorschau gibt es nur in der App.` })));
    }
  }

  sendRect() { this.overlay && this.overlay.sendRect(); }
  close() { return this.overlay && this.overlay.close(); }
}

// ---------------------------------------------------------------------------
// Lesezeichen
// ---------------------------------------------------------------------------

class LinkView {
  constructor(fv) { this.fv = fv; }
  async mount(root) {
    const url = this.fv.info.url || '';
    const open = h('button', { class: 'btn primary', html: icon('external', 'sm') + 'Im Browser öffnen' });
    open.addEventListener('click', () => call('open.url', { url }));
    root.append(h('div', { class: 'file-empty' }, h('span', { html: icon('link') }), h('p', { class: 'file-url', text: url || 'Keine Adresse' }), url ? open : ''));
  }
}

// ---------------------------------------------------------------------------
// Text und Code
// ---------------------------------------------------------------------------

class TextView {
  constructor(fv) { this.fv = fv; }

  async mount(root) {
    const { cls, uuid } = this.fv;
    let res;
    try { res = await call('file.text', { uuid }); }
    catch (e) { root.append(h('div', { class: 'file-empty', text: 'Datei kann nicht gelesen werden: ' + e.message })); return; }
    this.editable = !!cls.editable && cls.view === 'text';
    this.lang = cls.lang || 'plaintext';
    this.text = res.text || '';
    this.wrap = localStorage.getItem('heft-code-wrap') === '1';
    this.fontSize = +localStorage.getItem('heft-code-size') || 13;
    if (!this.editable) {
      const acts = [this.fv.openWithAction()];
      if (cls.view === 'preview' || cls.alt) acts.push({ label: 'Vorschau', icon: 'eye', onClick: () => this.fv.switchTo(PreviewView) });
      root.append(this.fv.banner(`${cls.label}: Nur Ansicht – DEVONthink lässt Heft diesen Dateityp nicht speichern. Bearbeiten geht im passenden Programm.`, acts));
    }
    const tb = h('div', { class: 'pdf-toolbar code-toolbar' });
    const info = h('span', { class: 'hint code-info' });
    const wrapBtn = h('button', { class: 'tool-btn' + (this.wrap ? ' on' : ''), 'data-tip': 'Lange Zeilen umbrechen', html: icon('turn', 'sm') + '<span>Umbruch</span>' });
    wrapBtn.addEventListener('click', () => { this.wrap = !this.wrap; localStorage.setItem('heft-code-wrap', this.wrap ? '1' : '0'); wrapBtn.classList.toggle('on', this.wrap); this.area.classList.toggle('wrap', this.wrap); this.render(); });
    const smaller = h('button', { class: 'tool-btn', 'data-tip': 'Schrift kleiner', html: icon('zoomOut', 'sm') });
    const bigger = h('button', { class: 'tool-btn', 'data-tip': 'Schrift größer', html: icon('zoomIn', 'sm') });
    const setSize = (d) => { this.fontSize = Math.max(9, Math.min(24, this.fontSize + d)); localStorage.setItem('heft-code-size', this.fontSize); this.scroll.style.setProperty('--code-size', this.fontSize + 'px'); this.render(); };
    smaller.addEventListener('click', () => setSize(-1));
    bigger.addEventListener('click', () => setSize(1));
    tb.append(h('span', { class: 'code-lang', text: cls.label }), info, h('span', { class: 'grow' }), wrapBtn, smaller, bigger);
    this.info = info;
    this.gutter = h('pre', { class: 'code-gutter', 'aria-hidden': 'true' });
    this.code = h('code', { class: 'hljs' });
    this.pre = h('pre', { class: 'code-hl' }, this.code);
    this.ta = h('textarea', { class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
    this.ta.value = this.text;
    this.ta.readOnly = !this.editable;
    this.area = h('div', { class: 'code-area' + (this.wrap ? ' wrap' : '') }, this.pre, this.ta);
    this.scroll = h('div', { class: 'code-scroll' }, h('div', { class: 'code-inner' }, this.gutter, this.area));
    this.scroll.style.setProperty('--code-size', this.fontSize + 'px');
    root.append(tb, this.scroll);
    this.encoding = res.encoding;
    const rerender = debounce(() => this.render(), this.text.length > 50000 ? 250 : 40);
    this.ta.addEventListener('input', () => {
      this.text = this.ta.value;
      this.pre.style.minHeight = '';
      rerender();
      if (this.editable) this.changed();
    });
    this.ta.addEventListener('keydown', (e) => this.keydown(e));
    this.render();
    if (this.editable) setTimeout(() => this.ta.focus(), 30);
  }

  highlight(text) {
    const hl = window.hljs;
    if (!hl || this.lang === 'plaintext' || text.length > 200000) return esc(text);
    try { return hl.highlight(text, { language: this.lang, ignoreIllegals: true }).value; } catch { return esc(text); }
  }

  render() {
    const text = this.text;
    this.code.innerHTML = this.highlight(text) + '\n';
    const lines = text.split('\n').length;
    this.gutter.textContent = this.wrap ? '' : Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    this.gutter.style.display = this.wrap ? 'none' : '';
    this.info.textContent = `${lines.toLocaleString('de-DE')} Zeilen · ${this.encoding || 'UTF-8'}`;
  }

  keydown(e) {
    if (e.key === 'Tab' && this.editable) {
      e.preventDefault();
      const indent = /\n\t/.test(this.text) ? '\t' : '    ';
      document.execCommand('insertText', false, indent);
    }
  }

  changed() {
    this.fv.app.setSaveState('dirty');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.editable || this.savedText === this.text) return;
    const text = this.text;
    this.fv.app.setSaveState('saving');
    try {
      await call('file.saveText', { uuid: this.fv.uuid, text });
      this.savedText = text;
      this.fv.app.setSaveState(this.text === text ? 'saved' : 'dirty');
    } catch (e) {
      this.fv.app.setSaveState('error');
      toast('Nicht gespeichert: ' + e.message, { type: 'error' });
    }
  }

  close() { return this.saveNow(); }
  undo() { document.execCommand('undo'); }
  redo() { document.execCommand('redo'); }
}

// ---------------------------------------------------------------------------
// Tabellen (CSV/TSV)
// ---------------------------------------------------------------------------

export function parseCSV(text) {
  const first = (text.split('\n')[0] || '');
  const delim = [['\t', (first.match(/\t/g) || []).length], [';', (first.match(/;/g) || []).length], [',', (first.match(/,/g) || []).length]].sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

class SheetView {
  constructor(fv) { this.fv = fv; }

  async mount(root) {
    const { cls, uuid } = this.fv;
    this.editable = !!cls.editable;
    let columns = [], cells = [];
    try {
      const r = await call('sheet.read', { uuid });
      columns = r.columns || []; cells = r.cells || [];
    } catch { /* unten mit Text versuchen */ }
    if (!columns.length && !cells.length) {
      try {
        const t = await call('file.text', { uuid });
        const rows = parseCSV(t.text || '');
        columns = rows.shift() || [];
        cells = rows;
      } catch (e) { root.append(h('div', { class: 'file-empty', text: 'Tabelle kann nicht gelesen werden: ' + e.message })); return; }
      this.editable = false;
    }
    this.columns = columns;
    this.cells = cells.map(r => columns.map((_, i) => r[i] ?? ''));
    if (!this.editable) root.append(this.fv.banner(`${cls.label}: Nur Ansicht.`, [this.fv.openWithAction()]));
    const tb = h('div', { class: 'pdf-toolbar' }, h('span', { class: 'code-lang', text: cls.label }), this.count = h('span', { class: 'hint code-info' }), h('span', { class: 'grow' }));
    if (this.editable) {
      const add = h('button', { class: 'tool-btn', html: icon('plus', 'sm') + '<span>Zeile</span>', 'data-tip': 'Zeile am Ende anfügen' });
      add.addEventListener('click', () => { this.cells.push(this.columns.map(() => '')); this.render(); this.changed(); this.focusCell(this.cells.length - 1, 0); });
      tb.append(add);
    }
    this.table = h('table', { class: 'sheet-table' });
    this.scroll = h('div', { class: 'sheet-scroll' }, this.table);
    root.append(tb, this.scroll);
    this.render();
  }

  render() {
    const t = this.table;
    t.innerHTML = '';
    const head = h('tr', {}, h('th', { class: 'rownum' }), ...this.columns.map(c => h('th', { text: c })));
    t.append(h('thead', {}, head));
    const body = h('tbody');
    this.cells.forEach((row, r) => {
      const tr = h('tr');
      const num = h('td', { class: 'rownum', text: String(r + 1) });
      if (this.editable) num.addEventListener('click', () => menu(num, [
        { label: 'Zeile darüber einfügen', icon: 'arrowUp', onSelect: () => { this.cells.splice(r, 0, this.columns.map(() => '')); this.render(); this.changed(); } },
        { label: 'Zeile darunter einfügen', icon: 'arrowDown', onSelect: () => { this.cells.splice(r + 1, 0, this.columns.map(() => '')); this.render(); this.changed(); } },
        '-',
        { label: 'Zeile löschen', icon: 'trash', danger: true, onSelect: () => { this.cells.splice(r, 1); this.render(); this.changed(); } }
      ]));
      tr.append(num);
      row.forEach((v, c) => {
        const td = h('td', { text: v });
        if (this.editable) {
          td.contentEditable = 'plaintext-only';
          td.addEventListener('input', () => { this.cells[r][c] = td.textContent; this.changed(); });
          td.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.focusCell(r + 1, c); }
            if (e.key === 'Tab') { e.preventDefault(); const n = r * row.length + c + (e.shiftKey ? -1 : 1); this.focusCell(Math.floor(n / row.length), n % row.length); }
          });
        }
        tr.append(td);
      });
      body.append(tr);
    });
    t.append(body);
    this.count.textContent = `${this.cells.length} Zeilen · ${this.columns.length} Spalten`;
  }

  focusCell(r, c) {
    const td = this.table.querySelectorAll('tbody tr')[r]?.children[c + 1];
    if (!td) return;
    td.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(td);
  }

  changed() {
    this.fv.app.setSaveState('dirty');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 900);
    this.dirty = true;
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.dirty) return;
    this.dirty = false;
    this.fv.app.setSaveState('saving');
    try {
      await call('sheet.write', { uuid: this.fv.uuid, cells: this.cells });
      this.fv.app.setSaveState(this.dirty ? 'dirty' : 'saved');
    } catch (e) {
      this.dirty = true;
      this.fv.app.setSaveState('error');
      toast('Tabelle nicht gespeichert: ' + e.message, { type: 'error' });
    }
  }

  close() { return this.saveNow(); }
}

// ---------------------------------------------------------------------------
// RTF-Textverarbeitung (native Textansicht, Werkzeugleiste in HTML)
// ---------------------------------------------------------------------------

const TEXT_COLORS = [['#000000', 'Schwarz'], ['#e03131', 'Rot'], ['#1971c2', 'Blau'], ['#2f9e44', 'Grün'], ['#f08c00', 'Orange'], ['#7048e8', 'Lila'], ['#868e96', 'Grau']];
const HIGHLIGHT = [[null, 'Keine'], ['#ffec99', 'Gelb'], ['#b2f2bb', 'Grün'], ['#a5d8ff', 'Blau'], ['#fcc2d7', 'Rosa']];
const FAMILIES = ['Helvetica Neue', 'Avenir Next', 'Times New Roman', 'Georgia', 'Palatino', 'Menlo', 'Noteworthy', 'Chalkboard SE'];

class RichView {
  constructor(fv) { this.fv = fv; }

  async mount(root) {
    const { cls, uuid } = this.fv;
    this.editable = !!cls.editable;
    if (!this.editable) {
      const acts = [this.fv.openWithAction()];
      if (cls.toRtf) acts.push(this.fv.rtfCopyAction());
      root.append(this.fv.banner(`${cls.label}: Nur Ansicht – DEVONthink kann dieses Format nicht aus Heft heraus speichern.`, acts));
    } else root.append(this.toolbar());
    this.host = h('div', { class: 'pdf-host rich-host' });
    root.append(this.host);
    this.off = on('rich-state', (st) => this.onState(st));
    this.overlay = new NativeOverlay(this.host);
    if (!await this.overlay.open({ uuid, mode: 'rich', editable: this.editable })) {
      this.host.append(h('div', { class: 'file-empty', text: 'Die Textverarbeitung gibt es nur in der Mac-App.' }));
    }
  }

  cmd(cmd, value) { return call('overlay.action', { cmd, value }).then(() => call('overlay.action', { cmd: 'focus' })); }

  toolbar() {
    const tb = h('div', { class: 'pdf-toolbar rich-toolbar' });
    const btn = (ic, tip, fn, cls = '') => { const b = h('button', { class: 'tool-btn ' + cls, 'data-tip': tip, html: icon(ic, 'sm') }); b.addEventListener('click', fn); tb.append(b); return b; };
    const sep = () => tb.append(h('span', { class: 'sep' }));
    const style = h('button', { class: 'tool-btn', html: '<span>Stil</span>' + icon('chevronDown', 'sm') });
    style.addEventListener('click', () => menu(style, [['title', 'Titel'], ['heading', 'Überschrift'], ['subheading', 'Unterüberschrift'], ['body', 'Text']].map(([v, l]) => ({ label: l, onSelect: () => this.cmd('style', v) }))));
    tb.append(style);
    this.familyBtn = h('button', { class: 'tool-btn rich-family', html: '<span>Schrift</span>' + icon('chevronDown', 'sm') });
    this.familyBtn.addEventListener('click', () => menu(this.familyBtn, FAMILIES.map(f => ({ label: f, html: `<span style="font-family:'${f}'">Aa</span>`, checked: this.state && this.state.family === f, onSelect: () => this.cmd('family', f) }))));
    tb.append(this.familyBtn);
    btn('chevronDown', 'Kleiner', () => this.cmd('size', Math.max(6, Math.round(((this.state && this.state.size) || 13) - 1))));
    this.sizeEl = h('span', { class: 'imged-size', text: '13' });
    tb.append(this.sizeEl);
    btn('chevronUp', 'Größer', () => this.cmd('size', Math.round(((this.state && this.state.size) || 13) + 1)));
    sep();
    this.bBold = btn('bold', 'Fett (⌘B)', () => this.cmd('bold'));
    this.bItalic = btn('italic', 'Kursiv (⌘I)', () => this.cmd('italic'));
    this.bUnder = btn('underline', 'Unterstrichen (⌘U)', () => this.cmd('underline'));
    this.bStrike = btn('strike', 'Durchgestrichen', () => this.cmd('strike'));
    const color = btn('palette', 'Schriftfarbe', () => menu(color, TEXT_COLORS.map(([c, l]) => ({ label: l, html: `<span class="swatch" style="background:${c}"></span>`, onSelect: () => this.cmd('color', c) }))));
    const hl = btn('highlighter', 'Markieren', () => menu(hl, HIGHLIGHT.map(([c, l]) => ({ label: l, html: `<span class="swatch" style="background:${c || 'transparent'}"></span>`, onSelect: () => this.cmd('highlight', c) }))));
    sep();
    this.aligns = {};
    for (const [a, ic, tip] of [['left', 'alignLeft', 'Linksbündig'], ['center', 'alignCenter', 'Zentriert'], ['right', 'alignRight', 'Rechtsbündig'], ['justify', 'alignJustify', 'Blocksatz']]) this.aligns[a] = btn(ic, tip, () => this.cmd('align', a));
    sep();
    btn('list', 'Aufzählung', () => this.cmd('bullets'));
    btn('listOrdered', 'Nummerierung', () => this.cmd('numbers'));
    btn('outdent', 'Ausrücken', () => this.cmd('outdent'));
    btn('indent', 'Einrücken', () => this.cmd('indent'));
    btn('superscript', 'Hochgestellt', () => this.cmd('superscript'));
    btn('subscript', 'Tiefgestellt', () => this.cmd('subscript'));
    tb.append(h('span', { class: 'grow' }));
    if (!isPad) {
      btn('zoomOut', 'Verkleinern', () => call('overlay.action', { cmd: 'zoomOut' }));
      btn('zoomIn', 'Vergrößern', () => call('overlay.action', { cmd: 'zoomIn' }));
    }
    return tb;
  }

  onState(st) {
    if (!st || (st.uuid && st.uuid !== this.fv.uuid)) return;
    if (st.saved !== undefined || st.saving) this.fv.app.setSaveState(st.saving ? 'saving' : st.dirty ? 'dirty' : 'saved');
    if (st.size === undefined || !this.sizeEl) return;
    this.state = st;
    this.sizeEl.textContent = String(Math.round(st.size));
    this.bBold.classList.toggle('on', !!st.bold);
    this.bItalic.classList.toggle('on', !!st.italic);
    this.bUnder.classList.toggle('on', !!st.underline);
    this.bStrike.classList.toggle('on', !!st.strike);
    for (const [a, b] of Object.entries(this.aligns)) b.classList.toggle('on', st.align === a);
    const fam = this.familyBtn.querySelector('span');
    if (fam) { fam.textContent = st.family || 'Schrift'; fam.style.fontFamily = st.family ? `'${st.family}'` : ''; }
  }

  sendRect() { this.overlay && this.overlay.sendRect(); }
  undo() { call('overlay.action', { cmd: 'undo' }); }
  redo() { call('overlay.action', { cmd: 'redo' }); }
  close() {
    this.off && this.off();
    return this.overlay && this.overlay.close();
  }
}
