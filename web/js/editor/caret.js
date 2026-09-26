// Cursor-Positionen innerhalb eines Textblocks.
//
// Positionen werden wie in inline.js gezählt: jedes Textzeichen 1, jedes Atom
// (Formel, Fußnote, Verweis) und jeder <br> ebenfalls 1. So lassen sich
// Cursor und Auswahl vor und nach einem Neuaufbau des HTML exakt übertragen.

const ZW = /\u200B/g;

export function isAtom(node) {
  return node.nodeType === 1 && (node.classList.contains('im') || node.classList.contains('fn') || node.classList.contains('ref') || node.classList.contains('am'));
}

function nodeLength(node) {
  if (node.nodeType === 3) return node.data.replace(ZW, '').length;
  if (node.nodeType !== 1) return 0;
  if (isAtom(node) || node.nodeName === 'BR') return 1;
  let n = 0;
  for (const c of node.childNodes) n += nodeLength(c);
  return n;
}

export function textLength(el) {
  let n = 0;
  for (const c of el.childNodes) n += nodeLength(c);
  // Der letzte <br> in einem Block ist WebKits Platzhalter und zählt nicht
  const last = lastMeaningful(el);
  if (last && last.nodeName === 'BR' && n > 0) {
    const prev = previousMeaningful(last);
    if (!prev || prev.nodeName !== 'BR') n -= 1;
  }
  return n;
}

function lastMeaningful(el) {
  let n = el.lastChild;
  while (n && n.nodeType === 3 && !n.data.replace(ZW, '')) n = n.previousSibling;
  while (n && n.nodeType === 1 && !isAtom(n) && n.nodeName !== 'BR' && n.lastChild) {
    n = n.lastChild;
    while (n && n.nodeType === 3 && !n.data.replace(ZW, '')) n = n.previousSibling;
  }
  return n;
}
function previousMeaningful(node) {
  let n = node.previousSibling;
  while (n && n.nodeType === 3 && !n.data.replace(ZW, '')) n = n.previousSibling;
  return n;
}

// Position eines DOM-Punkts (node, offset) innerhalb von el.
export function positionOf(el, node, offset) {
  if (!el.contains(node) && node !== el) return 0;
  let pos = 0;
  let done = false;
  const walk = (n) => {
    if (done) return;
    if (n === node) {
      if (n.nodeType === 3) {
        pos += n.data.slice(0, offset).replace(ZW, '').length;
      } else {
        for (let i = 0; i < offset && i < n.childNodes.length; i++) pos += nodeLength(n.childNodes[i]);
      }
      done = true;
      return;
    }
    if (n.nodeType === 3) { pos += n.data.replace(ZW, '').length; return; }
    if (n.nodeType !== 1) return;
    if (isAtom(n) || n.nodeName === 'BR') {
      if (n.contains(node)) { done = true; return; }
      pos += 1;
      return;
    }
    for (const c of n.childNodes) { walk(c); if (done) return; }
  };
  if (node === el) {
    for (let i = 0; i < offset && i < el.childNodes.length; i++) pos += nodeLength(el.childNodes[i]);
    return pos;
  }
  for (const c of el.childNodes) { walk(c); if (done) break; }
  return pos;
}

// DOM-Punkt zu einer Position (bevorzugt in Textknoten, damit WebKit den
// Cursor zuverlässig anzeigt).
export function pointAt(el, pos) {
  let remaining = Math.max(0, pos);
  let result = null;
  const walk = (n) => {
    if (result) return;
    if (n.nodeType === 3) {
      const clean = n.data.replace(ZW, '');
      if (remaining <= clean.length) {
        // Offset im Originaltext (mit ZW-Leerzeichen) bestimmen
        let seen = 0, i = 0;
        while (i < n.data.length && seen < remaining) { if (n.data[i] !== '\u200B') seen++; i++; }
        result = { node: n, offset: i };
        return;
      }
      remaining -= clean.length;
      return;
    }
    if (n.nodeType !== 1) return;
    if (isAtom(n) || n.nodeName === 'BR') {
      if (remaining === 0) {
        result = { node: n.parentNode, offset: indexIn(n) };
        return;
      }
      remaining -= 1;
      if (remaining === 0 && !n.nextSibling) {
        result = { node: n.parentNode, offset: indexIn(n) + 1 };
      }
      return;
    }
    for (const c of n.childNodes) { walk(c); if (result) return; }
  };
  for (const c of el.childNodes) { walk(c); if (result) break; }
  if (!result) {
    const last = el.lastChild;
    if (last && last.nodeType === 3) return { node: last, offset: last.data.length };
    return { node: el, offset: el.childNodes.length };
  }
  return result;
}

function indexIn(n) {
  let i = 0;
  while ((n = n.previousSibling)) i++;
  return i;
}

export function getSelectionIn(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) && r.startContainer !== el) return null;
  const start = positionOf(el, r.startContainer, r.startOffset);
  const end = r.collapsed ? start : (el.contains(r.endContainer) || r.endContainer === el ? positionOf(el, r.endContainer, r.endOffset) : textLength(el));
  return { start: Math.min(start, end), end: Math.max(start, end), collapsed: r.collapsed };
}

export function setSelectionIn(el, start, end = start) {
  const len = textLength(el);
  start = Math.max(0, Math.min(start, len));
  end = Math.max(0, Math.min(end, len));
  const a = pointAt(el, start);
  const b = end === start ? a : pointAt(el, end);
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function placeCaret(el, where) {
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  if (where === 'start') setSelectionIn(el, 0);
  else if (where === 'end' || where === undefined) setSelectionIn(el, textLength(el));
  else if (typeof where === 'number') setSelectionIn(el, where);
}

// Rechteck des Cursors (für Menüs und Pfeil-Navigation)
export function caretRect() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const rects = r.getClientRects();
  let rect = rects.length ? rects[rects.length - 1] : null;
  if (!rect || (rect.top === 0 && rect.height === 0)) {
    // Leerer Block: Position aus dem Element selbst ableiten (ohne den DOM
    // anzufassen, sonst geht die Auswahl verloren)
    let node = r.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    if (node.nodeType === 1 && node.childNodes[r.startOffset] && node.childNodes[r.startOffset].nodeType === 1) {
      const child = node.childNodes[r.startOffset];
      const cb = child.getBoundingClientRect();
      if (cb.height) return { left: cb.left, right: cb.left, top: cb.top, bottom: cb.bottom, height: cb.height, width: 0 };
    }
    const b = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
    const left = b.left + (parseFloat(cs.paddingLeft) || 0);
    const top = b.top + (parseFloat(cs.paddingTop) || 0);
    rect = { left, right: left, top, bottom: top + lh, height: lh, width: 0 };
  }
  return rect;
}

// Steht der Cursor in der ersten bzw. letzten Zeile des Elements?
export function onFirstLine(el) {
  const c = caretRect();
  if (!c) return true;
  const first = firstLineRect(el);
  return c.top < first.top + first.height * 0.7;
}
export function onLastLine(el) {
  const c = caretRect();
  if (!c) return true;
  const last = lastLineRect(el);
  return c.bottom > last.bottom - last.height * 0.7;
}

function firstLineRect(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const rects = r.getClientRects();
  if (rects.length) return rects[0];
  const b = el.getBoundingClientRect();
  return { top: b.top, bottom: b.top + 24, height: 24 };
}
function lastLineRect(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const rects = r.getClientRects();
  if (rects.length) return rects[rects.length - 1];
  const b = el.getBoundingClientRect();
  return { top: b.bottom - 24, bottom: b.bottom, height: 24 };
}

// Cursor an eine x-Position in der ersten/letzten Zeile eines Elements setzen.
export function placeCaretAtX(el, x, line) {
  el.focus({ preventScroll: true });
  const rect = line === 'last' ? lastLineRect(el) : firstLineRect(el);
  const y = rect.top + rect.height / 2;
  const box = el.getBoundingClientRect();
  const cx = Math.max(box.left + 1, Math.min(x, box.right - 1));
  let range = document.caretRangeFromPoint ? document.caretRangeFromPoint(cx, y) : null;
  if (range && el.contains(range.startContainer)) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else placeCaret(el, line === 'last' ? 'end' : 'start');
}

export function selectionInsideAtom() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let n = sel.anchorNode;
  while (n && n.nodeType !== 1) n = n.parentNode;
  return n && n.closest ? n.closest('.im, .fn') : null;
}
