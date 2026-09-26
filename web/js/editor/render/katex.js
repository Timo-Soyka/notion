// KaTeX-Darstellung mit Zwischenspeicher.
//
// Formeln werden beim Tippen ständig neu gezeichnet; der Cache hält die fertigen
// HTML-Schnipsel, damit das Umschalten zwischen Blöcken nicht ruckelt.

import { toLatex } from '../../core/typstmath.js';
import { repairLatex } from '../../core/mathlines.js';

const cache = new Map();
const MAX = 800;

const MACROS = {
  '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}', '\\Q': '\\mathbb{Q}', '\\C': '\\mathbb{C}',
  '\\grad': '^{\\circ}', '\\degree': '^{\\circ}', '\\euro': '\\text{€}',
  // Befehle, die das Formelfeld (MathLive) schreibt
  '\\differentialD': '\\mathrm{d}', '\\exponentialE': '\\mathrm{e}', '\\imaginaryI': '\\mathrm{i}', '\\imaginaryJ': '\\mathrm{j}',
  '\\questeq': '\\overset{?}{=}', '\\doubleprime': '\\prime\\prime', '\\coloneq': '\\mathrel{:=}', '\\heftmark': '\\vphantom{#1}', '\\heftbar': '\\qquad\\vert\\;'
};

// Dezimalkomma: "0,5" soll in LaTeX nicht wie eine Aufzählung ("0, 5") aussehen.
function fixComma(tex) {
  return tex.replace(/(\d),(\d)/g, '$1{,}$2');
}

export function texFor(src, mode = 'auto') {
  return fixComma(repairLatex(toLatex(src, mode)));
}

export function renderToString(src, { display = false, mode = 'auto' } = {}) {
  const key = (display ? 'D' : 'I') + mode + '\u0001' + src;
  if (cache.has(key)) return cache.get(key);
  let out;
  if (!window.katex) out = { html: `<span class="math-error">${escapeHTML(src)}</span>`, error: 'KaTeX fehlt' };
  else {
    const tex = texFor(src, mode);
    try {
      const html = window.katex.renderToString(tex, {
        displayMode: display, throwOnError: true, strict: 'ignore', trust: false, macros: { ...MACROS }, output: 'html'
      });
      out = { html, error: null, tex };
    } catch (e) {
      out = { html: null, error: cleanError(e.message), tex };
    }
  }
  if (cache.size > MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

function cleanError(msg) {
  return String(msg || 'Fehler').replace(/^KaTeX parse error: /, '').replace(/ at position \d+:.*$/s, '');
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline-Formel-Atom <span class="im" data-tex="…"> füllen.
export function hydrateInlineMath(span, mode) {
  const src = span.getAttribute('data-tex') || '';
  span.setAttribute('contenteditable', 'false');
  if (!src.trim()) {
    span.classList.add('empty');
    span.innerHTML = '';
    return;
  }
  span.classList.remove('empty');
  const r = renderToString(src, { display: false, mode });
  if (r.error) {
    span.classList.add('err');
    span.textContent = src;
    span.title = r.error;
  } else {
    span.classList.remove('err');
    span.innerHTML = r.html;
    span.removeAttribute('title');
  }
}

export function renderDisplay(el, src, mode) {
  if (!src || !src.trim()) {
    el.innerHTML = '<span class="math-empty">Formel eingeben …</span>';
    return null;
  }
  const r = renderToString(src, { display: true, mode });
  if (r.error) {
    el.innerHTML = `<div class="math-error">${escapeHTML(src)}\n⚠︎ ${escapeHTML(r.error)}</div>`;
    return r.error;
  }
  el.innerHTML = r.html;
  return null;
}
