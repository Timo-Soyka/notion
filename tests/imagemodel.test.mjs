// Tests für die Bildbearbeitung (Drehen, Spiegeln, Textumbruch, Treffer)
import { newLayer, spaceSize, rotateLayer, flipLayer, basePoint, wrapLines, layoutText, hit, topHit, dragHandle, clampRect, simplify, nextBadge, defaults, outRect } from '../web/js/core/imagemodel.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};
const r = (a) => a.map(v => Math.round(v * 100) / 100);

// Ein Punkt auf dem Bild bleibt beim Drehen/Spiegeln auf derselben Bildstelle
const L = newLayer(400, 300);
const P0 = [50, 20];
L.objects.push({ type: 'badge', x: P0[0], y: P0[1], r: 10, n: 1 });
L.objects.push({ type: 'line', x1: 0, y1: 0, x2: 100, y2: 50, width: 2 });
const checks = [];
for (const op of ['r', 'r', 'f', 'l', 'f', 'r', 'r', 'l', 'f']) {
  if (op === 'r') rotateLayer(L, 1); else if (op === 'l') rotateLayer(L, -1); else flipLayer(L);
  const b = L.objects[0];
  checks.push(JSON.stringify(r(basePoint(L, P0))) === JSON.stringify(r([b.x, b.y])));
}
eq('punkt folgt dem bild', checks.every(Boolean), true);
eq('raumgröße gedreht', spaceSize({ w: 400, h: 300, rot: 90 }), { w: 300, h: 400 });

const L2 = newLayer(400, 300);
L2.crop = { x: 10, y: 20, w: 100, h: 50 };
L2.objects.push({ type: 'rect', x: 10, y: 20, w: 100, h: 50, width: 2 });
for (let i = 0; i < 4; i++) rotateLayer(L2, 1);
eq('vier drehungen', [L2.rot, L2.crop, { x: L2.objects[0].x, y: L2.objects[0].y, w: L2.objects[0].w, h: L2.objects[0].h }], [0, { x: 10, y: 20, w: 100, h: 50 }, { x: 10, y: 20, w: 100, h: 50 }]);
flipLayer(L2); flipLayer(L2);
eq('zweimal spiegeln', [L2.flipX, L2.crop.x], [false, 10]);
eq('zuschnitt = ergebnis', outRect(L2), { x: 10, y: 20, w: 100, h: 50 });

// Textumbruch (jedes Zeichen 10 Punkte breit)
const m = (s) => s.length * 10;
eq('umbruch', wrapLines('Das ist ein Test', 80, m), ['Das ist', 'ein Test']);
eq('langes wort', wrapLines('Donaudampfschiff', 50, m), ['Donau', 'dampf', 'schif', 'f']);
eq('zeilen', wrapLines('a\n\nb', 100, m), ['a', '', 'b']);
const t = { type: 'text', x: 0, y: 0, w: 0, size: 20, text: 'Hallo\nWelt!', auto: true };
layoutText(t, m, 1000);
eq('auto breite', [t.w, t.h], [Math.ceil(50 + 2 * 20 * 0.12 + 2), Math.ceil(2 * 25 + 2 * 20 * 0.12)]);

// Treffer
const rect = { type: 'rect', x: 0, y: 0, w: 100, h: 100, width: 2 };
eq('rechteck rand', [hit(rect, 1, 50, 3), hit(rect, 50, 50, 3)], [true, false]);
eq('gefülltes rechteck', hit({ ...rect, fill: '#fff' }, 50, 50, 3), true);
eq('ellipse rand', [hit({ type: 'ellipse', x: 0, y: 0, w: 100, h: 50, width: 2 }, 100, 25, 3), hit({ type: 'ellipse', x: 0, y: 0, w: 100, h: 50, width: 2 }, 50, 25, 3)], [true, false]);
eq('pfeil', hit({ type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 100, width: 4 }, 51, 49, 2), true);
eq('oberstes', topHit([{ type: 'badge', id: 'a', x: 5, y: 5, r: 5 }, { type: 'badge', id: 'b', x: 6, y: 6, r: 5 }], 5, 5, 1).id, 'b');

// Griffe
const rr = { type: 'rect', x: 10, y: 10, w: 50, h: 50 };
dragHandle(rr, { ...rr }, 'nw', 70, 0);
eq('ecke über kreuz', [rr.x, rr.y, rr.w, rr.h], [60, 0, 10, 60]);
const tt = { type: 'text', x: 10, y: 0, w: 100, size: 10, auto: true };
dragHandle(tt, { ...tt }, 'w', 50, 0);
eq('textbreite links', [tt.x, tt.w, tt.auto], [50, 60, false]);

eq('zuschnitt begrenzt', clampRect({ x: -5, y: 10, w: 500, h: -20 }, 300, 200), { x: 0, y: 0, w: 300, h: 20 });
eq('glätten', simplify([[0, 0], [1, 0.01], [2, 0], [3, 5]], 0.5), [[0, 0], [2, 0], [3, 5]]);
eq('nummern', nextBadge([{ type: 'badge', n: 2 }, { type: 'text' }, { type: 'badge', n: 5 }]), 6);
eq('standardgrößen', defaults(newLayer(4000, 3000)), { size: 105, width: 13 });

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
