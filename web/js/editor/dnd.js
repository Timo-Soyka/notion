// Griff links neben den Blöcken (+ und ⋮⋮), Verschieben per Ziehen,
// Rahmen-Auswahl mit der Maus und Dateien aus dem Finder hineinziehen.

import { h } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { block, isEmptyHTML } from '../core/markdown.js';
import { segsToText, htmlToSegs } from '../core/inline.js';

const CAN_NEST = (b) => !['columns', 'column', 'hr', 'pagebreak', 'toc'].includes(b.type);

export function attachDnd(ed) {
  const d = ed.docEl;
  const handle = h('div', { class: 'blk-handle' });
  const plus = h('button', { 'data-tip': 'Klicken: Block darunter einfügen', 'data-kbd': '⌥-Klick: darüber', html: icon('plus', 'sm') });
  const grip = h('button', { class: 'grip', 'data-tip': 'Ziehen zum Verschieben', 'data-kbd': 'Klicken für Menü', html: icon('grip', 'sm') });
  handle.append(plus, grip);
  d.append(handle);
  let hoverBlock = null;
  let hidden = false;

  const blockAt = (x, y, exclude) => {
    const br = ed.blocksEl.getBoundingClientRect();
    const px = Math.min(Math.max(x, br.left + 8), br.right - 8);
    let el = document.elementFromPoint(px, y);
    if (!el || !ed.docEl.contains(el)) return null;
    let blk = el.closest('.blk:not(.col)');
    while (blk && exclude && exclude.some(b => ed.elOf(b)?.contains(blk))) blk = blk.parentElement?.closest('.blk:not(.col)');
    if (!blk || !ed.blocksEl.contains(blk)) {
      // Zwischen Blöcken: nächstgelegenen Block suchen
      let best = null, dist = Infinity;
      for (const b of ed.flat()) {
        if (exclude && exclude.includes(b)) continue;
        const r = ed.elOf(b)?.querySelector(':scope > .blk-main')?.getBoundingClientRect();
        if (!r) continue;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (dy < dist && x >= r.left - 60 && x <= r.right + 60) { dist = dy; best = b; }
      }
      return dist < 40 ? best : null;
    }
    return ed.find(blk.dataset.id);
  };

  const place = (b) => {
    const el = ed.elOf(b);
    const main = el && el.querySelector(':scope > .blk-main');
    if (!main) { handle.classList.remove('show'); return; }
    const dr = d.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const t = main.querySelector('.blk-text');
    let lineH = 24;
    if (t) lineH = parseFloat(getComputedStyle(t).lineHeight) || 24;
    const topPad = t ? parseFloat(getComputedStyle(t).paddingTop) || 0 : 0;
    const offsetY = t ? topPad + (lineH - 24) / 2 : 4;
    let left = mr.left - dr.left - 48;
    if (b.type === 'callout') left -= 14;
    handle.style.left = left + 'px';
    handle.style.top = (mr.top - dr.top + Math.max(0, offsetY)) + 'px';
    handle.classList.add('show');
  };

  d.addEventListener('mousemove', (e) => {
    if (dragging || ed.readonly) return;
    hidden = false;
    if (e.target.closest('.blk-handle')) return;
    const b = blockAt(e.clientX, e.clientY);
    if (b && b !== hoverBlock) { hoverBlock = b; place(b); }
    if (!b) { hoverBlock = null; handle.classList.remove('show'); }
  });
  d.addEventListener('mouseleave', () => { if (!dragging) { handle.classList.remove('show'); hoverBlock = null; } });
  d.addEventListener('keydown', () => { if (!hidden) { handle.classList.remove('show'); hidden = true; hoverBlock = null; } });
  ed.dnd = { refresh: () => { if (hoverBlock && ed.byId.has(hoverBlock.id)) place(hoverBlock); } };

  plus.addEventListener('mousedown', (e) => e.preventDefault());
  plus.addEventListener('click', (e) => {
    const b = hoverBlock;
    if (!b) return;
    ed.checkpoint();
    ed.syncAll();
    let nb;
    if (ed.isText(b) && b.type === 'p' && isEmptyHTML(ed.currentHTML(b)) && !e.altKey) nb = b;
    else {
      nb = block('p');
      if (e.altKey) ed.insertBefore(b, [nb]); else ed.insertAfter(b, [nb]);
    }
    ed.focusBlock(nb, 'end');
    document.execCommand('insertText', false, '/');
  });

  // ⋮⋮: Klick = Menü, Ziehen = Verschieben
  let dragging = false;
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoverBlock) return;
    e.preventDefault();
    const b = hoverBlock;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    let ghost = null, indicator = null, drop = null;
    const blocks = ed.selected.has(b.id) ? ed.selectedBlocks() : [b];
    const scroller = ed.root.closest('.view') || document.scrollingElement;
    let scrollTimer = null;
    const move = (ev) => {
      if (!started) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        started = true;
        dragging = true;
        ed.syncAll();
        ed.selectBlocks(blocks);
        window.getSelection().removeAllRanges();
        ghost = h('div', { class: 'drag-ghost', text: preview(ed, blocks) });
        indicator = h('div', { class: 'drop-indicator' });
        document.body.append(ghost);
        d.append(indicator);
        handle.classList.remove('show');
      }
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 8 + 'px';
      drop = computeDrop(ed, ev, blocks, blockAt);
      showIndicator(ed, indicator, drop);
      // Automatisch scrollen am Rand
      clearInterval(scrollTimer);
      const sr = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      const edge = ev.clientY < sr.top + 50 ? -1 : ev.clientY > sr.bottom - 50 ? 1 : 0;
      if (edge) scrollTimer = setInterval(() => { scroller.scrollTop += edge * 14; }, 16);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      clearInterval(scrollTimer);
      if (!started) { ed.openBlockMenu(b, grip); return; }
      dragging = false;
      ghost && ghost.remove();
      indicator && indicator.remove();
      if (drop) ed.moveBlocks(blocks, drop.target, drop.pos);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // Rahmen-Auswahl vom Rand aus und Text-Ziehen über Blockgrenzen
  d.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || ed.readonly) return;
    const t = e.target;
    if (t.closest('.blk-handle, .popover, .doc-header, .atom-panel, input, textarea, button, .media-bar')) return;
    const inText = t.closest('.blk-text');
    const onBlank = !inText && (t === d || t === ed.blocksEl || t.classList.contains('blk-children') || t.classList.contains('blk') || t.classList.contains('blk-main') && !t.querySelector('.atom, .blk-text'));
    if (!inText && !onBlank) return;
    const startBlock = inText ? ed.blockOfEl(inText) : null;
    const sx = e.clientX, sy = e.clientY;
    let rect = null, mode = null;
    if (onBlank) e.preventDefault();
    const move = (ev) => {
      if (onBlank) {
        if (!mode && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
        if (!mode) { mode = 'rect'; rect = h('div', { class: 'select-rect' }); document.body.append(rect); }
        const x1 = Math.min(sx, ev.clientX), y1 = Math.min(sy, ev.clientY), x2 = Math.max(sx, ev.clientX), y2 = Math.max(sy, ev.clientY);
        Object.assign(rect.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
        const hits = [];
        for (const b of ed.flat()) {
          const r = ed.elOf(b)?.querySelector(':scope > .blk-main')?.getBoundingClientRect();
          if (r && r.bottom > y1 && r.top < y2 && r.right > x1 && r.left < x2) hits.push(b);
        }
        if (hits.length) ed.selectBlocks(hits); else ed.clearBlockSelection();
        return;
      }
      if (!(ev.buttons & 1)) return;
      const over = blockAt(ev.clientX, ev.clientY);
      if (over && startBlock && over !== startBlock) {
        mode = 'blocks';
        ed.syncAll();
        ed.selectRange(startBlock, over);
      } else if (mode === 'blocks' && over === startBlock) {
        ed.selectBlocks([startBlock]);
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      rect && rect.remove();
      if (onBlank && !mode) {
        // Klick in den leeren Bereich: nächsten Block fokussieren
        const b = blockAt(sx, sy);
        if (b && ed.isText(b)) {
          const tr = ed.textElOf(b).getBoundingClientRect();
          ed.focusBlock(b, sx < tr.left + tr.width / 2 && sy < tr.bottom ? 'start' : 'end');
        }
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // Dateien aus dem Finder
  let fileIndicator = null;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  d.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || ed.readonly) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!fileIndicator) { fileIndicator = h('div', { class: 'drop-indicator' }); d.append(fileIndicator); }
    const b = blockAt(e.clientX, e.clientY);
    const main = b && ed.elOf(b)?.querySelector(':scope > .blk-main');
    if (main) {
      const r = main.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      showIndicator(ed, fileIndicator, { target: b, pos: before ? 'before' : 'after' });
    }
  });
  d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) { fileIndicator && fileIndicator.remove(); fileIndicator = null; } });
  d.addEventListener('drop', (e) => {
    if (!hasFiles(e) || ed.readonly) return;
    e.preventDefault();
    fileIndicator && fileIndicator.remove();
    fileIndicator = null;
    const files = [...e.dataTransfer.files];
    const b = blockAt(e.clientX, e.clientY);
    let pos = 'after';
    if (b) {
      const r = ed.elOf(b).querySelector(':scope > .blk-main').getBoundingClientRect();
      pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    }
    ed.insertFiles(files, b, pos);
  });
}

function preview(ed, blocks) {
  const b = blocks[0];
  let text = b.html !== undefined ? segsToText(htmlToSegs(ed.currentHTML(b))).trim() : '';
  if (!text) text = { math: 'Formel', chem: 'Reaktionsgleichung', plot: 'Funktionsgraph', image: 'Bild', pdf: 'Arbeitsblatt', table: 'Tabelle', smiles: 'Strukturformel', code: 'Code', columns: 'Spalten' }[b.type] || 'Block';
  if (text.length > 60) text = text.slice(0, 60) + '…';
  return blocks.length > 1 ? `${text}  (+${blocks.length - 1})` : text;
}

function computeDrop(ed, ev, dragged, blockAt) {
  const target = blockAt(ev.clientX, ev.clientY, dragged);
  if (!target || dragged.includes(target)) return null;
  const main = ed.elOf(target)?.querySelector(':scope > .blk-main');
  if (!main) return null;
  const r = main.getBoundingClientRect();
  const inMiddle = ev.clientY > r.top + r.height * 0.2 && ev.clientY < r.bottom - r.height * 0.2;
  if (inMiddle && ev.clientX > r.right - 50 && target.type !== 'columns') return { target, pos: 'col-right', rect: r };
  if (inMiddle && ev.clientX < r.left + 16 && target.type !== 'columns') return { target, pos: 'col-left', rect: r };
  const before = ev.clientY < r.top + r.height / 2;
  if (!before && CAN_NEST(target) && ev.clientX > r.left + 70 && ed.isText(target)) return { target, pos: 'child', rect: r };
  return { target, pos: before ? 'before' : 'after', rect: r };
}

function showIndicator(ed, el, drop) {
  if (!drop) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const dr = ed.docEl.getBoundingClientRect();
  const main = ed.elOf(drop.target).querySelector(':scope > .blk-main');
  const r = main.getBoundingClientRect();
  el.classList.toggle('vertical', drop.pos === 'col-left' || drop.pos === 'col-right');
  if (drop.pos === 'col-left' || drop.pos === 'col-right') {
    Object.assign(el.style, { left: (drop.pos === 'col-left' ? r.left - 8 : r.right + 4) - dr.left + 'px', top: r.top - dr.top + 'px', height: r.height + 'px', width: '3px' });
    return;
  }
  const y = drop.pos === 'before' ? r.top - 2 : r.bottom;
  const x = drop.pos === 'child' ? r.left + 28 : r.left;
  Object.assign(el.style, { left: x - dr.left + 'px', top: y - dr.top + 'px', width: r.right - x + 'px', height: '3px' });
}
