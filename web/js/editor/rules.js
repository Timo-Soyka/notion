// Eingaberegeln: Markdown-Kürzel ("# ", "- ", "**fett**", "$x^2$"),
// Typografie ("->" → "→", „deutsche“ Anführungszeichen) und Symbole
// ("\alpha" + Leertaste → α). Alles passiert direkt beim Tippen.

import { toLatex } from '../core/typstmath.js';
import { htmlToSegs, segsToHTML, splitSegs, mergeSegs, applyMark, segsToText } from '../core/inline.js';
import * as caret from './caret.js';
import { block } from '../core/markdown.js';
import { defaultPlotConfig } from './blocks/plot.js';

const OBJ = '\uFFFC';

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
};
export const SYMBOLS = {
  ...GREEK,
  deg: '°', grad: '°', times: '×', cdot: '·', dot: '·', pm: '±', mp: '∓', neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  approx: '≈', infty: '∞', inf: '∞', sqrt: '√', sum: '∑', int: '∫', to: '→', rarr: '→', larr: '←', lrarr: '↔',
  Rightarrow: '⇒', imp: '⇒', iff: '⇔', Leftrightarrow: '⇔', equiv: '≡', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
  cup: '∪', cap: '∩', empty: '∅', emptyset: '∅', forall: '∀', exists: '∃', partial: '∂', nabla: '∇', angle: '∠', perp: '⊥',
  parallel: '∥', ohm: 'Ω', micro: 'µ', permil: '‰', euro: '€', check: '✓', cross: '✗', star: '★', half: '½', third: '⅓',
  quarter: '¼', sq: '²', cube: '³', prime: '′', eq: '⇌', up: '↑', down: '↓', ca: '≈', R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ'
};

let busy = false;

function plainOf(segs) {
  return segs.map(s => s.t === 'text' ? s.text : s.t === 'br' ? '\n' : OBJ).join('');
}

function inCode(el) {
  const s = window.getSelection();
  const n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
  return !!(n && n.closest && n.closest('code') && el.contains(n));
}

// Text im Bereich [from, to) durch neuen Text ersetzen. Bewusst direkt im
// DOM statt per execCommand: WebKit führt execCommand nicht aus, solange es
// noch ein anderes Eingabe-Ereignis verarbeitet.
function replaceRange(el, from, to, text) {
  busy = true;
  try {
    const a = caret.pointAt(el, from), z = caret.pointAt(el, to);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(z.node, z.offset);
    r.deleteContents();
    const tn = document.createTextNode(text);
    r.insertNode(tn);
    el.normalize();
    caret.setSelectionIn(el, from + text.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } finally { busy = false; }
}

// Text im Bereich [from, to) durch ein Atom (z. B. Ausrichtungspunkt) ersetzen
function replaceWithNode(el, from, to, node) {
  busy = true;
  try {
    const a = caret.pointAt(el, from), z = caret.pointAt(el, to);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(z.node, z.offset);
    r.deleteContents();
    // Unsichtbares Zeichen dahinter: sonst schreibt WebKit den folgenden Text in das Atom hinein
    r.insertNode(document.createTextNode('\u200B'));
    r.insertNode(node);
    el.normalize();
    caret.setSelectionIn(el, from + 1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } finally { busy = false; }
}

export function alignMarkNode(id = 1) {
  const span = document.createElement('span');
  span.className = 'am';
  span.contentEditable = 'false';
  span.dataset.id = String(id);
  return span;
}

function alignRule(ed, el, data, before, sel) {
  const f = ed._freshAm;
  if (data === '&') {
    // Zweimal "&" hintereinander ergibt ein ganz normales &-Zeichen
    if (f && f.el === el && sel.start === f.pos + 1 && before.slice(-2) === OBJ + '&') {
      ed._freshAm = null;
      replaceRange(el, sel.start - 2, sel.start, '&');
      ed.alignSoon && ed.alignSoon();
      return true;
    }
    ed.checkpoint();
    const node = alignMarkNode(1);
    replaceWithNode(el, sel.start - 1, sel.start, node);
    ed._freshAm = { el, node, pos: sel.start, digits: 0, id: 1 };
    ed.alignSoon && ed.alignSoon();
    return true;
  }
  if (/^\d$/.test(data) && f && f.el === el && f.node.isConnected && sel.start === f.pos + 1 && f.digits < 2 && before[before.length - 2] === OBJ) {
    const id = f.digits === 0 ? +data : f.id * 10 + +data;
    if (id < 1) return false;
    f.node.dataset.id = String(id);
    replaceRange(el, sel.start - 1, sel.start, '');
    ed._freshAm = { ...f, digits: f.digits + 1, id };
    ed.alignSoon && ed.alignSoon();
    return true;
  }
  return false;
}

export function runInputRules(ed, b, el, e) {
  if (busy || !e || !e.inputType || !e.inputType.startsWith('insert')) return;
  // Bei Diktat oder Autokorrektur kommen mehrere Zeichen auf einmal – dann
  // zählt das zuletzt eingefügte Zeichen.
  if (!e.data) return;
  const data = e.data[e.data.length - 1];
  const sel = caret.getSelectionIn(el);
  if (!sel || !sel.collapsed) return;
  const segs = htmlToSegs(el.innerHTML);
  const plain = plainOf(segs);
  const before = plain.slice(0, sel.start);

  // 1) Block-Kürzel am Zeilenanfang (nur in normalen Absätzen)
  if (b && b.type === 'p' && el.classList.contains('blk-text')) {
    if (blockRules(ed, b, el, data, before, segs, sel)) return;
  }
  if (inCode(el)) return;

  // 2) Inline-Auszeichnungen per Markdown
  if ('*_`~=$'.includes(data) && inlineRules(ed, el, data, before, segs, sel)) return;

  // 3) Ausrichtungspunkte: "&" wird ein farbiger Punkt, Ziffern direkt danach sind seine ID
  if (el.classList.contains('blk-text') && ed.settings.textAlignMarks !== false) {
    if (alignRule(ed, el, data, before, sel)) return;
  }
  ed._freshAm = null;

  // 4) Symbole mit Backslash
  if (data === ' ') {
    const m = /\\([A-Za-z]+) $/.exec(before);
    if (m && SYMBOLS[m[1]]) { replaceRange(el, sel.start - m[0].length, sel.start, SYMBOLS[m[1]] + ' '); return; }
  }

  // 5) Typografie
  if (ed.settings.typography === false) return;
  typography(el, data, before, sel);
}

function blockRules(ed, b, el, data, before, segs, sel) {
  const convert = (prefixLen, type, props = {}) => {
    ed.checkpoint();
    const [, rest] = splitSegs(segs, prefixLen);
    b.html = segsToHTML(rest);
    ed.dirtyText.delete(b.id);
    ed.setType(b, type, props);
    const t = ed.textElOf(b);
    if (t) { t.focus(); caret.setSelectionIn(t, 0); }
    return true;
  };
  if (data === ' ') {
    let m;
    if ((m = /^(#{1,3}) $/.exec(before))) return convert(m[0].length, 'h' + m[1].length);
    if (/^[-*+] $/.test(before)) return convert(2, 'ul');
    if ((m = /^(\d{1,4})[.)] $/.exec(before))) return convert(m[0].length, 'ol', +m[1] !== 1 ? { start: +m[1] } : {});
    if (/^\[\s?\] $/.test(before)) return convert(before.length, 'todo', { checked: false });
    if (/^\[[xX]\] $/.test(before)) return convert(before.length, 'todo', { checked: true });
    if (/^> $/.test(before)) return convert(2, 'toggle', { open: true });
    if (/^["„“] $/.test(before)) return convert(2, 'quote');
    if (/^! $/.test(before)) {
      convert(2, 'callout', { kind: 'merke' });
      const p = block('p');
      ed.insertChildAt(b, 0, [p]);
      ed.focusBlock(b, 'start');
      return true;
    }
  }
  const whole = segsToText(segs);
  const replaceWithAtom = (type, props) => {
    ed.checkpoint();
    b.html = '';
    ed.dirtyText.delete(b.id);
    ed.setType(b, type, props);
    return true;
  };
  if (data === '-' && before === '---' && whole === '---') {
    ed.checkpoint();
    b.html = '';
    const nb = ed.setType(b, 'hr');
    return true;
  }
  if (data === '`' && before === '```' && whole === '```') return replaceWithAtom('code', { lang: '', text: '' });
  if (data === '$' && before === '$$' && whole === '$$') return replaceWithAtom('math', { tex: '' });
  return false;
}

function inlineRules(ed, el, data, before, segs, sel) {
  const rules = [
    { ch: '`', re: /`([^`]+)`$/, open: 1, close: 1, mark: 'code' },
    { ch: '$', re: /(?:^|[^$\\\w])\$([^$\s](?:[^$]*[^$\s\\])?)\$$/, open: 1, close: 1, math: true },
    { ch: '*', re: /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, open: 2, close: 2, mark: 'b' },
    { ch: '_', re: /(?:^|\s)__([^_\s](?:[^_]*[^_\s])?)__$/, open: 2, close: 2, mark: 'b' },
    { ch: '*', re: /(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, open: 1, close: 1, mark: 'i' },
    { ch: '_', re: /(?:^|\s)_([^_\s](?:[^_]*[^_\s])?)_$/, open: 1, close: 1, mark: 'i' },
    { ch: '~', re: /~~([^~]+)~~$/, open: 2, close: 2, mark: 's' },
    { ch: '=', re: /==([^=]+)==$/, open: 2, close: 2, mark: 'hl', value: 'yellow' }
  ];
  for (const r of rules) {
    if (r.ch !== data) continue;
    const m = r.re.exec(before);
    if (!m) continue;
    const inner = m[1];
    if (inner.includes(OBJ) && !r.math) continue;
    const end = sel.start;
    const start = end - r.close - inner.length - r.open;
    ed.checkpoint();
    const [L, rest] = splitSegs(segs, start);
    const [, rest2] = splitSegs(rest, r.open);
    const [mid, rest3] = splitSegs(rest2, inner.length);
    const [, R] = splitSegs(rest3, r.close);
    let out, pos;
    if (r.math) {
      out = mergeSegs([...L, { t: 'math', tex: toLatex(segsToText(mid), 'auto'), m: {} }, ...R]);
      pos = start + 1;
    } else {
      out = mergeSegs([...L, ...applyMark(mid, 0, inner.length, r.mark, r.value || true), ...R]);
      pos = start + inner.length;
    }
    ed.replaceInline(el, segsToHTML(out), { start: pos, end: pos });
    escapeMark(el);
    return true;
  }
  return false;
}

// Nach "**fett**" soll normal weitergeschrieben werden: Cursor hinter das
// Auszeichnungs-Element setzen (mit unsichtbarem Platzhalter, den die
// Normalisierung später wieder entfernt).
function escapeMark(el) {
  const s = window.getSelection();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  let node = r.startContainer;
  if (node.nodeType === 3 && r.startOffset !== node.data.length) return;
  let top = node.nodeType === 3 ? node.parentElement : node;
  if (!top || top === el) return;
  while (top.parentElement && top.parentElement !== el) top = top.parentElement;
  if (top.parentElement !== el || top.classList.contains('im')) return;
  let next = top.nextSibling;
  if (!next || next.nodeType !== 3) {
    next = document.createTextNode('\u200B');
    top.after(next);
  }
  const nr = document.createRange();
  nr.setStart(next, next.data.startsWith('\u200B') ? 1 : 0);
  nr.collapse(true);
  s.removeAllRanges();
  s.addRange(nr);
}

function typography(el, data, before, sel) {
  const at = sel.start;
  const rep = (len, text) => replaceRange(el, at - len, at, text);
  switch (data) {
    case '>':
      if (before.endsWith('<->')) return rep(3, '↔');
      if (before.endsWith('←>')) return rep(2, '↔');
      if (before.endsWith('<=>')) return rep(3, '⇔');
      if (before.endsWith('≤>')) return rep(2, '⇔');
      if (before.endsWith('->') && !before.endsWith('-->')) return rep(2, '→');
      if (before.endsWith('=>')) return rep(2, '⇒');
      return;
    case '-':
      if (before.endsWith('<-')) return rep(2, '←');
      if (before.endsWith('+-')) return rep(2, '±');
      // "--" → Halbgeviertstrich, aber nicht am Zeilenanfang ("---" = Trennlinie)
      if (before.endsWith('–-')) return rep(2, '—');
      if (before.endsWith('--') && before.length > 2 && before[before.length - 3] !== '-') return rep(2, '–');
      return;
    case '=':
      if (before.endsWith('!=')) return rep(2, '≠');
      if (before.endsWith('<=')) return rep(2, '≤');
      if (before.endsWith('>=')) return rep(2, '≥');
      if (before.endsWith('~=')) return rep(2, '≈');
      return;
    case '.':
      if (before.endsWith('...')) return rep(3, '…');
      return;
    case '"': {
      const prev = before.slice(0, -1);
      const open = prev === '' || /[\s(\[{\/–—-]$/.test(prev);
      return rep(1, open ? '„' : '“');
    }
    case "'": {
      const prev = before.slice(0, -1);
      if (/[\p{L}\p{N}]$/u.test(prev)) return rep(1, '’');
      return rep(1, '‚');
    }
    default: return;
  }
}
