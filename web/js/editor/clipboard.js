// Kopieren, Ausschneiden, Einfügen.
//
// Beim Kopieren landen drei Fassungen in der Zwischenablage: unser eigenes
// Blockformat (für verlustfreies Einfügen in Heft), Markdown als Text und
// schlichtes HTML für Pages, Word oder Mail. Beim Einfügen wird fremdes HTML
// (Webseiten, Word, Google Docs) in saubere Blöcke übersetzt.

import { block, isEmptyHTML, serializeBlocks, parseBlocks, TEXT_TYPES, newId, parseHtmlTable } from '../core/markdown.js';
import { cellMap, normalizeTable } from '../core/tablegrid.js';
import { htmlToSegs, segsToHTML, splitSegs, mergeSegs, normalizeHTML, segsLength, segsToText, escapeHTML } from '../core/inline.js';
import * as caret from './caret.js';

const HEFT_BLOCKS = 'application/x-heft-blocks';
const HEFT_INLINE = 'application/x-heft-inline';

export function attachClipboard(ed) {
  const d = ed.docEl;
  d.addEventListener('copy', (e) => onCopy(ed, e, false));
  d.addEventListener('cut', (e) => onCopy(ed, e, true));
  d.addEventListener('paste', (e) => onPaste(ed, e));
  ed.insertFiles = (files, where) => insertFiles(ed, files, where);
}

function stripTransient(blocks) {
  return JSON.parse(JSON.stringify(blocks, (k, v) => (k.startsWith('_') ? undefined : v)));
}

export function blocksToHTML(blocks) {
  const out = [];
  const inline = (html) => segsToHTML(htmlToSegs(html || '')).replace(/<span class="im"[^>]*data-tex="([^"]*)"[^>]*><\/span>/g, (m, t) => `<code>${t}</code>`)
    .replace(/<sup class="fn"[^>]*><\/sup>/g, '');
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const b of blocks) {
    const lt = b.type === 'ol' ? 'ol' : (b.type === 'ul' || b.type === 'todo') ? 'ul' : null;
    if (lt !== list) { closeList(); if (lt) { out.push(`<${lt}>`); list = lt; } }
    const kids = b.children && b.children.length ? blocksToHTML(b.children) : '';
    switch (b.type) {
      case 'h1': out.push(`<h1>${inline(b.html)}</h1>${kids}`); break;
      case 'h2': out.push(`<h2>${inline(b.html)}</h2>${kids}`); break;
      case 'h3': out.push(`<h3>${inline(b.html)}</h3>${kids}`); break;
      case 'ul': case 'ol': out.push(`<li>${inline(b.html)}${kids}</li>`); break;
      case 'todo': out.push(`<li>${b.checked ? '☑' : '☐'} ${inline(b.html)}${kids}</li>`); break;
      case 'quote': out.push(`<blockquote>${inline(b.html)}${kids}</blockquote>`); break;
      case 'callout': out.push(`<blockquote><b>${inline(b.html)}</b>${kids}</blockquote>`); break;
      case 'toggle': out.push(`<details><summary>${inline(b.html)}</summary>${kids}</details>`); break;
      case 'code': out.push(`<pre><code>${escapeHTML(b.text || '')}</code></pre>`); break;
      case 'math': out.push(`<p><code>${escapeHTML(b.tex || '')}</code></p>`); break;
      case 'chem': out.push(`<p><code>${escapeHTML(b.tex || '')}</code></p>`); break;
      case 'hr': out.push('<hr>'); break;
      case 'table': {
        // Verbundene Zellen als colspan/rowspan – so kommen sie auch in Word/Pages richtig an
        const map = cellMap(normalizeTable(b));
        out.push('<table>' + b.rows.map((r, i) => '<tr>' + r.map((c, j) => {
          const x = map[i][j];
          if (!x.anchor) return '';
          const tag = (i === 0 && b.header !== false) || (j === 0 && b.headerCol) ? 'th' : 'td';
          const span = (x.rs > 1 ? ` rowspan="${x.rs}"` : '') + (x.cs > 1 ? ` colspan="${x.cs}"` : '');
          return `<${tag}${span}>${inline(c)}</${tag}>`;
        }).join('') + '</tr>').join('') + '</table>');
        break;
      }
      case 'columns': for (const col of b.children) out.push(blocksToHTML(col.children)); break;
      default: if (b.html !== undefined) out.push(`<p>${inline(b.html)}</p>${kids}`); break;
    }
  }
  closeList();
  return out.join('');
}

function onCopy(ed, e, cut) {
  if (ed.selected.size) {
    e.preventDefault();
    ed.syncAll();
    const blocks = ed.selectedBlocks();
    const plain = serializeBlocks(blocks, { footnotes: [] });
    e.clipboardData.setData('text/plain', plain);
    e.clipboardData.setData('text/html', blocksToHTML(blocks));
    e.clipboardData.setData(HEFT_BLOCKS, JSON.stringify(stripTransient(blocks)));
    if (cut) ed.deleteBlocks(blocks);
    return;
  }
  // Textauswahl innerhalb eines Feldes: kanonisches HTML statt KaTeX-Innereien
  const el = ed.activeInlineEl();
  if (!el) return;
  const sel = caret.getSelectionIn(el);
  if (!sel || sel.collapsed) return;
  e.preventDefault();
  const segs = htmlToSegs(el.innerHTML);
  const [, rest] = splitSegs(segs, sel.start);
  const [mid] = splitSegs(rest, sel.end - sel.start);
  const html = segsToHTML(mid);
  e.clipboardData.setData(HEFT_INLINE, html);
  e.clipboardData.setData('text/html', html.replace(/<span class="im"[^>]*data-tex="([^"]*)"[^>]*><\/span>/g, '$1'));
  e.clipboardData.setData('text/plain', mid.map(s => s.t === 'text' ? s.text : s.t === 'br' ? '\n' : s.t === 'math' ? s.tex : '').join(''));
  if (cut) {
    ed.checkpoint();
    document.execCommand('delete');
  }
}

async function onPaste(ed, e) {
  const target = e.target;
  if (target.closest('textarea, input')) return;
  if (target.closest('.doc-title')) return;
  const dt = e.clipboardData;
  if (!dt) return;
  const el = target.closest('.blk-text, .cell, .caption') || ed.activeInlineEl();
  const isBlockText = el && el.classList.contains('blk-text');
  const files = [...(dt.files || [])];
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  const heft = dt.getData(HEFT_BLOCKS);
  const heftInline = dt.getData(HEFT_INLINE);

  if (files.length && !heft && (!text || files.some(f => /^image\//.test(f.type)) && !html.includes('<table'))) {
    e.preventDefault();
    await insertFiles(ed, files, ed.blockOfEl(el) || currentBlock(ed));
    return;
  }
  if (heftInline && el) {
    e.preventDefault();
    insertInline(ed, el, htmlToSegs(heftInline));
    return;
  }
  if (!isBlockText && el) {
    // Zellen und Beschriftungen: nur Inline-Inhalt
    e.preventDefault();
    const segs = html ? htmlToSegs(sanitizeInline(html)) : [{ t: 'text', text: (text || '').replace(/\n+/g, ' '), m: {} }];
    insertInline(ed, el, segs.filter(s => s.t !== 'br'));
    return;
  }
  let blocks = null;
  if (heft) {
    try { blocks = JSON.parse(heft).map(freshIds); } catch { blocks = null; }
  }
  if (!blocks && html && !/^\s*$/.test(html)) blocks = htmlToBlocks(html);
  if (!blocks && text) {
    if (!text.includes('\n')) {
      if (el) { e.preventDefault(); ed.checkpoint(); document.execCommand('insertText', false, text); }
      return;
    }
    blocks = parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'), { footnotes: {} });
  }
  if (!blocks || !blocks.length) return;
  e.preventDefault();
  // Ein einzelner Absatz wird in den laufenden Text eingefügt
  if (el && blocks.length === 1 && blocks[0].type === 'p' && !blocks[0].children.length) {
    insertInline(ed, el, htmlToSegs(blocks[0].html));
    return;
  }
  insertBlocksAtCaret(ed, blocks);
}

function currentBlock(ed) {
  const id = ed.focusId || [...ed.selected][0];
  return id ? ed.find(id) : ed.doc.blocks[ed.doc.blocks.length - 1];
}

function freshIds(b) {
  b.id = newId();
  if (b.children) b.children.forEach(freshIds);
  else b.children = [];
  return b;
}

function insertInline(ed, el, ins) {
  ed.checkpoint();
  const sel = caret.getSelectionIn(el) || { start: caret.textLength(el), end: caret.textLength(el) };
  const segs = htmlToSegs(el.innerHTML);
  const [L, rest] = splitSegs(segs, sel.start);
  const [, R] = splitSegs(rest, sel.end - sel.start);
  const pos = sel.start + segsLength(ins);
  ed.replaceInline(el, segsToHTML(mergeSegs([...L, ...ins, ...R])), { start: pos, end: pos });
}

export function insertBlocksAtCaret(ed, blocks) {
  ed.checkpoint();
  ed.syncAll();
  const el = ed.activeInlineEl();
  const b = el && el.classList.contains('blk-text') ? ed.blockOfEl(el) : currentBlock(ed);
  if (!b) { ed.appendTop(blocks); ed.changed(); return; }
  if (ed.isText(b) && el) {
    const sel = caret.getSelectionIn(el);
    const segs = htmlToSegs(el.innerHTML);
    const len = segsLength(segs);
    const pos = sel ? sel.start : len;
    if (len === 0 && b.type === 'p' && !b.children.length) {
      ed.insertAfter(b, blocks);
      ed.removeBlocks([b]);
    } else if (pos === 0) ed.insertBefore(b, blocks);
    else if (pos >= len) ed.insertAfter(b, blocks);
    else {
      const [L, R] = splitSegs(segs, pos);
      ed.setTextHTML(b, segsToHTML(L));
      const tail = block(b.type === 'ol' || b.type === 'ul' || b.type === 'todo' ? b.type : 'p', { html: segsToHTML(R) });
      ed.insertAfter(b, [...blocks, tail]);
    }
  } else ed.insertAfter(b, blocks);
  const last = [...blocks].reverse().find(x => ed.isText(x));
  if (last) ed.focusBlock(last, 'end'); else ed.selectBlocks(blocks);
  ed.changed();
}

// Dateien (Bilder, PDFs) als Blöcke einfügen
async function insertFiles(ed, files, afterBlock, position = 'after') {
  const list = files.filter(f => /^image\//.test(f.type) || f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!list.length) { ed.ui.toast('Nur Bilder und PDFs können eingefügt werden.', { type: 'error' }); return; }
  const busy = ed.ui.toast(list.length > 1 ? `${list.length} Dateien werden abgelegt …` : 'Datei wird in DEVONthink abgelegt …', { type: 'busy', timeout: 0 });
  try {
    const res = await ed.host.uploadFiles(list);
    const blocks = res.map(r => r.kind === 'pdf' ? block('pdf', { src: r.link, caption: r.name || '' }) : block('image', { src: r.link, caption: '' }));
    if (!blocks.length) return;
    ed.checkpoint();
    const target = afterBlock && ed.find(afterBlock.id) ? afterBlock : null;
    if (target) {
      if (ed.isText(target) && isEmptyHTML(ed.currentHTML(target)) && !target.children.length) {
        ed.insertAfter(target, blocks);
        ed.removeBlocks([target]);
      } else if (position === 'before') ed.insertBefore(target, blocks);
      else ed.insertAfter(target, blocks);
    } else ed.appendTop(blocks);
    ed.selectBlocks(blocks);
    ed.changed();
  } catch (err) {
    ed.ui.toast('Ablegen fehlgeschlagen: ' + err.message, { type: 'error' });
  } finally { busy.close(); }
}

// ---------------------------------------------------------------------------
// Fremdes HTML → Blöcke
// ---------------------------------------------------------------------------

function sanitizeInline(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  convertMathIn(doc.body);
  return doc.body.innerHTML;
}

// KaTeX/MathJax-Formeln aus Webseiten als echte Formeln übernehmen
function convertMathIn(root) {
  for (const k of root.querySelectorAll('.katex, .katex-display, mjx-container, .MathJax')) {
    let tex = '';
    const ann = k.querySelector('annotation[encoding="application/x-tex"]');
    if (ann) tex = ann.textContent;
    else if (k.getAttribute('data-latex')) tex = k.getAttribute('data-latex');
    if (!tex) continue;
    const span = document.createElement('span');
    span.className = 'im';
    span.setAttribute('data-tex', tex.trim());
    k.replaceWith(span);
  }
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'FIGURE', 'IMG', 'DETAILS', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'DL', 'DT', 'DD']);

export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const x of doc.querySelectorAll('script, style, meta, link, noscript, template')) x.remove();
  convertMathIn(doc.body);
  const out = [];
  walkContainer(doc.body, out);
  return out.filter(b => !(b.type === 'p' && isEmptyHTML(b.html) && !b.children.length)).length ? out : [];
}

function walkContainer(node, out) {
  let inlineBuf = '';
  const flush = () => {
    if (inlineBuf.trim()) {
      const html = normalizeHTML(inlineBuf.replace(/\s*\n\s*/g, ' '));
      if (html.trim()) out.push(block('p', { html }));
    }
    inlineBuf = '';
  };
  for (const c of [...node.childNodes]) {
    if (c.nodeType === 3) { inlineBuf += escapeHTML(c.data); continue; }
    if (c.nodeType !== 1) continue;
    if (!BLOCK_TAGS.has(c.tagName) || (c.tagName === 'DIV' && !hasBlockChild(c))) {
      if (c.tagName === 'DIV') { flush(); inlineBuf = c.innerHTML; flush(); continue; }
      inlineBuf += c.outerHTML;
      continue;
    }
    flush();
    blockFromElement(c, out);
  }
  flush();
}

function hasBlockChild(el) {
  for (const c of el.children) if (BLOCK_TAGS.has(c.tagName)) return true;
  return false;
}

function blockFromElement(el, out) {
  const tag = el.tagName;
  const inner = () => normalizeHTML(el.innerHTML.replace(/\s*\n\s*/g, ' '));
  switch (tag) {
    case 'H1': out.push(block('h1', { html: inner() })); return;
    case 'H2': out.push(block('h2', { html: inner() })); return;
    case 'H3': case 'H4': case 'H5': case 'H6': out.push(block('h3', { html: inner() })); return;
    case 'P': {
      if (el.querySelector('img') && !el.textContent.trim()) { for (const img of el.querySelectorAll('img')) imageBlock(img, out); return; }
      out.push(block('p', { html: inner() }));
      return;
    }
    case 'HR': out.push(block('hr')); return;
    case 'IMG': imageBlock(el, out); return;
    case 'FIGURE': {
      const img = el.querySelector('img');
      if (img) {
        imageBlock(img, out);
        const cap = el.querySelector('figcaption');
        if (cap && out.length) out[out.length - 1].caption = normalizeHTML(cap.innerHTML);
      } else walkContainer(el, out);
      return;
    }
    case 'PRE': {
      const code = el.querySelector('code');
      const lang = code && /language-(\w+)/.exec(code.className || '');
      out.push(block('code', { lang: lang ? lang[1] : '', text: el.textContent.replace(/\n$/, '') }));
      return;
    }
    case 'BLOCKQUOTE': {
      const kids = [];
      walkContainer(el, kids);
      const first = kids[0] && kids[0].type === 'p' ? kids.shift() : null;
      out.push(block('quote', { html: first ? first.html : '', children: kids }));
      return;
    }
    case 'UL': case 'OL': {
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        const cb = li.querySelector(':scope > input[type="checkbox"]');
        const type = cb ? 'todo' : tag === 'OL' ? 'ol' : 'ul';
        const clone = li.cloneNode(true);
        const nested = [];
        for (const sub of [...clone.children]) if (sub.tagName === 'UL' || sub.tagName === 'OL' || sub.tagName === 'P' && clone.children.length > 1 || sub.tagName === 'PRE') { nested.push(sub); sub.remove(); }
        clone.querySelector(':scope > input[type="checkbox"]')?.remove();
        const b = block(type, { html: normalizeHTML(clone.innerHTML.replace(/\s*\n\s*/g, ' ')) });
        if (cb) b.checked = cb.checked || cb.hasAttribute('checked');
        for (const n of nested) blockFromElement(n, b.children);
        out.push(b);
      }
      return;
    }
    case 'TABLE': {
      // Zellen samt rowspan/colspan übernehmen (z. B. aus Word, Pages oder Webseiten)
      let src = '<table>';
      for (const tr of el.querySelectorAll('tr')) {
        src += '<tr>';
        for (const c of tr.children) {
          if (!/^T[DH]$/.test(c.tagName)) continue;
          const rs = c.getAttribute('rowspan'), cs = c.getAttribute('colspan');
          src += `<${c.tagName.toLowerCase()}${rs ? ` rowspan="${rs}"` : ''}${cs ? ` colspan="${cs}"` : ''}>${normalizeHTML(c.innerHTML.replace(/\s*\n\s*/g, ' '))}</${c.tagName.toLowerCase()}>`;
        }
        src += '</tr>';
      }
      const t = parseHtmlTable(src + '</table>');
      if (t.rows.length) {
        t.header = !!el.querySelector('th');
        out.push(t);
      }
      return;
    }
    case 'DETAILS': {
      const sum = el.querySelector(':scope > summary');
      const clone = el.cloneNode(true);
      clone.querySelector(':scope > summary')?.remove();
      const kids = [];
      walkContainer(clone, kids);
      out.push(block('toggle', { html: sum ? normalizeHTML(sum.innerHTML) : '', children: kids, open: el.open }));
      return;
    }
    case 'DL': {
      for (const c of el.children) {
        if (c.tagName === 'DT') out.push(block('p', { html: '<b>' + normalizeHTML(c.innerHTML) + '</b>' }));
        else if (c.tagName === 'DD') out.push(block('p', { html: normalizeHTML(c.innerHTML) }));
      }
      return;
    }
    default: walkContainer(el, out);
  }
}

function imageBlock(img, out) {
  const src = img.getAttribute('src');
  if (!src) return;
  out.push(block('image', { src, caption: img.getAttribute('alt') || '' }));
}
