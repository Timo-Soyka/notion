// Funktionsgraph-Block.
//
// Zeichnet ein Koordinatensystem wie im Matheheft: Kästchengitter, Achsen mit
// Pfeilen, Funktionsnamen an den Graphen und – auf Wunsch – die besonderen
// Punkte in Schulschreibweise: N(…|…), H/T für Hoch- und Tiefpunkte,
// S für Schnittpunkte. Alles als SVG, damit es im PDF gestochen scharf bleibt.

import { h, esc } from '../../ui/ui.js';
import { icon } from '../../ui/icons.js';
import {
  parseExpr, compile, toTex, splitDefinition, formatNumber, findRoots, findExtrema, findInflections, usedNames
} from '../../core/mathexpr.js';
import { renderToString } from '../render/katex.js';
import { captionEl, mediaBar } from './atoms.js';
import { toPx, formatWidth, parseWidth, CM_PX } from '../../core/widths.js';

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

export function prepare(config) {
  const entries = (config.functions || []).filter(f => f && String(f.expr || '').trim());
  const params = {};
  const known = {};
  const defs = [];
  let auto = 0;
  const usedAuto = new Set(entries.map(e => splitDefinition(e.expr).name).filter(Boolean));
  entries.forEach((e, i) => {
    const d = splitDefinition(e.expr);
    if (d.param) { defs.push({ ...d, entry: e, index: i, param: true }); return; }
    let name = d.name;
    if (!name && !d.vertical) {
      while (usedAuto.has(AUTO_NAMES[auto])) auto++;
      name = AUTO_NAMES[auto++] || 'f' + i;
    }
    if (name) known[name] = true;
    defs.push({ ...d, name, entry: e, index: i });
  });
  // Parameter (a = 2) zuerst auswerten
  for (const d of defs.filter(x => x.param)) {
    try { params[d.name] = compile(parseExpr(d.body), { params })(0); d.value = params[d.name]; }
    catch (err) { d.error = err.message; }
  }
  const funcs = {};
  const out = [];
  let colorIdx = 0;
  for (const d of defs) {
    if (d.param) { out.push(d); continue; }
    const color = d.entry.color || PLOT_COLORS[colorIdx++ % PLOT_COLORS.length];
    try {
      const tree = parseExpr(d.body, known);
      const fn = compile(tree, { funcs, params });
      if (d.name) funcs[d.name] = fn;
      out.push({ ...d, tree, fn, color, deps: usedNames(tree) });
    } catch (err) {
      out.push({ ...d, error: err.message, color });
    }
  }
  return { list: out, funcs, params };
}

function niceStep(range, pixels, target = 45) {
  const raw = range / Math.max(1, pixels / target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return step * mag;
}

function autoYRange(list, xmin, xmax) {
  const vals = [];
  for (const f of list) {
    if (!f.fn || f.vertical || f.entry.hidden) continue;
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
    [ymin, ymax] = autoYRange(P.list, xmin, xmax);
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

  // Graphen
  const curves = s('g', { 'clip-path': `url(#${clipId})` });
  const labels = s('g');
  const visible = P.list.filter(f => f.fn && !f.entry.hidden && !f.param);
  for (const f of visible) {
    if (f.vertical) {
      let xv;
      try { xv = f.fn(0); } catch { continue; }
      if (!Number.isFinite(xv)) continue;
      curves.append(s('line', { class: 'curve dashed', x1: sx(xv), x2: sx(xv), y1: margin.t, y2: margin.t + plotH, stroke: f.color }));
      continue;
    }
    let d = '';
    let pen = false, lastY = null;
    const N = Math.max(200, Math.round(plotW * 1.5));
    for (let k = 0; k <= N; k++) {
      const x = xmin + (xmax - xmin) * k / N;
      const y = f.fn(x);
      if (!Number.isFinite(y)) { pen = false; lastY = null; continue; }
      let py = sy(y);
      const jump = lastY !== null && Math.abs(py - lastY) > plotH * 1.5;
      py = Math.max(-plotH * 2, Math.min(plotH * 3, py));
      if (!pen || jump) { d += `M${sx(x).toFixed(2)} ${py.toFixed(2)}`; pen = true; }
      else d += `L${sx(x).toFixed(2)} ${py.toFixed(2)}`;
      lastY = py;
    }
    curves.append(s('path', { class: 'curve' + (f.entry.dashed ? ' dashed' : ''), d, stroke: f.color }));
    // Name an den rechten sichtbaren Rand des Graphen
    if (f.name && config.names !== false) {
      for (let k = 0; k <= 60; k++) {
        const x = xmax - (xmax - xmin) * (0.04 + k * 0.012);
        const y = f.fn(x);
        if (Number.isFinite(y) && y > ymin + (ymax - ymin) * 0.06 && y < ymax - (ymax - ymin) * 0.04) {
          const slope = (f.fn(x + 0.01) - y) / 0.01;
          const above = slope * (uy / ux) < 0.8;
          labels.append(s('text', { class: 'curve-label', x: sx(x) - 4, y: sy(y) + (above ? -9 : 17), fill: f.color, 'text-anchor': 'end' }, f.name));
          break;
        }
      }
    }
  }
  svg.append(curves);

  // Besondere Punkte
  const pts = [];
  if (config.special) {
    let nN = 0;
    for (const f of visible.filter(f => !f.vertical)) {
      for (const x of findRoots(f.fn, xmin, xmax)) pts.push({ x, y: 0, name: 'N', color: f.color, fname: f.name });
      for (const e of findExtrema(f.fn, xmin, xmax)) pts.push({ x: e.x, y: e.y, name: e.kind === 'max' ? 'H' : 'T', color: f.color, fname: f.name });
      if (config.inflection) for (const w of findInflections(f.fn, xmin, xmax)) pts.push({ x: w.x, y: w.y, name: 'W', color: f.color, fname: f.name });
    }
    const fl = visible.filter(f => !f.vertical);
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
    for (const f of res.prepared.list) {
      if (!f.tree || f.entry.hidden || f.param) continue;
      const tex = (f.vertical ? 'x = ' : (f.name ? `${f.name}(x) = ` : 'y = ')) + toTex(f.tree);
      const r = renderToString(tex, { display: false, mode: 'latex' });
      const item = h('span', { class: 'item' }, h('span', { class: 'sw', style: { background: f.color } }));
      item.insertAdjacentHTML('beforeend', r.html || esc(f.entry.expr));
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
    const fs = res.prepared.list.filter(f => f.fn && !f.vertical && !f.param && !f.entry.hidden);
    const vals = fs.map(f => `${f.name || 'y'}(${formatNumber(d.x)}) = ${formatNumber(f.fn(d.x))}`);
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

  const renderRows = () => {
    list.innerHTML = '';
    const prep = prepare(c);
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
      const input = h('input', { class: 'input' + (info && info.error ? ' bad' : ''), value: f.expr, placeholder: 'f(x) = x^2 - 2   ·   a = 2   ·   x = 3', spellcheck: 'false' });
      input.addEventListener('input', () => {
        f.expr = input.value;
        const p = prepare(c).list.find(q => q.entry === f);
        input.classList.toggle('bad', !!(p && p.error && input.value.trim()));
        err.textContent = p && p.error && input.value.trim() ? `⚠︎ ${p.error}` : '';
        repaint();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          c.functions.splice(i + 1, 0, { expr: '' });
          renderRows();
          list.querySelectorAll('input')[i + 1]?.focus();
        }
        if (e.key === 'Escape') { e.preventDefault(); ed.deactivate({ select: true }); }
        if (e.key === 'Backspace' && !input.value && c.functions.length > 1) {
          e.preventDefault();
          c.functions.splice(i, 1);
          renderRows();
          repaint();
          list.querySelectorAll('input')[Math.max(0, i - 1)]?.focus();
        }
      });
      const dash = h('button', { class: 'btn icon-only sm' + (f.dashed ? ' on' : ''), 'data-tip': 'Gestrichelt', html: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 12h4M10 12h4M17 12h4"/></svg>' });
      dash.addEventListener('click', () => { f.dashed = !f.dashed || undefined; renderRows(); repaint(); });
      const eye = h('button', { class: 'btn icon-only sm', 'data-tip': f.hidden ? 'Einblenden' : 'Ausblenden', html: icon(f.hidden ? 'eye' : 'eye', 'sm') });
      eye.style.opacity = f.hidden ? 0.4 : 1;
      eye.addEventListener('click', () => { f.hidden = !f.hidden || undefined; renderRows(); repaint(); });
      const del = h('button', { class: 'btn icon-only sm', 'data-tip': 'Entfernen', html: icon('trash', 'sm') });
      del.addEventListener('click', () => { c.functions.splice(i, 1); if (!c.functions.length) c.functions.push({ expr: '' }); renderRows(); repaint(); });
      list.append(h('div', { class: 'fn-row' }, dot, input, dash, eye, del));
    });
  };
  renderRows();

  const add = h('button', { class: 'btn sm outline' }, icon('plus', 'sm'), 'Funktion');
  add.addEventListener('click', () => { c.functions.push({ expr: '' }); renderRows(); list.querySelectorAll('input')[c.functions.length - 1]?.focus(); });

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
    h('div', { class: 'panel-row' }, add, h('span', { class: 'hint grow', text: 'Schreibweise wie im Heft: 0,5x^2 − 3 · sin x · √x · f\'(x) · |x|' })),
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
