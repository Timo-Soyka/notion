// Blöcke ⇄ Markdown.
//
// Die Einträge liegen als Markdown in DEVONthink. Das hat drei Gründe:
// DEVONthink kann Markdown durchsuchen und anzeigen, die Dateien bleiben auch
// ohne diese App in 20 Jahren noch lesbar, und die Synchronisation überträgt
// kleine Textdateien statt undurchsichtiger Pakete.
//
// Alles, was Markdown nicht kennt (Spalten, Einrückung, Ausrichtung,
// Seitenumbruch), wird als schlichtes HTML geschrieben – das zeigt DEVONthink
// ebenfalls korrekt an, und unser Parser erkennt genau diese Muster wieder.

import {
  htmlToSegs, segsToMarkdown, markdownToSegs, segsToHTML, escapeHTML, escapeAttr,
  decodeEntities, HIGHLIGHT_COLORS, TEXT_COLORS, MARKS, normalizeHTML
} from './inline.js';
import { normalizeTable, cellMap, needsHtmlTable } from './tablegrid.js';
import { parseWidth, flexFor } from './widths.js';

export const FORMAT_VERSION = 1;

let idCounter = 0;
export function newId() {
  idCounter = (idCounter + 1) % 1e6;
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + idCounter.toString(36);
}

// Blocktypen, die Text (html) tragen.
export const TEXT_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'toggle', 'quote', 'callout']);
// Blocktypen, die Kinder haben dürfen.
export const LIST_TYPES = new Set(['ul', 'ol', 'todo']);

export function block(type, props = {}) {
  const b = { id: newId(), type, ...props };
  if (TEXT_TYPES.has(type) && b.html === undefined) b.html = '';
  if (!b.children) b.children = [];
  return b;
}

// ---------------------------------------------------------------------------
// Front Matter (kleines YAML-Subset)
// ---------------------------------------------------------------------------

const META_ORDER = ['title', 'number', 'subject', 'date', 'tags', 'font', 'numbering', 'fullWidth', 'smallText', 'fontSize', 'lineNumbers', 'mathSyntax', 'heft'];

function yamlScalar(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v ?? '');
  if (s === '' || /^[\s]|[\s]$|[:#\[\]{},&*!|>'"%@`]|^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^[-?]/.test(s) || /^\d+([.,]\d+)*$/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

export function serializeFrontMatter(meta) {
  const keys = [...META_ORDER.filter(k => k in meta), ...Object.keys(meta).filter(k => !META_ORDER.includes(k))];
  const lines = ['---'];
  for (const k of keys) {
    const v = meta[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}: [${v.map(yamlScalar).join(', ')}]`);
    } else lines.push(`${k}: ${yamlScalar(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function parseYamlScalar(s) {
  s = s.trim();
  if (!s) return '';
  if (s[0] === '"' && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (s[0] === "'" && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  if (/^-?\d+$/.test(s) && s.length < 10) return Number(s);
  return s;
}

function splitYamlArray(inner) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { cur += c; if (c === q && inner[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(parseYamlScalar).filter(x => x !== '');
}

export function parseFrontMatter(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text.replace(/^\uFEFF/, '') };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && listKey) { meta[listKey].push(parseYamlScalar(li[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    listKey = null;
    if (val === '') { meta[key] = []; listKey = key; continue; }
    if (val.startsWith('[') && val.endsWith(']')) meta[key] = splitYamlArray(val.slice(1, -1));
    else meta[key] = parseYamlScalar(val);
  }
  // leere Listen ohne Einträge wieder entfernen
  for (const k in meta) if (Array.isArray(meta[k]) && !meta[k].length && !['tags'].includes(k)) delete meta[k];
  return { meta, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// Serialisieren
// ---------------------------------------------------------------------------

export function serializeDocument(doc) {
  const meta = { ...doc.meta, heft: FORMAT_VERSION };
  const ctx = { footnotes: [] };
  const title = (meta.title || '').trim();
  let out = serializeFrontMatter(meta) + '\n\n';
  // Der Titel steht zusätzlich als oberste Überschrift im Text, damit die
  // Vorschau in DEVONthink ihn zeigt. Abschnitte beginnen deshalb bei "##".
  if (title) out += '# ' + escapeHeading((meta.number ? meta.number + ' ' : '') + title) + '\n\n';
  const body = serializeBlocks(trimTrailingEmpty(doc.blocks), ctx);
  if (body) out += body + '\n';
  if (ctx.footnotes.length) {
    out += '\n' + ctx.footnotes.map((f, i) => `[^${i + 1}]: ${f}`).join('\n') + '\n';
  }
  return out;
}

function escapeHeading(s) {
  return s.replace(/\n/g, ' ');
}

function trimTrailingEmpty(blocks) {
  const out = blocks.slice();
  while (out.length && out[out.length - 1].type === 'p' && isEmptyHTML(out[out.length - 1].html) && !(out[out.length - 1].children || []).length) out.pop();
  return out;
}

export function isEmptyHTML(html) {
  return !html || !htmlToSegs(html).length;
}

function inl(html, ctx, extra) {
  return segsToMarkdown(htmlToSegs(html || ''), { footnotes: ctx.footnotes, ...extra });
}

function indentLines(text, prefix) {
  return text.split('\n').map(l => (l ? prefix + l : l)).join('\n');
}

function quoteLines(text) {
  return text.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
}

export function serializeBlocks(blocks, ctx) {
  let out = '';
  let prev = null;
  let olCounter = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'ol') {
      olCounter = b.start || (prev && prev.type === 'ol' ? olCounter + 1 : 1);
    }
    const text = serializeBlock(b, ctx, olCounter);
    if (text === null) continue;
    if (prev) {
      // Aufeinanderfolgende Listenpunkte gleicher Art eng setzen, sonst Leerzeile.
      const tight = LIST_TYPES.has(b.type) && prev.type === b.type && !hasBlockChildren(prev);
      out += tight ? '\n' : '\n\n';
    }
    out += text;
    prev = b;
  }
  return out;
}

function hasBlockChildren(b) {
  return (b.children || []).some(c => !LIST_TYPES.has(c.type));
}

// Formeln, Bilder usw. stehen standardmäßig mittig – bei ihnen muss auch
// "links" gespeichert werden, bei Text ist links der Normalfall.
const CENTERED_BY_DEFAULT = new Set(['math', 'chem', 'image', 'plot', 'smiles']);

function wrapAlign(b, text) {
  if (!b.align || (b.align === 'left' && !CENTERED_BY_DEFAULT.has(b.type))) return text;
  return `<div align="${b.align}">\n\n${text}\n\n</div>`;
}

function childrenIndented(b, ctx) {
  if (!b.children || !b.children.length) return '';
  return serializeBlocks(b.children, ctx);
}

function serializeBlock(b, ctx, olIndex) {
  switch (b.type) {
    case 'p': {
      let md = inl(b.html, ctx);
      if (!md.trim()) md = '&nbsp;';
      md = escapeLineStart(md);
      return wrapAlign(b, md) + indentWrapper(b, ctx);
    }
    case 'h1': case 'h2': case 'h3': {
      const level = { h1: 2, h2: 3, h3: 4 }[b.type];
      const md = inl(b.html, ctx).replace(/<br>\n/g, '<br>');
      const nr = b.num ? ` <!-- nr=${String(b.num).replace(/[^\w.\-]/g, '')} -->` : '';
      return wrapAlign(b, '#'.repeat(level) + ' ' + (md || '&nbsp;') + nr) + indentWrapper(b, ctx);
    }
    case 'ul': case 'todo': case 'ol': {
      const marker = b.type === 'ol' ? `${olIndex}. ` : b.type === 'todo' ? (b.checked ? '- [x] ' : '- [ ] ') : '- ';
      const pad = b.type === 'ol' ? ' '.repeat(`${olIndex}. `.length) : '  ';
      let md = inl(b.html, ctx);
      if (!md.trim()) md = b.type === 'todo' ? '' : '&nbsp;';
      let text = marker + indentLines(escapeLineStart(md), pad).slice(pad.length);
      const kids = childrenIndented(b, ctx);
      if (kids) {
        const sep = hasBlockChildren(b) ? '\n\n' : '\n';
        text += sep + indentLines(kids, pad);
      }
      return text;
    }
    case 'toggle': {
      const summary = inlineHTMLForExport(b.html, ctx);
      const kids = childrenIndented(b, ctx);
      return `<details${b.open ? ' open' : ''}>\n<summary>${summary}</summary>\n\n${kids || '&nbsp;'}\n\n</details>`;
    }
    case 'quote': {
      let md = inl(b.html, ctx) || '&nbsp;';
      let text = quoteLines(md);
      const kids = childrenIndented(b, ctx);
      if (kids) text += '\n>\n' + quoteLines(kids);
      return wrapAlign(b, text);
    }
    case 'callout': {
      const title = inl(b.html, ctx).replace(/<br>\n/g, '<br>');
      let text = `> [!${b.kind || 'info'}]${title ? ' ' + title : ''}`;
      const kids = childrenIndented(b, ctx);
      if (kids) text += '\n' + quoteLines(kids);
      return text;
    }
    case 'hr': return '---';
    case 'pagebreak': return '<div style="page-break-after: always;"></div>';
    case 'toc': return '{{TOC}}';
    case 'code': {
      const text = b.text || '';
      let fence = '```';
      while (text.includes(fence)) fence += '`';
      return `${fence}${b.lang || ''}\n${text}\n${fence}`;
    }
    case 'math': {
      const tex = (b.tex || '').trim();
      return wrapAlign(b, `$$\n${tex}\n$$`) + indentWrapper(b, ctx);
    }
    case 'chem': {
      const tex = (b.tex || '').trim();
      return wrapAlign(b, `$$\n\\ce{${tex}}\n$$`) + indentWrapper(b, ctx);
    }
    case 'smiles': {
      const attrs = infoAttrs({ caption: b.caption, name: b.name, w: b.width, mode: b.mode, info: b.info ? '1' : undefined });
      return '```smiles' + attrs + '\n' + (b.smiles || '') + '\n```';
    }
    case 'plot': {
      return '```plot\n' + JSON.stringify(b.config || {}, null, 2) + '\n```';
    }
    case 'mermaid': {
      return '```mermaid\n' + (b.text || '') + '\n```';
    }
    case 'image': case 'pdf': case 'drawing': {
      const parts = [];
      if (b.type === 'pdf') parts.push('pdf');
      if (b.type === 'drawing') parts.push('drawing');
      if (b.type === 'pdf' && b.pages) parts.push('pages=' + b.pages);
      if (b.width && b.width !== 100) parts.push('w=' + b.width);
      const title = parts.length ? ` "${parts.join(' ')}"` : '';
      const alt = (b.caption || '').replace(/[\[\]]/g, '').replace(/\n/g, ' ');
      return wrapAlign(b, `![${alt}](${linkTarget(b.src || '')}${title})`);
    }
    case 'table': return serializeTable(b, ctx);
    case 'columns': {
      const cols = (b.children || []).map(col => {
        const inner = serializeBlocks(trimTrailingEmpty(col.children || []), ctx);
        // Breite als data-width (für Heft) und style (damit andere Programme sie ungefähr zeigen)
        const w = col.width ? ` data-width="${col.width}" style="flex: ${flexFor(col.width)}"` : '';
        return `<div class="column"${w}>\n\n${inner || '&nbsp;'}\n\n</div>`;
      });
      return `<div class="columns">\n${cols.join('\n')}\n</div>`;
    }
    default: return null;
  }
}

function indentWrapper(b, ctx) {
  const kids = childrenIndented(b, ctx);
  if (!kids) return '';
  return `\n\n<div class="indent">\n\n${kids}\n\n</div>`;
}

function linkTarget(url) {
  if (/[\s()<>]/.test(url)) return '<' + url + '>';
  return url;
}

function infoAttrs(o) {
  let s = '';
  for (const k in o) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    s += ` ${k}="${String(o[k]).replace(/"/g, "'")}"`;
  }
  return s;
}

// Zeilen, die mit Blocksyntax beginnen würden, maskieren.
function escapeLineStart(md) {
  return md.split('\n').map(line => line
    .replace(/^(\s*)(#{1,6})(\s)/, '$1\\$2$3')
    .replace(/^(\s*)>/, '$1\\>')
    .replace(/^(\s*)([-+])(\s)/, '$1\\$2$3')
    .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4')
    .replace(/^(\s*)(-{3,}|_{3,})\s*$/, '$1\\$2')
    .replace(/^(\s*)\{\{TOC\}\}/, '$1\\{{TOC}}')
  ).join('\n');
}

// Für <summary>: dort interpretiert Markdown nichts, also echtes HTML, mit
// Inline-Farben, damit DEVONthink es farbig zeigt.
function inlineHTMLForExport(html, ctx) {
  const segs = htmlToSegs(html || '');
  return segs.map(s => {
    if (s.t === 'text') {
      let t = escapeHTML(s.text);
      if (s.m.code) t = `<code>${t}</code>`;
      if (s.m.sup) t = `<sup>${t}</sup>`;
      if (s.m.sub) t = `<sub>${t}</sub>`;
      if (s.m.s) t = `<s>${t}</s>`;
      if (s.m.u) t = `<u>${t}</u>`;
      if (s.m.i) t = `<i>${t}</i>`;
      if (s.m.b) t = `<b>${t}</b>`;
      if (s.m.fc) t = `<span data-c="${s.m.fc}" style="color:${TEXT_COLORS[s.m.fc] || '#000'}">${t}</span>`;
      if (s.m.hl) t = `<mark data-c="${s.m.hl}" style="background-color:${HIGHLIGHT_COLORS[s.m.hl] || '#ff0'}">${t}</mark>`;
      if (s.m.a) t = `<a href="${escapeAttr(s.m.a)}">${t}</a>`;
      return t;
    }
    if (s.t === 'br') return '<br>';
    if (s.t === 'math') return `<span class="im" data-tex="${escapeAttr(s.tex)}">$${escapeHTML(s.tex)}$</span>`;
    if (s.t === 'fn') {
      const md = segsToMarkdown(htmlToSegs(s.html), { footnotes: ctx.footnotes }).replace(/\n/g, ' ');
      ctx.footnotes.push(md);
      return `<sup class="fn-ref">[^${ctx.footnotes.length}]</sup>`;
    }
    return '';
  }).join('');
}

function serializeTable(b, ctx) {
  const rows = b.rows || [];
  if (!rows.length) return null;
  if (needsHtmlTable(b)) return serializeHtmlTable(b, ctx);
  const ncol = Math.max(...rows.map(r => r.length));
  const cell = (h) => {
    const md = inl(h, ctx, { inTable: true }).replace(/\n/g, '');
    return md.trim() || ' ';
  };
  const head = b.header !== false ? rows[0] : Array(ncol).fill('');
  const bodyRows = b.header !== false ? rows.slice(1) : rows;
  const line = (r) => '| ' + Array.from({ length: ncol }, (_, i) => cell(r[i] || '')).join(' | ') + ' |';
  const aligns = b.aligns || [];
  const sep = '| ' + Array.from({ length: ncol }, (_, i) => {
    const a = aligns[i];
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
  }).join(' | ') + ' |';
  let out = [line(head), sep, ...bodyRows.map(line)].join('\n');
  if (b.header === false) out = '<!-- ohne-kopfzeile -->\n' + out;
  if (b.caption) out += `\n[${inl(b.caption, ctx).replace(/\n/g, ' ')}]`;
  return out;
}

// Tabellen mit verbundenen Zellen, Zellfarben oder Kopfspalte gehen in
// Markdown nur als HTML-Tabelle. Formeln stehen zusätzlich als $…$ darin,
// damit auch DEVONthink sie anzeigt; Heft liest sie aus data-tex.
function tableCellHTML(html) {
  return normalizeHTML(html || '')
    .replace(/<span class="im" contenteditable="false" data-tex="([^"]*)"><\/span>/g, (_, t) => `<span class="im" data-tex="${t}">$${t}$</span>`)
    .replace(/\n/g, '<br>');
}

function serializeHtmlTable(b, ctx) {
  normalizeTable(b);
  const map = cellMap(b);
  const header = b.header !== false;
  const tw = b.tableWidth ? ` data-width="${b.tableWidth}" style="width: ${b.tableWidth === 'full' ? '100%' : b.tableWidth}"` : '';
  const lines = [`<table data-heft="1"${header ? '' : ' data-header="0"'}${b.headerCol ? ' data-header-col="1"' : ''}${tw}>`];
  if (b.colWidths && b.colWidths.some(Boolean)) {
    // Anteile für andere Programme als Prozent (feste Breiten bleiben fest)
    const specs = b.colWidths.map(w => w || '1fr');
    const rs = specs.filter(w => /fr$/.test(w)).reduce((a, w) => a + parseFloat(w), 0);
    const col = (w, i) => {
      const dw = b.colWidths[i] ? ` data-width="${w}"` : '';
      return /fr$/.test(w) ? `<col${dw} style="width: ${(parseFloat(w) / rs * 100).toFixed(1)}%">` : `<col${dw} style="width: ${w}">`;
    };
    lines.push('<colgroup>' + specs.map(col).join('') + '</colgroup>');
  }
  b.rows.forEach((row, r) => {
    let tr = '<tr>';
    row.forEach((html, c) => {
      const x = map[r][c];
      if (!x.anchor) return;
      const tag = (header && r === 0) || (b.headerCol && c === 0) ? 'th' : 'td';
      const attrs = [];
      if (x.rs > 1) attrs.push(`rowspan="${x.rs}"`);
      if (x.cs > 1) attrs.push(`colspan="${x.cs}"`);
      const al = (b.aligns || [])[c];
      if (al) attrs.push(`align="${al}"`);
      const bg = b.bg && b.bg[r] && b.bg[r][c];
      if (bg) attrs.push(`data-bg="${bg}" style="background-color:${HIGHLIGHT_COLORS[bg] || '#eee'}"`);
      tr += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${tableCellHTML(html)}</${tag}>`;
    });
    lines.push(tr + '</tr>');
  });
  lines.push('</table>');
  let out = lines.join('\n');
  if (b.caption) out += `\n[${inl(b.caption, ctx).replace(/\n/g, ' ')}]`;
  return out;
}

function htmlAttrs(src) {
  const a = {};
  for (const m of String(src || '').matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) a[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return a;
}

const HEX_TO_BG = Object.fromEntries(Object.entries(HIGHLIGHT_COLORS).map(([k, v]) => [v.toLowerCase(), k]));

export function parseHtmlTable(src) {
  const ta = htmlAttrs((/<table\b([^>]*)>/i.exec(src) || [])[1]);
  const rows = [], merges = [], bg = [], aligns = [];
  const occ = [];
  let firstRowAllTh = true, anyBg = false;
  const trs = [...src.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  trs.forEach((tr, r) => {
    let c = 0;
    for (const cell of tr[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      while (occ[r] && occ[r][c]) c++;
      const a = htmlAttrs(cell[2]);
      const rs = Math.max(1, parseInt(a.rowspan, 10) || 1), cs = Math.max(1, parseInt(a.colspan, 10) || 1);
      for (let i = r; i < r + rs; i++) { occ[i] = occ[i] || []; for (let j = c; j < c + cs; j++) occ[i][j] = true; }
      (rows[r] = rows[r] || [])[c] = normalizeHTML(cell[3].trim());
      if (rs > 1 || cs > 1) merges.push({ r, c, rs, cs });
      let color = a['data-bg'];
      if (!color) { const m = /background(?:-color)?\s*:\s*(#[0-9a-f]{6})/i.exec(a.style || ''); if (m) color = HEX_TO_BG[m[1].toLowerCase()]; }
      if (color) { (bg[r] = bg[r] || [])[c] = color; anyBg = true; }
      const al = a.align || ((/text-align\s*:\s*(left|center|right)/i.exec(a.style || '') || [])[1]);
      if (al && cs === 1 && !aligns[c]) aligns[c] = al.toLowerCase();
      if (r === 0 && cell[1].toLowerCase() !== 'th') firstRowAllTh = false;
      c += cs;
    }
  });
  const R = Math.max(trs.length, occ.length), C = Math.max(1, ...occ.map(o => (o ? o.length : 0)));
  const grid = Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => (rows[r] && rows[r][c]) || ''));
  const t = block('table', { rows: grid, header: ta['data-header'] === '0' ? false : (ta['data-heft'] ? true : firstRowAllTh), aligns });
  if (merges.length) t.merges = merges;
  if (anyBg) t.bg = Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => (bg[r] && bg[r][c]) || null));
  if (ta['data-header-col'] === '1') t.headerCol = true;
  if (ta['data-width'] && (ta['data-width'] === 'full' || parseWidth(ta['data-width']))) t.tableWidth = ta['data-width'] === 'full' ? 'full' : parseWidth(ta['data-width']);
  const cols = [...src.matchAll(/<col\b([^>]*)>/gi)].map(m => htmlAttrs(m[1]));
  if (cols.length) {
    const ws = cols.map(a => parseWidth(a['data-width'] || '') || null);
    if (ws.some(Boolean)) t.colWidths = ws;
  }
  return normalizeTable(t);
}

// ---------------------------------------------------------------------------
// Parsen
// ---------------------------------------------------------------------------

export function parseDocument(text, opts = {}) {
  text = String(text || '').replace(/\r\n?/g, '\n');
  const { meta, body } = parseFrontMatter(text);
  const lines = body.split('\n');
  // Fußnoten-Definitionen vorab einsammeln (sie dürfen irgendwo stehen).
  const footnotes = {};
  const kept = [];
  let inFence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      if (!inFence) inFence = fm[1];
      else if (fm[1][0] === inFence[0] && fm[1].length >= inFence.length && /^\s*[`~]+\s*$/.test(line)) inFence = null;
    }
    const def = !inFence && /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
    if (def) {
      let content = def[2];
      while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) { content += '\n' + lines[i + 1].trim(); i++; }
      footnotes[def[1]] = content;
      continue;
    }
    kept.push(line);
  }
  const isHeft = !!meta.heft;
  const ctx = { footnotes, isHeft, resolveWiki: opts.resolveWiki };
  let blocks = parseBlocks(kept, ctx);
  // Erste "#"-Überschrift ist bei unseren Dateien der Titel.
  let title = meta.title;
  // Bei fremden Dateien bleibt die erste Überschrift ein Block, der Titel ist
  // dann der Name in DEVONthink – sonst würde Heft die Datei umbenennen.
  if (blocks.length && blocks[0]._level === 1 && (isHeft || (!title && !opts.defaultTitle))) {
    const t = htmlToPlain(blocks[0].html);
    if (!title) title = meta.number && t.startsWith(meta.number + ' ') ? t.slice(meta.number.length + 1) : t;
    blocks.shift();
  }
  // Eigene Dateien behalten einen leeren Titel (Platzhalter „Unbenannt“)
  if (!title && !isHeft) title = opts.defaultTitle || '';
  // Nummer aus dem Namen übernehmen ("1.1 Quadratwurzeln"), damit sie beim
  // Speichern nicht verloren geht
  if (!isHeft && !meta.number && opts.recordName) {
    const nm = /^(\d+(?:\.\d+)*)\s+(.+)$/.exec(opts.recordName);
    if (nm && nm[2] === title) meta.number = nm[1];
  }
  cleanup(blocks);
  meta.title = title;
  if (!Array.isArray(meta.tags)) meta.tags = meta.tags ? String(meta.tags).split(',').map(s => s.trim()).filter(Boolean) : [];
  return { meta, blocks };
}

function htmlToPlain(html) {
  return htmlToSegs(html).map(s => s.t === 'text' ? s.text : s.t === 'math' ? s.tex : '').join('').trim();
}

function cleanup(blocks) {
  for (const b of blocks) {
    delete b._level;
    if (b.children) cleanup(b.children);
  }
}

const isBlank = (l) => /^\s*$/.test(l);

function inlineMD(md, ctx) {
  const segs = markdownToSegs(md, ctx);
  // Leeres &nbsp; bedeutet "leerer Absatz" (siehe Serialisierung).
  if (segs.length === 1 && segs[0].t === 'text' && /^\s*$/.test(segs[0].text)) return '';
  return segsToHTML(segs);
}

function leadingSpaces(line) {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

function stripIndent(line, n) {
  let removed = 0, i = 0;
  while (i < line.length && removed < n) {
    if (line[i] === ' ') removed++;
    else if (line[i] === '\t') removed += 4 - (removed % 4);
    else break;
    i++;
  }
  return line.slice(i);
}

const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/;
const RE_HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RE_HR = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const RE_QUOTE = /^\s{0,3}>/;
const RE_MATH = /^\s{0,3}\$\$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function startsBlock(line) {
  return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) ||
    RE_MATH.test(line) || /^\s{0,3}<(details|div|\/div|\/details|summary)\b/i.test(line) ||
    /^\s*([-*+]|1[.)])[ \t]+\S/.test(line) || /^\s*\{\{TOC\}\}\s*$/i.test(line);
}

export function parseBlocks(lines, ctx = { footnotes: {} }) {
  const blocks = [];
  let i = 0;
  const n = lines.length;
  let pendingOl = null; // Startwert der laufenden nummerierten Liste
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;

    // Code-Blöcke (inkl. unserer Sonderblöcke smiles/plot/mermaid)
    if ((m = RE_FENCE.exec(line))) {
      const indent = m[1].length;
      const fence = m[2];
      const info = m[3].trim();
      const body = [];
      i++;
      while (i < n) {
        const l = lines[i];
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(l);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { i++; break; }
        body.push(stripIndent(l, indent));
        i++;
      }
      blocks.push(fencedBlock(info, body.join('\n')));
      continue;
    }

    // Formelblock $$ … $$
    if (RE_MATH.test(line)) {
      const first = line.trim().slice(2);
      let tex;
      if (first.endsWith('$$') && first.length >= 2) { tex = first.slice(0, -2); i++; }
      else {
        const body = [first];
        i++;
        while (i < n) {
          const l = lines[i];
          const t = l.trim();
          if (t.endsWith('$$')) { body.push(t.slice(0, -2)); i++; break; }
          body.push(l);
          i++;
        }
        tex = body.join('\n');
      }
      tex = tex.replace(/^\n+|\n+$/g, '').trim();
      const ce = /^\\ce\{([\s\S]*)\}$/.exec(tex);
      if (ce && balanced(ce[1])) blocks.push(block('chem', { tex: ce[1] }));
      else blocks.push(block('math', { tex }));
      continue;
    }

    // Überschriften
    if ((m = RE_HEADING.exec(line))) {
      const level = m[1].length;
      let text = m[2] || '';
      let num;
      const nr = /\s*<!--\s*nr=([\w.\-]+)\s*-->\s*$/.exec(text);
      if (nr) { num = nr[1]; text = text.slice(0, nr.index); }
      const b = block(headingType(level, ctx), { html: inlineMD(text, ctx) });
      if (num) b.num = num;
      b._level = level;
      blocks.push(b);
      i++;
      continue;
    }

    // Trennlinie
    if (RE_HR.test(line)) { blocks.push(block('hr')); i++; continue; }

    // Inhaltsverzeichnis
    if (/^\s*(\{\{TOC\}\}|\[TOC\])\s*$/i.test(line)) { blocks.push(block('toc')); i++; continue; }

    // Zitate und Callouts
    if (RE_QUOTE.test(line)) {
      const inner = [];
      while (i < n && RE_QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^\s{0,3}> ?/, ''));
        i++;
      }
      blocks.push(quoteBlock(inner, ctx));
      continue;
    }

    // HTML-Tabellen (verbundene Zellen, Zellfarben)
    if (/^\s{0,3}<table\b/i.test(line)) {
      let j = i;
      while (j < n && !/<\/table>/i.test(lines[j])) j++;
      const t = parseHtmlTable(lines.slice(i, j + 1).join('\n'));
      i = j + 1;
      if (i < n && /^\s*\[[^\]]+\]\s*$/.test(lines[i]) && !/^\s*\[\^/.test(lines[i])) {
        t.caption = inlineMD(lines[i].trim().slice(1, -1), ctx);
        i++;
      }
      blocks.push(t);
      continue;
    }

    // HTML-Blöcke, die wir selbst schreiben
    if (/^\s{0,3}<details\b/i.test(line)) {
      const { endIndex, inner, openTagLine } = collectHTMLBlock(lines, i, 'details');
      blocks.push(detailsBlock(openTagLine, inner, ctx));
      i = endIndex + 1;
      continue;
    }
    if (/^\s{0,3}<div\b[^>]*page-break[^>]*>\s*(<\/div>)?\s*$/i.test(line)) {
      blocks.push(block('pagebreak'));
      i++;
      if (!/<\/div>/i.test(line) && i < n && /^\s*<\/div>\s*$/.test(lines[i])) i++;
      continue;
    }
    if (/^\s{0,3}<div\b/i.test(line)) {
      const { endIndex, inner, openTagLine } = collectHTMLBlock(lines, i, 'div');
      i = endIndex + 1;
      const tag = openTagLine;
      if (/class\s*=\s*"[^"]*\bcolumns\b/i.test(tag)) {
        blocks.push(columnsBlock(inner, ctx));
        continue;
      }
      const innerBlocks = parseBlocks(inner, ctx);
      const al = /align\s*=\s*"(center|right|justify|left)"/i.exec(tag) || /text-align\s*:\s*(center|right|justify)/i.exec(tag);
      if (al) {
        for (const b of innerBlocks) b.align = al[1].toLowerCase();
        blocks.push(...innerBlocks);
        continue;
      }
      if (/class\s*=\s*"[^"]*\bindent\b/i.test(tag) && blocks.length) {
        const prev = blocks[blocks.length - 1];
        prev.children = [...(prev.children || []), ...innerBlocks];
        continue;
      }
      blocks.push(...innerBlocks);
      continue;
    }
    if (/^\s{0,3}<!--\s*ohne-kopfzeile\s*-->\s*$/.test(line)) {
      ctx.nextTableNoHeader = true;
      i++;
      continue;
    }
    if (/^\s{0,3}<!--/.test(line)) {
      // Kommentare überspringen
      while (i < n && !/-->/.test(lines[i])) i++;
      i++;
      continue;
    }

    // Tabellen
    if (line.includes('|') && i + 1 < n && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows = [splitRow(line)];
      const aligns = splitRow(lines[i + 1]).map(c => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        if (t.startsWith(':')) return 'left';
        return null;
      });
      i += 2;
      while (i < n && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      let caption;
      if (i < n && /^\s*\[[^\]]+\]\s*$/.test(lines[i]) && !/^\s*\[\^/.test(lines[i])) {
        caption = inlineMD(lines[i].trim().slice(1, -1), ctx);
        i++;
      }
      const ncol = Math.max(...rows.map(r => r.length));
      const noHeader = !!ctx.nextTableNoHeader;
      ctx.nextTableNoHeader = false;
      let htmlRows = rows.map(r => Array.from({ length: ncol }, (_, k) => inlineMD((r[k] || '').trim(), { ...ctx, inTable: true })));
      if (noHeader) htmlRows = htmlRows.slice(1);
      const t = block('table', { rows: htmlRows, header: !noHeader, aligns });
      if (caption) t.caption = caption;
      blocks.push(t);
      continue;
    }

    // Listen
    if ((m = RE_LIST.exec(line)) && !(RE_HR.test(line))) {
      const res = parseListItem(lines, i, ctx);
      if (res) {
        const b = res.block;
        if (b.type === 'ol') {
          const prev = blocks[blocks.length - 1];
          const cont = prev && prev.type === 'ol';
          const expected = cont ? (prev._olN || 1) + 1 : 1;
          if (!cont) pendingOl = res.number;
          // "1. 1. 1." (übliche Markdown-Kurzschrift) zählt normal weiter
          if (res.number !== expected && !(cont && res.number === prev._olN)) b.start = res.number;
          Object.defineProperty(b, '_olN', { value: res.number, enumerable: false });
        }
        blocks.push(b);
        i = res.next;
        continue;
      }
    }

    // Bild/PDF als eigener Absatz
    if ((m = /^\s{0,3}!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+"([^"]*)")?\s*\)\s*$/.exec(line))) {
      blocks.push(mediaBlock(m[1], m[2].replace(/^<|>$/g, ''), m[3] || '', ctx));
      i++;
      continue;
    }

    // Absatz (mit Setext-Überschriften für fremdes Markdown)
    const para = [line];
    i++;
    while (i < n && !isBlank(lines[i])) {
      const l = lines[i];
      if (/^\s{0,3}(=+|-+)\s*$/.test(l) && para.length === 1 && !ctx.isHeft) {
        const level = l.trim()[0] === '=' ? 1 : 2;
        const b = block(headingType(level, ctx), { html: inlineMD(para[0].trim(), ctx) });
        b._level = level;
        blocks.push(b);
        para.length = 0;
        i++;
        break;
      }
      if (startsBlock(l)) break;
      if (l.includes('|') && i + 1 < n && RE_TABLE_SEP.test(lines[i + 1])) break;
      para.push(l);
      i++;
    }
    if (para.length) {
      blocks.push(block('p', { html: inlineMD(para.map(l => l.replace(/^\s+/, '')).join('\n'), ctx) }));
    }
  }
  return blocks;
}

function balanced(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d < 0) return false; }
  }
  return d === 0;
}

function headingType(level, ctx) {
  // In unseren Dateien ist "#" der Titel, "##" die erste Gliederungsebene.
  if (ctx.isHeft) return level <= 2 ? 'h1' : level === 3 ? 'h2' : 'h3';
  return level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
}

function parseInfo(info) {
  const m = /^(\S*)\s*(.*)$/.exec(info);
  const lang = m[1];
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let a;
  while ((a = re.exec(m[2]))) attrs[a[1]] = a[2];
  return { lang, attrs };
}

function fencedBlock(info, body) {
  const { lang, attrs } = parseInfo(info);
  const l = lang.toLowerCase();
  if (l === 'smiles') {
    const b = block('smiles', { smiles: body.trim() });
    if (attrs.caption) b.caption = attrs.caption;
    if (attrs.name) b.name = attrs.name;
    if (attrs.w) b.width = Number(attrs.w) || undefined;
    if (attrs.mode) b.mode = attrs.mode;
    if (attrs.info === '1') b.info = true;
    return b;
  }
  if (l === 'plot') {
    let config = {};
    try { config = JSON.parse(body || '{}'); } catch { config = { functions: [{ expr: body.trim() }] }; }
    return block('plot', { config });
  }
  if (l === 'mermaid') return block('mermaid', { text: body });
  return block('code', { lang, text: body });
}

function quoteBlock(inner, ctx) {
  const first = inner[0] || '';
  const co = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(first);
  if (co) {
    const b = block('callout', { kind: co[1].toLowerCase(), html: inlineMD(co[2] || '', ctx) });
    b.children = parseBlocks(inner.slice(1), ctx);
    return b;
  }
  // Erster Absatz = Text des Zitats, alles danach = Kinder.
  let k = 0;
  const para = [];
  while (k < inner.length && !isBlank(inner[k])) { para.push(inner[k]); k++; }
  const b = block('quote', { html: inlineMD(para.join('\n'), ctx) });
  b.children = parseBlocks(inner.slice(k), ctx);
  return b;
}

// Sammelt einen HTML-Block bis zum passenden Schließ-Tag (Verschachtelung zählt).
function collectHTMLBlock(lines, start, tag) {
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 0;
  let inFence = null;
  const inner = [];
  const openTagLine = lines[start];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (fm && i !== start) {
      if (!inFence) inFence = fm[1];
      else if (fm[1][0] === inFence[0] && /^\s*[`~]+\s*$/.test(l)) inFence = null;
    }
    if (!inFence) {
      const opens = (l.match(openRe) || []).length;
      const closes = (l.match(closeRe) || []).length;
      depth += opens - closes;
    }
    if (i === start) {
      // Inhalt, der in derselben Zeile nach dem öffnenden Tag steht
      const after = l.replace(new RegExp(`^\\s*<${tag}\\b[^>]*>`, 'i'), '');
      if (depth <= 0) {
        const body = after.replace(new RegExp(`</${tag}\\s*>\\s*$`, 'i'), '');
        return { endIndex: i, inner: body.trim() ? [body] : [], openTagLine };
      }
      if (after.trim()) inner.push(after);
      continue;
    }
    if (depth <= 0 && !inFence) {
      const before = l.replace(new RegExp(`</${tag}\\s*>\\s*$`, 'i'), '');
      if (before.trim()) inner.push(before);
      return { endIndex: i, inner, openTagLine };
    }
    inner.push(l);
  }
  return { endIndex: lines.length - 1, inner, openTagLine };
}

function detailsBlock(openTagLine, inner, ctx) {
  const open = /<details[^>]*\bopen\b/i.test(openTagLine);
  let summary = '';
  const rest = [];
  let found = false;
  for (let k = 0; k < inner.length; k++) {
    const l = inner[k];
    if (!found) {
      const sm = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(l);
      if (sm) {
        summary = sm[1];
        found = true;
        const after = l.slice(l.indexOf(sm[0]) + sm[0].length);
        if (after.trim()) rest.push(after);
        continue;
      }
    }
    rest.push(l);
  }
  const b = block('toggle', { html: summaryToHTML(summary, ctx), open });
  b.children = parseBlocks(rest, ctx);
  return b;
}

function summaryToHTML(summary, ctx) {
  // Fußnoten-Verweise, die wir als [^n] in die Summary geschrieben haben
  let html = summary.replace(/<sup class="fn-ref">\[\^([^\]]+)\]<\/sup>/g, (m, id) => {
    const def = ctx.footnotes[id];
    const inner = def !== undefined ? segsToHTML(markdownToSegs(def, ctx)) : '';
    return `<sup class="fn" data-note="${escapeAttr(inner)}"></sup>`;
  });
  html = html.replace(/<span class="im" data-tex="([^"]*)">[\s\S]*?<\/span>/g, (m, tex) => `<span class="im" data-tex="${tex}"></span>`);
  return segsToHTML(htmlToSegs(html));
}

function columnsBlock(inner, ctx) {
  const cols = [];
  let i = 0;
  while (i < inner.length) {
    if (/^\s*<div\b/i.test(inner[i])) {
      const res = collectHTMLBlock(inner, i, 'div');
      const col = block('column');
      const w = /data-width\s*=\s*"([^"]+)"/i.exec(res.openTagLine || inner[i]);
      if (w && parseWidth(w[1])) col.width = parseWidth(w[1]);
      col.children = parseBlocks(res.inner, ctx);
      cols.push(col);
      i = res.endIndex + 1;
    } else i++;
  }
  const b = block('columns');
  b.children = cols.length ? cols : [block('column'), block('column')];
  return b;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

function mediaBlock(alt, src, title, ctx) {
  const words = title.split(/\s+/).filter(Boolean);
  const opts = {};
  let kind = 'image';
  for (const w of words) {
    if (w === 'pdf') kind = 'pdf';
    else if (w === 'drawing') kind = 'drawing';
    else {
      const kv = /^(\w+)=(.*)$/.exec(w);
      if (kv) opts[kv[1]] = kv[2];
    }
  }
  if (/\.pdf($|\?)/i.test(src) && kind === 'image') kind = 'pdf';
  const b = block(kind, { src: decodeEntities(src), caption: alt || '' });
  if (opts.w) b.width = Number(opts.w) || 100;
  if (opts.pages) b.pages = opts.pages;
  return b;
}

function parseListItem(lines, start, ctx) {
  const line = lines[start];
  const m = RE_LIST.exec(line);
  if (!m) return null;
  const indent = leadingSpaces(m[1]);
  const marker = m[2];
  let spaces = m[3].length;
  if (spaces > 4) spaces = 1;
  if (spaces === 0) spaces = 1;
  const contentOffset = indent + marker.length + spaces;
  const ordered = /\d/.test(marker);
  let first = line.slice(m[0].length);
  let type = ordered ? 'ol' : 'ul';
  let checked;
  const task = /^\[([ xX])\](?:\s+|$)(.*)$/.exec(first);
  if (!ordered && task) {
    type = 'todo';
    checked = task[1] !== ' ';
    first = task[2];
  }
  const body = [first];
  let i = start + 1;
  let lastBlank = false;
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { body.push(''); lastBlank = true; i++; continue; }
    const ind = leadingSpaces(l);
    if (ind >= contentOffset) { body.push(stripIndent(l, contentOffset)); lastBlank = false; i++; continue; }
    // Faule Fortsetzung des ersten Absatzes
    if (!lastBlank && !startsBlock(l) && !RE_LIST.test(l) && body.length && !isBlank(body[body.length - 1])) {
      body.push(l.trim());
      i++;
      continue;
    }
    break;
  }
  // Nachlaufende Leerzeilen gehören nicht zum Punkt
  while (body.length > 1 && isBlank(body[body.length - 1])) { body.pop(); }
  // Erster Absatz = Text, Rest = Kinder
  let k = 0;
  const para = [];
  while (k < body.length && !isBlank(body[k]) && (k === 0 || !startsBlock(body[k]) && !RE_LIST.test(body[k]))) { para.push(body[k]); k++; }
  const firstText = para.join('\n');
  const b = block(type, { html: inlineMD(firstText, ctx) });
  if (type === 'todo') b.checked = checked;
  // Ein Punkt, dessen Text selbst ein Block ist (z. B. "- $$"), wird zum Kind.
  if (k === 0) b.children = parseBlocks(body, ctx);
  else b.children = parseBlocks(body.slice(k), ctx);
  return { block: b, next: i, number: ordered ? parseInt(marker, 10) : null };
}

// ---------------------------------------------------------------------------
// Hilfen für andere Module
// ---------------------------------------------------------------------------

// Reiner Text eines Dokuments (für Suche, Vorschau, Wortzahl).
export function documentPlainText(doc) {
  const out = [];
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.html) out.push(htmlToPlain(b.html));
      if (b.type === 'code') out.push(b.text || '');
      if (b.type === 'table') for (const r of b.rows || []) out.push(r.map(htmlToPlain).join(' '));
      if (b.children) walk(b.children);
    }
  };
  walk(doc.blocks || []);
  return out.join('\n');
}

export function cloneBlocks(blocks, freshIds = false) {
  return blocks.map(b => {
    const c = JSON.parse(JSON.stringify(b));
    if (freshIds) reId(c);
    return c;
  });
}

function reId(b) {
  b.id = newId();
  for (const c of b.children || []) reId(c);
}

export { MARKS };
