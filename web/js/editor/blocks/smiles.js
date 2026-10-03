// Strukturformel-Block (SMILES → Skelettformel).
//
// SMILES ist die Standard-Kurzschrift für Moleküle ("CCO" = Ethanol). Weil
// niemand im Unterricht SMILES auswendig kann, gibt es ein eingebautes
// Wörterbuch der üblichen Schulstoffe auf Deutsch und – wenn online – die
// Suche über PubChem (die Mac-App fragt dort nach, damit der WebView keine
// fremden Server anspricht).

import { h, esc } from '../../ui/ui.js';
import { icon } from '../../ui/icons.js';
import { captionEl, mediaBar } from './atoms.js';
import {
  parseSmiles, elementCounts, hillFormula, molarMass, functionalGroups, substanceClass,
  explicitHSmiles, condensedFormula, gridLayout, nameToSmiles, isAcyclic, kekulize
} from '../../core/chem.js';
import { renderToString } from '../render/katex.js';

export const MOLECULES = {
  'wasser': 'O', 'kohlenstoffdioxid': 'O=C=O', 'kohlendioxid': 'O=C=O', 'kohlenstoffmonoxid': '[C-]#[O+]', 'ammoniak': 'N',
  'methan': 'C', 'ethan': 'CC', 'propan': 'CCC', 'butan': 'CCCC', 'pentan': 'CCCCC', 'hexan': 'CCCCCC', 'heptan': 'CCCCCCC', 'octan': 'CCCCCCCC',
  'isobutan': 'CC(C)C', 'cyclohexan': 'C1CCCCC1', 'ethen': 'C=C', 'propen': 'CC=C', 'buten': 'CCC=C', 'ethin': 'C#C',
  'methanol': 'CO', 'ethanol': 'CCO', 'propanol': 'CCCO', '1-propanol': 'CCCO', '2-propanol': 'CC(C)O', 'propan-2-ol': 'CC(C)O', 'butanol': 'CCCCO',
  'glycerin': 'OCC(O)CO', 'glycerol': 'OCC(O)CO', 'ethandiol': 'OCCO', 'glykol': 'OCCO',
  'methanal': 'C=O', 'formaldehyd': 'C=O', 'ethanal': 'CC=O', 'acetaldehyd': 'CC=O', 'propanal': 'CCC=O',
  'propanon': 'CC(C)=O', 'aceton': 'CC(C)=O', 'butanon': 'CCC(C)=O',
  'methansäure': 'OC=O', 'ameisensäure': 'OC=O', 'ethansäure': 'CC(O)=O', 'essigsäure': 'CC(O)=O', 'propansäure': 'CCC(O)=O',
  'butansäure': 'CCCC(O)=O', 'buttersäure': 'CCCC(O)=O', 'milchsäure': 'CC(O)C(O)=O', 'zitronensäure': 'OC(=O)CC(O)(CC(O)=O)C(O)=O',
  'oxalsäure': 'OC(=O)C(O)=O', 'benzoesäure': 'OC(=O)c1ccccc1', 'salicylsäure': 'OC(=O)c1ccccc1O', 'acetylsalicylsäure': 'CC(=O)Oc1ccccc1C(O)=O',
  'stearinsäure': 'CCCCCCCCCCCCCCCCCC(O)=O', 'palmitinsäure': 'CCCCCCCCCCCCCCCC(O)=O', 'ölsäure': 'CCCCCCCC/C=C\\CCCCCCCC(O)=O',
  'essigsäureethylester': 'CCOC(C)=O', 'ethylacetat': 'CCOC(C)=O', 'ethansäureethylester': 'CCOC(C)=O',
  'benzol': 'c1ccccc1', 'toluol': 'Cc1ccccc1', 'phenol': 'Oc1ccccc1', 'anilin': 'Nc1ccccc1', 'naphthalin': 'c1ccc2ccccc2c1', 'styrol': 'C=Cc1ccccc1',
  'glucose': 'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O', 'glukose': 'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O',
  'fructose': 'OC[C@@]1(O)OC[C@@H](O)[C@@H](O)[C@@H]1O', 'saccharose': 'OC[C@H]1O[C@@](CO)(O[C@H]2O[C@H](CO)[C@@H](O)[C@H](O)[C@H]2O)[C@@H](O)[C@@H]1O',
  'harnstoff': 'NC(N)=O', 'glycin': 'NCC(O)=O', 'alanin': 'C[C@H](N)C(O)=O', 'serin': 'N[C@@H](CO)C(O)=O', 'cystein': 'N[C@@H](CS)C(O)=O',
  'coffein': 'Cn1cnc2c1c(=O)n(C)c(=O)n2C', 'koffein': 'Cn1cnc2c1c(=O)n(C)c(=O)n2C', 'nikotin': 'CN1CCC[C@H]1c1cccnc1',
  'dichlormethan': 'ClCCl', 'chloroform': 'ClC(Cl)Cl', 'trichlormethan': 'ClC(Cl)Cl', 'tetrachlormethan': 'ClC(Cl)(Cl)Cl', 'chlormethan': 'CCl',
  'methylamin': 'CN', 'ethylamin': 'CCN', 'diethylether': 'CCOCC', 'dimethylether': 'COC',
  'schwefelsäure': 'OS(=O)(=O)O', 'salpetersäure': 'O[N+]([O-])=O', 'phosphorsäure': 'OP(=O)(O)O', 'kohlensäure': 'OC(=O)O',
  'salzsäure': 'Cl', 'chlorwasserstoff': 'Cl', 'wasserstoffperoxid': 'OO', 'ozon': '[O-][O+]=O', 'schwefeldioxid': 'O=S=O',
  'ethylenglykol': 'OCCO', 'adrenalin': 'CNC[C@H](O)c1ccc(O)c(O)c1', 'dopamin': 'NCCc1ccc(O)c(O)c1', 'paracetamol': 'CC(=O)Nc1ccc(O)cc1',
  'ibuprofen': 'CC(C)Cc1ccc(cc1)C(C)C(O)=O', 'vanillin': 'COc1cc(C=O)ccc1O', 'menthol': 'CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O',
  'limonen': 'CC1=CCC(CC1)C(C)=C', 'cholesterin': 'CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C'
};

export function lookupLocal(name) {
  const k = String(name || '').trim().toLowerCase();
  return MOLECULES[k] || null;
}

let drawerPromise = null;
function smilesDrawer() {
  if (!drawerPromise) {
    drawerPromise = new Promise((resolve) => {
      const check = () => {
        if (window.SmilesDrawer) resolve(window.SmilesDrawer);
        else setTimeout(check, 50);
      };
      check();
    });
  }
  return drawerPromise;
}

// Name → SMILES: erst IUPAC-Namen selbst auflösen, dann Wörterbuch.
export function resolveName(name) {
  const local = lookupLocal(name);
  if (local) return { smiles: local, source: 'Wörterbuch' };
  try { return { smiles: nameToSmiles(name), source: 'Name' }; } catch (e) { return { error: e.message }; }
}

const LONE_PAIR_COUNT = { N: 1, O: 2, S: 2, F: 3, Cl: 3, Br: 3, I: 3 };

// Skelett- oder Valenzstrichformel mit SmilesDrawer (auch für Ringe)
// scale = 1: eine Bindung ist 30 px lang – überall gleich groß, egal wie groß das Molekül ist
export async function drawSmiles(smiles, svg, { scale = 1, dark = false, explicit = false } = {}) {
  const SD = await smilesDrawer();
  const drawer = new SD.SvgDrawer({
    scale, bondThickness: 1.1, fontSizeLarge: 11, fontSizeSmall: 7, padding: 12,
    explicitHydrogens: explicit, terminalCarbons: explicit, compactDrawing: false
  });
  if (explicit) {
    // In der Valenzstrichformel jedes C beschriften
    const orig = drawer.preprocessor.processGraph.bind(drawer.preprocessor);
    drawer.preprocessor.processGraph = function () {
      orig();
      for (const v of this.graph.vertices) if (v.value.element === 'C') v.value.drawExplicit = true;
    };
  }
  const input = explicit ? explicitHSmiles(smiles) : smiles;
  await new Promise((resolve, reject) => {
    SD.parse(input, (tree) => {
      try { drawer.draw(tree, svg, dark ? 'dark' : 'light', null); resolve(true); } catch (e) { reject(e); }
    }, (err) => reject(err));
  });
  if (explicit) addLonePairs(drawer, svg, dark);
  return drawer;
}

// Valenzstrichformel für Ringe (und alles, was nicht als gerade Kette passt).
// SmilesDrawer legt nur die Lage der Nicht-H-Atome fest – wie bei der
// Skelettformel. H-Atome, Bindungsstriche und Elektronenpaare setzt Heft
// selbst in die freien Lücken (vorher zeichnete SmilesDrawer alles mit H, und
// bei Zuckern lagen H, O und Striche übereinander).
export async function ringLayout(smiles) {
  const SD = await smilesDrawer();
  // Räumliche Angaben (@, @@) weglassen: sonst legt SmilesDrawer eigene H-Atome
  // an, und die Valenzstrichformel zeigt sie ohnehin nicht
  const clean = String(smiles).replace(/@+/g, '');
  // Aromaten (Benzol …) mit abwechselnden Doppelbindungen, wie im Heft
  const base = kekulize(parseSmiles(clean));
  const drawer = new SD.SvgDrawer({ explicitHydrogens: false, compactDrawing: false });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  await new Promise((resolve, reject) => {
    SD.parse(clean, (tree) => { try { drawer.draw(tree, svg, 'light', null); resolve(true); } catch (e) { reject(e); } }, reject);
  });
  const g = drawer.preprocessor && drawer.preprocessor.graph;
  if (!g || g.vertices.length !== base.atoms.length) return null;
  // Länge einer Bindung → 2,6 Rastereinheiten (etwas mehr als in der geraden
  // Kette, damit die H-Atome benachbarter Ringatome nicht aneinanderstoßen)
  const lens = g.edges.map(e => { const a = g.vertices[e.sourceId].position, b = g.vertices[e.targetId].position; return Math.hypot(a.x - b.x, a.y - b.y); }).filter(Boolean);
  const f = lens.length ? 2.6 / (lens.reduce((x, y) => x + y, 0) / lens.length) : 1;
  const atoms = g.vertices.map((v, i) => ({ el: base.atoms[i].el, charge: base.atoms[i].charge || 0, x: v.position.x * f, y: v.position.y * f }));
  const order = { '-': 1, '=': 2, '#': 3 };
  const kek = new Map(base.bonds.map(bd => [Math.min(bd.a, bd.b) + '-' + Math.max(bd.a, bd.b), bd.order]));
  const bonds = g.edges.map(e => {
    const o = kek.get(Math.min(e.sourceId, e.targetId) + '-' + Math.max(e.sourceId, e.targetId));
    return { a: e.sourceId, b: e.targetId, order: o === 2 || o === 3 ? o : order[e.bondType] === 3 ? 3 : o === 1 ? 1 : (order[e.bondType] || 1) };
  });
  // Ringmitten – H-Atome und Elektronenpaare gehören nie ins Ringinnere
  const rings = (drawer.preprocessor.rings || []).map(r => {
    const m = r.members || [];
    return { members: new Set(m), x: m.reduce((a, i) => a + atoms[i].x, 0) / (m.length || 1), y: m.reduce((a, i) => a + atoms[i].y, 0) / (m.length || 1) };
  });
  const towardRing = (i, ang) => rings.some(r => r.members.has(i) && Math.cos(Math.atan2(r.y - atoms[i].y, r.x - atoms[i].x) - ang) > 0.5);
  const dirs = atoms.map(() => []);
  for (const bd of bonds) {
    const A = atoms[bd.a], B = atoms[bd.b];
    dirs[bd.a].push(Math.atan2(B.y - A.y, B.x - A.x));
    dirs[bd.b].push(Math.atan2(A.y - B.y, A.x - B.x));
  }
  // n Dinge (H-Atome, Elektronenpaare) gleichmäßig in die größte freie Lücke
  // um Atom i verteilen – bei Ringatomen also nach außen, nie in den Ring
  const spread = (i, n) => {
    const used = dirs[i].slice().sort((a, b) => a - b);
    if (!used.length) return Array.from({ length: n }, (_, k) => -Math.PI / 2 + (k * 2 * Math.PI) / n);
    // Fast gleich große Lücken: die mit dem meisten Platz drumherum (nicht in den Ring)
    let best = 0, size = -1, bestScore = -Infinity;
    for (let k = 0; k < used.length; k++) {
      const from = used[k], to = k + 1 < used.length ? used[k + 1] : used[0] + 2 * Math.PI;
      const mid = (from + to) / 2;
      const x = atoms[i].x + Math.cos(mid) * 1.5, y = atoms[i].y + Math.sin(mid) * 1.5;
      let near = Infinity;
      for (let j = 0; j < atoms.length; j++) if (j !== i) near = Math.min(near, Math.hypot(atoms[j].x - x, atoms[j].y - y));
      const score = (to - from) + 0.8 * Math.min(near, 2.5) - (towardRing(i, mid) ? 10 : 0);
      if (score > bestScore) { bestScore = score; size = to - from; best = from; }
    }
    return Array.from({ length: n }, (_, k) => best + (size * (k + 1)) / (n + 1));
  };
  const heavy = atoms.length;
  for (let i = 0; i < heavy; i++) {
    const n = base.atoms[i].hCount || 0;
    for (const a of spread(i, n)) {
      dirs[i].push(a);
      atoms.push({ el: 'H', charge: 0, x: atoms[i].x + Math.cos(a) * 1.5, y: atoms[i].y + Math.sin(a) * 1.5 });
      bonds.push({ a: i, b: atoms.length - 1, order: 1 });
    }
  }
  const lonePairs = [];
  for (let i = 0; i < heavy; i++) {
    const at = atoms[i];
    let lp = LONE_PAIR_COUNT[at.el] || 0;
    if (at.el === 'N' && at.charge > 0) lp = 0;
    if (at.el === 'O') lp = 2 + (at.charge < 0 ? 1 : 0) - (at.charge > 0 ? 1 : 0);
    for (const a of spread(i, lp)) lonePairs.push({ atom: i, angle: a });
  }
  return { atoms, bonds, lonePairs };
}

// Freie Elektronenpaare als Striche neben die Atome (Positionen aus SmilesDrawer)
function addLonePairs(drawer, svg, dark) {
  const g = drawer.preprocessor && drawer.preprocessor.graph;
  if (!g) return;
  const NS = 'http://www.w3.org/2000/svg';
  const grp = document.createElementNS(NS, 'g');
  grp.setAttribute('stroke', dark ? '#ddd' : '#222');
  grp.setAttribute('stroke-width', '1.2');
  grp.setAttribute('stroke-linecap', 'round');
  for (const v of g.vertices) {
    const el = v.value.element;
    let lp = LONE_PAIR_COUNT[el] || 0;
    const charge = v.value.charge || 0;
    if (el === 'N' && charge > 0) lp = 0;
    if (el === 'O') lp = 2 + (charge < 0 ? 1 : 0) - (charge > 0 ? 1 : 0);
    if (!lp) continue;
    const p = v.position;
    const angles = v.neighbours.map(nid => { const q = g.vertices[nid].position; return Math.atan2(q.y - p.y, q.x - p.x); }).sort((a, b) => a - b);
    // Elektronenpaare gleichmäßig in die größte Lücke zwischen den Bindungen legen
    let from = -Math.PI / 2, gap = 2 * Math.PI;
    if (angles.length) {
      gap = -1;
      for (let i = 0; i < angles.length; i++) {
        const a1 = angles[i], a2 = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
        if (a2 - a1 > gap) { gap = a2 - a1; from = a1; }
      }
    }
    const picks = [];
    for (let k = 1; k <= lp; k++) picks.push(from + gap * k / (lp + 1));
    for (const a of picks) {
      const cx = p.x + Math.cos(a) * 12, cy = p.y + Math.sin(a) * 12;
      const dx = -Math.sin(a) * 4.5, dy = Math.cos(a) * 4.5;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', cx - dx); line.setAttribute('y1', cy - dy);
      line.setAttribute('x2', cx + dx); line.setAttribute('y2', cy + dy);
      grp.append(line);
    }
  }
  svg.append(grp);
}

const ELEMENT_COLORS = { O: '#d6453d', N: '#3a6fd8', S: '#c7a000', F: '#2f9e5b', Cl: '#2f9e5b', Br: '#9a4b2b', I: '#7b3fa0', P: '#e07b00' };

// Valenzstrichformel im Heft-Stil: gerade Kette, H oben/unten, Elektronenpaare als Striche
export function drawGridSVG(layout, { unit = 17, dark = false } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const xs = layout.atoms.map(a => a.x), ys = layout.atoms.map(a => a.y);
  const pad = 1.4;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const W = (maxX - minX) * unit, H = (maxY - minY) * unit;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'smiles-svg grid-formula');
  svg.setAttribute('width', Math.round(W));
  svg.setAttribute('height', Math.round(H));
  svg.setAttribute('viewBox', `0 0 ${W.toFixed(1)} ${H.toFixed(1)}`);
  const X = (x) => (x - minX) * unit, Y = (y) => (y - minY) * unit;
  const fg = dark ? '#e6e6e6' : '#1d1d1f';
  const color = (el) => ELEMENT_COLORS[el] || fg;
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  // Alles wächst mit der Größe (S/M/L) – vorher waren Abstand, Schrift und
  // Elektronenpaare fest, bei „S“ blieben von den Bindungen nur Stummel übrig
  const k = unit / 17;
  const font = 14.5 * k;
  const gap = font * 0.45;
  const stroke = Math.max(1, 1.3 * k);
  for (const b of layout.bonds) {
    const A = layout.atoms[b.a], B = layout.atoms[b.b];
    let x1 = X(A.x), y1 = Y(A.y), x2 = X(B.x), y2 = Y(B.y);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    x1 += ux * gap; y1 += uy * gap; x2 -= ux * gap; y2 -= uy * gap;
    const nx = -uy, ny = ux;
    const o2 = Math.max(1.8, 2.2 * k), o3 = Math.max(2.8, 3.4 * k);
    const offs = b.order === 2 ? [-o2, o2] : b.order === 3 ? [-o3, 0, o3] : [0];
    for (const o of offs) svg.append(mk('line', { x1: x1 + nx * o, y1: y1 + ny * o, x2: x2 + nx * o, y2: y2 + ny * o, stroke: fg, 'stroke-width': stroke, 'stroke-linecap': 'round' }));
  }
  for (const lp of layout.lonePairs) {
    const a = layout.atoms[lp.atom];
    const cx = X(a.x), cy = Y(a.y);
    const d = lp.angle !== undefined ? [Math.cos(lp.angle), Math.sin(lp.angle)] : { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] }[lp.dir];
    const px = cx + d[0] * 9.5 * k, py = cy + d[1] * 10.5 * k;
    // Strich quer zur Richtung des Elektronenpaars
    const tx = -d[1] * 4 * k, ty = d[0] * 4 * k;
    svg.append(mk('line', { x1: px - tx, y1: py - ty, x2: px + tx, y2: py + ty, stroke: fg, 'stroke-width': stroke, 'stroke-linecap': 'round' }));
  }
  for (const a of layout.atoms) {
    const t = mk('text', { x: X(a.x), y: Y(a.y) + font * 0.345, 'text-anchor': 'middle', 'font-size': font.toFixed(1), 'font-family': '-apple-system, "Helvetica Neue", Arial, sans-serif', fill: color(a.el) });
    t.textContent = a.el;
    svg.append(t);
    if (a.charge) {
      const c = mk('text', { x: X(a.x) + 9 * k, y: Y(a.y) - 5 * k, 'font-size': (10 * k).toFixed(1), fill: fg });
      c.textContent = (Math.abs(a.charge) > 1 ? Math.abs(a.charge) : '') + (a.charge > 0 ? '+' : '−');
      svg.append(c);
    }
  }
  return svg;
}

export function moleculeInfo(smiles) {
  const g = parseSmiles(smiles);
  const { counts, charge } = elementCounts(g);
  return {
    formula: hillFormula(counts, charge),
    mass: molarMass(counts),
    groups: functionalGroups(g),
    klass: substanceClass(g),
    acyclic: isAcyclic(g)
  };
}

const isDark = () => document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches && !document.body.classList.contains('print-mode'));

// Größe S / M / L (in der Datei als w=240 / – / w=520 gespeichert)
const SIZES = { 240: 0.72, 520: 1.4 };

const MODES = [['skelett', 'Skelettformel'], ['halb', 'Halbstrukturformel'], ['valenz', 'Valenzstrichformel']];

export const smiles = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    const wrap = h('div', { class: 'smiles-wrap atom-view' });
    main.append(h('div', { class: 'atom' }, wrap));
    paint(ed, b, wrap);
    if (!ed.readonly) {
      wrap.addEventListener('mousedown', (e) => {
        if (e.target.closest('.media-bar, .caption')) return;
        if (!main.closest('.blk').classList.contains('editing')) { e.preventDefault(); ed.activate(b); }
      });
    }
    b._repaint = () => paint(ed, b, wrap);
  },
  activate(ed, b, main) {
    const atom = main.querySelector('.atom');
    const name = h('input', { class: 'input', value: b.name || '', placeholder: 'Name, z. B. 2-Methylpropan, Butan-2-ol, Essigsäure, Glucose …', spellcheck: 'false' });
    const sm = h('input', { class: 'input mono', value: b.smiles || '', placeholder: 'oder SMILES, z. B. CCO', spellcheck: 'false' });
    const status = h('div', { class: 'hint' });
    const searchBtn = h('button', { class: 'btn sm outline', 'data-tip': 'Auch englische und sehr spezielle Namen über PubChem suchen (Internet)' }, icon('search', 'sm'), 'Online suchen');
    const apply = (s, n, source) => {
      sm.value = s;
      b.smiles = s;
      b.name = n;
      const nice = n.charAt(0).toUpperCase() + n.slice(1);
      if (!b.caption || b._autoCaption) {
        b.caption = nice;
        b._autoCaption = true;
        main.querySelector('.smiles-wrap .caption')?.remove();
      }
      status.textContent = source === 'Name' ? 'Aus dem Namen erzeugt.' : source === 'Wörterbuch' ? 'Aus dem eingebauten Wörterbuch.' : source || '';
      b._repaint();
      ed.changed({ soft: true });
    };
    const tryLocal = () => {
      const q = name.value.trim();
      if (!q) return false;
      const r = resolveName(q);
      if (r.smiles) { apply(r.smiles, q, r.source); return true; }
      status.textContent = r.error ? `${r.error} – mit Enter online suchen oder SMILES eingeben.` : '';
      return false;
    };
    const doLookup = async () => {
      const q = name.value.trim();
      if (!q) return;
      if (tryLocal()) return;
      status.textContent = 'Suche bei PubChem …';
      try {
        const res = await ed.host.chemLookup(q);
        if (res && res.smiles) apply(res.smiles, q, res.formula ? `Online gefunden (${res.formula}).` : 'Online gefunden.');
        else status.textContent = 'Nichts gefunden – prüfe die Schreibweise oder gib SMILES direkt ein.';
      } catch { status.textContent = 'Keine Verbindung – gib SMILES direkt ein.'; }
    };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
      if (e.key === 'Escape') { e.preventDefault(); ed.deactivate({ select: true }); }
    });
    name.addEventListener('input', () => { clearTimeout(b._nameT); b._nameT = setTimeout(tryLocal, 250); });
    searchBtn.addEventListener('click', doLookup);
    // Schreibfeld für den Pencil: geschriebener Name (oder SMILES) wie eingetippt
    atom._hw = (text) => {
      if (/^[A-Za-z0-9@+\-\[\]\(\)=#\/\\%.]+$/.test(text) && !/[a-z]{3}/.test(text)) {
        sm.value = text;
        sm.dispatchEvent(new Event('input'));
        return;
      }
      name.value = text;
      doLookup();
    };
    sm.addEventListener('input', () => { b.smiles = sm.value.trim(); b._repaint(); ed.changed({ soft: true }); });
    sm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ed.exitAtom(b, 'after'); }
      if (e.key === 'Escape') { e.preventDefault(); ed.deactivate({ select: true }); }
    });
    const modeSeg = h('div', { class: 'segmented' });
    for (const [k, l] of MODES) {
      const bt = h('button', { class: (b.mode || 'skelett') === k ? 'on' : '' }, l);
      bt.addEventListener('click', () => { b.mode = k === 'skelett' ? undefined : k; modeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === bt)); b._repaint(); ed.changed({ soft: true }); });
      modeSeg.append(bt);
    }
    const info = h('input', { type: 'checkbox' });
    info.checked = !!b.info;
    info.addEventListener('change', () => { b.info = info.checked || undefined; b._repaint(); ed.changed({ soft: true }); });
    const size = h('div', { class: 'segmented' });
    for (const [k, l] of [[240, 'S'], [0, 'M'], [520, 'L']]) {
      const bt = h('button', { class: (b.width || 0) === k ? 'on' : '' }, l);
      bt.addEventListener('click', () => { b.width = k || undefined; size.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === bt)); b._repaint(); ed.changed({ soft: true }); });
      size.append(bt);
    }
    atom.append(h('div', { class: 'atom-panel' },
      h('div', { class: 'panel-row' }, name, searchBtn),
      h('div', { class: 'panel-row' }, sm),
      h('div', { class: 'panel-row', style: { flexWrap: 'wrap' } }, modeSeg, h('span', { class: 'grow' }), size),
      h('div', { class: 'panel-row' }, h('label', { class: 'chk' }, info, 'Summenformel, molare Masse und funktionelle Gruppen anzeigen')),
      status));
    requestAnimationFrame(() => (b.smiles ? sm : name).focus());
  }
};

async function paint(ed, b, wrap) {
  const cap = wrap.querySelector('.caption');
  wrap.innerHTML = '';
  if (!b.smiles) {
    wrap.append(h('div', { class: 'atom-placeholder' }, h('span', { html: icon('molecule') }), 'Strukturformel – deutschen Namen (z. B. Butan-2-ol) oder SMILES eingeben'));
    return;
  }
  const mode = b.mode || 'skelett';
  const dark = isDark();
  const factor = SIZES[b.width] || 1;
  let drawn = false;
  let note = '';
  try {
    if (mode === 'halb') {
      const cf = condensedFormula(b.smiles);
      if (cf) {
        const r = renderToString(`\\ce{${cf}}`, { display: true, mode: 'latex' });
        wrap.append(h('div', { class: 'math-view condensed', html: r.html || esc(cf) }));
        drawn = true;
      } else note = 'Halbstrukturformel gibt es nur für Moleküle ohne Ring – hier die Skelettformel.';
    }
    if (!drawn && mode === 'valenz') {
      const L = gridLayout(b.smiles) || await ringLayout(b.smiles).catch(() => null);
      if (L) {
        const svg = drawGridSVG(L, { dark, unit: 17 * factor });
        wrap.append(svg);
        drawn = true;
      }
    }
    if (!drawn) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'smiles-svg');
      wrap.append(svg);
      await drawSmiles(b.smiles, svg, { scale: factor, dark, explicit: mode === 'valenz' });
    }
  } catch (e) {
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'math-error', text: 'Ungültige Strukturangabe: ' + b.smiles }));
  }
  if (note && !ed.readonly) wrap.append(h('div', { class: 'mol-groups', text: note }));
  if (b.info) {
    try {
      const inf = moleculeInfo(b.smiles);
      const f = renderToString(`\\ce{${inf.formula}}`, { display: false, mode: 'latex' });
      const mass = Number.isFinite(inf.mass) ? inf.mass.toFixed(2).replace('.', ',') + ' g/mol' : '';
      const line = h('div', { class: 'mol-info' });
      line.innerHTML = `<span>${f.html || esc(inf.formula)}</span>` + (mass ? `<span>M = ${mass}</span>` : '') + (inf.klass ? `<span>${esc(inf.klass)}</span>` : '');
      wrap.append(line);
      if (inf.groups.length) wrap.append(h('div', { class: 'mol-groups', text: inf.groups.join(' · ') }));
    } catch { /* nichts anzeigen */ }
  }
  if (!ed.readonly) wrap.append(mediaBar(ed, b, [{ icon: 'more', tip: 'Mehr', onClick: (btn) => ed.openBlockMenu(b, btn) }]));
  if (b.caption !== undefined && b.caption !== '' || b._cap) wrap.append(cap || captionEl(ed, b, 'Beschriftung …', 'fig'));
  // Die Formel wird erst nach dem Laden gezeichnet – „Abbildung 1“ jetzt nachtragen
  ed.renumberCaptions && ed.renumberCaptions();
  ed.notifyLayout && ed.notifyLayout();
}
