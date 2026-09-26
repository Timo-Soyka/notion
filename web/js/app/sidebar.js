// Seitenleiste: Suche, Favoriten, zuletzt geöffnet und der Ordnerbaum.

import { h, esc, menu, promptDialog, confirmDialog, toast } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { subjectColor, subjectOfFolder } from '../core/subjects.js';
import { call } from '../bridge.js';

const KIND_ICON = { group: 'folder', note: 'note', bundle: 'folder', pdf: 'pdf', image: 'image', file: 'file' };
const isFolder = (n) => n.kind === 'group' || n.kind === 'bundle';

// Farbiges Kennzeichen für Dateien (nicht für Einträge und einfache Textdateien)
const BADGE_KIND = {
  pdf: 'pdf',
  jpg: 'img', jpeg: 'img', png: 'img', heic: 'img', gif: 'img', webp: 'img', tif: 'img', tiff: 'img', svg: 'img', bmp: 'img',
  doc: 'doc', docx: 'doc', pages: 'doc', rtf: 'doc', rtfd: 'doc', odt: 'doc',
  xls: 'sheet', xlsx: 'sheet', numbers: 'sheet', csv: 'sheet', ods: 'sheet',
  ppt: 'slides', pptx: 'slides', key: 'slides', odp: 'slides',
  mp3: 'media', m4a: 'media', wav: 'media', aiff: 'media', mp4: 'media', mov: 'media', m4v: 'media',
  zip: 'other', html: 'other', webarchive: 'web', webloc: 'web', epub: 'doc', ggb: 'other'
};
function fileBadge(n) {
  if (n.kind === 'note' || n.kind === 'group' || n.kind === 'bundle') return null;
  const ext = n.ext || (n.kind === 'pdf' ? 'pdf' : '');
  if (!ext || ext === 'md' || ext === 'txt' || ext === 'markdown') return null;
  const label = { jpeg: 'JPG', tiff: 'TIF', markdown: 'MD', webarchive: 'WEB', webloc: 'LINK' }[ext] || ext.toUpperCase().slice(0, 5);
  return h('span', { class: 'file-badge ' + (BADGE_KIND[ext] || 'other'), text: label });
}

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.lib = app.lib;
    this.expanded = new Set(JSON.parse(localStorage.getItem('heft-expanded') || '[]'));
    this.el = h('aside', { class: 'sidebar' });
    this.build();
    this.lib.onChange(() => this.renderTree());
    const w = +localStorage.getItem('heft-sidebar-w');
    if (w) document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    if (localStorage.getItem('heft-sidebar-collapsed') === '1') this.el.classList.add('collapsed');
  }

  saveExpanded() { localStorage.setItem('heft-expanded', JSON.stringify([...this.expanded])); }

  build() {
    const top = h('div', { class: 'sidebar-top', 'data-drag-region': '' });
    const collapse = h('button', { class: 'btn icon-only', 'data-tip': 'Seitenleiste ausblenden', 'data-kbd': '⌘\\', html: icon('sidebar') });
    collapse.addEventListener('click', () => this.app.toggleSidebar());
    top.append(collapse);

    const actions = h('div', { class: 'side-actions' });
    const item = (ic, label, kbd, onClick) => {
      const el = h('div', { class: 'side-item' }, h('span', { html: icon(ic) }), h('span', { text: label }), kbd ? h('span', { class: 'kbd-hint', text: kbd }) : '');
      el.addEventListener('click', onClick);
      actions.append(el);
      return el;
    };
    item('search', 'Suchen', '⌘K', () => this.app.openPalette());
    item('home', 'Startseite', '', () => this.app.showHome());
    item('plus', 'Neuer Eintrag', '⌘N', () => this.app.newNote());

    this.scroll = h('div', { class: 'side-scroll' });
    this.favSection = h('div', { class: 'side-section' });
    this.recentSection = h('div', { class: 'side-section' });
    this.treeSection = h('div', { class: 'side-section' });
    this.scroll.append(this.favSection, this.recentSection, this.treeSection);

    const footer = h('div', { class: 'side-footer' });
    const imp = h('div', { class: 'side-item' }, h('span', { html: icon('upload') }), h('span', { text: 'PDF importieren' }));
    imp.addEventListener('click', () => this.app.importPDF());
    const scan = h('div', { class: 'side-item' }, h('span', { html: icon('camera') }), h('span', { text: 'Vom iPhone scannen' }));
    scan.addEventListener('click', (e) => this.app.scanFromPhone(e.currentTarget));
    const set = h('div', { class: 'side-item' }, h('span', { html: icon('gear') }), h('span', { text: 'Einstellungen' }), h('span', { class: 'kbd-hint', text: '⌘,' }));
    set.addEventListener('click', () => this.app.openSettings());
    this.status = h('div', { class: 'dt-status', 'data-tip': 'Datenbank wechseln' }, h('span', { class: 'dot' }), h('span', { class: 'txt', text: 'DEVONthink' }));
    this.status.addEventListener('click', () => this.app.switchDatabase());
    footer.append(imp, scan, set, this.status);

    const resizer = h('div', { class: 'sidebar-resizer' });
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');
      const move = (ev) => {
        const w = Math.max(200, Math.min(480, ev.clientX));
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
        this.app.layoutChanged();
      };
      const up = (ev) => {
        resizer.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        localStorage.setItem('heft-sidebar-w', Math.max(200, Math.min(480, ev.clientX)));
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.el.append(top, actions, this.scroll, footer, resizer);
  }

  setStatus(state, text) {
    this.status.className = 'dt-status ' + (state || '');
    this.status.querySelector('.txt').textContent = text;
  }

  // -------------------------------------------------------------------------

  renderTree() {
    this.renderFavorites();
    this.renderRecent();
    const sec = this.treeSection;
    sec.innerHTML = '';
    const root = this.lib.root;
    const head = h('div', { class: 'side-section-head' }, h('span', { text: root ? root.name : 'Bibliothek' }));
    const acts = h('div', { class: 'actions' });
    const addNote = h('button', { class: 'btn icon-only', 'data-tip': 'Neuer Eintrag', html: icon('plus', 'sm') });
    addNote.addEventListener('click', (e) => { e.stopPropagation(); this.app.newNote(root && root.uuid); });
    const addFolder = h('button', { class: 'btn icon-only', 'data-tip': 'Neuer Ordner', html: icon('folder', 'sm') });
    addFolder.addEventListener('click', (e) => { e.stopPropagation(); this.app.newFolder(root && root.uuid); });
    const refresh = h('button', { class: 'btn icon-only', 'data-tip': 'Neu laden', html: icon('refresh', 'sm') });
    refresh.addEventListener('click', (e) => { e.stopPropagation(); this.lib.refresh(); });
    acts.append(addNote, addFolder, refresh);
    head.append(acts);
    sec.append(head);
    const ul = h('ul', { class: 'tree' });
    this.renderNodes(this.lib.nodes, ul, 0, null);
    if (!this.lib.nodes.length) ul.append(h('li', { class: 'tree-empty', style: { paddingLeft: '12px' }, text: this.lib.loading ? 'Wird geladen …' : 'Noch leer – lege einen Ordner an.' }));
    sec.append(ul);
    this.attachRootDrop(head, root);
    this.highlightActive();
  }

  // color: Fachfarbe, die vom Fachordner an alles darin weitergegeben wird
  renderNodes(nodes, ul, depth, color) {
    const subjects = this.app.settings.subjects || [];
    for (const n of nodes) {
      const li = h('li');
      const own = n.kind === 'group' ? subjectOfFolder(n.name, subjects) : null;
      const c = own ? subjectColor(this.app.settings, own) : color;
      const row = this.row(n, depth, c, !!own);
      li.append(row);
      if (isFolder(n) && this.expanded.has(n.uuid)) {
        const sub = h('ul', { class: 'tree' });
        const kids = n.children || [];
        if (!kids.length) sub.append(h('li', { class: 'tree-empty', style: { paddingLeft: (depth + 1) * 14 + 30 + 'px' }, text: 'Leer' }));
        else this.renderNodes(kids, sub, depth + 1, c);
        li.append(sub);
      }
      ul.append(li);
    }
  }

  row(n, depth, color = null, isSubject = false) {
    const row = h('div', { class: 'tree-row' + (isSubject && color ? ' subject' : ''), 'data-uuid': n.uuid, draggable: 'true', style: { paddingLeft: depth * 14 + 4 + 'px' } });
    if (color) row.dataset.subject = color;
    const expandable = isFolder(n);
    const tw = h('span', { class: 'twisty' + (expandable ? '' : ' empty') + (this.expanded.has(n.uuid) ? ' open' : ''), html: icon('chevronRight', 'sm') });
    tw.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(n); });
    const kind = h('span', { class: 'kind-icon', html: icon(expandable && this.expanded.has(n.uuid) ? 'folderOpen' : KIND_ICON[n.kind] || 'file') });
    if (n.color) kind.style.color = n.color;
    // Ordner und Einträge im Fach in der Fachfarbe
    if (color && (isFolder(n) || n.kind === 'note')) kind.style.color = `var(--t-${color})`;
    const label = h('span', { class: 'label', text: n.name });
    row.append(tw, kind, label);
    const badge = fileBadge(n);
    if (badge) row.append(badge);
    const acts = h('span', { class: 'row-actions' });
    const more = h('button', { class: 'btn icon-only', 'data-tip': 'Mehr', html: icon('more', 'sm') });
    more.addEventListener('click', (e) => { e.stopPropagation(); this.contextMenu(n, more); });
    acts.append(more);
    if (n.kind === 'group') {
      const add = h('button', { class: 'btn icon-only', 'data-tip': 'Neuer Eintrag hier', html: icon('plus', 'sm') });
      add.addEventListener('click', (e) => { e.stopPropagation(); this.expanded.add(n.uuid); this.saveExpanded(); this.app.newNote(n.uuid); });
      acts.append(add);
    }
    row.append(acts);
    row.addEventListener('click', () => this.activate(n));
    row.addEventListener('dblclick', (e) => { if (n.kind === 'group') { e.preventDefault(); } });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(n, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 }); });
    this.attachDnD(row, n);
    return row;
  }

  toggle(n) {
    if (this.expanded.has(n.uuid)) this.expanded.delete(n.uuid); else this.expanded.add(n.uuid);
    this.saveExpanded();
    this.renderTree();
  }

  activate(n) {
    if (n.kind === 'group') { this.toggle(n); this.app.selectedGroup = n.uuid; return; }
    // Eintrags-Ordner: aufklappen und den Eintrag darin öffnen
    if (n.kind === 'bundle') { if (!this.expanded.has(n.uuid)) this.toggle(n); this.app.openNote(n.note); return; }
    if (n.kind === 'note') this.app.openNote(n.uuid);
    else if (n.kind === 'pdf') this.app.openPDF(n.uuid);
    else call('record.openExternal', { uuid: n.uuid });
  }

  highlightActive() {
    const cur = this.app.current && this.app.current.uuid;
    for (const r of this.el.querySelectorAll('.tree-row.active')) r.classList.remove('active');
    if (!cur) return;
    const node = this.lib.index.get(cur);
    const uuid = node ? node.node.uuid : cur;
    for (const r of this.el.querySelectorAll(`.tree-row[data-uuid="${CSS.escape(uuid)}"]`)) r.classList.add('active');
  }

  // Alle Vorfahren aufklappen und die Zeile sichtbar machen
  reveal(uuid) {
    let changed = false;
    for (const a of this.lib.ancestors(uuid)) if (!this.expanded.has(a.uuid)) { this.expanded.add(a.uuid); changed = true; }
    if (changed) { this.saveExpanded(); this.renderTree(); }
    const node = this.lib.index.get(uuid);
    const id = node ? node.node.uuid : uuid;
    const row = this.el.querySelector(`.tree-row[data-uuid="${CSS.escape(id)}"]`);
    row && row.scrollIntoView({ block: 'nearest' });
    this.highlightActive();
  }

  renderFavorites() {
    const favs = (this.app.settings.favorites || []).map(u => this.lib.index.get(u)).filter(Boolean);
    this.favSection.innerHTML = '';
    if (!favs.length) return;
    this.favSection.append(h('div', { class: 'side-section-head' }, h('span', { text: 'Favoriten' })));
    const ul = h('ul', { class: 'tree' });
    for (const e of favs) {
      const n = e.node;
      const row = h('div', { class: 'tree-row', 'data-uuid': n.uuid, style: { paddingLeft: '4px' } },
        h('span', { class: 'twisty empty' }), h('span', { class: 'kind-icon', html: icon('star') }), h('span', { class: 'label', text: n.name }));
      row.addEventListener('click', () => this.activate(n));
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.contextMenu(n, { left: ev.clientX, top: ev.clientY, right: ev.clientX, bottom: ev.clientY, width: 0, height: 0 }); });
      ul.append(h('li', {}, row));
    }
    this.favSection.append(ul);
  }

  // Fachfarbe eines Eintrags über seine Ordner bestimmen
  colorOf(uuid) {
    const subjects = this.app.settings.subjects || [];
    for (const a of this.lib.ancestors(uuid).reverse()) {
      const s = subjectOfFolder(a.name, subjects);
      if (s) return subjectColor(this.app.settings, s);
    }
    return null;
  }

  renderRecent() {
    const recent = this.app.recent().map(u => this.lib.index.get(u)).filter(Boolean).slice(0, 5);
    this.recentSection.innerHTML = '';
    if (!recent.length) return;
    this.recentSection.append(h('div', { class: 'side-section-head' }, h('span', { text: 'Zuletzt geöffnet' })));
    const ul = h('ul', { class: 'tree' });
    for (const e of recent) {
      const n = e.node;
      const c = this.colorOf(n.uuid);
      const ic = h('span', { class: 'kind-icon', html: icon(n.kind === 'pdf' ? 'pdf' : 'clock') });
      if (c) ic.style.color = `var(--t-${c})`;
      const row = h('div', { class: 'tree-row', 'data-uuid': n.uuid, style: { paddingLeft: '4px' } },
        h('span', { class: 'twisty empty' }), ic, h('span', { class: 'label', text: n.name }));
      row.addEventListener('click', () => this.activate(n));
      ul.append(h('li', {}, row));
    }
    this.recentSection.append(ul);
  }

  // -------------------------------------------------------------------------
  // Kontextmenü
  // -------------------------------------------------------------------------

  contextMenu(n, anchor) {
    const app = this.app;
    const row = this.el.querySelector(`.tree-row[data-uuid="${CSS.escape(n.uuid)}"]`);
    row && row.classList.add('menu-open');
    const isFav = (app.settings.favorites || []).includes(n.uuid);
    const items = [];
    if (n.kind === 'group') {
      items.push(
        { label: 'Neuer Eintrag hier', icon: 'plus', onSelect: () => { this.expanded.add(n.uuid); this.saveExpanded(); app.newNote(n.uuid); } },
        { label: 'Neuer Unterordner', icon: 'folder', onSelect: () => { this.expanded.add(n.uuid); this.saveExpanded(); app.newFolder(n.uuid); } },
        { label: 'PDF hierher importieren', icon: 'upload', onSelect: () => app.importPDF(n.uuid) },
        '-'
      );
    } else {
      items.push({ label: 'Öffnen', icon: 'arrowRight', onSelect: () => this.activate(n) });
      if (n.kind === 'note' || n.kind === 'bundle') items.push({ label: 'Als PDF ablegen', icon: 'download', onSelect: () => app.exportCompanion(n.kind === 'bundle' ? n.note : n.uuid) });
      items.push('-');
    }
    items.push(
      { label: 'Umbenennen', icon: 'pencil', onSelect: () => this.rename(n) },
      { label: isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: 'star', onSelect: () => app.toggleFavorite(n.uuid) },
      { label: 'In DEVONthink zeigen', icon: 'database', onSelect: () => call('record.reveal', { uuid: n.uuid }) },
      { label: 'Link kopieren', icon: 'link', onSelect: async () => { await navigator.clipboard.writeText(`x-devonthink-item://${n.uuid}`); toast('Link kopiert', { type: 'success', timeout: 1500 }); } },
      '-',
      { label: 'In den Papierkorb', icon: 'trash', danger: true, onSelect: () => this.trash(n) }
    );
    menu(anchor, items, { onClose: () => row && row.classList.remove('menu-open') });
  }

  async rename(n) {
    const row = this.el.querySelector(`.tree-row[data-uuid="${CSS.escape(n.uuid)}"]`);
    const label = row && row.querySelector('.label');
    if (!label) {
      const v = await promptDialog('Umbenennen', n.name);
      if (v && v.trim() && v !== n.name) await this.app.renameRecord(n, v.trim());
      return;
    }
    const input = h('input', { value: n.name });
    label.innerHTML = '';
    label.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== n.name) await this.app.renameRecord(n, v);
      else label.textContent = n.name;
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  async trash(n) {
    const what = n.kind === 'group' ? `den Ordner „${n.name}“ mit allem Inhalt`
      : n.kind === 'bundle' || n.inBundle ? `„${n.name}“ samt Ordner und PDF-Fassung` : `„${n.name}“`;
    const ok = await confirmDialog('In den Papierkorb legen?', `Möchtest du ${what} in den Papierkorb von DEVONthink legen? Dort kannst du es wiederherstellen.`, { confirm: 'In den Papierkorb', danger: true });
    if (!ok) return;
    await this.app.trashRecord(n);
  }

  // -------------------------------------------------------------------------
  // Ziehen & Ablegen im Baum
  // -------------------------------------------------------------------------

  attachDnD(row, n) {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-heft-record', n.uuid);
      e.dataTransfer.effectAllowed = 'move';
      this.dragging = n;
    });
    row.addEventListener('dragend', () => { this.dragging = null; this.clearDrop(); });
    const target = this.dropGroup(n);
    row.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      const isRecord = types.includes('application/x-heft-record');
      const isFiles = types.includes('Files');
      if (!isRecord && !isFiles) return;
      if (isRecord && this.dragging && (this.dragging === n || this.isAncestor(this.dragging, target))) return;
      e.preventDefault();
      this.clearDrop();
      const tRow = target ? this.el.querySelector(`.tree-row[data-uuid="${CSS.escape(target.uuid)}"]`) : null;
      (tRow || row).classList.add('drop-into');
      e.dataTransfer.dropEffect = isFiles ? 'copy' : 'move';
      clearTimeout(this.expandTimer);
      if (n.kind === 'group' && !this.expanded.has(n.uuid)) this.expandTimer = setTimeout(() => this.toggle(n), 700);
    });
    row.addEventListener('dragleave', () => clearTimeout(this.expandTimer));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.clearDrop();
      const to = target ? target.uuid : this.lib.root && this.lib.root.uuid;
      const uuid = e.dataTransfer.getData('application/x-heft-record');
      if (uuid) { if (uuid !== to) await this.app.moveRecord(uuid, to); return; }
      const files = [...e.dataTransfer.files];
      if (files.length) await this.app.importFiles(files, to);
    });
  }

  // Ablageziel beim Ziehen: der nächste echte Ordner (nie in einen Eintrags-Ordner hinein)
  dropGroup(n) {
    let t = n.kind === 'group' ? n : this.lib.parentOf(n.uuid);
    while (t && t.kind === 'bundle') t = this.lib.parentOf(t.uuid);
    return t;
  }

  attachRootDrop(head, root) {
    head.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].some(t => t === 'application/x-heft-record' || t === 'Files')) { e.preventDefault(); head.classList.add('drop-into'); } });
    head.addEventListener('dragleave', () => head.classList.remove('drop-into'));
    head.addEventListener('drop', async (e) => {
      e.preventDefault();
      head.classList.remove('drop-into');
      const uuid = e.dataTransfer.getData('application/x-heft-record');
      if (uuid && root) await this.app.moveRecord(uuid, root.uuid);
      else if (e.dataTransfer.files.length && root) await this.app.importFiles([...e.dataTransfer.files], root.uuid);
    });
  }

  isAncestor(a, b) {
    if (!b) return false;
    if (a.uuid === b.uuid) return true;
    return this.lib.ancestors(b.uuid).some(x => x.uuid === a.uuid);
  }

  clearDrop() {
    for (const r of this.el.querySelectorAll('.drop-into')) r.classList.remove('drop-into');
  }
}
