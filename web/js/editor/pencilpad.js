// Schreibfeld für den Apple Pencil (iPad).
//
// In Formelfelder (MathLive) kann iPadOS nicht mit Scribble hineinschreiben.
// Deshalb bekommen geöffnete Blöcke – Formel, Reaktionsgleichung, Graph,
// Strukturformel – ein gewöhnliches Textfeld, in das man mit dem Pencil
// schreibt. Nach einer kurzen Pause (oder mit „Einfügen“) wird das
// Geschriebene ausgewertet und in den Block übernommen.

import { h } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { on } from '../bridge.js';

let known = false;
let lastPen = 0;
try { known = localStorage.getItem('heft-pencil') === '1'; } catch { /* egal */ }

function remember() {
  if (known) return;
  known = true;
  try { localStorage.setItem('heft-pencil', '1'); } catch { /* egal */ }
  // Ein gerade geöffneter Block soll das Schreibfeld sofort bekommen
  document.dispatchEvent(new Event('heft-pencil'));
}

// Pencil erkennen: die App meldet die erste Berührung, außerdem Stift-Tipps im Web
export function watchPencil() {
  on('pencil-seen', remember);
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return;
    lastPen = Date.now();
    remember();
  }, true);
}

export const pencilKnown = () => known || window.HeftPencil === true;

// Blöcke mit Schreibfeld; der Block selbst legt beim Öffnen `atom._hw(text, opts)` an
// (Formeln und Graphen haben dafür die Mathe-Tastatur)
export const PENCIL_TYPES = new Set(['chem', 'smiles']);

const HINT = {
  math: 'Mit dem Pencil hier schreiben – z. B.  x² + wurzel 9 = 1/2',
  chem: 'Mit dem Pencil hier schreiben – z. B.  2H2 + O2 -> 2H2O',
  plot: 'Mit dem Pencil hier schreiben – z. B.  f(x) = x² − 2',
  smiles: 'Mit dem Pencil den Namen schreiben – z. B.  Ethanol'
};

const NEWLINE = { math: 'Neue Zeile', plot: 'Neue Funktion' };

export function attachPencilPad(ed, b, main) {
  const target = main.querySelector('.atom');
  if (!target || main.querySelector('.pencil-pad')) return null;
  const ta = h('textarea', {
    class: 'pencil-input', rows: '1', placeholder: HINT[b.type] || 'Mit dem Pencil hier schreiben',
    autocapitalize: 'none', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false'
  });
  const ok = h('button', { class: 'btn sm primary' }, icon('check', 'sm'), 'Einfügen');
  const pad = h('div', { class: 'pencil-pad' }, h('span', { class: 'pencil-ic', html: icon('pen', 'sm') }), ta, ok);
  let nl = null;
  if (NEWLINE[b.type]) { nl = h('button', { class: 'btn sm outline' }, NEWLINE[b.type]); pad.append(nl); }
  // Unter den Block (in dessen Bearbeitungsbereich), nicht daneben
  target.append(pad);

  let timer = 0;
  let busy = false;
  const commit = async (opts = {}) => {
    clearTimeout(timer);
    const text = ta.value.trim();
    if ((!text && !opts.newLine) || busy) return;
    busy = true;
    ta.value = '';
    try { if (target._hw) await target._hw(text, opts); }
    catch (err) { console.error(err); }
    finally { busy = false; }
    // Weiterschreiben können – nach dem Fokus neuer Formelzeilen (bei Programm-Fokus zeigt iPadOS keine Tastatur)
    setTimeout(() => { if (ta.isConnected && document.activeElement !== ta) ta.focus({ preventScroll: true }); }, 120);
  };
  // Scribble setzt Wort für Wort ein – erst nach einer Schreibpause übernehmen
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(commit, 1500); });
  ta.addEventListener('keydown', (e) => {
    // Nicht an den Editor weiterreichen (Enter, Rücktaste …)
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit({ newLine: e.shiftKey }); }
    if (e.key === 'Escape') { e.preventDefault(); ed.deactivate({ select: true }); }
  });
  ta.addEventListener('blur', () => { if (ta.value.trim()) commit(); });
  for (const bt of [ok, nl].filter(Boolean)) bt.addEventListener('mousedown', (e) => e.preventDefault());
  ok.addEventListener('click', () => commit());
  nl && nl.addEventListener('click', () => commit({ newLine: true }));
  // Mit dem Pencil geöffnet: gleich ins Schreibfeld
  if (Date.now() - lastPen < 1500) setTimeout(() => { if (ta.isConnected) ta.focus({ preventScroll: true }); }, 350);
  return ta;
}
