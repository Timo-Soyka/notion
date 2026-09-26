// Rundlauf-Tests: Blöcke → Markdown → Blöcke muss dasselbe ergeben.
// Aufruf: node tests/markdown.test.mjs
import assert from 'node:assert/strict';
import { parseDocument, serializeDocument, block } from '../web/js/core/markdown.js';
import { htmlToSegs, segsToHTML, markdownToSegs, segsToMarkdown, normalizeHTML, applyMark } from '../web/js/core/inline.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log('✗', name); console.log('  ', e.message.split('\n').slice(0, 12).join('\n   ')); }
}

const strip = (blocks) => blocks.map(b => {
  const c = { ...b };
  delete c.id;
  if (c.children) { c.children = strip(c.children); if (!c.children.length) delete c.children; }
  return c;
});

function roundtrip(doc) {
  const md = serializeDocument(doc);
  const back = parseDocument(md);
  return { md, back };
}

// ---- Inline ----
test('inline: fett/kursiv verschachtelt', () => {
  const html = '<b>fett <i>beides</i></b> normal';
  const md = segsToMarkdown(htmlToSegs(html));
  assert.equal(md, '**fett *beides*** normal');
  assert.equal(segsToHTML(markdownToSegs(md)), html);
});

test('inline: Leerzeichen am Rand außerhalb der Sterne', () => {
  const md = segsToMarkdown(htmlToSegs('a<b> fett </b>b'));
  assert.equal(md, 'a **fett** b');
});

test('inline: Link, Code, Formel, Hoch/Tief', () => {
  const html = '<a href="https://example.org">Seite</a> <code>x*y</code> <span class="im" contenteditable="false" data-tex="a^2+b^2"></span> H<sub>2</sub>O x<sup>2</sup>';
  const md = segsToMarkdown(htmlToSegs(html));
  assert.equal(md, '[Seite](https://example.org) `x*y` $a^2+b^2$ H<sub>2</sub>O x<sup>2</sup>');
  assert.equal(segsToHTML(markdownToSegs(md)), html);
});

test('inline: Farben und Markierung', () => {
  const html = '<mark data-c="green">grün markiert</mark> <span data-c="red">rot</span>';
  const md = segsToMarkdown(htmlToSegs(html));
  assert.match(md, /<mark data-c="green" style="background-color:#[0-9A-F]+">grün markiert<\/mark>/);
  assert.equal(segsToHTML(markdownToSegs(md)), html);
});

test('inline: WebKit-Salat wird normalisiert', () => {
  const html = '<span style="font-weight: bold;">A</span><b>B</b><font color="#D44C47">C</font>&nbsp;D<br>';
  assert.equal(normalizeHTML(html), '<b>AB</b><span data-c="red">C</span> D');
});

test('inline: Sonderzeichen werden maskiert und zurückgelesen', () => {
  const html = 'Preis 5$ und *Stern* [Klammer] a_b _x_ 3 &lt; 4';
  const md = segsToMarkdown(htmlToSegs(html));
  assert.equal(segsToHTML(markdownToSegs(md)), html);
});

test('inline: applyMark über Teilbereich', () => {
  const segs = htmlToSegs('Hallo Welt');
  const out = applyMark(segs, 2, 7, 'b', true);
  assert.equal(segsToHTML(out), 'Ha<b>llo W</b>elt');
  assert.equal(segsToHTML(applyMark(out, 0, 10, 'b', false)), 'Hallo Welt');
});

test('inline: Fußnote', () => {
  const html = 'Text<sup class="fn" contenteditable="false" data-note="Die &lt;b&gt;Quelle&lt;/b&gt;"></sup> weiter';
  const ctx = { footnotes: [] };
  const md = segsToMarkdown(htmlToSegs(html), ctx);
  assert.equal(md, 'Text[^1] weiter');
  assert.deepEqual(ctx.footnotes, ['Die **Quelle**']);
});

// ---- Dokument ----
test('Dokument: alle Blocktypen im Rundlauf', () => {
  const doc = {
    meta: { title: 'Quadratwurzeln', number: '1.1', subject: 'Mathe', date: '2026-09-18', tags: ['Wurzeln', 'Potenzen'], font: 'mono' },
    blocks: [
      block('h1', { html: 'Was ist eine Quadratwurzel?' }),
      block('p', { html: 'Eine <b>Quadratwurzel</b> ist <i>im Endeffekt</i> eine Potenz.<br>Neue Zeile.' }),
      block('math', { tex: 'a^b &= c \\\\ \\sqrt[b]{c} &= a' }),
      block('chem', { tex: '2H2 + O2 -> 2H2O' }),
      block('ul', { html: 'Punkt 1', children: [block('ul', { html: 'Unterpunkt' })] }),
      block('ul', { html: 'Punkt 2' }),
      block('ol', { html: 'Erstens' }),
      block('ol', { html: 'Zweitens', children: [block('p', { html: 'Absatz im Punkt' })] }),
      block('ol', { html: 'Drittens' }),
      block('todo', { html: 'Hausaufgabe', checked: false }),
      block('todo', { html: 'Erledigt', checked: true }),
      block('toggle', { html: 'Lösung <b>anzeigen</b>', open: false, children: [block('p', { html: 'Geheim' })] }),
      block('quote', { html: 'Ein Zitat<br>zweite Zeile' }),
      block('callout', { kind: 'merke', html: 'Merke', children: [block('p', { html: 'Wichtiger Satz' }), block('ul', { html: 'mit Liste' })] }),
      block('hr'),
      block('code', { lang: 'python', text: 'def f(x):\n    return x**2\n\n# Kommentar' }),
      block('smiles', { smiles: 'CCO', caption: 'Ethanol' }),
      block('plot', { config: { functions: [{ expr: 'x^2-2' }], xmin: -5, xmax: 5 } }),
      block('image', { src: 'x-devonthink-item://ABC-123', caption: 'Abbildung 1', width: 60, align: 'center' }),
      block('pdf', { src: 'x-devonthink-item://PDF-1', caption: 'Arbeitsblatt', pages: '1-2' }),
      block('table', { rows: [['Kopf 1', 'Kopf <b>2</b>'], ['a | b', '<span class="im" contenteditable="false" data-tex="x^2"></span>']], header: true, aligns: ['left', 'center'], caption: 'Tabelle 1' }),
      block('toc'),
      block('pagebreak'),
      block('p', { html: 'Zentriert', align: 'center' }),
      block('p', { html: 'Aufgabe 10a', children: [block('math', { tex: '0{,}16 + \\sqrt{0{,}16}' })] }),
      block('columns', { children: [
        block('column', { children: [block('p', { html: 'Links' })] }),
        block('column', { children: [block('p', { html: 'Rechts' }), block('math', { tex: 'x=1' })] })
      ] }),
      block('p', { html: '' }),
      block('p', { html: 'Nach Leerzeile' }),
      block('h2', { html: 'Unterabschnitt' }),
      block('h3', { html: 'Unterunterabschnitt' }),
      block('p', { html: '# kein Titel und - keine Liste' }),
    ]
  };
  const { md, back } = roundtrip(doc);
  const exp = strip(doc.blocks);
  const got = strip(back.blocks);
  for (let k = 0; k < Math.max(exp.length, got.length); k++) {
    try { assert.deepEqual(got[k], exp[k]); }
    catch (e) { console.log(md); throw new Error(`Block ${k} (${exp[k] && exp[k].type}): ` + e.message); }
  }
  assert.equal(back.meta.title, 'Quadratwurzeln');
  assert.equal(back.meta.number, '1.1');
  assert.deepEqual(back.meta.tags, ['Wurzeln', 'Potenzen']);
  assert.equal(back.meta.subject, 'Mathe');
});

test('Dokument: Fußnoten im Rundlauf', () => {
  const doc = { meta: { title: 'T' }, blocks: [
    block('p', { html: 'Satz<sup class="fn" contenteditable="false" data-note="Erste &lt;i&gt;Quelle&lt;/i&gt;"></sup> und<sup class="fn" contenteditable="false" data-note="Zweite"></sup>.' }),
    block('toggle', { html: 'Mit Fußnote<sup class="fn" contenteditable="false" data-note="Dritte"></sup>', children: [] })
  ] };
  const { md, back } = roundtrip(doc);
  assert.match(md, /\[\^1\]: Erste \*Quelle\*/);
  assert.equal(back.blocks[0].html, doc.blocks[0].html);
  assert.equal(back.blocks[1].html, doc.blocks[1].html);
});

test('Fremdes Markdown: Obsidian/Standard', () => {
  const md = `# Titel

Ein Absatz
über zwei Zeilen.

* Stern-Liste
* noch einer
    * tief

1) Klammer-Liste
2) zwei

> [!NOTE] Hinweis
> Inhalt

Setext
------

| a | b |
|---|---|
| 1 | 2 |
`;
  const doc = parseDocument(md, { defaultTitle: 'Datei' });
  // Fremde Datei: Titel bleibt der Name in DEVONthink, die Überschrift ein Block
  assert.equal(doc.meta.title, 'Datei');
  const types = doc.blocks.map(b => b.type);
  assert.deepEqual(types, ['h1', 'p', 'ul', 'ul', 'ol', 'ol', 'callout', 'h2', 'table']);
  assert.equal(doc.blocks[1].html, 'Ein Absatz über zwei Zeilen.');
  assert.equal(doc.blocks[3].children[0].html, 'tief');
  assert.equal(doc.blocks[6].kind, 'note');
  // Ohne Namen wird die Überschrift zum Titel
  assert.equal(parseDocument(md).meta.title, 'Titel');
  // Nummer aus dem Namen bleibt erhalten
  assert.equal(parseDocument('Text', { defaultTitle: 'Quadratwurzeln', recordName: '1.1 Quadratwurzeln' }).meta.number, '1.1');
});

test('Leeres Dokument', () => {
  const back = parseDocument(serializeDocument({ meta: { title: 'Leer' }, blocks: [block('p')] }));
  assert.equal(back.meta.title, 'Leer');
  assert.equal(back.blocks.length, 0);
});

console.log(`${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
