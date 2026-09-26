// Suche (⌘K): Titel sofort aus dem Baum, Volltext über die Suche von
// DEVONthink – die kennt auch den Text in PDFs und eingescannten Blättern.

import { h, esc, dialog, debounce } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { call } from '../bridge.js';

function norm(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = norm(text).indexOf(norm(q));
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

export function openPalette(app) {
  const input = h('input', { placeholder: 'Einträge, Arbeitsblätter und Befehle durchsuchen …', spellcheck: 'false' });
  const list = h('div', { class: 'palette-list' });
  const foot = h('div', { class: 'palette-foot', html: '<span><kbd>↑</kbd><kbd>↓</kbd> auswählen</span><span><kbd>↵</kbd> öffnen</span><span><kbd>esc</kbd> schließen</span><span style="margin-left:auto">Volltextsuche über DEVONthink</span>' });
  const body = h('div', {}, h('div', { class: 'palette-input' }, h('span', { html: icon('search') }), input), list, foot);
  const d = dialog({ body, class: 'palette' });
  d.el.querySelector('.dialog-body').style.padding = '0';
  let items = [];
  let active = 0;
  let fulltext = [];
  let searching = false;

  const commands = [
    { label: 'Neuer Eintrag', icon: 'plus', hint: '⌘N', run: () => app.newNote() },
    { label: 'Neuer Ordner', icon: 'folder', hint: '⌘⇧N', run: () => app.newFolder() },
    { label: 'PDF importieren', icon: 'upload', run: () => app.importPDF() },
    { label: 'Als PDF ablegen', icon: 'download', run: () => app.exportCompanion() },
    { label: 'Einstellungen', icon: 'gear', hint: '⌘,', run: () => app.openSettings() },
    { label: 'Startseite', icon: 'home', run: () => app.showHome() }
  ];

  const render = () => {
    const q = input.value.trim();
    const nq = norm(q);
    const docs = app.lib.flatDocs();
    const titleHits = !q ? app.recent().map(u => docs.find(d => d.uuid === u)).filter(Boolean).slice(0, 8)
      : docs.map(d => ({ d, s: norm(d.name).startsWith(nq) ? 3 : norm(d.name).includes(nq) ? 2 : norm(d.path).includes(nq) ? 1 : 0 }))
        .filter(x => x.s).sort((a, b) => b.s - a.s).slice(0, 12).map(x => x.d);
    items = [];
    const sections = [];
    if (titleHits.length) sections.push([q ? 'Einträge' : 'Zuletzt geöffnet', titleHits.map(d => ({
      label: d.name, desc: d.path, icon: d.kind === 'pdf' ? 'pdf' : 'note', run: () => d.kind === 'pdf' ? app.openPDF(d.uuid) : app.openNote(d.uuid)
    }))]);
    const seen = new Set(titleHits.map(d => d.uuid));
    const ft = fulltext.filter(r => !seen.has(r.uuid));
    if (ft.length) sections.push(['Im Text gefunden', ft.map(r => ({
      label: r.name, desc: r.location, icon: r.kind === 'pdf' ? 'pdf' : r.kind === 'note' ? 'note' : 'file',
      run: () => r.kind === 'pdf' ? app.openPDF(r.uuid) : r.kind === 'note' ? app.openNote(r.uuid) : call('record.reveal', { uuid: r.uuid })
    }))]);
    const cmds = commands.filter(c => !q || norm(c.label).includes(nq));
    if (cmds.length) sections.push(['Befehle', cmds]);
    list.innerHTML = '';
    for (const [title, arr] of sections) {
      list.append(h('div', { class: 'menu-section', text: title }));
      for (const it of arr) {
        const i = items.length;
        items.push(it);
        const row = h('div', { class: 'palette-item' + (i === active ? ' on' : '') });
        row.innerHTML = icon(it.icon) + `<div class="col"><span class="t">${highlight(it.label, q)}</span>${it.desc ? `<span class="m">${esc(it.desc)}</span>` : ''}</div>` + (it.hint ? `<span class="right">${esc(it.hint)}</span>` : '');
        row.addEventListener('mouseenter', () => { active = i; mark(); });
        row.addEventListener('click', () => choose(i));
        list.append(row);
      }
    }
    if (!items.length) list.append(h('div', { class: 'slash-empty', text: searching ? 'Suche …' : 'Nichts gefunden' }));
    if (searching) list.append(h('div', { class: 'slash-empty', html: '<span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Volltextsuche in DEVONthink …' }));
    active = Math.min(active, Math.max(0, items.length - 1));
  };
  const mark = () => {
    list.querySelectorAll('.palette-item').forEach((el, k) => el.classList.toggle('on', k === active));
    list.querySelectorAll('.palette-item')[active]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    d.close();
    it.run();
  };
  let seq = 0;
  const searchFull = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { fulltext = []; searching = false; render(); return; }
    const my = ++seq;
    searching = true;
    render();
    try {
      const res = await call('search', { query: q });
      if (my !== seq) return;
      fulltext = res || [];
    } catch { fulltext = []; }
    searching = false;
    render();
  }, 280);
  input.addEventListener('input', () => { active = 0; render(); searchFull(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  });
  render();
  setTimeout(() => input.focus(), 10);
}
