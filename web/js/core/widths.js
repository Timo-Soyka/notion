// Breiten für Spalten nebeneinander und für Tabellenspalten.
//
// Eine Breite ist entweder ein Anteil ("2" = doppelt so breit wie "1") oder
// ein fester Wert mit Einheit ("5cm", "40mm", "120px", "30%"). Gespeichert
// wird sie als kurze Zeichenkette: "2fr" bzw. "5cm".

export const CM_PX = 96 / 2.54;
const UNIT_PX = { cm: CM_PX, mm: CM_PX / 10, px: 1, pt: 96 / 72, in: 96 };

// Eingabe (auch deutsch: "2,5 cm", "1:2" wird vorher aufgeteilt) → Speicherform oder null
export function parseWidth(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
  if (!s || s === 'auto' || s === 'automatisch') return null;
  let m;
  if ((m = /^(\d+(?:\.\d+)?)(fr|x|teile?|anteile?)?$/.exec(s))) {
    const n = parseFloat(m[1]);
    return n > 0 ? `${+n.toFixed(3)}fr` : null;
  }
  if ((m = /^(\d+(?:\.\d+)?)(cm|mm|px|pt|in|%)$/.exec(s))) {
    const n = parseFloat(m[1]);
    if (!(n > 0)) return null;
    if (m[2] === '%' && n > 100) return null;
    return `${+n.toFixed(2)}${m[2]}`;
  }
  return null;
}

export function widthKind(spec) {
  if (!spec) return 'auto';
  return /fr$/.test(spec) ? 'ratio' : 'fixed';
}

export function ratioOf(spec) {
  return widthKind(spec) === 'ratio' ? parseFloat(spec) : 1;
}

// Für Menschen: "2" bzw. "5 cm" (deutsches Komma)
export function formatWidth(spec) {
  if (!spec) return '';
  const m = /^(\d+(?:\.\d+)?)(fr|cm|mm|px|pt|in|%)$/.exec(spec);
  if (!m) return spec;
  const n = String(+parseFloat(m[1]).toFixed(2)).replace('.', ',');
  return m[2] === 'fr' ? n : `${n} ${m[2]}`;
}

// CSS für eine Spalte in einer Flex-Reihe
export function flexFor(spec) {
  if (widthKind(spec) === 'fixed') return `0 0 ${spec}`;
  return `${ratioOf(spec)} 1 0`;
}

export function toPx(spec, totalPx) {
  const m = /^(\d+(?:\.\d+)?)(cm|mm|px|pt|in|%)$/.exec(spec || '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === '%' ? totalPx * n / 100 : n * UNIT_PX[m[2]];
}

// Pixelbreiten aller Spalten: feste zuerst, der Rest nach Anteilen
export function distribute(specs, totalPx) {
  const out = specs.map(s => (widthKind(s) === 'fixed' ? toPx(s, totalPx) : null));
  const fixed = out.reduce((a, v) => a + (v || 0), 0);
  const ratios = specs.map((s, i) => (out[i] === null ? ratioOf(s) : 0));
  const sum = ratios.reduce((a, v) => a + v, 0);
  const rest = Math.max(0, totalPx - fixed);
  return out.map((v, i) => (v !== null ? v : sum ? rest * ratios[i] / sum : 0));
}

// Braucht die Reihe eine bestimmte Gesamtbreite? (nur feste Breiten → nein)
export function hasRatio(specs) {
  return specs.some(s => widthKind(s) !== 'fixed');
}

// Ein Wert aus Pixeln zurück in dieselbe Art wie vorher (für das Ziehen mit der Maus)
export function fromPx(px, like, totalPx) {
  const m = /^(\d+(?:\.\d+)?)(cm|mm|px|pt|in|%)$/.exec(like || '');
  if (!m) return null;
  const unit = m[2];
  const v = unit === '%' ? px / totalPx * 100 : px / UNIT_PX[unit];
  const step = unit === 'px' ? 1 : unit === '%' ? 1 : unit === 'mm' ? 1 : 0.1;
  return `${+(Math.round(v / step) * step).toFixed(2)}${unit}`;
}

// Mehrere Werte auf einmal: "1:2:1" oder "1 : 2" → ["1fr","2fr","1fr"]
export function parseRatioList(input) {
  const parts = String(input || '').split(/\s*[:|;]\s*/).filter(Boolean);
  if (parts.length < 2) return null;
  const specs = parts.map(parseWidth);
  return specs.every(Boolean) ? specs : null;
}
