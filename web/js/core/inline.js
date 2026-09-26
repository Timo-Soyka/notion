// Inline-Inhalt eines Textblocks.
//
// Der Editor arbeitet im DOM mit HTML (contenteditable), gespeichert wird Markdown.
// Dazwischen liegt eine flache Liste von "Segmenten": Textstücke mit einem Satz
// von Auszeichnungen (fett, kursiv, Farbe, Link …) sowie unteilbare "Atome"
// (Formel, Fußnote, Zeilenumbruch). Diese flache Form ist der Trick, der alles
// einfach hält: Formatieren ist nur noch "Auszeichnung für Zeichen a..b setzen",
// und daraus wird jedes Mal kanonisches, sauber verschachteltes HTML erzeugt –
// egal, welches Tag-Durcheinander WebKit beim Tippen hinterlassen hat.

// Reihenfolge = Verschachtelung von außen nach innen. Links außen, damit ein
// Link über fett/normal hinweg ein einziges <a> bleibt.
export const MARKS = ['a', 'hl', 'fc', 'b', 'i', 'u', 's', 'sub', 'sup', 'code'];

// Farbpalette angelehnt an Notion. Im Editor steht nur der Name (data-c),
// die Hex-Werte landen im Markdown, damit DEVONthink die Farben auch ohne
// unser CSS richtig anzeigt.
export const TEXT_COLORS = {
  gray: '#787774', brown: '#9F6B53', orange: '#D9730D', yellow: '#CB912F', green: '#448361',
  blue: '#337EA9', purple: '#9065B0', pink: '#C14C8A', red: '#D44C47'
};
export const HIGHLIGHT_COLORS = {
  yellow: '#FDEB8C', green: '#C9EBC4', blue: '#C6E3F7', pink: '#F8CFE3', orange: '#FBD9B4',
  purple: '#E3D6F3', red: '#F8CACA', gray: '#E3E2E0', brown: '#EAD9CF'
};
const HEX_TO_TEXT = invert(TEXT_COLORS);
const HEX_TO_HL = invert(HIGHLIGHT_COLORS);
function invert(o) { const r = {}; for (const k in o) r[o[k].toLowerCase()] = k; return r; }

// ---------------------------------------------------------------------------
// HTML-Zerleger
// Absichtlich ohne DOM, damit dieselbe Logik im Browser und in Node-Tests läuft.
// Er muss nur mit dem wohlgeformten HTML klarkommen, das WebKit per innerHTML
// liefert, bzw. mit dem, was wir selbst erzeugen.
// ---------------------------------------------------------------------------

const VOID = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link', 'col', 'area', 'source']);
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', shy: '', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  sbquo: '‚', euro: '€', copy: '©', reg: '®', deg: '°', times: '×', divide: '÷', middot: '·',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', zwsp: '\u200B'
};

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return e in NAMED_ENTITIES ? NAMED_ENTITIES[e] : m;
  });
}

export function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttr(s) {
  return escapeHTML(s).replace(/"/g, '&quot;');
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const v = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[m[1].toLowerCase()] = decodeEntities(v);
  }
  return attrs;
}

export function tokenizeHTML(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { tokens.push({ type: 'text', text: decodeEntities(html.slice(i)) }); break; }
    if (lt > i) tokens.push({ type: 'text', text: decodeEntities(html.slice(i, lt)) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)\s*>/.exec(html.slice(lt, lt + 4000));
    if (!m) { tokens.push({ type: 'text', text: '<' }); i = lt + 1; continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) tokens.push({ type: 'close', tag });
    else {
      const attrs = parseAttrs(m[3]);
      const selfClose = !!m[4] || VOID.has(tag);
      tokens.push({ type: selfClose ? 'void' : 'open', tag, attrs });
    }
    i = lt + m[0].length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// HTML → Segmente
// ---------------------------------------------------------------------------

function styleProps(style) {
  const out = {};
  if (!style) return out;
  for (const part of style.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim().toLowerCase();
  }
  return out;
}

function rgbToHex(v) {
  if (!v) return null;
  v = v.trim();
  if (v.startsWith('#')) {
    if (v.length === 4) return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
    return v.slice(0, 7).toLowerCase();
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('');
}

// Farbe aus Attributen lesen – bevorzugt unser data-c, sonst Hex-Werte aus
// Markdown/DEVONthink, die exakt zu unserer Palette passen. Fremde Farben aus
// eingefügten Webseiten werden bewusst verworfen, damit die Einträge ruhig bleiben.
function colorName(attrs, kind) {
  if (attrs['data-c']) return attrs['data-c'];
  const st = styleProps(attrs.style);
  const table = kind === 'hl' ? HEX_TO_HL : HEX_TO_TEXT;
  const raw = kind === 'hl' ? (st['background-color'] || st.background) : st.color;
  const hex = rgbToHex(raw);
  if (hex && table[hex]) return table[hex];
  if (kind === 'hl' && hex) return 'yellow';
  return null;
}

// Wandelt beliebiges (WebKit-)HTML in Segmente um.
export function htmlToSegs(html) {
  const tokens = tokenizeHTML(html || '');
  const segs = [];
  const stack = []; // {tag, marks: {..}} – Auszeichnungen, die das Tag beigetragen hat
  let marks = {};
  const recompute = () => {
    marks = {};
    for (const f of stack) Object.assign(marks, f.marks);
  };
  let pendingBlockBreak = false;
  const pushText = (text) => {
    if (!text) return;
    text = text.replace(/\u00A0/g, ' ').replace(/\u200B/g, '').replace(/\r/g, '');
    if (!text) return;
    if (pendingBlockBreak && segs.length) segs.push({ t: 'br', m: {} });
    pendingBlockBreak = false;
    const parts = text.split('\n');
    parts.forEach((p, idx) => {
      if (idx > 0) segs.push({ t: 'br', m: {} });
      if (p) segs.push({ t: 'text', text: p, m: { ...marks } });
    });
  };
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.type === 'text') { pushText(tok.text); continue; }
    const tag = tok.tag;
    const a = tok.attrs || {};
    if (tok.type === 'void') {
      if (tag === 'br') { segs.push({ t: 'br', m: {} }); pendingBlockBreak = false; }
      else if (tag === 'img' && a.alt) pushText(a.alt);
      continue;
    }
    if (tok.type === 'open') {
      const cls = ' ' + (a.class || '') + ' ';
      // Atome: Inhalt überspringen, nur die Daten aus den Attributen zählen.
      if (cls.includes(' im ') || a['data-tex'] !== undefined) {
        k = skipToClose(tokens, k, tag);
        segs.push({ t: 'math', tex: a['data-tex'] || '', m: pick(marks, ['a']) });
        continue;
      }
      if (cls.includes(' fn ') || a['data-note'] !== undefined) {
        k = skipToClose(tokens, k, tag);
        segs.push({ t: 'fn', html: a['data-note'] || '', m: {} });
        continue;
      }
      if (cls.includes(' am ')) {
        // Ausrichtungspunkt im Text (wie "&" in Formeln). Falls der Browser
        // Text hineingeschrieben hat, bleibt er dahinter erhalten.
        const end = skipToClose(tokens, k, tag);
        segs.push({ t: 'am', id: Math.max(1, parseInt(a['data-id'], 10) || 1), m: {} });
        const inner = tokens.slice(k + 1, end).filter(t => t.type === 'text').map(t => t.text).join('')
          .replace(/&(emsp|ensp|nbsp|#8195|#8194|#160);/g, '').replace(/[\u200B\u2003\u2002\u00A0]/g, '');
        k = end;
        if (inner.trim()) pushText(inner);
        continue;
      }
      if (cls.includes(' ref ') && a['data-target']) {
        k = skipToClose(tokens, k, tag);
        segs.push({ t: 'ref', target: a['data-target'], m: {} });
        continue;
      }
      const f = { tag, marks: {} };
      switch (tag) {
        case 'b': case 'strong': f.marks.b = true; break;
        case 'i': case 'em': case 'cite': case 'var': f.marks.i = true; break;
        case 'u': case 'ins': f.marks.u = true; break;
        case 's': case 'strike': case 'del': f.marks.s = true; break;
        case 'sub': f.marks.sub = true; break;
        case 'sup': f.marks.sup = true; break;
        case 'code': case 'kbd': case 'tt': case 'samp': f.marks.code = true; break;
        case 'mark': f.marks.hl = colorName(a, 'hl') || 'yellow'; break;
        case 'a': if (a.href) f.marks.a = a.href; break;
        case 'font': { const c = a.color && HEX_TO_TEXT[rgbToHex(a.color)]; if (c) f.marks.fc = c; break; }
        case 'div': case 'p': case 'li': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        case 'tr': case 'blockquote': case 'pre':
          if (segs.length) pendingBlockBreak = true;
          break;
        default: break;
      }
      if (tag === 'span' || tag === 'font' || tag === 'mark' || tag === 'b' || tag === 'strong') {
        const st = styleProps(a.style);
        if (tag === 'span') {
          if (a['data-c'] && !a['data-hl']) f.marks.fc = a['data-c'];
          else {
            const fc = colorName({ style: a.style }, 'fc');
            if (fc) f.marks.fc = fc;
          }
          if (a['data-hl']) f.marks.hl = a['data-hl'];
          else if (st['background-color'] || st.background) {
            const hl = colorName({ style: a.style }, 'hl');
            if (hl) f.marks.hl = hl;
          }
        }
        if (st['font-weight'] && (st['font-weight'] === 'bold' || +st['font-weight'] >= 600)) f.marks.b = true;
        if (st['font-weight'] && (st['font-weight'] === 'normal' || +st['font-weight'] === 400)) f.marks.b = false;
        if (st['font-style'] === 'italic') f.marks.i = true;
        const td = st['text-decoration'] || st['text-decoration-line'] || '';
        if (td.includes('underline')) f.marks.u = true;
        if (td.includes('line-through')) f.marks.s = true;
        if (st['vertical-align'] === 'sub') f.marks.sub = true;
        if (st['vertical-align'] === 'super') f.marks.sup = true;
      }
      stack.push(f);
      recompute();
      continue;
    }
    if (tok.type === 'close') {
      // Bis zum passenden Öffner abbauen; verwaiste Schließer ignorieren.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tag === tag) { stack.length = s; break; }
      }
      recompute();
      if (/^(div|p|li|h[1-6]|tr|blockquote|pre)$/.test(tag)) pendingBlockBreak = true;
    }
  }
  // Nach dem letzten Segment übrig gebliebener <br>: Platzhalter von WebKit
  // in leeren/endenden Zeilen, kein echter Umbruch.
  while (segs.length && segs[segs.length - 1].t === 'br' && segs.length >= 1) {
    const prev = segs[segs.length - 2];
    if (prev && prev.t === 'br') break; // doppelter <br> am Ende = gewollte Leerzeile
    segs.pop();
    break;
  }
  return mergeSegs(cleanMarks(segs));
}

function skipToClose(tokens, k, tag) {
  let depth = 0;
  for (let j = k; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === 'open' && t.tag === tag) depth++;
    else if (t.type === 'close' && t.tag === tag) { depth--; if (depth === 0) return j; }
  }
  return tokens.length - 1;
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k]) r[k] = o[k];
  return r;
}

function cleanMarks(segs) {
  for (const s of segs) {
    const m = {};
    for (const k of MARKS) if (s.m && s.m[k]) m[k] = s.m[k];
    if (m.code) { delete m.hl; }
    if (m.sub && m.sup) delete m.sup;
    s.m = m;
  }
  return segs;
}

function sameMarks(a, b) {
  for (const k of MARKS) if ((a[k] || false) !== (b[k] || false)) return false;
  return true;
}

export function mergeSegs(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.t === 'text' && !s.text) continue;
    if (last && last.t === 'text' && s.t === 'text' && sameMarks(last.m, s.m)) {
      last.text += s.text;
    } else out.push({ ...s, m: { ...s.m } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Segmente → kanonisches Editor-HTML
// ---------------------------------------------------------------------------

function openTag(key, v) {
  switch (key) {
    case 'a': return `<a href="${escapeAttr(v)}">`;
    case 'hl': return `<mark data-c="${escapeAttr(v)}">`;
    case 'fc': return `<span data-c="${escapeAttr(v)}">`;
    default: return `<${key}>`;
  }
}
function closeTag(key) {
  switch (key) {
    case 'a': return '</a>';
    case 'hl': return '</mark>';
    case 'fc': return '</span>';
    default: return `</${key}>`;
  }
}

function atomHTML(s) {
  switch (s.t) {
    case 'text': return escapeHTML(s.text);
    case 'br': return '<br>';
    case 'math': return `<span class="im" contenteditable="false" data-tex="${escapeAttr(s.tex)}"></span>`;
    case 'fn': return `<sup class="fn" contenteditable="false" data-note="${escapeAttr(s.html)}"></sup>`;
    case 'ref': return `<span class="ref" contenteditable="false" data-target="${escapeAttr(s.target)}"></span>`;
    case 'am': return `<span class="am" contenteditable="false" data-id="${s.id || 1}"></span>`;
    default: return '';
  }
}

export function segsToHTML(segs) {
  return renderLevel(segs, 0, atomHTML, openTag, closeTag);
}

function renderLevel(segs, level, atom, open, close) {
  if (level === MARKS.length) return segs.map(atom).join('');
  const key = MARKS[level];
  let out = '';
  let i = 0;
  while (i < segs.length) {
    const v = segs[i].m[key] || false;
    let j = i + 1;
    while (j < segs.length && (segs[j].m[key] || false) === v) j++;
    const inner = renderLevel(segs.slice(i, j), level + 1, atom, open, close);
    out += v ? open(key, v) + inner + close(key) : inner;
    i = j;
  }
  return out;
}

export function normalizeHTML(html) {
  return segsToHTML(htmlToSegs(html));
}

export function segsToText(segs) {
  return segs.map(s => s.t === 'text' ? s.text : s.t === 'br' ? '\n' : s.t === 'math' ? s.tex : s.t === 'am' ? '\t' : '').join('');
}

export function htmlToText(html) {
  return segsToText(htmlToSegs(html));
}

// Länge in "Positionen": Text zählt pro Zeichen, Atome zählen als 1.
export function segsLength(segs) {
  return segs.reduce((n, s) => n + (s.t === 'text' ? s.text.length : 1), 0);
}

// Teilt Segmente an Position pos in [links, rechts].
export function splitSegs(segs, pos) {
  const left = [], right = [];
  let p = 0;
  for (const s of segs) {
    const len = s.t === 'text' ? s.text.length : 1;
    if (p + len <= pos) left.push(s);
    else if (p >= pos) right.push(s);
    else {
      const cut = pos - p;
      left.push({ ...s, text: s.text.slice(0, cut), m: { ...s.m } });
      right.push({ ...s, text: s.text.slice(cut), m: { ...s.m } });
    }
    p += len;
  }
  return [left, right];
}

// Setzt oder entfernt eine Auszeichnung im Bereich [from, to).
export function applyMark(segs, from, to, key, value) {
  const [a, rest] = splitSegs(segs, from);
  const [mid, b] = splitSegs(rest, to - from);
  for (const s of mid) {
    if (s.t === 'br') continue;
    if (s.t !== 'text' && key !== 'a') continue;
    if (value) s.m[key] = value;
    else delete s.m[key];
    if (key === 'code' && value) { delete s.m.hl; }
    if (key === 'sub' && value) delete s.m.sup;
    if (key === 'sup' && value) delete s.m.sub;
  }
  return mergeSegs([...a, ...mid, ...b]);
}

// Ist die Auszeichnung auf dem ganzen Bereich aktiv? (Für den Umschalt-Zustand
// der Knöpfe in der Formatierungsleiste.)
export function markActive(segs, from, to, key) {
  const [, rest] = splitSegs(segs, from);
  const [mid] = splitSegs(rest, to - from);
  const texts = mid.filter(s => s.t === 'text');
  if (!texts.length) return false;
  return texts.every(s => !!s.m[key]);
}

export function markValueAt(segs, from, to, key) {
  const [, rest] = splitSegs(segs, from);
  const [mid] = splitSegs(rest, Math.max(1, to - from));
  const t = mid.find(s => s.t === 'text');
  return t ? t.m[key] || null : null;
}

// ---------------------------------------------------------------------------
// Segmente → Markdown
// ---------------------------------------------------------------------------

// Nur die Zeichen maskieren, die sonst wirklich als Syntax gelesen würden.
// Übermaskieren würde die Dateien in DEVONthink unleserlich machen ("\*").
export function escapeMarkdownText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*`$\[\]])/g, '\\$1')
    .replace(/~~/g, '\\~\\~')
    .replace(/==/g, '\\=\\=')
    .replace(/(^|[\s(])_/g, '$1\\_')
    .replace(/_(?=$|[\s).,;:!?])/g, '\\_')
    .replace(/<(?=[a-zA-Z\/!])/g, '&lt;');
}

function mdOpen(key, v) {
  switch (key) {
    case 'b': return '**';
    case 'i': return '*';
    case 's': return '~~';
    case 'u': return '<u>';
    case 'sub': return '<sub>';
    case 'sup': return '<sup>';
    case 'hl': return `<mark data-c="${v}" style="background-color:${HIGHLIGHT_COLORS[v] || HIGHLIGHT_COLORS.yellow}">`;
    case 'fc': return `<span data-c="${v}" style="color:${TEXT_COLORS[v] || '#000'}">`;
    default: return '';
  }
}
function mdClose(key) {
  switch (key) {
    case 'b': return '**';
    case 'i': return '*';
    case 's': return '~~';
    case 'u': return '</u>';
    case 'sub': return '</sub>';
    case 'sup': return '</sup>';
    case 'hl': return '</mark>';
    case 'fc': return '</span>';
    default: return '';
  }
}

function codeSpan(text) {
  let fence = '`';
  while (text.includes(fence)) fence += '`';
  const pad = text.startsWith('`') || text.endsWith('`') || /^\s|\s$/.test(text) && text.trim() ? ' ' : '';
  return fence + pad + text + pad + fence;
}

// ctx.footnotes: Array, in das Fußnoten-Inhalte (als Markdown) eingesammelt werden.
export function segsToMarkdown(segs, ctx = {}) {
  const footnotes = ctx.footnotes || (ctx.footnotes = []);
  const inTable = !!ctx.inTable;
  const atom = (s) => {
    switch (s.t) {
      case 'text': {
        let t = s.m.code ? s.text : escapeMarkdownText(s.text);
        if (inTable) t = t.replace(/\|/g, '\\|');
        return t;
      }
      case 'br': return inTable ? '<br>' : '<br>\n';
      case 'math': return mathSpan(s.tex);
      case 'fn': {
        const md = segsToMarkdown(htmlToSegs(s.html), { footnotes }).replace(/\n/g, ' ');
        footnotes.push(md);
        return `[^${footnotes.length}]`;
      }
      case 'ref': return `[@${s.target}]`;
      case 'am': return `<span class="am" data-id="${s.id || 1}">&emsp;</span>`;
      default: return '';
    }
  };
  return mdLevel(segs, 0, atom);
}

function mathSpan(tex) {
  const t = tex.replace(/\n/g, ' ').trim();
  return '$' + t.replace(/\$/g, '\\$') + '$';
}

function mdLevel(segs, level, atom) {
  if (level === MARKS.length) return segs.map(atom).join('');
  const key = MARKS[level];
  let out = '';
  let i = 0;
  while (i < segs.length) {
    const v = segs[i].m[key] || false;
    let j = i + 1;
    while (j < segs.length && (segs[j].m[key] || false) === v) j++;
    const group = segs.slice(i, j);
    if (!v) out += mdLevel(group, level + 1, atom);
    else if (key === 'a') {
      out += '[' + mdLevel(group, level + 1, atom) + '](' + mdLinkTarget(v) + ')';
    } else if (key === 'code') {
      // Code-Spans können nichts weiter enthalten – Text direkt, Atome daneben.
      out += group.map(s => s.t === 'text' ? codeSpan(s.text) : atom(s)).join('');
    } else {
      const inner = mdLevel(group, level + 1, atom);
      // Leerraum an den Rändern gehört außerhalb der Begrenzer, sonst erkennt
      // Markdown "** fett**" nicht als Hervorhebung.
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      if (!m[2]) out += inner;
      else out += m[1] + mdOpen(key, v) + m[2] + mdClose(key) + m[3];
    }
    i = j;
  }
  return out;
}

function mdLinkTarget(url) {
  if (/[\s()<>]/.test(url)) return '<' + url.replace(/>/g, '%3E') + '>';
  return url;
}

// ---------------------------------------------------------------------------
// Markdown → Segmente
// ---------------------------------------------------------------------------

// ctx.footnotes: Map id → Markdown-Text der Fußnote
export function markdownToSegs(md, ctx = {}) {
  const tokens = lexInline(md, ctx);
  resolveEmphasis(tokens);
  return buildSegs(tokens, ctx);
}

const PUNCT = /[!-\/:-@\[-`{-~ -⁯⸀-⹿¡-¿„“”‚‘’«»]/;

function lexInline(src, ctx) {
  const tokens = [];
  let text = '';
  const flush = () => { if (text) { tokens.push({ k: 'text', v: text }); text = ''; } };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // Maskierte Zeichen
    if (c === '\\' && i + 1 < n) {
      const d = src[i + 1];
      if (d === '\n') { flush(); tokens.push({ k: 'br' }); i += 2; continue; }
      if (/[!-\/:-@\[-`{-~]/.test(d)) { text += d; i += 2; continue; }
    }
    // Code-Span
    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = findClosingFence(src, i + run, fence);
      if (end >= 0) {
        flush();
        let code = src.slice(i + run, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        tokens.push({ k: 'code', v: code });
        i = end + run;
        continue;
      }
      text += fence; i += run; continue;
    }
    // Formel $…$ bzw. $$…$$ im Fließtext
    if (c === '$') {
      const dbl = src[i + 1] === '$';
      const open = dbl ? '$$' : '$';
      const start = i + open.length;
      if (src[start] && !/\s/.test(src[start]) || dbl) {
        let j = start;
        let found = -1;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src.startsWith(open, j) && (dbl || (!/\s/.test(src[j - 1]) && !/[0-9]/.test(src[j + 1] || '')))) { found = j; break; }
          j++;
        }
        if (found > start) {
          flush();
          tokens.push({ k: 'math', v: src.slice(start, found).replace(/\\\$/g, '$') });
          i = found + open.length;
          continue;
        }
      }
      text += c; i++; continue;
    }
    // Wiki-Link [[Name]] (DEVONthink versteht das auch selbst)
    if (c === '[' && src[i + 1] === '[') {
      const end = src.indexOf(']]', i + 2);
      if (end > i + 2 && !src.slice(i + 2, end).includes('\n')) {
        flush();
        const inner = src.slice(i + 2, end);
        const [target, label] = inner.split('|');
        tokens.push({ k: 'wiki', target: target.trim(), label: (label || target).trim() });
        i = end + 2;
        continue;
      }
    }
    // Fußnoten-Verweis [^id] und Querverweis [@label]
    if (c === '[' && (src[i + 1] === '^' || src[i + 1] === '@')) {
      const end = src.indexOf(']', i + 2);
      if (end > i + 2) {
        const id = src.slice(i + 2, end);
        if (!/\s/.test(id)) {
          flush();
          if (src[i + 1] === '^') tokens.push({ k: 'fn', id });
          else tokens.push({ k: 'ref', id });
          i = end + 1;
          continue;
        }
      }
    }
    // Bilder im Fließtext → Alternativtext (Bildblöcke erkennt der Blockparser)
    if (c === '!' && src[i + 1] === '[') {
      const link = parseLink(src, i + 1);
      if (link) { flush(); text += link.text; i = link.end; continue; }
    }
    // Links [Text](Ziel)
    if (c === '[') {
      const link = parseLink(src, i);
      if (link) {
        flush();
        tokens.push({ k: 'link', href: link.href, inner: markdownToSegs(link.text, ctx) });
        i = link.end;
        continue;
      }
    }
    // Autolinks <https://…>
    if (c === '<') {
      const auto = /^<((?:https?|mailto|x-devonthink-item|heft|file):[^\s<>]+)>/.exec(src.slice(i, i + 2000));
      if (auto) {
        flush();
        tokens.push({ k: 'link', href: auto[1], inner: [{ t: 'text', text: auto[1].replace(/^mailto:/, ''), m: {} }] });
        i += auto[0].length;
        continue;
      }
      const am = /^<span class="am" data-id="(\d+)">[^<]*<\/span>/.exec(src.slice(i, i + 200));
      if (am) {
        flush();
        tokens.push({ k: 'am', id: parseInt(am[1], 10) || 1 });
        i += am[0].length;
        continue;
      }
      const tag = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*?)\/?\s*>/.exec(src.slice(i, i + 2000));
      if (tag) {
        flush();
        tokens.push({ k: 'html', close: !!tag[1], tag: tag[2].toLowerCase(), attrs: parseAttrs(tag[3]) });
        i += tag[0].length;
        continue;
      }
    }
    // Hervorhebungs-Begrenzer
    if (c === '*' || c === '_' || c === '~' || c === '=') {
      let run = 0;
      while (src[i + run] === c) run++;
      if ((c === '~' || c === '=') && run < 2) { text += c; i++; continue; }
      const before = i > 0 ? src[i - 1] : ' ';
      const after = i + run < n ? src[i + run] : ' ';
      const ws = (ch) => /\s/.test(ch);
      const leftFlank = !ws(after) && (!PUNCT.test(after) || ws(before) || PUNCT.test(before));
      const rightFlank = !ws(before) && (!PUNCT.test(before) || ws(after) || PUNCT.test(after));
      let canOpen = leftFlank, canClose = rightFlank;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || PUNCT.test(before));
        canClose = rightFlank && (!leftFlank || PUNCT.test(after));
      }
      flush();
      tokens.push({ k: 'delim', ch: c, len: run, orig: run, canOpen, canClose });
      i += run;
      continue;
    }
    // HTML-Entitäten (&nbsp;, &lt; …) wie in CommonMark auflösen
    if (c === '&') {
      const ent = /^&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(src.slice(i, i + 40));
      if (ent) {
        const dec = decodeEntities(ent[0]);
        if (dec !== ent[0]) { text += dec; i += ent[0].length; continue; }
      }
    }
    // Harter Umbruch: zwei Leerzeichen + Zeilenende
    if (c === '\n') {
      const last = tokens[tokens.length - 1];
      if (!text && last && (last.k === 'br' || last.k === 'html' && last.tag === 'br')) {
        // Zeilenende direkt nach <br>: gehört zum Umbruch, kein zusätzliches Leerzeichen
        i++;
        while (src[i] === ' ') i++;
        continue;
      }
      if (/ {2,}$/.test(text)) { text = text.replace(/ +$/, ''); flush(); tokens.push({ k: 'br' }); }
      else { text = text.replace(/ +$/, ''); text += ' '; }
      i++;
      while (src[i] === ' ') i++;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return tokens;
}

function findClosingFence(src, from, fence) {
  let j = from;
  while (j < src.length) {
    const k = src.indexOf(fence, j);
    if (k < 0) return -1;
    if (src[k + fence.length] !== '`' && src[k - 1] !== '`') return k;
    j = k + 1;
    while (src[j] === '`') j++;
  }
  return -1;
}

function parseLink(src, i) {
  // i zeigt auf '['
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '[') depth++;
    else if (src[j] === ']') { depth--; if (depth === 0) break; }
    else if (src[j] === '\n' && src[j + 1] === '\n') return null;
  }
  if (depth !== 0 || src[j + 1] !== '(') return null;
  const text = src.slice(i + 1, j);
  let k = j + 2;
  while (src[k] === ' ') k++;
  let href = '';
  if (src[k] === '<') {
    const e = src.indexOf('>', k);
    if (e < 0) return null;
    href = src.slice(k + 1, e);
    k = e + 1;
  } else {
    let par = 0;
    const s = k;
    while (k < src.length && !/\s/.test(src[k])) {
      if (src[k] === '(') par++;
      else if (src[k] === ')') { if (par === 0) break; par--; }
      k++;
    }
    href = src.slice(s, k);
  }
  while (src[k] === ' ') k++;
  let title = null;
  if (src[k] === '"' || src[k] === "'") {
    const q = src[k];
    const e = src.indexOf(q, k + 1);
    if (e < 0) return null;
    title = src.slice(k + 1, e);
    k = e + 1;
    while (src[k] === ' ') k++;
  }
  if (src[k] !== ')') return null;
  return { text, href: decodeEntities(href), title, end: k + 1 };
}

// Vereinfachter CommonMark-Algorithmus: Schließer suchen den nächsten passenden
// Öffner. Für unsere eigenen Dateien exakt, für fremdes Markdown gut genug.
function resolveEmphasis(tokens) {
  for (let ci = 0; ci < tokens.length; ci++) {
    const closer = tokens[ci];
    if (closer.k !== 'delim' || closer.dead || !closer.canClose || closer.len === 0) continue;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = tokens[oi];
      if (opener.k !== 'delim' || opener.dead || opener.ch !== closer.ch || !opener.canOpen || opener.len === 0) continue;
      if ((opener.canClose || closer.canOpen) && (opener.orig + closer.orig) % 3 === 0 &&
          !(opener.orig % 3 === 0 && closer.orig % 3 === 0) && closer.ch !== '~' && closer.ch !== '=') continue;
      let use;
      if (closer.ch === '~' || closer.ch === '=') {
        if (opener.len < 2 || closer.len < 2) continue;
        use = 2;
      } else use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      const mark = closer.ch === '~' ? 's' : closer.ch === '=' ? 'hl' : use === 2 ? 'b' : 'i';
      opener.len -= use;
      closer.len -= use;
      (opener.opens = opener.opens || []).push(mark);
      (closer.closes = closer.closes || []).unshift(mark);
      // Begrenzer dazwischen können nicht mehr passen
      for (let k = oi + 1; k < ci; k++) if (tokens[k].k === 'delim') tokens[k].dead = true;
      if (closer.len > 0) ci--; // denselben Schließer erneut versuchen
      break;
    }
  }
}

function buildSegs(tokens, ctx) {
  const segs = [];
  const counts = {};
  const htmlStack = [];
  const marks = () => {
    const m = {};
    for (const k in counts) if (counts[k] > 0) m[k] = true;
    for (const f of htmlStack) Object.assign(m, f.marks);
    if (counts.hl > 0 && !m.hl) m.hl = 'yellow';
    if (m.hl === true) m.hl = 'yellow';
    return m;
  };
  for (const t of tokens) {
    switch (t.k) {
      case 'text': segs.push({ t: 'text', text: t.v, m: marks() }); break;
      case 'code': segs.push({ t: 'text', text: t.v, m: { ...marks(), code: true } }); break;
      case 'math': segs.push({ t: 'math', tex: t.v, m: {} }); break;
      case 'am': segs.push({ t: 'am', id: t.id, m: {} }); break;
      case 'br': segs.push({ t: 'br', m: {} }); break;
      case 'fn': {
        const def = ctx.footnotes && ctx.footnotes[t.id];
        const html = def !== undefined ? segsToHTML(markdownToSegs(def, { ...ctx, footnotes: {} })) : escapeHTML(t.id);
        segs.push({ t: 'fn', html, m: {} });
        break;
      }
      case 'ref': segs.push({ t: 'ref', target: t.id, m: {} }); break;
      case 'wiki': {
        const href = ctx.resolveWiki ? ctx.resolveWiki(t.target) : 'wiki:' + t.target;
        segs.push({ t: 'text', text: t.label, m: { ...marks(), a: href } });
        break;
      }
      case 'link': {
        const outer = marks();
        for (const s of t.inner) segs.push({ ...s, m: { ...outer, ...s.m, a: t.href } });
        break;
      }
      case 'html': {
        if (t.tag === 'br') { segs.push({ t: 'br', m: {} }); break; }
        const f = { tag: t.tag, marks: {} };
        switch (t.tag) {
          case 'u': case 'ins': f.marks.u = true; break;
          case 'sub': f.marks.sub = true; break;
          case 'sup': f.marks.sup = true; break;
          case 'b': case 'strong': f.marks.b = true; break;
          case 'i': case 'em': f.marks.i = true; break;
          case 's': case 'del': case 'strike': f.marks.s = true; break;
          case 'code': case 'kbd': f.marks.code = true; break;
          case 'mark': f.marks.hl = colorName(t.attrs, 'hl') || 'yellow'; break;
          case 'span': {
            const fc = colorName(t.attrs, 'fc');
            if (fc) f.marks.fc = fc;
            break;
          }
          case 'a': if (t.attrs.href) f.marks.a = t.attrs.href; break;
          default: break;
        }
        if (t.close) {
          for (let s = htmlStack.length - 1; s >= 0; s--) {
            if (htmlStack[s].tag === t.tag) { htmlStack.length = s; break; }
          }
        } else htmlStack.push(f);
        break;
      }
      case 'delim': {
        if (t.closes) for (const mk of t.closes) counts[mk] = (counts[mk] || 0) - 1;
        if (t.len > 0) segs.push({ t: 'text', text: t.ch.repeat(t.len), m: marks() });
        if (t.opens) for (const mk of t.opens) counts[mk] = (counts[mk] || 0) + 1;
        break;
      }
      default: break;
    }
  }
  return mergeSegs(cleanMarks(segs));
}

export function markdownToHTML(md, ctx) {
  return segsToHTML(markdownToSegs(md, ctx));
}

export function htmlToMarkdown(html, ctx) {
  return segsToMarkdown(htmlToSegs(html), ctx);
}
