// Tests für Bildgrößen: Einrasten und gleiche Größe für neue Bilder
import { snapWidth, roundWidth, formatPct, otherWidths, sameContextImages, widthForNew, imageBlocks } from '../web/js/core/imagesize.js';
import { parseDocument, serializeDocument, block } from '../web/js/core/markdown.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};

// Einrasten
eq('stufe', snapWidth(49, { threshold: 2 }), { width: 50, snap: 'step' });
eq('drittel', snapWidth(34.5, { threshold: 2 }), { width: 33.3, snap: 'step' });
eq('frei', snapWidth(43.4, { threshold: 2 }), { width: 43, snap: null });
eq('anderes bild', snapWidth(41, { others: [42], threshold: 2 }), { width: 42, snap: 'other' });
eq('anderes bild gewinnt bei gleichstand', snapWidth(50, { others: [50], threshold: 2 }), { width: 50, snap: 'other' });
eq('näher gewinnt', snapWidth(49.5, { others: [47], threshold: 3 }), { width: 50, snap: 'step' });
eq('mit ⌥ stufenlos', snapWidth(49.4, { threshold: 2, free: true }), { width: 49, snap: null });
eq('grenzen', [snapWidth(3, {}).width, snapWidth(140, {}).width], [10, 100]);
eq('runden', [roundWidth(33.333), roundWidth(5), roundWidth(250)], [33.3, 10, 100]);
eq('anzeige', [formatPct(33.3), formatPct(50)], ['33,3 %', '50 %']);

// Bilder im Eintrag
const img = (w, id) => block('image', { src: 'x-devonthink-item://' + id, caption: '', ...(w ? { width: w } : {}) });
const a = img(50, 'A'), b = img(40, 'B'), c = img(null, 'C');
const inCol = img(80, 'D');
const cols = block('columns', { children: [{ children: [inCol] }, { children: [block('p', { html: 'x' })] }] });
const doc = [block('h1', { html: 'T' }), a, block('p', { html: 'x' }), b, cols, c];
eq('alle bilder', imageBlocks(doc).map(e => [e.b.src.slice(-1), e.inCols]), [['A', false], ['B', false], ['D', true], ['C', false]]);
eq('andere breiten', otherWidths(doc, a), [40, 100]);
eq('andere in spalten', otherWidths(doc, inCol), []);
eq('gleiches umfeld', sameContextImages(doc, a).map(x => x.src.slice(-1)), ['A', 'B', 'C']);

// Neue Bilder übernehmen die Größe des Bildes davor
const n1 = img(null, 'N1');
const doc2 = [a, block('p', { html: 'x' }), n1];
eq('wie davor', widthForNew(doc2, n1, 100), 50);
const n2 = img(null, 'N2');
eq('erstes bild → voreinstellung', widthForNew([block('p'), n2], n2, 75), 75);
eq('erstes bild ganze breite', widthForNew([n2], n2, 100), undefined);
const n3 = img(null, 'N3');
eq('sonst wie danach', widthForNew([n3, block('p'), b], n3, 100), 40);
// Mehrere neue Bilder auf einmal: alle wie das bestehende Bild
const f1 = img(null, 'F1'), f2 = img(null, 'F2');
f1._fresh = f2._fresh = true;
eq('mehrere neu', [widthForNew([a, f1, f2], f1, 100), widthForNew([a, f1, f2], f2, 100)], [50, 50]);
const inCol2 = img(null, 'E');
const cols2 = block('columns', { children: [{ children: [inCol2] }] });
eq('in spalte ohne nachbarn: ganze spalte', widthForNew([a, cols2], inCol2, 50), undefined);

// Kommabreiten überstehen Speichern und Laden
const md = serializeDocument({ meta: { title: 'T' }, blocks: [img(33.3, 'X')] });
eq('markdown', md.includes('"w=33.3"'), true);
eq('zurück', parseDocument(md).blocks.find(x => x.type === 'image').width, 33.3);

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
