// Tests: welche Datei bekommt welche Ansicht?
import { classify } from '../web/js/core/filetypes.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};
const v = (n) => { const c = classify(n); return [c.view, c.editable]; };

eq('eintrag', v({ kind: 'note', type: 'markdown', ext: 'md' }), ['note', true]);
eq('tiff', v({ kind: 'image', type: 'picture', ext: 'tiff' }), ['image', true]);
eq('heic', v({ kind: 'image', type: 'picture', ext: 'heic' }), ['image', true]);
eq('raw', v({ kind: 'file', type: 'unknown', ext: 'dng' }), ['image', true]);
eq('python', v({ kind: 'file', type: 'txt', ext: 'py' }), ['text', true]);
eq('typst nur ansehen', v({ kind: 'file', type: 'unknown', ext: 'typ' }), ['text', false]);
eq('xml nur ansehen', v({ kind: 'file', type: 'XML', ext: 'xml' }), ['text', false]);
eq('csv', v({ kind: 'file', type: 'sheet', ext: 'csv' }), ['sheet', true]);
eq('rtf', v({ kind: 'file', type: 'RTF', ext: 'rtf' }), ['rich', true]);
eq('docx nicht speichern', v({ kind: 'file', type: 'RTF', ext: 'docx' }), ['preview', false]);
eq('pages', v({ kind: 'file', type: 'unknown', ext: 'pages' }), ['preview', false]);
eq('html', v({ kind: 'file', type: 'HTML', ext: 'html' }), ['preview', false]);
eq('video', classify({ kind: 'file', type: 'multimedia', ext: 'mov' }).label, 'Video');
eq('audio', classify({ kind: 'file', type: 'multimedia', ext: 'm4a' }).label, 'Audio');
eq('lesezeichen', v({ kind: 'file', type: 'bookmark', ext: '' }), ['link', false]);
eq('svg', classify({ kind: 'file', type: 'unknown', ext: 'svg' }).alt, 'text');
eq('unbekannt', classify({ kind: 'file', type: 'unknown', ext: 'zip' }).label, 'ZIP-Datei');
eq('word kopie', classify({ kind: 'file', type: 'RTF', ext: 'docx' }).toRtf, true);

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
