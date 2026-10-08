// Griff links neben den Blöcken (+ und ⋮⋮), Verschieben per Ziehen,
// Rahmen-Auswahl mit der Maus und Dateien aus dem Finder hineinziehen.

import { h, closeAllPopovers } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { block, isEmptyHTML } from '../core/markdown.js';
import { segsToText, htmlToSegs } from '../core/inline.js';
import { isPalm, onPenDown } from '../palm.js';

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

  // Wo der Griff eines Blocks sitzt (Bildschirmkoordinaten). In einer Spalte
  // (außer der ersten) darf er den Anfasser für die Spaltenbreite nicht verdecken:
  // dann nur der Griff ⋮⋮ direkt daneben, oder – wenn dafür kein Platz ist – ganz davor.
  const HANDLE_W = 40;
  const handleBox = (b, mr) => {
    const el = ed.elOf(b);
    let left = mr.left - 48;
    if (b.type === 'callout') left -= 14;
    let gripOnly = false;
    const col = el && el.closest('.col');
    const rz = col && col.querySelector(':scope > .col-resize');
    if (rz) {
      const rr = rz.getBoundingClientRect();
      if (left < rr.right && left + HANDLE_W > rr.left) {
        if (mr.left - 2 - (rr.right + 2) >= 18) { left = rr.right + 2 - 22; gripOnly = true; }
        else left = rr.left - 2 - HANDLE_W;
      }
    }
    return { left, gripOnly };
  };

  const mainOf = (b) => { const el = ed.elOf(b); return el && el.querySelector(':scope > .blk-main'); };

  // Wo der Griff eines Blocks stünde (Bildschirmkoordinaten, auf Höhe der ersten Zeile)
  const handlePos = (b) => {
    const main = mainOf(b);
    if (!main) return null;
    const mr = main.getBoundingClientRect();
    const t = main.querySelector('.blk-text');
    let lineH = 24;
    if (t) lineH = parseFloat(getComputedStyle(t).lineHeight) || 24;
    const topPad = t ? parseFloat(getComputedStyle(t).paddingTop) || 0 : 0;
    const offsetY = t ? topPad + (lineH - 24) / 2 : 4;
    const box = handleBox(b, mr);
    return { left: box.left, top: mr.top + Math.max(0, offsetY), gripOnly: box.gripOnly, mr };
  };

  const place = (b) => {
    const p = handlePos(b);
    if (!p) { handle.classList.remove('show'); return; }
    const dr = d.getBoundingClientRect();
    plus.style.visibility = p.gripOnly ? 'hidden' : '';
    handle.style.left = (p.left - dr.left) + 'px';
    handle.style.top = (p.top - dr.top) + 'px';
    handle.classList.add('show');
  };

  // iPad: Wo man den Griff ⋮⋮ mit Finger oder Pencil anfassen kann – großzügiger
  // als der kleine Knopf und auch, solange er gerade bei keinem oder einem
  // anderen Block steht. Bei mehreren Kandidaten gewinnt der nächstgelegene.
  const GRIP_X = 22, GRIP_W = 18, GRIP_H = 24;
  const gripZoneAt = (x, y) => {
    let best = null, bestDist = Infinity;
    for (const b of ed.flat()) {
      const main = mainOf(b);
      if (!main) continue;
      const mr = main.getBoundingClientRect();
      if (!mr.height || x > mr.left || x < mr.left - 80 || y < mr.top - 16 || y > mr.top + 64) continue;
      const p = handlePos(b);
      const gl = p.left + GRIP_X;
      if (x < gl - 8 || x > Math.min(gl + GRIP_W + 12, mr.left - 1) || y < p.top - 12 || y > p.top + GRIP_H + 12) continue;
      const dist = Math.hypot(x - (gl + GRIP_W / 2), y - (p.top + GRIP_H / 2));
      if (dist < bestDist) { bestDist = dist; best = b; }
    }
    return best;
  };

  // Zu welchem Block gehört der Griff an dieser Stelle? Zuerst die Griffzone
  // links neben jeder Blockzeile – so erreicht man den Griff auch bei
  // eingerückten Blöcken und in Spalten, ohne dass er unterwegs zum
  // übergeordneten Block oder zur Nachbarspalte springt. Bei mehreren Treffern
  // gewinnt der am weitesten eingerückte bzw. am weitesten rechts stehende Block.
  const hoverAt = (x, y) => {
    for (const rz of ed.blocksEl.querySelectorAll('.col-resize')) {
      const r = rz.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return null;  // Spaltenbreite ziehen
    }
    let best = null, bestLeft = -Infinity;
    for (const b of ed.flat()) {
      const main = mainOf(b);
      if (!main) continue;
      const mr = main.getBoundingClientRect();
      if (!mr.height || y < mr.top - 2 || y > mr.bottom + 2) continue;
      if (x > mr.right + 8 || x < mr.left - 70) continue;
      const box = handleBox(b, mr);
      if (x < Math.min(mr.left - 56, box.left - 6)) continue;
      if (mr.left >= bestLeft) { bestLeft = mr.left; best = b; }
    }
    return best || blockAt(x, y);
  };

  let raf = 0, pending = null;
  d.addEventListener('mousemove', (e) => {
    if (dragging || ed.readonly) return;
    hidden = false;
    if (e.target.closest('.blk-handle')) return;
    pending = { x: e.clientX, y: e.clientY };
    if (raf) return;
    // Höchstens einmal pro Bild auswerten (Zeitgeber als Rückfall, falls keine Bilder gezeichnet werden)
    const run = () => {
      if (!raf) return;
      cancelAnimationFrame(raf.a); clearTimeout(raf.t); raf = 0;
      if (dragging || !pending) return;
      const b = hoverAt(pending.x, pending.y);
      if (b && b !== hoverBlock) { hoverBlock = b; place(b); }
      if (!b) { hoverBlock = null; handle.classList.remove('show'); }
    };
    raf = { a: requestAnimationFrame(run), t: setTimeout(run, 40) };
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
  // Laufende Geste am Griff. Kommt ihr Ende nie an (iPadOS bricht Berührungen
  // manchmal ab, ohne es zu melden), beendet die nächste Berührung sie – sonst
  // bliebe der Griff bis zum Neustart tot.
  let active = null;
  // Offenes Blockmenü (iPad: erneutes Antippen des Griffs schließt es nur –
  // das Menü bleibt dafür bei Berührungen seines Griffs offen, bis der Griff
  // selbst entscheidet)
  let menuFor = null;
  const openMenu = (b) => {
    const keep = (e) => !!e.pointerType && e.pointerType !== 'mouse' && gripTarget(e) === b;
    menuFor = { id: b.id, pop: ed.openBlockMenu(b, grip, { keep }) };
  };
  // touch: { id, menu } beim Ziehen mit Finger oder Pencil (Pointer-Ereignisse statt Maus)
  const startDrag = (b, sx, sy, touch = null) => {
    if (active) active.abort();
    let started = false;
    let ghost = null, indicator = null, drop = null;
    const blocks = ed.selected.has(b.id) ? ed.selectedBlocks() : [b];
    const scroller = ed.root.closest('.view') || document.scrollingElement;
    let scrollTimer = null;
    let ended = false;
    const mine = (ev) => !touch || ev.pointerId === touch.id;
    let offPen = null;
    const move = (ev) => {
      if (!mine(ev)) return;
      gesture.last = performance.now();
      if (touch) ev.preventDefault();
      if (!started) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < (touch ? 6 : 4)) return;
        started = true;
        dragging = true;
        if (touch) {
          // Offene Formel und Tastatur schließen – sie verdecken sonst das Ziel
          if (ed.activeAtom) ed.deactivate();
          const a = document.activeElement;
          if (a && a !== document.body && a.blur) a.blur();
        }
        ed.syncAll();
        ed.selectBlocks(blocks);
        window.getSelection().removeAllRanges();
        ghost = h('div', { class: 'drag-ghost', text: preview(ed, blocks) });
        indicator = h('div', { class: 'drop-indicator' });
        document.body.append(ghost);
        d.append(indicator);
        handle.classList.remove('show');
      }
      // Mit dem Finger: Vorschau über der Fingerspitze, sonst sieht man sie nicht
      ghost.style.left = ev.clientX + (touch ? 20 : 12) + 'px';
      ghost.style.top = ev.clientY + (touch ? -52 : 8) + 'px';
      drop = computeDrop(ed, ev, blocks, blockAt);
      showIndicator(ed, indicator, drop);
      // Automatisch scrollen am Rand
      clearInterval(scrollTimer);
      const sr = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      const zone = touch ? 70 : 50;
      const edge = ev.clientY < sr.top + zone ? -1 : ev.clientY > sr.bottom - zone ? 1 : 0;
      if (edge) scrollTimer = setInterval(() => { scroller.scrollTop += edge * 14; }, 16);
    };
    // Aufräumen – genau einmal, egal ob die Geste endet, abbricht oder hängen blieb
    const end = () => {
      if (ended) return false;
      ended = true;
      if (touch) {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel, true);
        d.removeEventListener('lostpointercapture', cancel);
        if (offPen) offPen();
        touchGrab = false;
      } else {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      }
      clearInterval(scrollTimer);
      if (active === gesture) active = null;
      if (started) {
        dragging = false;
        ghost && ghost.remove();
        indicator && indicator.remove();
      }
      return true;
    };
    const finish = (ev, cancelled) => {
      if (!mine(ev) || !end()) return;
      if (!started) {
        // Antippen: Menü – mit dem Finger nur, wenn der Griff schon zu sehen war
        if (!cancelled && (!touch || touch.menu)) openMenu(b);
        return;
      }
      if (drop && !cancelled) ed.moveBlocks(blocks, drop.target, drop.pos);
      // Griff gleich wieder am verschobenen Block – zum Weiterschieben
      if (touch) requestAnimationFrame(() => { if (ed.byId.has(b.id)) { hoverBlock = b; place(b); } });
    };
    const up = (ev) => finish(ev, false);
    const cancel = (ev) => finish(ev, true);
    // Art des Zeigers: Eine neue Berührung beendet nur eine Geste derselben Art
    // (ein aufliegender Handballen bricht das Ziehen mit dem Pencil nicht ab)
    const gesture = { abort: end, type: touch ? touch.type : 'mouse', last: performance.now() };
    active = gesture;
    if (touch) {
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      // Ende der Berührung auch dann, wenn pointerup/pointercancel nicht ankommen
      d.addEventListener('lostpointercapture', cancel);
      // Setzt der Pencil auf, während ein Finger den Griff hält, war es der Handballen
      if (touch.type === 'touch') offPen = onPenDown(() => cancel({ pointerId: touch.id }));
    } else {
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  };
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoverBlock) return;
    e.preventDefault();
    startDrag(hoverBlock, e.clientX, e.clientY);
  });

  // iPad: Griff mit Finger oder Pencil anfassen und ziehen – ohne vorher den
  // Block antippen zu müssen
  let touchGrab = false;
  // Welcher Block wird hier am Griff angefasst? (null: keiner)
  const gripTarget = (e) => {
    const t = e.target;
    if (t.closest && t.closest('.col-resize, .tcol-resize, .plot-resize, .img-handle, .popover')) return null;
    // Der sichtbare +-Knopf bleibt ein Knopf
    if (t.closest && t.closest('.blk-handle button:not(.grip)') && handle.classList.contains('show')) return null;
    const onGrip = !!(t.closest && t.closest('.blk-handle .grip')) && handle.classList.contains('show') && hoverBlock;
    return onGrip ? hoverBlock : gripZoneAt(e.clientX, e.clientY);
  };
  d.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || ed.readonly || isPalm(e)) return;
    // Finger: jede Berührung, nicht nur die erste. Liegt schon etwas auf (meist der
    // Handballen), ist der Finger am Griff nicht mehr die „erste“ Berührung – er
    // käme sonst nie an, und Menü und Ziehen gingen nicht, solange die Hand aufliegt.
    if (e.pointerType === 'pen' && !e.isPrimary) return;
    // Eine neue Berührung derselben Art löst eine offene Geste ab: Entweder ist
    // ihr Ende verloren gegangen, oder sie kam vom aufliegenden Handballen.
    // Eine andere Art, die sich länger nicht mehr gerührt hat, ist ebenfalls hängengeblieben.
    if (active) { if (active.type === e.pointerType || performance.now() - active.last > 1500) active.abort(); else return; }
    // Ein Griff, der zu einem gelöschten Block gehört, zählt nicht
    if (hoverBlock && !ed.byId.has(hoverBlock.id)) { hoverBlock = null; handle.classList.remove('show'); }
    const b = gripTarget(e);
    if (!b) return;
    // Keine nachgemachten Mausklicks, nichts darunter reagiert – offene Menüs schließen deshalb hier
    e.preventDefault();
    e.stopPropagation();
    // Menü dieses Blocks gerade offen? Dann nur schließen
    const wasOpen = !!menuFor && menuFor.id === b.id && menuFor.pop && !menuFor.pop.closed;
    closeAllPopovers();
    const shown = handle.classList.contains('show') && hoverBlock === b;
    hoverBlock = b;
    place(b);
    touchGrab = true;
    // Alle weiteren Ereignisse dieser Berührung hierher – auch wenn das berührte
    // Element unterwegs neu gezeichnet wird
    try { d.setPointerCapture(e.pointerId); } catch { /* egal */ }
    startDrag(b, e.clientX, e.clientY, { id: e.pointerId, menu: shown && !wasOpen, type: e.pointerType });
  }, true);
  // Solange der Griff gehalten wird: kein Scrollen, keine Handschrift-Erkennung
  d.addEventListener('touchstart', (e) => { if (touchGrab && e.cancelable) e.preventDefault(); }, { passive: false });

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
