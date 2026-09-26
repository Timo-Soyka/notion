// Rechenausdrücke für Funktionsgraphen.
//
// Eingabe so, wie man sie im Unterricht schreibt: "2x^2 - 3", "0,5x + 1",
// "sin x", "√x", "f'(x)". Daraus wird ein Syntaxbaum, der sich schnell
// auswerten (Closure statt eval) und als LaTeX für die Legende ausgeben lässt.

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  cot: (x) => 1 / Math.tan(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, wurzel: Math.sqrt, cbrt: Math.cbrt,
  abs: Math.abs, betrag: Math.abs,
  ln: Math.log, log: Math.log10, lg: Math.log10, ld: Math.log2, exp: Math.exp,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign, sgn: Math.sign
};
const MULTI_ARG = {
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  root: (n, x) => nthRoot(x, n), log: (b, x) => Math.log(x) / Math.log(b),
  mod: (a, b) => ((a % b) + b) % b
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI };

function nthRoot(x, n) {
  // Ungerade Wurzeln aus negativen Zahlen sind reell (∛-8 = -2)
  if (x < 0 && Math.round(n) === n && n % 2 === 1) return -Math.pow(-x, 1 / n);
  return Math.pow(x, 1 / n);
}

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

function normalizeInput(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (SUPERSCRIPTS[c] !== undefined) {
      let sup = '';
      while (i < s.length && SUPERSCRIPTS[s[i]] !== undefined) { sup += SUPERSCRIPTS[s[i]]; i++; }
      i--;
      out += '^(' + sup + ')';
      continue;
    }
    out += c;
  }
  return out
    .replace(/[·⋅×]/g, '*')
    .replace(/[÷:]/g, '/')
    .replace(/−/g, '-')
    .replace(/\*\*/g, '^')
    // Dezimalkomma: 0,5 → 0.5 (aber nicht in max(1, 2) – dort steht ein Leerzeichen)
    .replace(/(\d),(\d)/g, '$1.$2');
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; if (toks.length) toks[toks.length - 1].spaceAfter = true; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (/[eE]/.test(src[j]) && /[-+0-9]/.test(src[j + 1] || '') && /[0-9]/.test(src[j + 1] === '-' || src[j + 1] === '+' ? src[j + 2] || '' : src[j + 1])) {
        j += 2;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const v = parseFloat(src.slice(i, j));
      if (Number.isNaN(v)) throw new Error('Ungültige Zahl');
      toks.push({ k: 'num', v, raw: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[\p{L}]/u.test(c)) {
      let j = i;
      while (j < src.length && /[\p{L}]/u.test(src[j])) j++;
      toks.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '√') { toks.push({ k: 'id', v: 'sqrt', sym: true }); i++; continue; }
    if ('+-*/^()|,;!\''.includes(c)) { toks.push({ k: 'op', v: c }); i++; continue; }
    if (c === '[' ) { toks.push({ k: 'op', v: '(' }); i++; continue; }
    if (c === ']' ) { toks.push({ k: 'op', v: ')' }); i++; continue; }
    throw new Error(`Unbekanntes Zeichen „${c}“`);
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser → Baum
// Knoten: {t:'num',v} {t:'var',n} {t:'neg',a} {t:'bin',op,a,b} {t:'call',f,args,d(Ableitung)}
// ---------------------------------------------------------------------------

class P {
  constructor(toks, known) { this.t = toks; this.i = 0; this.known = known || {}; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  isOp(v) { const t = this.peek(); return t && t.k === 'op' && t.v === v; }
  expect(v) { if (!this.isOp(v)) throw new Error(`„${v}“ erwartet`); this.next(); }

  parse() {
    const e = this.add();
    if (this.i < this.t.length) throw new Error(`Unerwartet: „${this.peek().v}“`);
    return e;
  }
  add() {
    let a = this.mul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      a = { t: 'bin', op, a, b: this.mul() };
    }
    return a;
  }
  startsAtom() {
    const t = this.peek();
    if (!t) return false;
    if (t.k === 'num' || t.k === 'id') return true;
    return t.k === 'op' && (t.v === '(' || (t.v === '|' && !this.inAbs));
  }
  mul() {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = this.next().v;
        a = { t: 'bin', op, a, b: this.unary() };
      } else if (this.startsAtom()) {
        a = { t: 'bin', op: '*', a, b: this.pow(), implicit: true };
      } else break;
    }
    return a;
  }
  unary() {
    if (this.isOp('-')) { this.next(); return { t: 'neg', a: this.unary() }; }
    if (this.isOp('+')) { this.next(); return this.unary(); }
    return this.pow();
  }
  pow() {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.next();
      return { t: 'bin', op: '^', a: base, b: this.unary() };
    }
    return base;
  }
  postfix() {
    let a = this.atom();
    while (this.isOp('!')) { this.next(); a = { t: 'call', f: 'fact', args: [a] }; }
    return a;
  }
  args() {
    this.expect('(');
    const args = [this.add()];
    while (this.isOp(',') || this.isOp(';')) { this.next(); args.push(this.add()); }
    this.expect(')');
    return args;
  }
  atom() {
    const t = this.next();
    if (!t) throw new Error('Ausdruck unvollständig');
    if (t.k === 'num') return { t: 'num', v: t.v, raw: t.raw };
    if (t.k === 'op' && t.v === '(') { const e = this.add(); this.expect(')'); return { t: 'paren', a: e }; }
    if (t.k === 'op' && t.v === '|') {
      const prev = this.inAbs;
      this.inAbs = true;
      const e = this.add();
      this.inAbs = prev;
      this.expect('|');
      return { t: 'call', f: 'abs', args: [e] };
    }
    if (t.k === 'id') return this.ident(t);
    throw new Error(`Unerwartet: „${t.v}“`);
  }
  ident(t) {
    let name = t.v;
    // Ableitung f'(x), f''(x)
    let d = 0;
    while (this.isOp("'")) { this.next(); d++; }
    if (this.known[name] && (this.isOp('(') || d)) {
      const args = this.isOp('(') ? this.args() : [{ t: 'var', n: 'x' }];
      return { t: 'call', f: name, user: true, d, args };
    }
    if (FUNCS[name] || MULTI_ARG[name]) {
      if (this.isOp('(')) return { t: 'call', f: name, args: this.args() };
      // "sin x", "√x": Funktion ohne Klammern wirkt auf den nächsten Term
      return { t: 'call', f: name, args: [this.pow()] };
    }
    if (name in CONSTS) return { t: 'const', n: name };
    if (name === 'x') return { t: 'var', n: 'x' };
    // Mehrbuchstabige Folge: bekannte Funktion am Anfang? ("sinx" → sin(x))
    for (const fn of Object.keys(FUNCS).sort((a, b) => b.length - a.length)) {
      if (name.startsWith(fn) && name.length > fn.length) {
        const rest = { k: 'id', v: name.slice(fn.length) };
        return { t: 'call', f: fn, args: [this.ident(rest)] };
      }
    }
    if (name.length > 1) {
      // "ax" → a·x
      const parts = [...name].map(ch => this.ident({ k: 'id', v: ch }));
      return parts.reduce((a, b) => ({ t: 'bin', op: '*', a, b, implicit: true }));
    }
    if (this.known[name] && !this.isOp('(')) return { t: 'param', n: name };
    return { t: 'param', n: name };
  }
}

// ---------------------------------------------------------------------------
// Öffentliche Schnittstelle
// ---------------------------------------------------------------------------

// Zerlegt "f(x) = x^2", "g: x^2", "y = 2x" oder nur "x^2".
export function splitDefinition(src) {
  const s = String(src || '').trim();
  let m = /^([\p{L}][\p{L}\d_]*)\s*\(\s*x\s*\)\s*=\s*([\s\S]*)$/u.exec(s);
  if (m) return { name: m[1], body: m[2] };
  m = /^([\p{L}][\p{L}\d_]*)\s*:\s*([\s\S]*)$/u.exec(s);
  if (m) return { name: m[1], body: m[2] };
  m = /^y\s*=\s*([\s\S]*)$/.exec(s);
  if (m) return { name: null, body: m[1] };
  m = /^x\s*=\s*([\s\S]*)$/.exec(s);
  if (m) return { name: null, body: m[1], vertical: true };
  m = /^([a-zA-Z])\s*=\s*([^=]*)$/.exec(s);
  if (m && !/x/.test(m[2])) return { name: m[1], body: m[2], param: true };
  return { name: null, body: s };
}

export function parseExpr(src, known) {
  const toks = lex(normalizeInput(String(src)));
  if (!toks.length) throw new Error('Leer');
  return new P(toks, known).parse();
}

function fact(n) {
  if (n < 0 || n !== Math.floor(n)) return gamma(n + 1);
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}
function gamma(z) {
  // Lanczos-Näherung
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

// Übersetzt den Baum in eine schnelle Funktion x ↦ y.
// env.funcs: Name → Funktion (für f(x) in g(x)), env.params: Name → Zahl
export function compile(node, env = {}) {
  const funcs = env.funcs || {};
  const params = env.params || {};
  const c = (n) => {
    switch (n.t) {
      case 'num': { const v = n.v; return () => v; }
      case 'var': return (x) => x;
      case 'const': { const v = CONSTS[n.n]; return () => v; }
      case 'param': {
        const name = n.n;
        return () => (name in params ? params[name] : NaN);
      }
      case 'paren': return c(n.a);
      case 'neg': { const a = c(n.a); return (x) => -a(x); }
      case 'bin': {
        const a = c(n.a), b = c(n.b);
        switch (n.op) {
          case '+': return (x) => a(x) + b(x);
          case '-': return (x) => a(x) - b(x);
          case '*': return (x) => a(x) * b(x);
          case '/': return (x) => a(x) / b(x);
          case '^': {
            // (-8)^(1/3) soll -2 ergeben, wie im Taschenrechner der Schule
            return (x) => {
              const base = a(x), e = b(x);
              if (base < 0 && !Number.isInteger(e)) {
                const inv = 1 / e;
                if (Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2 === 1) return -Math.pow(-base, e);
              }
              return Math.pow(base, e);
            };
          }
        }
        break;
      }
      case 'call': {
        const args = n.args.map(c);
        if (n.user) {
          const name = n.f, d = n.d || 0;
          const a0 = args[0];
          return (x) => {
            const f = funcs[name];
            if (!f) return NaN;
            const u = a0(x);
            return d ? derivative(f, u, d) : f(u);
          };
        }
        if (n.f === 'fact') { const a = args[0]; return (x) => fact(a(x)); }
        if (args.length > 1 && MULTI_ARG[n.f]) {
          const f = MULTI_ARG[n.f];
          return (x) => f(...args.map(g => g(x)));
        }
        const f = FUNCS[n.f] || MULTI_ARG[n.f];
        const a = args[0];
        return (x) => f(a(x));
      }
    }
    throw new Error('Unbekannter Knoten');
  };
  return c(node);
}

export function derivative(f, x, order = 1) {
  const h = 1e-4 * Math.max(1, Math.abs(x));
  if (order === 1) return (f(x + h) - f(x - h)) / (2 * h);
  if (order === 2) return (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);
  return derivative((u) => derivative(f, u, order - 1), x, 1);
}

// Welche Namen benutzt ein Baum? (für Abhängigkeiten zwischen Funktionen)
export function usedNames(node, out = new Set()) {
  if (!node) return out;
  if (node.t === 'call' && node.user) out.add(node.f);
  if (node.t === 'param') out.add(node.n);
  for (const k of ['a', 'b']) if (node[k]) usedNames(node[k], out);
  if (node.args) node.args.forEach(a => usedNames(a, out));
  return out;
}

// ---------------------------------------------------------------------------
// Baum → LaTeX (für die Legende und Punktbeschriftungen)
// ---------------------------------------------------------------------------

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };

export function toTex(node) {
  const t = (n, parentPrec = 0) => {
    switch (n.t) {
      case 'num': return formatNumberTex(n.v, n.raw);
      case 'var': return 'x';
      case 'const': return n.n === 'pi' || n.n === 'π' ? '\\pi' : n.n === 'tau' ? '\\tau' : 'e';
      case 'param': return n.n;
      case 'paren': return `\\left(${t(n.a)}\\right)`;
      case 'neg': return wrap('-' + t(n.a, 3), 3, parentPrec);
      case 'bin': {
        const p = PREC[n.op];
        if (n.op === '/') return `\\frac{${t(n.a)}}{${t(n.b)}}`;
        if (n.op === '^') {
          const base = n.a.t === 'call' && n.a.f === 'sqrt' || n.a.t === 'bin' || n.a.t === 'neg' ? `\\left(${t(n.a)}\\right)` : t(n.a, 5);
          return `${base}^{${t(n.b)}}`;
        }
        if (n.op === '*') {
          const left = t(n.a, p), right = t(n.b, p + 0.5);
          const needDot = !n.implicit || /^[0-9.]/.test(right) || n.b.t === 'num';
          return wrap(left + (needDot ? ' \\cdot ' : ' ') + right, p, parentPrec);
        }
        return wrap(`${t(n.a, p)} ${n.op} ${t(n.b, p + 0.5)}`, p, parentPrec);
      }
      case 'call': {
        const a = n.args.map(x => t(x));
        if (n.user) return `${n.f}${"'".repeat(n.d || 0)}\\left(${a.join(', ')}\\right)`;
        switch (n.f) {
          case 'sqrt': case 'wurzel': return `\\sqrt{${a[0]}}`;
          case 'cbrt': return `\\sqrt[3]{${a[0]}}`;
          case 'root': return `\\sqrt[${a[0]}]{${a[1]}}`;
          case 'abs': case 'betrag': return `\\left|${a[0]}\\right|`;
          case 'fact': return `${t(n.args[0], 5)}!`;
          case 'exp': return `e^{${a[0]}}`;
          case 'log': return a.length > 1 ? `\\log_{${a[0]}}\\left(${a[1]}\\right)` : `\\log\\left(${a[0]}\\right)`;
          case 'lg': case 'ld': case 'sgn': case 'sign': case 'round':
            return `\\operatorname{${n.f}}\\left(${a[0]}\\right)`;
          case 'floor': return `\\lfloor ${a[0]} \\rfloor`;
          case 'ceil': return `\\lceil ${a[0]} \\rceil`;
          default: {
            const known = ['sin', 'cos', 'tan', 'cot', 'sinh', 'cosh', 'tanh', 'ln', 'arcsin', 'arccos', 'arctan', 'min', 'max'];
            const name = n.f === 'asin' ? 'arcsin' : n.f === 'acos' ? 'arccos' : n.f === 'atan' ? 'arctan' : n.f;
            const head = known.includes(name) ? '\\' + name : `\\operatorname{${name}}`;
            return `${head}\\left(${a.join(', ')}\\right)`;
          }
        }
      }
    }
    return '';
  };
  return t(node);
}

function wrap(s, p, parent) {
  return p < parent ? `\\left(${s}\\right)` : s;
}

function formatNumberTex(v, raw) {
  const s = raw && /^[0-9]*\.?[0-9]+$/.test(raw) ? raw : String(v);
  return s.replace('.', '{,}');
}

// Zahl für Beschriftungen: deutsches Komma, sinnvoll gerundet.
export function formatNumber(v, digits = 2) {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) < 1e-10) v = 0;
  let s = v.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s.replace('.', ',').replace('-', '−');
}

// ---------------------------------------------------------------------------
// Besondere Punkte
// ---------------------------------------------------------------------------

function bisect(f, a, b, it = 60) {
  let fa = f(a);
  for (let k = 0; k < it; k++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (!Number.isFinite(fm)) return null;
    if (fa * fm <= 0) b = m;
    else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

function dedupe(xs, tol) {
  const out = [];
  for (const x of xs.sort((a, b) => a - b)) if (!out.length || Math.abs(out[out.length - 1] - x) > tol) out.push(x);
  return out;
}

// Nullstellen von f in [a, b]; findet auch Berührpunkte (x² bei 0).
export function findRoots(f, a, b, samples = 1200) {
  const roots = [];
  const step = (b - a) / samples;
  let px = a, py = f(a);
  const vals = [py];
  for (let k = 1; k <= samples; k++) {
    const x = a + k * step;
    const y = f(x);
    vals.push(y);
    if (Number.isFinite(py) && Number.isFinite(y)) {
      if (py === 0) roots.push(px);
      else if (py * y < 0) {
        const r = bisect(f, px, x);
        // Polstellen (1/x) haben einen Vorzeichenwechsel, aber keinen kleinen Wert
        if (r !== null && Math.abs(f(r)) < 1e-6 * Math.max(1, Math.abs(py), Math.abs(y))) roots.push(r);
      }
    }
    px = x; py = y;
  }
  if (vals[samples] === 0) roots.push(b);
  // Berührstellen: lokale Minima von |f| nahe 0
  const range = Math.max(1e-9, ...vals.filter(Number.isFinite).map(Math.abs));
  for (let k = 1; k < samples; k++) {
    const l = Math.abs(vals[k - 1]), m = Math.abs(vals[k]), r = Math.abs(vals[k + 1]);
    if (m <= l && m <= r && m < range * 1e-3 && Number.isFinite(m)) {
      const x0 = a + (k - 1) * step, x1 = a + (k + 1) * step;
      const xm = goldenMin((x) => Math.abs(f(x)), x0, x1);
      if (Math.abs(f(xm)) < 1e-7 * Math.max(1, range)) roots.push(xm);
    }
  }
  return dedupe(roots, step * 1.5).map(x => snap(x));
}

function goldenMin(f, a, b, it = 80) {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  for (let k = 0; k < it; k++) {
    if (f(c) < f(d)) b = d; else a = c;
    c = b - g * (b - a); d = a + g * (b - a);
  }
  return (a + b) / 2;
}

// Glatte Werte (1,9999999 → 2) für die Beschriftung
function snap(x) {
  const r = Math.round(x * 1e6) / 1e6;
  const v = Math.abs(r - Math.round(r)) < 1e-6 ? Math.round(r) : r;
  return v + 0; // -0 vermeiden

}

export function findExtrema(f, a, b) {
  const df = (x) => derivative(f, x, 1);
  const xs = findRoots(df, a, b, 800);
  const out = [];
  for (const x of xs) {
    const y = f(x);
    if (!Number.isFinite(y)) continue;
    const h = (b - a) / 400;
    const l = f(x - h), r = f(x + h);
    if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
    if (y > l && y > r) out.push({ x, y, kind: 'max' });
    else if (y < l && y < r) out.push({ x, y, kind: 'min' });
  }
  return out;
}

export function findInflections(f, a, b) {
  const d2 = (x) => derivative(f, x, 2);
  const xs = [];
  const samples = 600;
  const step = (b - a) / samples;
  let py = d2(a);
  for (let k = 1; k <= samples; k++) {
    const x = a + k * step;
    const y = d2(x);
    if (Number.isFinite(py) && Number.isFinite(y) && py * y < 0 && Math.abs(py) < 1e6 && Math.abs(y) < 1e6) {
      const r = bisect(d2, x - step, x);
      if (r !== null) xs.push(snap(r));
    }
    py = y;
  }
  return dedupe(xs, step * 2).map(x => ({ x, y: f(x), kind: 'wp' })).filter(p => Number.isFinite(p.y));
}
