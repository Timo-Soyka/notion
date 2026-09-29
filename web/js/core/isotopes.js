// Isotope und Kernreaktionen.
//
//  • Periodensystem (Ordnungszahlen)
//  • Nuklid-Schreibweise in Formeln: {}^{14}_{6}C wird wie im Chemiebuch
//    gesetzt – Massen- und Ordnungszahl rechtsbündig vor dem aufrechten Symbol
//  • Kernreaktionen prüfen: Summe der Massenzahlen und der Ordnungszahlen
//    links = rechts, und passt die Ordnungszahl zum Element?
//
// Ohne Abhängigkeiten, damit es in Node getestet werden kann.

const SYMBOLS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu ' +
  'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr ' +
  'Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');

export const ATOMIC_NUMBER = Object.fromEntries(SYMBOLS.map((s, i) => [s, i + 1]));

// Teilchen in Kernreaktionen: [Massenzahl, Ordnungszahl]
const PARTICLES = { n: [1, 0], p: [1, 1], d: [2, 1], t: [3, 1], '\\alpha': [4, 2], 'α': [4, 2], '\\gamma': [0, 0], 'γ': [0, 0], '\\nu': [0, 0], 'ν': [0, 0] };

// ---------------------------------------------------------------------------
// Formeln: Vorgestellte Hoch-/Tiefzahlen ausrichten
// ---------------------------------------------------------------------------

// Ein Skript-Argument lesen: {…} (ausgeglichen), \befehl oder ein Zeichen
function readArg(s, i) {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === '{') depth++;
      else if (s[k] === '}' && --depth === 0) return { text: s.slice(i + 1, k), end: k + 1 };
    }
    return null;
  }
  const m = /^\\[a-zA-Z]+|^./.exec(s.slice(i));
  return m ? { text: m[0], end: i + m[0].length } : null;
}

const plain = (t) => /^[-−+]?[0-9A-Za-z]*$/.test(t);
const numeric = (t) => /^[-−+]?\d+$/.test(t);

// Links mit unsichtbaren Zeichen auffüllen, damit beide Zahlen rechtsbündig stehen
function padTo(short, long) {
  const diff = long.length - short.length;
  return diff > 0 ? `\\hphantom{${long.slice(0, diff)}}${short}` : short;
}

// {}^{A}_{Z}X (in beliebiger Reihenfolge, wie MathLive sie schreibt) →
// rechtsbündige Zahlen; bei Zahlen (also einem Nuklid) Symbol aufrecht
export function alignPrescripts(tex) {
  const s = String(tex || '');
  if (!s.includes('{}')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('{}', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    i = at + 2;
    // Nur ein leerer Sockel – kein Argument eines Befehls ({}{} bei \frac, x^{})
    const before = s.slice(0, at).replace(/\s+$/, '');
    if (/[}\]^_]$/.test(before) || /\\[a-zA-Z]+$/.test(before) && !/\\(quad|qquad|,|;|:|!|to|rightarrow|longrightarrow|leftrightarrow|rightleftharpoons|Rightarrow|pm|cdot|times)$/.test(before)) {
      out += '{}';
      continue;
    }
    let sup = null, sub = null, k = i;
    for (let n = 0; n < 2; n++) {
      let j = k;
      while (s[j] === ' ') j++;
      const c = s[j];
      if ((c === '^' && sup === null) || (c === '_' && sub === null)) {
        const a = readArg(s, j + 1);
        if (!a) break;
        if (c === '^') sup = a.text; else sub = a.text;
        k = a.end;
      } else break;
    }
    if (sup === null || sub === null || !plain(sup) || !plain(sub)) { out += '{}'; continue; }
    const w = Math.max(sup.length, sub.length);
    const A = sup.length < w ? padTo(sup, sub) : sup;
    const Z = sub.length < w ? padTo(sub, sup) : sub;
    out += `{}^{${A}}_{${Z}}`;
    i = k;
    // Nuklid: das folgende Element- oder Teilchensymbol aufrecht setzen
    if (numeric(sup) && numeric(sub)) {
      const rest = s.slice(i);
      const m = /^(\s*)([A-Z][a-z]?|[a-z])(?![a-zA-Z])/.exec(rest);
      if (m) { out += `${m[1]}\\mathrm{${m[2]}}`; i += m[0].length; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kernreaktionen (Schreibweise der Reaktionsgleichung, mhchem)
// ---------------------------------------------------------------------------

const ARROW = /\s*(->\[[^\]]*\](?:\[[^\]]*\])?|<=>|<->|->|→|⇌)\s*/;
const ISO = /\^\{?\s*([-−+]?\d+)\s*\}?\s*_\{?\s*([-−+]?\d+)\s*\}?|_\{?\s*([-−+]?\d+)\s*\}?\s*\^\{?\s*([-−+]?\d+)\s*\}?/;

export const hasNuclide = (src) => ISO.test(String(src || ''));

const toInt = (v) => parseInt(String(v).replace('−', '-'), 10);

// Ein Teilchen: "3 ^{1}_{0}n", "^{4}_{2}He^{2+}", "e^-", "\gamma"
function nuclide(tok) {
  let t = tok.trim();
  let k = 1;
  const cm = /^(\d+)\s*(?=[\^_\\A-Za-zαγν])/.exec(t);
  if (cm) { k = parseInt(cm[1], 10); t = t.slice(cm[0].length); }
  const m = new RegExp('^\\s*(?:' + ISO.source + ')\\s*').exec(t);
  if (m) {
    const A = toInt(m[1] ?? m[4]), Z = toInt(m[2] ?? m[3]);
    const sym = t.slice(m[0].length).replace(/\^\{?[0-9]*[+-]\}?$|\^[+-]$/, '').replace(/[{}]/g, '').trim();
    return { k, A, Z, sym };
  }
  const bare = t.replace(/[{}]/g, '').trim();
  if (/^e\^?-$|^e\^\{-\}$|^\\beta\^?-$|^β-$/.test(bare)) return { k, A: 0, Z: -1, sym: 'e' };
  if (/^e\^?\+$|^e\^\{\+\}$|^\\beta\^?\+$|^β\+$/.test(bare)) return { k, A: 0, Z: 1, sym: 'e' };
  if (/^\\bar\s*\\nu$|^\\overline\s*\\nu$/.test(bare)) return { k, A: 0, Z: 0, sym: '\\nu' };
  if (PARTICLES[bare]) return { k, A: PARTICLES[bare][0], Z: PARTICLES[bare][1], sym: bare };
  return null;
}

// → null (keine Kernreaktion bzw. nicht lesbar) oder
//   { balanced, mass: [links, rechts], charge: [links, rechts], wrong: [{ sym, Z, expected }] }
export function checkNuclear(src) {
  const text = String(src || '');
  if (!hasNuclide(text)) return null;
  const am = ARROW.exec(text);
  if (!am) return null;
  const side = (s) => s.split(/\s+\+\s+/).map(x => x.trim()).filter(Boolean).map(nuclide);
  const left = side(text.slice(0, am.index)), right = side(text.slice(am.index + am[0].length));
  if (!left.length || !right.length || [...left, ...right].some(x => !x)) return null;
  const sum = (list, key) => list.reduce((a, x) => a + x.k * x[key], 0);
  const mass = [sum(left, 'A'), sum(right, 'A')];
  const charge = [sum(left, 'Z'), sum(right, 'Z')];
  const wrong = [];
  for (const x of [...left, ...right]) {
    const expected = ATOMIC_NUMBER[x.sym];
    if (expected && x.Z !== expected && !wrong.some(w => w.sym === x.sym && w.Z === x.Z)) wrong.push({ sym: x.sym, Z: x.Z, expected });
  }
  return { balanced: mass[0] === mass[1] && charge[0] === charge[1], mass, charge, wrong };
}
