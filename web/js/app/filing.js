// Dialog „Fach und Thema“: Wohin gehört ein Eintrag?
//
// Oben das Fach, darunter die Themen dieses Fachs als Baum – beliebig tief.
// Auf jeder Ebene lassen sich neue Themen anlegen; sie entstehen in
// DEVONthink erst beim Ablegen. Die Nummer wird aus Thema und Unterthemen
// gebildet und nimmt den nächsten freien Platz (1.1 → 1.1.2).

import { h, dialog, naturalCompare } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { subjectColor, colorDot } from '../core/subjects.js';
import { topicChain, nextSlot, joinNumber, slotOf } from '../core/filing.js';
import { nextEntryNumber } from '../core/numbering.js';

// → Promise: null (abgebrochen), { remove: true } oder
//   { subject, home, path: [{ uuid } | { tmp, name }], number }
export function filingDialog(app, { uuid, meta }) {
  const lib = app.lib;
  const subjects = app.settings.subjects || [];
  const format = app.settings.entryNumbers || 'off';
  const here = lib.placeOf(uuid);
  const self = new Set([uuid]);
  { const b = lib.parentOf(uuid); if (b && b.kind === 'bundle') self.add(b.uuid); }

  let subject = meta.subject || lib.guessSubject(here, subjects) || null;
  let home = null, root = null, selected = null, adding = null, tmpId = 0;
  let number = meta.number || '', numberTouched = false;
  const expanded = new Set();
  const byKey = new Map();

  // Themenbaum aus der Bibliothek (Eintrags-Ordner sind keine Themen)
  const model = (n) => {
    const node = {
      key: n.uuid, uuid: n.uuid, name: n.name, children: [],
      entries: (n.children || []).filter(c => c.kind !== 'group' && !self.has(c.uuid)).map(c => c.name)
    };
    for (const c of n.children || []) if (c.kind === 'group') { const m = model(c); m.parent = node; node.children.push(m); }
    byKey.set(node.key, node);
    return node;
  };

  const load = () => {
    byKey.clear();
    adding = null;
    if (!subject) { home = null; root = null; selected = null; return; }
    home = lib.subjectHome(subject, subjects, here);
    const g = home.entries && lib.get(home.entries);
    root = g ? model(g) : { key: 'new', name: home.path[home.path.length - 1], children: [], entries: [] };
    root.isRoot = true;
    byKey.set(root.key, root);
    selected = byKey.has(here) ? here : root.key;
    for (let n = byKey.get(selected); n; n = n.parent) expanded.add(n.key);
    if (!numberTouched) number = proposeNumber();
  };

  const pathTo = (key) => {
    const out = [];
    for (let n = byKey.get(key); n && !n.isRoot; n = n.parent) out.unshift(n);
    return out;
  };

  const slotNames = (n) => [...n.entries, ...n.children.map(c => c.name)];

  function proposeNumber() {
    if (!root) return meta.number || '';
    const n = byKey.get(selected);
    const chain = topicChain(pathTo(selected).map(x => x.name));
    // Bleibt der Eintrag, wo er ist, behält er seine Nummer – außer ein neues
    // Unterthema hat den Platz inzwischen belegt
    if (selected === here && meta.number) {
      const own = slotOf(`${meta.number} x`, chain);
      if (format !== 'chapter' || !slotNames(n).some(s => slotOf(s, chain) === own)) return meta.number;
    }
    if (format === 'off') return meta.number || '';
    if (format !== 'chapter') return nextEntryNumber(n.entries, '', format);
    return joinNumber(chain, nextSlot(slotNames(n), chain));
  }

  // Vorschlag für den Namen eines neuen Themas: „1.2 “ usw.
  const topicPrefix = (parent) => {
    if (format === 'off') return '';
    const names = slotNames(parent);
    if (format !== 'chapter') return nextSlot(names, '') + ' ';
    const chain = topicChain(pathTo(parent.key).map(x => x.name));
    return joinNumber(chain, nextSlot(names, chain)) + ' ';
  };

  // ---------------------------------------------------------------------------

  const subjectsEl = h('div', { class: 'filing-subjects' });
  const treeEl = h('div', { class: 'filing-tree' });
  const numberInput = h('input', { class: 'input filing-number', spellcheck: 'false', placeholder: 'ohne' });
  const whereEl = h('div', { class: 'filing-where' });
  const addTop = h('button', { class: 'btn sm ghost filing-add' }, icon('plus', 'sm'), 'Neues Thema');

  const renderSubjects = () => {
    subjectsEl.innerHTML = '';
    for (const s of subjects) {
      const c = subjectColor(app.settings, s);
      const chip = h('button', { class: 'filing-subject' + (s === subject ? ' on' : ''), 'data-c': c || null, type: 'button' });
      chip.innerHTML = colorDot(c, 9);
      chip.append(s);
      chip.addEventListener('click', () => {
        if (s === subject) return;
        subject = s;
        load();
        render();
      });
      subjectsEl.append(chip);
    }
  };

  const row = (n, depth) => {
    const open = expanded.has(n.key);
    const r = h('div', { class: 'filing-row' + (n.key === selected ? ' on' : '') + (n.tmp ? ' new' : ''), style: { paddingLeft: 6 + depth * 18 + 'px' } });
    const tw = h('span', { class: 'twisty' + (open ? ' open' : '') + (n.children.length ? '' : ' empty') }, icon('chevronRight', 'sm'));
    tw.addEventListener('click', (e) => { e.stopPropagation(); open ? expanded.delete(n.key) : expanded.add(n.key); renderTree(); });
    const label = n.isRoot ? h('span', { class: 'label' }, h('span', { class: 'muted', text: 'Ohne Thema – direkt in ' }), `„${n.name}“`) : h('span', { class: 'label', text: n.name });
    const add = h('button', { class: 'filing-sub', type: 'button', 'data-tip': n.isRoot ? 'Neues Thema' : 'Unterthema anlegen' }, icon('plus', 'sm'));
    add.addEventListener('click', (e) => { e.stopPropagation(); startAdd(n); });
    r.append(n.isRoot ? h('span', { class: 'twisty empty' }) : tw, h('span', { class: 'kind-icon' }, icon(n.isRoot ? 'book' : open && n.children.length ? 'folderOpen' : 'folder', 'sm')), label);
    if (n.tmp) r.append(h('span', { class: 'filing-badge', text: 'neu' }));
    r.append(add);
    r.addEventListener('click', () => select(n.key));
    r.addEventListener('dblclick', () => { select(n.key); confirm(); });
    return r;
  };

  const addRow = (parent, depth) => {
    const input = h('input', { class: 'input', value: topicPrefix(parent), placeholder: parent.isRoot ? 'Name des Themas' : 'Name des Unterthemas', spellcheck: 'false' });
    const ok = h('button', { class: 'btn sm primary', type: 'button', text: 'Anlegen' });
    const commit = () => {
      const name = input.value.trim();
      if (!name || /^\d+(?:\.\d+)*$/.test(name)) { input.focus(); input.classList.add('bad'); return; }
      const node = { key: 'tmp' + ++tmpId, tmp: true, name, children: [], entries: [], parent };
      parent.children.push(node);
      parent.children.sort((a, b) => naturalCompare(a.name, b.name));
      byKey.set(node.key, node);
      expanded.add(parent.key);
      adding = null;
      select(node.key);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
    });
    ok.addEventListener('click', commit);
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 20);
    return h('div', { class: 'filing-row adding', style: { paddingLeft: 6 + depth * 18 + 'px' } }, h('span', { class: 'kind-icon' }, icon('folder', 'sm')), input, ok);
  };

  const renderTree = () => {
    treeEl.innerHTML = '';
    if (!root) {
      treeEl.append(h('div', { class: 'filing-empty', text: 'Wähle oben zuerst ein Fach.' }));
      return;
    }
    const walk = (n, depth) => {
      treeEl.append(row(n, depth));
      if (n.isRoot || expanded.has(n.key)) for (const c of n.children) walk(c, depth + (n.isRoot ? 0 : 1));
      if (adding === n.key) treeEl.append(addRow(n, depth + (n.isRoot ? 0 : 1)));
    };
    walk(root, 0);
    if (!root.children.length && adding !== root.key) treeEl.append(h('div', { class: 'filing-empty', text: 'Noch keine Themen – leg das erste mit „Neues Thema“ an.' }));
    const on = treeEl.querySelector('.filing-row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };

  const renderWhere = () => {
    whereEl.innerHTML = '';
    if (!root) return;
    const parts = [...home.path, ...pathTo(selected).map(n => n.name)];
    whereEl.append(h('span', { html: icon('arrowRight', 'sm') }), h('span', { text: parts.join(' › ') }));
    if (home.create) whereEl.append(h('span', { class: 'filing-badge', text: `„${home.create.names.join(' › ')}“ wird angelegt` }));
    const title = meta.title || 'Unbenannt';
    whereEl.append(h('div', { class: 'filing-name' }, h('span', { class: 'muted', text: 'Name: ' }), `${number.trim() ? number.trim() + ' ' : ''}${title}`));
  };

  const render = () => {
    renderSubjects();
    renderTree();
    numberInput.value = number;
    addTop.disabled = !root;
    renderWhere();
  };

  function select(key) {
    selected = key;
    if (!numberTouched) number = proposeNumber();
    render();
  }

  function startAdd(parent) {
    adding = parent.key;
    if (!parent.isRoot) expanded.add(parent.key);
    renderTree();
  }

  numberInput.addEventListener('input', () => { number = numberInput.value; numberTouched = true; renderWhere(); });
  numberInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
  addTop.addEventListener('click', () => root && startAdd(root));

  const reset = h('button', { class: 'btn sm ghost', type: 'button', 'data-tip': 'Nächsten freien Platz vorschlagen' }, icon('refresh', 'sm'));
  reset.addEventListener('click', () => { numberTouched = false; number = proposeNumber(); render(); });

  const remove = meta.subject ? h('button', { class: 'btn sm ghost danger filing-remove', type: 'button', text: 'Fach entfernen' }) : null;

  const body = h('div', { class: 'filing' },
    h('div', { class: 'filing-label', text: 'Fach' }), subjectsEl,
    h('div', { class: 'filing-label' }, 'Thema', h('span', { class: 'muted', text: ' · so tief verschachtelt, wie du möchtest – „+“ legt ein Unterthema an' })),
    treeEl, addTop,
    h('div', { class: 'filing-bottom' },
      h('label', { class: 'filing-number-row' }, h('span', { text: 'Nummer' }), numberInput, reset),
      whereEl),
    remove);

  let result = null;
  load();
  const d = dialog({
    title: 'Fach und Thema', body, class: 'filing-dialog',
    onEscape: () => { if (adding) { adding = null; renderTree(); return true; } return false; },
    actions: [
      { label: 'Abbrechen', value: null },
      { label: 'Ablegen', primary: true, value: true, onClick: () => confirm(true) }
    ]
  });
  if (remove) remove.addEventListener('click', () => { result = { remove: true }; d.close(true); });

  function confirm(fromButton) {
    if (!root) { subjectsEl.classList.remove('shake'); void subjectsEl.offsetWidth; subjectsEl.classList.add('shake'); return false; }
    result = { subject, home, path: pathTo(selected).map(n => (n.tmp ? { tmp: true, name: n.name } : { uuid: n.uuid, name: n.name })), number: number.trim() };
    if (!fromButton) d.close(true);
    return true;
  }

  render();
  setTimeout(() => { const on = treeEl.querySelector('.filing-row.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }, 30);
  return d.done.then(v => (v ? result : null));
}
