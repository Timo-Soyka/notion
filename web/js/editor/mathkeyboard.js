// Mathe-Tastatur fürs iPad.
//
// Statt der normalen Bildschirmtastatur erscheint unter Formelfeldern eine
// eigene Tastatur mit allem, was man im Matheheft braucht: Ziffern und
// Rechenzeichen, Bruch, Wurzel, Hochzahl, Funktionen, Integrale, griechische
// Buchstaben, Einheiten und die Heft-Besonderheiten (Ausrichtungspunkt,
// Kommandostrich). Die Tasten nehmen dem Formelfeld nie den Fokus weg.

import { h } from '../ui/ui.js';
import { renderToString } from './render/katex.js';
import { icon } from '../ui/icons.js';

const P = '#?';   // Kästchen (wird zu \placeholder{})

// Tasten: l = Beschriftung (Text), t = Beschriftung als Formel,
// ins = LaTeX einfügen, typ = Zeichen wie getippt, key = Taste (wie echte Taste), c = Klasse
const k = (l, spec = {}) => ({ l, ...spec });
const ins = (l, tex, extra = {}) => k(l, { ins: tex, ...extra });
const typ = (l, chars = l, extra = {}) => k(l, { typ: chars, ...extra });

const LAYERS = [
  {
    id: 'zahlen', label: '123', rows: [
      [typ('7', '7', { c: 'num' }), typ('8', '8', { c: 'num' }), typ('9', '9', { c: 'num' }), typ(':', ':', { c: 'op' }), typ('(', '('), typ(')', ')'), ins('x²', '#@^{2}', { t: 'x^2' }), ins('xⁿ', `#@^{${P}}`, { t: 'x^{\\square}' }), ins('√', `\\sqrt{${P}}`, { t: '\\sqrt{\\square}' }), ins('ⁿ√', `\\sqrt[${P}]{${P}}`, { t: '\\sqrt[\\square]{\\square}' })],
      [typ('4', '4', { c: 'num' }), typ('5', '5', { c: 'num' }), typ('6', '6', { c: 'num' }), ins('·', '\\cdot ', { c: 'op' }), typ('[', '['), typ(']', ']'), ins('xₙ', `#@_{${P}}`, { t: 'x_{\\square}' }), ins('Bruch', `\\frac{${P}}{${P}}`, { t: '\\frac{\\square}{\\square}' }), ins('|x|', `\\left|${P}\\right|`, { t: '\\left|\\square\\right|' }), ins('π', '\\pi ', { t: '\\pi' })],
      [typ('1', '1', { c: 'num' }), typ('2', '2', { c: 'num' }), typ('3', '3', { c: 'num' }), typ('−', '-', { c: 'op' }), typ('<', '<'), typ('>', '>'), ins('≤', '\\le ', { t: '\\le' }), ins('≥', '\\ge ', { t: '\\ge' }), ins('≈', '\\approx ', { t: '\\approx' }), ins('≠', '\\ne ', { t: '\\ne' })],
      [typ('0', '0', { c: 'num' }), typ(',', ',', { c: 'num' }), typ('=', '=', { c: 'op' }), typ('+', '+', { c: 'op' }), typ('x', 'x', { c: 'var' }), typ('y', 'y', { c: 'var' }), ins('±', '\\pm ', { t: '\\pm' }), ins('∞', '\\infty ', { t: '\\infty' }), ins('e', '\\mathrm{e}', { t: '\\mathrm{e}' }), typ('%', '%')]
    ]
  },
  {
    id: 'funktionen', label: 'f(x)', rows: [
      [ins('sin', '\\sin(#?)', { t: '\\sin' }), ins('cos', '\\cos(#?)', { t: '\\cos' }), ins('tan', '\\tan(#?)', { t: '\\tan' }), ins('sin⁻¹', '\\sin^{-1}(#?)', { t: '\\sin^{-1}' }), ins('cos⁻¹', '\\cos^{-1}(#?)', { t: '\\cos^{-1}' }), ins('tan⁻¹', '\\tan^{-1}(#?)', { t: '\\tan^{-1}' }), ins('ln', '\\ln(#?)', { t: '\\ln' }), ins('log', `\\log_{${P}}(${P})`, { t: '\\log_{\\square}' }), ins('lg', '\\lg(#?)', { t: '\\lg' }), ins('eˣ', `\\mathrm{e}^{${P}}`, { t: '\\mathrm{e}^{\\square}' })],
      [ins('f(x)', 'f(x)', { t: 'f(x)' }), ins("f'(x)", "f^{\\prime}(x)", { t: "f'(x)" }), ins("f''(x)", "f^{\\prime\\prime}(x)", { t: "f''(x)" }), ins('d/dx', `\\frac{\\mathrm{d}}{\\mathrm{d}x}`, { t: '\\frac{\\mathrm{d}}{\\mathrm{d}x}' }), ins('∫ₐᵇ', `\\int_{${P}}^{${P}}${P}\\,\\mathrm{d}x`, { t: '\\int_a^b' }), ins('∫', `\\int ${P}\\,\\mathrm{d}x`, { t: '\\int' }), ins('[F]ₐᵇ', `\\left[${P}\\right]_{${P}}^{${P}}`, { t: '\\left[F\\right]_a^b' }), ins('lim', `\\lim_{${P}\\to ${P}}`, { t: '\\lim' }), ins('→', '\\to ', { t: '\\to' }), ins('n!', '#@!', { t: 'n!' })],
      [ins('Σ', `\\sum_{${P}}^{${P}}`, { t: '\\sum' }), ins('Π', `\\prod_{${P}}^{${P}}`, { t: '\\prod' }), ins('(ⁿₖ)', `\\binom{${P}}{${P}}`, { t: '\\binom{n}{k}' }), ins('[a;b]', `\\left[${P};${P}\\right]`, { t: '[a;b]' }), ins(']a;b[', `\\left]${P};${P}\\right[`, { t: ']a;b[' }), ins('∈', '\\in ', { t: '\\in' }), ins('∉', '\\notin ', { t: '\\notin' }), ins('ℝ', '\\mathbb{R}', { t: '\\mathbb{R}' }), ins('ℕ', '\\mathbb{N}', { t: '\\mathbb{N}' }), ins('ℤ', '\\mathbb{Z}', { t: '\\mathbb{Z}' })],
      [ins('ℚ', '\\mathbb{Q}', { t: '\\mathbb{Q}' }), ins('⇒', '\\Rightarrow ', { t: '\\Rightarrow' }), ins('⇔', '\\Leftrightarrow ', { t: '\\Leftrightarrow' }), ins('{ }', `\\left\\{${P}\\right\\}`, { t: '\\{\\square\\}' }), ins('∪', '\\cup ', { t: '\\cup' }), ins('∩', '\\cap ', { t: '\\cap' }), ins('∅', '\\emptyset ', { t: '\\emptyset' }), ins('⃗v', `\\vec{${P}}`, { t: '\\vec{v}' }), ins('x̄', `\\overline{${P}}`, { t: '\\overline{x}' }), ins('Δ', '\\Delta ', { t: '\\Delta' })]
    ]
  },
  {
    id: 'symbole', label: 'αβγ', rows: [
      ['alpha', 'beta', 'gamma', 'delta', 'varepsilon', 'lambda', 'mu', 'varphi', 'omega', 'pi'].map(n => ins(n, `\\${n} `, { t: `\\${n}` })),
      ['Delta', 'Sigma', 'Omega', 'theta', 'rho', 'sigma', 'tau', 'eta', 'Phi', 'Lambda'].map(n => ins(n, `\\${n} `, { t: `\\${n}` })),
      [ins('∠', '\\angle ', { t: '\\angle' }), ins('⊥', '\\perp ', { t: '\\perp' }), ins('∥', '\\parallel ', { t: '\\parallel' }), ins('°', '^{\\circ}', { t: '{}^{\\circ}' }), ins('≡', '\\equiv ', { t: '\\equiv' }), ins('∼', '\\sim ', { t: '\\sim' }), ins('×', '\\times ', { t: '\\times' }), ins('∘', '\\circ ', { t: '\\circ' }), ins('‰', '‰'), ins('…', '\\ldots ', { t: '\\ldots' })],
      [ins('∀', '\\forall ', { t: '\\forall' }), ins('∃', '\\exists ', { t: '\\exists' }), ins('⊂', '\\subset ', { t: '\\subset' }), ins('⊆', '\\subseteq ', { t: '\\subseteq' }), ins('¬', '\\neg ', { t: '\\neg' }), ins('∧', '\\land ', { t: '\\land' }), ins('∨', '\\lor ', { t: '\\lor' }), ins('↦', '\\mapsto ', { t: '\\mapsto' }), ins('⇌', '\\rightleftharpoons ', { t: '\\rightleftharpoons' }), ins('′', '^{\\prime}', { t: "x'" })]
    ]
  },
  {
    id: 'abc', label: 'abc', rows: [
      'qwertzuiop'.split('').map(ch => typ(ch, ch, { c: 'var' })),
      'asdfghjkl'.split('').map(ch => typ(ch, ch, { c: 'var' })),
      [k('⇧', { act: 'shift', c: 'mod' }), ...'yxcvbnm'.split('').map(ch => typ(ch, ch, { c: 'var' })), k('Text', { act: 'text', c: 'mod' })],
      [k('Leerzeichen', { ins: '\\;', w: 4 }), ins('„für“', '\\text{ für }'), ins('„und“', '\\text{ und }'), ins('„oder“', '\\text{ oder }')]
    ]
  },
  {
    id: 'heft', label: 'Einheiten', rows: [
      ['mm', 'cm', 'dm', 'm', 'km', 'mg', 'g', 'kg', 't', 'ml'].map(u => ins(u, `\\,\\text{${u}}`)),
      [['l', 'l'], ['s', 's'], ['min', 'min'], ['h', 'h'], ['N', 'N'], ['J', 'J'], ['W', 'W'], ['V', 'V'], ['A', 'A'], ['Ω', '\\Omega']].map(([l, u]) => ins(l, u.startsWith('\\') ? `\\,${u}` : `\\,\\text{${u}}`)),
      [ins('cm²', '\\,\\text{cm}^2'), ins('m²', '\\,\\text{m}^2'), ins('cm³', '\\,\\text{cm}^3'), ins('m³', '\\,\\text{m}^3'), ins('°C', '\\,^{\\circ}\\text{C}'), ins('K', '\\,\\text{K}'), ins('mol', '\\,\\text{mol}'), ins('km/h', '\\,\\tfrac{\\text{km}}{\\text{h}}'), ins('m/s', '\\,\\tfrac{\\text{m}}{\\text{s}}'), ins('g/mol', '\\,\\tfrac{\\text{g}}{\\text{mol}}')],
      [k('& ausrichten', { typ: '&', w: 2, c: 'mod' }), k('| Kommandostrich', { ins: '\\heftbar', w: 3, c: 'mod' }), k('Isotop', { act: 'isotope', w: 2, c: 'mod' }), ins('Stapel', `{${P}\\atop${P}}`, { w: 2, c: 'mod' })]
    ]
  }
];

let enabled = true;
let collapsed = false;
try { collapsed = localStorage.getItem('heft-mathkbd-min') === '1'; } catch { /* egal */ }

// Ein-/ausschalten (Einstellungen → iPad); ohne Tastatur kommt die normale
export function setMathKeyboard(on) { enabled = on !== false; if (!enabled) hide(); }
export const mathKeyboardEnabled = () => enabled;

let panel = null, showBtn = null, field = null, layer = 'zahlen', shift = false, hideTimer = 0;

const isMF = (el) => el && el.matches && el.matches('math-field.heft-mf');

export function installMathKeyboard() {
  document.addEventListener('focusin', (e) => {
    const mf = e.target && e.target.closest && e.target.closest('math-field.heft-mf');
    if (mf && enabled) { clearTimeout(hideTimer); show(mf); }
  }, true);
  document.addEventListener('focusout', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!isMF(document.activeElement)) hide(); }, 150);
  }, true);
}

function sinkOf(mf) { return mf && mf.shadowRoot && mf.shadowRoot.querySelector('.ML__keyboard-sink'); }

// Echte Taste nachmachen (Rücktaste, Pfeile, Tab, Enter) – so greifen auch Heft-Sonderfälle
function press(mf, key) {
  const target = sinkOf(mf) || mf;
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, composed: true, cancelable: true }));
}

function changed(mf) { mf.dispatchEvent(new Event('input', { bubbles: true, composed: true })); }

function apply(spec) {
  const mf = field;
  if (!mf || !mf.isConnected) return;
  if (spec.act === 'shift') { shift = !shift; render(); return; }
  if (spec.act === 'text') { mf.insert('\\text{\\placeholder{}}', { selectionMode: 'placeholder', format: 'latex' }); changed(mf); return; }
  if (spec.act === 'isotope') { if (mf.insertIsotope) mf.insertIsotope(); return; }
  if (spec.key) { press(mf, spec.key); return; }
  if (spec.typ !== undefined) {
    const s = shift && /^[a-z]$/.test(spec.typ) ? spec.typ.toUpperCase() : spec.typ;
    for (const ch of s) mf.executeCommand(['typedText', ch, { simulateKeystroke: true }]);
    if (shift) { shift = false; render(); }
    changed(mf);
    return;
  }
  if (spec.ins !== undefined) {
    const tex = spec.ins.replace(/#\?/g, '\\placeholder{}');
    mf.insert(tex, { format: 'latex', selectionMode: tex.includes('\\placeholder') ? 'placeholder' : 'after' });
    changed(mf);
  }
}

function keyEl(spec) {
  const b = h('button', { class: 'mk-key' + (spec.c ? ' ' + spec.c : ''), type: 'button' });
  if (spec.w) b.style.gridColumn = `span ${spec.w}`;
  const shown = shift && spec.typ && /^[a-z]$/.test(spec.typ) ? spec.typ.toUpperCase() : null;
  if (spec.t && !shown) {
    const r = renderToString(spec.t, { display: false, mode: 'latex' });
    if (r.html) b.innerHTML = r.html; else b.textContent = spec.l;
  } else b.textContent = shown || spec.l;
  bindKey(b, () => apply(spec), spec.key === 'Backspace');
  return b;
}

// Tippen löst sofort aus (pointerdown) und nimmt dem Formelfeld nicht den Fokus;
// gedrückt gehaltene Rücktaste löscht weiter
function bindKey(b, fn, repeat = false) {
  let t1 = 0, t2 = 0;
  const stop = () => { clearTimeout(t1); clearInterval(t2); b.classList.remove('down'); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.classList.add('down');
    fn();
    if (repeat) t1 = setTimeout(() => { t2 = setInterval(fn, 70); }, 420);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, stop);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => e.preventDefault());
}

function build() {
  panel = h('div', { class: 'math-kbd' });
  showBtn = h('button', { class: 'math-kbd-show', type: 'button', text: '∑ Mathe-Tastatur' });
  bindKey(showBtn, () => { collapsed = false; save(); show(field); });
  document.body.append(panel, showBtn);
}

function save() { try { localStorage.setItem('heft-mathkbd-min', collapsed ? '1' : '0'); } catch { /* egal */ } }

function render() {
  if (!panel) build();
  panel.innerHTML = '';
  const top = h('div', { class: 'mk-top' });
  for (const L of LAYERS) {
    const tab = h('button', { class: 'mk-tab' + (L.id === layer ? ' on' : ''), type: 'button', text: L.label });
    bindKey(tab, () => { layer = L.id; shift = false; render(); });
    top.append(tab);
  }
  top.append(h('span', { class: 'grow' }));
  const tool = (label, fn, cls = '', html = '') => { const b = h('button', { class: 'mk-tool ' + cls, type: 'button', text: label }); if (html) b.innerHTML = html; bindKey(b, fn); top.append(b); return b; };
  tool('', () => field && field.executeCommand('undo'), '', icon('undo', 'sm')).setAttribute('aria-label', 'Rückgängig');
  tool('', () => field && field.executeCommand('redo'), '', icon('redo', 'sm')).setAttribute('aria-label', 'Wiederholen');
  tool('Einklappen', () => { collapsed = true; save(); show(field); });
  tool('Fertig', () => {
    const ed = window.heftApp && window.heftApp.editor;
    if (ed && ed.activeAtom) ed.deactivate(); else if (field) field.blur();
    hide();
  }, 'done');
  // Jede Reihe für sich – kürzere Reihen rutschen sonst in die Reihe darüber
  const grid = h('div', { class: 'mk-grid' });
  for (const row of LAYERS.find(L => L.id === layer).rows) {
    const r = h('div', { class: 'mk-row' });
    for (const spec of row) r.append(keyEl(spec));
    grid.append(r);
  }
  const side = h('div', { class: 'mk-side' });
  for (const spec of [k('⌫', { key: 'Backspace', c: 'mod' }), k('←', { key: 'ArrowLeft', c: 'mod' }), k('→', { key: 'ArrowRight', c: 'mod' }), k('⇥ Kästchen', { key: 'Tab', c: 'mod' }), k('↵ Zeile', { key: 'Enter', c: 'enter' })]) side.append(keyEl(spec));
  panel.append(top, h('div', { class: 'mk-body' }, grid, side));
}

function show(mf) {
  field = mf || field;
  if (!panel) build();
  if (collapsed) {
    panel.classList.remove('open');
    showBtn.classList.add('open');
    document.body.classList.remove('mathkbd-open');
    return;
  }
  render();
  showBtn.classList.remove('open');
  panel.classList.add('open');
  document.body.classList.add('mathkbd-open');
  document.documentElement.style.setProperty('--mk-h', panel.offsetHeight + 'px');
  // Formel nicht unter der Tastatur verstecken
  requestAnimationFrame(() => {
    if (!field) return;
    const r = field.getBoundingClientRect();
    const limit = window.innerHeight - panel.offsetHeight - 24;
    if (r.bottom > limit) {
      const view = field.closest('.view') || document.scrollingElement;
      view.scrollBy({ top: r.bottom - limit + 40, behavior: 'smooth' });
    }
  });
}

function hide() {
  if (panel) panel.classList.remove('open');
  if (showBtn) showBtn.classList.remove('open');
  document.body.classList.remove('mathkbd-open');
}
