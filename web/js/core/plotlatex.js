// Funktionszeilen im Graphen: Formelfeld (LaTeX) ↔ Rechenausdruck.
//
// Im Graphen tippt man in dasselbe Formelfeld wie bei Formeln – "integral"
// gibt ∫ mit Kästchen für die Grenzen, "wurzel" eine Wurzel, "/" einen Bruch.
// Gerechnet wird aber mit der einfachen Schreibweise aus mathexpr.js
// ("∫_(0)^(2) f(x) dx", "sqrt(x)", "((1)/(2))x^(2)"). Diese Datei übersetzt
// in beide Richtungen.

import { splitDefinition, splitCondition, parseExpr, toTex, conditionTex } from './mathexpr.js';

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', lambda: 'λ', mu: 'μ', omega: 'ω', varphi: 'φ', phi: 'φ',
  theta: 'θ', sigma: 'σ', tau: 'τ', rho: 'ρ', nu: 'ν', kappa: 'κ', eta: 'η', zeta: 'ζ', xi: 'ξ', psi: 'ψ', chi: 'χ'
};
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'ln', 'log', 'lg', 'exp', 'min', 'max', 'sgn']);
const SIMPLE = {
  cdot: '*', times: '*', ast: '*', div: '/', pi: 'π', infty: '∞', exponentialE: 'e', differentialD: 'd', imaginaryI: 'i',
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥', lt: '<', gt: '>', ne: '≠', neq: '≠',
  in: '∈', cup: '∪', lor: ' oder ', vee: ' oder ', land: ' und ', wedge: ' und ', mid: '|', vert: '|', lvert: '|', rvert: '|',
  lbrack: '[', rbrack: ']', lbrace: '{', rbrace: '}', langle: '(', rangle: ')', int: '∫', infinity: '∞', to: '→',
  quad: ' ', qquad: ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%'
};

function tokenize(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      out.push({ cmd: m[1] });
      i += m[0].length;
      continue;
    }
    out.push({ ch: c });
    i++;
  }
  return out;
}

// LaTeX aus dem Formelfeld → Rechenausdruck
export function latexToExpr(tex) {
  const toks = tokenize(String(tex || ''));
  let i = 0;
  const peek = () => toks[i];
  // Ein Argument: {…} oder ein einzelnes Zeichen/Befehl
  const arg = () => {
    while (peek() && peek().ch === ' ') i++;
    const t = toks[i++];
    if (!t) return '';
    if (t.ch === '{') return seq('}');
    return one(t);
  };
  // Optionales [n] bei \sqrt
  const optArg = () => {
    if (!peek() || peek().ch !== '[') return null;
    i++;
    return seq(']');
  };
  const one = (t) => {
    if (t.ch !== undefined) {
      if (t.ch === '{') return '(' + seq('}') + ')';
      if (t.ch === '~') return ' ';
      if (t.ch === '^' || t.ch === '_') return script(t.ch);
      return t.ch;
    }
    const c = t.cmd;
    switch (c) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': { const a = arg(), b = arg(); return `((${a})/(${b}))`; }
      case 'sqrt': { const n = optArg(); const a = arg(); return n ? `root(${n}, ${a})` : `sqrt(${a})`; }
      case 'left': case 'right': case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': case 'big': case 'Big': {
        const d = toks[i++];
        if (!d) return '';
        if (d.ch === '.') return '';
        return d.ch !== undefined ? d.ch : (SIMPLE[d.cmd] ?? '');
      }
      case 'text': case 'textrm': case 'mathrm': case 'operatorname': case 'mathit': case 'mathbf': case 'textit': case 'mbox': {
        const inner = arg();
        return c === 'text' || c === 'textrm' || c === 'mbox' ? ` ${inner.trim()} ` : inner;
      }
      case 'prime': return "'";
      case 'placeholder': arg(); return '';
      case 'heftmark': arg(); return '';
      case 'displaystyle': case 'textstyle': case 'limits': case 'nolimits': return '';
    }
    if (FUNCS.has(c)) return ` ${c} `;
    if (c in SIMPLE) return SIMPLE[c];
    if (GREEK[c]) return GREEK[c];
    return c;
  };
  // Hoch-/Tiefzahl: ^{\prime} → ', sonst ^(…)
  const script = (kind) => {
    while (peek() && peek().ch === ' ') i++;
    const t = peek();
    if (kind === '^' && t && (t.cmd === 'prime' || (t.ch === '{' && toks[i + 1] && toks[i + 1].cmd === 'prime'))) {
      let primes = '';
      if (t.cmd === 'prime') { i++; return "'"; }
      i++;
      while (peek() && peek().cmd === 'prime') { primes += "'"; i++; }
      if (peek() && peek().ch === '}') i++;
      return primes;
    }
    const a = arg();
    // Einzelnes Zeichen ohne Klammer: x^2 statt x^(2)
    return /^[\w.,π∞']$/.test(a) ? `${kind}${a}` : `${kind}(${a})`;
  };
  const seq = (end) => {
    let out = '';
    while (i < toks.length) {
      const t = toks[i];
      if (end && t.ch === end) { i++; break; }
      i++;
      // {,} ist das Dezimalkomma
      if (t.ch === '{' && toks[i] && toks[i].ch === ',' && toks[i + 1] && toks[i + 1].ch === '}') { i += 2; out += ','; continue; }
      out += one(t);
    }
    return out;
  };
  let s = seq(null);
  // "für" im Formelfeld steht als Buchstabenfolge da: x^2fürx<3
  s = s.replace(/\s*(für|fuer)\s*/gi, ' für ').replace(/\s*(oder)\s*(?=[x(\d-])/g, ' oder ');
  // Leere Klammern von Platzhaltern und doppelte Leerzeichen aufräumen
  return s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

// Rechenausdruck (ältere Graphen, Vorlagen) → LaTeX für das Formelfeld
export function exprToLatex(expr) {
  const src = String(expr || '').trim();
  if (!src) return '';
  // Namen, die wie Funktionen benutzt werden (f(…), f'(…)), als Funktionen lesen
  const known = {};
  for (const m of src.matchAll(/(?<!\p{L})(\p{L})'*\s*\(/gu)) if (m[1] !== 'x') known[m[1]] = true;
  const tex = (s) => toTex(parseExpr(s, known));
  try {
    const d = splitDefinition(src);
    const head = d.param ? `${d.name}=` : d.vertical ? 'x=' : d.name ? (d.area ? `${d.name}=` : `${d.name}(x)=`) : /^y\s*=/.test(src) ? 'y=' : '';
    if (d.param) return head + tex(d.body);
    const v = d.vertical ? 'y' : 'x';
    const sc = splitCondition(d.body, v);
    let out = head + tex(sc.body);
    if (sc.cond) out += `\\text{ für }${conditionTex(sc.cond, {}, v)}`;
    return out.replace(/\\left\(/g, '(').replace(/\\right\)/g, ')');
  } catch {
    // Nicht lesbar: so übernehmen, wie es ist (das Feld zeigt dann den Fehler)
    return src.replace(/([{}\\])/g, '\\$1');
  }
}
