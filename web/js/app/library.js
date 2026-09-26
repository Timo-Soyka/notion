// Bibliothek: der Ordnerbaum aus DEVONthink, im Speicher gehalten.
//
// Der Baum kommt in einem Rutsch aus DEVONthink (die Mac-App fragt alle
// Datensätze gesammelt ab, das dauert nur Sekundenbruchteile) und wird hier
// für Suche, Pfadanzeige und "Zuletzt geöffnet" aufbereitet.

import { call, on } from '../bridge.js';
import { naturalCompare } from '../ui/ui.js';

export class Library {
  constructor() {
    this.root = null;
    this.nodes = [];
    this.index = new Map();
    this.listeners = new Set();
    this.loading = null;
    on('tree-changed', () => this.refresh());
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await call('lib.tree');
        this.set(res);
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  set(res) {
    this.root = res.root;
    this.nodes = sortNodes(showBundles(res.nodes || []));
    this.reindex();
    this.emit();
  }

  reindex() {
    this.index.clear();
    const walk = (list, parent, path) => {
      for (const n of list) {
        this.index.set(n.uuid, { node: n, parent, path });
        if (n.children) walk(n.children, n, path ? path + ' / ' + n.name : n.name);
      }
    };
    walk(this.nodes, null, '');
  }

  get(uuid) { const e = this.index.get(uuid); return e ? e.node : null; }
  parentOf(uuid) { const e = this.index.get(uuid); return e ? e.parent : null; }
  pathOf(uuid) { const e = this.index.get(uuid); return e ? e.path : ''; }

  ancestors(uuid) {
    const out = [];
    let e = this.index.get(uuid);
    while (e && e.parent) { out.unshift(e.parent); e = this.index.get(e.parent.uuid); }
    return out;
  }

  // Alle Einträge und PDFs flach (für Suche und Verlinkung)
  flatDocs() {
    const out = [];
    const walk = (list, path) => {
      for (const n of list) {
        if (n.kind === 'note' || n.kind === 'pdf') out.push({ uuid: n.uuid, node: n, name: n.name, kind: n.kind, path });
        if (n.children) walk(n.children, path ? path + ' / ' + n.name : n.name);
      }
    };
    walk(this.nodes, '');
    return out;
  }

  flatGroups() {
    const out = [];
    const walk = (list, path, depth) => {
      for (const n of list) {
        if (n.kind !== 'group') continue;  // Eintrags-Ordner sind kein Ablageziel
        out.push({ uuid: n.uuid, name: n.name, path, depth });
        walk(n.children || [], path ? path + ' / ' + n.name : n.name, depth + 1);
      }
    };
    walk(this.nodes, '', 0);
    return out;
  }

  // Fach aus dem Ordnerpfad erraten ("01 Fächer / Mathe / Hefteinträge" → Mathe)
  guessSubject(groupUuid, subjects) {
    const chain = groupUuid ? [...this.ancestors(groupUuid), this.get(groupUuid)].filter(Boolean) : [];
    for (const g of chain.reverse()) {
      const clean = g.name.replace(/^\d+\s*/, '').trim().toLowerCase();
      const hit = subjects.find(s => s.toLowerCase() === clean);
      if (hit) return hit;
    }
    return null;
  }
}

// Ordner eines Eintrags (Eintrag + PDF-Fassung) so zeigen wie in DEVONthink:
// als Ordner, in dem der Eintrag und die PDF liegen.
function showBundles(list) {
  for (const n of list) {
    if (n.kind === 'bundle' && n.note && !(n.children || []).some(c => c.uuid === n.note)) {
      n.children = [{ uuid: n.note, name: n.name, kind: 'note', type: 'markdown', modified: n.modified, inBundle: true }, ...(n.children || [])];
    }
    if (n.children) showBundles(n.children);
  }
  return list;
}

// Themen-Ordner zuerst, dann die Einträge in Nummernfolge – Eintrags-Ordner
// stehen dabei zwischen den Einträgen, damit 1, 2, 3 … zusammenbleiben.
// Bei gleichem Namen kommt der Eintrag vor seiner PDF.
export function sortNodes(list) {
  list.sort((a, b) => {
    const ga = a.kind === 'group' ? 0 : 1, gb = b.kind === 'group' ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return naturalCompare(a.name, b.name) || (a.kind === 'note' ? -1 : b.kind === 'note' ? 1 : 0);
  });
  for (const n of list) if (n.children) sortNodes(n.children);
  return list;
}
