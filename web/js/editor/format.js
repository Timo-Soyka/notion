// Formatierungsleiste über markiertem Text und die kleinen Popover für
// Inline-Formeln, Fußnoten und Links.

import { h, esc, popover, placeNear } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import {
  htmlToSegs, segsToHTML, splitSegs, mergeSegs, markActive, markValueAt, segsToText,
  htmlToMarkdown, markdownToHTML, applyMark, TEXT_COLORS, HIGHLIGHT_COLORS
} from '../core/inline.js';
import * as caret from './caret.js';
import { iconFor } from '../core/filetypes.js';
import { hydrateInlineMath, renderToString } from './render/katex.js';
import { createField } from './mathfield.js';
import { needsSource, repairLatex } from '../core/mathlines.js';
import { uuidFromLink, itemLink } from '../bridge.js';

const COLOR_NAMES = { gray: 'Grau', brown: 'Braun', orange: 'Orange', yellow: 'Gelb', green: 'Grün', blue: 'Blau', purple: 'Lila', pink: 'Rosa', red: 'Rot' };

function inlineHost(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el ? el.closest('.blk-text, .cell, .caption') : null;
}

// Nach Änderungen an einem Inline-Feld: Modell/Speichern anstoßen
function touched(ed, el) {
  if (el.classList.contains('blk-text')) {
    const b = ed.blockOfEl(el);
    if (b) ed.dirtyText.add(b.id);
    ed.changed();
  } else el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Formatierungsleiste
// ---------------------------------------------------------------------------

export class FormatBar {
  constructor(ed) {
    this.ed = ed;
    this.el = null;
    this.onSel = () => {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.update());
    };
    document.addEventListener('selectionchange', this.onSel);
    this.onScroll = () => this.hide();
    (ed.root.closest('.view') || window).addEventListener('scroll', this.onScroll, true);
  }

  destroy() {
    document.removeEventListener('selectionchange', this.onSel);
    (this.ed.root.closest('.view') || window).removeEventListener('scroll', this.onScroll, true);
    this.hide();
  }

  hide() {
    if (this.el) { this.el.remove(); this.el = null; }
  }

  update() {
    const ed = this.ed;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || ed.selected.size || (ed.slash && ed.slash.isOpen()) || this.suspended) { if (!this.keep) this.hide(); return; }
    const host = inlineHost(sel.anchorNode);
    if (!host || host !== inlineHost(sel.focusNode) || !ed.docEl.contains(host)) { if (!this.keep) this.hide(); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return;
    this.host = host;
    if (!this.el) this.build();
    this.refreshStates();
    placeNear(this.el, r, { side: 'top', align: 'center', gap: 8 });
  }

  build() {
    const ed = this.ed;
    const bar = h('div', { class: 'fmt-bar' });
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    const btn = (key, html, tip, onClick) => {
      const b = h('button', { 'data-tip': tip, 'data-key': key || '' });
      b.innerHTML = html;
      b.addEventListener('click', (e) => { e.preventDefault(); onClick(b); });
      bar.append(b);
      return b;
    };
    const sep = () => bar.append(h('span', { class: 'sep' }));
    if (this.host.classList.contains('blk-text')) {
      btn('', '<span class="txt-btn">Umwandeln</span>' + icon('chevronDown', 'sm'), 'Block umwandeln', (b) => {
        const blk = ed.blockOfEl(this.host);
        if (blk) ed.openBlockMenu(blk, b);
      });
      sep();
    }
    const mark = (k) => () => ed.toggleMark(k, true, this.host);
    btn('b', '<span class="glyph">B</span>', 'Fett', mark('b')).dataset.kbd = '⌘B';
    btn('i', '<span class="glyph i">i</span>', 'Kursiv', mark('i')).dataset.kbd = '⌘I';
    btn('u', '<span class="glyph u">U</span>', 'Unterstrichen', mark('u')).dataset.kbd = '⌘U';
    btn('s', '<span class="glyph s">S</span>', 'Durchgestrichen', mark('s')).dataset.kbd = '⌘⇧S';
    btn('code', icon('code', 'sm'), 'Code', mark('code')).dataset.kbd = '⌘E';
    sep();
    btn('math', icon('sigma', 'sm'), 'Als Formel', () => openInlineMath(ed, null, this.host)).dataset.kbd = '⌘⇧E';
    btn('a', icon('link', 'sm'), 'Link', () => openLinkPopover(ed, this.host)).dataset.kbd = '⌘K';
    btn('sup', icon('superscript', 'sm'), 'Hochgestellt', mark('sup')).dataset.kbd = '⌃⌘+';
    btn('sub', icon('subscript', 'sm'), 'Tiefgestellt', mark('sub')).dataset.kbd = '⌃⌘-';
    sep();
    btn('color', '<span class="glyph" style="font-weight:600">A</span>' + icon('chevronDown', 'sm'), 'Farbe & Markierung', (b) => this.colorMenu(b));
    btn('hl', icon('highlighter', 'sm'), 'Markieren', () => ed.toggleMark('hl', ed.lastHighlight || 'yellow', this.host)).dataset.kbd = '⌘⇧H';
    btn('fn', icon('footnote', 'sm'), 'Fußnote', () => {
      const s = window.getSelection();
      if (s.rangeCount) { const r = s.getRangeAt(0); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
      openFootnote(ed, null, this.host);
    });
    document.body.append(bar);
    this.el = bar;
  }

  refreshStates() {
    if (!this.el || !this.host) return;
    const s = caret.getSelectionIn(this.host);
    if (!s) return;
    const segs = htmlToSegs(this.host.innerHTML);
    for (const b of this.el.querySelectorAll('button[data-key]')) {
      const k = b.dataset.key;
      if (['b', 'i', 'u', 's', 'code', 'sup', 'sub', 'a', 'hl'].includes(k)) b.classList.toggle('on', markActive(segs, s.start, s.end, k));
    }
    const fc = markValueAt(segs, s.start, s.end, 'fc');
    const cb = this.el.querySelector('button[data-key="color"] .glyph');
    if (cb) cb.style.color = fc ? `var(--t-${fc})` : '';
  }

  colorMenu(anchor) {
    const ed = this.ed;
    const host = this.host;
    const box = h('div', { style: { width: '220px' } });
    const section = (title) => box.append(h('div', { class: 'menu-section', text: title }));
    const item = (label, sw, onClick) => {
      const it = h('div', { class: 'menu-item' }, sw, h('span', { text: label }));
      it.addEventListener('mousedown', (e) => e.preventDefault());
      it.addEventListener('click', () => { onClick(); pop.close(); });
      box.append(it);
    };
    const swatch = (fg, bg) => h('span', { class: 'color-cell', style: { width: '22px', height: '22px', color: fg || 'var(--fg)', background: bg || 'var(--bg)' }, text: 'A' });
    section('Textfarbe');
    item('Standard', swatch(), () => ed.setMarkValue('fc', null, host));
    for (const c of Object.keys(TEXT_COLORS)) item(COLOR_NAMES[c], swatch(`var(--t-${c})`), () => ed.setMarkValue('fc', c, host));
    section('Markierung');
    item('Keine', swatch(null, 'var(--bg)'), () => ed.setMarkValue('hl', null, host));
    for (const c of Object.keys(HIGHLIGHT_COLORS)) item(COLOR_NAMES[c], swatch(null, `var(--m-${c})`), () => { ed.lastHighlight = c; ed.setMarkValue('hl', c, host); });
    this.keep = true;
    const pop = popover(anchor, box, { onClose: () => { this.keep = false; } });
  }
}

// ---------------------------------------------------------------------------
// Inline-Formel
// ---------------------------------------------------------------------------

export function openInlineMath(ed, span, el, initial) {
  if (!span) {
    el = el || ed.activeInlineEl();
    if (!el) return;
    const sel = caret.getSelectionIn(el) || { start: caret.textLength(el), end: caret.textLength(el) };
    ed.checkpoint();
    const segs = htmlToSegs(el.innerHTML);
    const [L, rest] = splitSegs(segs, sel.start);
    const [mid, R] = splitSegs(rest, sel.end - sel.start);
    const tex = initial !== undefined ? initial : segsToText(mid);
    const nth = L.filter(s => s.t === 'math').length;
    el.innerHTML = segsToHTML(mergeSegs([...L, { t: 'math', tex, m: {} }, ...R]));
    ed.hydrateInline(el);
    span = el.querySelectorAll('.im')[nth];
    touched(ed, el);
    if (!span) return;
  } else {
    el = inlineHost(span);
    ed.checkpoint();
  }
  span.classList.add('active');
  const tex = repairLatex(span.getAttribute('data-tex') || '');
  const host = h('div', { class: 'mf-row' });
  const hint = h('div', { class: 'hint', style: { marginTop: '6px', fontSize: '12px', color: 'var(--muted)' } });
  const box = h('div', {}, host, hint);
  const update = (v) => {
    span.setAttribute('data-tex', v);
    hydrateInlineMath(span, ed.mathMode());
    span.classList.add('active');
    touched(ed, el);
    pop.reposition();
  };
  const finish = () => {
    span.classList.remove('active');
    if (!(span.getAttribute('data-tex') || '').trim()) {
      span.remove();
      touched(ed, el);
      el.focus();
      return;
    }
    // Cursor hinter die Formel setzen
    el.focus({ preventScroll: true });
    const r = document.createRange();
    r.setStartAfter(span);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };
  const pop = popover(span, h('div', { class: 'inline-pop' }, box), { onClose: finish, class: 'no-pad' });

  // Quelltext – für chemische Formeln (\ce{…}) oder auf Wunsch
  const sourceMode = () => {
    host.innerHTML = '';
    const input = h('input', { class: 'input mono', value: span.getAttribute('data-tex') || '', placeholder: 'LaTeX, z. B. \\frac{a}{b}  oder  \\ce{H2O}', spellcheck: 'false' });
    const preview = h('div', { class: 'preview' });
    const paint = () => {
      const v = input.value;
      const r = renderToString(v || '\;', { display: false, mode: ed.mathMode() });
      preview.innerHTML = v ? (r.html || `<span class="math-error">${esc(r.error)}</span>`) : '<span class="math-empty">Vorschau</span>';
    };
    host.style.display = 'block';
    host.append(input, preview);
    hint.innerHTML = 'LaTeX-Schreibweise · <kbd>Enter</kbd> fertig';
    paint();
    input.addEventListener('input', () => { update(input.value); paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.close(); }
    });
    setTimeout(() => {
      input.focus();
      const at = input.value.endsWith('{}') ? input.value.length - 1 : input.value.length;
      input.setSelectionRange(at, at);
    }, 20);
  };

  if (needsSource(tex)) { sourceMode(); return; }
  hint.innerHTML = 'Tippe z. B. <b>wurzel</b>, <b>bruch</b>, <kbd>/</kbd>, <kbd>^</kbd> · <kbd>Enter</kbd> fertig';
  const srcBtn = h('button', { class: 'btn sm ghost icon-only', 'data-tip': 'Als LaTeX bearbeiten', html: icon('code', 'sm') });
  srcBtn.addEventListener('mousedown', (e) => e.preventDefault());
  srcBtn.addEventListener('click', sourceMode);
  createField({
    value: tex,
    inline: true,
    onInput: (v) => update(v),
    onKey: (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); pop.close(); return true; }
      return false;
    },
    onMoveOut: (dir, mf, { stay } = {}) => { if (!stay && (dir === 'forward' || dir === 'backward')) pop.close(); },
    extraMenu: () => [{ label: 'Als LaTeX bearbeiten', icon: 'code', onSelect: sourceMode }]
  }).then((mf) => {
    if (pop.closed) return;
    host.append(mf, srcBtn);
    pop.reposition();
    setTimeout(() => { mf.focus(); mf.position = mf.lastOffset; }, 20);
  });
}

// ---------------------------------------------------------------------------
// Fußnote
// ---------------------------------------------------------------------------

export function openFootnote(ed, sup, el) {
  if (!sup) {
    el = el || ed.activeInlineEl();
    if (!el) return;
    const sel = caret.getSelectionIn(el) || { start: caret.textLength(el), end: caret.textLength(el) };
    ed.checkpoint();
    const segs = htmlToSegs(el.innerHTML);
    const [L, R] = splitSegs(segs, sel.end);
    const nth = L.filter(s => s.t === 'fn').length;
    el.innerHTML = segsToHTML(mergeSegs([...L, { t: 'fn', html: '', m: {} }, ...R]));
    ed.hydrateInline(el);
    sup = el.querySelectorAll('.fn')[nth];
    touched(ed, el);
    ed.renumberFootnotes();
    if (!sup) return;
  } else {
    el = inlineHost(sup);
    ed.checkpoint();
  }
  const ta = h('textarea', { class: 'textarea', placeholder: 'Text der Fußnote, z. B. Quelle: Lambacher Schweizer, S. 12', rows: 3 });
  ta.value = htmlToMarkdown(sup.getAttribute('data-note') || '');
  const del = h('button', { class: 'btn sm danger' }, icon('trash', 'sm'), 'Entfernen');
  const box = h('div', {},
    h('div', { class: 'menu-section', style: { padding: '0 0 6px' }, text: `Fußnote ${sup.dataset.n || ''}` }),
    ta,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'hint grow', style: { fontSize: '12px', color: 'var(--muted)' }, text: 'Markdown erlaubt: **fett**, *kursiv*, [Link](https://…)' }), del));
  let removed = false;
  const pop = popover(sup, h('div', { class: 'inline-pop' }, box), {
    onClose: () => {
      if (!removed && !ta.value.trim()) { sup.remove(); ed.renumberFootnotes(); touched(ed, el); }
      el.focus({ preventScroll: true });
      if (sup.isConnected) {
        const r = document.createRange();
        r.setStartAfter(sup);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    }
  });
  ta.addEventListener('input', () => {
    sup.setAttribute('data-note', markdownToHTML(ta.value));
    ed.renumberFootnotes();
    touched(ed, el);
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.close(); }
  });
  del.addEventListener('click', () => { removed = true; sup.remove(); ed.renumberFootnotes(); touched(ed, el); pop.close(); });
  setTimeout(() => ta.focus(), 20);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function looksLikeURL(v) {
  return /^(https?:|mailto:|x-devonthink-item:|heft:|file:|#)/i.test(v) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v);
}
function normalizeURL(v) {
  v = v.trim();
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) && !/^\w+:/.test(v)) return 'https://' + v;
  return v;
}

export function openLinkPopover(ed, el) {
  el = el || ed.activeInlineEl();
  if (!el) return;
  const sel = caret.getSelectionIn(el);
  if (!sel) return;
  const segs = htmlToSegs(el.innerHTML);
  const current = markValueAt(segs, sel.start, sel.end, 'a');
  const input = h('input', { class: 'input', value: current || '', placeholder: 'Adresse einfügen oder Eintrag suchen …' });
  const list = h('div', { class: 'suggest' });
  const box = h('div', {}, input, list);
  let active = 0;
  let items = [];
  const apply = (href, label) => {
    ed.checkpoint();
    let out;
    let end = sel.end;
    if (sel.start === sel.end) {
      const text = label || href;
      const [L, R] = splitSegs(segs, sel.start);
      out = mergeSegs([...L, { t: 'text', text, m: { a: href } }, ...R]);
      end = sel.start + text.length;
    } else out = applyMark(segs, sel.start, sel.end, 'a', href);
    pop.close();
    ed.replaceInline(el, segsToHTML(out), { start: end, end });
  };
  const remove = () => {
    ed.checkpoint();
    // ganzen Link entfernen, auch wenn nur ein Teil markiert war
    let a = sel.start, z = sel.end;
    const flat = [];
    let p = 0;
    for (const s of segs) { const len = s.t === 'text' ? s.text.length : 1; flat.push({ s, from: p, to: p + len }); p += len; }
    for (const f of flat) if (f.s.m.a === current && f.to > a && f.from < z) { a = Math.min(a, f.from); z = Math.max(z, f.to); }
    // benachbarte Stücke desselben Links einsammeln
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of flat) if (f.s.m.a === current && (f.to === a || f.from === z)) { if (f.from < a) { a = f.from; changed = true; } if (f.to > z) { z = f.to; changed = true; } }
    }
    pop.close();
    ed.replaceInline(el, segsToHTML(applyMark(segs, a, z, 'a', false)), { start: z, end: z });
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = [];
    if (q && looksLikeURL(input.value.trim())) items.push({ label: 'Link setzen: ' + normalizeURL(input.value), icon: 'link', run: () => apply(normalizeURL(input.value)) });
    const notes = ed.host.listNotes ? ed.host.listNotes() : [];
    for (const n of notes.filter(n => !q || n.name.toLowerCase().includes(q)).slice(0, 8)) {
      items.push({ label: n.name, desc: n.path, icon: iconFor(n), run: () => apply(itemLink(n.uuid), n.name) });
    }
    if (ed.host.pickDocument) items.push({ label: 'Datei auswählen …', desc: 'Ordner durchblättern und suchen', icon: 'folder', run: async () => {
      pop.close();
      const n = await ed.host.pickDocument();
      if (n) apply(itemLink(n.uuid), n.name); else el.focus();
    } });
    for (const hd of ed.headings().filter(x => !q || x.text.toLowerCase().includes(q)).slice(0, 5)) {
      items.push({ label: hd.text, desc: 'Überschrift in diesem Eintrag', icon: 'heading', run: () => apply('#' + hd.slug, hd.text) });
    }
    if (current) items.push({ label: 'Link entfernen', icon: 'trash', danger: true, run: remove });
    list.innerHTML = '';
    active = Math.min(active, Math.max(0, items.length - 1));
    items.forEach((it, i) => {
      const row = h('div', { class: 'menu-item' + (i === active ? ' on' : '') + (it.danger ? ' danger' : '') });
      row.innerHTML = icon(it.icon) + `<span class="lbl" style="overflow:hidden;text-overflow:ellipsis">${esc(it.label)}</span>` + (it.desc ? `<span class="hint">${esc(it.desc)}</span>` : '');
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', it.run);
      list.append(row);
    });
    pop && pop.reposition();
  };
  const rect = (() => { const s = window.getSelection(); return s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : el.getBoundingClientRect(); })();
  const pop = popover(rect, h('div', { class: 'inline-pop' }, box), {});
  render();
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (looksLikeURL(v) && (!items[active] || active === 0)) apply(normalizeURL(v));
      else if (items[active]) items[active].run();
    } else if (e.key === 'Escape') { e.preventDefault(); pop.close(); el.focus(); }
  });
  setTimeout(() => { input.focus(); input.select(); }, 20);
}

// Kleines Popover beim Überfahren eines Links
export function linkHover(ed) {
  let timer = null, pop = null, current = null;
  const close = () => { clearTimeout(timer); if (pop) { pop.close(); pop = null; } current = null; };
  ed.docEl.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (pop) pop.close();
      current = a;
      const href = a.getAttribute('href');
      const uuid = uuidFromLink(href);
      const label = uuid ? (ed.host.noteTitle && ed.host.noteTitle(uuid)) || 'Eintrag in DEVONthink' : href.startsWith('#') ? 'Überschrift in diesem Eintrag' : href;
      const open = h('button', { class: 'btn sm' }, uuid ? 'Öffnen' : 'Öffnen ↗');
      open.addEventListener('click', () => { close(); ed.host.openLink(href); });
      const box = h('div', { class: 'row', style: { gap: '4px', padding: '2px', maxWidth: '420px' } },
        h('span', { html: icon(uuid ? 'note' : 'link', 'sm'), style: { color: 'var(--faint)', display: 'flex' } }),
        h('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', color: 'var(--muted)' }, text: label }),
        open);
      pop = popover(a, box, { class: 'link-hover' });
      pop.el.addEventListener('mouseleave', () => setTimeout(() => { if (pop && !pop.el.matches(':hover') && !(current && current.matches(':hover'))) close(); }, 250));
    }, 550);
  });
  ed.docEl.addEventListener('mouseout', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    clearTimeout(timer);
    setTimeout(() => { if (pop && !pop.el.matches(':hover') && !a.matches(':hover')) close(); }, 300);
  });
  ed.docEl.addEventListener('keydown', close);
}
