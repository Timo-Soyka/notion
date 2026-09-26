// Datei zum Verlinken auswählen: Ordner durchblättern oder suchen.
//
// Startet im Ordner des aktuellen Eintrags. Oben die Suche (über die ganze
// Datenbank oder nur im aktuellen Ordner), darunter der Pfad zum Anklicken
// und der Inhalt des Ordners. Tastatur: ↑/↓ wählen, Enter öffnet den Ordner
// bzw. verlinkt die Datei, ← oder Rückschritt (bei leerer Suche) geht einen
// Ordner nach oben.

import { h, dialog, esc } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { iconFor, classify } from '../core/filetypes.js';

const FILTERS = [['all', 'Alle'], ['note', 'Einträge'], ['pdf', 'PDFs'], ['image', 'Bilder'], ['other', 'Andere']];
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function typeOf(n) {
  if (n.kind === 'group') return 'group';
  if (n.kind === 'note' || n.kind === 'bundle') return 'note';
  if (n.kind === 'pdf') return 'pdf';
  return classify(n).view === 'image' ? 'image' : 'other';
}

// → Promise mit { uuid, name, kind } oder null
export function pickDocument(app, { title = 'Datei verlinken', exclude = null, start = null } = {}) {
  return new Promise((resolve) => {
    const lib = app.lib;
    const root = lib.root;
    const skip = new Set([exclude].filter(Boolean));
    if (exclude) { const p = lib.parentOf(exclude); if (p && p.kind === 'bundle') skip.add(p.uuid); }
    let folder = start || (exclude ? lib.placeOf(exclude) : null);
    if (folder === (root && root.uuid) || !lib.get(folder)) folder = null;
    let query = '', filter = 'all', scope = 'all', active = 0, items = [];
    let result = null;

    const input = h('input', { class: 'input lp-search', placeholder: 'Suchen – Name oder Ordner …', spellcheck: 'false' });
    const scopeBtns = h('div', { class: 'segmented lp-scope' });
    for (const [v, l] of [['all', 'Überall'], ['here', 'In diesem Ordner']]) {
      const b = h('button', { class: v === scope ? 'on' : '', text: l, type: 'button' });
      b.addEventListener('click', () => { scope = v; scopeBtns.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); active = 0; render(); input.focus(); });
      scopeBtns.append(b);
    }
    const filters = h('div', { class: 'lp-filters' });
    for (const [v, l] of FILTERS) {
      const b = h('button', { class: 'lp-chip' + (v === filter ? ' on' : ''), text: l, type: 'button' });
      b.addEventListener('click', () => { filter = v; filters.querySelectorAll('.lp-chip').forEach(x => x.classList.toggle('on', x === b)); active = 0; render(); input.focus(); });
      filters.append(b);
    }
    const crumbs = h('div', { class: 'lp-crumbs' });
    const list = h('div', { class: 'lp-list', tabindex: '-1' });
    const body = h('div', { class: 'lp' }, h('div', { class: 'lp-top' }, h('span', { class: 'lp-icon', html: icon('search', 'sm') }), input, scopeBtns), filters, crumbs, list);

    const childrenOf = (uuid) => (uuid ? (lib.get(uuid) || {}).children || [] : lib.nodes);
    const passes = (n) => filter === 'all' || typeOf(n) === filter || n.kind === 'group';

    // Alle Datensätze unterhalb eines Ordners (für die Suche)
    const allBelow = (uuid) => {
      const out = [];
      const walk = (list, path) => {
        for (const n of list) {
          if (skip.has(n.uuid)) continue;
          if (n.kind === 'bundle') {
            out.push({ n: { ...n, uuid: n.note, kind: 'note' }, path, bundle: n });
            // Die PDF-Fassung im Eintrags-Ordner auch finden
            for (const c of n.children || []) if (c.uuid !== n.note && !c.inBundle && !skip.has(c.uuid)) out.push({ n: c, path: path ? `${path} / ${n.name}` : n.name });
            continue;
          }
          out.push({ n, path });
          if (n.kind === 'group') walk(n.children || [], path ? `${path} / ${n.name}` : n.name);
        }
      };
      const startPath = uuid ? lib.pathOf(uuid) ? `${lib.pathOf(uuid)} / ${lib.get(uuid).name}` : lib.get(uuid).name : '';
      walk(childrenOf(uuid), startPath);
      return out;
    };

    const renderCrumbs = () => {
      crumbs.innerHTML = '';
      const chain = folder ? [...lib.ancestors(folder), lib.get(folder)] : [];
      const up = h('button', { class: 'btn icon-only sm lp-up', 'data-tip': 'Einen Ordner nach oben (←)', html: icon('chevronLeft', 'sm'), disabled: !folder });
      up.addEventListener('click', () => goUp());
      crumbs.append(up);
      const seg = (label, uuid, last) => {
        const b = h('button', { class: 'lp-crumb' + (last ? ' last' : ''), text: label, type: 'button' });
        b.addEventListener('click', () => open(uuid));
        crumbs.append(b);
        if (!last) crumbs.append(h('span', { class: 'lp-sep', text: '›' }));
      };
      seg((root && root.name) || 'Datenbank', null, !chain.length);
      chain.forEach((g, i) => seg(g.name, g.uuid, i === chain.length - 1));
    };

    const row = (it, i, withPath) => {
      const n = it.n;
      const isFolder = n.kind === 'group';
      const r = h('div', { class: 'lp-row' + (i === active ? ' on' : '') + (isFolder ? ' folder' : '') });
      r.innerHTML = icon(isFolder ? 'folder' : iconFor(n.kind === 'note' ? { kind: 'note' } : n));
      const txt = h('div', { class: 'lp-txt' });
      txt.innerHTML = `<span class="lp-name">${highlight(n.name, query)}</span>` + (withPath && it.path ? `<span class="lp-path">${esc(it.path)}</span>` : '');
      r.append(txt);
      const ext = !isFolder && n.kind !== 'note' && (n.ext || (n.kind === 'pdf' ? 'pdf' : ''));
      if (ext) r.append(h('span', { class: 'lp-ext', text: ext.toUpperCase() }));
      if (isFolder) r.append(h('span', { class: 'lp-go', html: icon('chevronRight', 'sm') }));
      r.addEventListener('mouseenter', () => { active = i; mark(); });
      r.addEventListener('click', () => choose(i));
      return r;
    };

    function render() {
      query = input.value.trim();
      renderCrumbs();
      list.innerHTML = '';
      items = [];
      if (query) {
        const words = norm(query).split(/\s+/).filter(Boolean);
        const pool = allBelow(scope === 'here' ? folder : null).filter(it => passes(it.n) && (filter === 'all' || it.n.kind !== 'group'));
        const scored = [];
        for (const it of pool) {
          const name = norm(it.n.name), path = norm(it.path);
          if (!words.every(w => name.includes(w) || path.includes(w))) continue;
          let s = words.every(w => name.includes(w)) ? 2 : 1;
          if (name.startsWith(words[0])) s += 2;
          if (it.n.kind === 'group') s -= 0.5;
          // Treffer im aktuellen Ordner zuerst
          if (folder && lib.ancestors(it.n.uuid).some(a => a.uuid === folder)) s += 0.5;
          scored.push({ it, s });
        }
        scored.sort((a, b) => b.s - a.s || a.it.n.name.localeCompare(b.it.n.name, 'de'));
        items = scored.slice(0, 80).map(x => x.it);
        if (!items.length) list.append(h('div', { class: 'lp-empty', text: 'Nichts gefunden' }));
        items.forEach((it, i) => list.append(row(it, i, true)));
      } else {
        for (const n of childrenOf(folder)) {
          if (skip.has(n.uuid) || !passes(n)) continue;
          if (n.kind === 'bundle') { items.push({ n: { ...n, uuid: n.note, kind: 'note' }, bundle: n }); continue; }
          items.push({ n });
        }
        if (!items.length) list.append(h('div', { class: 'lp-empty', text: filter === 'all' ? 'Dieser Ordner ist leer' : 'Keine passenden Dateien in diesem Ordner' }));
        items.forEach((it, i) => list.append(row(it, i, false)));
      }
      active = Math.min(active, Math.max(0, items.length - 1));
      mark();
    }

    function mark() {
      list.querySelectorAll('.lp-row').forEach((el, k) => el.classList.toggle('on', k === active));
      const on = list.querySelectorAll('.lp-row')[active];
      if (on) on.scrollIntoView({ block: 'nearest' });
    }

    function open(uuid) {
      folder = uuid;
      input.value = '';
      active = 0;
      render();
      input.focus();
    }

    function goUp() {
      if (!folder) return;
      const from = folder;
      const p = lib.parentOf(folder);
      open(p && p.uuid !== (root && root.uuid) ? p.uuid : null);
      // Den Ordner markieren, aus dem man kam
      const i = items.findIndex(it => it.n.uuid === from);
      if (i >= 0) { active = i; mark(); }
    }

    function choose(i) {
      const it = items[i];
      if (!it) return;
      if (it.n.kind === 'group') { open(it.n.uuid); return; }
      result = { uuid: it.n.uuid, name: it.n.name, kind: it.n.kind };
      d.close(true);
    }

    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'ArrowRight' && !input.value && items[active] && items[active].n.kind === 'group') { e.preventDefault(); open(items[active].n.uuid); }
      else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && !input.value) { e.preventDefault(); goUp(); }
    });

    const d = dialog({
      title, body, class: 'lp-dialog',
      actions: [{ label: 'Abbrechen', value: null }]
    });
    d.done.then((v) => resolve(v ? result : null));
    render();
    setTimeout(() => input.focus(), 30);
  });
}

function highlight(text, q) {
  const t = esc(text);
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return t;
  // Markieren auf dem normalisierten Text, Ausgabe im Original
  const plain = String(text);
  const n = norm(plain);
  const marks = new Array(plain.length).fill(false);
  for (const w of words) {
    let i = n.indexOf(w);
    while (i >= 0) { for (let k = i; k < i + w.length && k < marks.length; k++) marks[k] = true; i = n.indexOf(w, i + w.length); }
  }
  let out = '', open = false;
  for (let i = 0; i < plain.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(plain[i]);
  }
  return out + (open ? '</mark>' : '');
}
