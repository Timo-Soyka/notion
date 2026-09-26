// Nummerierung an einer Stelle: Überschriften (1.1), Listen (1. / a) / i.),
// Abbildungen/Tabellen und die Nummern neuer Einträge.
//
// Einzelne Überschriften oder Listenpunkte können eine eigene Nummer bekommen
// (b.num bzw. b.start); alles danach zählt von dort aus weiter – so wie man
// es im Heft macht, wenn die Nummerierung vom Standard abweicht.

export const HEADING_STYLES = [['', 'Aus'], ['1.1', '1.1'], ['1.', '1.1.'], ['I.1', 'I.1'], ['A.1', 'A.1']];
export const LIST_STYLES = [['1.', '1.'], ['1)', '1)'], ['a)', 'a)']];
export const ENTRY_FORMATS = [['off', 'Aus'], ['1', '1, 2, 3'], ['chapter', '1.1, 1.2'], ['01', '01, 02']];

export function roman(n) {
  if (!(n > 0) || n > 3999) return String(n);
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

export function alpha(n) {
  if (!(n > 0)) return String(n);
  let out = '';
  while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

// "2.4" → [2, 4]; "-" → 'none'; sonst null
export function parseNum(s) {
  if (s === undefined || s === null || s === '') return null;
  const t = String(s).trim();
  if (t === '-' || t.toLowerCase() === 'keine') return 'none';
  const parts = t.replace(/[.)]+$/, '').split(/[.,]/).map(x => parseInt(x, 10));
  return parts.length && parts.every(x => Number.isFinite(x) && x >= 0) ? parts : null;
}

export function formatHeading(counters, level, style, prefix = '') {
  const parts = counters.slice(0, level);
  const first = style.startsWith('I') ? roman(parts[0]) : style.startsWith('A') ? alpha(parts[0]).toUpperCase() : String(parts[0]);
  let s = [first, ...parts.slice(1)].join('.');
  if (prefix) s = `${prefix}.${s}`;
  if (style === '1.') s += '.';
  return s;
}

// headings: [{ id, level (1–3), num }] in Dokumentreihenfolge → Map id → Nummer ('' = keine)
export function headingNumbers(headings, { style = '1.1', depth = 3, prefix = '' } = {}) {
  const out = new Map();
  const counters = [0, 0, 0];
  for (const hd of headings) {
    const L = hd.level;
    const own = parseNum(hd.num);
    if (!style || own === 'none' || L > depth) { out.set(hd.id, ''); continue; }
    if (Array.isArray(own)) {
      // Eigene Nummer: von hinten auf die Ebenen verteilen ("5" → nur diese Ebene, "2.4" → Ebene 1 und 2)
      own.slice(-L).forEach((v, i, arr) => { counters[L - arr.length + i] = v; });
    } else counters[L - 1]++;
    for (let k = L; k < 3; k++) counters[k] = 0;
    out.set(hd.id, formatHeading(counters, L, style, prefix));
  }
  return out;
}

export function listLabel(n, depth, style = '1.', nested = true) {
  let st = style;
  if (nested && depth > 0) {
    const cycle = style === 'a)' ? ['a)', '1.', 'i.'] : [style, 'a)', 'i.'];
    st = cycle[depth % 3];
  }
  switch (st) {
    case '1)': return `${n})`;
    case 'a)': return `${alpha(n)})`;
    case 'i.': return `${roman(n).toLowerCase()}.`;
    default: return `${n}.`;
  }
}

// Nächste Eintragsnummer im Ordner ("1 Quadratzahlen", "2 Wurzeln" → "3")
export function nextEntryNumber(siblingNames, folderName, format) {
  if (!format || format === 'off') return '';
  const lead = (s) => { const m = /^\s*(\d+(?:\.\d+)*)[\s.)_-]/.exec(String(s || '') + ' '); return m ? m[1] : null; };
  if (format === 'chapter') {
    const chapter = lead(folderName);
    if (chapter) {
      let max = 0;
      for (const n of siblingNames) {
        const l = lead(n);
        if (l && l.startsWith(chapter + '.')) max = Math.max(max, parseInt(l.slice(chapter.length + 1), 10) || 0);
      }
      return `${chapter}.${max + 1}`;
    }
  }
  let max = 0;
  for (const n of siblingNames) {
    const l = lead(n);
    if (l) max = Math.max(max, parseInt(l.split('.').pop(), 10) || 0);
  }
  const next = max + 1;
  return format === '01' ? String(next).padStart(2, '0') : String(next);
}
