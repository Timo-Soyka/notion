// Tests für Spalten- und Tabellenbreiten
import { parseWidth, formatWidth, distribute, flexFor, fromPx, parseRatioList, CM_PX } from '../web/js/core/widths.js';
import { parseDocument, serializeDocument, block } from '../web/js/core/markdown.js';
import { insertCol, deleteCol, normalizeTable } from '../web/js/core/tablegrid.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};

eq('parse', ['2', '1,5', '5 cm', '40mm', '30 %', '120px', '2fr', '', 'x', '0'].map(parseWidth), ['2fr', '1.5fr', '5cm', '40mm', '30%', '120px', '2fr', null, null, null]);
eq('format', ['2fr', '1.5fr', '5cm', '30%'].map(formatWidth), ['2', '1,5', '5 cm', '30 %']);
eq('flex', [flexFor('2fr'), flexFor('5cm'), flexFor(null)], ['2 1 0', '0 0 5cm', '1 1 0']);
eq('verteilen', distribute(['1fr', '2fr', '1fr'], 400).map(Math.round), [100, 200, 100]);
eq('gemischt', distribute(['2cm', '1fr', '1fr'], 400).map(v => Math.round(v)), [Math.round(2 * CM_PX), Math.round((400 - 2 * CM_PX) / 2), Math.round((400 - 2 * CM_PX) / 2)]);
eq('prozent', distribute(['25%', '1fr'], 400), [100, 300]);
eq('zurück', fromPx(CM_PX * 4.26, '5cm', 500), '4.3cm');
eq('liste', parseRatioList('1 : 2 : 1'), ['1fr', '2fr', '1fr']);

// Spalten nebeneinander: Breiten bleiben beim Speichern erhalten
const cols = block('columns', { children: [block('column', { width: '2fr', children: [block('p', { html: 'links' })] }), block('column', { width: '5cm', children: [block('p', { html: 'rechts' })] })] });
const md = serializeDocument({ meta: { title: 'T' }, blocks: [cols] });
eq('spalten md', md.includes('data-width="2fr"') && md.includes('data-width="5cm"'), true);
const back = parseDocument(md).blocks[0];
eq('spalten zurück', back.children.map(c => c.width), ['2fr', '5cm']);

// Tabellen: Spaltenbreiten und Tabellenbreite
const t = normalizeTable({ type: 'table', rows: [['a', 'b', 'c'], ['1', '2', '3']], header: true, colWidths: ['1fr', '2fr', null], tableWidth: 'full' });
const tmd = serializeDocument({ meta: { title: 'T' }, blocks: [t] });
eq('tabelle md', tmd.includes('<colgroup>') && tmd.includes('data-width="full"'), true);
const tb = parseDocument(tmd).blocks[0];
eq('tabelle zurück', [tb.colWidths, tb.tableWidth], [['1fr', '2fr', null], 'full']);
insertCol(tb, 1);
eq('spalte einfügen', tb.colWidths, ['1fr', null, '2fr', null]);
deleteCol(tb, 0);
eq('spalte löschen', tb.colWidths, [null, '2fr', null]);

console.log(`${ok} bestanden, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
