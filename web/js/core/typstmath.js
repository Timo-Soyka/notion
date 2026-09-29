// Typst-Mathe → LaTeX.
//
// Timo schreibt seine Hefteinträge bisher in Typst. Damit er nicht auf LaTeX
// umlernen muss, versteht der Editor die Typst-Schreibweise (root(2, x), a/b,
// "Text", & und \ für Umformungen) und übersetzt sie für KaTeX. LaTeX-Eingaben
// (erkennbar an \befehl) werden unverändert durchgereicht.

const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
  'pi', 'rho', 'sigma', 'tau', 'upsilon', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'];

const SYMBOLS = {
  epsilon: '\\varepsilon', 'epsilon.alt': '\\epsilon', phi: '\\varphi', 'phi.alt': '\\phi', 'theta.alt': '\\vartheta',
  'pi.alt': '\\varpi', 'rho.alt': '\\varrho', 'sigma.alt': '\\varsigma', 'kappa.alt': '\\varkappa',
  Alpha: 'A', Beta: 'B', Epsilon: 'E', Zeta: 'Z', Eta: 'H', Iota: 'I', Kappa: 'K', Mu: 'M', Nu: 'N', Omicron: 'O', omicron: 'o', Rho: 'P', Tau: 'T', Chi: 'X',
  dot: '\\cdot', 'dot.op': '\\cdot', 'dot.c': '\\cdot', times: '\\times', 'times.big': '\\bigotimes', div: '\\div',
  'plus.minus': '\\pm', pm: '\\pm', 'minus.plus': '\\mp', mp: '\\mp', ast: '\\ast', star: '\\star', circle: '\\circ', compose: '\\circ',
  plus: '+', minus: '-', eq: '=', 'eq.not': '\\neq', neq: '\\neq', 'lt.eq': '\\le', 'gt.eq': '\\ge', leq: '\\le', geq: '\\ge', lt: '<', gt: '>',
  approx: '\\approx', equiv: '\\equiv', prop: '\\propto', sim: '\\sim', 'tilde.op': '\\sim', 'eq.def': '\\coloneqq', 'colon.eq': '\\coloneqq',
  'lt.double': '\\ll', 'gt.double': '\\gg',
  infinity: '\\infty', oo: '\\infty', partial: '\\partial', nabla: '\\nabla', degree: '^{\\circ}', angle: '\\angle',
  triangle: '\\triangle', perp: '\\perp', parallel: '\\parallel', 'parallel.not': '\\nparallel',
  dots: '\\ldots', 'dots.h': '\\ldots', 'dots.c': '\\cdots', 'dots.v': '\\vdots', 'dots.down': '\\ddots', prime: "'",
  in: '\\in', 'in.not': '\\notin', 'in.rev': '\\ni', subset: '\\subset', 'subset.eq': '\\subseteq', supset: '\\supset', 'supset.eq': '\\supseteq',
  union: '\\cup', sect: '\\cap', 'union.big': '\\bigcup', 'sect.big': '\\bigcap', without: '\\setminus', emptyset: '\\emptyset', nothing: '\\emptyset',
  NN: '\\mathbb{N}', ZZ: '\\mathbb{Z}', QQ: '\\mathbb{Q}', RR: '\\mathbb{R}', CC: '\\mathbb{C}', PP: '\\mathbb{P}',
  forall: '\\forall', exists: '\\exists', 'exists.not': '\\nexists', not: '\\neg', and: '\\land', or: '\\lor', top: '\\top', bot: '\\bot',
  sum: '\\sum', product: '\\prod', prod: '\\prod', coproduct: '\\coprod', integral: '\\int', 'integral.double': '\\iint', 'integral.triple': '\\iiint', 'integral.cont': '\\oint',
  quad: '\\quad', wide: '\\qquad', thin: '\\,', med: '\\:', thick: '\\;', space: '~',
  arrow: '\\rightarrow', 'arrow.r': '\\rightarrow', 'arrow.l': '\\leftarrow', 'arrow.t': '\\uparrow', 'arrow.b': '\\downarrow',
  'arrow.l.r': '\\leftrightarrow', 'arrow.r.double': '\\Rightarrow', 'arrow.l.double': '\\Leftarrow', 'arrow.l.r.double': '\\Leftrightarrow',
  'arrow.r.long': '\\longrightarrow', 'arrow.r.bar': '\\mapsto', 'arrows.rl': '\\rightleftharpoons', 'harpoons.rtlb': '\\rightleftharpoons',
  'arrow.t.b': '\\updownarrow', 'arrow.r.squiggly': '\\leadsto',
  ell: '\\ell', planck: 'h', 'planck.reduce': '\\hbar', hbar: '\\hbar', aleph: '\\aleph', Re: '\\Re', Im: '\\Im',
  percent: '\\%', permille: '\\text{‰}', euro: '\\text{€}', dollar: '\\$', hash: '\\#', 'bar.v': '|', 'bar.v.double': '\\|',
  'angle.l': '\\langle', 'angle.r': '\\rangle', 'bracket.l': '[', 'bracket.r': ']', 'brace.l': '\\{', 'brace.r': '\\}', 'paren.l': '(', 'paren.r': ')',
  checkmark: '\\checkmark', 'dagger': '\\dagger', diamond: '\\diamond', square: '\\square', bullet: '\\bullet', 'qed': '\\blacksquare'
};
for (const g of GREEK) if (!SYMBOLS[g]) SYMBOLS[g] = '\\' + g;

// Aufrecht gesetzte Funktionen/Operatoren
const OPERATORS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth',
  'ln', 'log', 'exp', 'det', 'dim', 'gcd', 'ker', 'deg', 'arg', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'Pr', 'hom', 'mod']);
const EXTRA_OPERATORS = { lg: 'lg', ggT: 'ggT', kgV: 'kgV', sgn: 'sgn', tr: 'tr', id: 'id', rank: 'rank', diff: 'd' };

const MULTI = ['<==>', '<=>', '==>', '<==', '-->', '<--', '<->', '|->', '...', '->', '<-', '=>', '<=', '>=', '!=', '<<', '>>', ':=', '+-', '-+', '=:', '~~', '|=', '||'];
const MULTI_MAP = {
  '<==>': '\\Longleftrightarrow', '<=>': '\\Leftrightarrow', '==>': '\\Longrightarrow', '<==': '\\Longleftarrow',
  '-->': '\\longrightarrow', '<--': '\\longleftarrow', '<->': '\\leftrightarrow', '|->': '\\mapsto', '...': '\\ldots',
  '->': '\\rightarrow', '<-': '\\leftarrow', '=>': '\\Rightarrow', '<=': '\\le', '>=': '\\ge', '!=': '\\neq',
  '<<': '\\ll', '>>': '\\gg', ':=': '\\coloneqq', '+-': '\\pm', '-+': '\\mp', '=:': '\\eqqcolon', '~~': '\\approx', '|=': '\\models', '||': '\\|'
};

export function isLatex(src) {
  // \befehl, oder geschweifte Klammern an Hoch-/Tiefzahlen (x^{12}, {}^{14}_{6}C) –
  // Typst schreibt dort runde Klammern, geschweifte sind in Typst Mengenklammern
  return /\\[a-zA-Z]|[\^_]\{|\{\}/.test(src);
}

// Wandelt, falls nötig, in LaTeX um. mode: 'auto' | 'typst' | 'latex'
export function toLatex(src, mode = 'auto') {
  src = String(src ?? '');
  if (mode === 'latex' || (mode === 'auto' && isLatex(src))) return src;
  try {
    return typstToLatex(src);
  } catch (e) {
    return src;
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function lex(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  let spaceBefore = false;
  const push = (t) => { t.sp = spaceBefore; spaceBefore = false; toks.push(t); };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      spaceBefore = true;
      i++;
      continue;
    }
    // Zeilenumbruch "\" (gefolgt von Leerraum oder Ende) bzw. maskiertes Zeichen
    if (c === '\\') {
      const d = src[i + 1];
      if (d === undefined || /\s/.test(d)) { push({ k: 'nl' }); i++; continue; }
      if (d === '\\') { push({ k: 'nl' }); i += 2; continue; }
      push({ k: 'sym', v: escapeLatexChar(d) });
      i += 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { s += src[j + 1]; j += 2; continue; }
        s += src[j];
        j++;
      }
      push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    // Code-Ausdrücke (#…) überspringen – z. B. #h(1cm)
    if (c === '#') {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      if (src[j] === '(') {
        let d = 0;
        for (; j < n; j++) { if (src[j] === '(') d++; else if (src[j] === ')') { d--; if (d === 0) { j++; break; } } }
      }
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if ((src[j] === '.' || src[j] === ',') && /[0-9]/.test(src[j + 1] || '')) {
        const sep = src[j];
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
        push({ k: 'num', v: src.slice(i, j), sep });
      } else push({ k: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[\p{L}]/u.test(c)) {
      let j = i;
      while (j < n && /[\p{L}]/u.test(src[j])) j++;
      // Punktnotation wie plus.minus, arrow.r.double
      while (src[j] === '.' && /[\p{L}]/u.test(src[j + 1] || '')) {
        let k = j + 1;
        while (k < n && /[\p{L}]/u.test(src[k])) k++;
        const cand = src.slice(i, k);
        if (SYMBOLS[cand] !== undefined || /^(arrow|arrows|dots|eq|lt|gt|in|subset|supset|plus|minus|times|dot|integral|union|sect|bar|angle|bracket|brace|paren|harpoons|colon|tilde|planck|exists|parallel|theta|phi|epsilon|pi|rho|sigma|kappa)$/.test(src.slice(i, j).split('.')[0])) j = k;
        else break;
      }
      push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    let multi = null;
    for (const m of MULTI) if (src.startsWith(m, i)) { multi = m; break; }
    if (multi) { push({ k: 'sym', v: MULTI_MAP[multi], raw: multi }); i += multi.length; continue; }
    push({ k: 'op', v: c });
    i++;
  }
  return toks;
}

function escapeLatexChar(d) {
  if ('{}$%#&_'.includes(d)) return '\\' + d;
  if (d === '~') return '\\sim';
  if (d === '^') return '\\hat{}';
  return d;
}

// ---------------------------------------------------------------------------
// Parser → LaTeX (direkt, ohne separaten Baum; Knoten tragen ihr LaTeX)
// ---------------------------------------------------------------------------

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  next() { return this.t[this.i++]; }
  eof() { return this.i >= this.t.length; }
  isOp(v, o = 0) { const t = this.peek(o); return t && t.k === 'op' && t.v === v; }

  // Folge bis zu einem Endzeichen (')' , ',' ';' …)
  parseSeq(stop) {
    const items = [];
    while (!this.eof()) {
      const t = this.peek();
      if (t.k === 'op' && stop.includes(t.v)) break;
      if (t.k === 'nl') { this.next(); items.push({ tex: ' \\\\ ', kind: 'nl' }); continue; }
      if (t.k === 'op' && t.v === '&') { this.next(); items.push({ tex: ' & ', kind: 'amp' }); continue; }
      const f = this.parseFrac(stop);
      if (!f) break;
      items.push(f);
    }
    return items;
  }

  parseFrac(stop) {
    let left = this.parseScript(stop);
    if (!left) return null;
    while (this.isOp('/') && !(stop.includes('/'))) {
      this.next();
      const right = this.parseScript(stop);
      if (!right) break;
      left = { tex: `\\frac{${unparen(left)}}{${unparen(right)}}`, kind: 'frac', sp: left.sp, tall: true };
    }
    return left;
  }

  parseScript(stop) {
    let base = this.parseAtom(stop);
    if (!base) return null;
    let sub = null, sup = null, primes = '';
    for (;;) {
      if (this.isOp("'")) { this.next(); primes += "'"; continue; }
      if (this.isOp('_') && sub === null) {
        this.next();
        const a = this.parseScriptArg(stop);
        sub = a ? unparen(a) : '';
        continue;
      }
      if (this.isOp('^') && sup === null) {
        this.next();
        const a = this.parseScriptArg(stop);
        sup = a ? unparen(a) : '';
        continue;
      }
      break;
    }
    if (sub === null && sup === null && !primes) return base;
    let tex = base.kind === 'frac' || base.kind === 'group' && base.needsBrace ? `{${base.tex}}` : base.tex;
    tex += primes;
    if (sub !== null) tex += `_{${sub}}`;
    if (sup !== null) tex += `^{${sup}}`;
    return { tex, kind: 'script', sp: base.sp, tall: base.tall };
  }

  // Ein Hoch-/Tiefstellungs-Argument ist ein einzelnes Atom, Zahlen komplett.
  parseScriptArg(stop) {
    const t = this.peek();
    if (!t) return null;
    if (t.k === 'op' && t.v === '-' ) {
      // x^-1 → x^{-1}
      this.next();
      const a = this.parseAtom(stop);
      return { tex: '-' + (a ? a.tex : ''), kind: 'atom' };
    }
    const a = this.parseAtom(stop);
    return a;
  }

  parseArgs() {
    // nach '(' – Argumente getrennt durch ',', Zeilen durch ';'
    this.argDepth = (this.argDepth || 0) + 1;
    // Werden die Argumente mit ", " (Komma + Leerzeichen) getrennt, ist ein
    // Komma ohne Leerzeichen ein Dezimalkomma: root(2, 0,16)
    this.spacedArgs = this.spacedArgs || [];
    this.spacedArgs.push(this.argsUseSpaces());
    try { return this.parseArgsInner(); } finally { this.argDepth--; this.spacedArgs.pop(); }
  }

  argsUseSpaces() {
    let depth = 0;
    for (let k = this.i; k < this.t.length; k++) {
      const t = this.t[k];
      if (t.k === 'op' && t.v === '(') depth++;
      else if (t.k === 'op' && t.v === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0 && t.k === 'op' && t.v === ',') {
        const next = this.t[k + 1];
        if (next && next.sp) return true;
      }
    }
    return false;
  }

  parseArgsInner() {
    const rows = [[]];
    for (;;) {
      if (this.eof()) break;
      if (this.isOp(')')) { this.next(); break; }
      const items = this.parseSeq([',', ';', ')']);
      rows[rows.length - 1].push(join(items));
      if (this.isOp(',')) { this.next(); continue; }
      if (this.isOp(';')) { this.next(); rows.push([]); continue; }
      if (this.isOp(')')) { this.next(); break; }
      if (!this.eof()) this.next();
    }
    return rows;
  }

  parseAtom(stop) {
    const t = this.peek();
    if (!t) return null;
    if (t.k === 'op' && stop.includes(t.v)) return null;
    this.next();
    const sp = t.sp;
    switch (t.k) {
      case 'num': {
        if (t.sep === ',' && this.argDepth > 0 && !this.spacedArgs[this.spacedArgs.length - 1]) {
          // In Argumentlisten trennt das Komma Argumente (mat(1,2; 3,4)).
          const [a, b] = t.v.split(',');
          this.t.splice(this.i, 0, { k: 'op', v: ',' }, { k: 'num', v: b });
          return { tex: a, kind: 'num', sp };
        }
        let v = t.v;
        if (t.sep === ',') v = v.replace(',', '{,}');
        return { tex: v, kind: 'num', sp };
      }
      case 'str': return { tex: `\\text{${escapeText(t.v)}}`, kind: 'str', sp };
      case 'sym': return { tex: t.v, kind: 'sym', sp };
      case 'nl': return { tex: ' \\\\ ', kind: 'nl', sp };
      case 'id': return this.parseIdent(t, stop);
      case 'op': return this.parseOp(t, stop);
      default: return null;
    }
  }

  parseOp(t, stop) {
    const v = t.v;
    const sp = t.sp;
    if (v === '(' || v === '[' || v === '{') {
      const close = { '(': ')', '[': ']', '{': '}' }[v];
      const items = this.parseSeq([close]);
      if (this.isOp(close)) this.next();
      const inner = join(items);
      const tall = items.some(x => x.tall);
      const l = v === '{' ? '\\{' : v;
      const r = close === '}' ? '\\}' : close;
      const tex = tall ? `\\left${l} ${inner} \\right${r}` : `${l}${inner}${r}`;
      return { tex, inner, kind: 'group', paren: v, sp, tall };
    }
    if (v === '|') {
      // |x| als Betrag, wenn ein schließender Strich folgt
      const save = this.i;
      const items = this.parseSeq(['|', '&']);
      if (this.isOp('|') && items.length) {
        this.next();
        const inner = join(items);
        const tall = items.some(x => x.tall);
        return { tex: tall ? `\\left| ${inner} \\right|` : `|${inner}|`, kind: 'group', sp, tall };
      }
      this.i = save;
      return { tex: '|', kind: 'sym', sp };
    }
    if (v === ')' || v === ']' || v === '}') return { tex: v === '}' ? '\\}' : v, kind: 'sym', sp };
    if (v === '*') return { tex: '\\ast', kind: 'sym', sp };
    if (v === '~') return { tex: '~', kind: 'sym', sp };
    if (v === ',') return { tex: ',', kind: 'sym', sp };
    if (v === ';') return { tex: ';', kind: 'sym', sp };
    if (v === '%') return { tex: '\\%', kind: 'sym', sp };
    if (v === '$') return { tex: '\\$', kind: 'sym', sp };
    if (v === '_' || v === '^') return { tex: '', kind: 'sym', sp };
    if (v === '/') return { tex: '/', kind: 'sym', sp };
    if (v === '°') return { tex: '^{\\circ}', kind: 'sym', sp };
    if (v === '·' || v === '⋅') return { tex: '\\cdot', kind: 'sym', sp };
    if (v === '×') return { tex: '\\times', kind: 'sym', sp };
    if (v === '−') return { tex: '-', kind: 'sym', sp };
    if (v === '#') return { tex: '\\#', kind: 'sym', sp };
    return { tex: v, kind: 'sym', sp };
  }

  parseIdent(t, stop) {
    const name = t.v;
    const sp = t.sp;
    const call = this.isOp('(') && !this.peek().sp;
    const fn = FUNCTIONS[name];
    if (fn && call) {
      this.next(); // (
      const rows = this.parseArgs();
      return { ...fn(rows, this), sp };
    }
    // f(x), sin(x): Bezeichner direkt vor "(" bildet mit der Klammer eine
    // Einheit – so wird sin(x)/x zu \frac{\sin(x)}{x}, wie in Typst.
    if (call && (name.length === 1 || OPERATORS.has(name) || EXTRA_OPERATORS[name])) {
      const head = name.length === 1 ? name : OPERATORS.has(name) ? '\\' + name : `\\operatorname{${EXTRA_OPERATORS[name]}}`;
      const g = this.parseOp(this.next(), []);
      return { tex: head + g.tex, kind: 'call', sp, tall: g.tall };
    }
    if (name.length === 1) return { tex: name, kind: 'var', sp };
    if (SYMBOLS[name] !== undefined) {
      const tex = SYMBOLS[name];
      const bigop = /^\\(sum|prod|int|iint|iiint|oint|coprod|bigcup|bigcap)$/.test(tex);
      return { tex, kind: bigop ? 'bigop' : 'sym', sp };
    }
    if (OPERATORS.has(name)) return { tex: '\\' + name, kind: 'opname', sp };
    if (EXTRA_OPERATORS[name]) return { tex: `\\operatorname{${EXTRA_OPERATORS[name]}}`, kind: 'opname', sp };
    // Unbekannte Wörter aufrecht setzen – passt für Einheiten (cm, kg, mol)
    // und Indizes wie E_kin.
    return { tex: `\\mathrm{${escapeText(name)}}`, kind: 'word', sp };
  }
}

function escapeText(s) {
  return s.replace(/\\/g, '\\textbackslash{}').replace(/([{}$%#&_])/g, '\\$1').replace(/\^/g, '\\^{}').replace(/~/g, '\\textasciitilde{}');
}

// Äußere runde Klammern fallen bei Brüchen und Exponenten weg – wie in Typst.
function unparen(node) {
  if (node.kind === 'group' && node.paren === '(') return node.inner;
  return node.tex;
}

function arg(rows, k) {
  return (rows[0] && rows[0][k]) || '';
}

function join(items) {
  let out = '';
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const prev = items[k - 1];
    if (prev) {
      // Zahl gefolgt von Wort/Text mit Leerzeichen: Einheit → schmaler Abstand
      if (it.sp && prev.kind === 'num' && (it.kind === 'word' || it.kind === 'str' && isUnitText(it.tex))) out += '\\,';
      else if (it.sp && prev.kind === 'str' && it.kind !== 'nl') out += '\\ ';
      else if (it.sp && it.kind === 'str' && prev.kind !== 'nl' && prev.kind !== 'amp') out += '\\ ';
      else if (needsSpace(out, it.tex)) out += ' ';
    }
    out += it.tex;
  }
  return out.trim();
}

// Kurzer Text ohne Leerzeichen nach einer Zahl ist meist eine Einheit ("cm").
function isUnitText(tex) {
  const m = /^\\text\{(.*)\}$/.exec(tex);
  return !!m && m[1].length <= 5 && !/\s/.test(m[1]);
}

function needsSpace(prev, next) {
  return /\\[a-zA-Z]+$/.test(prev) && /^[a-zA-Z]/.test(next);
}

function cases(rows) {
  const lines = rows.flat().map(r => {
    const parts = r.split(/\s*\\ \s*|\s+&\s+/);
    return r;
  });
  return `\\begin{cases} ${lines.join(' \\\\ ')} \\end{cases}`;
}

const FUNCTIONS = {
  sqrt: (rows) => ({ tex: `\\sqrt{${arg(rows, 0)}}`, kind: 'atom', tall: true }),
  root: (rows) => {
    const n = arg(rows, 0), x = arg(rows, 1);
    if (!x) return { tex: `\\sqrt{${n}}`, kind: 'atom', tall: true };
    return { tex: n === '2' ? `\\sqrt{${x}}` : `\\sqrt[${n}]{${x}}`, kind: 'atom', tall: true };
  },
  frac: (rows) => ({ tex: `\\frac{${arg(rows, 0)}}{${arg(rows, 1)}}`, kind: 'frac', tall: true }),
  binom: (rows) => ({ tex: `\\binom{${arg(rows, 0)}}{${arg(rows, 1)}}`, kind: 'atom', tall: true }),
  // attach(C, tl: 14, bl: 6): Hoch- und Tiefzahlen an allen Ecken – so schreibt Typst Isotope (¹⁴₆C)
  attach: (rows) => {
    const [base = '', ...rest] = rows[0] || [];
    const at = {};
    for (const a of rest) {
      const m = /^(?:\\(?:mathrm|operatorname)\{)?(tl|bl|tr|br|t|b)\}?\s*:\s*([\s\S]*)$/.exec(a.trim());
      if (m) at[m[1]] = m[2].trim();
    }
    let tex = base;
    if (at.t) tex = `\\overset{${at.t}}{${tex}}`;
    if (at.b) tex = `\\underset{${at.b}}{${tex}}`;
    const pre = at.tl || at.bl ? `{}${at.tl ? `^{${at.tl}}` : ''}${at.bl ? `_{${at.bl}}` : ''}` : '';
    const post = `${at.tr ? `^{${at.tr}}` : ''}${at.br ? `_{${at.br}}` : ''}`;
    return { tex: pre + (post ? `{${tex}}${post}` : tex), kind: 'atom', tall: !!(at.t || at.b) };
  },
  abs: (rows) => ({ tex: `\\left| ${arg(rows, 0)} \\right|`, kind: 'atom' }),
  norm: (rows) => ({ tex: `\\left\\| ${arg(rows, 0)} \\right\\|`, kind: 'atom' }),
  floor: (rows) => ({ tex: `\\left\\lfloor ${arg(rows, 0)} \\right\\rfloor`, kind: 'atom' }),
  ceil: (rows) => ({ tex: `\\left\\lceil ${arg(rows, 0)} \\right\\rceil`, kind: 'atom' }),
  round: (rows) => ({ tex: `\\left\\lfloor ${arg(rows, 0)} \\right\\rceil`, kind: 'atom' }),
  vec: (rows) => ({ tex: `\\begin{pmatrix} ${rows.flat().join(' \\\\ ')} \\end{pmatrix}`, kind: 'atom', tall: true }),
  mat: (rows) => ({ tex: `\\begin{pmatrix} ${rows.map(r => r.join(' & ')).join(' \\\\ ')} \\end{pmatrix}`, kind: 'atom', tall: true }),
  det: (rows) => ({ tex: `\\begin{vmatrix} ${rows.map(r => r.join(' & ')).join(' \\\\ ')} \\end{vmatrix}`, kind: 'atom', tall: true }),
  cases: (rows) => ({ tex: cases(rows), kind: 'atom', tall: true }),
  overline: (rows) => ({ tex: `\\overline{${arg(rows, 0)}}`, kind: 'atom' }),
  underline: (rows) => ({ tex: `\\underline{${arg(rows, 0)}}`, kind: 'atom' }),
  overbrace: (rows) => ({ tex: `\\overbrace{${arg(rows, 0)}}${arg(rows, 1) ? `^{${arg(rows, 1)}}` : ''}`, kind: 'atom', tall: true }),
  underbrace: (rows) => ({ tex: `\\underbrace{${arg(rows, 0)}}${arg(rows, 1) ? `_{${arg(rows, 1)}}` : ''}`, kind: 'atom', tall: true }),
  hat: (rows) => ({ tex: `\\hat{${arg(rows, 0)}}`, kind: 'atom' }),
  tilde: (rows) => ({ tex: `\\tilde{${arg(rows, 0)}}`, kind: 'atom' }),
  bar: (rows) => ({ tex: `\\bar{${arg(rows, 0)}}`, kind: 'atom' }),
  dot: (rows) => ({ tex: `\\dot{${arg(rows, 0)}}`, kind: 'atom' }),
  arrow: (rows) => ({ tex: `\\vec{${arg(rows, 0)}}`, kind: 'atom' }),
  vect: (rows) => ({ tex: `\\vec{${arg(rows, 0)}}`, kind: 'atom' }),
  cancel: (rows) => ({ tex: `\\cancel{${arg(rows, 0)}}`, kind: 'atom' }),
  bold: (rows) => ({ tex: `\\boldsymbol{${arg(rows, 0)}}`, kind: 'atom' }),
  upright: (rows) => ({ tex: `\\mathrm{${arg(rows, 0)}}`, kind: 'atom' }),
  italic: (rows) => ({ tex: `\\mathit{${arg(rows, 0)}}`, kind: 'atom' }),
  cal: (rows) => ({ tex: `\\mathcal{${arg(rows, 0)}}`, kind: 'atom' }),
  bb: (rows) => ({ tex: `\\mathbb{${arg(rows, 0)}}`, kind: 'atom' }),
  frak: (rows) => ({ tex: `\\mathfrak{${arg(rows, 0)}}`, kind: 'atom' }),
  mono: (rows) => ({ tex: `\\mathtt{${arg(rows, 0)}}`, kind: 'atom' }),
  sans: (rows) => ({ tex: `\\mathsf{${arg(rows, 0)}}`, kind: 'atom' }),
  op: (rows) => ({ tex: `\\operatorname{${arg(rows, 0).replace(/^\\text\{(.*)\}$/, '$1')}}`, kind: 'opname' }),
  lr: (rows) => ({ tex: arg(rows, 0), kind: 'atom' }),
  display: (rows) => ({ tex: `\\displaystyle ${arg(rows, 0)}`, kind: 'atom' }),
  inline: (rows) => ({ tex: `\\textstyle ${arg(rows, 0)}`, kind: 'atom' }),
  limits: (rows) => ({ tex: `${arg(rows, 0)}\\limits`, kind: 'bigop' }),
  text: (rows) => ({ tex: `\\text{${arg(rows, 0).replace(/^\\text\{(.*)\}$/, '$1')}}`, kind: 'str' }),
  color: (rows) => ({ tex: `\\textcolor{${arg(rows, 0).replace(/\\mathrm\{(.*)\}/, '$1')}}{${arg(rows, 1)}}`, kind: 'atom' }),
  ce: (rows, p) => ({ tex: `\\ce{${rows[0].join(',').replace(/^\\text\{(.*)\}$/, '$1')}}`, kind: 'atom' }),
  pu: (rows) => ({ tex: `\\pu{${arg(rows, 0).replace(/^\\text\{(.*)\}$/, '$1')}}`, kind: 'atom' })
};

// Für ce(...) wollen wir den Rohtext, nicht die übersetzte Form – deshalb
// wird ce("…") bzw. ce(…) vor dem Lexen durch einen Platzhalter §n§ ersetzt.
export function typstToLatex(src) {
  const chem = [];
  const rebuilt = String(src)
    .replace(/\bce\(\s*"([^"]*)"\s*\)/g, (m, s) => { chem.push(s); return ` §${chem.length - 1}§ `; })
    .replace(/\bce\(([^()"]*)\)/g, (m, s) => { chem.push(s.trim()); return ` §${chem.length - 1}§ `; });
  const toks = lex(rebuilt);
  const fixed = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.k === 'op' && t.v === '§' && toks[k + 1] && toks[k + 1].k === 'num' && toks[k + 2] && toks[k + 2].v === '§') {
      fixed.push({ k: 'sym', v: `\\ce{${chem[+toks[k + 1].v]}}`, sp: t.sp });
      k += 2;
      continue;
    }
    fixed.push(t);
  }
  const p = new Parser(fixed);
  const items = [];
  while (!p.eof()) {
    items.push(...p.parseSeq([]));
    if (!p.eof()) {
      const t = p.next();
      items.push({ tex: t.v || '', kind: 'sym' });
    }
  }
  let tex = join(items);
  const multiline = items.some(x => x.kind === 'nl' || x.kind === 'amp');
  if (multiline) {
    tex = tex.replace(/\s*\\\\\s*$/, '');
    tex = `\\begin{aligned} ${tex} \\end{aligned}`;
  }
  return tex;
}
