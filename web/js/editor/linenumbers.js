// Zeilennummern am Rand – wie bei Texten im Deutschbuch („Z. 12“).
//
// Gezählt werden die sichtbaren Zeilen von Fließtext, Listen, Zitaten,
// Merkkästen und aufklappbaren Abschnitten, fortlaufend durch den Eintrag.
// Überschriften, Formeln, Tabellen und leere Zeilen zählen nicht mit.
//
// Am Bildschirm liegen die Nummern in einer eigenen Ebene neben dem Text
// (der Text selbst bleibt unangetastet). Beim Drucken wird vor jede Zeile eine
// unsichtbare Marke gesetzt, damit die Nummer auch nach einem Seitenumbruch
// neben ihrer Zeile steht.

const COUNTED = new Set(['p', 'ul', 'ol', 'todo', 'quote', 'callout', 'toggle']);
// Inline-Teile, die als Ganzes zählen (Formeln, Chemie, Fußnoten …)
const ATOMIC = '.im, .fn, .ref, .am, .katex, [contenteditable="false"], img, svg';

// Textfelder der gezählten Blöcke in Dokumentreihenfolge (ohne zugeklappte Inhalte)
export function countedTextEls(root) {
  const out = [];
  for (const blk of root.querySelectorAll('.blk')) {
    if (!COUNTED.has(blk.dataset.type)) continue;
    if (!blk.offsetParent) continue;  // in einem zugeklappten Abschnitt
    const t = blk.querySelector(':scope > .blk-main > .blk-text');
    if (t && t.textContent.trim()) out.push(t);
  }
  return out;
}

// Schriftmaße (Ober- und Unterlänge) – daraus ergibt sich die Grundlinie einer
// Zeile genau: Oberkante des Textes + Oberlänge der Schrift
const metricsCache = new Map();
const measureCtx = () => (measureCtx.c = measureCtx.c || document.createElement('canvas').getContext('2d'));
export function fontMetrics(font, sizePx) {
  const key = font;
  if (!metricsCache.has(key)) {
    const c = measureCtx();
    c.font = font;
    const m = c.measureText('Hg');
    const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
    metricsCache.set(key, Number.isFinite(asc) && asc > 0 ? { asc, desc } : { asc: sizePx * 0.8, desc: sizePx * 0.22 });
  }
  return metricsCache.get(key);
}
export const fontOf = (el) => { const cs = getComputedStyle(el); return { font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, size: parseFloat(cs.fontSize) || 16 }; };
const UI_FONT = () => getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif';

// Sichtbare Zeilen eines Textfelds (Bildschirmkoordinaten) samt Grundlinie
export function measureLines(el) {
  const range = document.createRange();
  const rects = [];
  // Liegt ein Element in einer Formel o. Ä. innerhalb dieses Textfelds?
  const insideAtom = (node) => { const a = node && node.closest(ATOMIC); return !!(a && a !== el && el.contains(a)); };
  // Textstücke: Grundlinie aus der Schrift des Elternelements
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (insideAtom(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.length || !n.data.trim()) continue;
    const f = fontOf(n.parentElement);
    const { asc } = fontMetrics(f.font, f.size);
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 2 && r.width > 0.5) rects.push({ top: r.top, bottom: r.bottom, baseline: r.top + asc, size: f.size });
  }
  // Formeln, Fußnoten … zählen als Zeileninhalt, liefern aber keine Grundlinie
  for (const a of el.querySelectorAll(ATOMIC)) {
    if (insideAtom(a.parentElement)) continue;  // nur die äußerste Formel usw.
    for (const r of a.getClientRects()) if (r.height > 2 && r.width > 0.5) rects.push({ top: r.top, bottom: r.bottom, baseline: null, size: 0 });
  }
  rects.sort((a, b) => a.top - b.top);
  const lines = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    const overlap = last ? Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top) : 0;
    if (last && overlap > Math.min(last.bottom - last.top, r.bottom - r.top) * 0.4) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      // Grundlinie vom größten Text der Zeile (hoch-/tiefgestellte Stellen sind kleiner)
      if (r.baseline !== null && r.size > last.size) { last.baseline = r.baseline; last.size = r.size; }
    } else lines.push({ top: r.top, bottom: r.bottom, baseline: r.baseline, size: r.size });
  }
  return lines;
}

export const shows = (n, every) => n === 1 || n % every === 0;

// Am Bildschirm: Nummern in einer Ebene neben dem Text, Grundlinie auf Grundlinie
export function renderOverlay(docEl, blocksEl, every) {
  let layer = docEl.querySelector(':scope > .ln-layer');
  if (!every) { if (layer) layer.remove(); return 0; }
  if (!layer) { layer = document.createElement('div'); layer.className = 'ln-layer'; layer.setAttribute('aria-hidden', 'true'); docEl.append(layer); }
  const base = docEl.getBoundingClientRect();
  const left = blocksEl.getBoundingClientRect().left - base.left;
  const numSize = 11;
  const num = fontMetrics(`400 ${numSize}px ${UI_FONT()}`, numSize);
  const frag = document.createDocumentFragment();
  let n = 0;
  for (const el of countedTextEls(blocksEl)) {
    const size = parseFloat(getComputedStyle(el).fontSize) || 16;
    for (const line of measureLines(el)) {
      n++;
      if (!shows(n, every)) continue;
      const s = document.createElement('span');
      s.className = 'ln-num';
      s.textContent = String(n);
      const baseline = line.baseline ?? (line.bottom - size * 0.22);
      s.style.top = (baseline - base.top - num.asc) + 'px';
      s.style.lineHeight = (num.asc + num.desc) + 'px';
      frag.append(s);
    }
  }
  layer.style.left = left + 'px';
  layer.replaceChildren(frag);
  return n;
}

// Beim Drucken: Marke am Anfang jeder Zeile (wandert mit, wenn die Seite umbricht)
// Anfänge der sichtbaren Zeilen eines Textfelds als DOM-Stellen:
// { node, offset } im Text oder { before } vor einem Inline-Element
export function lineStarts(el) {
  let lastTop = -Infinity;
  const range = document.createRange();
  const topOf = (node, i) => { range.setStart(node, i); range.setEnd(node, i + 1); const r = range.getClientRects(); return r.length ? r[r.length - 1].top : null; };
  const newLine = (top) => top !== null && top > lastTop + 2;
  const starts = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1 && child.matches(ATOMIC)) {
        const rs = child.getClientRects();
        if (!rs.length) continue;
        if (newLine(rs[0].top)) starts.push({ before: child });
        lastTop = Math.max(lastTop, rs[rs.length - 1].top);
        continue;
      }
      if (child.nodeType === 1) { walk(child); continue; }
      if (child.nodeType !== 3 || !child.length) continue;
      // Zeilenanfänge im Textknoten per Halbierung suchen
      let i = 0;
      while (i < child.length) {
        if (/\s/.test(child.data[i]) && i < child.length - 1) { i++; continue; }
        const t = topOf(child, i);
        if (t === null) { i++; continue; }
        if (newLine(t)) { starts.push({ node: child, offset: i }); lastTop = t; }
        else lastTop = Math.max(lastTop, t);
        // nächstes Zeichen, das tiefer liegt
        let lo = i + 1, hi = child.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const tm = topOf(child, mid);
          if (tm !== null && tm > lastTop + 2) hi = mid; else lo = mid + 1;
        }
        i = lo;
      }
    }
  };
  walk(el);
  return starts;
}

export function insertMarkers(blocksEl, every) {
  if (!every) return 0;
  const colLeft = blocksEl.getBoundingClientRect().left;
  let n = 0;
  const marks = [];
  for (const el of countedTextEls(blocksEl)) {
    const starts = lineStarts(el);
    for (const s of starts) {
      n++;
      if (!shows(n, every)) continue;
      marks.push({ ...s, n });
    }
  }
  const ui = UI_FONT();
  // Von hinten einsetzen, damit die Positionen in den Textknoten stimmen
  for (const m of marks.reverse()) {
    const span = document.createElement('span');
    span.className = 'ln-mark';
    span.dataset.n = String(m.n);
    // Hinter das erste Zeichen der Zeile – direkt nach einem Leerzeichen würde
    // die leere Marke noch am Ende der vorigen Zeile hängen bleiben
    if (m.before) {
      if (m.before.nodeType === 1 && !/^(IMG|SVG|BR)$/i.test(m.before.tagName)) m.before.prepend(span);
      else m.before.parentNode.insertBefore(span, m.before);
    } else {
      const rest = m.node.splitText(Math.min(m.node.length, m.offset + 1));
      rest.parentNode.insertBefore(span, rest);
    }
    span.style.setProperty('--ln-dx', (colLeft - span.getBoundingClientRect().left) + 'px');
    // Die Nummer (0,66 der Textgröße) mit ihrer Grundlinie auf die Grundlinie der Zeile setzen:
    // Oberkante der Marke = Grundlinie − Oberlänge des Textes
    const f = fontOf(span.parentElement);
    const text = fontMetrics(f.font, f.size);
    const numSize = f.size * 0.66;
    const num = fontMetrics(`400 ${numSize}px ${ui}`, numSize);
    span.style.setProperty('--ln-top', (text.asc - num.asc) + 'px');
    span.style.setProperty('--ln-lh', (num.asc + num.desc) + 'px');
  }
  return n;
}
