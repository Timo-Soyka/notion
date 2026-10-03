// Funktionsgraph-Block.
//
// Zeichnet ein Koordinatensystem wie im Matheheft: Kästchengitter, Achsen mit
// Pfeilen, Funktionsnamen an den Graphen und – auf Wunsch – die besonderen
// Punkte in Schulschreibweise: N(…|…), H/T für Hoch- und Tiefpunkte,
// S für Schnittpunkte. Alles als SVG, damit es im PDF gestochen scharf bleibt.

import { h, esc } from '../../ui/ui.js';
import { icon } from '../../ui/icons.js';
import {
  parseExpr, compile, toTex, splitDefinition, formatNumber, findRoots, findExtrema, findInflections, usedNames, usedFunctions,
  splitCondition, evalCondition, inInterval, conditionTex, derive, integrate, tangentLine, primitive, inlineCalls, toFraction
} from '../../core/mathexpr.js';
import { renderToString } from '../render/katex.js';
import { captionEl, mediaBar } from './atoms.js';
import { createField, writeInto } from '../mathfield.js';
import { latexToExpr, exprToLatex } from '../../core/plotlatex.js';
import { toPx, formatWidth, parseWidth, CM_PX } from '../../core/widths.js';

// Zusätzliche Kürzel in den Funktionszeilen
const PLOT_SHORTCUTS = {
  tangente: '\\operatorname{tangente}\\left(#?,#?\\right)', normale: '\\operatorname{normale}\\left(#?,#?\\right)',
  unendlich: '\\infty'
};

export const PLOT_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0d9488', '#db2777', '#4b5563'];
const AUTO_NAMES = ['f', 'g', 'h', 'k', 'p', 'q', 'r', 's', 'u', 'v', 'w'];
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n) => String(n).split('').map(d => SUB[+d]).join('');

export function defaultPlotConfig() {
  return { functions: [{ expr: 'f(x) = x^2' }], xmin: -5, xmax: 5, grid: true, special: false, equal: true, legend: true, size: 'M' };
}

// ---------------------------------------------------------------------------
// Funktionen vorbereiten
// ---------------------------------------------------------------------------
//
// Jede Zeile ist eine Funktion ("f(x) = x^2"), ein Parameter ("a = 2"), eine
// senkrechte Gerade ("x = 3"), eine Ableitung ("f'(x)"), eine Tangente
// ("tangente(f, 1)") oder eine Fläche ("∫_0^3 f(x) dx"). Funktionen dürfen
// eingeschränkt sein ("x^2 für x < 3"); mehrere Zeilen mit demselben Namen
// und Einschränkung ergeben eine abschnittsweise definierte Funktion.

const isIntegral = (s) => /^\s*(∫|int\b|integral\b)/.test(s);

function piecewise(pieces) {
  if (pieces.length === 1 && !pieces[0].iv) return pieces[0].fn;
  return (x) => {
    for (const p of pieces) if (inInterval(p.iv, x)) return p.fn(x);
    return NaN;
  };
}

// Funktionsnamen, die in Termen aufgerufen werden (f(…), f'(…), tangente(f, …))
function calledNames(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(/(?<!\p{L})(\p{L})'*\s*\(/gu)) out.add(m[1]);
  for (const m of String(body || '').matchAll(/(?:tangente?|normale?)\s*\(\s*(\p{L})/giu)) out.add(m[1]);
  return out;
}

export function prepare(config) {
  const entries = (config.functions || []).filter(f => f && String(f.expr || '').trim());
  const params = {};
  const rows = entries.map((entry, index) => {
    const d = splitDefinition(entry.expr);
    const row = { ...d, entry, index };
    if (d.param || d.vertical) return row;
    const sc = splitCondition(d.body);
    row.body = sc.body;
    row.cond = sc.cond;
    if (!row.name) {
      const dm = /^(\p{L})('+)\(\s*x\s*\)$/u.exec(row.body.trim());
      if (dm) row.derivOf = { f: dm[1], d: dm[2].length };
    }
    return row;
  });

  // Automatische Namen: keine, die schon vergeben oder in einem Term benutzt sind
  // (sonst würde sich "g(x)" beim Eintippen selbst aufrufen)
  const taken = new Set();
  for (const r of rows) {
    if (r.name && !r.area) taken.add(r.name);
    for (const n of calledNames(r.body)) taken.add(n);
  }
  const pick = (pref) => {
    for (const n of [...pref, ...AUTO_NAMES]) if (!taken.has(n)) { taken.add(n); return n; }
    return null;
  };
  for (const r of rows) {
    if (r.param || r.vertical || r.name || r.derivOf || r.area || isIntegral(r.body)) continue;
    r.name = /^\s*tangente?\s*\(/i.test(r.body) ? pick(['t']) : /^\s*normale?\s*\(/i.test(r.body) ? pick(['n']) : pick([]);
  }

  // Parameter (a = 2) zuerst auswerten
  for (const r of rows.filter(x => x.param)) {
    try { params[r.name] = compile(parseExpr(r.body), { params })(0); r.value = params[r.name]; }
    catch (err) { r.error = err.message; }
  }

  const known = {};
  for (const r of rows) if (r.name && !r.param && !r.area) known[r.name] = true;
  for (const r of rows) {
    if (r.param) continue;
    try {
      r.tree = parseExpr(r.body, known);
      if (r.area || (r.tree.t === 'integral' && !hasX(r.tree.lo) && !hasX(r.tree.hi))) r.kind = 'area';
      else if (r.tree.t === 'tangent') r.kind = 'tangent';
      else r.kind = 'fn';
    } catch (err) { r.error = err.message; }
  }

  // Unbekannte Namen: "g(x)" ohne Funktion g, Tippfehler bei Parametern
  for (const r of rows) {
    if (!r.tree) continue;
    const missing = [...usedNames(r.tree)].filter(n => !known[n] && !(n in params) && n !== 'x' && n !== 't');
    if (r.kind === 'tangent' && !known[r.tree.f]) missing.push(r.tree.f);
    if (missing.length) {
      const n = missing[0];
      r.error = `„${n}“ ist noch nicht festgelegt – z. B. ${n}(x) = … oder ${n} = 2 in einer eigenen Zeile`;
      r.tree = null;
    }
  }

  // Kreisverweise (f ruft g, g ruft f) abfangen
  const deps = {};
  for (const r of rows) {
    if (!r.tree || !r.name || r.kind === 'area') continue;
    deps[r.name] = deps[r.name] || new Set();
    for (const n of usedFunctions(r.tree, known)) deps[r.name].add(n);
  }
  const inCycle = (start) => {
    const seen = new Set();
    const stack = [...(deps[start] || [])];
    while (stack.length) {
      const n = stack.pop();
      if (n === start) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(deps[n] || []));
    }
    return false;
  };
  for (const r of rows) {
    if (!r.tree || !r.name || r.kind === 'area' || !inCycle(r.name)) continue;
    const others = [...(deps[r.name] || [])].filter(n => n !== r.name);
    r.error = deps[r.name].has(r.name) ? `${r.name} darf sich nicht selbst enthalten` : `${r.name} und ${others.join(', ')} verweisen aufeinander`;
    r.tree = null;
  }

  // Funktionen übersetzen – abschnittsweise, wenn alle Zeilen eines Namens eingeschränkt sind
  const funcs = {};
  const defs = {};
  const derivCache = new Map();
  const env = { funcs, params };
  const derivPieces = (name, k) => {
    const key = name + ':' + k;
    if (derivCache.has(key)) return derivCache.get(key);
    derivCache.set(key, null);
    const pcs = defs[name];
    let comp = null;
    if (pcs) {
      comp = pcs.map(pc => { const t = derive(pc.tree, k); return t && { fn: compile(t, env), iv: pc.iv, tree: t }; });
      if (!comp.every(Boolean)) comp = null;
    }
    derivCache.set(key, comp);
    return comp;
  };
  env.deriv = (name, k) => { const comp = derivPieces(name, k); return comp ? piecewise(comp) : null; };
  const byName = new Map();
  for (const r of rows) {
    if (!r.tree || r.kind !== 'fn' && r.kind !== 'tangent' || !r.name) continue;
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  for (const r of rows) {
    if (!r.tree || r.kind === 'area') continue;
    try {
      r.raw = compile(r.tree, env);
      r.iv = evalCondition(r.cond, params);
      if (r.iv && !r.iv.length) throw new Error('Die Bedingungen widersprechen sich – der Graph wäre nirgends zu sehen');
      r.fn = r.iv ? piecewise([{ fn: r.raw, iv: r.iv }]) : r.raw;
    } catch (err) { r.error = err.message; r.fn = null; }
  }
  for (const [name, list] of byName) {
    const ok = list.filter(r => r.fn);
    if (!ok.length) continue;
    if (list.length > 1 && list.every(r => r.cond)) {
      funcs[name] = piecewise(ok.map(r => ({ fn: r.raw, iv: r.iv })));
      defs[name] = ok.map(r => ({ tree: r.tree, iv: r.iv }));
      for (const r of ok) r.piece = true;
    } else {
      const last = ok[ok.length - 1];
      funcs[name] = last.fn;
      if (last.kind === 'fn') defs[name] = [{ tree: last.tree, iv: last.iv }];
    }
  }

  // Kurven: eine je Funktion (Abschnitte zusammen), Ableitungen, Tangenten, senkrechte Geraden
  const curves = [];
  let colorIdx = 0;
  const colorOf = {};
  const nextColor = (entry) => entry.color || PLOT_COLORS[colorIdx++ % PLOT_COLORS.length];
  for (const r of rows) {
    if (r.param || r.kind === 'area') continue;
    if (!r.fn && !r.error) continue;
    const group = r.piece ? curves.find(c => c.name === r.name && c.pieces) : null;
    if (group) { r.color = group.color; group.rows.push(r); continue; }
    const color = nextColor(r.entry);
    r.color = color;
    if (!r.fn) continue;
    const label = r.derivOf ? r.derivOf.f + "'".repeat(r.derivOf.d) : r.name;
    const c = { name: r.name, label, color, rows: [r], vertical: !!r.vertical, kind: r.kind, pieces: r.piece || undefined };
    if (r.name && !colorOf[r.name]) colorOf[r.name] = color;
    curves.push(c);
  }
  for (const c of curves) {
    // Ableitung einer eingeschränkten/abschnittsweisen Funktion: Abschnitte einzeln
    // zeichnen – an den Grenzen offen, dort ist sie meist nicht ableitbar
    const r0 = c.rows[0];
    if (r0.derivOf && !r0.cond) {
      const comp = derivPieces(r0.derivOf.f, r0.derivOf.d);
      if (comp && comp.some(pc => pc.iv)) {
        c.rows = comp.map(pc => ({ ...r0, raw: pc.fn, fn: piecewise([pc]), iv: pc.iv && pc.iv.map(v => ({ ...v, loIncl: false, hiIncl: false })), derived: true }));
      }
    }
    c.fn = c.pieces ? funcs[c.name] : c.rows.length > 1 ? piecewise(c.rows.map(r => ({ fn: r.raw, iv: r.iv }))) : c.rows[0].fn;
    c.hidden = c.rows.every(r => r.entry.hidden);
    if (c.kind === 'tangent') {
      const t = c.rows[0].tree;
      let x0 = NaN;
      try { x0 = compile(t.x0, env)(0); } catch { /* bleibt NaN */ }
      c.touch = tangentLine(funcs[t.f], x0, { d: t.d, deriv: (k) => env.deriv(t.f, k), normal: t.normal });
    }
  }

  // Flächen unter/zwischen Graphen: ∫_a^b f(x) dx, ∫_a^b (f(x) − g(x)) dx
  const areas = [];
  for (const r of rows) {
    if (r.kind !== 'area' || !r.tree) continue;
    const t = r.tree;
    let lo, hi;
    try { lo = compile(t.lo, env)(0); hi = compile(t.hi, env)(0); } catch (err) { r.error = err.message; continue; }
    const integrand = t.a.t === 'paren' ? t.a.a : t.a;
    const userFn = (n) => n && n.t === 'call' && n.user && !n.d && n.args[0].t === 'var' ? n.f : null;
    let top, bottom = () => 0, color, outline = false;
    const f = userFn(integrand);
    const diff = integrand.t === 'bin' && integrand.op === '-' ? [userFn(integrand.a), userFn(integrand.b)] : null;
    const g = compile(t.a, { ...env, variable: t.v, outer: { x: 0 } });
    if (f && funcs[f]) { top = funcs[f]; color = colorOf[f]; }
    else if (diff && diff[0] && diff[1] && funcs[diff[0]] && funcs[diff[1]]) { top = funcs[diff[0]]; bottom = funcs[diff[1]]; color = colorOf[diff[0]]; }
    else { top = g; outline = true; }
    color = r.entry.color || color || nextColor(r.entry);
    r.color = color;
    // An Abschnittsgrenzen (Sprungstellen) getrennt rechnen – sonst verschmiert die Simpsonregel den Sprung
    const cuts = rows.flatMap(x => (x.iv || []).flatMap(v => [v.lo, v.hi])).filter(v => Number.isFinite(v) && v > Math.min(lo, hi) && v < Math.max(lo, hi));
    let value = integrateSplit(g, lo, hi, cuts, 400);
    let area = integrateSplit((x) => Math.abs(g(x)), lo, hi, cuts, 800);
    // Exakt über die Stammfunktion, wenn es eine gibt (dann auch [F(x)] in der Legende)
    const exact = t.v === 'x' ? exactIntegral(t.a, lo, hi, cuts, defs, g) : null;
    if (exact) { value = exact.value; area = exact.area; }
    areas.push({ row: r, lo, hi, top, bottom, color, outline, value, area, exact, hidden: !!r.entry.hidden });
  }
  return { list: rows, curves, areas, funcs, params, env, defs };
}

const hasX = (n) => JSON.stringify(n || {}).includes('"t":"var"');

// ∫ exakt: Stammfunktion je Abschnitt (bei abschnittsweisen Funktionen der
// jeweils gültige Term), Fläche mit Aufteilung an den Nullstellen.
// → { value, area, F (nur bei einem Abschnitt) } oder null
function exactIntegral(integrand, lo, hi, cuts, defs, g) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const a = Math.min(lo, hi), b = Math.max(lo, hi), sign = hi < lo ? -1 : 1;
  const roots = findRoots(g, a, b, 400).filter(x => x > a && x < b);
  const pts = [...new Set([a, ...cuts, ...roots, b])].sort((u, v) => u - v);
  // Stammfunktion für den Abschnitt um m (Funktionsaufrufe durch den dort gültigen Term ersetzt)
  const cache = new Map();
  const primAt = (m) => {
    const trees = {};
    for (const name in defs) {
      const pc = defs[name].find(p => inInterval(p.iv, m));
      if (pc) trees[name] = pc.tree;
    }
    const key = JSON.stringify(trees);
    if (!cache.has(key)) {
      const F = primitive(inlineCalls(integrand, trees));
      cache.set(key, F && !JSON.stringify(F).includes('"user":true') ? { tree: F, fn: compile(F) } : null);
    }
    return cache.get(key);
  };
  let value = 0, area = 0, single = null;
  for (let k = 0; k < pts.length - 1; k++) {
    const u = pts[k], v = pts[k + 1];
    const P = primAt((u + v) / 2);
    if (!P) return null;
    const part = P.fn(v) - P.fn(u);
    if (!Number.isFinite(part)) return null;
    value += part;
    area += Math.abs(part);
    single = single === null ? P : single === P ? single : false;
  }
  return { value: sign * value, area, F: single ? single.tree : null };
}

// Integral in Teilstücken; die Ränder jedes Stücks minimal nach innen, damit
// an einer Sprungstelle der Wert des richtigen Abschnitts zählt
function integrateSplit(g, lo, hi, cuts, n) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return NaN;
  const sign = hi < lo ? -1 : 1;
  const pts = [...new Set([Math.min(lo, hi), ...cuts, Math.max(lo, hi)])].sort((a, b) => a - b);
  if (pts.length === 2) {
    const plain = integrate(g, pts[0], pts[1], n);
    if (Number.isFinite(plain)) return sign * plain;
  }
  let sum = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1], eps = (b - a) * 1e-9;
    sum += integrate(g, a + eps, b - eps, Math.max(40, Math.round(n / (pts.length - 1) / 2) * 2));
  }
  return sign * sum;
}

function niceStep(range, pixels, target = 45) {
  const raw = range / Math.max(1, pixels / target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return step * mag;
}

function autoYRange(P, xmin, xmax) {
  const vals = [];
  const list = [...P.curves, ...P.areas.filter(a => a.outline).map(a => ({ fn: a.top }))];
  for (const f of list) {
    if (!f.fn || f.vertical || f.hidden) continue;
    for (let k = 0; k <= 200; k++) {
      const x = xmin + (xmax - xmin) * k / 200;
      const y = f.fn(x);
      if (Number.isFinite(y)) vals.push(y);
    }
  }
  if (!vals.length) return [-5, 5];
  vals.sort((a, b) => a - b);
  let lo = vals[Math.floor(vals.length * 0.03)], hi = vals[Math.ceil(vals.length * 0.97) - 1];
  lo = Math.min(lo, 0); hi = Math.max(hi, 0);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  return [Math.floor(lo - pad), Math.ceil(hi + pad)];
}

export function parsePoints(text) {
  const out = [];
  const re = /([A-Za-zÄÖÜäöü][\w']*)?\s*\(\s*([^|;()]+?)\s*[|;]\s*([^|;()]+?)\s*\)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    try {
      const x = compile(parseExpr(m[2].replace(',', '.')))(0);
      const y = compile(parseExpr(m[3].replace(',', '.')))(0);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ name: m[1] || '', x, y });
    } catch { /* ungültiger Punkt wird übersprungen */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) el.setAttribute(k, attrs[k]);
  if (text !== undefined) el.textContent = text;
  return el;
}

export function drawPlot(config, width, prepared, height) {
  const P = prepared || prepare(config);
  const xmin = Number.isFinite(+config.xmin) ? +config.xmin : -5;
  const xmax = Number.isFinite(+config.xmax) && +config.xmax > xmin ? +config.xmax : xmin + 10;
  let ymin = config.ymin, ymax = config.ymax;
  if (!(Number.isFinite(+ymin) && Number.isFinite(+ymax) && +ymax > +ymin && ymin !== '' && ymax !== '' && ymin !== null && ymax !== null)) {
    [ymin, ymax] = autoYRange(P, xmin, xmax);
  } else { ymin = +ymin; ymax = +ymax; }

  const margin = { l: 10, r: 18, t: 16, b: 14 };
  const W = Math.max(160, Math.round(width));
  const plotW = W - margin.l - margin.r;
  let plotH;
  if (height) {
    // Feste Fenstergröße: bei gleichen Einheiten zeigt ein höheres Fenster mehr von der y-Achse
    plotH = Math.max(80, Math.round(height) - margin.t - margin.b);
    if (config.equal !== false) {
      // Neue y-Spanne; liegt 0 im Bereich, bleibt die x-Achse an derselben relativen Stelle
      const span = plotH / plotW * (xmax - xmin);
      if (ymin <= 0 && ymin + span >= 0) {
        // unteren Rand behalten (z. B. Scheitel einer Parabel), solange die x-Achse im Bild bleibt
        ymax = ymin + span;
      } else if (ymin <= 0 && ymax >= 0) {
        const t = (0 - ymin) / (ymax - ymin);
        ymin = -t * span; ymax = ymin + span;
      } else {
        const yc = (ymin + ymax) / 2;
        ymin = yc - span / 2; ymax = yc + span / 2;
      }
    }
  } else if (config.equal !== false) {
    plotH = plotW * (ymax - ymin) / (xmax - xmin);
    plotH = Math.max(140, Math.min(plotH, 900));
  } else plotH = Math.round(plotW * 0.62);
  const H = Math.round(plotH + margin.t + margin.b);
  const sx = (x) => margin.l + (x - xmin) / (xmax - xmin) * plotW;
  const sy = (y) => margin.t + (ymax - y) / (ymax - ymin) * plotH;
  const ux = plotW / (xmax - xmin), uy = plotH / (ymax - ymin);

  const svg = s('svg', { class: 'plot-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  const defs = s('defs');
  const clipId = 'clip' + Math.random().toString(36).slice(2, 8);
  const cp = s('clipPath', { id: clipId });
  cp.append(s('rect', { x: margin.l, y: margin.t, width: plotW, height: plotH }));
  defs.append(cp);
  const arrowId = 'arr' + clipId;
  const marker = s('marker', { id: arrowId, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.append(s('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: 'currentColor' }));
  defs.append(marker);
  svg.append(defs);

  // Gitter: im Heft-Stil ein Kästchen pro halbe Einheit, wenn Platz ist
  const stepX = niceStep(xmax - xmin, plotW), stepY = niceStep(ymax - ymin, plotH);
  if (config.grid !== false) {
    const g = s('g');
    const minorX = ux * stepX / 2 >= 9 ? stepX / 2 : null;
    const minorY = uy * stepY / 2 >= 9 ? stepY / 2 : null;
    const lines = (step, cls) => {
      if (!step) return;
      for (let x = Math.ceil(xmin / step) * step; x <= xmax + 1e-9; x += step) g.append(s('line', { class: cls, x1: sx(x), x2: sx(x), y1: margin.t, y2: margin.t + plotH }));
    };
    const linesY = (step, cls) => {
      if (!step) return;
      for (let y = Math.ceil(ymin / step) * step; y <= ymax + 1e-9; y += step) g.append(s('line', { class: cls, y1: sy(y), y2: sy(y), x1: margin.l, x2: margin.l + plotW }));
    };
    lines(minorX, 'grid minor'); linesY(minorY, 'grid minor');
    lines(stepX, 'grid'); linesY(stepY, 'grid');
    svg.append(g);
  }

  // Achsen
  const axes = s('g', { style: 'color: var(--fg)' });
  const x0 = Math.min(Math.max(0, xmin), xmax), y0 = Math.min(Math.max(0, ymin), ymax);
  axes.append(s('line', { class: 'axis', x1: margin.l, x2: margin.l + plotW + 8, y1: sy(y0), y2: sy(y0), 'marker-end': `url(#${arrowId})` }));
  axes.append(s('line', { class: 'axis', x1: sx(x0), x2: sx(x0), y1: margin.t + plotH, y2: margin.t - 8, 'marker-end': `url(#${arrowId})` }));
  axes.append(s('text', { class: 'axis-label', x: margin.l + plotW + 4, y: sy(y0) + 16, 'text-anchor': 'end' }, config.xLabel || 'x'));
  axes.append(s('text', { class: 'axis-label', x: sx(x0) - 7, y: margin.t + 2, 'text-anchor': 'end' }, config.yLabel || 'y'));
  // Beschriftung der Achsen
  const tickDec = (st) => Math.max(0, -Math.floor(Math.log10(st) + 1e-9));
  for (let x = Math.ceil(xmin / stepX) * stepX; x <= xmax + 1e-9; x += stepX) {
    if (Math.abs(x) < stepX / 2) continue;
    const px = sx(x);
    if (px > margin.l + plotW - 12) continue;
    axes.append(s('line', { class: 'axis', x1: px, x2: px, y1: sy(y0) - 3, y2: sy(y0) + 3 }));
    axes.append(s('text', { class: 'tick-label', x: px, y: Math.min(sy(y0) + 15, margin.t + plotH + 12), 'text-anchor': 'middle' }, formatNumber(x, tickDec(stepX))));
  }
  for (let y = Math.ceil(ymin / stepY) * stepY; y <= ymax + 1e-9; y += stepY) {
    if (Math.abs(y) < stepY / 2) continue;
    const py = sy(y);
    if (py < margin.t + 10) continue;
    axes.append(s('line', { class: 'axis', x1: sx(x0) - 3, x2: sx(x0) + 3, y1: py, y2: py }));
    axes.append(s('text', { class: 'tick-label', x: Math.max(sx(x0) - 6, margin.l + 12), y: py + 4, 'text-anchor': 'end' }, formatNumber(y, tickDec(stepY))));
  }
  if (xmin < 0 && xmax > 0 && ymin < 0 && ymax > 0) axes.append(s('text', { class: 'tick-label', x: sx(0) - 5, y: sy(0) + 14, 'text-anchor': 'end' }, '0'));
  svg.append(axes);

  // Flächen (Integrale) unter den Graphen
  const shades = s('g', { 'clip-path': `url(#${clipId})` });
  for (const a of P.areas) {
    if (a.hidden || !Number.isFinite(a.lo) || !Number.isFinite(a.hi)) continue;
    const x0a = Math.max(Math.min(a.lo, a.hi), xmin), x1a = Math.min(Math.max(a.lo, a.hi), xmax);
    if (x1a <= x0a) continue;
    const n = Math.max(60, Math.round((x1a - x0a) * ux));
    const clampY = (y) => Math.max(-plotH * 2, Math.min(plotH * 3, sy(y)));
    let up = '', down = '';
    // Ränder minimal nach innen: am offenen Rand (x < 2) hat der Graph selbst keinen Wert
    const eps = (x1a - x0a) * 1e-9;
    for (let k = 0; k <= n; k++) {
      const x = Math.min(x1a - eps, Math.max(x0a + eps, x0a + (x1a - x0a) * k / n));
      const yt = a.top(x), yb = a.bottom(x);
      if (!Number.isFinite(yt) || !Number.isFinite(yb)) continue;
      up += `${up ? 'L' : 'M'}${sx(x).toFixed(2)} ${clampY(yt).toFixed(2)}`;
      down = `L${sx(x).toFixed(2)} ${clampY(yb).toFixed(2)}` + down;
    }
    if (!up) continue;
    shades.append(s('path', { class: 'area', d: up + down + 'Z', fill: a.color }));
    if (a.outline) shades.append(s('path', { class: 'curve', d: up, stroke: a.color }));
    // Grenzen als dünne senkrechte Linien
    for (const xb of [a.lo, a.hi]) {
      if (xb < xmin || xb > xmax) continue;
      const xi = Math.min(x1a - eps, Math.max(x0a + eps, xb));
      const yt = a.top(xi), yb = a.bottom(xi);
      if (Number.isFinite(yt) && Number.isFinite(yb)) shades.append(s('line', { class: 'area-edge', x1: sx(xb), x2: sx(xb), y1: clampY(yb), y2: clampY(yt), stroke: a.color }));
    }
  }
  svg.append(shades);

  // Graphen
  const curves = s('g', { 'clip-path': `url(#${clipId})` });
  const labels = s('g');
  const dots = [];
  const visible = P.curves.filter(c => c.fn && !c.hidden);
  const trace = (fn, from, to) => {
    let d = '';
    let pen = false, lastY = null;
    const N = Math.max(200, Math.round(plotW * 1.5 * (to - from) / (xmax - xmin)));
    for (let k = 0; k <= N; k++) {
      const x = from + (to - from) * k / N;
      const y = fn(x);
      if (!Number.isFinite(y)) { pen = false; lastY = null; continue; }
      let py = sy(y);
      const jump = lastY !== null && Math.abs(py - lastY) > plotH * 1.5;
      py = Math.max(-plotH * 2, Math.min(plotH * 3, py));
      if (!pen || jump) { d += `M${sx(x).toFixed(2)} ${py.toFixed(2)}`; pen = true; }
      else d += `L${sx(x).toFixed(2)} ${py.toFixed(2)}`;
      lastY = py;
    }
    return d;
  };
  for (const c of visible) {
    if (c.vertical) {
      let xv;
      try { xv = c.fn(0); } catch { continue; }
      if (!Number.isFinite(xv)) continue;
      curves.append(s('line', { class: 'curve dashed', x1: sx(xv), x2: sx(xv), y1: margin.t, y2: margin.t + plotH, stroke: c.color }));
      continue;
    }
    for (const r of c.rows) {
      if (!r.fn || r.entry.hidden) continue;
      // Jeden erlaubten Bereich für sich zeichnen (x < -1 oder x > 1 ergibt zwei Stücke)
      for (const iv of r.iv || [null]) {
        const from = iv ? Math.max(xmin, iv.lo) : xmin, to = iv ? Math.min(xmax, iv.hi) : xmax;
        if (to <= from) continue;
        curves.append(s('path', { class: 'curve' + (r.entry.dashed ? ' dashed' : ''), d: trace(r.raw || r.fn, from, to), stroke: c.color }));
        // Randpunkte: ausgefüllt, wenn der Rand dazugehört, sonst offen – wie im Heft
        if (iv) {
          for (const [xb, incl] of [[iv.lo, iv.loIncl], [iv.hi, iv.hiIncl]]) {
            if (!Number.isFinite(xb) || xb < xmin || xb > xmax) continue;
            let y = r.raw(xb);
            if (!Number.isFinite(y)) y = r.raw(xb + (xb === iv.lo ? 1 : -1) * 1e-9 * Math.max(1, Math.abs(xb)));
            if (Number.isFinite(y)) dots.push({ x: xb, y, incl, color: c.color });
          }
        }
      }
    }
    // Berührpunkt der Tangente
    if (c.touch) dots.push({ x: c.touch.x0, y: c.touch.y0, incl: true, color: c.color, small: true });
    // Name an den rechten sichtbaren Rand des Graphen
    if (c.label && config.names !== false) {
      for (let k = 0; k <= 60; k++) {
        const x = xmax - (xmax - xmin) * (0.04 + k * 0.012);
        const y = c.fn(x);
        if (Number.isFinite(y) && y > ymin + (ymax - ymin) * 0.06 && y < ymax - (ymax - ymin) * 0.04) {
          const slope = (c.fn(x + 0.01) - y) / 0.01;
          const above = !Number.isFinite(slope) || slope * (uy / ux) < 0.8;
          labels.append(s('text', { class: 'curve-label', x: sx(x) - 4, y: sy(y) + (above ? -9 : 17), fill: c.color, 'text-anchor': 'end' }, c.label));
          break;
        }
      }
    }
  }
  svg.append(curves);
  // Offene Punkte zuerst, damit ein ausgefüllter an derselben Stelle darüber liegt.
  // Zwei offene Punkte an derselben Stelle derselben Kurve: dort geht sie glatt weiter
  const same = (a, b) => a !== b && a.color === b.color && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-6 * Math.max(1, Math.abs(a.y));
  const shown = dots.filter(d => d.incl || !dots.some(e => !e.incl && same(d, e)));
  const dotsG = s('g');
  for (const d of shown.sort((a, b) => a.incl - b.incl)) {
    if (d.y < ymin || d.y > ymax) continue;
    dotsG.append(s('circle', { class: 'end-dot' + (d.incl ? '' : ' open'), cx: sx(d.x), cy: sy(d.y), r: d.small ? 3.2 : 3.6, stroke: d.color, fill: d.incl ? d.color : 'var(--bg, #fff)' }));
  }
  svg.append(dotsG);

  // Besondere Punkte
  const pts = [];
  if (config.special) {
    let nN = 0;
    // Tangenten haben keine eigenen besonderen Punkte – nur ihren Berührpunkt B
    for (const f of visible.filter(f => f.kind === 'tangent' && f.touch)) pts.push({ x: f.touch.x0, y: f.touch.y0, name: 'B', color: f.color, fname: f.label });
    for (const f of visible.filter(f => !f.vertical && f.kind !== 'tangent')) {
      for (const x of findRoots(f.fn, xmin, xmax)) pts.push({ x, y: 0, name: 'N', color: f.color, fname: f.label });
      for (const e of findExtrema(f.fn, xmin, xmax)) pts.push({ x: e.x, y: e.y, name: e.kind === 'max' ? 'H' : 'T', color: f.color, fname: f.label });
      if (config.inflection) for (const w of findInflections(f.fn, xmin, xmax)) pts.push({ x: w.x, y: w.y, name: 'W', color: f.color, fname: f.label });
    }
    const fl = visible.filter(f => !f.vertical && f.kind !== 'tangent');
    for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
      const a = fl[i].fn, b = fl[j].fn;
      for (const x of findRoots((x) => a(x) - b(x), xmin, xmax)) pts.push({ x, y: a(x), name: 'S', color: 'var(--fg)' });
    }
    // Nummerieren, wenn es mehrere gleicher Art gibt
    const counts = {};
    for (const p of pts) counts[p.name + (visible.length > 1 && p.name !== 'S' ? p.fname : '')] = (counts[p.name + (visible.length > 1 && p.name !== 'S' ? p.fname : '')] || 0) + 1;
    const seen = {};
    for (const p of pts) {
      const key = p.name + (visible.length > 1 && p.name !== 'S' ? p.fname : '');
      seen[key] = (seen[key] || 0) + 1;
      p.label = p.name + (counts[key] > 1 ? sub(seen[key]) : '');
      nN++;
    }
  }
  for (const p of parsePoints(config.points)) pts.push({ ...p, label: p.name, color: 'var(--fg)', custom: true });
  const ptsG = s('g');
  const placed = [];
  for (const p of pts.slice(0, 40)) {
    if (p.x < xmin || p.x > xmax || p.y < ymin || p.y > ymax) continue;
    const px = sx(p.x), py = sy(p.y);
    ptsG.append(s('circle', { class: 'pt', cx: px, cy: py, r: 4, fill: p.color }));
    if (config.pointLabels === false && !p.custom) continue;
    const text = `${p.label || ''}(${formatNumber(p.x)}|${formatNumber(p.y)})`;
    // Beschriftungen nicht übereinanderlegen
    let lx = px + 7, ly = py - 8;
    for (let tries = 0; tries < 6 && placed.some(q => Math.abs(q.x - lx) < 70 && Math.abs(q.y - ly) < 14); tries++) ly += 15;
    if (lx + text.length * 6.2 > W - 4) lx = px - 7 - text.length * 6.2;
    placed.push({ x: lx, y: ly });
    ptsG.append(s('text', { class: 'pt-label', x: lx, y: ly }, text));
  }
  svg.append(ptsG, labels);
  return { svg, view: { xmin, xmax, ymin, ymax, sx, sy, margin, plotW, plotH, W, H }, prepared: P };
}

// ---------------------------------------------------------------------------
// Legende: Funktionsterme als Formel – abschnittsweise mit Fallunterscheidung,
// Ableitungen ausgerechnet, Tangenten als Geradengleichung, Integrale mit Wert
// ---------------------------------------------------------------------------

const texNum = (v, digits = 2) => formatNumber(v, digits).replace('−', '-').replace(',', '{,}');

// Wert exakt, wenn möglich: = 9 · = 8/3 ≈ 2,67 · ≈ 1,23
function valueTex(v) {
  const f = toFraction(v);
  if (f && f[1] === 1) return ` = ${f[0]}`;
  if (f) return ` = ${f[0] < 0 ? '-' : ''}\\frac{${Math.abs(f[0])}}{${f[1]}} \\approx ${texNum(v)}`;
  return ` \\approx ${texNum(v)}`;
}

function derivativeTex(P, name, d, prefix) {
  const pcs = P.defs && P.defs[name];
  const head = prefix || `${name}${"'".repeat(d)}(x) = `;
  if (!pcs) return null;
  const parts = pcs.map(pc => ({ t: derive(pc.tree, d), iv: pc }));
  if (parts.some(x => !x.t)) return null;
  const conds = P.list.filter(r => r.name === name && r.tree && r.kind === 'fn');
  if (parts.length > 1) {
    return `${head}\\begin{cases} ${parts.map((x, i) => `${toTex(x.t)}, & ${conditionTex(conds[i] && conds[i].cond, P.params)}`).join(' \\\\ ')} \\end{cases}`;
  }
  const cond = conds.length === 1 && conds[0].cond;
  return head + toTex(parts[0].t) + (cond ? `,\\; ${conditionTex(cond, P.params)}` : '');
}

export function legendItems(P) {
  const out = [];
  for (const c of P.curves) {
    if (c.hidden) continue;
    const r = c.rows[0];
    if (!r.tree) continue;
    let tex;
    if (c.vertical) tex = 'x = ' + toTex(r.tree);
    else if (c.pieces) {
      const rows = c.rows.filter(x => x.tree);
      tex = `${c.name}(x) = \\begin{cases} ${rows.map(x => `${toTex(x.tree)}, & ${conditionTex(x.cond, P.params)}`).join(' \\\\ ')} \\end{cases}`;
    } else if (r.derivOf) {
      tex = derivativeTex(P, r.derivOf.f, r.derivOf.d) || `${c.label}(x)`;
    } else if (c.kind === 'tangent') {
      const t = c.touch;
      if (t) {
        const m = Math.abs(t.m) < 1e-10 ? 0 : t.m, b = Math.abs(t.b) < 1e-10 ? 0 : t.b;
        const mx = m === 0 ? '' : (Math.abs(m - 1) < 1e-10 ? '' : Math.abs(m + 1) < 1e-10 ? '-' : texNum(m) + ' ') + 'x';
        const bs = m === 0 ? texNum(b) : b === 0 ? '' : (b > 0 ? ' + ' : ' - ') + texNum(Math.abs(b));
        tex = `${c.name}(x) = ${mx}${bs}`;
      } else tex = `${c.name}(x) = ${toTex(r.tree)}`;
    } else {
      tex = (c.name ? `${c.name}(x) = ` : 'y = ') + toTex(r.tree);
      // g(x) = f'(x) → gleich ausgerechnet dazuschreiben
      const t = r.tree;
      if (t.t === 'call' && t.user && t.d && t.args[0].t === 'var' && !r.cond) {
        const dt = derivativeTex(P, t.f, t.d, ' = ');
        if (dt) tex += dt;
      }
      if (r.cond) tex += `,\\; ${conditionTex(r.cond, P.params)}`;
    }
    out.push({ color: c.color, tex, fallback: r.entry.expr });
  }
  for (const a of P.areas) {
    if (a.hidden) continue;
    const r = a.row, t = r.tree;
    let tex = (r.name ? `${r.name} = ` : '') + toTex(t);
    // Rechenweg wie im Heft: [F(x)] von a bis b
    if (a.exact && a.exact.F) tex += ` = \\left[${toTex(a.exact.F)}\\right]_{${toTex(t.lo)}}^{${toTex(t.hi)}}`;
    tex += Number.isFinite(a.value) ? valueTex(a.value) : ' = \\text{–}';
    // Wechselt der Graph das Vorzeichen, ist die Fläche größer als das Integral
    if (Number.isFinite(a.area) && Number.isFinite(a.value) && Math.abs(Math.abs(a.value) - a.area) > 1e-6 * Math.max(1, a.area)) {
      tex += `\\qquad\\text{Fläche: }${valueTex(a.area).replace(/^ = /, '')}`;
    }
    out.push({ color: a.color, tex, area: true, fallback: r.entry.expr });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

const SIZE_W = { S: 0.55, M: 0.8, L: 1 };

export const plot = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    if (!b.config) b.config = defaultPlotConfig();
    const wrap = h('div', { class: 'plot-wrap atom-view' });
    main.append(h('div', { class: 'atom' }, wrap));
    const paint = () => paintPlot(ed, b, wrap);
    paint();
    b._repaint = paint;
    if (!ed.readonly) {
      wrap.addEventListener('mousedown', (e) => {
        if (e.target.closest('.media-bar, .caption')) return;
        if (!main.closest('.blk').classList.contains('editing')) { e.preventDefault(); ed.activate(b); }
      });
    }
  },
  activate(ed, b, main) {
    const atom = main.querySelector('.atom');
    const panel = h('div', { class: 'atom-panel' });
    atom.append(panel);
    buildPanel(ed, b, panel);
  }
};

function plotSize(ed, b, wrap) {
  const cfg = b.config;
  const avail = Math.max(260, (wrap.parentElement?.clientWidth || ed.contentWidth()) - 4);
  // Eigene Größe (in cm, damit sie im PDF gleich ist) oder Klein/Mittel/Groß
  const width = cfg.w ? Math.max(160, Math.min(avail, toPx(cfg.w, avail) || avail)) : Math.min(avail, Math.round(avail * (SIZE_W[cfg.size] || 0.8)));
  const height = cfg.h ? Math.max(100, toPx(cfg.h, avail) || 0) : undefined;
  return { width, height, avail };
}

function paintPlot(ed, b, wrap) {
  const cfg = b.config;
  const { width, height, avail } = plotSize(ed, b, wrap);
  const keepCaption = wrap.querySelector('.caption');
  wrap.innerHTML = '';
  let res;
  try { res = drawPlot(cfg, width, undefined, height); }
  catch (err) { wrap.append(h('div', { class: 'math-error', text: 'Graph konnte nicht gezeichnet werden: ' + err.message })); return; }
  const frame = h('div', { class: 'plot-frame' }, res.svg);
  wrap.append(frame);
  if (!ed.readonly) frame.append(plotResizer(ed, b, wrap, res.svg, avail));
  // Legende mit Funktionstermen als Formel
  if (cfg.legend !== false) {
    const leg = h('div', { class: 'plot-legend' });
    for (const it of legendItems(res.prepared)) {
      const r = renderToString(it.tex, { display: false, mode: 'latex' });
      const item = h('span', { class: 'item' + (it.area ? ' area' : '') }, h('span', { class: 'sw' + (it.area ? ' area' : ''), style: { background: it.color } }));
      item.insertAdjacentHTML('beforeend', r.html || esc(it.fallback || ''));
      leg.append(item);
    }
    if (leg.childNodes.length) wrap.append(leg);
  }
  if (!ed.readonly) {
    wrap.append(mediaBar(ed, b, [
      { icon: 'refresh', tip: 'Ansicht zurücksetzen', onClick: () => { ed.checkpoint(); Object.assign(b.config, { xmin: -5, xmax: 5, ymin: undefined, ymax: undefined }); b._repaint(); ed.changed(); } },
      { icon: 'more', tip: 'Mehr', onClick: (btn) => ed.openBlockMenu(b, btn) }
    ]));
    attachInteraction(ed, b, res);
  }
  if (b.caption || b._cap) wrap.append(keepCaption || captionEl(ed, b, 'Beschriftung …', 'fig'));
}

// Griff unten rechts: Fenster des Graphen größer/kleiner ziehen
function plotResizer(ed, b, wrap, svg, avail) {
  const grip = h('div', { class: 'plot-resize', 'data-tip': 'Ziehen: Größe ändern · Doppelklick: Standardgröße' });
  const tip = h('div', { class: 'plot-size-tip' });
  grip.append(tip);
  const cm = (px) => `${+(Math.round(px / CM_PX * 10) / 10).toFixed(1)}cm`;
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    ed.checkpoint();
    const r = svg.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, w0 = r.width, h0 = r.height;
    let frameId = 0, last = null, active = true;
    document.body.classList.add('plot-resizing');
    grip.classList.add('dragging');
    const apply = () => {
      frameId = 0;
      if (!last) return;
      const w = Math.max(160, Math.min(avail, w0 + (last.clientX - x0)));
      const hh = Math.max(100, Math.min(1400, h0 + (last.clientY - y0)));
      b.config.w = cm(w);
      b.config.h = cm(hh);
      b._repaint();
      const g = wrap.querySelector('.plot-resize');
      if (g) { g.classList.toggle('dragging', active); g.querySelector('.plot-size-tip').textContent = `${formatWidth(b.config.w)} × ${formatWidth(b.config.h)}`; }
    };
    const move = (ev) => {
      last = ev;
      if (!frameId) frameId = requestAnimationFrame(apply);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      active = false;
      // Letzten Zwischenschritt sofort übernehmen, damit nichts nachläuft
      if (frameId) { cancelAnimationFrame(frameId); apply(); }
      document.body.classList.remove('plot-resizing');
      wrap.querySelector('.plot-resize')?.classList.remove('dragging');
      b._syncSize && b._syncSize();
      ed.changed();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  grip.addEventListener('dblclick', (e) => {
    e.preventDefault();
    ed.checkpoint();
    delete b.config.w;
    delete b.config.h;
    b._repaint();
    ed.changed();
  });
  return grip;
}

// Verschieben mit der Maus, Zoomen mit ⌘ + Scrollen bzw. Zwei-Finger-Zoom,
// Koordinaten beim Überfahren.
function attachInteraction(ed, b, res) {
  const svg = res.svg;
  const v = res.view;
  let coords = null;
  const toData = (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (v.W / r.width), py = (e.clientY - r.top) * (v.H / r.height);
    const x = v.xmin + (px - v.margin.l) / v.plotW * (v.xmax - v.xmin);
    const y = v.ymax - (py - v.margin.t) / v.plotH * (v.ymax - v.ymin);
    return { x, y, px, py };
  };
  svg.addEventListener('mousemove', (e) => {
    const d = toData(e);
    if (d.px < v.margin.l || d.px > v.margin.l + v.plotW) { coords && coords.remove(); coords = null; return; }
    if (!coords) { coords = h('div', { class: 'plot-coords' }); svg.parentElement.append(coords); }
    const fs = res.prepared.curves.filter(c => c.fn && !c.vertical && !c.hidden);
    const vals = fs.map(c => `${c.label || 'y'}(${formatNumber(d.x)}) = ${formatNumber(c.fn(d.x))}`);
    coords.textContent = vals.length ? vals.join('   ') : `(${formatNumber(d.x)}|${formatNumber(d.y)})`;
  });
  svg.addEventListener('mouseleave', () => { coords && coords.remove(); coords = null; });
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const blk = svg.closest('.blk');
    if (!blk || !blk.classList.contains('editing')) return;
    e.preventDefault();
    e.stopPropagation();
    const start = toData(e);
    const r = svg.getBoundingClientRect();
    const scaleX = (v.xmax - v.xmin) / (v.plotW * r.width / v.W);
    const scaleY = (v.ymax - v.ymin) / (v.plotH * r.height / v.H);
    const base = { ...v };
    let moved = false;
    const move = (ev) => {
      const dx = (ev.clientX - e.clientX) * scaleX, dy = (ev.clientY - e.clientY) * scaleY;
      if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 3) return;
      if (!moved) { ed.checkpoint(); moved = true; }
      b.config.xmin = round(base.xmin - dx); b.config.xmax = round(base.xmax - dx);
      b.config.ymin = round(base.ymin + dy); b.config.ymax = round(base.ymax + dy);
      scheduleRepaint(b);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) { b._repaint(); ed.changed(); b._syncPanel && b._syncPanel(); }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    void start;
  });
  svg.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // normales Scrollen soll die Seite scrollen
    e.preventDefault();
    const d = toData(e);
    const f = Math.exp(e.deltaY * 0.01);
    const c = b.config;
    const nx0 = d.x + (v.xmin - d.x) * f, nx1 = d.x + (v.xmax - d.x) * f;
    const ny0 = d.y + (v.ymin - d.y) * f, ny1 = d.y + (v.ymax - d.y) * f;
    if (!b._zooming) { ed.checkpoint(); b._zooming = true; }
    Object.assign(c, { xmin: round(nx0), xmax: round(nx1), ymin: round(ny0), ymax: round(ny1) });
    scheduleRepaint(b);
    clearTimeout(b._zoomT);
    b._zoomT = setTimeout(() => { b._zooming = false; ed.changed(); b._syncPanel && b._syncPanel(); }, 300);
  }, { passive: false });
}

function round(v) {
  const m = Math.pow(10, Math.max(0, 2 - Math.floor(Math.log10(Math.abs(v) + 1e-9))));
  return Math.round(v * m) / m;
}

function scheduleRepaint(b) {
  if (b._raf) return;
  b._raf = requestAnimationFrame(() => { b._raf = null; b._repaint && b._repaint(); });
}

// ---------------------------------------------------------------------------
// Bearbeitungsfeld
// ---------------------------------------------------------------------------

function buildPanel(ed, b, panel) {
  const c = b.config;
  const list = h('div');
  const err = h('div', { class: 'err' });
  const repaint = () => { b._repaint(); ed.changed({ soft: true }); };
  // Beim Tippen höchstens einmal pro Bild neu zeichnen
  let paintFrame = 0;
  const repaintSoon = () => { cancelAnimationFrame(paintFrame); paintFrame = requestAnimationFrame(repaint); };
  // Zuletzt bearbeitete Zeile – dort setzen die Hilfsknöpfe an
  let focusIdx = 0;

  // Zeilen als Formelfelder – wie bei Formeln: "integral", "wurzel", "/" …
  // ergeben gleich die fertige Schreibweise mit Kästchen
  let fields = [];
  let pending = null; // nach dem Aufbau: { index, placeholder }
  const texOf = (f) => (f.tex !== undefined ? f.tex : exprToLatex(f.expr));
  const showState = (f, i) => {
    const p = prepare(c).list.find(q => q.entry === f);
    const bad = !!(p && p.error && String(f.expr || '').trim());
    fields[i] && fields[i].classList.toggle('bad', bad);
    const hint = p && p.cond && p.cond.hint;
    err.classList.toggle('hint', !bad && !!hint);
    err.textContent = bad ? `⚠︎ ${p.error}` : hint ? `ⓘ ${hint}` : '';
  };
  const renderRows = () => {
    list.innerHTML = '';
    fields = [];
    const prep = prepare(c);
    const ready = [];
    c.functions.forEach((f, i) => {
      const info = prep.list.find(p => p.entry === f);
      const color = info && info.color || PLOT_COLORS[i % PLOT_COLORS.length];
      const dot = h('button', { class: 'color-dot', style: { background: color }, 'data-tip': 'Farbe' });
      dot.addEventListener('click', () => {
        const grid = h('div', { class: 'swatch-row', style: { padding: '4px' } });
        const pop = ed.ui.popover(dot, grid, { class: 'color-pop' });
        for (const col of PLOT_COLORS) {
          const sw = h('button', { class: 'swatch' + (col === color ? ' on' : ''), style: { background: col } });
          sw.addEventListener('click', () => { f.color = col; pop.close(); renderRows(); repaint(); });
          grid.append(sw);
        }
      });
      const slot = h('div', { class: 'fn-field' });
      ready.push(createField({
        value: texOf(f),
        inline: true,
        shortcuts: PLOT_SHORTCUTS,
        onInput: (tex) => {
          f.tex = tex;
          f.expr = latexToExpr(tex);
          showState(f, i);
          repaintSoon();
        },
        onKey: (e, mf) => {
          if (e.key === 'Enter') { addRow('', i + 1); return true; }
          if (e.key === 'Escape') { ed.deactivate({ select: true }); return true; }
          if (e.key === 'Backspace' && !mf.getValue('latex') && c.functions.length > 1) {
            c.functions.splice(i, 1);
            pending = { index: Math.max(0, i - 1), end: true };
            renderRows();
            repaint();
            return true;
          }
          if (e.key === 'ArrowDown' && fields[i + 1]) { fields[i + 1].focus(); return true; }
          if (e.key === 'ArrowUp' && i > 0 && fields[i - 1]) { fields[i - 1].focus(); return true; }
          return false;
        }
      }).then((mf) => {
        mf.addEventListener('focus', () => { focusIdx = i; showState(f, i); });
        // "für", "oder", "und" als Wort setzen und danach im Formelmodus weiterschreiben
        // (erst wenn die Eingabe zur Ruhe gekommen ist – Tastendrücke kommen gebündelt an)
        let wordTimer = null;
        mf.addEventListener('input', () => {
          clearTimeout(wordTimer);
          wordTimer = setTimeout(() => {
            if (mf.mode !== 'math') return;
            const pos = mf.position;
            const m = /(?:^|[^a-zA-Z\\])(für|fuer|oder|und)$/.exec(mf.getValue(0, pos));
            if (!m) return;
            const len = m[1].length;
            if (mf.getValue(pos - len, pos) !== m[1]) return;
            mf.selection = { ranges: [[pos - len, pos]] };
            mf.insert(`\\text{ ${m[1] === 'fuer' ? 'für' : m[1]} }`, { insertionMode: 'replaceSelection', selectionMode: 'after' });
            mf.executeCommand(['switchMode', 'math']);
          }, 0);
        });
        mf.setAttribute('placeholder', i === 0 ? '\\text{z. B. } f(x)=x^2' : '');
        fields[i] = mf;
        slot.append(mf);
        if (info && info.error && String(f.expr || '').trim()) mf.classList.add('bad');
      }));
      const dash = h('button', { class: 'btn icon-only sm' + (f.dashed ? ' on' : ''), 'data-tip': 'Gestrichelt', html: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 12h4M10 12h4M17 12h4"/></svg>' });
      dash.addEventListener('click', () => { f.dashed = !f.dashed || undefined; renderRows(); repaint(); });
      const eye = h('button', { class: 'btn icon-only sm', 'data-tip': f.hidden ? 'Einblenden' : 'Ausblenden', html: icon('eye', 'sm') });
      eye.style.opacity = f.hidden ? 0.4 : 1;
      eye.addEventListener('click', () => { f.hidden = !f.hidden || undefined; renderRows(); repaint(); });
      const del = h('button', { class: 'btn icon-only sm', 'data-tip': 'Entfernen', html: icon('trash', 'sm') });
      del.addEventListener('click', () => { c.functions.splice(i, 1); if (!c.functions.length) c.functions.push({ expr: '' }); renderRows(); repaint(); });
      list.append(h('div', { class: 'fn-row' }, dot, slot, dash, eye, del));
    });
    return Promise.all(ready).then(() => {
      if (!pending) return;
      const { index, end } = pending;
      pending = null;
      const mf = fields[index];
      if (!mf) return;
      mf.focus();
      focusIdx = index;
      // Erstes Kästchen einer Vorlage auswählen, sonst ans Ende
      if (!end && /\\placeholder/.test(mf.getValue('latex'))) { mf.position = 0; mf.executeCommand('moveToNextPlaceholder'); }
      else mf.position = mf.lastOffset;
    });
  };
  // Neue Zeile (LaTeX mit \placeholder{} für die Kästchen)
  const addRow = (tex, at = Math.min(focusIdx + 1, c.functions.length)) => {
    c.functions.splice(at, 0, { tex, expr: latexToExpr(tex) });
    pending = { index: at };
    const done = renderRows();
    repaint();
    return done;
  };
  // Schreibfeld für den Pencil: in die gewählte Zeile, wenn sie leer ist – sonst neue Funktion
  panel.parentElement._hw = async (text, { newLine } = {}) => {
    let i = focusIdx;
    const cur = fields[i];
    if (newLine || !cur || cur.getValue('latex').trim()) {
      i = c.functions.length;
      await addRow('', i);
      await new Promise(r => requestAnimationFrame(r));
    }
    const mf = fields[i];
    if (!mf || !text) return;
    if (!/\\placeholder/.test(mf.getValue('latex'))) mf.position = mf.lastOffset;
    writeInto(mf, text);
    focusIdx = i;
  };
  renderRows();

  const add = h('button', { class: 'btn sm outline' }, icon('plus', 'sm'), 'Funktion');
  add.addEventListener('click', () => addRow('', c.functions.length));

  // Hilfsknöpfe: Einschränkung, abschnittsweise, Ableitung, Tangente, Fläche
  const nameAt = (i) => {
    const prep = prepare(c);
    const r = prep.list.find(x => x.entry === c.functions[i]);
    if (r && r.name && !r.param && r.kind === 'fn') return r.name;
    const first = prep.list.find(x => x.name && x.kind === 'fn');
    return first ? first.name : 'f';
  };
  const hasCond = (f) => f && !!splitCondition(splitDefinition(f.expr || '').body).cond;
  // In die aktuelle Zeile einfügen (am Ende oder an der Einfügemarke)
  const insertInRow = (tex, { atEnd = false } = {}) => {
    const mf = fields[focusIdx];
    if (!mf) return;
    mf.focus();
    if (atEnd) mf.position = mf.lastOffset;
    mf.insert(tex, { selectionMode: /#\?/.test(tex) ? 'placeholder' : 'after', format: 'latex' });
    mf.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const helpers = h('div', { class: 'chem-helpers plot-helpers' });
  const helper = (label, tip, fn) => {
    const bt = h('button', { 'data-tip': tip }, label);
    bt.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
    helpers.append(bt);
  };
  helper('Einschränken', 'Nur ein Teil des Graphen, z. B. für x < 3 oder für 0 ≤ x ≤ 2. Nochmal klicken: weitere Bedingung (mit ; getrennt)', () => {
    const f = c.functions[focusIdx];
    if (!f) return;
    insertInRow(hasCond(f) ? ';x>#?' : '\\text{ für }x<#?', { atEnd: true });
  });
  helper('Abschnittsweise', 'Weiterer Abschnitt derselben Funktion (gleicher Name, anderer Bereich)', () => {
    const n = nameAt(focusIdx);
    if (!hasCond(c.functions[focusIdx])) insertInRow('\\text{ für }x<0', { atEnd: true });
    addRow(`${n}(x)=\\placeholder{}\\text{ für }x\\ge0`);
  });
  helper("f′ Ableitung", 'Graph der Ableitung – der abgeleitete Term steht in der Legende', () => addRow(`${nameAt(focusIdx)}^{\\prime}(x)`));
  helper('Tangente', 'Tangente an der Stelle x = …', () => addRow(`\\operatorname{tangente}\\left(${nameAt(focusIdx)},\\placeholder{}\\right)`));
  helper('∫ Fläche', 'Fläche zwischen Graph und x-Achse mit exaktem Wert – Grenzen in die Kästchen', () => addRow(`\\int_{\\placeholder{}}^{\\placeholder{}}${nameAt(focusIdx)}(x)\\,\\mathrm{d}x`));
  for (const [sym, tex] of [['≤', '\\le'], ['≥', '\\ge'], ['∈', '\\in'], ['∞', '\\infty'], ['π', '\\pi']]) helper(sym, `„${sym}“ einfügen`, () => insertInRow(tex));

  const num = (key, label) => {
    const inp = h('input', { class: 'input', value: c[key] ?? '', placeholder: key.startsWith('y') ? 'auto' : '' });
    inp.addEventListener('input', () => {
      const v = inp.value.trim().replace(',', '.');
      c[key] = v === '' ? undefined : Number(v);
      if (v !== '' && !Number.isFinite(c[key])) return;
      repaint();
    });
    return h('label', {}, label, inp);
  };
  const ranges = h('div', { class: 'plot-grid-inputs' }, num('xmin', 'x von'), num('xmax', 'x bis'), num('ymin', 'y von'), num('ymax', 'y bis'));
  b._syncPanel = () => {
    const ins = ranges.querySelectorAll('input');
    ['xmin', 'xmax', 'ymin', 'ymax'].forEach((k, i) => { ins[i].value = c[k] ?? ''; });
  };

  const chk = (key, label, def = false) => {
    const inp = h('input', { type: 'checkbox' });
    inp.checked = c[key] === undefined ? def : !!c[key];
    inp.addEventListener('change', () => { c[key] = inp.checked; repaint(); });
    return h('label', { class: 'chk' }, inp, label);
  };
  const points = h('input', { class: 'input', value: c.points || '', placeholder: 'Punkte, z. B.  P(1|2)  Q(-2|0,5)', spellcheck: 'false' });
  points.addEventListener('input', () => { c.points = points.value || undefined; repaint(); });

  const size = h('div', { class: 'segmented' });
  const wIn = h('input', { class: 'input', value: formatWidth(c.w), placeholder: 'Breite', 'data-tip': 'z. B. 12 cm oder 80 %' });
  const hIn = h('input', { class: 'input', value: formatWidth(c.h), placeholder: 'Höhe', 'data-tip': 'z. B. 8 cm' });
  wIn.style.width = hIn.style.width = '88px';
  const markSize = () => size.querySelectorAll('button').forEach(x => x.classList.toggle('on', !c.w && !c.h && x.dataset.k === (c.size || 'M')));
  for (const [k, l] of [['S', 'Klein'], ['M', 'Mittel'], ['L', 'Groß']]) {
    const bt = h('button', { 'data-k': k }, l);
    bt.addEventListener('click', () => { c.size = k; delete c.w; delete c.h; wIn.value = hIn.value = ''; markSize(); repaint(); });
    size.append(bt);
  }
  markSize();
  const sizeInput = (inp, key) => inp.addEventListener('change', () => {
    const v = parseWidth(inp.value);
    if (inp.value.trim() && (!v || /fr$/.test(v))) { inp.value = formatWidth(c[key]); return; }
    if (v) c[key] = v; else delete c[key];
    inp.value = formatWidth(c[key]);
    markSize();
    repaint();
  });
  sizeInput(wIn, 'w');
  sizeInput(hIn, 'h');
  b._syncSize = () => { wIn.value = formatWidth(c.w); hIn.value = formatWidth(c.h); markSize(); };
  const capBtn = h('button', { class: 'btn sm' }, 'Beschriftung');
  capBtn.addEventListener('click', () => { b._cap = true; b.caption = b.caption || ''; b._repaint(); ed.elOf(b).querySelector('.caption')?.focus(); });

  panel.append(
    list,
    h('div', { class: 'panel-row' }, add, h('span', { class: 'hint grow', html: 'Tippen wie im Formelfeld: <b>wurzel</b>, <b>/</b> Bruch, <b>integral</b> … · <b>für</b> x &lt; 3 · mehrere Bedingungen mit <b>;</b> · f\'(x) · <kbd>Enter</kbd> neue Zeile' })),
    helpers,
    err,
    h('div', { class: 'panel-row' }, points),
    h('div', { class: 'panel-row' }, ranges),
    h('div', { class: 'panel-row', style: { flexWrap: 'wrap', gap: '14px' } },
      chk('special', 'Besondere Punkte (N, H, T, S)'), chk('inflection', 'Wendepunkte'), chk('grid', 'Gitter', true),
      chk('equal', 'Gleiche Einheiten', true), chk('legend', 'Legende', true)),
    h('div', { class: 'panel-row', style: { flexWrap: 'wrap' } }, size, wIn, h('span', { class: 'hint', text: '×' }), hIn, capBtn, h('span', { class: 'grow' }),
      h('span', { class: 'hint', html: 'Ziehen verschiebt · <kbd>⌘</kbd> + Scrollen zoomt · Ecke unten rechts: Größe' }))
  );
  requestAnimationFrame(() => list.querySelector('input')?.focus());
}
