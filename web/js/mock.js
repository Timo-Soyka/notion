// Nachbau der Mac-App-Schnittstelle für die Entwicklung im Browser.
// Hält eine kleine Beispiel-Bibliothek im localStorage.

const KEY = 'heft-mock-db-v1';

const WELCOME = `---
title: Willkommen bei Heft
subject: Allgemein
date: 2026-09-26
tags: [Anleitung]
heft: 1
---

# Willkommen bei Heft

## Blöcke und die Schrägstrich-Taste

Tippe **/** am Anfang einer Zeile oder nach einem Leerzeichen, um einen Block einzufügen: Überschriften, Listen, Formeln, Funktionsgraphen, Strukturformeln, Tabellen, Merkkästen und vieles mehr.

> [!merke] Tastenkürzel wie in Notion
> - \`#\` + Leertaste → Überschrift, \`-\` → Aufzählung, \`1.\` → Nummerierung
> - \`[]\` → To-do, \`>\` → Toggle, \`"\` → Zitat, \`---\` → Trennlinie
> - \`$$\` → Formelblock, \`\` \`\`\` \`\` → Code

## Formeln

Formeln im Text: $a^2 + b^2 = c^2$ – einfach zwischen Dollarzeichen schreiben. Du kannst wie in Typst schreiben: $root(2, 0,16) = 0,4$.

$$
z^2 - 9 &= 16 &&| +9 \\
z^2 &= 25 &&| root(2, ~) \\
z &= 5
$$

## Chemie

$$
\\ce{2H2 + O2 -> 2H2O}
$$

\`\`\`smiles caption="Ethanol"
CCO
\`\`\`

## Funktionsgraph

\`\`\`plot
{
  "functions": [
    { "expr": "f(x) = x^2 - 2" },
    { "expr": "g(x) = 0,5x + 1" }
  ],
  "xmin": -4, "xmax": 4, "ymin": -3, "ymax": 5,
  "special": true
}
\`\`\`

## Tabellen

| $x$ | $f(x)$ |
| :---: | :---: |
| 0 | −2 |
| 1 | −1 |
| 2 | 2 |
[Wertetabelle]

- [ ] Hausaufgabe: Buch S. 8 Nr. 10
- [x] Arbeitsblatt abgeheftet

<details>
<summary>Lösung anzeigen</summary>

Die Lösung ist $x = \\pm\\sqrt{2}$[^1].

</details>

[^1]: Das sind etwa ±1,41.
`;

const QW = `---
title: Quadratwurzeln
number: "1.1"
subject: Mathe
date: 2026-09-18
tags: [Wurzeln]
font: mono
numbering: "1.1"
heft: 1
---

# 1.1 Quadratwurzeln

## Was ist eine Quadratwurzel?

Eine Quadratwurzel ist im Endeffekt einfach nur eine andere Schreibweise für eine Potenz:

$$
a^b &= c \\
root(b, c) &= a
$$

Im Grunde formt man die Potenz also einfach nur um, sodass die Basis als Ergebnis isoliert wird.

## Negative Radikanden

Grundlegend ist es zwar nicht unmöglich, eine Wurzel aus einem negativen Radikanden zu ziehen, allerdings ist das Ergebnis dann keine reelle Zahl mehr.

$$
i^2=-1
$$

<div style="page-break-after: always;"></div>

## Übungen

<div align="center">

$$
"Buch" &"Seite 8 Nummer 10; 12" \\
&"Seite" 9 "Nummer 18"
$$

</div>

<div class="columns">
<div class="column">

***10a***

<div class="indent">

$$
0,16 + root(2, 0.16) = 0,16 + 0,4 = 0,56
$$

</div>

</div>
<div class="column">

***18c***

<div class="indent">

$$
z^2 -9 &= 16 &&|+9 \\
z^2 &= 25 &&|root(2, ~) \\
z &= 5
$$

</div>

</div>
</div>
`;

function uid() {
  return 'M' + Math.random().toString(36).slice(2, 10).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
}

function seed() {
  const n = (name, kind, extra = {}) => ({ uuid: uid(), name, kind, modified: new Date().toISOString(), ...extra });
  const welcome = n('Willkommen bei Heft', 'note');
  const qw = n('1.1 Quadratwurzeln', 'note');
  const ab = n('Einstieg Quadratwurzeln', 'pdf');
  const db = {
    root: { uuid: 'ROOT', name: '01 Fächer' },
    nodes: [
      welcome,
      n('Mathe', 'group', { children: [
        n('Hefteinträge', 'group', { children: [
          n('1 Reelle Zahlen', 'group', { children: [qw] })
        ] }),
        n('Arbeitsblätter', 'group', { children: [ab] }),
        n('Hausaufgaben', 'group', { children: [] })
      ] }),
      n('Physik', 'group', { children: [n('Hefteinträge', 'group', { children: [] }), n('Arbeitsblätter', 'group', { children: [] })] }),
      n('Chemie', 'group', { children: [n('Hefteinträge', 'group', { children: [] })] }),
      n('Biologie', 'group', { children: [] }),
      n('Deutsch', 'group', { children: [] })
    ],
    notes: { [welcome.uuid]: WELCOME, [qw.uuid]: QW },
    settings: { configured: true, database: 'DB1', databaseName: 'Schule', root: 'ROOT', rootName: '01 Fächer' }
  };
  return db;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* neu anlegen */ }
  const db = seed();
  save(db);
  return db;
}
function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

function find(nodes, uuid, parent = null) {
  for (const x of nodes) {
    if (x.uuid === uuid) return { node: x, parent, list: nodes };
    if (x.children) {
      const r = find(x.children, uuid, x);
      if (r) return r;
    }
  }
  return null;
}

const delay = (v, ms = 40) => new Promise(r => setTimeout(() => r(v), ms));

export const mock = {
  'app.info': () => delay({ version: 'dev', native: false }),
  'settings.get': () => delay(load().settings),
  'settings.set': ({ settings }) => { const db = load(); db.settings = { ...db.settings, ...settings }; save(db); return delay(db.settings); },
  'dt.status': () => delay({ running: true, databases: [{ uuid: 'DB1', name: 'Schule' }, { uuid: 'DB2', name: 'TS Privat' }] }),
  'dt.groups': () => {
    const db = load();
    const strip = (nodes) => nodes.filter(x => x.kind === 'group').map(x => ({ uuid: x.uuid, name: x.name, children: strip(x.children || []) }));
    return delay([{ uuid: 'ROOT', name: '01 Fächer', children: strip(db.nodes) }]);
  },
  'lib.tree': () => { const db = load(); return delay({ root: db.root, nodes: db.nodes }); },
  'note.read': ({ uuid }) => {
    const db = load();
    const f = find(db.nodes, uuid);
    return delay({ uuid, name: f ? f.node.name : 'Unbekannt', markdown: db.notes[uuid] || '', modified: f && f.node.modified });
  },
  'note.write': ({ uuid, markdown, name }) => {
    const db = load();
    db.notes[uuid] = markdown;
    const f = find(db.nodes, uuid);
    if (f) { f.node.modified = new Date().toISOString(); if (name) f.node.name = name; }
    save(db);
    return delay({ ok: true, modified: f && f.node.modified }, 60);
  },
  'note.create': ({ parent, name, markdown }) => {
    const db = load();
    const node = { uuid: uid(), name: name || 'Unbenannt', kind: 'note', modified: new Date().toISOString() };
    const list = parent && parent !== 'ROOT' ? (find(db.nodes, parent)?.node.children) : db.nodes;
    (list || db.nodes).push(node);
    db.notes[node.uuid] = markdown || '';
    save(db);
    return delay({ uuid: node.uuid });
  },
  'group.create': ({ parent, name }) => {
    const db = load();
    const node = { uuid: uid(), name: name || 'Neuer Ordner', kind: 'group', children: [], modified: new Date().toISOString() };
    const list = parent && parent !== 'ROOT' ? (find(db.nodes, parent)?.node.children) : db.nodes;
    (list || db.nodes).push(node);
    save(db);
    return delay({ uuid: node.uuid });
  },
  'record.rename': ({ uuid, name }) => {
    const db = load();
    const f = find(db.nodes, uuid);
    if (f) f.node.name = name;
    save(db);
    return delay({ ok: true });
  },
  'record.move': ({ uuid, to }) => {
    const db = load();
    const f = find(db.nodes, uuid);
    if (!f) return delay({ ok: false });
    f.list.splice(f.list.indexOf(f.node), 1);
    const target = to === 'ROOT' ? db.nodes : find(db.nodes, to)?.node.children;
    (target || db.nodes).push(f.node);
    save(db);
    return delay({ ok: true });
  },
  'record.trash': ({ uuid }) => {
    const db = load();
    const f = find(db.nodes, uuid);
    if (f) f.list.splice(f.list.indexOf(f.node), 1);
    save(db);
    return delay({ ok: true });
  },
  'record.reveal': () => delay({ ok: true }),
  'record.openExternal': () => delay({ ok: true }),
  'record.link': ({ uuid }) => delay({ link: `x-devonthink-item://${uuid}` }),
  'asset.add': ({ note, name, data, mime }) => {
    const u = uid();
    try {
      const store = JSON.parse(localStorage.getItem('heft-mock-assets') || '{}');
      store[u] = `data:${mime};base64,${data}`;
      localStorage.setItem('heft-mock-assets', JSON.stringify(store));
    } catch { /* zu groß für localStorage – Platzhalter genügt */ }
    return delay({ uuid: u, link: `x-devonthink-item://${u}`, name });
  },
  'asset.pick': () => delay([]),
  'pdf.import': () => delay([]),
  'pdf.info': () => delay({ pages: 2 }),
  'pdf.open': () => delay({ ok: false, reason: 'Nur in der Mac-App' }),
  'pdf.close': () => delay({ ok: true }),
  'pdf.rect': () => delay({ ok: true }),
  'pdf.tool': () => delay({ ok: true }),
  'pdf.action': () => delay({ ok: true }),
  'export.pdf': () => { window.print(); return delay({ ok: true }); },
  'export.companion': () => delay({ ok: true, pdf: uid() }, 400),
  'print': () => { window.print(); return delay({ ok: true }); },
  'search': ({ query }) => {
    const db = load();
    const q = String(query || '').toLowerCase();
    const out = [];
    const walk = (nodes, path) => {
      for (const x of nodes) {
        const text = (db.notes[x.uuid] || '').toLowerCase();
        if (q && (x.name.toLowerCase().includes(q) || text.includes(q))) out.push({ uuid: x.uuid, name: x.name, kind: x.kind, location: path });
        if (x.children) walk(x.children, path + '/' + x.name);
      }
    };
    walk(db.nodes, '');
    return delay(out.slice(0, 30), 120);
  },
  'open.url': ({ url }) => { window.open(url, '_blank'); return delay({ ok: true }); },
  'chem.lookup': ({ name }) => delay(null, 200),
  'window.state': () => delay({ ok: true })
};
