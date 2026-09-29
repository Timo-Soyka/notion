// Chemie-Werkzeuge ohne Internet:
//
//  • SMILES einlesen und schreiben (Molekül als Graph aus Atomen und Bindungen)
//  • Summenformel, molare Masse, funktionelle Gruppen
//  • Halbstrukturformel (CH₃–CH₂–OH) und Valenzstrichformel mit allen H-Atomen
//  • deutsche IUPAC-Namen → Struktur ("2-Methylpropan", "Butan-2-ol", "Ethansäureethylester")
//  • Reaktionsgleichungen ausgleichen
//
// Bewusst ohne Abhängigkeiten, damit es in Node getestet werden kann.

import { hasNuclide, checkNuclear } from './isotopes.js';

// ---------------------------------------------------------------------------
// Atommassen (IUPAC, gerundet) und Standard-Bindigkeiten
// ---------------------------------------------------------------------------

export const MASSES = {
  H: 1.008, He: 4.0026, Li: 6.94, Be: 9.0122, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Ne: 20.180,
  Na: 22.990, Mg: 24.305, Al: 26.982, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.948, K: 39.098, Ca: 40.078,
  Sc: 44.956, Ti: 47.867, V: 50.942, Cr: 51.996, Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38,
  Ga: 69.723, Ge: 72.630, As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798, Rb: 85.468, Sr: 87.62, Ag: 107.87, Cd: 112.41,
  Sn: 118.71, Sb: 121.76, I: 126.90, Xe: 131.29, Cs: 132.91, Ba: 137.33, Pt: 195.08, Au: 196.97, Hg: 200.59, Pb: 207.2, U: 238.03
};

const VALENCE = { B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1] };
const ORGANIC = new Set(['B', 'C', 'N', 'O', 'P', 'S', 'F', 'Cl', 'Br', 'I']);
const LONE_PAIRS = { N: 1, O: 2, S: 2, F: 3, Cl: 3, Br: 3, I: 3, P: 1 };

// ---------------------------------------------------------------------------
// SMILES → Graph
// ---------------------------------------------------------------------------

export function parseSmiles(smiles) {
  const s = String(smiles || '').trim();
  if (!s) throw new Error('Leer');
  const atoms = [], bonds = [];
  const stack = [];
  const rings = {};
  let prev = null, bondOrder = null, i = 0;
  const addAtom = (a) => {
    atoms.push(a);
    const idx = atoms.length - 1;
    if (prev !== null) {
      let order = bondOrder;
      if (order === null) order = atoms[prev].aromatic && a.aromatic ? 1.5 : 1;
      bonds.push({ a: prev, b: idx, order });
    }
    prev = idx;
    bondOrder = null;
    return idx;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '(') { stack.push(prev); i++; continue; }
    if (c === ')') { prev = stack.pop(); i++; continue; }
    if (c === '.') { prev = null; i++; continue; }
    if ('-=#$:/\\'.includes(c)) {
      bondOrder = c === '=' ? 2 : c === '#' ? 3 : c === '$' ? 4 : c === ':' ? 1.5 : 1;
      i++;
      continue;
    }
    if (/[0-9%]/.test(c)) {
      let num;
      if (c === '%') { num = s.slice(i + 1, i + 3); i += 3; } else { num = c; i++; }
      if (rings[num] !== undefined) {
        const { atom, order } = rings[num];
        let o = bondOrder ?? order;
        if (o === null) o = atoms[atom].aromatic && atoms[prev].aromatic ? 1.5 : 1;
        bonds.push({ a: atom, b: prev, order: o });
        delete rings[num];
      } else rings[num] = { atom: prev, order: bondOrder };
      bondOrder = null;
      continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new Error('„]“ fehlt');
      const inner = s.slice(i + 1, end);
      const m = /^(\d+)?([A-Z][a-z]?|[bcnops]|se|as)(@{0,2}(?:TH\d|AL\d|SP\d|TB\d+|OH\d+)?)?(H\d*)?([+-]+\d*|[+-]\d+)?(?::\d+)?$/.exec(inner);
      if (!m) throw new Error(`Unbekanntes Atom [${inner}]`);
      const aromatic = m[2] === m[2].toLowerCase();
      const el = aromatic ? m[2][0].toUpperCase() + m[2].slice(1) : m[2];
      let h = 0;
      if (m[4]) h = m[4].length > 1 ? parseInt(m[4].slice(1), 10) : 1;
      let charge = 0;
      if (m[5]) {
        const sign = m[5][0] === '+' ? 1 : -1;
        const rest = m[5].slice(1);
        charge = /^\d+$/.test(rest) ? sign * parseInt(rest, 10) : sign * m[5].length;
      }
      addAtom({ el, aromatic, charge, h, bracket: true });
      i = end + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === 'Cl' || two === 'Br') { addAtom({ el: two, aromatic: false, charge: 0, h: null, bracket: false }); i += 2; continue; }
    if (/[BCNOPSFI]/.test(c)) { addAtom({ el: c, aromatic: false, charge: 0, h: null, bracket: false }); i++; continue; }
    if (/[bcnops]/.test(c)) { addAtom({ el: c.toUpperCase(), aromatic: true, charge: 0, h: null, bracket: false }); i++; continue; }
    throw new Error(`Unerwartetes Zeichen „${c}“`);
  }
  if (Object.keys(rings).length) throw new Error('Ring nicht geschlossen');
  const g = { atoms, bonds };
  computeH(g);
  return g;
}

export function neighbors(g, i) {
  const out = [];
  for (const b of g.bonds) {
    if (b.a === i) out.push({ atom: b.b, order: b.order, bond: b });
    else if (b.b === i) out.push({ atom: b.a, order: b.order, bond: b });
  }
  return out;
}

// Implizite Wasserstoffatome nach den Standard-Bindigkeiten
export function computeH(g) {
  g.atoms.forEach((a, i) => {
    if (a.bracket || a.h !== null && a.h !== undefined && a.fixedH) { a.hCount = a.h || 0; return; }
    const nb = neighbors(g, i);
    let sum = 0, arom = false;
    for (const n of nb) {
      if (n.order === 1.5) { sum += 1; arom = true; } else sum += n.order;
    }
    if (arom) {
      // Aromatische Atome: nur die Grundbindigkeit (n in Pyridin/Coffein hat kein H)
      sum += 1;
      a.hCount = Math.max(0, (VALENCE[a.el] || [0])[0] - sum);
      return;
    }
    const vals = VALENCE[a.el] || [0];
    const target = vals.find(v => v >= sum) ?? sum;
    a.hCount = Math.max(0, target - sum);
  });
  return g;
}

// ---------------------------------------------------------------------------
// Summenformel und molare Masse
// ---------------------------------------------------------------------------

export function elementCounts(g) {
  const c = {};
  let charge = 0;
  for (const a of g.atoms) {
    c[a.el] = (c[a.el] || 0) + 1;
    if (a.hCount) c.H = (c.H || 0) + a.hCount;
    charge += a.charge || 0;
  }
  return { counts: c, charge };
}

export function hillFormula(counts, charge = 0) {
  const keys = Object.keys(counts).filter(k => counts[k] > 0);
  let order;
  if (counts.C) order = ['C', ...(counts.H ? ['H'] : []), ...keys.filter(k => k !== 'C' && k !== 'H').sort()];
  else order = keys.sort();
  let out = order.map(k => k + (counts[k] > 1 ? counts[k] : '')).join('');
  if (charge) out += '^{' + (Math.abs(charge) > 1 ? Math.abs(charge) : '') + (charge > 0 ? '+' : '-') + '}';
  return out;
}

export function molarMass(counts) {
  let m = 0;
  for (const k in counts) {
    if (!(k in MASSES)) return NaN;
    m += MASSES[k] * counts[k];
  }
  return m;
}

// ---------------------------------------------------------------------------
// Funktionelle Gruppen (deutsche Schulbegriffe)
// ---------------------------------------------------------------------------

export function functionalGroups(g) {
  const found = [];
  const add = (x) => { if (!found.includes(x)) found.push(x); };
  const A = g.atoms;
  const nb = (i) => neighbors(g, i);
  const isC = (i) => A[i].el === 'C';
  const dblO = (i) => nb(i).filter(n => A[n.atom].el === 'O' && n.order === 2).length > 0;
  let aromatic = false, cc2 = false, cc3 = false;
  for (const b of g.bonds) {
    const a1 = A[b.a], a2 = A[b.b];
    if (b.order === 1.5) aromatic = true;
    if (a1.el === 'C' && a2.el === 'C' && b.order === 2) cc2 = true;
    if (a1.el === 'C' && a2.el === 'C' && b.order === 3) cc3 = true;
  }
  A.forEach((a, i) => {
    if (a.el === 'C' && dblO(i)) {
      const others = nb(i).filter(n => !(A[n.atom].el === 'O' && n.order === 2));
      const singleO = others.filter(n => A[n.atom].el === 'O' && n.order === 1);
      const N = others.filter(n => A[n.atom].el === 'N');
      if (singleO.some(n => A[n.atom].hCount > 0 || A[n.atom].charge < 0)) add('Carboxy-Gruppe (Carbonsäure)');
      else if (singleO.some(n => nb(n.atom).filter(m => isC(m.atom)).length === 2)) add('Ester-Gruppe');
      else if (N.length) add('Amid-Gruppe (Peptidbindung)');
      else if (a.hCount > 0) add('Aldehyd-Gruppe (Carbonylgruppe)');
      else if (others.filter(n => isC(n.atom)).length === 2) add('Keto-Gruppe (Carbonylgruppe)');
    }
  });
  A.forEach((a, i) => {
    if (a.el === 'O' && a.hCount > 0) {
      const c = nb(i).find(n => isC(n.atom));
      if (c && !dblO(c.atom)) add(A[c.atom].aromatic ? 'Hydroxy-Gruppe (Phenol)' : 'Hydroxy-Gruppe (Alkohol)');
    }
    if (a.el === 'O' && a.hCount === 0 && a.charge === 0) {
      const cs = nb(i).filter(n => isC(n.atom) && n.order === 1);
      if (cs.length === 2 && !cs.some(n => dblO(n.atom))) add('Ether-Gruppe');
    }
    if (a.el === 'N') {
      const os = nb(i).filter(n => A[n.atom].el === 'O');
      if (os.length >= 2) add('Nitro-Gruppe');
      else if (nb(i).some(n => isC(n.atom) && n.order === 3)) add('Nitril-Gruppe');
      else if (!nb(i).some(n => isC(n.atom) && dblO(n.atom)) && !a.aromatic) add('Amino-Gruppe');
    }
    if (['F', 'Cl', 'Br', 'I'].includes(a.el) && nb(i).some(n => isC(n.atom))) add('Halogenatom (' + a.el + ')');
    if (a.el === 'S' && a.hCount > 0) add('Thiol-Gruppe');
  });
  if (cc2) add('C=C-Doppelbindung');
  if (cc3) add('C≡C-Dreifachbindung');
  if (aromatic) add('aromatischer Ring');
  return found;
}

// Stoffklasse für die Beschriftung ("Alkan", "Alkohol" …)
export function substanceClass(g) {
  const fg = functionalGroups(g);
  const has = (s) => fg.some(x => x.startsWith(s));
  if (has('Carboxy')) return 'Carbonsäure';
  if (has('Ester')) return 'Ester';
  if (has('Amid')) return 'Amid';
  if (has('Aldehyd')) return 'Aldehyd (Alkanal)';
  if (has('Keto')) return 'Keton (Alkanon)';
  if (fg.includes('Hydroxy-Gruppe (Phenol)')) return 'Phenol';
  if (has('Hydroxy')) return 'Alkohol (Alkanol)';
  if (has('Amino')) return 'Amin';
  if (has('Ether')) return 'Ether';
  if (has('Halogen')) return 'Halogenalkan';
  if (has('aromatisch')) return 'Aromat';
  if (has('C≡C')) return 'Alkin';
  if (has('C=C')) return 'Alken';
  const onlyCH = g.atoms.every(a => a.el === 'C' || a.el === 'H');
  if (onlyCH) return hasRing(g) ? 'Cycloalkan' : 'Alkan';
  return '';
}

export function hasRing(g) {
  return !isAcyclic(g);
}

function components(g) {
  const seen = new Set();
  let n = 0;
  for (let i = 0; i < g.atoms.length; i++) {
    if (seen.has(i)) continue;
    n++;
    const st = [i];
    while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); for (const m of neighbors(g, x)) st.push(m.atom); }
  }
  return n;
}

export function isAcyclic(g) {
  return g.bonds.length === g.atoms.length - components(g);
}

// ---------------------------------------------------------------------------
// Graph → SMILES
// ---------------------------------------------------------------------------

function atomSymbol(a, forceBracket) {
  const el = a.aromatic ? a.el.toLowerCase() : a.el;
  const implicitOK = !forceBracket && ORGANIC.has(a.el) && !a.charge && !a.bracket;
  if (implicitOK) return el;
  let s = '[' + el;
  if (a.hCount && a.el !== 'H') s += 'H' + (a.hCount > 1 ? a.hCount : '');
  if (a.charge) s += (a.charge > 0 ? '+' : '-') + (Math.abs(a.charge) > 1 ? Math.abs(a.charge) : '');
  return s + ']';
}

function bondSymbol(order, a, b) {
  if (order === 2) return '=';
  if (order === 3) return '#';
  if (order === 1.5) return '';
  if (order === 1 && a.aromatic && b.aromatic) return '-';
  return '';
}

export function toSmiles(g) {
  const n = g.atoms.length;
  if (!n) return '';
  const adj = Array.from({ length: n }, () => []);
  g.bonds.forEach((b, k) => { adj[b.a].push({ to: b.b, k }); adj[b.b].push({ to: b.a, k }); });
  // DFS-Baum bestimmen, übrige Kanten sind Ringschlüsse
  const visited = new Array(n).fill(false);
  const treeEdge = new Set();
  const order = [];
  const dfs = (v) => {
    visited[v] = true;
    order.push(v);
    for (const e of adj[v]) if (!visited[e.to]) { treeEdge.add(e.k); dfs(e.to); }
  };
  const roots = [];
  for (let i = 0; i < n; i++) if (!visited[i]) { roots.push(i); dfs(i); }
  const ringAt = Array.from({ length: n }, () => []);
  let nextDigit = 1;
  const pos = new Map(order.map((v, i) => [v, i]));
  g.bonds.forEach((b, k) => {
    if (treeEdge.has(k)) return;
    const [first, second] = pos.get(b.a) < pos.get(b.b) ? [b.a, b.b] : [b.b, b.a];
    const d = nextDigit++;
    ringAt[first].push({ d, k, open: true });
    ringAt[second].push({ d, k, open: false });
  });
  const written = new Array(n).fill(false);
  const write = (v, from) => {
    written[v] = true;
    let s = atomSymbol(g.atoms[v]);
    for (const r of ringAt[v]) {
      const b = g.bonds[r.k];
      const ds = r.d < 10 ? String(r.d) : '%' + r.d;
      s += (r.open ? bondSymbol(b.order, g.atoms[b.a], g.atoms[b.b]) : '') + ds;
    }
    const kids = adj[v].filter(e => treeEdge.has(e.k) && e.to !== from && !written[e.to]);
    kids.forEach((e, idx) => {
      const b = g.bonds[e.k];
      const sub = bondSymbol(b.order, g.atoms[v], g.atoms[e.to]) + write(e.to, v);
      s += idx < kids.length - 1 ? '(' + sub + ')' : sub;
    });
    return s;
  };
  return roots.map(r => write(r, -1)).join('.');
}

// Aromatische Ringe als abwechselnde Einfach-/Doppelbindungen schreiben
// (Kekulé-Formel, so wie im Schulbuch bei der Valenzstrichformel)
export function kekulize(g) {
  const atoms = g.atoms.map(a => ({ ...a }));
  const bonds = g.bonds.map(b => ({ ...b }));
  const arom = bonds.filter(b => b.order === 1.5);
  if (!arom.length) return { atoms, bonds };
  const deg = (i) => bonds.filter(b => b.a === i || b.b === i).length;
  const hasDouble = (i) => bonds.some(b => (b.a === i || b.b === i) && b.order === 2);
  const needs = atoms.map((a, i) => {
    if (!a.aromatic || hasDouble(i)) return false;
    if (a.el === 'C') return a.charge === 0;
    if (a.el === 'N' || a.el === 'P') return a.charge > 0 ? deg(i) === 3 : (a.hCount || 0) === 0 && deg(i) === 2;
    return false;
  });
  const matched = new Array(atoms.length).fill(false);
  const needy = atoms.map((_, i) => i).filter(i => needs[i]);
  let steps = 0;
  const solve = () => {
    if (++steps > 20000) return false;
    const i = needy.find(k => !matched[k]);
    if (i === undefined) return true;
    for (const b of arom) {
      if (b.order !== 1.5) continue;
      const j = b.a === i ? b.b : b.b === i ? b.a : -1;
      if (j < 0 || !needs[j] || matched[j]) continue;
      b.order = 2; matched[i] = matched[j] = true;
      if (solve()) return true;
      b.order = 1.5; matched[i] = matched[j] = false;
    }
    return false;
  };
  if (!solve()) return { atoms: g.atoms.map(a => ({ ...a })), bonds: g.bonds.map(b => ({ ...b })) };
  for (const b of bonds) if (b.order === 1.5) b.order = 1;
  for (const a of atoms) if (a.aromatic) { a.aromatic = false; if (a.el !== 'C' && a.hCount) a.bracket = true; }
  return { atoms, bonds };
}

// SMILES mit allen H-Atomen als eigene Atome (für die Valenzstrichformel)
export function explicitHSmiles(smiles) {
  const g = kekulize(typeof smiles === 'string' ? parseSmiles(smiles) : smiles);
  const out = { atoms: g.atoms.map(a => ({ ...a, hCount: 0, bracket: a.bracket || !!a.charge })), bonds: g.bonds.map(b => ({ ...b })) };
  g.atoms.forEach((a, i) => {
    for (let k = 0; k < (a.hCount || 0); k++) {
      out.atoms.push({ el: 'H', aromatic: false, charge: 0, hCount: 0, bracket: true });
      out.bonds.push({ a: i, b: out.atoms.length - 1, order: 1 });
    }
  });
  // Geladene Atome brauchen Klammern ohne H-Zahl
  return toSmiles(out);
}

// ---------------------------------------------------------------------------
// Halbstrukturformel (mhchem-Schreibweise: CH3-CH2-OH)
// ---------------------------------------------------------------------------

export function condensedFormula(smiles) {
  const g = typeof smiles === 'string' ? parseSmiles(smiles) : smiles;
  if (!isAcyclic(g) || components(g) !== 1) return null;
  const A = g.atoms;
  const nb = (i) => neighbors(g, i);
  // Kettenatome: Kohlenstoff und Heteroatome zwischen zwei Kettenatomen (Ether, Ester, sek. Amine)
  const heavy = A.map((a, i) => i);
  const isChain = (i) => A[i].el === 'C' || (['O', 'N', 'S'].includes(A[i].el) && nb(i).filter(n => A[n.atom].el === 'C').length >= 2);
  const chainAtoms = heavy.filter(isChain);
  if (!chainAtoms.length) return null;
  const chainNb = (i) => nb(i).filter(n => isChain(n.atom));
  const farthest = (start) => {
    const dist = new Map([[start, 0]]), prev = new Map();
    const q = [start];
    while (q.length) {
      const v = q.shift();
      for (const n of chainNb(v)) if (!dist.has(n.atom)) { dist.set(n.atom, dist.get(v) + 1); prev.set(n.atom, v); q.push(n.atom); }
    }
    let best = start;
    for (const [v, d] of dist) if (d > dist.get(best)) best = v;
    return { best, prev };
  };
  const a = farthest(chainAtoms[0]).best;
  const { best: b, prev } = farthest(a);
  let path = [b];
  while (path[path.length - 1] !== a) path.push(prev.get(path[path.length - 1]));
  // Funktionelle Gruppe möglichst ans Ende (rechts) stellen
  const score = (i) => nb(i).filter(n => !isChain(n.atom)).length;
  if (path.length > 1 && score(path[0]) > score(path[path.length - 1])) path.reverse();
  // Ester in Schulschreibweise: R-COO-R' (Carbonyl-C vor dem Brücken-O)
  const isCarbonylC = (i) => A[i].el === 'C' && nb(i).some(n => A[n.atom].el === 'O' && n.order === 2);
  for (let k = 0; k < path.length - 1; k++) {
    if (A[path[k]].el === 'O' && isCarbonylC(path[k + 1])) { path.reverse(); break; }
  }
  const inPath = new Set(path);
  const group = (i, parent) => {
    // Seitengruppe als kurzer Text
    const at = A[i];
    if (at.el === 'O' && at.hCount) return 'OH';
    if (at.el === 'N' && !at.charge) return 'NH' + (at.hCount > 1 ? at.hCount : at.hCount ? '' : '');
    if (at.el === 'C') {
      const kids = nb(i).filter(n => n.atom !== parent);
      if (!kids.length) return 'CH' + (at.hCount > 1 ? at.hCount : at.hCount ? '' : '');
      const inner = kids.map(k => group(k.atom, i)).join('');
      return 'CH' + (at.hCount > 1 ? at.hCount : at.hCount ? '' : '') + '-' + inner;
    }
    return at.el + (at.hCount ? 'H' + (at.hCount > 1 ? at.hCount : '') : '');
  };
  const bondSym = (o) => (o === 2 ? '=' : o === 3 ? '#' : '-');
  let out = '';
  for (let k = 0; k < path.length; k++) {
    const v = path[k];
    const at = A[v];
    const side = nb(v).filter(n => !inPath.has(n.atom));
    const dO = side.filter(n => A[n.atom].el === 'O' && n.order === 2);
    const rest = side.filter(n => !dO.includes(n));
    const last = k === path.length - 1, first = k === 0;
    let label = '';
    if (at.el === 'C') {
      const ohSide = rest.filter(n => A[n.atom].el === 'O' && A[n.atom].hCount);
      if (dO.length && ohSide.length && (last || first) && rest.length === 1) {
        label = first && !last ? 'HOOC' : 'COOH';
        out += (k ? bondSym(chainOrder(g, path[k - 1], v)) : '') + label;
        continue;
      }
      if (dO.length && at.hCount === 1 && (last || first) && !rest.length) {
        label = first && !last ? 'OHC' : 'CHO';
        out += (k ? bondSym(chainOrder(g, path[k - 1], v)) : '') + label;
        continue;
      }
      if (dO.length && !last && A[path[k + 1]].el === 'O') {
        // Ester: -COO-
        label = 'COO';
        out += (k ? bondSym(chainOrder(g, path[k - 1], v)) : '') + label;
        k++;
        continue;
      }
      label = 'C' + (at.hCount ? 'H' + (at.hCount > 1 ? at.hCount : '') : '');
      if (dO.length) label += 'O';
      // Einzelne Seitengruppen am Kettenende als "-OH" anhängen, sonst in Klammern
      const tail = [];
      for (const n of rest) {
        const txt = group(n.atom, v);
        if ((last || first) && rest.length === 1 && path.length > 1) tail.push(txt);
        else label += '(' + txt + ')';
      }
      const bond = k ? bondSym(chainOrder(g, path[k - 1], v)) : '';
      if (first && tail.length && path.length > 1) out += tail[0].split('-').reverse().join('-').replace(/^OH$/, 'HO') + '-' + label;
      else out += bond + label + (tail.length ? '-' + tail[0] : '');
    } else {
      label = at.el + (at.hCount ? 'H' + (at.hCount > 1 ? at.hCount : '') : '');
      out += (k ? bondSym(chainOrder(g, path[k - 1], v)) : '') + label;
    }
  }
  if (path.length === 1) {
    const v = path[0];
    const side = nb(v);
    if (side.length) {
      const g1 = side.map(n => group(n.atom, v));
      out = out + g1.map(x => '-' + x).join('');
    }
  }
  return out;
}

function chainOrder(g, a, b) {
  const bd = g.bonds.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  return bd ? bd.order : 1;
}

// ---------------------------------------------------------------------------
// Valenzstrichformel im Heft-Stil (gerade Kette, H oben/unten)
// Liefert Positionen auf einem Raster – gezeichnet wird im Block.
// ---------------------------------------------------------------------------

const DIRS = { r: [1, 0], l: [-1, 0], u: [0, -1], d: [0, 1] };
const PERP = { r: ['u', 'd'], l: ['u', 'd'], u: ['l', 'r'], d: ['l', 'r'] };
const OPP = { r: 'l', l: 'r', u: 'd', d: 'u' };

// Probiert zuerst eine enge Kette; wird es zu voll, mehr Abstand zwischen den Kettenatomen.
export function gridLayout(smiles) {
  for (const spacing of [2, 3, 4]) {
    const L = gridLayoutWith(smiles, spacing);
    if (L) return L;
  }
  return null;
}

function gridLayoutWith(smiles, spacing) {
  const base = typeof smiles === 'string' ? parseSmiles(smiles) : smiles;
  if (!isAcyclic(base) || components(base) !== 1) return null;
  // Alle H als eigene Atome
  const g = { atoms: base.atoms.map(a => ({ ...a })), bonds: base.bonds.map(b => ({ ...b })) };
  base.atoms.forEach((a, i) => {
    for (let k = 0; k < (a.hCount || 0); k++) {
      g.atoms.push({ el: 'H', charge: 0, hCount: 0 });
      g.bonds.push({ a: i, b: g.atoms.length - 1, order: 1 });
    }
  });
  const nb = (i) => neighbors(g, i);
  const isH = (i) => g.atoms[i].el === 'H';
  // Doppelt gebundenes, endständiges O/S (=O) gehört nicht in die Hauptkette,
  // damit z. B. die Carboxygruppe als C(=O)–OH mit =O nach oben erscheint.
  const isSideOnly = (i) => ['O', 'S'].includes(g.atoms[i].el) && nb(i).filter(n => !isH(n.atom)).length === 1 && nb(i).some(n => n.order === 2);
  const chainIdx = g.atoms.map((a, i) => i).filter(i => !isH(i) && !isSideOnly(i));
  const pool = chainIdx.length ? chainIdx : g.atoms.map((a, i) => i).filter(i => !isH(i));
  const inPool = new Set(pool);
  const heavyNb = (i) => nb(i).filter(n => inPool.has(n.atom));
  const farthest = (start) => {
    const dist = new Map([[start, 0]]), prev = new Map();
    const q = [start];
    while (q.length) {
      const v = q.shift();
      for (const n of heavyNb(v)) if (!dist.has(n.atom)) { dist.set(n.atom, dist.get(v) + 1); prev.set(n.atom, v); q.push(n.atom); }
    }
    let best = start;
    for (const [v, d] of dist) if (d > dist.get(best)) best = v;
    return { best, prev };
  };
  const a = farthest(pool[0]).best;
  const { best: b, prev } = farthest(a);
  const path = [b];
  while (path[path.length - 1] !== a) path.push(prev.get(path[path.length - 1]));
  // Heteroatome (OH, NH2 …) lieber rechts
  if (path.length > 1 && g.atoms[path[0]].el !== 'C' && g.atoms[path[path.length - 1]].el === 'C') path.reverse();

  const pos = new Map();
  const tooClose = (x, y, minD) => {
    for (const [, [px, py]] of pos) if (Math.hypot(px - x, py - y) < minD) return true;
    return false;
  };
  path.forEach((v, k) => pos.set(v, [k * spacing, 0]));

  // Platziert einen Teilbaum ab Atom v (Richtung cameDir); bei Kollision wird
  // alles wieder entfernt und false zurückgegeben (dann wird die andere Seite probiert).
  const placeSub = (v, from, cameDir, prefer) => {
    const [x, y] = pos.get(v);
    const kids = nb(v).filter(n => n.atom !== from && !pos.has(n.atom));
    const heavyKids = kids.filter(n => !isH(n.atom));
    const hKids = kids.filter(n => isH(n.atom));
    let slots;
    if (cameDir === null) {
      const k = path.indexOf(v);
      slots = [];
      if (k === 0 && path.length > 1) slots.push('l');
      if (k === path.length - 1 && path.length > 1) slots.push('r');
      slots.push(...prefer);
      if (path.length === 1) slots = ['r', 'l', ...prefer];
    } else slots = [cameDir, ...PERP[cameDir]];
    const placed = [];
    const undo = () => { for (const p of placed) pos.delete(p); };
    const tryHeavy = (idx) => {
      if (idx === heavyKids.length) return true;
      const n = heavyKids[idx];
      // Äste an der Kette: zuerst die bevorzugte Seite, dann die andere
      const order = cameDir === null ? [...prefer.filter(s => slots.includes(s)), ...slots.filter(s => !prefer.includes(s))] : slots.slice();
      for (const d of order) {
        if (!slots.includes(d)) continue;
        const [dx, dy] = DIRS[d];
        const nx = x + dx * 2, ny = y + dy * 2;
        if (tooClose(nx, ny, 1.9) || tooClose(x + dx, y + dy, 0.9)) continue;
        pos.set(n.atom, [nx, ny]);
        const before = new Set(pos.keys());
        slots = slots.filter(s => s !== d);
        if (placeSub(n.atom, v, d, [d]) && tryHeavy(idx + 1)) { placed.push(n.atom); return true; }
        // zurücknehmen
        for (const key of [...pos.keys()]) if (!before.has(key)) pos.delete(key);
        pos.delete(n.atom);
        slots.push(d);
      }
      return false;
    };
    if (!tryHeavy(0)) { undo(); return false; }
    for (const n of hKids) {
      const d = slots.find(s => { const [dx, dy] = DIRS[s]; return !tooClose(x + dx * 1.5, y + dy * 1.5, 1.2); });
      if (!d) { undo(); return false; }
      slots = slots.filter(s => s !== d);
      const [dx, dy] = DIRS[d];
      pos.set(n.atom, [x + dx * 1.5, y + dy * 1.5]);
      placed.push(n.atom);
    }
    return true;
  };
  for (let k = 0; k < path.length; k++) {
    const v = path[k];
    const prefer = k % 2 === 0 ? ['u', 'd'] : ['d', 'u'];
    if (!placeSub(v, null, null, prefer) && !placeSub(v, null, null, [prefer[1], prefer[0]])) return null;
  }
  if (pos.size !== g.atoms.length) return null;
  // Freie Elektronenpaare in freie Richtungen
  const lonePairs = [];
  g.atoms.forEach((at, i) => {
    let lp = LONE_PAIRS[at.el] || 0;
    if (at.el === 'N' && at.charge > 0) lp = 0;
    if (at.el === 'O') lp = 2 - (at.charge > 0 ? 1 : 0) + (at.charge < 0 ? 1 : 0);
    if (!lp) return;
    const [x, y] = pos.get(i);
    const usedDirs = nb(i).map(n => {
      const [nx, ny] = pos.get(n.atom);
      return Math.abs(nx - x) > Math.abs(ny - y) ? (nx > x ? 'r' : 'l') : (ny > y ? 'd' : 'u');
    });
    const freeDirs = ['u', 'd', 'l', 'r'].filter(d => !usedDirs.includes(d));
    const prefOrder = usedDirs.length === 1 ? [OPP[usedDirs[0]], ...PERP[usedDirs[0]]] : [...PERP[usedDirs[0] || 'r'], ...freeDirs];
    const pick = [];
    for (const d of prefOrder) if (freeDirs.includes(d) && !pick.includes(d) && pick.length < lp) pick.push(d);
    // Bei zwei Paaren an einem O mit einer Bindung: die beiden seitlichen Plätze (wie im Heft)
    if (at.el === 'O' && usedDirs.length === 1 && lp === 2) {
      const side = PERP[usedDirs[0]];
      if (side.every(d => freeDirs.includes(d))) { pick.length = 0; pick.push(...side); }
    }
    for (const d of pick) lonePairs.push({ atom: i, dir: d });
  });
  return {
    atoms: g.atoms.map((at, i) => ({ el: at.el, charge: at.charge || 0, x: pos.get(i)[0], y: pos.get(i)[1] })),
    bonds: g.bonds.map(bd => ({ a: bd.a, b: bd.b, order: bd.order })),
    lonePairs
  };
}

// ---------------------------------------------------------------------------
// Deutsche IUPAC-Namen → Molekül
// ---------------------------------------------------------------------------

const STEMS = [
  ['eicos', 20], ['icos', 20], ['nonadec', 19], ['octadec', 18], ['heptadec', 17], ['hexadec', 16], ['pentadec', 15], ['tetradec', 14],
  ['tridec', 13], ['dodec', 12], ['undec', 11], ['dec', 10], ['non', 9], ['oct', 8], ['hept', 7], ['hex', 6], ['pent', 5],
  ['but', 4], ['prop', 3], ['eth', 2], ['meth', 1]
];
const MULTIPLIERS = { di: 2, tri: 3, tetra: 4, penta: 5, hexa: 6 };
const SUBSTITUENTS = [
  ['tert-butyl', 'C(C)(C)C'], ['sec-butyl', 'C(C)CC'], ['isopropyl', 'C(C)C'], ['isobutyl', 'CC(C)C'],
  ['methyl', 'C'], ['ethyl', 'CC'], ['propyl', 'CCC'], ['butyl', 'CCCC'], ['pentyl', 'CCCCC'], ['hexyl', 'CCCCCC'],
  ['phenyl', 'c1ccccc1'], ['ethenyl', 'C=C'], ['vinyl', 'C=C'],
  ['chloro', 'Cl'], ['chlor', 'Cl'], ['bromo', 'Br'], ['brom', 'Br'], ['iodo', 'I'], ['iod', 'I'], ['jod', 'I'], ['fluoro', 'F'], ['fluor', 'F'],
  ['hydroxy', 'O'], ['amino', 'N'], ['nitro', '[N+](=O)[O-]'], ['methoxy', 'OC'], ['ethoxy', 'OCC'], ['oxo', '=O'], ['cyano', 'C#N'],
  ['sulfanyl', 'S'], ['mercapto', 'S']
];
const TRIVIAL_ACIDS = { essigsäure: 'ethansäure', ameisensäure: 'methansäure', propionsäure: 'propansäure', buttersäure: 'butansäure', valeriansäure: 'pentansäure' };

function newAtom(el, extra = {}) { return { el, aromatic: false, charge: 0, h: null, bracket: false, ...extra }; }

// Fragment (SMILES) an Atom `at` des Graphen hängen
function attachFragment(g, at, frag) {
  if (frag === '=O') {
    g.atoms.push(newAtom('O'));
    g.bonds.push({ a: at, b: g.atoms.length - 1, order: 2 });
    return;
  }
  const f = parseSmiles(frag);
  const offset = g.atoms.length;
  for (const a of f.atoms) g.atoms.push({ ...a, hCount: undefined });
  for (const b of f.bonds) g.bonds.push({ a: b.a + offset, b: b.b + offset, order: b.order });
  g.bonds.push({ a: at, b: offset, order: 1 });
}

function parseLocants(s) {
  return s ? s.split(',').map(x => parseInt(x, 10)).filter(n => n > 0) : null;
}

export function nameToMolecule(name) {
  let s = String(name || '').trim().toLowerCase().replace(/\s+/g, '').replace(/ä/g, 'ä');
  if (!s) throw new Error('Kein Name');
  for (const [k, v] of Object.entries(TRIVIAL_ACIDS)) if (s.startsWith(k)) s = v + s.slice(k.length);
  // Ester: "Ethansäureethylester" oder "Ethylethanoat"
  let m = /^(.+säure)(.+)ylester$/.exec(s);
  if (m) return esterFrom(m[1], m[2] + 'yl');
  m = /^((?:methyl|ethyl|propyl|butyl|pentyl|isopropyl))(.+)oat$/.exec(s);
  if (m) return esterFrom(m[2] + 'säure', m[1]);

  // Präfixe (Substituenten) abtrennen
  const subs = [];
  let rest = s;
  let bareLocant = null;
  const subNames = SUBSTITUENTS.map(x => x[0]).join('|');
  const re = new RegExp(`^-?(?:(\\d+(?:,\\d+)*)-)?(di|tri|tetra)?(${subNames})`);
  for (;;) {
    const mm = re.exec(rest);
    if (!mm) break;
    const after = rest.slice(mm[0].length);
    // "propyl..." darf nicht den Stamm "prop" des Hauptnamens verschlucken
    if (!after || /^(an|en|in|ol|al|on|säure)/.test(after)) break;
    subs.push({ locants: parseLocants(mm[1]), mult: mm[2] ? MULTIPLIERS[mm[2]] : 1, frag: SUBSTITUENTS.find(x => x[0] === mm[3])[1], name: mm[3] });
    rest = after;
  }
  const lm = /^-?(\d+(?:,\d+)*)-(.*)$/.exec(rest);
  if (lm) { bareLocant = parseLocants(lm[1]); rest = lm[2]; }
  rest = rest.replace(/^-/, '');

  // Stammname mit Endung
  const stemNames = STEMS.map(x => x[0]).join('|');
  const pm = new RegExp(`^(cyclo)?(${stemNames})(a)?(?:-?(\\d+(?:,\\d+)*)-)?(di|tri|tetra)?(an|en|in)(?:-?(\\d+(?:,\\d+)*)-)?(di|tri|tetra)?(ol|al|on|säure|amin|nitril)?$`).exec(rest);
  if (!pm) throw new Error('Name nicht erkannt');
  const cyclo = !!pm[1];
  const n = STEMS.find(x => x[0] === pm[2])[1];
  let unsatLoc = parseLocants(pm[4]);
  const unsatMult = pm[5] ? MULTIPLIERS[pm[5]] : 1;
  const unsat = pm[6];
  let sufLoc = parseLocants(pm[7]);
  const sufMult = pm[8] ? MULTIPLIERS[pm[8]] : 1;
  const suffix = pm[9] || '';
  if (bareLocant) {
    if (suffix && !sufLoc && suffix !== 'al' && suffix !== 'säure') sufLoc = bareLocant;
    else if (unsat !== 'an' && !unsatLoc) unsatLoc = bareLocant;
    else if (!sufLoc) sufLoc = bareLocant;
  }
  if (cyclo && n < 3) throw new Error('Ring zu klein');

  const g = { atoms: [], bonds: [] };
  for (let k = 0; k < n; k++) {
    g.atoms.push(newAtom('C'));
    if (k) g.bonds.push({ a: k - 1, b: k, order: 1 });
  }
  if (cyclo) g.bonds.push({ a: 0, b: n - 1, order: 1 });
  const C = (loc) => {
    if (!loc || loc < 1 || loc > n) throw new Error(`Position ${loc} passt nicht zur Kettenlänge ${n}`);
    return loc - 1;
  };
  // Mehrfachbindungen
  if (unsat !== 'an') {
    let locs = unsatLoc || (unsatMult === 2 ? [1, 3] : unsatMult === 3 ? [1, 3, 5] : [1]);
    if (locs.length !== unsatMult) throw new Error('Anzahl der Mehrfachbindungen passt nicht');
    for (const l of locs) {
      const a = C(l), b = cyclo && l === n ? 0 : C(l + 1);
      const bd = g.bonds.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
      if (!bd) throw new Error('Bindung existiert nicht');
      bd.order = unsat === 'en' ? 2 : 3;
    }
  }
  // Hauptgruppe (Endung)
  const def = (mult, first) => (mult === 1 ? [first] : mult === 2 ? [1, n] : Array.from({ length: mult }, (_, k) => k + 1));
  if (suffix === 'ol') for (const l of sufLoc || def(sufMult, 1)) attachFragment(g, C(l), 'O');
  if (suffix === 'amin') for (const l of sufLoc || def(sufMult, 1)) attachFragment(g, C(l), 'N');
  if (suffix === 'on') for (const l of sufLoc || def(sufMult, n > 2 ? 2 : 1)) attachFragment(g, C(l), '=O');
  if (suffix === 'al') for (const l of sufMult === 2 ? [1, n] : [1]) attachFragment(g, C(l), '=O');
  if (suffix === 'säure') for (const l of sufMult === 2 ? [1, n] : [1]) { attachFragment(g, C(l), '=O'); attachFragment(g, C(l), 'O'); }
  if (suffix === 'nitril') { const at = C(1); g.atoms.push(newAtom('N')); g.bonds.push({ a: at, b: g.atoms.length - 1, order: 3 }); }
  // Substituenten
  for (const sub of subs) {
    const isAlkyl = /yl$/.test(sub.name);
    const locs = sub.locants || Array.from({ length: sub.mult }, () => (isAlkyl && n > 2 ? 2 : 1));
    if (sub.locants && sub.locants.length !== sub.mult) throw new Error(`Anzahl bei „${sub.name}“ passt nicht (${sub.locants.join(',')})`);
    for (const l of locs) attachFragment(g, C(l), sub.frag);
  }
  finalize(g);
  return g;
}

function esterFrom(acidName, alkyl) {
  const acid = nameToMolecule(acidName);
  // OH der Säuregruppe durch O-Alkyl ersetzen
  const oh = acid.atoms.findIndex((a, i) => a.el === 'O' && a.hCount === 1 && neighbors(acid, i).some(n => acid.atoms[n.atom].el === 'C'));
  if (oh < 0) throw new Error('Keine Säuregruppe gefunden');
  const frag = SUBSTITUENTS.find(x => x[0] === alkyl);
  if (!frag) throw new Error(`Unbekannter Rest „${alkyl}“`);
  const g = { atoms: acid.atoms.map(a => ({ ...a, hCount: undefined })), bonds: acid.bonds.map(b => ({ ...b })) };
  attachFragment(g, oh, frag[1]);
  finalize(g);
  return g;
}

function finalize(g) {
  for (const a of g.atoms) { a.h = null; a.bracket = a.bracket && !!a.charge; }
  computeH(g);
  g.atoms.forEach((a, i) => {
    if (a.el !== 'C') return;
    const sum = neighbors(g, i).reduce((s, n) => s + (n.order === 1.5 ? 1 : n.order), 0);
    if (sum > 4) throw new Error('Ein Kohlenstoffatom hätte mehr als vier Bindungen – der Name ist so nicht möglich');
  });
}

export function nameToSmiles(name) {
  return toSmiles(nameToMolecule(name));
}

// ---------------------------------------------------------------------------
// Reaktionsgleichungen ausgleichen
// ---------------------------------------------------------------------------

// Zerlegt eine Summenformel wie Ca(OH)2, CuSO4*5H2O oder SO4^2- in Atome + Ladung
export function parseFormula(src) {
  let s = String(src).trim();
  let charge = 0;
  const cm = /\^\{?(\d*)([+-])\}?$/.exec(s) || /(?<=[A-Za-z\])])(\d*)([+-])$/.exec(s);
  if (cm) {
    charge = (cm[2] === '+' ? 1 : -1) * (cm[1] ? parseInt(cm[1], 10) : 1);
    s = s.slice(0, cm.index);
  }
  if (/^e$/.test(s)) return { counts: {}, charge: charge || -1 };
  const parts = s.split(/[*·.]/);
  const total = {};
  for (let p of parts) {
    const mult = /^(\d+)/.exec(p);
    let k = 1;
    if (mult) { k = parseInt(mult[1], 10); p = p.slice(mult[1].length); }
    const c = parseGroup(p);
    for (const el in c) total[el] = (total[el] || 0) + c[el] * k;
  }
  return { counts: total, charge };
}

function parseGroup(s) {
  let i = 0;
  const parse = () => {
    const counts = {};
    while (i < s.length) {
      const c = s[i];
      if (c === '(' || c === '[') {
        i++;
        const inner = parse();
        i++; // schließende Klammer
        const m = /^\d+/.exec(s.slice(i));
        const k = m ? parseInt(m[0], 10) : 1;
        if (m) i += m[0].length;
        for (const el in inner) counts[el] = (counts[el] || 0) + inner[el] * k;
        continue;
      }
      if (c === ')' || c === ']') return counts;
      const m = /^([A-Z][a-z]?)(\d*)/.exec(s.slice(i));
      if (!m) throw new Error(`Formel nicht lesbar: „${s}“`);
      if (!(m[1] in MASSES)) throw new Error(`Unbekanntes Element „${m[1]}“`);
      counts[m[1]] = (counts[m[1]] || 0) + (m[2] ? parseInt(m[2], 10) : 1);
      i += m[0].length;
    }
    return counts;
  };
  return parse();
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }

// Rationale Zahlen als [Zähler, Nenner] (BigInt, damit nichts überläuft)
function frac(n, d = 1n) { n = BigInt(n); d = BigInt(d); if (d < 0n) { n = -n; d = -d; } const g = bgcd(n < 0n ? -n : n, d) || 1n; return [n / g, d / g]; }
function bgcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
const fsub = (x, y) => frac(x[0] * y[1] - y[0] * x[1], x[1] * y[1]);
const fmul = (x, y) => frac(x[0] * y[0], x[1] * y[1]);
const fdiv = (x, y) => frac(x[0] * y[1], x[1] * y[0]);

function nullspace(M) {
  const rows = M.length, cols = M[0].length;
  const A = M.map(r => r.map(v => frac(v)));
  const pivots = [];
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    let p = r;
    while (p < rows && A[p][c][0] === 0n) p++;
    if (p === rows) continue;
    [A[r], A[p]] = [A[p], A[r]];
    const piv = A[r][c];
    A[r] = A[r].map(v => fdiv(v, piv));
    for (let k = 0; k < rows; k++) {
      if (k === r || A[k][c][0] === 0n) continue;
      const f = A[k][c];
      A[k] = A[k].map((v, j) => fsub(v, fmul(f, A[r][j])));
    }
    pivots.push(c);
    r++;
  }
  const free = [];
  for (let c = 0; c < cols; c++) if (!pivots.includes(c)) free.push(c);
  return { free, A, pivots };
}

const STATE_RE = /\s*\((s|l|g|aq)\)\s*$/;

function splitSpecies(side) {
  return side.split(/\s+\+\s+/).map(x => x.trim()).filter(Boolean);
}

function speciesParts(tok) {
  // Koeffizient, Formel, Rest (Zustand, ↑/↓)
  let t = tok.trim();
  let tail = '';
  const ud = /\s+(\^|v)$/.exec(t);
  if (ud) { tail = ud[0] + tail; t = t.slice(0, ud.index); }
  const st = STATE_RE.exec(t);
  if (st) { tail = st[0] + tail; t = t.slice(0, st.index); }
  const cm = /^(\d+(?:\/\d+)?)\s*/.exec(t);
  let coef = null;
  if (cm && /[A-Z(e]/.test(t.slice(cm[0].length, cm[0].length + 1))) { coef = cm[1]; t = t.slice(cm[0].length); }
  return { formula: t, tail };
}

export function balanceEquation(src) {
  const text = String(src || '');
  const am = /\s*(->\[[^\]]*\](?:\[[^\]]*\])?|<=>\[[^\]]*\](?:\[[^\]]*\])?|<=>|<-->|<->|->|→|⇌|=)\s*/.exec(text);
  if (!am) throw new Error('Kein Reaktionspfeil gefunden (-> oder <=>)');
  const left = splitSpecies(text.slice(0, am.index));
  const right = splitSpecies(text.slice(am.index + am[0].length));
  if (!left.length || !right.length) throw new Error('Links oder rechts fehlt etwas');
  const species = [...left, ...right].map(speciesParts);
  const parsed = species.map(sp => parseFormula(sp.formula));
  const elements = [...new Set(parsed.flatMap(p => Object.keys(p.counts)))];
  const rows = elements.map(el => parsed.map((p, j) => (p.counts[el] || 0) * (j < left.length ? 1 : -1)));
  if (parsed.some(p => p.charge)) rows.push(parsed.map((p, j) => p.charge * (j < left.length ? 1 : -1)));
  const { free, A, pivots } = nullspace(rows);
  if (free.length !== 1) throw new Error(free.length ? 'Gleichung ist nicht eindeutig ausgleichbar' : 'Gleichung lässt sich nicht ausgleichen – stimmen die Formeln?');
  const f = free[0];
  const x = new Array(parsed.length).fill(null);
  x[f] = frac(1);
  pivots.forEach((c, r) => { x[c] = frac(-A[r][f][0], A[r][f][1]); });
  // Auf kleinste ganze Zahlen bringen
  let lcm = 1n;
  for (const v of x) lcm = (lcm * v[1]) / bgcd(lcm, v[1]);
  let ints = x.map(v => (v[0] * lcm) / v[1]);
  if (ints.every(v => v <= 0n)) ints = ints.map(v => -v);
  if (ints.some(v => v <= 0n)) throw new Error('Gleichung lässt sich nicht sinnvoll ausgleichen');
  let g = ints.reduce((a, b) => bgcd(a, b));
  ints = ints.map(v => v / g);
  const fmt = (i) => (ints[i] === 1n ? '' : String(ints[i])) + species[i].formula + species[i].tail;
  const L = left.map((_, i) => fmt(i)).join(' + ');
  const R = right.map((_, i) => fmt(left.length + i)).join(' + ');
  return { text: `${L} ${am[1]} ${R}`, coefficients: ints.map(Number) };
}

// Prüft, ob eine Gleichung stimmt (für einen Hinweis im Editor).
// Kernreaktionen (mit Nukliden wie ^{14}_{6}C) werden über Massen- und
// Ordnungszahlen geprüft – dort ändern sich ja die Elemente.
export function checkEquation(src) {
  if (hasNuclide(src)) {
    const n = checkNuclear(src);
    return n ? { ...n, nuclear: true, diff: [] } : null;
  }
  try {
    const text = String(src);
    const am = /\s*(->\[[^\]]*\](?:\[[^\]]*\])?|<=>\[[^\]]*\](?:\[[^\]]*\])?|<=>|<->|->|→|⇌)\s*/.exec(text);
    if (!am) return null;
    const count = (side) => {
      const tot = {};
      let ch = 0;
      for (const tok of splitSpecies(side)) {
        const t = tok.trim().replace(/\s+(\^|v)$/, '').replace(STATE_RE, '');
        const cm = /^(\d+)\s*(?=[A-Z(e])/.exec(t);
        const k = cm ? parseInt(cm[1], 10) : 1;
        const p = parseFormula(cm ? t.slice(cm[0].length) : t);
        for (const el in p.counts) tot[el] = (tot[el] || 0) + p.counts[el] * k;
        ch += p.charge * k;
      }
      return { tot, ch };
    };
    const l = count(text.slice(0, am.index)), r = count(text.slice(am.index + am[0].length));
    const els = new Set([...Object.keys(l.tot), ...Object.keys(r.tot)]);
    const diff = [...els].filter(e => (l.tot[e] || 0) !== (r.tot[e] || 0));
    return { balanced: !diff.length && l.ch === r.ch, diff, charge: l.ch === r.ch };
  } catch { return null; }
}
