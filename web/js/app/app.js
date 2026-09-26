// Das App-Gerüst: verbindet Seitenleiste, Editor, PDF-Ansicht und die
// Mac-App. Hier wird auch gespeichert (verzögert, sobald man kurz aufhört
// zu tippen) und beim Wechseln des Eintrags sofort.

import { h, esc, menu, toast, confirmDialog, promptDialog, initTooltips, debounce, formatDate, relativeTime, todayISO, mod } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { call, on, isNative, uuidFromLink, itemLink } from '../bridge.js';
import { parseDocument, serializeDocument, block } from '../core/markdown.js';
import { Editor } from '../editor/editor.js';
import { Library } from './library.js';
import { Sidebar } from './sidebar.js';
import { openPalette } from './palette.js';
import { defaultFontPt, openSettings, renderOnboarding, renderDatabasePicker, withDefaults } from './settings.js';
import { PDFView } from './pdfview.js';
import { HEADING_STYLES, LIST_STYLES, nextEntryNumber } from '../core/numbering.js';
import { topicChain } from '../core/filing.js';
import { filingDialog } from './filing.js';
import { FileView } from './fileview.js';
import { pickDocument } from './linkpicker.js';
import { iconFor } from '../core/filetypes.js';

export class App {
  constructor(root) {
    this.root = root;
    this.lib = new Library();
    this.settings = withDefaults({});
    this.current = null;
    this.editor = null;
    this.pdfView = null;
    this.fileView = null;
    this.dirty = false;
    this.saving = null;
    this.selectedGroup = null;
    this.scheduleSave = debounce(() => this.saveNow(), 700);
    this.buildDOM();
    initTooltips();
    this.bindKeys();
    this.bindNative();
  }

  buildDOM() {
    this.el = h('div', { id: 'app', class: isNative ? 'native' : '' });
    this.sidebar = new Sidebar(this);
    this.main = h('main', { class: 'main' });
    this.topbar = h('div', { class: 'topbar', 'data-drag-region': '' });
    this.view = h('div', { class: 'view' });
    this.main.append(this.topbar, this.view);
    this.el.append(this.sidebar.el, this.main);
    this.root.append(this.el);
    window.addEventListener('resize', () => this.layoutChanged());
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async boot() {
    try { this.settings = withDefaults(await call('settings.get')); } catch { this.settings = withDefaults({}); }
    this.applyTheme();
    this.sidebar.el.style.display = 'none';
    this.renderTopbar();
    if (!this.settings.configured) { await renderOnboarding(this, this.view); return; }
    // Bei jedem Start zuerst die Datenbank wählen (im Browser-Testaufbau nicht)
    if (isNative) { await renderDatabasePicker(this, this.view); return; }
    this.start();
  }

  // Zur Datenbankauswahl zurück (Seitenleiste unten oder Menü „Ablage“)
  async switchDatabase() {
    await this.leaveNote();
    this.current = null;
    this.sidebar.el.style.display = 'none';
    this.renderTopbar();
    await renderDatabasePicker(this, this.view);
  }

  async start() {
    this.sidebar.el.style.display = '';
    this.sidebar.renderTree();
    this.checkDT();
    const last = localStorage.getItem('heft-last');
    try { await this.lib.refresh(); }
    catch (e) { toast('Bibliothek konnte nicht geladen werden: ' + e.message, { type: 'error' }); }
    const lastNode = last && this.lib.index.get(last);
    if (lastNode) {
      this.openRecord(last);
    } else this.showHome();
    this.layoutChanged();
  }

  applyTheme() {
    const t = this.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    if (isNative) call('window.theme', { theme: t || 'system' }).catch(() => {});
  }

  async updateSettings(patch) {
    this.settings = withDefaults({ ...this.settings, ...patch });
    try { await call('settings.set', { settings: patch }); } catch (e) { toast('Einstellungen nicht gespeichert: ' + e.message, { type: 'error' }); }
    return this.settings;
  }

  refreshEditorSettings() {
    if (!this.editor) return;
    this.editor.settings = this.settings;
    this.editor.applyMeta();
    this.editor.renderAll();
  }

  async checkDT(verbose) {
    try {
      const st = await call('dt.status');
      if (st.running) this.sidebar.setStatus('', `DEVONthink · ${this.settings.databaseName || 'verbunden'}`);
      else this.sidebar.setStatus('off', 'DEVONthink nicht gestartet');
      if (verbose) toast(st.running ? 'DEVONthink ist verbunden.' : 'DEVONthink läuft nicht – es wird beim nächsten Speichern gestartet.', { type: st.running ? 'success' : 'info' });
    } catch {
      this.sidebar.setStatus('off', 'Keine Verbindung');
    }
  }

  // -------------------------------------------------------------------------
  // Tastatur und Mac-Menü
  // -------------------------------------------------------------------------

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (!mod(e) || document.querySelector('.overlay')) return;
      const k = e.key.toLowerCase();
      const inEditable = e.target.closest && e.target.closest('[contenteditable="true"], input, textarea');
      const hasTextSel = !window.getSelection().isCollapsed;
      if (k === 'k' && !e.shiftKey && !(inEditable && hasTextSel)) { e.preventDefault(); this.openPalette(); return; }
      if (k === 'o' && !e.shiftKey) { e.preventDefault(); this.openPalette(); return; }
      if (!isNative) {
        // Im Browser gibt es kein Mac-Menü – dieselben Kürzel hier
        if (k === 'n' && !e.shiftKey) { e.preventDefault(); this.newNote(); }
        else if (k === 'n' && e.shiftKey) { e.preventDefault(); this.newFolder(); }
        else if (e.key === '\\') { e.preventDefault(); this.toggleSidebar(); }
        else if (k === ',') { e.preventDefault(); this.openSettings(); }
        else if (k === 'p' && e.shiftKey) { e.preventDefault(); this.exportCompanion(); }
      }
    });
  }

  bindNative() {
    on('menu', ({ cmd }) => this.command(cmd));
    on('open-record', ({ uuid }) => this.openRecord(uuid));
    on('will-quit', async () => { await this.saveNow(); await this.leaveNote(); call('app.quitReady', {}); });
    on('app-active', () => { this.lib.refresh(); this.checkDT(); this.reloadIfChanged(); });
    on('tree-changed', () => this.sidebar.renderTree());
    on('toast', ({ message, type }) => toast(message, { type }));
  }

  command(cmd) {
    const ed = this.editor;
    switch (cmd) {
      case 'newNote': return this.newNote();
      case 'newFolder': return this.newFolder();
      case 'search': return this.openPalette();
      case 'settings': return this.openSettings();
      case 'toggleSidebar': return this.toggleSidebar();
      case 'importPDF': return this.importPDF();
      case 'companion': return this.exportCompanion();
      case 'exportPDF': return this.exportPDF();
      case 'print': return this.print();
      case 'revealDT': return this.current && call('record.reveal', { uuid: this.current.uuid });
      case 'undo': case 'redo': {
        // Formelfeld und Eingabefelder haben ihr eigenes Widerrufen
        const a = document.activeElement;
        if (a && a.tagName === 'MATH-FIELD') { a.executeCommand(cmd); return; }
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) { document.execCommand(cmd); return; }
        if (ed) cmd === 'undo' ? ed.undo() : ed.redo(); else if (this.pdfView) this.pdfView.action(cmd); else if (this.fileView) this.fileView[cmd]();
        return;
      }
      case 'home': return this.showHome();
      case 'switchDB': return this.switchDatabase();
      case 'scan': return this.scanFromPhone();
      default: return;
    }
  }

  // -------------------------------------------------------------------------
  // Kopfzeile
  // -------------------------------------------------------------------------

  renderTopbar() {
    const tb = this.topbar;
    tb.innerHTML = '';
    if (this.sidebar.el.classList.contains('collapsed')) {
      const open = h('button', { class: 'btn icon-only', 'data-tip': 'Seitenleiste einblenden', 'data-kbd': '⌘\\', html: icon('sidebar') });
      open.addEventListener('click', () => this.toggleSidebar());
      tb.append(open);
    }
    const crumbs = h('div', { class: 'crumbs' });
    tb.append(crumbs);
    const cur = this.current;
    if (cur && (cur.kind === 'note' || cur.kind === 'pdf' || cur.kind === 'file')) {
      const node = this.lib.index.get(cur.uuid);
      const chain = node ? this.lib.ancestors(cur.uuid) : [];
      const parent = node && node.parent;
      const bundle = parent && parent.kind === 'bundle' ? parent : null;
      const shown = chain.slice(-3);
      if (chain.length > shown.length) crumbs.append(h('span', { class: 'crumb dim', text: '…' }), h('span', { class: 'crumb-sep', text: '/' }));
      for (const g of shown) {
        if (bundle && g.uuid === bundle.uuid) continue;
        const c = h('span', { class: 'crumb dim', text: g.name });
        c.addEventListener('click', () => { this.sidebar.expanded.add(g.uuid); this.sidebar.saveExpanded(); this.sidebar.reveal(g.uuid); });
        crumbs.append(c, h('span', { class: 'crumb-sep', text: '/' }));
      }
      const crumbIcon = cur.kind === 'file' ? iconFor((node && node.node) || { kind: 'file', name: cur.name }) : cur.kind === 'pdf' ? 'pdf' : 'note';
      const titleCrumb = h('span', { class: 'crumb', html: icon(crumbIcon, 'sm') + `<span class="t">${esc(cur.name || 'Unbenannt')}</span>` });
      this.titleCrumb = titleCrumb.querySelector('.t');
      crumbs.append(titleCrumb);
    } else if (cur && cur.kind === 'home') {
      crumbs.append(h('span', { class: 'crumb', html: icon('home', 'sm') + 'Startseite' }));
    }
    const actions = h('div', { class: 'topbar-actions' });
    this.saveStateEl = h('span', { class: 'save-state' });
    actions.append(this.saveStateEl);
    if (cur && cur.kind === 'note') {
      const pdfBtn = h('button', { class: 'btn', 'data-tip': 'PDF-Fassung neben dem Eintrag in DEVONthink ablegen', 'data-kbd': '⌘⇧P', html: icon('download', 'sm') + 'Als PDF ablegen' });
      pdfBtn.addEventListener('click', () => this.exportCompanion());
      const more = h('button', { class: 'btn icon-only', 'data-tip': 'Mehr', html: icon('more') });
      more.addEventListener('click', () => this.noteMenu(more));
      actions.append(pdfBtn, more);
    } else if (cur && cur.kind === 'file') {
      if (cur.back) {
        const back = h('button', { class: 'btn', html: icon('chevronLeft', 'sm') + 'Zurück zum Eintrag' });
        back.addEventListener('click', () => this.openRecord(cur.back));
        actions.append(back);
      }
      const ow = h('button', { class: 'btn', 'data-tip': 'In einem anderen Programm bearbeiten', html: icon('external', 'sm') + 'Öffnen mit' + icon('chevronDown', 'sm') });
      ow.addEventListener('click', () => this.openWithMenu(ow, cur.uuid));
      const dt = h('button', { class: 'btn icon-only', 'data-tip': 'In DEVONthink zeigen', html: icon('database') });
      dt.addEventListener('click', () => call('record.reveal', { uuid: cur.uuid }));
      actions.append(ow, dt);
    } else if (cur && cur.kind === 'pdf') {
      const dt = h('button', { class: 'btn', html: icon('database', 'sm') + 'In DEVONthink' });
      dt.addEventListener('click', () => call('record.reveal', { uuid: cur.uuid }));
      actions.append(dt);
    }
    tb.append(actions);
    this.layoutChanged();
  }

  setSaveState(state) {
    const el = this.saveStateEl;
    if (!el) return;
    el.className = 'save-state' + (state === 'error' ? ' error' : '');
    el.textContent = { saving: 'Speichert …', saved: 'Gespeichert', dirty: 'Bearbeitet', error: 'Nicht gespeichert!' }[state] || '';
    if (state === 'saved') {
      clearTimeout(this._savedT);
      this._savedT = setTimeout(() => { if (el.textContent === 'Gespeichert') el.textContent = ''; }, 2500);
    }
  }

  noteMenu(anchor) {
    const ed = this.editor;
    if (!ed) return;
    const m = ed.doc.meta;
    const s = this.settings;
    const font = m.font || s.font;
    const numbering = m.numbering !== undefined ? m.numbering : s.numbering;
    const fontRow = h('div', { class: 'segmented', style: { width: '100%', display: 'flex', margin: '4px 0 6px' } });
    for (const [v, l, f] of [['sans', 'Standard', 'var(--font-sans)'], ['serif', 'Serif', 'var(--font-serif)'], ['mono', 'Mono', 'var(--font-mono)']]) {
      const b = h('button', { class: font === v ? 'on' : '', style: { flex: '1', fontFamily: f, height: '44px', fontSize: '15px' } }, h('div', {}, 'Ag'), h('div', { style: { fontSize: '11px', fontFamily: 'var(--font-ui)' }, text: l }));
      b.addEventListener('click', () => { ed.setMeta({ font: v }); fontRow.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
      fontRow.append(b);
    }
    menu(anchor, [
      { section: 'Stil' },
      { custom: h('div', { style: { padding: '0 6px' } }, fontRow) },
      { label: 'Schriftgröße', icon: 'type', submenu: (() => {
        const std = s.fontSize || defaultFontPt(font);
        const cur = Number(m.fontSize) || 0;
        const fmt = (v) => String(v).replace('.', ',') + ' pt';
        return [
          { label: `Standard (${fmt(std)})`, checked: !cur && !m.smallText, onSelect: () => ed.setMeta({ fontSize: undefined, smallText: undefined }) },
          '-',
          ...[10, 11, 12, 13, 14, 16].map(v => ({ label: fmt(v), checked: cur === v, onSelect: () => ed.setMeta({ fontSize: v, smallText: undefined }) })),
          '-',
          { label: 'Standard einstellen …', icon: 'gear', onSelect: () => openSettings(this, 'editor') }
        ];
      })() },
      { label: 'Volle Breite', icon: 'columns', checked: !!m.fullWidth, onSelect: () => ed.setMeta({ fullWidth: !m.fullWidth || undefined }) },
      { label: 'Zeilennummern', icon: 'listOrdered', submenu: [
        { label: 'Aus', checked: !m.lineNumbers, onSelect: () => ed.setMeta({ lineNumbers: undefined }) },
        { label: 'Jede Zeile', checked: Number(m.lineNumbers) === 1, onSelect: () => ed.setMeta({ lineNumbers: 1 }) },
        { label: 'Jede 5. Zeile', checked: Number(m.lineNumbers) === 5, onSelect: () => ed.setMeta({ lineNumbers: 5 }) },
        { label: 'Jede 10. Zeile', checked: Number(m.lineNumbers) === 10, onSelect: () => ed.setMeta({ lineNumbers: 10 }) }
      ] },
      { label: 'Nummerierung', icon: 'listOrdered', submenu: (() => {
        const o = ed.numberingOpts();
        const own = ['numbering', 'numberDepth', 'numberPrefix', 'listStyle'].some(k => m[k] !== undefined);
        return [
          { section: 'Überschriften' },
          ...HEADING_STYLES.map(([v, l]) => ({ label: l, checked: (numbering || '') === v, onSelect: () => ed.setMeta({ numbering: v }) })),
          { label: 'Bis Ebene', icon: 'heading', submenu: [1, 2, 3].map(d => ({ label: `Ebene ${d}`, checked: o.depth === d, onSelect: () => ed.setMeta({ numberDepth: d }) })) },
          { label: m.number ? `Mit Eintragsnummer (${m.number}.1)` : 'Mit Eintragsnummer', checked: !!o.prefix, disabled: !m.number, onSelect: () => ed.setMeta({ numberPrefix: !o.prefix, numbering: numbering || '1.1' }) },
          { section: 'Listen' },
          ...LIST_STYLES.map(([v, l]) => ({ label: l, checked: o.listStyle === v, onSelect: () => { ed.setMeta({ listStyle: v }); } })),
          '-',
          own ? { label: 'Standard verwenden', icon: 'refresh', onSelect: () => ed.setMeta({ numbering: undefined, numberDepth: undefined, numberPrefix: undefined, listStyle: undefined }) } : null,
          { label: 'Standard einstellen …', icon: 'gear', onSelect: () => openSettings(this, 'numbering') }
        ];
      })() },
      { label: 'Nummer des Eintrags …', icon: 'hash', onSelect: () => ed.editNumber() },
      '-',
      { label: 'Als PDF ablegen', icon: 'download', hint: '⌘⇧P', onSelect: () => this.exportCompanion() },
      { label: 'Als PDF exportieren …', icon: 'upload', hint: '⌘⌥P', onSelect: () => this.exportPDF() },
      { label: 'Drucken …', icon: 'printer', hint: '⌘P', onSelect: () => this.print() },
      '-',
      { label: 'In DEVONthink zeigen', icon: 'database', hint: '⌘⇧D', onSelect: () => call('record.reveal', { uuid: this.current.uuid }) },
      { label: 'Link kopieren', icon: 'link', onSelect: async () => { await navigator.clipboard.writeText(itemLink(this.current.uuid)); toast('Link kopiert', { type: 'success', timeout: 1500 }); } },
      { label: (s.favorites || []).includes(this.currentNodeUuid()) ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: 'star', onSelect: () => this.toggleFavorite(this.currentNodeUuid()) },
      '-',
      { label: 'In den Papierkorb', icon: 'trash', danger: true, onSelect: async () => {
        const n = this.lib.get(this.currentNodeUuid());
        if (n) await this.sidebar.trash(n);
      } },
      { custom: h('div', { class: 'menu-section', style: { paddingTop: '8px' }, text: this.current.modified ? `Zuletzt geändert ${relativeTime(this.current.modified)}` : '' }) }
    ], { align: 'right' });
  }

  currentNodeUuid() {
    if (!this.current) return null;
    const e = this.lib.index.get(this.current.uuid);
    return e ? e.node.uuid : this.current.uuid;
  }

  // -------------------------------------------------------------------------
  // Ansichten
  // -------------------------------------------------------------------------

  async leaveNote() {
    await this.saveNow();
    if (this.editor) {
      const cur = this.current;
      const node = cur && this.lib.index.get(cur.uuid);
      if (this.touched && this.settings.autoPdf && node && node.node.hasPdf) {
        call('export.companion', { uuid: cur.uuid, quiet: true }).catch(() => {});
      }
      this.editor.destroy();
      this.editor = null;
    }
    this.touched = false;
    if (this.pdfView) { this.pdfView.close(); this.pdfView = null; }
    if (this.fileView) { const fv = this.fileView; this.fileView = null; try { await fv.close(); } catch { /* egal */ } }
    this.view.classList.remove('no-scroll');
  }

  async showHome() {
    await this.leaveNote();
    this.current = { kind: 'home' };
    localStorage.removeItem('heft-last');
    this.renderTopbar();
    this.sidebar.highlightActive();
    const v = this.view;
    v.innerHTML = '';
    const hour = new Date().getHours();
    const greet = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';
    const name = (this.settings.name || '').split(' ')[0];
    const home = h('div', { class: 'home' },
      h('h1', { text: `${greet}${name ? ', ' + name : ''}!` }),
      h('p', { class: 'sub', text: formatDate(todayISO()) + ' · Was steht heute an?' }));
    const qa = h('div', { class: 'quick-actions' });
    const q = (ic, label, fn, primary) => { const b = h('button', { class: 'btn ' + (primary ? 'primary' : 'outline') }, h('span', { html: icon(ic, 'sm') }), label); b.addEventListener('click', fn); qa.append(b); };
    q('plus', 'Neuer Eintrag', () => this.newNote(), true);
    q('upload', 'Arbeitsblatt importieren', () => this.importPDF());
    q('camera', 'Vom iPhone scannen', (e) => this.scanFromPhone());
    q('search', 'Suchen', () => this.openPalette());
    home.append(qa);
    const recent = this.recent().map(u => this.lib.index.get(u)).filter(Boolean).slice(0, 9);
    if (recent.length) {
      home.append(h('h2', { text: 'Zuletzt geöffnet' }));
      const grid = h('div', { class: 'home-grid' });
      for (const e of recent) {
        const n = e.node;
        const card = h('div', { class: 'home-card' }, h('span', { html: icon(iconFor(n)) }), h('span', { class: 't', text: n.name }), h('span', { class: 'm', text: e.path || '' }));
        card.addEventListener('click', () => this.sidebar.activate(n));
        grid.append(card);
      }
      home.append(grid);
    }
    home.append(h('h2', { text: 'Gut zu wissen' }));
    const tips = h('div', { class: 'home-grid' });
    for (const [ic, t, d] of [
      ['text', 'Tippe „/“', 'für Überschriften, Formeln, Graphen, Merkkästen …'],
      ['sigma', 'Formeln wie in Typst', '$root(2, x)$ oder $a/b$ – LaTeX geht auch'],
      ['download', 'Als PDF ablegen', 'legt Eintrag und PDF zusammen in einen Ordner'],
      ['database', 'Alles in DEVONthink', 'durchsuchbar, synchronisiert, auch auf dem iPad']
    ]) tips.append(h('div', { class: 'home-card' }, h('span', { html: icon(ic) }), h('span', { class: 't', text: t }), h('span', { class: 'm', text: d })));
    home.append(tips);
    v.append(home);
  }

  async openRecord(uuid, opts) {
    const e = this.lib.index.get(uuid);
    if (e && e.node.kind === 'pdf') return this.openPDF(uuid);
    if (e && e.node.kind === 'group') { this.sidebar.reveal(uuid); return; }
    if (e && e.node.kind === 'bundle') return this.openNote(e.node.note);
    if (e && e.node.kind !== 'note') return this.openFile(uuid, opts);
    return this.openNote(uuid);
  }

  // Bilder, Text, Tabellen, Office-Dateien, Audio, Video … (alles außer Einträgen und PDFs)
  async openFile(uuid, opts = {}) {
    if (this.current && this.current.kind === 'file' && this.current.uuid === uuid && this.fileView) return;
    await this.leaveNote();
    const e = this.lib.index.get(uuid);
    this.current = { kind: 'file', uuid, name: e ? e.node.name : 'Datei', back: opts.back || null };
    localStorage.setItem('heft-last', uuid);
    this.addRecent(uuid);
    this.renderTopbar();
    this.sidebar.reveal(uuid);
    this.setSaveState('saved');
    this.fileView = new FileView(this, uuid, e && e.node, opts);
    await this.fileView.mount(this.view);
    this.renderTopbar();
  }

  // Menü „Öffnen mit …“ – über DEVONthink, damit Änderungen in der Datenbank ankommen
  async openWithMenu(anchor, uuid) {
    let apps = [];
    try { apps = await call('file.apps', { uuid }); } catch { apps = []; }
    const items = apps.map(a => ({ label: a.name + (a.default ? ' (Standard)' : ''), icon: 'external', onSelect: () => call('file.openWith', { uuid, app: a.default ? '' : a.name }) }));
    if (!items.length) items.push({ label: 'Mit Standardprogramm öffnen', icon: 'external', onSelect: () => call('file.openWith', { uuid }) });
    items.push('-', { label: 'In DEVONthink zeigen', icon: 'database', onSelect: () => call('record.reveal', { uuid }) });
    menu(anchor, items);
  }

  async openNote(uuid, { focusTitle = false } = {}) {
    if (this.current && this.current.kind === 'note' && this.current.uuid === uuid && this.editor) return;
    await this.leaveNote();
    const v = this.view;
    v.innerHTML = '';
    v.scrollTop = 0;
    let res;
    try { res = await call('note.read', { uuid }); }
    catch (e) {
      toast('Eintrag konnte nicht geöffnet werden: ' + e.message, { type: 'error' });
      return this.showHome();
    }
    const doc = parseDocument(res.markdown || '', { defaultTitle: stripNumber(res.name), recordName: res.name });
    if (!doc.meta.title && res.name && !doc.meta.heft) doc.meta.title = res.name;
    this.current = { kind: 'note', uuid, name: recordName(doc.meta) || res.name, modified: res.modified, loadedModified: res.modified };
    localStorage.setItem('heft-last', uuid);
    this.addRecent(uuid);
    this.renderTopbar();
    this.editor = new Editor(v, {
      host: this.editorHost(),
      settings: this.settings,
      onChange: () => { this.dirty = true; this.touched = true; this.setSaveState('dirty'); this.scheduleSave(); },
      onTitleChange: (t) => this.onTitleChange(t)
    });
    this.editor.load(doc);
    this.sidebar.reveal(uuid);
    if (focusTitle) setTimeout(() => this.editor.titleEl && this.editor.titleEl.focus(), 30);
  }

  async openPDF(uuid) {
    await this.leaveNote();
    const e = this.lib.index.get(uuid);
    this.current = { kind: 'pdf', uuid, name: e ? e.node.name : 'PDF' };
    localStorage.setItem('heft-last', uuid);
    this.addRecent(uuid);
    this.renderTopbar();
    this.sidebar.reveal(uuid);
    this.pdfView = new PDFView(this, uuid, e && e.node);
    await this.pdfView.mount(this.view);
  }

  onTitleChange(title) {
    const name = recordName(this.editor.doc.meta) || 'Unbenannt';
    if (this.titleCrumb) this.titleCrumb.textContent = name;
    if (this.current) this.current.name = name;
    const e = this.lib.index.get(this.current.uuid);
    if (e) {
      for (const row of this.sidebar.el.querySelectorAll(`.tree-row[data-uuid="${CSS.escape(e.node.uuid)}"] .label`)) {
        if (!row.querySelector('input')) row.textContent = name;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Speichern
  // -------------------------------------------------------------------------

  async saveNow() {
    this.scheduleSave.cancel();
    if (this.saving) { await this.saving; }
    if (!this.editor || !this.dirty || !this.current || this.current.kind !== 'note') return;
    const uuid = this.current.uuid;
    const doc = this.editor.getDoc();
    const markdown = serializeDocument(doc);
    const name = recordName(doc.meta) || 'Unbenannt';
    const tags = this.settings.syncTags ? [...new Set([...(doc.meta.tags || []), ...(doc.meta.subject ? [doc.meta.subject] : [])])] : null;
    this.dirty = false;
    this.setSaveState('saving');
    this.saving = (async () => {
      try {
        const r = await call('note.write', { uuid, markdown, name, tags });
        if (this.current && this.current.uuid === uuid) {
          this.current.modified = r && r.modified;
          this.current.loadedModified = r && r.modified;
          this.setSaveState(this.dirty ? 'dirty' : 'saved');
        }
        const e = this.lib.index.get(uuid);
        if (e && e.node.name !== name) {
          e.node.name = name;
          if (r && r.treeChanged) this.lib.refresh();
        }
      } catch (err) {
        this.dirty = true;
        this.setSaveState('error');
        toast('Speichern fehlgeschlagen: ' + err.message, { type: 'error', action: { label: 'Erneut', onClick: () => this.saveNow() } });
      } finally { this.saving = null; }
    })();
    return this.saving;
  }

  async reloadIfChanged() {
    if (!this.editor || this.dirty || !this.current || this.current.kind !== 'note') return;
    try {
      const res = await call('note.read', { uuid: this.current.uuid });
      if (res.modified && this.current.loadedModified && res.modified !== this.current.loadedModified) {
        const doc = parseDocument(res.markdown || '', { defaultTitle: stripNumber(res.name), recordName: res.name });
        this.editor.load(doc);
        this.current.loadedModified = res.modified;
        toast('Der Eintrag wurde außerhalb geändert und neu geladen.', { timeout: 2500 });
      }
    } catch { /* egal */ }
  }

  // -------------------------------------------------------------------------
  // Anlegen, Umbenennen, Verschieben …
  // -------------------------------------------------------------------------

  targetGroup(explicit) {
    if (explicit) return explicit;
    if (this.selectedGroup && this.lib.get(this.selectedGroup)) return this.selectedGroup;
    if (this.current && this.current.uuid) {
      const e = this.lib.index.get(this.current.uuid);
      if (e) {
        // Bei Einträgen mit eigenem Ordner: daneben anlegen, nicht hinein
        let p = e.parent;
        while (p && p.kind === 'bundle') p = this.lib.parentOf(p.uuid);
        if (p) return p.uuid;
      }
    }
    return this.lib.root && this.lib.root.uuid;
  }

  async newNote(parent, { title = '', blocks = [] } = {}) {
    await this.saveNow();
    const group = this.targetGroup(parent);
    const meta = { title, date: todayISO(), tags: [] };
    const subject = this.lib.guessSubject(group, this.settings.subjects || []);
    if (subject) meta.subject = subject;
    // Nächste freie Nummer im Ordner (falls in den Einstellungen eingeschaltet)
    const number = this.nextNumberIn(group);
    if (number) meta.number = number;
    const markdown = serializeDocument({ meta, blocks });
    try {
      const r = await call('note.create', { parent: group, name: recordName(meta) || 'Unbenannt', markdown, bundle: !!this.settings.bundleNotes });
      await this.lib.refresh();
      if (group) { this.sidebar.expanded.add(group); this.sidebar.saveExpanded(); }
      await this.openNote(r.uuid, { focusTitle: !title });
    } catch (e) {
      toast('Eintrag konnte nicht angelegt werden: ' + e.message, { type: 'error' });
    }
  }

  // Nächste freie Nummer im Ordner – bei „nach Thema“ aus Thema und
  // Unterthemen zusammengesetzt (1.1 → 1.1.2)
  nextNumberIn(group) {
    const fmt = this.settings.entryNumbers;
    if (!fmt || fmt === 'off') return '';
    const folder = group && this.lib.get(group);
    const kids = (folder && folder.children) || [];
    if (fmt === 'chapter') {
      const chain = topicChain(this.lib.topicPath(group, this.settings.subjects || []).map(n => n.name));
      return nextEntryNumber(kids.map(n => n.name), chain, fmt);
    }
    return nextEntryNumber(kids.filter(n => n.kind === 'note' || n.kind === 'bundle').map(n => n.name), folder ? folder.name : '', fmt);
  }

  // Themen des Eintrags unterhalb des Fachs (für die Anzeige im Kopf)
  topicNames(uuid) {
    const place = this.lib.placeOf(uuid);
    return this.lib.topicPath(place, this.settings.subjects || []).map(n => n.name);
  }

  // Fach und Thema wählen: Eintrag wandert in den Ordner und bekommt die passende Nummer
  async fileEntry(uuid) {
    uuid = uuid || (this.current && this.current.kind === 'note' && this.current.uuid);
    if (!uuid) return;
    if (!this.current || this.current.uuid !== uuid || !this.editor) await this.openNote(uuid);
    if (!this.editor) return;
    await this.saveNow();
    const res = await filingDialog(this, { uuid, meta: { ...this.editor.doc.meta } });
    if (!res) return;
    if (res.remove) { this.editor.setMeta({ subject: undefined }); return; }
    const t = toast('Wird abgelegt …', { type: 'busy', timeout: 0 });
    try {
      let parent = res.home.entries;
      if (!parent) {
        parent = res.home.create.parent;
        for (const name of res.home.create.names) parent = (await call('group.create', { parent, name })).uuid;
      }
      for (const step of res.path) parent = step.tmp ? (await call('group.create', { parent, name: step.name })).uuid : step.uuid;
      if (this.lib.placeOf(uuid) !== parent) await call('record.move', { uuid, to: parent });
      if (this.current && this.current.uuid === uuid && this.editor) {
        this.editor.setMeta({ subject: res.subject, number: res.number || undefined });
        this.onTitleChange(this.editor.doc.meta.title || '');
        await this.saveNow();
      }
      await this.lib.refresh();
      this.sidebar.reveal(uuid);
      this.renderTopbar();
      if (this.editor) this.editor.renderHeader();
      t.close();
      const where = [res.subject, ...res.path.map(p => p.name)].join(' › ');
      toast(`Abgelegt unter ${where}`, { type: 'success' });
    } catch (e) {
      t.close();
      toast('Ablegen fehlgeschlagen: ' + e.message, { type: 'error' });
      await this.lib.refresh();
    }
  }

  async newFolder(parent) {
    const group = this.targetGroup(parent);
    const name = await promptDialog('Neuer Ordner', '', { placeholder: 'z. B. 2 Quadratische Funktionen', confirm: 'Anlegen' });
    if (!name || !name.trim()) return;
    try {
      const r = await call('group.create', { parent: group, name: name.trim() });
      if (group) this.sidebar.expanded.add(group);
      this.sidebar.expanded.add(r.uuid);
      this.sidebar.saveExpanded();
      this.selectedGroup = r.uuid;
      await this.lib.refresh();
      this.sidebar.reveal(r.uuid);
    } catch (e) { toast('Ordner konnte nicht angelegt werden: ' + e.message, { type: 'error' }); }
  }

  async renameRecord(n, name) {
    try {
      const isCurrent = this.current && (this.current.uuid === n.uuid || n.note === this.current.uuid);
      if (isCurrent && this.editor) {
        const m = this.editor.doc.meta;
        const num = m.number && name.startsWith(m.number + ' ') ? m.number : null;
        this.editor.setMeta({ title: num ? name.slice(num.length + 1) : name, number: num || (m.number && !name.startsWith(m.number) ? undefined : m.number) });
        this.editor.renderHeader();
        this.onTitleChange(name);
        await this.saveNow();
      } else await call('record.rename', { uuid: n.kind === 'bundle' ? n.uuid : n.uuid, name, retitle: n.kind === 'note' || n.kind === 'bundle' });
      await this.lib.refresh();
      this.renderTopbar();
    } catch (e) { toast('Umbenennen fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  async moveRecord(uuid, to) {
    try {
      await call('record.move', { uuid, to });
      this.sidebar.expanded.add(to);
      this.sidebar.saveExpanded();
      await this.lib.refresh();
      this.renderTopbar();
    } catch (e) { toast('Verschieben fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  async trashRecord(n) {
    const cur = this.current && this.current.uuid;
    const affected = cur && (cur === n.uuid || cur === n.note || this.lib.ancestors(cur).some(a => a.uuid === n.uuid));
    if (affected) { this.dirty = false; await this.showHome(); }
    try {
      await call('record.trash', { uuid: n.uuid });
      await this.lib.refresh();
      toast(`„${n.name}“ liegt im Papierkorb von DEVONthink.`);
    } catch (e) { toast('Löschen fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  async importPDF(parent) {
    const group = this.targetGroup(parent);
    try {
      const res = await call('pdf.import', { parent: group });
      if (!res || !res.length) return;
      await this.lib.refresh();
      this.openPDF(res[0].uuid);
      toast(res.length > 1 ? `${res.length} PDFs importiert` : `„${res[0].name}“ importiert`, { type: 'success' });
    } catch (e) { toast('Import fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  async importFiles(files, parent) {
    const t = toast(`${files.length} Datei(en) werden importiert …`, { type: 'busy', timeout: 0 });
    try {
      const list = [];
      for (const f of files) list.push({ name: f.name, mime: f.type, data: await fileToBase64(f) });
      await call('files.import', { parent, files: list });
      await this.lib.refresh();
    } catch (e) { toast('Import fehlgeschlagen: ' + e.message, { type: 'error' }); }
    finally { t.close(); }
  }

  async scanFromPhone() {
    if (!isNative) { toast('Nur in der Mac-App verfügbar.'); return; }
    const group = this.targetGroup();
    try {
      const res = await call('scan.phone', { parent: group });
      if (res && res.length) { await this.lib.refresh(); this.openPDF(res[0].uuid); }
    } catch (e) { toast('Scannen fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  async noteFromPDF(pdfUuid, node) {
    const name = node ? node.name : 'Arbeitsblatt';
    const blocks = [block('pdf', { src: itemLink(pdfUuid), caption: name }), block('p')];
    const parent = this.lib.parentOf(pdfUuid);
    await this.newNote(parent && parent.uuid, { title: name, blocks });
  }

  async exportCompanion(uuid) {
    uuid = uuid || (this.current && this.current.kind === 'note' && this.current.uuid);
    if (!uuid) return;
    await this.saveNow();
    const t = toast('PDF wird erstellt und in DEVONthink abgelegt …', { type: 'busy', timeout: 0 });
    try {
      const r = await call('export.companion', { uuid });
      t.close();
      toast(r && r.created ? 'Eintrag und PDF liegen jetzt zusammen in einem Ordner.' : 'PDF-Fassung aktualisiert.', {
        type: 'success', action: r && r.pdf ? { label: 'Zeigen', onClick: () => call('record.reveal', { uuid: r.pdf }) } : null
      });
      await this.lib.refresh();
      // Den (neuen) Eintrags-Ordner aufklappen, damit Eintrag und PDF sichtbar sind
      this.sidebar.reveal(uuid);
      this.renderTopbar();
    } catch (e) {
      t.close();
      toast('PDF konnte nicht erstellt werden: ' + e.message, { type: 'error' });
    }
  }

  async exportPDF() {
    if (!this.current || this.current.kind !== 'note') return;
    await this.saveNow();
    try { await call('export.pdf', { uuid: this.current.uuid }); }
    catch (e) { toast('Export fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  async print() {
    if (!this.current || this.current.kind !== 'note') return;
    await this.saveNow();
    try { await call('print', { uuid: this.current.uuid }); }
    catch (e) { toast('Drucken fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  // -------------------------------------------------------------------------
  // Kleinkram
  // -------------------------------------------------------------------------

  editorHost() {
    const app = this;
    return {
      openSettings: (section) => openSettings(app, section),
      fileEntry: () => app.fileEntry(),
      topicNames: () => (app.current && app.current.kind === 'note' ? app.topicNames(app.current.uuid) : []),
      listNotes: () => app.lib.flatDocs().filter(d => !app.current || d.uuid !== app.current.uuid).map(d => ({ uuid: d.uuid, name: d.name, path: d.path, kind: d.kind, type: d.node.type, ext: d.node.ext })),
      pickDocument: (opts = {}) => pickDocument(app, { exclude: app.current && app.current.uuid, ...opts }),
      noteTitle: (uuid) => { const n = app.lib.get(uuid); return n ? n.name : null; },
      openLink: (href) => {
        const uuid = uuidFromLink(href);
        if (uuid) return app.openRecord(uuid);
        if (href.startsWith('#')) return app.editor && app.editor.scrollToBlock(href.slice(1));
        if (href.startsWith('wiki:')) {
          const hit = app.lib.flatDocs().find(d => d.name.toLowerCase() === href.slice(5).toLowerCase());
          if (hit) return app.openRecord(hit.uuid);
          return toast('Kein Eintrag mit diesem Namen gefunden.');
        }
        call('open.url', { url: href });
      },
      openPDF: (uuid) => app.openPDF(uuid),
      editImage: async (src) => {
        const u = uuidFromLink(src);
        if (!u) return;
        const back = app.current && app.current.kind === 'note' ? app.current.uuid : null;
        await app.saveNow();
        app.openFile(u, { back });
      },
      revealLink: (href) => { const u = uuidFromLink(href); if (u) call('record.reveal', { uuid: u }); },
      pickFiles: async (kind) => {
        const res = await call('asset.pick', { note: app.current && app.current.uuid, kind });
        if (res && res.length) app.lib.refresh();
        return res;
      },
      uploadFiles: async (files) => {
        const out = [];
        for (const f of files) {
          const data = await fileToBase64(f);
          const r = await call('asset.add', { note: app.current && app.current.uuid, name: f.name || 'Bild.png', mime: f.type || 'image/png', data });
          out.push({ ...r, kind: f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf' : 'image' });
        }
        app.lib.refresh();
        return out;
      },
      pdfInfo: (uuid) => call('pdf.info', { uuid }),
      chemLookup: (name) => call('chem.lookup', { name })
    };
  }

  recent() {
    try { return JSON.parse(localStorage.getItem('heft-recent') || '[]'); } catch { return []; }
  }

  addRecent(uuid) {
    const r = this.recent().filter(u => u !== uuid);
    r.unshift(uuid);
    localStorage.setItem('heft-recent', JSON.stringify(r.slice(0, 20)));
    this.sidebar.renderRecent();
  }

  async toggleFavorite(uuid) {
    const favs = new Set(this.settings.favorites || []);
    if (favs.has(uuid)) favs.delete(uuid); else favs.add(uuid);
    await this.updateSettings({ favorites: [...favs] });
    this.sidebar.renderFavorites();
  }

  openPalette() { openPalette(this); }
  openSettings(section) { openSettings(this, section); }

  toggleSidebar() {
    const c = this.sidebar.el.classList.toggle('collapsed');
    localStorage.setItem('heft-sidebar-collapsed', c ? '1' : '0');
    this.renderTopbar();
    setTimeout(() => this.layoutChanged(), 200);
  }

  // Der Mac-App mitteilen, wo man das Fenster anfassen kann (Kopfzeilen)
  layoutChanged() {
    if (this.pdfView) this.pdfView.sendRect();
    if (this.fileView) this.fileView.sendRect();
    if (!isNative) return;
    cancelAnimationFrame(this._layoutRaf);
    this._layoutRaf = requestAnimationFrame(() => {
      const regions = [], holes = [];
      for (const el of document.querySelectorAll('[data-drag-region]')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        regions.push({ x: r.left, y: r.top, width: r.width, height: r.height });
        for (const c of el.querySelectorAll('button, input, .crumb, .save-state')) {
          const q = c.getBoundingClientRect();
          if (q.width) holes.push({ x: q.left, y: q.top, width: q.width, height: q.height });
        }
      }
      call('window.dragRegions', { regions, holes }).catch(() => {});
    });
  }
}

export function recordName(meta) {
  const t = (meta.title || '').trim();
  if (!t) return meta.number ? String(meta.number) : '';
  return meta.number ? `${meta.number} ${t}` : t;
}

function stripNumber(name) {
  return String(name || '').replace(/^\d+(\.\d+)*\s+/, '');
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
