// Der Block-Editor.
//
// Aufbau wie bei Notion: jeder Textblock ist ein eigenes contenteditable-
// Element. Das Modell (this.doc.blocks) ist die Wahrheit; der DOM wird daraus
// erzeugt. Beim Tippen wird der DOM nur als "schmutzig" markiert und erst beim
// Speichern bzw. vor strukturellen Änderungen ins Modell zurückgelesen – so
// bleibt Tippen flüssig, auch in langen Einträgen.

import { attachPencilPad, pencilKnown, PENCIL_TYPES } from './pencilpad.js';
import * as UI from '../ui/ui.js';
import { renderOverlay as renderLineNumbers } from './linenumbers.js';
import { h } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { block, newId, TEXT_TYPES, LIST_TYPES, isEmptyHTML } from '../core/markdown.js';
import {
  htmlToSegs, segsToHTML, normalizeHTML, splitSegs, segsLength, mergeSegs, applyMark, markActive, segsToText
} from '../core/inline.js';
import * as caret from './caret.js';
import { hydrateInlineMath } from './render/katex.js';
import * as atoms from './blocks/atoms.js';
import { widthForNew } from '../core/imagesize.js';
import { plot, defaultPlotConfig } from './blocks/plot.js';
import { smiles } from './blocks/smiles.js';
import { table, emptyTable, tableMenu } from './blocks/table.js';
import { SlashMenu } from './slash.js';
import { FormatBar, openInlineMath, openFootnote, openLinkPopover, linkHover } from './format.js';
import { runInputRules } from './rules.js';
import { attachClipboard } from './clipboard.js';
import { attachDnd } from './dnd.js';
import { uuidFromLink, assetURL, assetVersion, isPad } from '../bridge.js';
import { normalizeMathSyntax, markColor, markName } from '../core/mathlines.js';
import { headingNumbers, listLabel, parseNum } from '../core/numbering.js';
import { subjectColor, colorDot } from '../core/subjects.js';
import { CALLOUTS } from './callouts.js';

export const ATOMS = {
  math: atoms.math, chem: atoms.chem, code: atoms.code, mermaid: atoms.code, hr: atoms.hr, pagebreak: atoms.pagebreak,
  toc: atoms.toc, image: atoms.image, pdf: atoms.pdf, columns: atoms.columns, plot, smiles, table
};

export { CALLOUTS };

const PLACEHOLDERS = {
  p: { focus: 'Tippe „/“ für Befehle …' },
  h1: { always: 'Überschrift 1' }, h2: { always: 'Überschrift 2' }, h3: { always: 'Überschrift 3' },
  ul: { focus: 'Liste' }, ol: { focus: 'Liste' }, todo: { focus: 'To-do' }, toggle: { focus: 'Toggle' },
  quote: { focus: 'Zitat' }, callout: { focus: 'Titel (optional)' }
};

const NO_CHILDREN = new Set(['columns', 'column', 'hr', 'pagebreak', 'toc']);

export class Editor {
  constructor(root, opts = {}) {
    this.root = root;
    this.host = opts.host || {};
    this.readonly = !!opts.readonly;
    this.print = !!opts.print;
    this.onChange = opts.onChange || (() => {});
    this.onTitleChange = opts.onTitleChange || (() => {});
    this.settings = opts.settings || {};
    this.ui = { menu: UI.menu, popover: UI.popover, toast: UI.toast, prompt: UI.promptDialog, confirm: UI.confirmDialog, dialog: UI.dialog };
    this.els = new Map();
    this.byId = new Map();
    this.parents = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.selected = new Set();
    this.activeAtom = null;
    this.focusId = null;
    this.dirtyText = new Set();
    this.lastTypingCP = 0;
    this.lastTypingId = null;
    this.doc = { meta: {}, blocks: [] };
    this.buildDOM();
    if (!this.readonly) {
      this.slash = new SlashMenu(this);
      this.format = new FormatBar(this);
      attachClipboard(this);
      attachDnd(this);
      this.attachEvents();
      linkHover(this);
    }
  }

  // -------------------------------------------------------------------------
  // Grundgerüst
  // -------------------------------------------------------------------------

  buildDOM() {
    this.docEl = h('div', { class: 'doc', tabindex: '-1', lang: 'de' });
    if (this.readonly) this.docEl.dataset.readonly = '';
    this.headerEl = h('div', { class: 'doc-header' });
    this.blocksEl = h('div', { class: 'blocks' });
    // Zeilennummern neu setzen, sobald sich der Text umbricht (Tippen, Fensterbreite, Auf-/Zuklappen)
    if (!this.print && window.ResizeObserver) { this._lnRO = new ResizeObserver(() => this.lineNumbersSoon()); this._lnRO.observe(this.blocksEl); }
    this.fnEl = h('div', { class: 'doc-footnotes' });
    this.endEl = h('div', { class: 'doc-end' });
    this.docEl.append(this.headerEl, this.blocksEl, this.fnEl);
    if (!this.readonly) this.docEl.append(this.endEl);
    this.root.append(this.docEl);
  }

  destroy() {
    this._lnRO && this._lnRO.disconnect();
    cancelAnimationFrame(this._lnRaf);
    this.format && this.format.destroy();
    this.slash && this.slash.close();
    this._unbind && this._unbind();
    this.docEl.remove();
  }

  mathMode() {
    return this.doc.meta.mathSyntax || this.settings.mathSyntax || 'auto';
  }

  contentWidth() {
    return this.blocksEl.clientWidth || 700;
  }

  // -------------------------------------------------------------------------
  // Laden / Abgeben
  // -------------------------------------------------------------------------

  load(doc) {
    this.doc = { meta: { ...(doc.meta || {}) }, blocks: doc.blocks || [] };
    // Formeln einheitlich als LaTeX (das Formelfeld arbeitet mit LaTeX)
    normalizeMathSyntax(this.doc, this.settings && this.settings.mathSyntax);
    if (!this.doc.blocks.length && !this.readonly) this.doc.blocks.push(block('p'));
    this.undoStack = [];
    this.redoStack = [];
    this.selected.clear();
    this.activeAtom = null;
    this.applyMeta();
    this.renderHeader();
    this.renderAll();
  }

  getDoc() {
    this.syncAll();
    return { meta: { ...this.doc.meta }, blocks: this.doc.blocks };
  }

  applyMeta() {
    const m = this.doc.meta;
    const d = this.docEl.dataset;
    const font = m.font || this.settings.font || 'sans';
    d.font = font;
    if (m.smallText) d.small = ''; else delete d.small;
    // Schriftgröße in Punkt (Eintrag vor Einstellungen); 1 pt = 1,25 px wie beim Drucken
    const pt = Number(m.fontSize) || Number(this.settings.fontSize) || 0;
    if (pt) this.docEl.style.setProperty('--doc-size', (pt * 1.25 * (m.smallText && !m.fontSize ? 0.875 : 1)) + 'px');
    else this.docEl.style.removeProperty('--doc-size');
    if (m.fullWidth) d.full = ''; else delete d.full;
    const numbering = m.numbering !== undefined ? m.numbering : (this.settings.numbering || '');
    if (numbering && numbering !== 'off') d.numbering = numbering; else delete d.numbering;
    const colored = m.headingColor !== undefined ? m.headingColor : this.settings.headingColor !== false;
    if (colored) d.headingColor = ''; else delete d.headingColor;
    if (m.lineNumbers) d.lines = String(m.lineNumbers); else delete d.lines;
    this.lineNumbersSoon();
  }

  // Zeilennummern am Rand (⋯-Menü → Zeilennummern)
  lineNumbersSoon() {
    if (this.print || !this.docEl) return;
    cancelAnimationFrame(this._lnRaf);
    this._lnRaf = requestAnimationFrame(() => renderLineNumbers(this.docEl, this.blocksEl, Number(this.doc && this.doc.meta.lineNumbers) || 0));
  }

  // Einstellungen der Nummerierung: Eintrag (⋯-Menü) vor Standard (Einstellungen)
  numberingOpts() {
    const m = this.doc.meta, s = this.settings;
    const pick = (k, def) => (m[k] !== undefined ? m[k] : s[k] !== undefined ? s[k] : def);
    const style = pick('numbering', '');
    return {
      style: style === 'off' ? '' : style,
      depth: Number(pick('numberDepth', 3)) || 3,
      prefix: pick('numberPrefix', false) && m.number ? String(m.number) : '',
      listStyle: pick('listStyle', '1.'),
      listNested: pick('listNested', true) !== false,
      captions: !!pick('captionNumbers', false)
    };
  }

  headingNumberMap() {
    const list = this.flat().filter(b => /^h[123]$/.test(b.type)).map(b => ({ id: b.id, level: +b.type[1], num: b.num }));
    return headingNumbers(list, this.numberingOpts());
  }

  renumberHeadings() {
    const map = this.headingNumberMap();
    for (const [id, num] of map) {
      const t = this.textElOf(this.find(id));
      if (!t) continue;
      if (num) t.dataset.num = num; else delete t.dataset.num;
    }
  }

  // "Abbildung 1", "Tabelle 1" vor den Beschriftungen (falls eingeschaltet)
  renumberCaptions() {
    const on = this.numberingOpts().captions;
    let fig = 0, tab = 0;
    for (const b of this.flat()) {
      const cap = this.elOf(b)?.querySelector(':scope > .blk-main .caption');
      if (!cap) continue;
      const has = on && String(b.caption || '').replace(/<[^>]*>/g, '').trim();
      if (!has) { delete cap.dataset.num; continue; }
      cap.dataset.num = b.type === 'table' ? `Tabelle ${++tab}` : `Abbildung ${++fig}`;
    }
  }

  setMeta(patch) {
    this.checkpoint();
    Object.assign(this.doc.meta, patch);
    for (const k in patch) if (patch[k] === undefined || patch[k] === null) delete this.doc.meta[k];
    this.applyMeta();
    this.renderHeader();
    this.afterStructure();
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Modell-Hilfen
  // -------------------------------------------------------------------------

  makeBlock(type, props) { return block(type, props); }

  reindex() {
    this.byId.clear();
    this.parents.clear();
    const walk = (list, parent) => {
      for (const b of list) {
        this.byId.set(b.id, b);
        this.parents.set(b.id, parent);
        if (!b.children) b.children = [];
        walk(b.children, b);
      }
    };
    walk(this.doc.blocks, null);
  }

  find(id) { return this.byId.get(id); }
  parentOf(b) { return this.parents.get(b.id) || null; }
  siblingsOf(b) { const p = this.parentOf(b); return p ? p.children : this.doc.blocks; }
  indexOf(b) { return this.siblingsOf(b).indexOf(b); }
  isText(b) { return b && TEXT_TYPES.has(b.type); }
  elOf(b) { return b && this.els.get(b.id); }
  textElOf(b) {
    const el = this.elOf(b);
    return el ? el.querySelector(':scope > .blk-main > .blk-text') : null;
  }
  blockOfEl(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-id]');
    return el ? this.find(el.dataset.id) : null;
  }
  registerEl(b, el) { this.els.set(b.id, el); }

  // Sichtbare Blöcke in Lesereihenfolge (zugeklappte Toggles überspringen)
  flat() {
    const out = [];
    const walk = (list) => {
      for (const b of list) {
        if (b.type === 'columns') { for (const col of b.children) walk(col.children); continue; }
        out.push(b);
        const closed = (b.type === 'toggle' && !b.open) || (b.type === 'callout' && b.kind === 'loesung' && !b.open);
        if (!closed) walk(b.children);
      }
    };
    walk(this.doc.blocks);
    return out;
  }
  prevVisible(b) { const f = this.flat(); const i = f.indexOf(b); return i > 0 ? f[i - 1] : null; }
  nextVisible(b) { const f = this.flat(); const i = f.indexOf(b); return i >= 0 && i < f.length - 1 ? f[i + 1] : null; }

  // -------------------------------------------------------------------------
  // Darstellung
  // -------------------------------------------------------------------------

  renderAll() {
    this.reindex();
    this.els.clear();
    this.blocksEl.innerHTML = '';
    for (const b of this.doc.blocks) this.blocksEl.append(this.renderBlock(b));
    this.afterStructure();
    this.alignMarks();
  }

  // -------------------------------------------------------------------------
  // Ausrichtungspunkte im Text ("&"): Punkte mit derselben ID in direkt
  // aufeinanderfolgenden Absätzen stehen genau untereinander – wie Tabstopps.
  // -------------------------------------------------------------------------

  alignSoon() {
    if (this._alignQueued) return;
    this._alignQueued = true;
    const run = () => { if (!this._alignQueued) return; this._alignQueued = false; this.alignMarks(); this.lineNumbersSoon(); };
    requestAnimationFrame(run);
    setTimeout(run, 80);
  }

  alignMarks() {
    const root = this.blocksEl;
    if (!root) return;
    // Vorherige Gruppen-Ausrichtung zurücksetzen
    for (const t of root.querySelectorAll('.blk-text.am-group')) { t.classList.remove('am-group'); t.style.paddingLeft = ''; }
    const all = root.querySelectorAll('.blk-text .am');
    if (!all.length) return;
    const idOf = (m) => parseInt(m.dataset.id, 10) || 1;
    for (const m of all) {
      m.style.width = '';
      m.style.setProperty('--am-c', markColor(idOf(m)));
      m.title = `Ausrichtungspunkt ${idOf(m)} – Rechtsklick zum Ändern`;
    }
    const flush = (run) => {
      const marks = run.flatMap(r => r.marks);
      const count = new Map();
      for (const m of marks) count.set(idOf(m), (count.get(idOf(m)) || 0) + 1);
      const shared = [...count.keys()].filter(id => count.get(id) >= 2).sort((a, b) => a - b);
      if (!shared.length) return;
      // Zentriert oder rechtsbündig: Zeilen linksbündig untereinander ausrichten
      // und danach den ganzen Block zentrieren – sonst verschiebt jede Zeile
      // sich selbst und die Lücken im Text würden größer.
      const align = run.map(r => r.el.closest('.blk')?.dataset.align).find(a => a === 'center' || a === 'right');
      if (align) for (const r of run) r.el.classList.add('am-group');
      for (const id of shared) {
        const ms = marks.filter(m => idOf(m) === id);
        const xs = ms.map(m => m.getBoundingClientRect().left);
        const max = Math.max(...xs);
        ms.forEach((m, i) => { const extra = max - xs[i]; if (extra > 0.5) m.style.width = `calc(var(--am-w) + ${extra.toFixed(1)}px)`; });
      }
      if (!align) return;
      let left = Infinity, right = -Infinity, avail = Infinity;
      for (const r of run) {
        const cs = getComputedStyle(r.el);
        const box = r.el.getBoundingClientRect();
        const cl = box.left + parseFloat(cs.paddingLeft || 0) + parseFloat(cs.borderLeftWidth || 0);
        const cr = box.right - parseFloat(cs.paddingRight || 0) - parseFloat(cs.borderRightWidth || 0);
        const range = document.createRange();
        range.selectNodeContents(r.el);
        const rr = range.getBoundingClientRect();
        left = Math.min(left, cl);
        right = Math.max(right, rr.right);
        avail = Math.min(avail, cr - cl);
      }
      const width = right - left;
      const off = Math.max(0, align === 'center' ? (avail - width) / 2 : avail - width);
      for (const r of run) r.el.style.paddingLeft = `calc(2px + ${off.toFixed(1)}px)`;
    };
    for (const container of [root, ...root.querySelectorAll('.blk-children')]) {
      let run = [];
      for (const child of container.children) {
        if (!child.classList.contains('blk')) continue;
        const own = child.querySelector(':scope > .blk-main > .blk-text');
        const ms = own ? [...own.querySelectorAll('.am')] : [];
        if (ms.length) run.push({ el: own, marks: ms });
        else { flush(run); run = []; }
      }
      flush(run);
    }
  }

  // Rechtsklick auf einen Ausrichtungspunkt im Text
  alignMarkMenu(am, at) {
    const t = am.closest('.blk-text');
    const b = t && this.blockOfEl(t);
    if (!b) return;
    const cur = parseInt(am.dataset.id, 10) || 1;
    const apply = (fn) => () => {
      this.checkpoint();
      fn();
      this.dirtyText.add(b.id);
      this.syncBlock(b);
      this.changed();
      this.alignSoon();
    };
    const swatch = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${c};margin-right:2px"></span>`;
    const items = [{ section: `Ausrichtungspunkt ${cur}` }];
    for (let id = 1; id <= 6; id++) items.push({ label: `ID ${id} – ${markName(id)}`, html: swatch(markColor(id)), checked: id === cur, onSelect: apply(() => { am.dataset.id = String(id); }) });
    items.push({ label: 'Andere ID …', icon: 'hash', onSelect: async () => {
      const v = await UI.promptDialog('ID des Ausrichtungspunkts', String(cur), { placeholder: 'z. B. 7', description: 'Punkte mit derselben ID stehen in Zeilen direkt untereinander an derselben Stelle.' });
      const n = parseInt(v, 10);
      if (n > 0 && n < 100) apply(() => { am.dataset.id = String(n); })();
    } });
    items.push('-',
      { label: 'In normales &-Zeichen umwandeln', icon: 'text', onSelect: apply(() => { am.replaceWith(document.createTextNode('&')); }) },
      { label: 'Punkt entfernen', icon: 'trash', danger: true, onSelect: apply(() => { am.remove(); }) });
    UI.menu(at, items);
  }

  // Ausrichtungspunkt an der Einfügemarke einsetzen (Befehlsmenü)
  insertAlignMark(el) {
    el = el || this.activeInlineEl();
    if (!el) return;
    const sel = caret.getSelectionIn(el) || { start: caret.textLength(el), end: caret.textLength(el) };
    this.checkpoint();
    const segs = htmlToSegs(el.innerHTML);
    const [L, rest] = splitSegs(segs, sel.start);
    const [, R] = splitSegs(rest, sel.end - sel.start);
    el.innerHTML = segsToHTML(mergeSegs([...L, { t: 'am', id: 1, m: {} }, ...R]));
    this.hydrateInline(el);
    el.focus();
    caret.setSelectionIn(el, sel.start + 1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this.alignSoon();
  }

  renderBlock(b) {
    if (!b.children) b.children = [];
    const el = h('div', { class: 'blk', 'data-id': b.id, 'data-type': b.type });
    this.applyBlockAttrs(b, el);
    const main = h('div', { class: 'blk-main' });
    el.append(main);
    const def = ATOMS[b.type];
    if (def) {
      try { def.render(this, b, main, el); }
      catch (err) { console.error(err); main.append(h('div', { class: 'math-error', text: 'Block konnte nicht angezeigt werden: ' + err.message })); }
    } else this.renderTextBlock(b, main);
    if (!(def && def.container)) {
      const kids = h('div', { class: 'blk-children' });
      for (const c of b.children) kids.append(this.renderBlock(c));
      if (b.type === 'toggle' && b.open && !b.children.length && !this.readonly) {
        const empty = h('div', { class: 'toggle-empty', text: 'Leerer Toggle. Klicken, um etwas hinzuzufügen.' });
        empty.addEventListener('mousedown', (e) => { e.preventDefault(); this.checkpoint(); const nb = block('p'); this.insertChildAt(b, 0, [nb]); this.focusBlock(nb, 'start'); this.changed(); });
        kids.append(empty);
      }
      el.append(kids);
    }
    this.els.set(b.id, el);
    return el;
  }

  applyBlockAttrs(b, el) {
    const d = el.dataset;
    d.type = b.type;
    if (b.align) d.align = b.align; else delete d.align;
    if (b.type === 'todo' && b.checked) d.checked = ''; else delete d.checked;
    if (b.open || this.print && (b.type === 'toggle' || b.kind === 'loesung') && this.settings.printOpenToggles !== false) d.open = ''; else delete d.open;
    if (b.type === 'callout') d.kind = b.kind || 'info'; else delete d.kind;
  }

  renderTextBlock(b, main) {
    if (b.type === 'ul' || b.type === 'ol') main.append(h('div', { class: 'blk-marker' }));
    if (b.type === 'todo') {
      const box = h('button', { class: 'check-box', tabindex: '-1', 'aria-label': 'Erledigt' });
      box.addEventListener('mousedown', (e) => e.preventDefault());
      box.addEventListener('click', () => this.toggleChecked(b));
      main.append(h('div', { class: 'blk-marker' }, box));
    }
    if (b.type === 'toggle') {
      const btn = h('button', { class: 'toggle-btn', tabindex: '-1', html: icon('triangle') });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.toggleOpen(b));
      main.append(btn);
    }
    if (b.type === 'callout') {
      const def = CALLOUTS[b.kind] || CALLOUTS.info;
      const ic = h('div', { class: 'callout-icon' });
      ic.innerHTML = icon(def.icon) + `<span class="label">${def.label}</span>`;
      if (!this.readonly) {
        ic.addEventListener('mousedown', (e) => { e.preventDefault(); this.calloutMenu(b, ic); });
        ic.style.cursor = 'default';
      }
      main.append(ic);
    }
    const ph = PLACEHOLDERS[b.type] || {};
    const t = h('div', {
      class: 'blk-text', contenteditable: this.readonly ? 'false' : 'true', spellcheck: 'true',
      'data-ph': ph.always || null, 'data-ph-focus': ph.focus || null
    });
    t.innerHTML = b.html || '';
    this.hydrateInline(t);
    main.append(t);
    if (b.type === 'callout' && CALLOUTS[b.kind]?.foldable) {
      const fold = h('button', { class: 'btn sm callout-fold', tabindex: '-1' }, b.open ? 'Verbergen' : 'Anzeigen');
      fold.addEventListener('mousedown', (e) => e.preventDefault());
      fold.addEventListener('click', () => this.toggleOpen(b));
      if (!this.print) main.append(fold);
    }
  }

  hydrateInline(el) {
    for (const m of el.querySelectorAll('.im')) hydrateInlineMath(m, this.mathMode());
    // Hinter Ausrichtungspunkten braucht WebKit einen Textknoten für den Cursor
    for (const a of el.querySelectorAll('.am')) {
      a.textContent = '';
      const nx = a.nextSibling;
      if (!nx || nx.nodeType !== 3) a.after(document.createTextNode('\u200B'));
    }
    for (const f of el.querySelectorAll('.fn, .ref')) f.setAttribute('contenteditable', 'false');
    for (const a of el.querySelectorAll('a[href]')) {
      if (/^x-devonthink-item:/i.test(a.getAttribute('href'))) a.classList.add('note-link');
    }
  }

  rerender(b, { keepFocus = true } = {}) {
    const old = this.els.get(b.id);
    if (!old) return;
    let sel = null;
    if (keepFocus) sel = this.captureSelection();
    // Kinder-Elemente abmelden, sie werden neu erzeugt
    const nu = this.renderBlock(b);
    old.replaceWith(nu);
    this.reindex();
    this.afterStructure();
    if (sel && sel.type === 'text' && this.byId.has(sel.id)) this.restoreSelection(sel);
  }

  afterStructure() {
    this.renumberLists();
    this.renumberHeadings();
    this.renumberCaptions();
    this.renumberFootnotes();
    for (const b of this.byId.values()) {
      if (b.type === 'toc') { const el = this.elOf(b); if (el) atoms.toc.render(this, b, el.querySelector(':scope > .blk-main')); }
    }
  }

  renumberLists() {
    const o = this.numberingOpts();
    const walk = (list, depth) => {
      let n = 0;
      let prev = null;
      for (const b of list) {
        if (b.type === 'ol') {
          // Eigene Nummer (b.start) gilt auch mitten in der Liste; danach wird weitergezählt
          n = b.start || (prev && prev.type === 'ol' ? n + 1 : 1);
          const m = this.elOf(b)?.querySelector(':scope > .blk-main > .blk-marker');
          if (m) { m.dataset.n = listLabel(n, depth, o.listStyle, o.listNested); m.classList.toggle('own', !!b.start); }
        }
        prev = b;
        if (b.children) walk(b.children, depth + (b.type === 'ol' ? 1 : 0));
      }
    };
    walk(this.doc.blocks, 0);
  }

  renumberFootnotes() {
    const fns = [...this.blocksEl.querySelectorAll('.fn')];
    this.fnEl.innerHTML = '';
    fns.forEach((f, i) => {
      f.dataset.n = i + 1;
      const item = h('div', { class: 'fn-item' });
      const n = h('span', { class: 'n', text: String(i + 1) });
      n.addEventListener('click', () => f.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      const body = h('span');
      body.innerHTML = f.getAttribute('data-note') || '';
      this.hydrateInline(body);
      body.querySelectorAll('[contenteditable]').forEach(x => x.removeAttribute('contenteditable'));
      item.append(n, body);
      this.fnEl.append(item);
    });
    if (fns.length) this.fnEl.dataset.count = fns.length;
  }

  headings() {
    const map = this.headingNumberMap();
    const out = [];
    const used = new Map();
    for (const b of this.flat()) {
      if (!/^h[123]$/.test(b.type)) continue;
      const text = segsToText(htmlToSegs(this.currentHTML(b))).trim();
      // Dauerhafter Anker aus dem Text der Überschrift (#zusammenfassung, bei Doppelten #zusammenfassung-2)
      const base = headingSlug(text);
      const k = (used.get(base) || 0) + 1;
      used.set(base, k);
      out.push({ id: b.id, slug: k > 1 ? `${base}-${k}` : base, level: +b.type[1], text: text || 'Ohne Titel', number: (map.get(b.id) || '').replace(/\.$/, '') });
    }
    return out;
  }

  // Nummer einer Überschrift / eines Listenpunkts von Hand festlegen
  numberMenuItems(b) {
    const isHeading = /^h[123]$/.test(b.type);
    const apply = (fn) => () => { this.checkpoint(); fn(); this.afterStructure(); this.changed(); };
    const current = isHeading ? (this.headingNumberMap().get(b.id) || '').replace(/\.$/, '') : (b.start ? String(b.start) : '');
    const ask = async () => {
      const v = await UI.promptDialog(isHeading ? 'Nummer der Überschrift' : 'Nummer des Listenpunkts', current, {
        placeholder: isHeading ? 'z. B. 3 oder 2.4' : 'z. B. 5',
        description: 'Die folgenden Nummern zählen von hier aus weiter. Leer lassen = wieder automatisch.'
      });
      if (v === null) return;
      const t = v.trim();
      if (isHeading) {
        if (!t) apply(() => { delete b.num; })();
        else if (parseNum(t)) apply(() => { b.num = t.replace(/[.)]+$/, ''); })();
      } else {
        const n = parseInt(t, 10);
        apply(() => { if (n > 0) b.start = n; else delete b.start; })();
      }
    };
    const items = [{ label: 'Nummer festlegen …', icon: 'hash', onSelect: ask }];
    if (isHeading) items.push({ label: 'Ohne Nummer', icon: 'x', checked: b.num === '-', onSelect: apply(() => { if (b.num === '-') delete b.num; else b.num = '-'; }) });
    if ((isHeading && b.num) || (!isHeading && b.start)) items.push({ label: 'Wieder automatisch zählen', icon: 'refresh', onSelect: apply(() => { delete b.num; delete b.start; }) });
    items.push('-', { label: 'Standard einstellen …', icon: 'gear', onSelect: () => this.host.openSettings && this.host.openSettings('numbering') });
    return items;
  }

  // Klick auf die Nummer vor einer Überschrift?
  hitHeadingNumber(t, e) {
    if (!t.dataset.num) return false;
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    if (!first || !first.length) return e.clientX < t.getBoundingClientRect().left + 40;
    const r = document.createRange();
    r.setStart(first, 0);
    r.setEnd(first, 1);
    const rect = r.getBoundingClientRect();
    return e.clientX < rect.left - 1 && e.clientY <= rect.bottom + 2;
  }

  currentHTML(b) {
    if (this.dirtyText.has(b.id)) {
      const t = this.textElOf(b);
      if (t) return normalizeHTML(t.innerHTML);
    }
    return b.html || '';
  }

  scrollToBlock(id) {
    // Verweise auf Überschriften: Anker aus dem Text (#zusammenfassung) oder – ältere Verweise – die Block-ID
    if (!this.els.has(id)) { const hd = this.headings().find(x => x.slug === id); if (hd) id = hd.id; }
    const el = this.els.get(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.add('selected');
    setTimeout(() => el.classList.remove('selected'), 900);
  }

  notifyLayout() { this.dnd && this.dnd.refresh && this.dnd.refresh(); }

  // Neue Bilder bekommen die Größe des Bildes davor (bzw. die Voreinstellung),
  // damit alle Bilder eines Eintrags gleich groß bleiben
  sizeNewImages(list) {
    const imgs = (list || []).filter(b => b && b.type === 'image' && b.src && b.width == null);
    if (!imgs.length) return;
    for (const b of imgs) b._fresh = true;
    for (const b of imgs) { const w = widthForNew(this.doc.blocks, b, this.settings.imageWidth); if (w) b.width = w; }
    for (const b of imgs) { delete b._fresh; if (b.width && this.els.has(b.id)) this.rerender(b, { keepFocus: false }); }
  }

  // Bilder und PDF-Seiten neu laden, deren Datei sich geändert hat
  // (im Bildeditor bearbeitet oder außerhalb von Heft, z. B. in Vorschau)
  refreshAssets() {
    for (const [id, el] of this.els) {
      const b = this.find(id);
      if (!b || !b.src) continue;
      if (b.type === 'image') {
        const img = el.querySelector(':scope > .blk-main .img-frame > img');
        if (img && img.dataset.src === b.src && img.getAttribute('src') !== assetURL(b.src)) img.src = assetURL(b.src);
      } else if (b.type === 'pdf') {
        const pages = el.querySelector(':scope > .blk-main .pdf-pages');
        if (pages && pages.dataset.v !== assetVersion(uuidFromLink(b.src))) this.rerender(b, { keepFocus: false });
      }
    }
  }

  // Welches Bild bzw. Arbeitsblatt ein Block ist – die Block-IDs gelten nur,
  // solange der Eintrag offen ist, deshalb Datei und laufende Nummer
  assetPosition(id) {
    const b = this.find(id);
    const uuid = b && uuidFromLink(b.src);
    if (!uuid) return null;
    const same = this.flat().filter(x => (x.type === 'image' || x.type === 'pdf') && uuidFromLink(x.src) === uuid);
    return { uuid, nth: Math.max(0, same.indexOf(b)) };
  }

  // Nach dem Zurückkommen (z. B. aus dem Bildeditor) das Bild wieder zeigen
  revealAsset({ uuid, nth = 0 } = {}) {
    const same = this.flat().filter(x => (x.type === 'image' || x.type === 'pdf') && uuidFromLink(x.src) === uuid);
    const b = same[Math.min(nth, same.length - 1)];
    const el = b && this.els.get(b.id);
    if (!el) return;
    // Hohe Blöcke (mehrseitige Arbeitsblätter) oben anfangen, sonst mittig
    const go = () => { if (this.els.get(b.id) === el) el.scrollIntoView({ block: el.offsetHeight > window.innerHeight * 0.8 ? 'start' : 'center' }); };
    go();
    this.selectBlocks([b]);
    // Bilder weiter oben laden womöglich noch und verschieben alles – danach noch einmal
    const pending = [...this.blocksEl.querySelectorAll('img')].filter(im => !im.complete);
    if (pending.length) {
      const loaded = Promise.all(pending.map(im => new Promise(r => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); })));
      Promise.race([loaded, new Promise(r => setTimeout(r, 1500))]).then(go);
    }
  }


  // -------------------------------------------------------------------------
  // Kopfbereich: Titel und Eigenschaften
  // -------------------------------------------------------------------------

  renderHeader() {
    const m = this.doc.meta;
    this.headerEl.innerHTML = '';
    if (!this.readonly) {
      const tools = h('div', { class: 'doc-header-tools' });
      if (!m.number) {
        const nb = h('button', { class: 'btn sm' }, icon('hash', 'sm'), 'Nummer');
        nb.addEventListener('click', () => this.editNumber());
        tools.append(nb);
      }
      if (!m.subject) {
        const sb = h('button', { class: 'btn sm' }, icon('cap', 'sm'), 'Fach');
        sb.addEventListener('click', () => this.chooseSubject(sb));
        tools.append(sb);
      }
      if (!m.date) {
        const db = h('button', { class: 'btn sm' }, icon('calendar', 'sm'), 'Datum');
        db.addEventListener('click', () => this.setMeta({ date: UI.todayISO() }));
        tools.append(db);
      }
      this.headerEl.append(tools);
    }
    const row = h('div', { class: 'doc-title-row' });
    const num = h('div', { class: 'doc-number', text: m.number || '' });
    if (!this.readonly && m.number) num.addEventListener('click', () => this.editNumber());
    const title = h('h1', { class: 'doc-title', contenteditable: this.readonly ? 'false' : 'true', spellcheck: 'true', 'data-ph': 'Unbenannt' });
    title.textContent = m.title || '';
    this.titleEl = title;
    row.append(num, title);
    this.headerEl.append(row);
    if (!this.readonly) this.attachTitle(title);

    const props = h('div', { class: 'doc-props' });
    if (m.subject) {
      const sc = subjectColor(this.settings, m.subject);
      const p = h('button', { class: 'prop subject' + (sc ? ' colored' : ''), 'data-c': sc || null }, h('span', { html: icon('cap', 'sm') }), h('span', { class: 'v', text: m.subject }));
      if (!this.readonly) p.addEventListener('click', () => this.chooseSubject(p));
      props.append(p);
      // Thema und Unterthemen, in denen der Eintrag liegt
      const topics = (!this.readonly && this.host.topicNames && this.host.topicNames()) || [];
      if (this.host.fileEntry && !this.readonly) {
        const t = h('button', { class: 'prop topic' }, h('span', { html: icon('folder', 'sm') }),
          h('span', { class: 'v' + (topics.length ? '' : ' empty'), text: topics.length ? topics.join(' › ') : 'Thema wählen' }));
        t.addEventListener('click', () => this.host.fileEntry());
        props.append(t);
      }
    }
    if (m.date) {
      const p = h('button', { class: 'prop' }, h('span', { html: icon('calendar', 'sm') }), h('span', { class: 'v', text: UI.formatDate(m.date) }));
      if (!this.readonly) p.addEventListener('click', () => this.dateMenu(p));
      props.append(p);
    }
    const tags = m.tags || [];
    if (tags.length || !this.readonly) {
      const p = h('div', { class: 'prop' }, h('span', { html: icon('tag', 'sm') }));
      tags.forEach((t, i) => {
        const chip = h('span', { class: 'tag-chip', 'data-c': tagColor(t), text: t });
        if (!this.readonly) chip.addEventListener('click', (e) => {
          e.stopPropagation();
          UI.menu(chip, [{ label: `„${t}“ entfernen`, icon: 'x', onSelect: () => this.setMeta({ tags: tags.filter((_, k) => k !== i) }) }]);
        });
        p.append(chip);
      });
      if (!this.readonly) {
        const add = h('span', { class: 'v empty', text: tags.length ? '+' : 'Schlagwort hinzufügen' });
        p.append(add);
        p.addEventListener('click', () => this.addTag(p));
      }
      if (tags.length || !this.readonly) props.append(p);
    }
    if (props.childNodes.length) this.headerEl.append(props);
  }

  attachTitle(title) {
    title.addEventListener('input', () => {
      const v = title.textContent.replace(/\n/g, ' ');
      if (!title.textContent) title.innerHTML = '';
      this.titleTyping();
      this.doc.meta.title = v;
      this.onTitleChange(v);
      this.changed({ soft: true });
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = this.doc.blocks[0];
        if (first && this.isText(first) && isEmptyHTML(this.currentHTML(first))) this.focusBlock(first, 'start');
        else { this.checkpoint(); const nb = block('p'); this.doc.blocks.unshift(nb); this.renderAll(); this.focusBlock(nb, 'start'); this.changed(); }
      } else if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && caret.getSelectionIn(title)?.start === title.textContent.length)) {
        const first = this.flat()[0];
        if (first) { e.preventDefault(); this.focusBlock(first, 'start'); }
      }
    });
    title.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
      document.execCommand('insertText', false, text);
    });
  }

  titleTyping() {
    if (Date.now() - this.lastTypingCP > 1200 || this.lastTypingId !== '__title') this.checkpoint();
    this.lastTypingCP = Date.now();
    this.lastTypingId = '__title';
  }

  async editNumber() {
    const v = await UI.promptDialog('Nummer des Eintrags', this.doc.meta.number || '', {
      placeholder: 'z. B. 1.1', description: 'Erscheint vor dem Titel und im Namen in DEVONthink (z. B. „1.1 Quadratwurzeln“).'
    });
    if (v === null) return;
    this.setMeta({ number: v.trim() || undefined });
    this.onTitleChange(this.doc.meta.title || '');
  }

  // Fach wählen: in der App mit Ablage in Fach und Thema, sonst nur als Eigenschaft
  chooseSubject(anchor) {
    if (this.host.fileEntry) this.host.fileEntry();
    else this.subjectMenu(anchor);
  }

  subjectMenu(anchor) {
    const subjects = this.settings.subjects || ['Mathe', 'Deutsch', 'Englisch', 'Latein', 'Französisch', 'Physik', 'Chemie', 'Biologie', 'Geschichte', 'Geographie', 'Ethik', 'Religion', 'Informatik', 'Wirtschaft', 'Sozialkunde', 'Kunst', 'Musik', 'Sport'];
    UI.menu(anchor, [
      { section: 'Fach' },
      ...subjects.map(s => ({ label: s, html: colorDot(subjectColor(this.settings, s)), checked: this.doc.meta.subject === s, onSelect: () => this.setMeta({ subject: s }) })),
      '-',
      { label: 'Anderes …', icon: 'pencil', onSelect: async () => { const v = await UI.promptDialog('Fach', this.doc.meta.subject || ''); if (v !== null) this.setMeta({ subject: v.trim() || undefined }); } },
      { label: 'Fächer und Farben einstellen …', icon: 'palette', onSelect: () => this.host.openSettings && this.host.openSettings('subjects') },
      this.doc.meta.subject ? { label: 'Entfernen', icon: 'x', danger: true, onSelect: () => this.setMeta({ subject: undefined }) } : null
    ]);
  }

  dateMenu(anchor) {
    const initial = this.doc.meta.date;
    const input = h('input', { class: 'input', type: 'date', value: initial || UI.todayISO() });
    let done = false;
    // Safari meldet "change" erst beim Verlassen des Feldes – das Popover ist
    // dann schon zu. Deshalb beim Schließen (und mit Enter) übernehmen.
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v !== initial) this.setMeta({ date: v });
    };
    const box = h('div', { style: { padding: '6px', width: '220px' } }, input,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm outline', onclick: () => { done = true; this.setMeta({ date: UI.todayISO() }); pop.close(); } }, 'Heute'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm danger', onclick: () => { done = true; this.setMeta({ date: undefined }); pop.close(); } }, 'Entfernen')));
    const pop = UI.popover(anchor, box, { onClose: commit });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pop.close(); } });
    setTimeout(() => input.focus(), 30);
  }

  addTag(anchor) {
    const input = h('input', { class: 'input', placeholder: 'Schlagwort …' });
    const pop = UI.popover(anchor, h('div', { style: { padding: '4px', width: '240px' } }, input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim().replace(/,/g, ' ');
        if (v) this.setMeta({ tags: [...(this.doc.meta.tags || []).filter(t => t !== v), v] });
        pop.close();
      }
    });
    setTimeout(() => input.focus(), 30);
  }

  // -------------------------------------------------------------------------
  // Fokus und Auswahl
  // -------------------------------------------------------------------------

  focusBlock(b, where = 'end') {
    if (!b) return;
    this.clearBlockSelection();
    const el = this.elOf(b);
    if (!el) return;
    if (this.isText(b)) {
      const t = this.textElOf(b);
      caret.placeCaret(t, where);
      this.ensureVisible(t);
    } else if (ATOMS[b.type] && ATOMS[b.type].focus) {
      ATOMS[b.type].focus(this, b, el.querySelector(':scope > .blk-main'), where);
    } else if (ATOMS[b.type] && ATOMS[b.type].activate) {
      this.activate(b);
    } else this.selectBlocks([b]);
  }

  ensureVisible(el) {
    const r = (el.nodeType === 1 ? el : el.parentElement).getBoundingClientRect();
    const scroller = this.root.closest('.view') || document.scrollingElement;
    const sr = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    if (r.bottom > sr.bottom - 40) scroller.scrollTop += r.bottom - sr.bottom + 80;
    else if (r.top < sr.top + 50) scroller.scrollTop -= sr.top + 50 - r.top;
  }

  setFocusBlock(b) {
    this.focusId = b ? b.id : null;
  }

  captureSelection() {
    if (this.selected.size) return { type: 'blocks', ids: [...this.selected] };
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const node = sel.anchorNode;
    if (this.titleEl && this.titleEl.contains(node)) {
      const s = caret.getSelectionIn(this.titleEl);
      return { type: 'title', start: s ? s.start : 0 };
    }
    const t = node && (node.nodeType === 1 ? node : node.parentElement)?.closest('.blk-text');
    if (!t || !this.docEl.contains(t)) return null;
    const b = this.blockOfEl(t);
    const s = caret.getSelectionIn(t);
    return b && s ? { type: 'text', id: b.id, start: s.start, end: s.end } : null;
  }

  restoreSelection(sel) {
    if (!sel) return;
    if (sel.type === 'blocks') { this.selectBlocks(sel.ids.map(id => this.find(id)).filter(Boolean)); return; }
    if (sel.type === 'title') { caret.placeCaret(this.titleEl, sel.start); return; }
    const b = this.find(sel.id);
    const t = b && this.textElOf(b);
    if (!t) return;
    t.focus({ preventScroll: true });
    caret.setSelectionIn(t, sel.start, sel.end);
  }

  selectBlocks(blocks, { anchor } = {}) {
    this.deactivate();
    this.clearBlockSelection();
    blocks = blocks.filter(Boolean);
    if (!blocks.length) return;
    for (const b of blocks) {
      this.selected.add(b.id);
      const el = this.elOf(b);
      if (el) el.classList.add('selected', 'whole');
    }
    this.selAnchor = anchor || blocks[0].id;
    this.selHead = blocks[blocks.length - 1].id;
    this.docEl.classList.add('block-sel');
    this.docEl.focus({ preventScroll: true });
    // Unsichtbare Textauswahl über die Blöcke legen, damit ⌘C/⌘X im
    // WebView überhaupt ein copy-Ereignis auslösen.
    const first = this.elOf(blocks[0]), last = this.elOf(blocks[blocks.length - 1]);
    if (first && last) {
      const r = document.createRange();
      r.setStartBefore(first);
      r.setEndAfter(last);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    this.format && this.format.hide();
  }

  clearBlockSelection() {
    if (!this.selected.size) return;
    for (const id of this.selected) this.els.get(id)?.classList.remove('selected', 'whole');
    this.selected.clear();
    this.docEl.classList.remove('block-sel');
  }

  selectedBlocks() {
    // In Dokumentreihenfolge, ohne Blöcke, deren Eltern schon ausgewählt sind
    const all = [];
    const walk = (list, parentSelected) => {
      for (const b of list) {
        const sel = this.selected.has(b.id);
        if (sel && !parentSelected) all.push(b);
        walk(b.children || [], parentSelected || sel);
      }
    };
    walk(this.doc.blocks, false);
    return all;
  }

  // Auswahl von anchor bis head (gleiche Ebene bevorzugt)
  selectRange(a, b) {
    const f = this.flat();
    let i = f.indexOf(a), j = f.indexOf(b);
    if (i < 0 || j < 0) return;
    if (i > j) [i, j] = [j, i];
    this.selectBlocks(f.slice(i, j + 1), { anchor: a.id });
    this.selHead = b.id;
  }

  // -------------------------------------------------------------------------
  // Atom-Blöcke bearbeiten
  // -------------------------------------------------------------------------

  activate(b) {
    if (this.readonly) return;
    const def = ATOMS[b.type];
    if (!def || !def.activate) { this.selectBlocks([b]); return; }
    if (this.activeAtom === b) return;
    this.deactivate();
    this.clearBlockSelection();
    this.checkpoint();
    this.activeAtom = b;
    const el = this.elOf(b);
    el.classList.add('editing');
    const main = el.querySelector(':scope > .blk-main');
    def.activate(this, b, main);
    this.pencilPad();
    this.format && this.format.hide();
  }

  // iPad mit Pencil: eigenes Schreibfeld unter Formel, Reaktionsgleichung, Graph und Strukturformel
  pencilPad() {
    const b = this.activeAtom;
    if (!b || !isPad || !pencilKnown() || this.settings.pencilPad === false || !PENCIL_TYPES.has(b.type)) return;
    const main = this.elOf(b)?.querySelector(':scope > .blk-main');
    if (main) attachPencilPad(this, b, main);
  }

  deactivate({ select = false } = {}) {
    const b = this.activeAtom;
    if (!b) return;
    this.activeAtom = null;
    const el = this.elOf(b);
    // Erst das Formelfeld verlassen (schließt offene Eingaben wie ´ oder
    // Handschrift ab), dann neu zeichnen – sonst stolpert MathLive über das
    // schon entfernte Feld
    const focused = el && el.contains(document.activeElement) ? document.activeElement : null;
    if (focused && focused.blur) focused.blur();
    if (el) {
      el.classList.remove('editing');
      const main = el.querySelector(':scope > .blk-main');
      ATOMS[b.type].render(this, b, main, el);
    }
    this.afterStructure();
    this.changed();
    if (select) this.selectBlocks([b]);
  }

  exitAtom(b, dir) {
    this.deactivate();
    if (dir === 'before') {
      const prev = this.prevVisible(b);
      if (prev) this.focusBlock(prev, 'end');
      else { this.checkpoint(); const nb = block('p'); this.insertBefore(b, [nb]); this.focusBlock(nb); }
      return;
    }
    const next = this.nextVisible(b);
    if (next && this.isText(next) && isEmptyHTML(this.currentHTML(next))) { this.focusBlock(next, 'start'); return; }
    this.checkpoint();
    const nb = block('p');
    this.insertAfter(b, [nb]);
    this.focusBlock(nb, 'start');
    this.changed();
  }

  removeAtomAndFocusPrev(b) {
    this.checkpoint();
    const prev = this.prevVisible(b);
    this.activeAtom = null;
    this.removeBlocks([b]);
    if (prev) this.focusBlock(prev, 'end');
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Strukturelle Änderungen
  // -------------------------------------------------------------------------

  childrenContainer(b) {
    const el = this.elOf(b);
    return el ? el.querySelector(':scope > .blk-children') : null;
  }

  insertAfter(ref, blocks) {
    const sibs = this.siblingsOf(ref);
    sibs.splice(sibs.indexOf(ref) + 1, 0, ...blocks);
    let anchor = this.elOf(ref);
    for (const nb of blocks) { const el = this.renderBlock(nb); anchor.after(el); anchor = el; }
    this.reindex();
    this.afterStructure();
  }

  insertBefore(ref, blocks) {
    const sibs = this.siblingsOf(ref);
    sibs.splice(sibs.indexOf(ref), 0, ...blocks);
    const refEl = this.elOf(ref);
    for (const nb of blocks) refEl.before(this.renderBlock(nb));
    this.reindex();
    this.afterStructure();
  }

  insertChildAt(parent, index, blocks) {
    parent.children.splice(index, 0, ...blocks);
    const box = this.childrenContainer(parent);
    if (!box) { this.rerender(parent, { keepFocus: false }); return; }
    box.querySelector(':scope > .toggle-empty')?.remove();
    const ref = box.children[index] || null;
    for (const nb of blocks) box.insertBefore(this.renderBlock(nb), ref);
    this.reindex();
    this.afterStructure();
  }

  appendTop(blocks) {
    this.doc.blocks.push(...blocks);
    for (const nb of blocks) this.blocksEl.append(this.renderBlock(nb));
    this.reindex();
    this.afterStructure();
  }

  removeBlocks(blocks) {
    this.syncAll();
    for (const b of blocks) {
      const sibs = this.siblingsOf(b);
      const i = sibs.indexOf(b);
      if (i >= 0) sibs.splice(i, 1);
      this.elOf(b)?.remove();
      this.dirtyText.delete(b.id);
      if (this.activeAtom === b) this.activeAtom = null;
    }
    this.reindex();
    this.normalizeTree();
  }

  // Leere Spalten auflösen, leeres Dokument mit einem Absatz füllen.
  normalizeTree() {
    let changed = false;
    const fix = (list) => {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.type === 'columns') {
          b.children = b.children.filter(col => col.children.length);
          if (b.children.length <= 1) {
            const inner = b.children[0] ? b.children[0].children : [];
            list.splice(i, 1, ...inner);
            changed = true;
            i--;
            continue;
          }
          for (const col of b.children) fix(col.children);
        } else if (b.children) fix(b.children);
      }
    };
    fix(this.doc.blocks);
    if (!this.doc.blocks.length) { this.doc.blocks.push(block('p')); changed = true; }
    if (changed) this.renderAll();
    else { this.reindex(); this.afterStructure(); }
  }

  // -------------------------------------------------------------------------
  // Nebeneinander (Spalten)
  // -------------------------------------------------------------------------

  columnRowOf(b) {
    let x = b;
    while (x) { if (x.type === 'columns') return x; x = this.parentOf(x); }
    return null;
  }

  columnMenuItems(row) {
    return [
      { label: 'Spaltenbreiten …', icon: 'columns', onSelect: () => atoms.columnWidthsDialog(this, row) },
      { label: 'Alle gleich breit', icon: 'alignJustify', disabled: !row.children.some(c => c.width), onSelect: () => { this.checkpoint(); for (const c of row.children) delete c.width; this.rerender(row); this.changed(); } },
      { label: 'Spalte hinzufügen', icon: 'plus', onSelect: () => { this.checkpoint(); row.children.push(block('column', { children: [block('p')] })); this.rerender(row); this.changed(); } },
      '-',
      { label: 'Untereinander anordnen', icon: 'list', onSelect: () => this.stackColumns(row) }
    ];
  }

  // Markierte Blöcke (auf derselben Ebene) nebeneinander stellen – jeder in eine Spalte
  arrangeSideBySide(blocks) {
    const parent = this.parentOf(blocks[0]);
    if (blocks.some(x => this.parentOf(x) !== parent || x.type === 'columns' || x.type === 'column')) {
      UI.toast('Nur Blöcke direkt untereinander auf derselben Ebene lassen sich nebeneinander anordnen.', { type: 'error' });
      return;
    }
    this.checkpoint();
    this.syncAll();
    const sibs = this.siblingsOf(blocks[0]);
    const sorted = blocks.slice().sort((x, y) => sibs.indexOf(x) - sibs.indexOf(y));
    const at = sibs.indexOf(sorted[0]);
    for (const x of sorted) sibs.splice(sibs.indexOf(x), 1);
    const row = block('columns', { children: sorted.map(x => block('column', { children: [x] })) });
    sibs.splice(at, 0, row);
    this.normalizeTree();
    this.renderAll();
    this.changed();
  }

  // Spalten auflösen: alles wieder untereinander
  stackColumns(row) {
    this.checkpoint();
    this.syncAll();
    const sibs = this.siblingsOf(row);
    sibs.splice(sibs.indexOf(row), 1, ...row.children.flatMap(c => c.children));
    this.normalizeTree();
    this.renderAll();
    this.changed();
  }

  // Blöcke verschieben: pos = 'before' | 'after' | 'child' | 'col-left' | 'col-right'
  moveBlocks(blocks, target, pos) {
    if (!blocks.length || blocks.includes(target)) return;
    // Nicht in eigene Nachkommen schieben
    for (const b of blocks) { let p = target; while (p) { if (p === b) return; p = this.parentOf(p); } }
    this.checkpoint();
    this.syncAll();
    for (const b of blocks) { const s = this.siblingsOf(b); s.splice(s.indexOf(b), 1); }
    this.reindex();
    if (pos === 'child') target.children.push(...blocks);
    else if (pos === 'col-left' || pos === 'col-right') {
      const parent = this.parentOf(target);
      if (parent && parent.type === 'column') {
        // In bestehende Spaltenreihe neue Spalte einfügen
        const row = this.parentOf(parent);
        const col = block('column', { children: blocks });
        const ci = row.children.indexOf(parent);
        row.children.splice(pos === 'col-left' ? ci : ci + 1, 0, col);
      } else {
        const sibs = this.siblingsOf(target);
        const i = sibs.indexOf(target);
        const a = block('column', { children: [target] });
        const bcol = block('column', { children: blocks });
        const row = block('columns', { children: pos === 'col-left' ? [bcol, a] : [a, bcol] });
        sibs.splice(i, 1, row);
      }
    } else {
      const sibs = this.siblingsOf(target);
      const i = sibs.indexOf(target);
      sibs.splice(pos === 'before' ? i : i + 1, 0, ...blocks);
    }
    this.normalizeTree();
    this.renderAll();
    this.selectBlocks(blocks);
    this.changed();
  }

  setType(b, type, props = {}) {
    this.checkpoint();
    this.syncAll();
    const sel = this.captureSelection();
    const wasText = this.isText(b);
    if (wasText && ATOMS[type]) {
      // Text → Atom: Text bleibt als eigener Absatz erhalten, falls vorhanden
      const html = b.html;
      const nb = block(type, props);
      if (!isEmptyHTML(html)) {
        this.insertAfter(b, [nb]);
      } else {
        const sibs = this.siblingsOf(b);
        nb.children = b.children;
        sibs.splice(sibs.indexOf(b), 1, nb);
        this.elOf(b).replaceWith(this.renderBlock(nb));
        this.reindex();
        this.afterStructure();
      }
      this.changed();
      if (ATOMS[type].activate) this.activate(nb); else if (ATOMS[type].focus) this.focusBlock(nb, 'start'); else {
        const next = this.nextVisible(nb);
        if (!next) { const p = block('p'); this.insertAfter(nb, [p]); this.focusBlock(p); } else this.selectBlocks([nb]);
      }
      return nb;
    }
    b.type = type;
    for (const k of ['checked', 'kind', 'open', 'start']) if (!(k in props)) delete b[k];
    Object.assign(b, props);
    if (!this.isText(b)) b.html = undefined;
    if (this.isText(b) && b.html === undefined) b.html = '';
    this.rerender(b, { keepFocus: false });
    if (sel && sel.type === 'text' && sel.id === b.id) this.restoreSelection(sel);
    else if (this.isText(b)) this.focusBlock(b, 'end');
    this.changed();
    return b;
  }

  toggleChecked(b) {
    this.checkpoint();
    b.checked = !b.checked;
    this.applyBlockAttrs(b, this.elOf(b));
    this.changed();
  }

  toggleOpen(b) {
    this.checkpoint();
    this.syncAll();
    b.open = !b.open;
    this.rerender(b);
    this.changed();
  }

  indent(blocks) {
    blocks = blocks.filter(b => this.indexOf(b) > 0);
    if (!blocks.length) return false;
    const first = blocks[0];
    const prev = this.siblingsOf(first)[this.indexOf(first) - 1];
    if (!prev || NO_CHILDREN.has(prev.type) || blocks.some(b => this.parentOf(b) !== this.parentOf(first))) return false;
    this.checkpoint();
    this.syncAll();
    const sel = this.captureSelection();
    const sibs = this.siblingsOf(first);
    for (const b of blocks) sibs.splice(sibs.indexOf(b), 1);
    prev.children.push(...blocks);
    if (prev.type === 'toggle') prev.open = true;
    this.renderAll();
    this.restoreSelection(sel);
    this.changed();
    return true;
  }

  outdent(blocks) {
    const first = blocks[0];
    const parent = first && this.parentOf(first);
    if (!parent || parent.type === 'column' || blocks.some(b => this.parentOf(b) !== parent)) return false;
    this.checkpoint();
    this.syncAll();
    const sel = this.captureSelection();
    const sibs = parent.children;
    for (const b of blocks) sibs.splice(sibs.indexOf(b), 1);
    const outer = this.siblingsOf(parent);
    outer.splice(outer.indexOf(parent) + 1, 0, ...blocks);
    this.renderAll();
    this.restoreSelection(sel);
    this.changed();
    return true;
  }

  moveUpDown(blocks, dir) {
    const first = blocks[0], last = blocks[blocks.length - 1];
    const sibs = this.siblingsOf(first);
    const i = sibs.indexOf(first), j = sibs.indexOf(last);
    if (dir < 0 && i === 0 || dir > 0 && j === sibs.length - 1) return;
    this.checkpoint();
    this.syncAll();
    const sel = this.captureSelection();
    const moved = sibs.splice(i, j - i + 1);
    sibs.splice(i + dir, 0, ...moved);
    this.renderAll();
    this.restoreSelection(sel);
    this.changed();
  }

  duplicate(blocks) {
    this.checkpoint();
    this.syncAll();
    const copies = blocks.map(b => cloneWithIds(b));
    this.insertAfter(blocks[blocks.length - 1], copies);
    this.selectBlocks(copies);
    this.changed();
  }

  deleteBlocks(blocks) {
    if (!blocks.length) return;
    this.checkpoint();
    const prev = this.prevVisible(blocks[0]);
    const next = this.nextVisible(blocks[blocks.length - 1]);
    this.removeBlocks(blocks);
    this.clearBlockSelection();
    const target = prev && this.byId.has(prev.id) ? prev : next && this.byId.has(next.id) ? next : this.flat()[0];
    if (target) {
      if (this.isText(target)) this.focusBlock(target, prev === target ? 'end' : 'start');
      else this.selectBlocks([target]);
    }
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Text-Inhalt
  // -------------------------------------------------------------------------

  syncBlock(b) {
    if (!this.dirtyText.has(b.id)) return;
    const t = this.textElOf(b);
    if (t) b.html = normalizeHTML(t.innerHTML);
    this.dirtyText.delete(b.id);
  }

  syncAll() {
    for (const id of [...this.dirtyText]) {
      const b = this.find(id);
      if (b) this.syncBlock(b); else this.dirtyText.delete(id);
    }
  }

  // Inhalt eines Textelements neu setzen und Auswahl erhalten
  setTextHTML(b, html, sel) {
    const t = this.textElOf(b);
    b.html = html;
    this.dirtyText.delete(b.id);
    if (!t) return;
    t.innerHTML = html;
    this.hydrateInline(t);
    if (sel) { t.focus({ preventScroll: true }); caret.setSelectionIn(t, sel.start, sel.end ?? sel.start); }
    this.renumberFootnotes();
  }

  // Auszeichnung auf die aktuelle Auswahl anwenden (⌘B usw.)
  toggleMark(key, value = true, el) {
    el = el || this.activeInlineEl();
    if (!el) return;
    const sel = caret.getSelectionIn(el);
    if (!sel || sel.collapsed) return;
    this.checkpoint();
    const segs = htmlToSegs(el.innerHTML);
    let v = value;
    if (value === true && markActive(segs, sel.start, sel.end, key)) v = false;
    const out = applyMark(segs, sel.start, sel.end, key, v);
    this.replaceInline(el, segsToHTML(out), sel);
    this.format && this.format.update();
  }

  setMarkValue(key, value, el) {
    el = el || this.activeInlineEl();
    if (!el) return;
    const sel = caret.getSelectionIn(el);
    if (!sel || sel.collapsed) return;
    this.checkpoint();
    const out = applyMark(htmlToSegs(el.innerHTML), sel.start, sel.end, key, value || false);
    this.replaceInline(el, segsToHTML(out), sel);
    this.format && this.format.update();
  }

  // Inhalt eines beliebigen Inline-Felds (Block-Text, Tabellenzelle, Beschriftung) ersetzen
  replaceInline(el, html, sel) {
    el.innerHTML = html;
    this.hydrateInline(el);
    el.focus({ preventScroll: true });
    if (sel) caret.setSelectionIn(el, sel.start, sel.end);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  activeInlineEl() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('.blk-text, .cell, .caption');
    return el && this.docEl.contains(el) ? el : null;
  }

  // -------------------------------------------------------------------------
  // Verlauf (Rückgängig / Wiederholen)
  // -------------------------------------------------------------------------

  snapshot() {
    this.syncAll();
    return {
      blocks: JSON.stringify(this.doc.blocks, (k, v) => (k.startsWith('_') ? undefined : v)),
      meta: JSON.stringify(this.doc.meta),
      sel: this.captureSelection()
    };
  }

  checkpoint() {
    if (this.restoring || this.readonly) return;
    const s = this.snapshot();
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && last.blocks === s.blocks && last.meta === s.meta) return;
    this.undoStack.push(s);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  typingCheckpoint(id) {
    if (Date.now() - this.lastTypingCP > 1500 || this.lastTypingId !== id) this.checkpoint();
    this.lastTypingCP = Date.now();
    this.lastTypingId = id;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.deactivate();
    const cur = this.snapshot();
    let s = this.undoStack.pop();
    // Zustände überspringen, die sich nicht vom aktuellen unterscheiden
    while (s && s.blocks === cur.blocks && s.meta === cur.meta && this.undoStack.length) s = this.undoStack.pop();
    this.redoStack.push(cur);
    this.restore(s);
  }

  redo() {
    if (!this.redoStack.length) return;
    this.deactivate();
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  restore(s) {
    if (!s) return;
    this.restoring = true;
    const oldTitle = this.doc.meta.title;
    this.doc.blocks = JSON.parse(s.blocks);
    this.doc.meta = JSON.parse(s.meta);
    this.dirtyText.clear();
    this.clearBlockSelection();
    this.applyMeta();
    this.renderHeader();
    this.renderAll();
    this.restoreSelection(s.sel);
    this.restoring = false;
    this.lastTypingCP = 0;
    if (oldTitle !== this.doc.meta.title) this.onTitleChange(this.doc.meta.title || '');
    this.changed();
  }

  changed() {
    if (this.readonly) return;
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // Ereignisse
  // -------------------------------------------------------------------------

  attachEvents() {
    const d = this.docEl;
    d.addEventListener('contextmenu', (e) => {
      const am = e.target.closest && e.target.closest('.blk-text .am');
      if (!am || this.readonly) return;
      e.preventDefault();
      this.alignMarkMenu(am, new DOMRect(e.clientX, e.clientY, 0, 0));
    });
    window.addEventListener('resize', () => {
      this.alignSoon();
      // Tabellen mit festen/anteiligen Breiten neu berechnen
      clearTimeout(this._tblT);
      this._tblT = setTimeout(() => { for (const w of this.blocksEl.querySelectorAll('.table-wrap')) w._layout && w._layout(); }, 60);
    });
    d.addEventListener('keydown', (e) => this.onKeyDown(e));
    d.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    d.addEventListener('input', (e) => this.onInput(e));
    d.addEventListener('focusin', (e) => {
      const t = e.target.closest && e.target.closest('.blk-text');
      if (t) {
        const b = this.blockOfEl(t);
        this.focusId = b && b.id;
        this.elOf(b)?.classList.add('focused');
        this.clearBlockSelection();
        if (this.activeAtom && !this.elOf(this.activeAtom)?.contains(t)) this.deactivate();
      }
    });
    d.addEventListener('focusout', (e) => {
      const t = e.target.closest && e.target.closest('.blk-text');
      if (t) this.blockOfEl(t) && this.elOf(this.blockOfEl(t))?.classList.remove('focused');
    });
    d.addEventListener('compositionstart', () => { this.composing = true; });
    d.addEventListener('compositionend', () => { this.composing = false; });
    d.addEventListener('mousedown', (e) => this.onMouseDown(e));
    d.addEventListener('click', (e) => this.onClick(e));
    const outside = (e) => {
      if (!this.activeAtom) return;
      const el = this.elOf(this.activeAtom);
      if (el && !el.contains(e.target) && !e.target.closest('.popover, .overlay, .tooltip, .math-kbd, .math-kbd-show')) this.deactivate();
    };
    document.addEventListener('mousedown', outside, true);
    const selKey = (e) => this.onDocumentKey(e);
    document.addEventListener('keydown', selKey);
    // Pencil erst jetzt erkannt: geöffneter Block bekommt das Schreibfeld nachträglich
    const pencil = () => this.pencilPad();
    document.addEventListener('heft-pencil', pencil);
    this._unbind = () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', selKey);
      document.removeEventListener('heft-pencil', pencil);
    };
    this.endEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const last = this.doc.blocks[this.doc.blocks.length - 1];
      if (last && last.type === 'p' && isEmptyHTML(this.currentHTML(last)) && !last.children.length) this.focusBlock(last, 'end');
      else { this.checkpoint(); const nb = block('p'); this.appendTop([nb]); this.focusBlock(nb); this.changed(); }
    });
  }

  onMouseDown(e) {
    const t = e.target;
    // Klick auf die Nummer einer Überschrift oder eines Listenpunkts → Nummer anpassen
    if (!this.readonly && e.button === 0) {
      const ht = t.closest && t.closest('.blk[data-type^="h"] > .blk-main > .blk-text[data-num]');
      const mk = t.closest && t.closest('.blk[data-type="ol"] > .blk-main > .blk-marker');
      const target = ht && this.hitHeadingNumber(ht, e) ? ht : mk;
      if (target) {
        const b = this.blockOfEl(target);
        if (b) {
          e.preventDefault();
          UI.menu(new DOMRect(e.clientX, e.clientY, 0, 0), [{ section: /^h/.test(b.type) ? 'Nummer der Überschrift' : 'Nummer des Listenpunkts' }, ...this.numberMenuItems(b)]);
          return;
        }
      }
    }
    if (t.closest('.im') && !t.closest('.popover')) {
      const span = t.closest('.im');
      e.preventDefault();
      openInlineMath(this, span);
      return;
    }
    if (t.closest('.fn')) {
      e.preventDefault();
      openFootnote(this, t.closest('.fn'));
      return;
    }
    if (this.selected.size && !t.closest('.blk-handle') && !e.shiftKey) this.clearBlockSelection();
    if (e.shiftKey && this.selected.size) {
      const b = this.blockOfEl(t);
      if (b) { e.preventDefault(); this.selectRange(this.find(this.selAnchor), b); }
    }
  }

  onClick(e) {
    const a = e.target.closest('a[href]');
    if (a && this.docEl.contains(a) && (e.metaKey || !a.closest('[contenteditable="true"]') || this.readonly)) {
      e.preventDefault();
      this.host.openLink && this.host.openLink(a.getAttribute('href'));
      return;
    }
    const ref = e.target.closest('.ref');
    if (ref) { const id = ref.dataset.target; this.scrollToBlock(id); }
  }

  onDocumentKey(e) {
    // Tasten, während Blöcke ausgewählt sind (Fokus liegt dann auf .doc)
    if (!this.selected.size || document.activeElement !== this.docEl) return;
    if (document.querySelector('.overlay')) return;
    const blocks = this.selectedBlocks();
    const m = UI.mod(e);
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); this.clearBlockSelection(); window.getSelection().removeAllRanges(); return; }
    if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); this.deleteBlocks(blocks); return; }
    if (k === 'Enter') {
      e.preventDefault();
      const b = blocks[0];
      if (this.isText(b)) this.focusBlock(b, 'end');
      else if (ATOMS[b.type]?.activate) this.activate(b);
      else if (ATOMS[b.type]?.focus) this.focusBlock(b, 'start');
      return;
    }
    if (k === 'Tab') { e.preventDefault(); if (e.shiftKey) this.outdent(blocks); else this.indent(blocks); this.selectBlocks(blocks); return; }
    if (m && k.toLowerCase() === 'd') { e.preventDefault(); this.duplicate(blocks); return; }
    if (m && e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); this.moveUpDown(blocks, k === 'ArrowUp' ? -1 : 1); this.selectBlocks(blocks); return; }
    if (m && k.toLowerCase() === 'a') { e.preventDefault(); this.selectBlocks(this.doc.blocks); return; }
    if (m && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      const f = this.flat();
      const head = this.find(this.selHead) || blocks[0];
      let i = f.indexOf(head) + (k === 'ArrowUp' ? -1 : 1);
      i = Math.max(0, Math.min(f.length - 1, i));
      if (e.shiftKey) this.selectRange(this.find(this.selAnchor) || head, f[i]);
      else this.selectBlocks([f[i]]);
      this.elOf(f[i])?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (m && e.altKey && /^Digit\d$/.test(e.code)) { this.shortcutTurnInto(e, blocks); return; }
  }

  shortcutTurnInto(e, blocks) {
    const map = { Digit0: 'p', Digit1: 'h1', Digit2: 'h2', Digit3: 'h3', Digit4: 'todo', Digit5: 'ul', Digit6: 'ol', Digit7: 'toggle', Digit8: 'code', Digit9: 'math' };
    const type = map[e.code];
    if (!type) return false;
    e.preventDefault();
    for (const b of blocks) if (this.isText(b) || type === 'code' || type === 'math') this.setType(b, type);
    return true;
  }

  onBeforeInput(e) {
    if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); return; }
    if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); return; }
    const t = e.target.closest && e.target.closest('.blk-text');
    if (!t) return;
    const b = this.blockOfEl(t);
    if (!b) return;
    if (e.inputType.startsWith('insert') || e.inputType.startsWith('delete')) this.typingCheckpoint(b.id);
    // Zeilenumbruch per Enter übernimmt onKeyDown; alles andere darf WebKit.
    if (e.inputType === 'insertParagraph') e.preventDefault();
    if (e.inputType === 'formatBold') { e.preventDefault(); this.toggleMark('b'); }
    if (e.inputType === 'formatItalic') { e.preventDefault(); this.toggleMark('i'); }
    if (e.inputType === 'formatUnderline') { e.preventDefault(); this.toggleMark('u'); }
  }

  onInput(e) {
    const t = e.target.closest && e.target.closest('.blk-text');
    if (t) {
      const b = this.blockOfEl(t);
      if (!b) return;
      if (!caret.textLength(t) && t.innerHTML && !t.querySelector('.im, .fn')) t.innerHTML = '';
      this.dirtyText.add(b.id);
      if (!this.composing) runInputRules(this, b, t, e);
      this.slash && this.slash.onInput(b, t, e);
      if (/^h[123]$/.test(b.type)) this.afterHeadingEdit();
      this.changed();
      this.alignSoon();
      return;
    }
    const inl = e.target.closest && e.target.closest('.cell, .caption');
    if (inl && !this.composing && e.inputType) runInputRules(this, null, inl, e);
  }

  afterHeadingEdit() {
    clearTimeout(this._tocT);
    this._tocT = setTimeout(() => {
      for (const b of this.byId.values()) if (b.type === 'toc') { const el = this.elOf(b); if (el) atoms.toc.render(this, b, el.querySelector(':scope > .blk-main')); }
    }, 300);
  }

  onKeyDown(e) {
    if (e.defaultPrevented) return;
    const t = e.target.closest && e.target.closest('.blk-text');
    const m = UI.mod(e);
    // Globale Editor-Kürzel
    // Im Formelfeld und in Eingabefeldern gilt deren eigenes Widerrufen
    if (m && !e.altKey && e.key.toLowerCase() === 'z' && !(e.target.closest && e.target.closest('math-field, input, textarea'))) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (this.slash && this.slash.isOpen() && this.slash.onKey(e)) return;
    const inl = e.target.closest && e.target.closest('.blk-text, .cell, .caption');
    if (inl && m && this.formatShortcut(e, inl)) return;
    if (!t) return;
    const b = this.blockOfEl(t);
    if (!b) return;
    if (m && e.altKey && /^Digit\d$/.test(e.code)) { this.syncAll(); if (this.shortcutTurnInto(e, [b])) return; }
    switch (e.key) {
      case 'Enter': return this.onEnter(e, b, t);
      case 'Backspace': return this.onBackspace(e, b, t);
      case 'Delete': return this.onDelete(e, b, t);
      case 'Tab': e.preventDefault(); this.syncAll(); if (e.shiftKey) this.outdent([b]); else this.indent([b]); return;
      case 'ArrowUp': return this.onArrowVertical(e, b, t, -1);
      case 'ArrowDown': return this.onArrowVertical(e, b, t, 1);
      case 'ArrowLeft': return this.onArrowHorizontal(e, b, t, -1);
      case 'ArrowRight': return this.onArrowHorizontal(e, b, t, 1);
      case 'Escape':
        e.preventDefault();
        this.syncAll();
        t.blur();
        this.selectBlocks([b]);
        return;
      default: break;
    }
    if (m && e.key.toLowerCase() === 'a' && !e.shiftKey) {
      const s = caret.getSelectionIn(t);
      if (s && s.start === 0 && s.end >= caret.textLength(t)) { e.preventDefault(); this.syncAll(); t.blur(); this.selectBlocks(this.doc.blocks); }
      return;
    }
    if (m && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicate([b]); return; }
    if (m && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); this.moveUpDown([b], e.key === 'ArrowUp' ? -1 : 1); return; }
    if (m && e.key === 'Enter') {
      e.preventDefault();
      if (b.type === 'todo') this.toggleChecked(b);
      else if (b.type === 'toggle' || b.type === 'callout' && b.kind === 'loesung') this.toggleOpen(b);
    }
  }

  formatShortcut(e, el) {
    const k = e.key.toLowerCase();
    const sh = e.shiftKey;
    if (!sh && k === 'b') { e.preventDefault(); this.toggleMark('b', true, el); return true; }
    if (!sh && k === 'i') { e.preventDefault(); this.toggleMark('i', true, el); return true; }
    if (!sh && k === 'u') { e.preventDefault(); this.toggleMark('u', true, el); return true; }
    if (sh && k === 's') { e.preventDefault(); this.toggleMark('s', true, el); return true; }
    if (!sh && k === 'e') { e.preventDefault(); this.toggleMark('code', true, el); return true; }
    if (sh && k === 'e') { e.preventDefault(); openInlineMath(this, null, el); return true; }
    if (sh && k === 'h') { e.preventDefault(); this.toggleMark('hl', this.lastHighlight || 'yellow', el); return true; }
    if (!sh && k === 'k') { e.preventDefault(); openLinkPopover(this, el); return true; }
    if (e.ctrlKey && e.metaKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.toggleMark('sup', true, el); return true; }
    if (e.ctrlKey && e.metaKey && e.key === '-') { e.preventDefault(); this.toggleMark('sub', true, el); return true; }
    if (sh && k === 'f' && e.altKey) { e.preventDefault(); openFootnote(this, null, el); return true; }
    return false;
  }

  onEnter(e, b, t) {
    if (e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      return;
    }
    if (UI.mod(e)) return;
    e.preventDefault();
    this.checkpoint();
    let sel = caret.getSelectionIn(t);
    if (sel && !sel.collapsed) { document.execCommand('delete'); sel = caret.getSelectionIn(t); }
    const segs = htmlToSegs(t.innerHTML);
    const len = segsLength(segs);
    const pos = sel ? sel.start : len;
    const empty = len === 0;
    // Leerer Listenpunkt / Toggle / Zitat: zuerst ausrücken, dann zu Text
    if (empty && (LIST_TYPES.has(b.type) || b.type === 'toggle' || b.type === 'quote') && !b.children.length) {
      const parent = this.parentOf(b);
      if (parent && parent.type !== 'column' && LIST_TYPES.has(parent.type)) { this.outdent([b]); return; }
      this.setType(b, 'p');
      return;
    }
    // Leerer letzter Absatz in einem Toggle/Kasten/Zitat: Enter verlässt den Container
    if (empty && b.type === 'p' && !b.children.length) {
      const parent = this.parentOf(b);
      if (parent && ['toggle', 'callout', 'quote'].includes(parent.type) && parent.children[parent.children.length - 1] === b) {
        this.outdent([b]);
        this.focusBlock(b, 'start');
        return;
      }
    }
    const [L, R] = splitSegs(segs, pos);
    const continueType = LIST_TYPES.has(b.type) || b.type === 'toggle' && !b.open ? b.type : 'p';
    // Enter am Anfang eines nichtleeren Blocks: leeren Block davor einfügen
    if (pos === 0 && !empty) {
      const nb = block(LIST_TYPES.has(b.type) ? b.type : 'p');
      this.syncBlock(b);
      this.insertBefore(b, [nb]);
      this.focusBlock(b, 'start');
      this.changed();
      return;
    }
    const nb = block(continueType, { html: segsToHTML(R) });
    if (nb.type === 'todo') nb.checked = false;
    this.setTextHTML(b, segsToHTML(L));
    const intoChildren = (b.type === 'callout') || (b.type === 'toggle' && b.open) || (b.children.length && (LIST_TYPES.has(b.type) || b.type === 'p'));
    if (intoChildren) {
      if (b.type === 'callout' || b.type === 'toggle') nb.type = 'p';
      this.insertChildAt(b, 0, [nb]);
    } else this.insertAfter(b, [nb]);
    this.focusBlock(nb, 'start');
    this.changed();
  }

  onBackspace(e, b, t) {
    const sel = caret.getSelectionIn(t);
    if (!sel || !sel.collapsed || sel.start !== 0) return;
    e.preventDefault();
    this.syncAll();
    if (b.type !== 'p') { this.setType(b, 'p'); this.focusBlock(b, 'start'); return; }
    if (b.align) { this.checkpoint(); delete b.align; this.applyBlockAttrs(b, this.elOf(b)); this.changed(); return; }
    const parent = this.parentOf(b);
    if (parent && parent.type !== 'column' && !['callout', 'toggle', 'quote'].includes(parent.type) && this.indexOf(b) === parent.children.length - 1) {
      this.outdent([b]);
      return;
    }
    const prev = this.prevVisible(b);
    if (!prev) return;
    if (!this.isText(prev)) {
      if (!caret.textLength(t) && !b.children.length) {
        this.checkpoint();
        this.removeBlocks([b]);
        this.changed();
      }
      this.selectBlocks([prev]);
      return;
    }
    this.mergeInto(prev, b);
  }

  // Block b an prev anhängen (Rückschritt am Anfang / Entf am Ende)
  mergeInto(prev, b) {
    this.checkpoint();
    this.syncAll();
    const prevSegs = htmlToSegs(prev.html || '');
    const at = segsLength(prevSegs);
    const merged = mergeSegs([...prevSegs, ...htmlToSegs(b.html || '')]);
    const kids = b.children || [];
    const sibs = this.siblingsOf(b);
    sibs.splice(sibs.indexOf(b), 1, ...kids);
    this.elOf(b)?.remove();
    prev.html = segsToHTML(merged);
    this.renderAll();
    const pt = this.textElOf(prev);
    pt.focus({ preventScroll: true });
    caret.setSelectionIn(pt, at);
    this.changed();
  }

  onDelete(e, b, t) {
    const sel = caret.getSelectionIn(t);
    if (!sel || !sel.collapsed || sel.start !== caret.textLength(t)) return;
    const next = this.nextVisible(b);
    if (!next) return;
    e.preventDefault();
    if (!this.isText(next)) { this.syncAll(); this.selectBlocks([next]); return; }
    this.mergeInto(b, next);
  }

  onArrowVertical(e, b, t, dir) {
    if (e.altKey || UI.mod(e)) return;
    const atEdge = dir < 0 ? caret.onFirstLine(t) : caret.onLastLine(t);
    if (!atEdge) return;
    if (e.shiftKey) {
      e.preventDefault();
      this.syncAll();
      t.blur();
      const other = dir < 0 ? this.prevVisible(b) : this.nextVisible(b);
      this.selectBlocks([b]);
      if (other) this.selectRange(b, other);
      return;
    }
    const target = dir < 0 ? this.prevVisible(b) : this.nextVisible(b);
    if (!target) {
      if (dir < 0 && this.titleEl) { e.preventDefault(); caret.placeCaret(this.titleEl, 'end'); }
      return;
    }
    e.preventDefault();
    const x = (caret.caretRect() || t.getBoundingClientRect()).left;
    if (this.isText(target)) {
      const tt = this.textElOf(target);
      caret.placeCaretAtX(tt, x, dir < 0 ? 'last' : 'first');
      this.ensureVisible(tt);
    } else this.focusBlock(target, dir < 0 ? 'end' : 'start');
  }

  onArrowHorizontal(e, b, t, dir) {
    if (e.shiftKey || e.altKey || UI.mod(e)) return;
    const sel = caret.getSelectionIn(t);
    if (!sel || !sel.collapsed) return;
    if (dir < 0 && sel.start === 0) {
      const prev = this.prevVisible(b);
      if (prev && this.isText(prev)) { e.preventDefault(); this.focusBlock(prev, 'end'); }
    } else if (dir > 0 && sel.start >= caret.textLength(t)) {
      const next = this.nextVisible(b);
      if (next && this.isText(next)) { e.preventDefault(); this.focusBlock(next, 'start'); }
    }
  }

  // -------------------------------------------------------------------------
  // Menüs am Block
  // -------------------------------------------------------------------------

  calloutMenu(b, anchor) {
    const kinds = ['merke', 'definition', 'satz', 'regel', 'beispiel', 'aufgabe', 'loesung', 'hausaufgabe', 'achtung', 'tipp', 'beweis', 'zusammenfassung', 'versuch', 'info'];
    UI.menu(anchor, [{ section: 'Art des Kastens' }, ...kinds.map(k => ({
      label: CALLOUTS[k].label, icon: CALLOUTS[k].icon, checked: b.kind === k,
      onSelect: () => { this.checkpoint(); this.syncAll(); b.kind = k; this.rerender(b); this.changed(); }
    }))]);
  }

  openBlockMenu(b, anchor) {
    const blocks = this.selected.has(b.id) ? this.selectedBlocks() : [b];
    if (!this.selected.has(b.id)) this.selectBlocks([b]);
    const turnInto = [
      ['p', 'Text', 'text'], ['h1', 'Überschrift 1', 'heading'], ['h2', 'Überschrift 2', 'heading'], ['h3', 'Überschrift 3', 'heading'],
      ['ul', 'Aufzählung', 'list'], ['ol', 'Nummerierung', 'listOrdered'], ['todo', 'To-do', 'checkSquare'], ['toggle', 'Toggle', 'toggle'],
      ['quote', 'Zitat', 'quote'], ['callout', 'Merkkasten', 'alert']
    ].map(([type, label, ic]) => ({
      label, icon: ic, checked: b.type === type,
      onSelect: () => { for (const x of blocks) if (this.isText(x)) this.setType(x, type, type === 'callout' ? { kind: x.kind || 'merke' } : {}); this.selectBlocks(blocks); }
    }));
    const align = (a) => () => { this.checkpoint(); for (const x of blocks) { if (a) x.align = a; else delete x.align; this.rerender(x, { keepFocus: false }); } this.selectBlocks(blocks); this.changed(); };
    const items = [
      { section: blocks.length > 1 ? `${blocks.length} Blöcke` : blockLabel(b) },
      { label: 'Löschen', icon: 'trash', hint: '⌫', onSelect: () => this.deleteBlocks(blocks) },
      { label: 'Duplizieren', icon: 'copy', hint: '⌘D', onSelect: () => this.duplicate(blocks) },
      blocks.every(x => this.isText(x)) ? { label: 'Umwandeln in', icon: 'turn', submenu: turnInto } : null,
      blocks.length === 1 && (/^h[123]$/.test(b.type) || b.type === 'ol') ? { label: 'Nummer', icon: 'hash', submenu: this.numberMenuItems(b) } : null,
      blocks.length > 1 ? { label: 'Nebeneinander anordnen', icon: 'columns', onSelect: () => this.arrangeSideBySide(blocks) } : null,
      this.columnRowOf(b) ? { label: 'Spalten', icon: 'columns', submenu: this.columnMenuItems(this.columnRowOf(b)) } : null,
      { label: 'Ausrichtung', icon: 'alignLeft', submenu: [
        { label: 'Links', icon: 'alignLeft', onSelect: align(null) },
        { label: 'Zentriert', icon: 'alignCenter', onSelect: align('center') },
        { label: 'Rechts', icon: 'alignRight', onSelect: align('right') },
        { label: 'Blocksatz', icon: 'alignJustify', onSelect: align('justify') }
      ] },
      '-',
      { label: 'Nach oben', icon: 'arrowUp', hint: '⌘⇧↑', onSelect: () => { this.moveUpDown(blocks, -1); this.selectBlocks(blocks); } },
      { label: 'Nach unten', icon: 'arrowDown', hint: '⌘⇧↓', onSelect: () => { this.moveUpDown(blocks, 1); this.selectBlocks(blocks); } },
      { label: 'Einrücken', icon: 'indent', hint: '⇥', onSelect: () => { this.indent(blocks); this.selectBlocks(blocks); } },
      { label: 'Ausrücken', icon: 'outdent', hint: '⇧⇥', onSelect: () => { this.outdent(blocks); this.selectBlocks(blocks); } }
    ];
    if (b.type === 'table' && blocks.length === 1) items.push('-', ...tableMenu(this, b));
    if (['image', 'plot', 'smiles'].includes(b.type) && blocks.length === 1) {
      items.push('-', { label: b.caption || b._cap ? 'Beschriftung bearbeiten' : 'Beschriftung hinzufügen', icon: 'text', onSelect: () => { b._cap = true; b.caption = b.caption || ''; this.rerender(b); requestAnimationFrame(() => this.elOf(b)?.querySelector('.caption')?.focus()); } });
    }
    if (b.type === 'image' && b.src && blocks.length === 1) {
      items.push({ label: 'Größe', icon: 'resize', hint: atoms.imageSizeLabel(b), submenu: atoms.imageSizeItems(this, b) });
      if (this.host.editImage) items.push({ label: 'Bild bearbeiten', icon: 'pencil', onSelect: () => this.host.editImage(b.src, b.id) });
    }
    if ((b.type === 'image' || b.type === 'pdf') && b.src) {
      items.push({ label: 'In DEVONthink zeigen', icon: 'database', onSelect: () => this.host.revealLink(b.src) });
      if (b.type === 'pdf') items.push({ label: 'Im PDF-Editor öffnen', icon: 'pencil', onSelect: () => this.host.openPDF(uuidFromLink(b.src), b.id) });
    }
    UI.menu(anchor, items);
  }
}

export function blockLabel(b) {
  const L = {
    p: 'Text', h1: 'Überschrift 1', h2: 'Überschrift 2', h3: 'Überschrift 3', ul: 'Aufzählung', ol: 'Nummerierung', todo: 'To-do',
    toggle: 'Toggle', quote: 'Zitat', callout: (CALLOUTS[b.kind] || CALLOUTS.info).label, hr: 'Trennlinie', pagebreak: 'Seitenumbruch',
    code: 'Code', math: 'Formel', chem: 'Reaktionsgleichung', smiles: 'Strukturformel', plot: 'Funktionsgraph', image: 'Bild',
    pdf: 'Arbeitsblatt', table: 'Tabelle', toc: 'Inhaltsverzeichnis', columns: 'Spalten'
  };
  return L[b.type] || 'Block';
}

function cloneWithIds(b) {
  const c = JSON.parse(JSON.stringify(b, (k, v) => (k.startsWith('_') ? undefined : v)));
  const re = (x) => { x.id = newId(); (x.children || []).forEach(re); };
  re(c);
  return c;
}

const TAG_COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'gray', 'brown'];
function tagColor(t) {
  let hsh = 0;
  for (const ch of t) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(hsh) % TAG_COLORS.length];
}

export { defaultPlotConfig, emptyTable };

// Anker für eine Überschrift: „Die Zelle – Aufbau“ → „die-zelle-aufbau“
export function headingSlug(text) {
  const s = String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'abschnitt';
}
