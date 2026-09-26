// Tests für Tabellen mit verbundenen Zellen
import { mergeRect, splitRect, insertRow, insertCol, deleteRow, deleteCol, rectFrom, cellMap, stepCell, setBg, normalizeTable } from '../web/js/core/tablegrid.js';
import { parseDocument, serializeDocument } from '../web/js/core/markdown.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};
const T = (rows, extra = {}) => normalizeTable({ type: 'table', rows: rows.map(r => r.slice()), header: true, ...extra });

// Verbinden: Inhalte landen untereinander in der Ankerzelle
let t = T([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
mergeRect(t, { r1: 0, c1: 0, r2: 1, c2: 1 });
eq('merge', t.merges, [{ r: 0, c: 0, rs: 2, cs: 2 }]);
eq('merge inhalt', t.rows, [['a<br>b<br>d<br>e', '', 'c'], ['', '', 'f'], ['g', 'h', 'i']]);

// Auswahl wird so erweitert, dass keine Verbindung angeschnitten wird
eq('rect', rectFrom(t, { r: 1, c: 1 }, { r: 2, c: 2 }), { r1: 0, c1: 0, r2: 2, c2: 2 });

// Navigation überspringt verdeckte Zellen
eq('tab', stepCell(t, 0, 0, 1), { r: 0, c: 2 });
eq('tab2', stepCell(t, 0, 2, 1), { r: 1, c: 2 });
eq('shift-tab', stepCell(t, 1, 2, -1), { r: 0, c: 2 });

// Zeile in der Verbindung einfügen → Verbindung wird länger
insertRow(t, 1);
eq('insert row inside', t.merges, [{ r: 0, c: 0, rs: 3, cs: 2 }]);
insertRow(t, 0);
eq('insert row above', t.merges, [{ r: 1, c: 0, rs: 3, cs: 2 }]);
insertCol(t, 1);
eq('insert col inside', t.merges, [{ r: 1, c: 0, rs: 3, cs: 3 }]);

// Ankerzeile löschen: Inhalt wandert in die nächste Zeile
t = T([['x', 'y'], ['', 'z']]);
mergeRect(t, { r1: 0, c1: 0, r2: 1, c2: 0 });
deleteRow(t, 0);
eq('delete anchor row', [t.rows, t.merges || null], [[['x', 'z']], null]);

t = T([['a', 'b', 'c']]);
mergeRect(t, { r1: 0, c1: 0, r2: 0, c2: 2 });
deleteCol(t, 1);
eq('delete col inside', t.merges, [{ r: 0, c: 0, rs: 1, cs: 2 }]);
splitRect(t, { r1: 0, c1: 0, r2: 0, c2: 0 });
eq('split', t.merges || null, null);

// Speichern: einfache Tabellen bleiben Markdown, verbundene werden HTML
t = T([['Name', 'Wert', ''], ['<b>x</b>', '<span class="im" data-tex="x^2"></span>', '3']]);
mergeRect(t, { r1: 0, c1: 1, r2: 0, c2: 2 });
setBg(t, { r1: 1, c1: 0, r2: 1, c2: 0 }, 'blue');
t.headerCol = true;
t.caption = 'Messwerte';
const md = serializeDocument({ meta: { title: 'T' }, blocks: [t] });
eq('html', md.includes('<th colspan="2">Wert</th>') && md.includes('data-bg="blue"') && md.includes('$x^2$') && md.includes('data-header-col="1"'), true);
const back = parseDocument(md).blocks.find(b => b.type === 'table');
eq('zurück merges', back.merges, [{ r: 0, c: 1, rs: 1, cs: 2 }]);
eq('zurück inhalt', back.rows[1][1], '<span class="im" contenteditable="false" data-tex="x^2"></span>');
eq('zurück farbe', [back.bg[1][0], back.headerCol, back.header, back.caption], ['blue', true, true, 'Messwerte']);

const plain = serializeDocument({ meta: { title: 'T' }, blocks: [T([['a', 'b'], ['c', 'd']])] });
eq('gfm', plain.includes('| a | b |'), true);

// Fremde HTML-Tabelle mit rowspan
const foreign = parseDocument('<table>\n<tr><th>A</th><th>B</th></tr>\n<tr><td rowspan="2">1</td><td>2</td></tr>\n<tr><td>3</td></tr>\n</table>').blocks[0];
eq('fremd', [foreign.rows, foreign.merges, foreign.header], [[['A', 'B'], ['1', '2'], ['', '3']], [{ r: 1, c: 0, rs: 2, cs: 1 }], true]);
eq('map', cellMap(foreign)[2][0].anchor, false);

console.log(`${ok} bestanden, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
