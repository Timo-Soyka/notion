// Bildgrößen im Eintrag: feste Stufen zum Einrasten und gleiche Größe für alle Bilder.
//
// Die Breite eines Bildes steht in Prozent der Spalte, in der es steht
// (b.width, fehlt sie, ist das Bild so breit wie die Spalte). Beim Ziehen
// rastet die Breite auf den Stufen unten ein – und auf den Breiten der
// anderen Bilder im Eintrag, damit mehrere Bilder genau gleich groß werden.

export const SIZE_STEPS = [25, 33.3, 50, 66.7, 75, 100];

export const SIZE_PRESETS = [
  { label: 'Klein', width: 33.3 },
  { label: 'Mittel', width: 50 },
  { label: 'Groß', width: 75 },
  { label: 'Ganze Breite', width: 100 }
];

export const MIN_WIDTH = 10;

export const widthOf = (b) => (b && b.width ? Number(b.width) : 100);

// Auf eine Nachkommastelle, zwischen 10 und 100 %
export function roundWidth(pct) {
  const v = Math.round(Math.max(MIN_WIDTH, Math.min(100, Number(pct) || 100)) * 10) / 10;
  return v;
}

export const formatPct = (v) => String(roundWidth(v)).replace('.', ',') + ' %';

// Breite beim Ziehen: nächste Stufe oder Bildbreite in Reichweite (threshold in %).
// → { width, snap: 'step' | 'other' | null }
export function snapWidth(pct, { others = [], threshold = 2, free = false } = {}) {
  const raw = roundWidth(pct);
  if (free) return { width: Math.round(raw), snap: null };
  let best = null;
  const consider = (v, kind) => {
    const d = Math.abs(v - pct);
    if (d > threshold) return;
    // Gleich nah: die Breite eines anderen Bildes gewinnt
    if (!best || d < best.d - 0.01 || (Math.abs(d - best.d) <= 0.01 && kind === 'other')) best = { v, d, kind };
  };
  for (const v of others) consider(roundWidth(v), 'other');
  for (const v of SIZE_STEPS) consider(v, 'step');
  if (best) return { width: best.v, snap: best.kind };
  return { width: Math.round(raw), snap: null };
}

// Alle Bildblöcke des Eintrags in Dokumentreihenfolge, mit Angabe,
// ob sie in einer Spalte stehen (dort bezieht sich die Breite auf die Spalte)
export function imageBlocks(blocks) {
  const out = [];
  const walk = (list, inCols) => {
    for (const b of list || []) {
      if (b.type === 'image' && b.src) out.push({ b, inCols });
      if (b.type === 'columns') for (const col of b.children || []) walk(col.children, true);
      else if (b.children && b.children.length) walk(b.children, inCols);
    }
  };
  walk(blocks, false);
  return out;
}

const contextOf = (all, b) => { const e = all.find(x => x.b === b); return e ? e.inCols : false; };

// Breiten der anderen Bilder im selben Umfeld (Spalte bzw. Fließtext)
export function otherWidths(blocks, b) {
  const all = imageBlocks(blocks);
  const ctx = contextOf(all, b);
  const set = new Set();
  for (const e of all) if (e.b !== b && e.inCols === ctx) set.add(roundWidth(widthOf(e.b)));
  return [...set].sort((x, y) => x - y);
}

// Die Bilder, die „Alle Bilder auf diese Größe“ betrifft
export function sameContextImages(blocks, b) {
  const all = imageBlocks(blocks);
  const ctx = contextOf(all, b);
  return all.filter(e => e.inCols === ctx).map(e => e.b);
}

// Größe für ein neu eingefügtes Bild: wie das nächste Bild davor im selben
// Umfeld (sonst danach), gibt es keins, die Voreinstellung.
// Liefert undefined für „ganze Breite“ (so wird nichts ins Markdown geschrieben).
export function widthForNew(blocks, b, fallback = 100) {
  const all = imageBlocks(blocks);
  const i = all.findIndex(e => e.b === b);
  const ctx = i >= 0 ? all[i].inCols : false;
  const same = (e) => e.b !== b && e.inCols === ctx && !e.b._fresh;
  let ref = null;
  for (let k = (i >= 0 ? i : all.length) - 1; k >= 0 && !ref; k--) if (same(all[k])) ref = all[k];
  for (let k = i + 1; i >= 0 && k < all.length && !ref; k++) if (same(all[k])) ref = all[k];
  const w = ref ? widthOf(ref.b) : ctx ? 100 : Number(fallback) || 100;
  return w >= 100 ? undefined : roundWidth(w);
}
