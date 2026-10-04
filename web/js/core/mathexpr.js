// Rechenausdrücke für Funktionsgraphen.
//
// Eingabe so, wie man sie im Unterricht schreibt: "2x^2 - 3", "0,5x + 1",
// "sin x", "√x", "f'(x)", "∫_0^3 f(x) dx", "tangente(f, 1)" und mit
// Einschränkung "x^2 für x < 3". Daraus wird ein Syntaxbaum, der sich schnell
// auswerten (Closure statt eval), ableiten und als LaTeX ausgeben lässt.

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
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI, '∞': Infinity };

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
    if (c === '∞') { toks.push({ k: 'id', v: '∞' }); i++; continue; }
    if ('+-*/^()|,;!\'∫_'.includes(c)) { toks.push({ k: 'op', v: c }); i++; continue; }
    if (c === '[' || c === '{') { toks.push({ k: 'op', v: '(' }); i++; continue; }
    if (c === ']' || c === '}') { toks.push({ k: 'op', v: ')' }); i++; continue; }
    throw new Error(`Unbekanntes Zeichen „${c}“`);
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser → Baum
// Knoten: {t:'num',v} {t:'var',n} {t:'neg',a} {t:'bin',op,a,b} {t:'call',f,args,d(Ableitung)}
// ---------------------------------------------------------------------------

class P {
  constructor(toks, known, opts = {}) { this.t = toks; this.i = 0; this.known = known || {}; this.v = opts.variable || 'x'; this.inIntegral = null; }
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
    // "dx" beendet den Term unter dem Integral
    if (this.inIntegral && t.k === 'id' && t.v === 'd' + this.inIntegral) return false;
    if (t.k === 'op' && t.v === '∫') return true;
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
    if (t.k === 'op' && t.v === '∫') return this.integral();
    if (t.k === 'id') return this.ident(t);
    throw new Error(`Unerwartet: „${t.v}“`);
  }

  // Grenze am Integral: Zahl, Name oder Klammer, auch mit Vorzeichen (∫_-1^2)
  bound() {
    if (this.isOp('-')) { this.next(); return { t: 'neg', a: this.bound() }; }
    const t = this.next();
    if (!t) throw new Error('Grenze fehlt');
    if (t.k === 'num') return { t: 'num', v: t.v, raw: t.raw };
    if (t.k === 'op' && t.v === '(') { const e = this.add(); this.expect(')'); return e; }
    if (t.k === 'id') {
      if (t.v === this.v || t.v === 'x') return { t: 'var', n: t.v };
      if (t.v in CONSTS) return { t: 'const', n: t.v };
      if (t.v.length === 1) return { t: 'param', n: t.v };
      // "_0^3" wird zu den Token 0, ^, 3 – "pi2" o. Ä. als Ganzes lesen
      this.i--;
      return this.postfix();
    }
    throw new Error('Grenze nicht lesbar');
  }

  // ∫_a^b Term dx  ·  ∫(Term, a, b)  ·  integral(Term, a, b)
  integral() {
    if (this.isOp('(')) {
      const args = this.args();
      if (args.length !== 3) throw new Error('Integral: ∫(Term, von, bis)');
      return { t: 'integral', a: args[0], lo: args[1], hi: args[2], v: 'x' };
    }
    let lo = null, hi = null;
    for (let k = 0; k < 2; k++) {
      if (this.isOp('_') && !lo) { this.next(); lo = this.bound(); }
      else if (this.isOp('^') && !hi) { this.next(); hi = this.bound(); }
    }
    if (!lo || !hi) throw new Error('Integral braucht Grenzen: ∫_0^3 f(x) dx');
    // Integrationsvariable aus "dx", "dt" … ablesen
    let v = 'x';
    for (let k = this.i; k < this.t.length; k++) {
      const t = this.t[k];
      const m = t.k === 'id' && /d([a-z])$/.exec(t.v);
      if (m) { v = m[1]; break; }
    }
    const outer = { v: this.v, inIntegral: this.inIntegral };
    this.v = v;
    this.inIntegral = v;
    const body = this.add();
    this.v = outer.v;
    this.inIntegral = outer.inIntegral;
    const d = this.peek();
    if (!d || d.k !== 'id' || d.v !== 'd' + v) throw new Error(`„d${v}“ am Ende des Integrals fehlt`);
    this.next();
    return { t: 'integral', a: body, lo, hi, v };
  }
  ident(t) {
    let name = t.v;
    // "xdx" unter dem Integral: x · dx
    if (this.inIntegral && name.length > 2 && name.endsWith('d' + this.inIntegral)) {
      this.t.splice(this.i, 0, { k: 'id', v: 'd' + this.inIntegral });
      name = name.slice(0, -2);
      t = { k: 'id', v: name };
    }
    if ((name === 'int' || name === 'integral') && (this.isOp('(') || this.isOp('_') || this.isOp('^'))) return this.integral();
    // tangente(f, 1), normale(f, 1) – vor der Zerlegung in tan · gente
    if (/^(tangente|tangent|normale|normal)$/i.test(name) && this.isOp('(')) {
      this.next();
      const ft = this.next();
      if (!ft || ft.k !== 'id') throw new Error('Tangente: tangente(f, 1)');
      let d = 0;
      while (this.isOp("'")) { this.next(); d++; }
      if (!(this.isOp(',') || this.isOp(';'))) throw new Error('Tangente: tangente(f, 1)');
      this.next();
      const x0 = this.add();
      this.expect(')');
      return { t: 'tangent', f: ft.v, d, x0, normal: /^normal/i.test(name) };
    }
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
    if (name === this.v) return { t: 'var', n: name };
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
  // Fläche: "A = ∫_0^3 f(x) dx"
  let m = /^([\p{L}][\p{L}\d_]*)\s*=\s*((?:∫|int\b|integral\b)[\s\S]*)$/u.exec(s);
  if (m) return { name: m[1], body: m[2], area: true };
  m = /^([\p{L}][\p{L}\d_]*)\s*\(\s*x\s*\)\s*=\s*([\s\S]*)$/u.exec(s);
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

export function parseExpr(src, known, opts) {
  const toks = lex(normalizeInput(String(src)));
  if (!toks.length) throw new Error('Leer');
  return new P(toks, known, opts).parse();
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

// Wie tief Funktionen einander aufrufen dürfen. Ruft sich eine Funktion
// (auch über Umwege) selbst auf, bricht die Auswertung hier ab, statt
// endlos weiterzulaufen – WebKit meldet eine solche Rekursion nicht als Fehler.
const MAX_DEPTH = 40;
let depth = 0;

// Übersetzt den Baum in eine schnelle Funktion x ↦ y.
// env.funcs: Name → Funktion (für f(x) in g(x)), env.params: Name → Zahl,
// env.deriv(name, n): n-te Ableitung von name als Funktion (falls bekannt)
export function compile(node, env = {}) {
  const funcs = env.funcs || {};
  const params = env.params || {};
  const outer = env.outer || null;
  const variable = env.variable || null;
  const c = (n) => {
    switch (n.t) {
      case 'num': { const v = n.v; return () => v; }
      case 'var':
        // Im Integral: die äußere Variable (∫_0^x x·t dt) kommt von außen
        if (outer && variable && n.n && n.n !== variable) return () => outer.x;
        return (x) => x;
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
            if (!f || depth > MAX_DEPTH) return NaN;
            depth++;
            try {
              const u = a0(x);
              if (!d) return f(u);
              const g = env.deriv && env.deriv(name, d);
              return g ? g(u) : derivative(f, u, d);
            } finally { depth--; }
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
      case 'integral': {
        const lo = c(n.lo), hi = c(n.hi);
        const box = { x: 0 };
        const g = compile(n.a, { ...env, variable: n.v, outer: box });
        return (x) => {
          if (depth > MAX_DEPTH) return NaN;
          depth++;
          try { box.x = x; return integrate(g, lo(x), hi(x)); } finally { depth--; }
        };
      }
      case 'tangent': {
        const name = n.f, d = n.d || 0, x0 = c(n.x0), normal = n.normal;
        return (x) => {
          const line = tangentLine(funcs[name], x0(x), { d, deriv: env.deriv && ((k) => env.deriv(name, k)), normal });
          return line ? line.m * x + line.b : NaN;
        };
      }
    }
    throw new Error('Unbekannter Knoten');
  };
  return c(node);
}

// Bestimmtes Integral (Simpsonregel); a > b ergibt das negative Integral
export function integrate(f, a, b, n = 200) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  if (a === b) return 0;
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let k = 1; k < n; k++) sum += f(a + k * h) * (k % 2 ? 4 : 2);
  const r = sum * h / 3;
  return Number.isFinite(r) ? r : NaN;
}

// Tangente (bzw. Normale) an f in x0: y = m·x + b, Berührpunkt (x0|y0)
export function tangentLine(f, x0, { d = 0, deriv = null, normal = false } = {}) {
  if (!f || !Number.isFinite(x0) || depth > MAX_DEPTH) return null;
  depth++;
  try {
    const at = (k) => {
      const g = deriv && deriv(k);
      if (g) return g(x0);
      return k ? derivative(f, x0, k) : f(x0);
    };
    const y0 = at(d), m0 = at(d + 1);
    if (!Number.isFinite(y0) || !Number.isFinite(m0)) return null;
    let m = m0;
    if (normal) { if (Math.abs(m0) < 1e-12) return null; m = -1 / m0; }
    return { m, b: y0 - m * x0, x0, y0 };
  } finally { depth--; }
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
  if (node.t === 'tangent') out.add(node.f);
  if (node.t === 'param') out.add(node.n);
  for (const k of ['a', 'b', 'lo', 'hi', 'x0']) if (node[k]) usedNames(node[k], out);
  if (node.args) node.args.forEach(a => usedNames(a, out));
  return out;
}

// Nur die Funktionen, die ein Baum aufruft (ohne Parameter)
export function usedFunctions(node, known) {
  return [...usedNames(node)].filter(n => known[n]);
}

// ---------------------------------------------------------------------------
// Baum → LaTeX (für die Legende und Punktbeschriftungen)
// ---------------------------------------------------------------------------

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };

export function toTex(node) {
  const t = (n, parentPrec = 0) => {
    switch (n.t) {
      case 'num': return n.v === Infinity ? '\\infty' : n.v === -Infinity ? '-\\infty' : formatNumberTex(n.v, n.raw);
      case 'var': return n.n || 'x';
      case 'const': return n.n === 'pi' || n.n === 'π' ? '\\pi' : n.n === 'tau' ? '\\tau' : n.n === '∞' ? '\\infty' : 'e';
      case 'integral': return `\\int_{${t(n.lo)}}^{${t(n.hi)}} ${t(n.a)} \\,\\mathrm{d}${n.v}`;
      case 'tangent': return `\\operatorname{${n.normal ? 'Normale' : 'Tangente'}}\\left(${n.f}${"'".repeat(n.d || 0)}, ${t(n.x0)}\\right)`;
      case 'param': return n.n;
      // Brüche brauchen keine Klammer drumherum – sie sind schon eine Einheit
      case 'paren': return n.a.t === 'bin' && n.a.op === '/' ? t(n.a, parentPrec) : `\\left(${t(n.a)}\\right)`;
      // -2x und -x^2 brauchen keine Klammer, -(x + 1) schon
      case 'neg': return wrap('-' + t(n.a, n.a.t === 'bin' && n.a.op !== '+' && n.a.op !== '-' ? 2 : 3), 3, parentPrec);
      case 'bin': {
        const p = PREC[n.op];
        // Zähler, Nenner und Hochzahl stehen schon für sich – Klammern darin weglassen
        const bare = (m) => (m.t === 'paren' ? m.a : m);
        if (n.op === '/') return `\\frac{${t(bare(n.a))}}{${t(bare(n.b))}}`;
        if (n.op === '^') {
          const base = n.a.t === 'call' && n.a.f === 'sqrt' || n.a.t === 'bin' || n.a.t === 'neg' ? `\\left(${t(n.a)}\\right)` : t(n.a, 5);
          return `${base}^{${t(bare(n.b))}}`;
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
            // ln|x| statt ln(|x|)
            if (n.args.length === 1 && n.args[0].t === 'call' && (n.args[0].f === 'abs' || n.args[0].f === 'betrag')) return `${head}${a[0]}`;
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

// ---------------------------------------------------------------------------
// Ableiten (für die Legende: f'(x) = 2x) und Vereinfachen
// ---------------------------------------------------------------------------

const num = (v) => ({ t: 'num', v });
const isNum = (n, v) => n.t === 'num' && (v === undefined || Math.abs(n.v - v) < 1e-12);
const hasVar = (n, v) => {
  if (!n) return false;
  if (n.t === 'var') return (n.n || 'x') === v;
  if (n.t === 'call' && n.user) return n.args.some(a => hasVar(a, v));
  if (n.t === 'integral') return hasVar(n.lo, v) || hasVar(n.hi, v) || (n.v !== v && hasVar(n.a, v));
  if (n.t === 'tangent') return true;
  return ['a', 'b'].some(k => n[k] && hasVar(n[k], v)) || (n.args || []).some(a => hasVar(a, v));
};
const call = (f, a) => ({ t: 'call', f, args: [a] });
const bin = (op, a, b) => ({ t: 'bin', op, a, b });
const mul = (a, b) => bin('*', a, b);

// Variable ersetzen (Hauptsatz: (∫_0^x f(t) dt)' = f(x))
function substitute(n, v, by) {
  if (!n || typeof n !== 'object') return n;
  if (n.t === 'var' && (n.n || 'x') === v) return by;
  const out = { ...n };
  for (const k of ['a', 'b', 'lo', 'hi', 'x0']) if (n[k]) out[k] = substitute(n[k], v, by);
  if (n.args) out.args = n.args.map(a => substitute(a, v, by));
  return out;
}

// Ableitung nach x als neuer Baum; wirft, wenn etwas nicht ableitbar ist
export function differentiate(n, v = 'x') {
  const d = (m) => differentiate(m, v);
  if (!hasVar(n, v)) return num(0);
  switch (n.t) {
    case 'var': return num(1);
    case 'paren': return d(n.a);
    case 'neg': return { t: 'neg', a: d(n.a) };
    case 'bin': {
      const { a, b } = n;
      switch (n.op) {
        case '+': case '-': return bin(n.op, d(a), d(b));
        case '*': return bin('+', mul(d(a), b), mul(a, d(b)));
        case '/':
          if (!hasVar(b, v)) return bin('/', d(a), b);
          return bin('/', bin('-', mul(d(a), b), mul(a, d(b))), bin('^', b, num(2)));
        case '^':
          if (!hasVar(b, v)) return mul(mul(b, bin('^', a, bin('-', b, num(1)))), d(a));
          if (!hasVar(a, v)) return mul(mul(n, call('ln', a)), d(b));
          return mul(n, bin('+', mul(d(b), call('ln', a)), bin('/', mul(b, d(a)), a)));
      }
      break;
    }
    case 'call': {
      const u = n.args[0];
      if (n.user) return mul({ ...n, d: (n.d || 0) + 1 }, d(u));
      const du = d(u);
      switch (n.f) {
        case 'sin': return mul(call('cos', u), du);
        case 'cos': return mul({ t: 'neg', a: call('sin', u) }, du);
        case 'tan': return bin('/', du, bin('^', call('cos', u), num(2)));
        case 'exp': return mul(n, du);
        case 'ln': return bin('/', du, u);
        case 'log': case 'lg': if (n.args.length === 1) return bin('/', du, mul(u, call('ln', num(10)))); break;
        case 'sqrt': case 'wurzel': return bin('/', du, mul(num(2), call('sqrt', u)));
        case 'abs': case 'betrag': return bin('/', mul(u, du), call('abs', u));
        case 'asin': case 'arcsin': return bin('/', du, call('sqrt', bin('-', num(1), bin('^', u, num(2)))));
        case 'acos': case 'arccos': return { t: 'neg', a: bin('/', du, call('sqrt', bin('-', num(1), bin('^', u, num(2))))) };
        case 'atan': case 'arctan': return bin('/', du, bin('+', num(1), bin('^', u, num(2))));
        case 'sinh': return mul(call('cosh', u), du);
        case 'cosh': return mul(call('sinh', u), du);
      }
      break;
    }
    case 'integral':
      // Hauptsatz: obere Grenze x, untere fest
      if (n.hi.t === 'var' && (n.hi.n || 'x') === v && !hasVar(n.lo, v)) return substitute(n.a, n.v, { t: 'var', n: v });
      break;
  }
  throw new Error('nicht ableitbar');
}

const roundNum = (v) => { const r = Number(v.toPrecision(12)); return Object.is(r, -0) ? 0 : r; };

// Vereinfachen: Zahlen ausrechnen, ·1, +0, ^1 weglassen, Vorzeichen nach vorn
export function simplify(n) {
  if (!n || typeof n !== 'object') return n;
  switch (n.t) {
    case 'paren': return simplify(n.a);
    case 'neg': {
      const a = simplify(n.a);
      if (a.t === 'num') return num(roundNum(-a.v));
      if (a.t === 'neg') return a.a;
      return { t: 'neg', a };
    }
    case 'call': {
      const args = n.args.map(simplify);
      if ((n.f === 'ln') && args[0].t === 'const' && args[0].n === 'e') return num(1);
      if ((n.f === 'ln') && isNum(args[0], 1)) return num(0);
      return { ...n, args };
    }
    case 'bin': {
      let a = simplify(n.a), b = simplify(n.b);
      const op = n.op;
      if (a.t === 'num' && b.t === 'num') {
        const r = op === '+' ? a.v + b.v : op === '-' ? a.v - b.v : op === '*' ? a.v * b.v : op === '/' ? a.v / b.v : Math.pow(a.v, b.v);
        // Brüche bleiben Brüche (1/3), nur glatt aufgehende werden ausgerechnet
        if (Number.isFinite(r) && (op !== '/' || Number.isInteger(roundNum(r)))) return num(roundNum(r));
      }
      switch (op) {
        case '+':
          if (isNum(a, 0)) return b;
          if (isNum(b, 0)) return a;
          if (b.t === 'neg') return simplify(bin('-', a, b.a));
          if (b.t === 'num' && b.v < 0) return bin('-', a, num(-b.v));
          if (a.t === 'neg') return simplify(bin('-', b, a.a));
          return bin('+', a, b);
        case '-':
          if (isNum(b, 0)) return a;
          if (isNum(a, 0)) return simplify({ t: 'neg', a: b });
          if (b.t === 'neg') return simplify(bin('+', a, b.a));
          if (b.t === 'num' && b.v < 0) return bin('+', a, num(-b.v));
          return bin('-', a, b);
        case '*': {
          // Faktoren sammeln: Zahlen multiplizieren, Vorzeichen nach vorn
          const factors = [];
          let coef = 1;
          const take = (m) => {
            if (m.t === 'bin' && m.op === '*') { take(m.a); take(m.b); return; }
            if (m.t === 'neg') { coef = -coef; take(m.a); return; }
            if (m.t === 'num') { coef *= m.v; return; }
            factors.push(m);
          };
          take(a); take(b);
          coef = roundNum(coef);
          if (coef === 0) return num(0);
          if (!factors.length) return num(coef);
          // links anfangen (2·a·x statt 2·(a·x)), damit keine Klammern nötig sind
          if (Math.abs(coef) !== 1) factors.unshift(num(Math.abs(coef)));
          const prod = factors.reduce((x, y) => ({ t: 'bin', op: '*', a: x, b: y, implicit: true }));
          return coef < 0 ? { t: 'neg', a: prod } : prod;
        }
        case '/':
          if (isNum(a, 0)) return num(0);
          if (isNum(b, 1)) return a;
          if (a.t === 'neg') return { t: 'neg', a: bin('/', a.a, b) };
          if (a.t === 'num' && a.v < 0) return { t: 'neg', a: bin('/', num(-a.v), b) };
          return bin('/', a, b);
        case '^':
          if (isNum(b, 1)) return a;
          if (isNum(b, 0)) return num(1);
          return bin('^', a, b);
      }
      return { ...n, a, b };
    }
  }
  return n;
}

// Polynome (nur Zahlen, x, +, −, ·, ganze Potenzen) ausmultiplizieren und
// zusammenfassen: (x−1) − (x+1) → −2
function toPoly(n) {
  const add = (p, q, k = 1) => { const r = { ...p }; for (const d in q) r[d] = (r[d] || 0) + k * q[d]; return r; };
  const mulP = (p, q) => { const r = {}; for (const i in p) for (const j in q) r[+i + +j] = (r[+i + +j] || 0) + p[i] * q[j]; return r; };
  switch (n.t) {
    case 'num': return Number.isFinite(n.v) ? { 0: n.v } : null;
    case 'var': return (n.n || 'x') === 'x' ? { 1: 1 } : null;
    case 'paren': return toPoly(n.a);
    case 'neg': { const p = toPoly(n.a); return p && add({}, p, -1); }
    case 'bin': {
      const p = toPoly(n.a);
      if (!p) return null;
      if (n.op === '^') {
        const e = toPoly(n.b);
        if (!e || Object.keys(e).some(d => d !== '0')) return null;
        const k = e[0] || 0;
        if (!Number.isInteger(k) || k < 0 || k > 6) return null;
        let r = { 0: 1 };
        for (let i = 0; i < k; i++) r = mulP(r, p);
        return r;
      }
      const q = toPoly(n.b);
      if (!q) return null;
      if (n.op === '+') return add(p, q);
      if (n.op === '-') return add(p, q, -1);
      if (n.op === '*') return mulP(p, q);
      if (n.op === '/' && Object.keys(q).every(d => d === '0') && q[0]) return add({}, p, 1 / q[0]);
      return null;
    }
  }
  return null;
}

function polyTree(p) {
  const degs = Object.keys(p).map(Number).filter(d => Math.abs(roundNum(p[d])) > 1e-12).sort((a, b) => b - a);
  if (!degs.length) return num(0);
  let out = null;
  for (const d of degs) {
    const c = roundNum(p[d]);
    const pow = d === 0 ? null : d === 1 ? { t: 'var', n: 'x' } : bin('^', { t: 'var', n: 'x' }, num(d));
    const mag = Math.abs(c);
    const term = !pow ? num(mag) : mag === 1 ? pow : { t: 'bin', op: '*', a: num(mag), b: pow, implicit: true };
    if (!out) out = c < 0 ? { t: 'neg', a: term } : term;
    else out = bin(c < 0 ? '-' : '+', out, term);
  }
  return out;
}

function tidy(n) {
  const p = toPoly(n);
  if (p) return polyTree(p);
  if (n.t === 'bin' && (n.op === '+' || n.op === '-' || n.op === '*')) return simplify({ ...n, a: tidy(n.a), b: tidy(n.b) });
  if (n.t === 'bin' && n.op === '/') return simplify({ ...n, a: tidy(n.a) });
  if (n.t === 'neg') return simplify({ t: 'neg', a: tidy(n.a) });
  return n;
}

// n-te Ableitung als lesbarer Baum (oder null, wenn nicht ableitbar)
export function derive(tree, order = 1) {
  try {
    let t = tree;
    for (let k = 0; k < order; k++) t = tidy(simplify(differentiate(t)));
    return t;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Einschränkungen: "x^2 für x < 3", "0 < x < 4", "x > 0; x < 4",
// "x < -1 oder x > 1", "x ∈ [0; 3[ ∪ [5; 6]"
//
// Aufbau als kleiner Baum: iv (Grenzen), and (alles gilt), or (eins gilt),
// semi (Semikolon: einzelne Grenzen ergeben zusammen einen Bereich, ganze
// Bereiche werden vereinigt). Ausgerechnet wird erst mit den Parametern.
// ---------------------------------------------------------------------------

const REL = /(<=|>=|=<|=>|≤|≥|⩽|⩾|<|>)/;
const relInfo = (op) => ({ lt: /^(<|<=|=<|≤|⩽)$/.test(op), incl: /=|≤|≥|⩽|⩾/.test(op) });
const INTERVAL = /([\[\]\(])\s*([^\[\]()§;|]+?)\s*(?:;|\||,(?!\d))\s*([^\[\]()§;|]+?)\s*([\[\]\)])/g;

// Grenze lesen: Zahl, Term oder ±∞ – als Baum (wird später mit Parametern ausgewertet)
function boundTree(src, v = 'x') {
  const s = String(src).trim().replace(/^\+/, '');
  const inf = /^(-)?\s*(∞|oo|inf|infinity|unendlich)$/i.exec(s);
  if (inf) return num(inf[1] ? -Infinity : Infinity);
  const t = parseExpr(s);
  if (hasVar(t, v)) throw new Error('Grenze enthält ' + v);
  return t;
}

const iv = (lo, hi, loIncl, hiIncl) => ({ t: 'iv', lo, hi, loIncl: !!loIncl, hiIncl: !!hiIncl });

// → Bedingungsbaum oder null. v: Variable der Bedingung (y bei senkrechten Geraden: x = 3 für 0 ≤ y ≤ 4)
export function parseCondition(text, v = 'x') {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const brackets = [];
  s = s.replace(INTERVAL, (m, open, a, b, close) => { brackets.push({ open, a, b, close }); return ` §${brackets.length - 1}§ `; }).trim();
  const atom = (p) => {
    p = p.trim();
    const bm = new RegExp(`^(?:${v}\\s*(?:∈|in|el)\\s*|D(?:_?f)?\\s*=\\s*)?§(\\d+)§$`, 'i').exec(p);
    if (bm) {
      const b = brackets[+bm[1]];
      return iv(boundTree(b.a, v), boundTree(b.b, v), b.open === '[', b.close === ']');
    }
    const bits = p.split(REL).map(x => x.trim());
    if (bits.length < 3 || bits.length % 2 === 0) throw new Error('keine Bedingung');
    const xi = bits.findIndex((b, k) => k % 2 === 0 && b === v);
    if (xi < 0) throw new Error('keine Bedingung');
    const parts = [];
    for (const k of [xi - 1, xi + 1]) {
      if (k < 1 || k >= bits.length) continue;
      const r = relInfo(bits[k]);
      // a < x → untere Grenze; x < b → obere
      if (k < xi) parts.push(r.lt ? iv(boundTree(bits[k - 1], v), null, r.incl, false) : iv(null, boundTree(bits[k - 1], v), false, r.incl));
      else parts.push(r.lt ? iv(null, boundTree(bits[k + 1], v), false, r.incl) : iv(boundTree(bits[k + 1], v), null, r.incl, false));
    }
    if (parts.length === 1) return parts[0];
    const node = { t: 'and', parts };
    // "4 < x > 0": zwei untere (oder zwei obere) Grenzen – vermutlich anders gemeint
    const lows = parts.filter(q => q.lo), highs = parts.filter(q => q.hi);
    if (lows.length === 2 || highs.length === 2) {
      const [a, b] = [bits[xi - 2], bits[xi + 2]];
      const [lo, hi] = [a, b].sort((u, v) => (parseFloat(u.replace(',', '.')) || 0) - (parseFloat(v.replace(',', '.')) || 0));
      node.hint = lows.length === 2
        ? `„${p}“ heißt: ${v} > ${a} und ${v} > ${b}. Für ${v} zwischen ${lo} und ${hi}: ${lo} < ${v} < ${hi}`
        : `„${p}“ heißt: ${v} < ${a} und ${v} < ${b}. Für ${v} zwischen ${lo} und ${hi}: ${lo} < ${v} < ${hi}`;
    }
    return node;
  };
  const and = (p) => {
    const parts = p.split(/\s+(?:und|and)\s+|\s*(?:&&|∧)\s*|\s*,(?!\d)\s*/i).filter(x => x.trim());
    const nodes = parts.map(atom);
    return nodes.length === 1 ? nodes[0] : { t: 'and', parts: nodes };
  };
  const semi = (p) => {
    const parts = p.split(/\s*;\s*/).filter(x => x.trim());
    const nodes = parts.map(and);
    return nodes.length === 1 ? nodes[0] : { t: 'semi', parts: nodes };
  };
  try {
    const parts = s.split(/\s+(?:oder|or)\s+|\s*(?:∨|∪|\|\|)\s*/i).filter(x => x.trim());
    const nodes = parts.map(semi);
    const node = nodes.length === 1 ? nodes[0] : { t: 'or', parts: nodes };
    node.hint = node.hint || findHint(node);
    return node;
  } catch { return null; }
}

function findHint(n) {
  if (!n || n.t === 'iv') return null;
  if (n.hint) return n.hint;
  for (const p of n.parts || []) { const h = findHint(p); if (h) return h; }
  return null;
}

// Term und Einschränkung trennen: "x^2 für x < 3" → { body: "x^2", cond }
export function splitCondition(body, v = 'x') {
  const s = String(body || '');
  const tries = [];
  // {x < 3} am Ende (wie bei Desmos)
  const brace = /\{([^{}]*)\}\s*$/.exec(s);
  if (brace) tries.push([brace.index, brace[1]]);
  const word = /\s*(?:für|fuer|falls|wenn|mit)\s+/gi;
  let m;
  while ((m = word.exec(s))) if (m.index > 0) tries.push([m.index, s.slice(m.index + m[0].length)]);
  // Komma oder Semikolon außerhalb von Klammern
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('({'.includes(c)) depth++;
    else if (')}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || (c === ',' && !/\d/.test(s[i + 1] || '')))) tries.push([i, s.slice(i + 1)]);
  }
  tries.sort((a, b) => a[0] - b[0]);
  for (const [at, rest] of tries) {
    const cond = parseCondition(rest, v);
    if (cond) { cond.text = rest.trim(); return { body: s.slice(0, at).trim(), cond }; }
  }
  return { body: s, cond: null };
}

// ---------------------------------------------------------------------------
// Intervalle ausrechnen: Liste [{ lo, hi, loIncl, hiIncl }], sortiert, ohne Überlappung
// ---------------------------------------------------------------------------

const EMPTY = [];
function cut(a, b) {
  let lo, loIncl, hi, hiIncl;
  if (a.lo > b.lo) { lo = a.lo; loIncl = a.loIncl; } else if (b.lo > a.lo) { lo = b.lo; loIncl = b.loIncl; } else { lo = a.lo; loIncl = a.loIncl && b.loIncl; }
  if (a.hi < b.hi) { hi = a.hi; hiIncl = a.hiIncl; } else if (b.hi < a.hi) { hi = b.hi; hiIncl = b.hiIncl; } else { hi = a.hi; hiIncl = a.hiIncl && b.hiIncl; }
  if (lo > hi || (lo === hi && !(loIncl && hiIncl))) return null;
  return { lo, hi, loIncl, hiIncl };
}
const intersect = (A, B) => A.flatMap(a => B.map(b => cut(a, b)).filter(Boolean));
function union(lists) {
  const all = lists.flat().sort((a, b) => a.lo - b.lo || (b.loIncl - a.loIncl));
  const out = [];
  for (const x of all) {
    const last = out[out.length - 1];
    if (last && (x.lo < last.hi || (x.lo === last.hi && (x.loIncl || last.hiIncl)))) {
      if (x.hi > last.hi || (x.hi === last.hi && x.hiIncl)) { last.hi = x.hi; last.hiIncl = x.hiIncl; }
    } else out.push({ ...x });
  }
  return out;
}
const oneSided = (n) => n.t === 'iv' && (!n.lo || !n.hi);

// Grenzen mit Parametern ausrechnen → Liste von Intervallen (leer: nirgends)
export function evalCondition(cond, params) {
  if (!cond) return null;
  const val = (t, def) => {
    if (!t) return def;
    try { const v = compile(t, { params })(0); return Number.isNaN(v) ? def : v; } catch { return def; }
  };
  const ev = (n) => {
    switch (n.t) {
      case 'iv': {
        const c = cut({ lo: val(n.lo, -Infinity), hi: val(n.hi, Infinity), loIncl: n.lo ? n.loIncl : false, hiIncl: n.hi ? n.hiIncl : false },
          { lo: -Infinity, hi: Infinity, loIncl: false, hiIncl: false });
        return c ? [c] : EMPTY;
      }
      case 'and': return n.parts.map(ev).reduce(intersect);
      case 'or': return union(n.parts.map(ev));
      case 'semi': {
        // x > 0; x < 4 → 0 < x < 4 · x < -1; x > 1 → beides (Vereinigung)
        const lists = n.parts.map(ev);
        if (n.parts.every(oneSided)) {
          const both = lists.reduce(intersect);
          if (both.length) return both;
        }
        return union(lists);
      }
    }
    return EMPTY;
  };
  return ev(cond);
}

// Liegt x im erlaubten Bereich? (null = überall)
export function inInterval(ivs, x) {
  if (!ivs) return true;
  const list = Array.isArray(ivs) ? ivs : [ivs];
  for (const iv of list) {
    if (x < iv.lo || (x === iv.lo && !iv.loIncl && Number.isFinite(iv.lo))) continue;
    if (x > iv.hi || (x === iv.hi && !iv.hiIncl && Number.isFinite(iv.hi))) continue;
    return true;
  }
  return false;
}

// Für die Legende: "0 ≤ x < 3", "x < -1 oder x > 1" (v: Variable, y bei senkrechten Geraden)
export function conditionTex(cond, params = {}, v = 'x') {
  if (!cond) return '';
  const isInf = (t, v) => t && t.t === 'num' && t.v === v;
  const chain = (lo, loIncl, hi, hiIncl) => {
    const L = lo && !isInf(lo, -Infinity) ? toTex(lo) : null;
    const H = hi && !isInf(hi, Infinity) ? toTex(hi) : null;
    const rel = (incl) => (incl ? ' \\le ' : ' < ');
    if (L && H) return `${L}${rel(loIncl)}${v}${rel(hiIncl)}${H}`;
    if (H) return `${v}${rel(hiIncl)}${H}`;
    if (L) return `${v}${loIncl ? ' \\ge ' : ' > '}${L}`;
    return `${v} \\in \\mathbb{R}`;
  };
  // Mehrere einzelne Grenzen zu einer Kette zusammenfassen, wenn es genau eine untere und eine obere gibt
  const merged = (parts) => {
    if (!parts.every(p => p.t === 'iv')) return null;
    const los = parts.filter(p => p.lo), his = parts.filter(p => p.hi);
    if (los.length > 1 || his.length > 1) return null;
    return chain(los[0] && los[0].lo, los[0] && los[0].loIncl, his[0] && his[0].hi, his[0] && his[0].hiIncl);
  };
  const tex = (n) => {
    switch (n.t) {
      case 'iv': return chain(n.lo, n.loIncl, n.hi, n.hiIncl);
      case 'and': return merged(n.parts) || n.parts.map(tex).join(' \\text{ und } ');
      case 'or': return n.parts.map(tex).join(' \\text{ oder } ');
      case 'semi': {
        const res = evalCondition(n, params);
        const asOne = n.parts.every(oneSided) && res.length === 1 && Number.isFinite(res[0].lo) && Number.isFinite(res[0].hi) && merged(n.parts);
        return asOne || n.parts.map(tex).join(' \\text{ oder } ');
      }
    }
    return '';
  };
  return tex(cond);
}

// ---------------------------------------------------------------------------
// Stammfunktionen (für exakte Integralwerte und [F(x)] in der Legende)
// ---------------------------------------------------------------------------

// Bruch erkennen: 2,6666… → [8, 3]; nichts Passendes → null
export function toFraction(v, maxDen = 1000) {
  if (!Number.isFinite(v)) return null;
  const tol = 1e-9 * Math.max(1, Math.abs(v));
  let h0 = 1, h1 = 0, k0 = 0, k1 = 1, x = v;
  for (let i = 0; i < 20; i++) {
    const a = Math.floor(x);
    [h0, h1] = [a * h0 + h1, h0];
    [k0, k1] = [a * k0 + k1, k0];
    if (k0 > maxDen) return null;
    if (Math.abs(h0 / k0 - v) < tol) return [h0, k0];
    const r = x - a;
    if (r < 1e-12) break;
    x = 1 / r;
  }
  return null;
}

// Zahl als Baum, Brüche als Bruch (1/3 statt 0,333…)
export function numTree(v) {
  const f = toFraction(v);
  if (!f || f[1] === 1) return f ? num(f[0]) : num(roundNum(v));
  const t = bin('/', num(Math.abs(f[0])), num(f[1]));
  return f[0] < 0 ? { t: 'neg', a: t } : t;
}

// Linearer Term k·x + m? → { k, m } (für die Kettenregel rückwärts)
function linear(n) {
  const p = toPoly(n);
  if (!p || Object.keys(p).some(d => +d > 1)) return null;
  return { k: p[1] || 0, m: p[0] || 0 };
}

const isConst = (n) => !hasVar(n, 'x');

// Stammfunktion als Baum oder null (Summen, Faktoren, Potenzen, e, sin, cos, 1/x)
export function antiderivative(n) {
  if (!n) return null;
  const F = antiderivative;
  const X = { t: 'var', n: 'x' };
  if (isConst(n)) return mul(n, X);
  const p = toPoly(n);
  if (p) {
    const out = {};
    for (const d in p) out[+d + 1] = p[d] / (+d + 1);
    return polyTreeExact(out);
  }
  switch (n.t) {
    case 'paren': return F(n.a);
    case 'neg': { const a = F(n.a); return a && { t: 'neg', a }; }
    case 'bin': {
      if (n.op === '+' || n.op === '-') { const a = F(n.a), b = F(n.b); return a && b && bin(n.op, a, b); }
      if (n.op === '*') {
        if (isConst(n.a)) { const b = F(n.b); return b && mul(n.a, b); }
        if (isConst(n.b)) { const a = F(n.a); return a && mul(n.b, a); }
        return null;
      }
      if (n.op === '/') {
        if (isConst(n.b)) { const a = F(n.a); return a && bin('/', a, n.b); }
        // c / (k·x + m) → c/k · ln|k·x + m|
        const l = linear(n.b);
        if (isConst(n.a) && l && l.k) return mul(bin('/', n.a, numTree(l.k)), call('ln', call('abs', n.b)));
        return null;
      }
      if (n.op === '^') {
        const l = linear(n.a);
        // (k·x + m)^r → (k·x + m)^(r+1) / (k·(r+1)),  r = −1 → ln
        if (l && l.k && isConst(n.b)) {
          const r = compile(n.b)(0);
          if (!Number.isFinite(r)) return null;
          if (Math.abs(r + 1) < 1e-12) return bin('/', call('ln', call('abs', n.a)), numTree(l.k));
          return mul(numTree(1 / (l.k * (r + 1))), bin('^', n.a, numTree(r + 1)));
        }
        // e^(k·x + m) → e^(k·x + m) / k
        if (n.a.t === 'const' && n.a.n === 'e') { const e = linear(n.b); if (e && e.k) return mul(numTree(1 / e.k), n); }
        return null;
      }
      return null;
    }
    case 'call': {
      const u = n.args[0], l = linear(u);
      if (!l || !l.k) return null;
      const k = numTree(1 / l.k);
      switch (n.f) {
        case 'sin': return mul(k, { t: 'neg', a: call('cos', u) });
        case 'cos': return mul(k, call('sin', u));
        case 'exp': return mul(k, n);
        case 'sqrt': case 'wurzel': return mul(numTree(2 / (3 * l.k)), bin('^', u, bin('/', num(3), num(2))));
      }
      return null;
    }
  }
  return null;
}

// Polynom mit Brüchen als Koeffizienten: 1/3 x^3 statt 0,333 x^3
function polyTreeExact(p) {
  const degs = Object.keys(p).map(Number).filter(d => Math.abs(p[d]) > 1e-12).sort((a, b) => b - a);
  if (!degs.length) return num(0);
  let out = null;
  for (const d of degs) {
    const c = p[d];
    const pow = d === 0 ? null : d === 1 ? { t: 'var', n: 'x' } : bin('^', { t: 'var', n: 'x' }, num(d));
    const mag = Math.abs(c);
    const coef = numTree(mag);
    const term = !pow ? coef : isNum(coef, 1) ? pow : { t: 'bin', op: '*', a: coef, b: pow, implicit: true };
    if (!out) out = c < 0 ? { t: 'neg', a: term } : term;
    else out = bin(c < 0 ? '-' : '+', out, term);
  }
  return out;
}

// Aufrufe selbst definierter Funktionen durch ihren Term ersetzen: f(x) → x^2
export function inlineCalls(n, trees) {
  if (!n || typeof n !== 'object') return n;
  if (n.t === 'call' && n.user && !n.d && trees[n.f]) return { t: 'paren', a: substitute(trees[n.f], 'x', inlineCalls(n.args[0], trees)) };
  if (n.t === 'call' && n.user) return n;
  const out = { ...n };
  for (const k of ['a', 'b', 'lo', 'hi', 'x0']) if (n[k]) out[k] = inlineCalls(n[k], trees);
  if (n.args) out.args = n.args.map(a => inlineCalls(a, trees));
  return out;
}

// Stammfunktion lesbar (vereinfacht) – oder null
export function primitive(tree) {
  const F = antiderivative(tree);
  if (!F) return null;
  const p = toPoly(F);
  return p ? polyTreeExact(p) : simplify(F);
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
