// Tabellen-Block.
//
// Jede Zelle ist ein eigenes kleines Textfeld mit denselben Auszeichnungen wie
// normaler Text (fett, Formeln …). Tab springt zur nächsten Zelle, am Ende
// entsteht automatisch eine neue Zeile – wie in Notion oder Word.

import { h } from '../../ui/ui.js';
import { icon } from '../../ui/icons.js';
import { normalizeHTML, htmlToSegs } from '../../core/inline.js';
import { captionEl } from './atoms.js';
import { parseExpr, compile, formatNumber } from '../../core/mathexpr.js';
import { setSelectionIn, textLength, getSelectionIn } from '../caret.js';
import {
  normalizeTable, cellMap, anchorAt, ncols, rectFrom, rectSize, inRect, mergeRect, splitRect, hasMergeIn,
  insertRow, insertCol, deleteRow, deleteCol, setBg, clearRect, stepCell
} from '../../core/tablegrid.js';
import { widthDialog } from '../widthdialog.js';
import { distribute, toPx, widthKind, ratioOf, fromPx, formatWidth, parseWidth } from '../../core/widths.js';

export function emptyTable(rows = 3, cols = 3) {
  return { rows: Array.from({ length: rows }, () => Array(cols).fill('')), header: true, aligns: [] };
}

// Markierte Zellen je Tabelle (nicht im Dokument gespeichert)
const selections = new WeakMap();
const selOf = (b) => { let s = selections.get(b); if (!s) { s = { rect: null, anchor: null, head: null }; selections.set(b, s); } return s; };

const BG_NAMES = { yellow: 'Gelb', orange: 'Orange', red: 'Rot', pink: 'Rosa', purple: 'Lila', blue: 'Blau', green: 'Grün', brown: 'Braun', gray: 'Grau' };

export const table = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    if (!b.rows || !b.rows.length) Object.assign(b, emptyTable());
    normalizeTable(b);
    const map = cellMap(b);
    const ncol = ncols(b);
    selOf(b).rect = null;
    const wrap = h('div', { class: 'table-wrap', tabindex: '-1' });
    const tbl = h('table', { class: 'htable' + (b.header !== false ? ' header' : '') + (b.headerCol ? ' header-col' : '') });
    const tbody = h('tbody');
    b.rows.forEach((row, ri) => {
      const tr = h('tr');
      row.forEach((cellHTML, ci) => {
        const x = map[ri][ci];
        if (!x.anchor) return;
        const td = h('td', { 'data-align': (b.aligns || [])[ci] || null, 'data-bg': (b.bg && b.bg[ri] && b.bg[ri][ci]) || null, 'data-r': ri, 'data-c': ci });
        if (x.rs > 1) td.rowSpan = x.rs;
        if (x.cs > 1) td.colSpan = x.cs;
        if (ci === 0 && b.headerCol) td.classList.add('hcol');
        const cell = h('div', { class: 'cell', contenteditable: ed.readonly ? 'false' : 'true', spellcheck: 'true', 'data-r': ri, 'data-c': ci });
        cell.innerHTML = cellHTML;
        ed.hydrateInline(cell);
        td.append(cell);
        tr.append(td);
      });
      tbody.append(tr);
    });
    tbl.append(tbody);
    wrap.append(tbl);
    if (!ed.readonly) {
      const addCol = h('button', { class: 'table-add col', 'data-tip': 'Spalte hinzufügen', html: icon('plus', 'sm') });
      const addRow = h('button', { class: 'table-add row', 'data-tip': 'Zeile hinzufügen', html: icon('plus', 'sm') });
      addCol.addEventListener('mousedown', (e) => { e.preventDefault(); ed.checkpoint(); insertCol(b, ncol); ed.rerender(b); ed.changed(); });
      addRow.addEventListener('mousedown', (e) => { e.preventDefault(); ed.checkpoint(); insertRow(b, b.rows.length); ed.rerender(b); ed.changed(); focusCell(ed, b, b.rows.length - 1, 0); });
      wrap.append(addCol, addRow);
      attachCellEvents(ed, b, tbl, wrap);
    }
    main.append(wrap);
    // Breiten erst berechnen, wenn die Tabelle auf der Seite ist (auch beim Drucken)
    wrap._layout = () => {
      layoutTable(tbl, b, wrap);
      if (ed.readonly) return;
      const addCol = wrap.querySelector('.table-add.col'), addRow = wrap.querySelector('.table-add.row');
      const tr = tbl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      if (addCol) { addCol.style.left = (tr.right - wr.left + wrap.scrollLeft + 4) + 'px'; addCol.style.height = tr.height + 'px'; }
      if (addRow) { addRow.style.top = (tr.bottom - wr.top + 3) + 'px'; addRow.style.width = tr.width + 'px'; }
      placeColHandles(ed, b, tbl, wrap);
    };
    setTimeout(() => wrap.isConnected && wrap._layout(), 0);
    if (b.caption || b._cap) main.append(captionEl(ed, b, 'Tabellenbeschriftung …', 'tab'));
  },
  focus(ed, b, main, where) {
    const cells = main.querySelectorAll('.cell');
    const cell = where === 'end' ? cells[cells.length - 1] : cells[0];
    if (cell) { cell.focus(); setSelectionIn(cell, where === 'end' ? textLength(cell) : 0); }
  }
};

// ---------------------------------------------------------------------------
// Spaltenbreiten: b.colWidths (pro Spalte "2fr", "3cm", … oder null) und
// b.tableWidth (null = automatisch, "full" = ganze Breite, oder fest)
// ---------------------------------------------------------------------------

function tableSpecs(b) {
  const C = ncols(b);
  return Array.from({ length: C }, (_, i) => (b.colWidths && b.colWidths[i]) || null);
}

function isSized(b) {
  return !!(b.tableWidth || (b.colWidths && b.colWidths.some(Boolean)));
}

// Pixelbreiten berechnen und setzen; gibt sie zurück (oder null ohne Vorgaben)
export function layoutTable(tbl, b, wrap) {
  let cg = tbl.querySelector(':scope > colgroup');
  if (!isSized(b)) {
    tbl.classList.remove('sized');
    tbl.style.width = '';
    if (cg) cg.remove();
    return null;
  }
  const specs = tableSpecs(b);
  // 2 px Luft für die Rahmenlinien, sonst ragt die Tabelle über den Rand
  const avail = Math.max(120, ((wrap && wrap.clientWidth) || tbl.parentElement?.clientWidth || 600) - 2);
  let total;
  if (b.tableWidth === 'full') total = avail;
  else if (b.tableWidth) total = Math.min(avail, toPx(b.tableWidth, avail) || avail);
  else if (specs.every(s => widthKind(s) === 'fixed')) total = specs.reduce((a, s) => a + toPx(s, avail), 0);
  else total = avail;
  const px = distribute(specs.map(s => s || '1fr'), total);
  if (!cg) { cg = document.createElement('colgroup'); tbl.prepend(cg); }
  cg.innerHTML = '';
  for (const w of px) { const col = document.createElement('col'); col.style.width = `${w.toFixed(1)}px`; cg.append(col); }
  tbl.classList.add('sized');
  tbl.style.width = `${px.reduce((a, v) => a + v, 0).toFixed(1)}px`;
  return px;
}

// Aktuelle Spaltenbreiten in Pixeln (auch ohne Vorgaben, dann gemessen)
function measureCols(b, tbl) {
  const C = ncols(b);
  const out = new Array(C).fill(0);
  for (const td of tbl.querySelectorAll('td')) {
    if (td.colSpan === 1 && !out[+td.dataset.c]) out[+td.dataset.c] = td.getBoundingClientRect().width;
  }
  const known = out.filter(Boolean);
  const avg = known.length ? known.reduce((a, v) => a + v, 0) / known.length : 100;
  return out.map(v => v || avg);
}

// Ziehgriffe an den Spaltengrenzen
function placeColHandles(ed, b, tbl, wrap) {
  wrap.querySelectorAll('.tcol-resize').forEach(x => x.remove());
  const C = ncols(b);
  if (C < 2) return;
  const widths = measureCols(b, tbl);
  const tr = tbl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  let x = tr.left - wr.left + wrap.scrollLeft;
  for (let k = 0; k < C - 1; k++) {
    x += widths[k];
    const g = h('div', { class: 'tcol-resize', 'data-tip': 'Ziehen: Spaltenbreite · Doppelklick: alle gleich breit · Rechtsklick: genaue Werte' });
    g.style.left = `${x - 4}px`;
    g.style.top = `${tr.top - wr.top}px`;
    g.style.height = `${tr.height}px`;
    g.addEventListener('mousedown', (e) => startColDrag(ed, b, tbl, wrap, k, e));
    g.addEventListener('dblclick', (e) => { e.preventDefault(); ed.checkpoint(); b.colWidths = tableSpecs(b).map(() => '1fr'); ed.rerender(b); ed.changed(); });
    g.addEventListener('contextmenu', (e) => { e.preventDefault(); tableWidthsDialog(ed, b); });
    wrap.append(g);
  }
}

function startColDrag(ed, b, tbl, wrap, k, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  ed.checkpoint();
  const avail = wrap.clientWidth;
  const measured = measureCols(b, tbl);
  // Erstes Ziehen ohne Vorgaben: jetzige Breiten als Anteile übernehmen, Tabellenbreite behalten
  if (!isSized(b)) {
    const tw = measured.reduce((a, v) => a + v, 0);
    const unit = tw / measured.length;
    b.colWidths = measured.map(w => `${+(w / unit).toFixed(2)}fr`);
    b.tableWidth = tw >= avail - 2 ? 'full' : `${Math.round(tw / avail * 100)}%`;
    layoutTable(tbl, b, wrap);
  }
  const specs = tableSpecs(b).map(s => s || '1fr');
  b.colWidths = specs;
  const px = measureCols(b, tbl);
  const w1 = px[k], w2 = px[k + 1];
  const ratioSum = ratioOf(specs[k]) + ratioOf(specs[k + 1]);
  const x0 = e.clientX;
  const tip = h('div', { class: 'tcol-tip' });
  wrap.append(tip);
  document.body.classList.add('col-resizing');
  const move = (ev) => {
    const dx = ev.clientX - x0;
    const a = Math.max(30, Math.min(w1 + w2 - 30, w1 + dx)), c = w1 + w2 - a;
    const total = tbl.getBoundingClientRect().width;
    b.colWidths[k] = widthKind(specs[k]) === 'fixed' ? fromPx(a, specs[k], total) : `${+(ratioSum * a / (a + c)).toFixed(2)}fr`;
    b.colWidths[k + 1] = widthKind(specs[k + 1]) === 'fixed' ? fromPx(c, specs[k + 1], total) : `${+(ratioSum * c / (a + c)).toFixed(2)}fr`;
    layoutTable(tbl, b, wrap);
    tip.textContent = `${formatWidth(b.colWidths[k])}  |  ${formatWidth(b.colWidths[k + 1])}`;
    const tr = tbl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    tip.style.left = `${ev.clientX - wr.left + wrap.scrollLeft}px`;
    tip.style.top = `${tr.top - wr.top - 24}px`;
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('col-resizing');
    tip.remove();
    wrap._layout && wrap._layout();
    ed.changed();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

export async function tableWidthsDialog(ed, b) {
  const C = ncols(b);
  // Tabellenbreite: automatisch / ganze Breite / fest
  let mode = !b.tableWidth ? 'auto' : b.tableWidth === 'full' ? 'full' : 'fixed';
  const fixedInput = h('input', { class: 'input', value: mode === 'fixed' ? formatWidth(b.tableWidth) : '', placeholder: 'z. B. 12 cm oder 80 %' });
  const seg = h('div', { class: 'segmented' });
  for (const [v, l] of [['auto', 'Automatisch'], ['full', 'Ganze Breite'], ['fixed', 'Fest']]) {
    const btn = h('button', { class: mode === v ? 'on' : '', text: l });
    btn.addEventListener('click', () => { mode = v; seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn)); fixedInput.style.display = v === 'fixed' ? '' : 'none'; if (v === 'fixed') fixedInput.focus(); });
    seg.append(btn);
  }
  fixedInput.style.display = mode === 'fixed' ? '' : 'none';
  const extra = h('div', { class: 'width-table' }, h('div', { class: 'width-row' }, h('span', { text: 'Tabellenbreite' }), seg), fixedInput);
  const specs = await widthDialog({ title: 'Spaltenbreiten der Tabelle', labels: Array.from({ length: C }, (_, i) => `Spalte ${i + 1}`), specs: tableSpecs(b), extra });
  if (!specs) return;
  ed.checkpoint();
  if (specs.some(Boolean)) b.colWidths = specs; else delete b.colWidths;
  if (mode === 'full') b.tableWidth = 'full';
  else if (mode === 'fixed' && parseWidth(fixedInput.value) && !/fr$/.test(parseWidth(fixedInput.value))) b.tableWidth = parseWidth(fixedInput.value);
  else delete b.tableWidth;
  ed.rerender(b);
  ed.changed();
}

function focusCell(ed, b, r, c, where = 'end') {
  requestAnimationFrame(() => {
    const a = anchorAt(b, r, c);
    const cell = ed.elOf(b)?.querySelector(`.cell[data-r="${a.r}"][data-c="${a.c}"]`);
    if (!cell) return;
    cell.focus();
    setSelectionIn(cell, where === 'start' ? 0 : textLength(cell));
  });
}

// Mehrere Zellen markieren: ziehen, ⇧-Klick oder ⇧-Pfeiltasten
function paintSelection(b, tbl, wrap) {
  const st = selOf(b);
  const multi = st.rect && rectSize(st.rect) > 1;
  for (const td of tbl.querySelectorAll('td')) td.classList.toggle('cell-sel', !!multi && inRect(st.rect, +td.dataset.r, +td.dataset.c));
  wrap.classList.toggle('selecting', !!multi);
}

function selectCells(ed, b, tbl, wrap, from, to) {
  const st = selOf(b);
  st.anchor = from;
  st.head = to;
  st.rect = rectFrom(b, anchorAt(b, from.r, from.c), anchorAt(b, to.r, to.c));
  paintSelection(b, tbl, wrap);
  if (rectSize(st.rect) > 1) {
    window.getSelection().removeAllRanges();
    if (document.activeElement && tbl.contains(document.activeElement)) document.activeElement.blur();
    wrap.focus({ preventScroll: true });
  }
}

function clearCellSelection(b, tbl, wrap) {
  const st = selOf(b);
  st.rect = null;
  st.anchor = st.head = null;
  paintSelection(b, tbl, wrap);
}

function attachCellEvents(ed, b, tbl, wrap) {
  const op = (fn) => { ed.checkpoint(); fn(); ed.rerender(b); ed.changed(); };
  const posOf = (el) => { const td = el && el.closest && el.closest('td'); return td && tbl.contains(td) ? { r: +td.dataset.r, c: +td.dataset.c } : null; };
  tbl.addEventListener('input', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const r = +cell.dataset.r, c = +cell.dataset.c;
    b.rows[r][c] = normalizeHTML(cell.innerHTML);
    ed.changed({ soft: true });
  });
  tbl.addEventListener('focusin', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    ed.setFocusBlock(b);
    if (selOf(b).rect) clearCellSelection(b, tbl, wrap);
  });

  // Maus: in eine andere Zelle ziehen markiert ein Rechteck
  let drag = null;
  tbl.addEventListener('mousedown', (e) => {
    const pos = posOf(e.target);
    if (!pos) return;
    const st = selOf(b);
    // Rechtsklick in die Markierung: Markierung behalten (Zelle nicht fokussieren)
    if (e.button === 2 && st.rect && rectSize(st.rect) > 1 && inRect(st.rect, pos.r, pos.c)) { e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (e.shiftKey) {
      const from = st.anchor || posOf(document.activeElement);
      if (from) { e.preventDefault(); selectCells(ed, b, tbl, wrap, from, pos); }
      return;
    }
    if (st.rect) clearCellSelection(b, tbl, wrap);
    drag = { start: pos };
    window.addEventListener('mouseup', () => { drag = null; }, { once: true });
  });
  tbl.addEventListener('mouseover', (e) => {
    if (!drag || !(e.buttons & 1)) return;
    const pos = posOf(e.target);
    if (!pos) return;
    const same = pos.r === drag.start.r && pos.c === drag.start.c;
    if (same && !selOf(b).rect) return;
    selectCells(ed, b, tbl, wrap, drag.start, pos);
  });

  // Tasten, solange mehrere Zellen markiert sind
  wrap.addEventListener('keydown', (e) => {
    const st = selOf(b);
    if (!st.rect || e.target !== wrap) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = st.anchor; clearCellSelection(b, tbl, wrap); if (a) focusCell(ed, b, a.r, a.c); return; }
    if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); e.stopPropagation(); const r = st.rect; op(() => clearRect(b, r)); return; }
    if (e.shiftKey && k.startsWith('Arrow')) {
      e.preventDefault(); e.stopPropagation();
      const hd = { ...st.head };
      const R = b.rows.length, C = ncols(b);
      if (k === 'ArrowUp') hd.r = Math.max(0, hd.r - 1);
      if (k === 'ArrowDown') hd.r = Math.min(R - 1, hd.r + 1);
      if (k === 'ArrowLeft') hd.c = Math.max(0, hd.c - 1);
      if (k === 'ArrowRight') hd.c = Math.min(C - 1, hd.c + 1);
      selectCells(ed, b, tbl, wrap, st.anchor, hd);
      return;
    }
    if (UI_MOD(e) && k.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); selectCells(ed, b, tbl, wrap, { r: 0, c: 0 }, { r: b.rows.length - 1, c: ncols(b) - 1 }); }
  });
  // Kopieren: markierte Zellen als Text mit Tabulatoren (passt in Excel/Numbers)
  wrap.addEventListener('copy', (e) => {
    const st = selOf(b);
    if (!st.rect || e.target !== wrap) return;
    e.preventDefault();
    const x = st.rect, lines = [];
    for (let r = x.r1; r <= x.r2; r++) {
      const cols = [];
      for (let c = x.c1; c <= x.c2; c++) cols.push(htmlToSegs(b.rows[r][c]).map(sg => sg.text || (sg.t === 'math' ? sg.tex : '')).join(''));
      lines.push(cols.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
  });

  tbl.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    if (ed.inlineMenuOpen && ed.inlineMenuOpen()) return;
    const r = +cell.dataset.r, c = +cell.dataset.c;
    const here = anchorAt(b, r, c);
    const nrow = b.rows.length, ncol = ncols(b);
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const next = stepCell(b, r, c, e.shiftKey ? -1 : 1);
      if (next) { focusCell(ed, b, next.r, next.c); return; }
      if (e.shiftKey) return;
      op(() => insertRow(b, nrow));
      focusCell(ed, b, nrow, 0);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      const below = here.r + here.rs;
      if (below >= nrow) op(() => insertRow(b, nrow));
      focusCell(ed, b, below, c);
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      document.execCommand('insertLineBreak');
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); ed.exitAtom(b, 'after'); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cell.blur(); ed.selectBlocks([b]); return; }
    const sel = getSelectionIn(cell);
    const atStart = sel && sel.collapsed && sel.start === 0;
    const atEnd = sel && sel.collapsed && sel.start === textLength(cell);
    // ⇧ + Pfeil am Rand der Zelle: Zellen markieren
    if (e.shiftKey && e.key.startsWith('Arrow')) {
      const edge = (e.key === 'ArrowLeft' && atStart) || (e.key === 'ArrowRight' && atEnd) || e.key === 'ArrowUp' || e.key === 'ArrowDown';
      if (edge) {
        const to = { r, c };
        if (e.key === 'ArrowUp') to.r = Math.max(0, r - 1);
        if (e.key === 'ArrowDown') to.r = Math.min(nrow - 1, here.r + here.rs);
        if (e.key === 'ArrowLeft') to.c = Math.max(0, c - 1);
        if (e.key === 'ArrowRight') to.c = Math.min(ncol - 1, here.c + here.cs);
        if (to.r !== r || to.c !== c) { e.preventDefault(); e.stopPropagation(); selectCells(ed, b, tbl, wrap, { r, c }, to); }
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (here.r === 0) ed.exitAtom(b, 'before'); else focusCell(ed, b, here.r - 1, c);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      if (here.r + here.rs >= nrow) ed.exitAtom(b, 'after'); else focusCell(ed, b, here.r + here.rs, c);
      return;
    }
    if (e.key === 'ArrowLeft' && atStart) {
      if (here.c > 0) { e.preventDefault(); e.stopPropagation(); focusCell(ed, b, r, here.c - 1, 'end'); }
      return;
    }
    if (e.key === 'ArrowRight' && atEnd) {
      if (here.c + here.cs < ncol) { e.preventDefault(); e.stopPropagation(); focusCell(ed, b, r, here.c + here.cs, 'start'); }
      return;
    }
    if (e.key === 'Backspace' && atStart && textLength(cell) === 0) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
    // Andere Tasten (⌘B usw.) übernimmt der Editor
  });
  const openMenu = (e) => {
    const pos = posOf(e.target);
    if (!pos) return;
    e.preventDefault();
    const st = selOf(b);
    const rect = st.rect && rectSize(st.rect) > 1 && inRect(st.rect, pos.r, pos.c) ? st.rect : null;
    if (!rect && st.rect) clearCellSelection(b, tbl, wrap);
    ed.ui.menu({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 }, tableMenu(ed, b, pos.r, pos.c, rect));
  };
  tbl.addEventListener('contextmenu', openMenu);
}

const UI_MOD = (e) => (navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey);

function swatch(color) {
  const bg = color ? `color-mix(in srgb, var(--m-${color}) 70%, transparent)` : 'transparent';
  return `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--border-strong);background:${bg};margin-right:2px"></span>`;
}

export function tableMenu(ed, b, r = 0, c = 0, rect = null) {
  normalizeTable(b);
  const op = (fn) => () => { ed.checkpoint(); fn(); ed.rerender(b); ed.changed(); };
  const here = anchorAt(b, r, c);
  const area = rect || { r1: here.r, c1: here.c, r2: here.r + here.rs - 1, c2: here.c + here.cs - 1 };
  const R = b.rows.length, C = ncols(b);
  const colorMenu = [
    { label: 'Keine Farbe', html: swatch(null), onSelect: op(() => setBg(b, area, null)) },
    ...Object.keys(BG_NAMES).map(k => ({ label: BG_NAMES[k], html: swatch(k), checked: b.bg && b.bg[area.r1] && b.bg[area.r1][area.c1] === k, onSelect: op(() => setBg(b, area, k)) }))
  ];
  const align = (a) => op(() => {
    b.aligns = b.aligns || [];
    while (b.aligns.length < C) b.aligns.push(null);
    for (let k = area.c1; k <= area.c2; k++) b.aligns[k] = a;
  });
  const alignMenu = { label: rect ? 'Spalten ausrichten' : 'Spalte ausrichten', icon: 'alignLeft', submenu: [
    { label: 'Links', icon: 'alignLeft', onSelect: align('left') },
    { label: 'Mitte', icon: 'alignCenter', onSelect: align('center') },
    { label: 'Rechts', icon: 'alignRight', onSelect: align('right') }
  ] };
  const merged = hasMergeIn(b, area);
  const rowsDel = area.r2 - area.r1 + 1, colsDel = area.c2 - area.c1 + 1;
  const delRows = op(() => { for (let k = area.r2; k >= area.r1; k--) deleteRow(b, k); });
  const delCols = op(() => { for (let k = area.c2; k >= area.c1; k--) deleteCol(b, k); });

  if (rect) {
    const n = rectSize(rect);
    return [
      { section: `${n} Zellen markiert` },
      { label: 'Zellen verbinden', icon: 'columns', onSelect: op(() => mergeRect(b, rect)) },
      merged ? { label: 'Verbindungen aufheben', icon: 'table', onSelect: op(() => splitRect(b, rect)) } : null,
      { label: 'Zellfarbe', icon: 'palette', submenu: colorMenu },
      alignMenu,
      { label: 'Inhalt leeren', icon: 'eraser', hint: '⌫', onSelect: op(() => clearRect(b, rect)) },
      '-',
      { label: rowsDel > 1 ? `${rowsDel} Zeilen löschen` : 'Zeile löschen', icon: 'trash', danger: true, disabled: rowsDel >= R, onSelect: delRows },
      { label: colsDel > 1 ? `${colsDel} Spalten löschen` : 'Spalte löschen', icon: 'trash', danger: true, disabled: colsDel >= C, onSelect: delCols }
    ];
  }
  const right = here.c + here.cs, below = here.r + here.rs;
  return [
    { label: 'Zeile darüber einfügen', icon: 'arrowUp', onSelect: op(() => insertRow(b, here.r)) },
    { label: 'Zeile darunter einfügen', icon: 'arrowDown', onSelect: op(() => insertRow(b, below)) },
    { label: 'Spalte links einfügen', icon: 'chevronLeft', onSelect: op(() => insertCol(b, here.c)) },
    { label: 'Spalte rechts einfügen', icon: 'chevronRight', onSelect: op(() => insertCol(b, right)) },
    '-',
    { label: 'Zellen verbinden', icon: 'columns', submenu: [
      { label: 'Mit der Zelle rechts', icon: 'arrowRight', disabled: right >= C, onSelect: op(() => mergeRect(b, { r1: here.r, c1: here.c, r2: below - 1, c2: right })) },
      { label: 'Mit der Zelle darunter', icon: 'arrowDown', disabled: below >= R, onSelect: op(() => mergeRect(b, { r1: here.r, c1: here.c, r2: below, c2: right - 1 })) },
      { label: 'Ganze Zeile', icon: 'alignJustify', disabled: C < 2, onSelect: op(() => mergeRect(b, { r1: here.r, c1: 0, r2: below - 1, c2: C - 1 })) },
      { label: 'Ganze Spalte', icon: 'columns', disabled: R < 2, onSelect: op(() => mergeRect(b, { r1: 0, c1: here.c, r2: R - 1, c2: right - 1 })) },
      '-',
      { label: 'Tipp: Zellen mit der Maus markieren (ziehen oder ⇧-Klick)', disabled: true }
    ] },
    merged ? { label: 'Verbindung aufheben', icon: 'table', onSelect: op(() => splitRect(b, area)) } : null,
    { label: 'Zellfarbe', icon: 'palette', submenu: colorMenu },
    '-',
    alignMenu,
    { label: 'Spaltenbreiten …', icon: 'columns', onSelect: () => tableWidthsDialog(ed, b) },
    isSized(b) ? { label: 'Breiten zurücksetzen', icon: 'refresh', onSelect: op(() => { delete b.colWidths; delete b.tableWidth; }) } : null,
    { label: 'Kopfzeile', icon: 'heading', checked: b.header !== false, onSelect: op(() => { b.header = b.header === false; }) },
    { label: 'Kopfspalte', icon: 'heading', checked: !!b.headerCol, onSelect: op(() => { b.headerCol = !b.headerCol || undefined; }) },
    { label: 'Beschriftung', icon: 'text', onSelect: () => { b._cap = true; b.caption = b.caption || ''; ed.rerender(b); requestAnimationFrame(() => ed.elOf(b).querySelector('.caption')?.focus()); } },
    { label: 'Wertetabelle erzeugen …', icon: 'graph', onSelect: () => valueTableDialog(ed, b) },
    '-',
    { label: 'Zeile löschen', icon: 'trash', danger: true, disabled: R <= 1, onSelect: op(() => deleteRow(b, here.r)) },
    { label: 'Spalte löschen', icon: 'trash', danger: true, disabled: C <= 1, onSelect: op(() => deleteCol(b, here.c)) }
  ];
}

// Wertetabelle wie im Matheunterricht: x-Werte oben, f(x) darunter.
async function valueTableDialog(ed, b) {
  const fx = h('input', { class: 'input mono', value: 'x^2 - 2', placeholder: 'f(x) =' });
  const from = h('input', { class: 'input', value: '-3' });
  const to = h('input', { class: 'input', value: '3' });
  const step = h('input', { class: 'input', value: '1' });
  const body = h('div', {},
    h('div', { class: 'field' }, h('label', { text: 'Funktion f(x) =' }), fx),
    h('div', { class: 'row' },
      h('div', { class: 'field grow' }, h('label', { text: 'x von' }), from),
      h('div', { class: 'field grow' }, h('label', { text: 'bis' }), to),
      h('div', { class: 'field grow' }, h('label', { text: 'Schritt' }), step)));
  const ok = await ed.ui.dialog({ title: 'Wertetabelle erzeugen', body, center: true, actions: [{ label: 'Abbrechen', value: false }, { label: 'Erzeugen', value: true, primary: true }] }).done;
  if (!ok) return;
  try {
    const f = compile(parseExpr(fx.value.replace(/^\s*[a-z]\(x\)\s*=\s*/i, '')));
    const a = parseFloat(from.value.replace(',', '.')), z = parseFloat(to.value.replace(',', '.')), s = parseFloat(step.value.replace(',', '.'));
    if (!(s > 0) || !(z >= a) || (z - a) / s > 40) throw new Error('Bereich ungültig (höchstens 40 Werte)');
    const xs = [];
    for (let x = a; x <= z + 1e-9; x += s) xs.push(Math.round(x * 1e9) / 1e9);
    ed.checkpoint();
    b.rows = [['<span class="im" data-tex="x"></span>', ...xs.map(x => formatNumber(x))],
      ['<span class="im" data-tex="f(x)"></span>', ...xs.map(x => formatNumber(f(x)))]];
    b.header = true;
    delete b.merges;
    delete b.bg;
    b.aligns = Array(xs.length + 1).fill('center');
    ed.rerender(b);
    ed.changed();
  } catch (err) {
    ed.ui.toast('Wertetabelle: ' + err.message, { type: 'error' });
  }
}

export function tableText(b) {
  return (b.rows || []).map(r => r.map(c => htmlToSegs(c).map(s => s.text || '').join('')).join('\t')).join('\n');
}
