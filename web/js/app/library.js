// Bibliothek: der Ordnerbaum aus DEVONthink, im Speicher gehalten.
//
// Der Baum kommt in einem Rutsch aus DEVONthink (die Mac-App fragt alle
// Datensätze gesammelt ab, das dauert nur Sekundenbruchteile) und wird hier
// für Suche, Pfadanzeige und "Zuletzt geöffnet" aufbereitet.

import { call, on, setAssetStamp } from '../bridge.js';
import { naturalCompare } from '../ui/ui.js';
import { subjectOfFolder } from '../core/subjects.js';
import { isEntriesFolder, leadNumber } from '../core/filing.js';

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
    // Geänderte Bilder, PDFs usw. merken – offene Einträge laden sie dann neu
    this.changedFiles = [];
    const walk = (list, parent, path) => {
      for (const n of list) {
        this.index.set(n.uuid, { node: n, parent, path });
        if (n.kind !== 'group' && n.kind !== 'note' && n.kind !== 'bundle' && setAssetStamp(n.uuid, n.modified)) this.changedFiles.push(n.uuid);
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

  // Alle Dateien flach – Einträge, PDFs, Bilder, alles andere (für Suche und Verlinkung)
  flatDocs() {
    const out = [];
    const walk = (list, path) => {
      for (const n of list) {
        if (n.kind !== 'group' && n.kind !== 'bundle') out.push({ uuid: n.uuid, node: n, name: n.name, kind: n.kind, path });
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

  // Ordner, in dem ein Eintrag liegt (bei eigenem Eintrags-Ordner: der Ordner darüber)
  placeOf(uuid) {
    let p = this.parentOf(uuid);
    while (p && p.kind === 'bundle') p = this.parentOf(p.uuid);
    return p ? p.uuid : (this.root && this.root.uuid);
  }

  // Themen-Ordner über einem Ordner bis hinauf zum Fach bzw. „Hefteinträge“
  topicPath(groupUuid, subjects) {
    const chain = groupUuid ? [...this.ancestors(groupUuid), this.get(groupUuid)].filter(Boolean) : [];
    for (let k = chain.length - 1; k >= 0; k--) {
      if (isEntriesFolder(chain[k].name) || subjectOfFolder(chain[k].name, subjects)) return chain.slice(k + 1);
    }
    // Kein Fach in Sicht: nur die nummerierten Ordner direkt darüber
    const out = [];
    for (let k = chain.length - 1; k >= 0 && leadNumber(chain[k].name); k--) out.unshift(chain[k]);
    return out;
  }

  // Wo liegen die Einträge eines Fachs? → { subject, entries, path } oder
  // { create: { parent, names }, path }, wenn der Ordner noch fehlt.
  // Gibt es das Fach mehrfach (z. B. in zwei Schuljahren), gewinnt das in der
  // Nähe von `nearUuid`, sonst das neueste.
  subjectHome(subject, subjects, nearUuid) {
    const near = nearUuid ? new Set([nearUuid, ...this.ancestors(nearUuid).map(a => a.uuid)]) : new Set();
    const rank = (list) => list.map(g => {
      const anc = this.ancestors(g.uuid);
      return { g, shared: anc.filter(a => near.has(a.uuid)).length, depth: anc.length, path: this.pathOf(g.uuid) };
    }).sort((a, b) => b.shared - a.shared || a.depth - b.depth || naturalCompare(b.path, a.path)).map(x => x.g);
    const groups = [];
    const walk = (list) => { for (const n of list) if (n.kind === 'group') { groups.push(n); walk(n.children || []); } };
    walk(this.nodes);
    const label = (uuid, extra = []) => [...this.ancestors(uuid), this.get(uuid)].filter(Boolean).map(a => a.name).concat(extra);
    const entriesIn = (g) => (g.children || []).find(c => c.kind === 'group' && isEntriesFolder(c.name));
    const own = rank(groups.filter(g => subjectOfFolder(g.name, [subject])));
    if (own.length) {
      const g = own[0], e = entriesIn(g) || g;
      return { subject: g.uuid, entries: e.uuid, path: label(e.uuid) };
    }
    // Neu anlegen – neben den anderen Fächern und genauso aufgebaut
    const other = rank(groups.filter(g => subjectOfFolder(g.name, (subjects || []).filter(x => x !== subject))));
    const sib = other[0];
    const parent = sib ? this.parentOf(sib.uuid) : null;
    const sibEntries = sib && entriesIn(sib);
    const names = sibEntries ? [subject, sibEntries.name] : [subject];
    return { create: { parent: parent ? parent.uuid : (this.root && this.root.uuid), names }, path: parent ? label(parent.uuid, names) : names };
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

// Reihenfolge wie im Heft: Alles mit Nummer nach der Nummer – Themen und
// Einträge gemischt, denn sie teilen sich die Plätze (1.1.1 Eintrag,
// 1.1.2 Unterthema, …). Relativ benannte Unterthemen („1 Quadratzahlen“ im
// Thema 1) zählen dabei als 1.1. Danach Ordner und Einträge ohne Nummer.
// Bei gleichem Namen kommt der Eintrag vor seiner PDF.
export function sortNodes(list, chain = '') {
  const keyOf = (n) => {
    const lead = leadNumber(n.name);
    if (!lead) return null;
    return (chain && !lead.includes('.') ? `${chain}.${lead}` : lead).split('.').map(Number);
  };
  const rank = (n) => ({ note: 0, bundle: 1, group: 2 })[n.kind] ?? 3;
  const keyed = list.map(n => ({ n, k: keyOf(n) }));
  keyed.sort((a, b) => {
    if (!!a.k !== !!b.k) return a.k ? -1 : 1;
    if (a.k) {
      for (let i = 0; i < Math.max(a.k.length, b.k.length); i++) {
        const d = (a.k[i] ?? -1) - (b.k[i] ?? -1);
        if (d) return d;
      }
    } else {
      const ga = a.n.kind === 'group' ? 0 : 1, gb = b.n.kind === 'group' ? 0 : 1;
      if (ga !== gb) return ga - gb;
    }
    return naturalCompare(a.n.name, b.n.name) || rank(a.n) - rank(b.n);
  });
  list.splice(0, list.length, ...keyed.map(x => x.n));
  for (const n of list) if (n.children) sortNodes(n.children, n.kind === 'group' ? childChain(chain, n.name) : chain);
  return list;
}

// Themennummer eines Unterordners; ein Ordner ohne Nummer beginnt neu
function childChain(chain, name) {
  const lead = leadNumber(name);
  if (!lead) return '';
  if (chain && lead.startsWith(chain + '.')) return lead;
  if (lead.includes('.')) return lead;
  return chain ? `${chain}.${lead}` : lead;
}
