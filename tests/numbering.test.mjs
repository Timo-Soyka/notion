// Tests für die Nummerierung
import { headingNumbers, listLabel, nextEntryNumber, parseNum, roman } from '../web/js/core/numbering.js';
import { parseDocument, serializeDocument, block } from '../web/js/core/markdown.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};
const H = (list, opts) => [...headingNumbers(list.map(([level, num], i) => ({ id: 'h' + i, level, num })), opts).values()];

eq('standard', H([[1], [2], [2], [1], [2], [3]]), ['1', '1.1', '1.2', '2', '2.1', '2.1.1']);
eq('punkt', H([[1], [2]], { style: '1.' }), ['1.', '1.1.']);
eq('römisch', H([[1], [2], [1]], { style: 'I.1' }), ['I', 'I.1', 'II']);
eq('buchstabe', H([[1], [2], [1]], { style: 'A.1' }), ['A', 'A.1', 'B']);
eq('eigene nummer', H([[1], [1, '5'], [2], [1]]), ['1', '5', '5.1', '6']);
eq('eigene 2.4', H([[1], [2, '2.4'], [2]]), ['1', '2.4', '2.5']);
eq('ohne nummer', H([[1], [1, '-'], [1]]), ['1', '', '2']);
eq('tiefe', H([[1], [2], [3]], { depth: 2 }), ['1', '1.1', '']);
eq('präfix', H([[1], [2]], { prefix: '3' }), ['3.1', '3.1.1']);
eq('aus', H([[1]], { style: '' }), ['']);
eq('parse', [parseNum('2.4'), parseNum('-'), parseNum('x')], [[2, 4], 'none', null]);
eq('listen', [listLabel(3, 0), listLabel(2, 1), listLabel(4, 2), listLabel(2, 0, '1)'), listLabel(28, 0, 'a)', false)], ['3.', 'b)', 'iv.', '2)', 'ab)']);
eq('roman', roman(1994), 'MCMXCIV');
eq('eintrag', nextEntryNumber(['1 Quadratzahlen', '2 Wurzeln', 'Arbeitsblatt'], '1 Reelle Zahlen', '1'), '3');
eq('eintrag kapitel', nextEntryNumber(['1.1 A', '1.2 B'], '1 Reelle Zahlen', 'chapter'), '1.3');
eq('eintrag 01', nextEntryNumber(['01 A'], 'Mathe', '01'), '02');
eq('eintrag leer', nextEntryNumber([], 'Mathe', '1'), '1');

// Eigene Nummern bleiben beim Speichern erhalten
const doc = { meta: { title: 'T' }, blocks: [block('h1', { html: 'A' }), block('h1', { html: 'B', num: '5' }), block('h2', { html: 'C', num: '-' }),
  block('ol', { html: 'x' }), block('ol', { html: 'y', start: 7 }), block('ol', { html: 'z' })] };
const md = serializeDocument(doc);
eq('md', md.includes('## B <!-- nr=5 -->') && md.includes('### C <!-- nr=- -->') && md.includes('1. x\n7. y\n8. z'), true);
const back = parseDocument(md).blocks;
eq('zurück', back.map(b => [b.type, b.num || b.start || null]), [['h1', null], ['h1', '5'], ['h2', '-'], ['ol', null], ['ol', 7], ['ol', null]]);

console.log(`${ok} bestanden, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
