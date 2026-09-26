// Bildeditor: Textfelder, Pfeile, Linien, Formen, Stift, Textmarker,
// Nummern zum Beschriften, Abdecken, Zuschneiden, Drehen und Spiegeln.
//
// Alles bleibt als eigene Ebene bearbeitbar: Textfelder lassen sich später
// verschieben und ändern. Gespeichert wird automatisch; die Mac-App schreibt
// das Ergebnis im Originalformat zurück (TIFF bleibt TIFF, HEIC bleibt HEIC)
// und hebt das unveränderte Original auf.

import { h, menu, toast, confirmDialog } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { call, imageURL, touchAsset } from '../bridge.js';
import * as M from '../core/imagemodel.js';

const COLORS = [
  ['#e03131', 'Rot'], ['#1971c2', 'Blau'], ['#2f9e44', 'Grün'], ['#f08c00', 'Orange'],
  ['#7048e8', 'Lila'], ['#111111', 'Schwarz'], ['#ffffff', 'Weiß'], ['#fcc419', 'Gelb']
];
const MARKERS = [['#ffe066', 'Gelb'], ['#8ce99a', 'Grün'], ['#74c0fc', 'Blau'], ['#faa2c1', 'Rosa'], ['#ffc078', 'Orange']];
const COVERS = [['#ffffff', 'Weiß'], ['#111111', 'Schwarz'], ['#f1f3f5', 'Hellgrau'], ['#fff3bf', 'Gelb']];
const TEXT_BG = [[null, 'Ohne Hintergrund'], ['#ffffff', 'Weiß'], ['#fff3bf', 'Gelb'], ['#e7f5ff', 'Blau'], ['#111111', 'Schwarz']];
const TOOLS = [
  ['select', 'cursor', 'Auswählen und verschieben', 'V'],
  ['text', 'textTool', 'Textfeld', 'T'],
  ['arrow', 'arrowTool', 'Pfeil', 'A'],
  ['line', 'line', 'Linie', 'L'],
  ['rect', 'square', 'Rechteck', 'R'],
  ['ellipse', 'circle', 'Kreis', 'O'],
  ['pen', 'pen', 'Stift', 'P'],
  ['marker', 'highlighter', 'Textmarker', 'H'],
  ['badge', 'badge', 'Nummer zum Beschriften (1, 2, 3 …)', 'N'],
  ['cover', 'eyeOff', 'Abdecken – z. B. Lösungen verdecken', 'B']
];
const WIDTHS = [[0.5, 'Dünn'], [1, 'Normal'], [2, 'Dick'], [3.5, 'Sehr dick']];
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));

export class ImageEditor {
  constructor(app, uuid, node, opts = {}) {
    this.app = app;
    this.uuid = uuid;
    this.node = node;
    this.opts = opts;
    this.tool = 'select';
    this.page = 0;
    this.sel = null;
    this.editing = null;
    this.cropMode = false;
    this.dirtyPages = new Set();
    this.images = [];
    this.hist = {};
    this.fitMode = true;
    this.view = { s: 1, ox: 0, oy: 0 };
    this.style = { color: COLORS[0][0], widthK: 1, font: 'sans', sizeK: 1, bold: false, italic: false, align: 'left', bg: null, border: false, fill: null, marker: MARKERS[0][0], cover: COVERS[0][0], head: 'end' };
    this.el = h('div', { class: 'imged' });
    this.toolbar = h('div', { class: 'pdf-toolbar imged-toolbar' });
    this.props = h('div', { class: 'imged-props' });
    this.stage = h('div', { class: 'imged-stage', tabindex: '0' });
    this.canvas = h('canvas', { class: 'imged-canvas' });
    this.stage.append(this.canvas);
    this.banner = h('div', { class: 'imged-banner', style: { display: 'none' } });
    this.el.append(this.toolbar, this.props, this.banner, this.stage);
    this.ctx = this.canvas.getContext('2d');
    this.measureCtx = document.createElement('canvas').getContext('2d');
    this.onKey = (e) => this.keydown(e);
  }

  get L() { return this.doc.pages[this.page]; }

  async mount(container) {
    container.innerHTML = '';
    container.classList.add('no-scroll');
    container.append(this.el);
    try {
      this.info = await call('image.info', { uuid: this.uuid });
    } catch (e) {
      this.stage.append(h('div', { class: 'imged-empty', text: 'Bild kann nicht geöffnet werden: ' + e.message }));
      return;
    }
    const stored = this.info.layer && this.info.layer.v ? this.info.layer : null;
    this.doc = stored || { v: 1, pages: {} };
    this.writable = !!this.info.writable;
    this.pageCount = (this.info.pages || []).length || 1;
    if (!this.writable) {
      this.banner.style.display = '';
      this.banner.textContent = this.info.animated
        ? 'Animiertes Bild: Beim ersten Bearbeiten legt Heft eine PNG-Kopie an – das Original bleibt unverändert.'
        : 'Dieses Bildformat kann Heft nicht zurückschreiben. Beim ersten Bearbeiten entsteht eine PNG-Kopie daneben – das Original bleibt unverändert.';
    }
    this.buildToolbar();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.bindPointer();
    document.addEventListener('keydown', this.onKey, true);
    await this.showPage(0);
    this.stage.focus();
  }

  close() {
    this.closed = true;
    this.endEdit();
    this.ro && this.ro.disconnect();
    document.removeEventListener('keydown', this.onKey, true);
    return this.saveNow();
  }

  // -------------------------------------------------------------------------
  // Seiten und Bild laden
  // -------------------------------------------------------------------------

  loadImage(page) {
    if (this.images[page]) return this.images[page];
    this.images[page] = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
      img.src = imageURL(this.uuid, { page, base: this.info.base, v: this.stamp || (this.stamp = Date.now()) });
    });
    return this.images[page];
  }

  async showPage(page) {
    this.endEdit();
    this.page = page;
    this.sel = null;
    try { this.img = await this.loadImage(page); }
    catch (e) { this.stage.append(h('div', { class: 'imged-empty', text: e.message })); return; }
    let L = this.doc.pages[page];
    if (!L || L.w !== this.img.naturalWidth || L.h !== this.img.naturalHeight) {
      L = M.newLayer(this.img.naturalWidth, this.img.naturalHeight);
      this.doc.pages[page] = L;
    }
    if (!this.hist[page]) this.hist[page] = { stack: [JSON.stringify(L)], idx: 0 };
    this.fitMode = true;
    this.resize();
    this.renderProps();
    this.updatePageInfo();
  }

  // -------------------------------------------------------------------------
  // Werkzeugleiste und Eigenschaften
  // -------------------------------------------------------------------------

  buildToolbar() {
    const tb = this.toolbar;
    tb.innerHTML = '';
    const sep = () => tb.append(h('span', { class: 'sep' }));
    const act = (ic, tip, fn, label) => {
      const b = h('button', { class: 'tool-btn', 'data-tip': tip, html: icon(ic) + (label ? `<span>${label}</span>` : '') });
      b.addEventListener('click', fn);
      tb.append(b);
      return b;
    };
    for (const [id, ic, tip, kbd] of TOOLS) {
      const b = h('button', { class: 'tool-btn', 'data-tool': id, 'data-tip': tip, 'data-kbd': kbd, html: icon(ic) });
      b.addEventListener('click', () => this.setTool(id));
      tb.append(b);
    }
    sep();
    act('undo', 'Rückgängig', () => this.undo());
    act('redo', 'Wiederholen', () => this.redo());
    sep();
    act('rotate', 'Nach links drehen', () => this.transform((L) => M.rotateLayer(L, -1))).classList.add('flip-x');
    act('rotate', 'Nach rechts drehen', () => this.transform((L) => M.rotateLayer(L, 1)));
    act('flip', 'Spiegeln', () => this.transform((L) => M.flipLayer(L)));
    this.cropBtn = act('crop', 'Zuschneiden (Rahmen ziehen, Enter übernimmt)', () => this.startCrop(), 'Zuschneiden');
    sep();
    act('zoomOut', 'Verkleinern', () => this.zoomBy(1 / 1.25));
    this.zoomInfo = h('button', { class: 'tool-btn zoom-info', 'data-tip': 'Ganzes Bild zeigen', text: '100 %' });
    this.zoomInfo.addEventListener('click', () => { this.fitMode = true; this.fit(); this.draw(); });
    tb.append(this.zoomInfo);
    act('zoomIn', 'Vergrößern', () => this.zoomBy(1.25));
    if (this.pageCount > 1) {
      sep();
      act('chevronLeft', 'Vorige Seite', () => this.page > 0 && this.showPage(this.page - 1));
      this.pageInfo = h('span', { class: 'hint imged-pageinfo' });
      tb.append(this.pageInfo);
      act('chevronRight', 'Nächste Seite', () => this.page < this.pageCount - 1 && this.showPage(this.page + 1));
    }
    tb.append(h('span', { class: 'grow' }));
    act('more', 'Mehr', (e) => menu(e.currentTarget, [
      { label: 'Alles auswählen und löschen …', icon: 'trash', danger: true, onSelect: () => this.clearAll() },
      { label: 'Original wiederherstellen …', icon: 'refresh', onSelect: () => this.revert() }
    ]));
    this.setTool('select');
  }

  updatePageInfo() {
    if (this.pageInfo) this.pageInfo.textContent = `Seite ${this.page + 1} / ${this.pageCount}`;
  }

  setTool(id) {
    if (this.cropMode) this.endCrop(false);
    this.endEdit();
    this.tool = id;
    if (id !== 'select') this.sel = null;
    for (const b of this.toolbar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === id);
    this.stage.dataset.tool = id;
    this.renderProps();
    this.draw();
  }

  // Aktuelle Eigenschaften: vom ausgewählten Objekt oder vom Werkzeug
  context() {
    if (this.sel) return this.sel.type;
    return this.tool;
  }

  renderProps() {
    const p = this.props;
    p.innerHTML = '';
    if (!this.doc) return;
    if (this.cropMode) {
      p.append(h('span', { class: 'imged-hint', text: 'Rahmen an den Ecken und Kanten ziehen, dann „Fertig“.' }));
      const reset = h('button', { class: 'btn sm outline', text: 'Ganzes Bild' });
      reset.addEventListener('click', () => { const s = M.spaceSize(this.L); this.cropRect = { x: 0, y: 0, w: s.w, h: s.h }; this.draw(); });
      const cancel = h('button', { class: 'btn sm outline', text: 'Abbrechen' });
      cancel.addEventListener('click', () => this.endCrop(false));
      const done = h('button', { class: 'btn sm primary', text: 'Fertig' });
      done.addEventListener('click', () => this.endCrop(true));
      p.append(h('span', { class: 'grow' }), reset, cancel, done);
      return;
    }
    const ctx = this.context();
    const o = this.sel;
    const D = M.defaults(this.L || M.newLayer(1000, 1000));
    const group = (...kids) => h('div', { class: 'imged-group' }, ...kids);
    const swatches = (list, current, onPick) => group(...list.map(([c, name]) => {
      const s = h('button', { class: 'swatch' + (c === current ? ' on' : '') + (c ? '' : ' none'), style: { background: c || 'transparent' }, 'data-tip': name });
      s.addEventListener('click', () => onPick(c));
      return s;
    }));
    const toggle = (ic, tip, on, fn) => {
      const b = h('button', { class: 'tool-btn sm' + (on ? ' on' : ''), 'data-tip': tip, html: icon(ic, 'sm') });
      b.addEventListener('click', fn);
      return b;
    };
    const label = (t) => h('span', { class: 'imged-label', text: t });

    if (ctx === 'select' && !o) {
      p.append(h('span', { class: 'imged-hint', text: 'Objekt anklicken zum Bearbeiten · Doppelklick auf ein Textfeld ändert den Text · Entf löscht' }));
      return;
    }
    if (['text', 'arrow', 'line', 'rect', 'ellipse', 'pen', 'badge'].includes(ctx)) {
      p.append(label('Farbe'), swatches(COLORS, o ? o.color : this.style.color, (c) => this.setProp({ color: c })));
    }
    if (ctx === 'marker') p.append(label('Farbe'), swatches(MARKERS, o ? o.color : this.style.marker, (c) => this.setProp({ color: c }, { marker: c })));
    if (ctx === 'cover') p.append(label('Farbe'), swatches(COVERS, o ? o.color : this.style.cover, (c) => this.setProp({ color: c }, { cover: c })));
    if (['arrow', 'line', 'rect', 'ellipse', 'pen'].includes(ctx)) {
      const cur = o ? o.width / D.width : this.style.widthK;
      p.append(label('Stärke'), group(...WIDTHS.map(([k, name]) => {
        const b = h('button', { class: 'tool-btn sm width-btn' + (Math.abs(cur - k) < 0.01 ? ' on' : ''), 'data-tip': name });
        b.append(h('span', { class: 'width-dot', style: { height: Math.max(1.5, k * 2.5) + 'px' } }));
        b.addEventListener('click', () => this.setProp({ width: Math.round(D.width * k * 10) / 10 }, { widthK: k }));
        return b;
      })));
    }
    if (ctx === 'marker') {
      const cur = o ? o.width / D.width : this.style.markerK || 6;
      p.append(label('Breite'), group(...[[4, 'Schmal'], [6, 'Mittel'], [9, 'Breit']].map(([k, name]) => {
        const b = h('button', { class: 'tool-btn sm width-btn' + (Math.abs(cur - k) < 0.01 ? ' on' : ''), 'data-tip': name });
        b.append(h('span', { class: 'width-dot', style: { height: k * 1.4 + 'px' } }));
        b.addEventListener('click', () => this.setProp({ width: D.width * k }, { markerK: k }));
        return b;
      })));
    }
    if (ctx === 'text') {
      const cur = o || this.style;
      const fontBtn = h('button', { class: 'btn sm outline imged-font', text: (M.FONTS[cur.font] || M.FONTS.sans).label });
      fontBtn.style.fontFamily = (M.FONTS[cur.font] || M.FONTS.sans).css;
      fontBtn.addEventListener('click', () => menu(fontBtn, Object.entries(M.FONTS).map(([k, f]) => ({
        label: f.label, checked: cur.font === k, onSelect: () => this.setProp({ font: k }, { font: k })
      }))));
      const size = o ? o.size : Math.round(D.size * this.style.sizeK);
      const sizeLabel = h('span', { class: 'imged-size', text: String(Math.round(size)) });
      const step = (f) => {
        const next = Math.max(6, Math.round(size * f));
        this.setProp({ size: next }, { sizeK: next / D.size });
      };
      const minus = toggle('chevronDown', 'Kleiner', false, () => step(1 / 1.2));
      const plus = toggle('chevronUp', 'Größer', false, () => step(1.2));
      p.append(label('Schrift'), fontBtn, group(minus, sizeLabel, plus),
        group(toggle('bold', 'Fett', cur.bold, () => this.setProp({ bold: !cur.bold }, { bold: !cur.bold })),
          toggle('italic', 'Kursiv', cur.italic, () => this.setProp({ italic: !cur.italic }, { italic: !cur.italic }))),
        group(...[['left', 'alignLeft', 'Linksbündig'], ['center', 'alignCenter', 'Zentriert'], ['right', 'alignRight', 'Rechtsbündig']].map(([a, ic, tip]) =>
          toggle(ic, tip, (cur.align || 'left') === a, () => this.setProp({ align: a }, { align: a })))),
        label('Hintergrund'), swatches(TEXT_BG, cur.bg || null, (c) => this.setProp({ bg: c }, { bg: c })),
        toggle('square', 'Rahmen', !!cur.border, () => this.setProp({ border: !cur.border }, { border: !cur.border })));
    }
    if (ctx === 'rect' || ctx === 'ellipse') {
      const cur = o ? o.fill || null : this.style.fill;
      p.append(label('Füllung'), group(...[[null, 'Ohne'], ['soft', 'Durchscheinend'], ['solid', 'Voll']].map(([k, name]) => {
        const b = h('button', { class: 'btn sm outline' + ((cur || null) === k ? ' on' : ''), text: name });
        b.addEventListener('click', () => this.setProp({ fill: k }, { fill: k }));
        return b;
      })));
    }
    if (ctx === 'arrow') {
      const cur = o ? o.head || 'end' : this.style.head;
      p.append(label('Spitzen'), group(...[['end', 'Eine'], ['both', 'Beide']].map(([k, name]) => {
        const b = h('button', { class: 'btn sm outline' + (cur === k ? ' on' : ''), text: name });
        b.addEventListener('click', () => this.setProp({ head: k }, { head: k }));
        return b;
      })));
    }
    if (ctx === 'badge' && o) {
      const n = h('input', { class: 'input imged-num', value: String(o.n), 'data-tip': 'Nummer oder Buchstabe' });
      n.addEventListener('change', () => this.setProp({ n: n.value.trim() || o.n }));
      p.append(label('Zeichen'), n);
    }
    if (o) {
      p.append(h('span', { class: 'grow' }));
      p.append(toggle('arrowUp', 'Nach vorne', false, () => this.reorder(1)), toggle('arrowDown', 'Nach hinten', false, () => this.reorder(-1)),
        toggle('copy', 'Duplizieren (⌘D)', false, () => this.duplicate()), toggle('trash', 'Löschen (Entf)', false, () => this.deleteSel()));
    }
  }

  // Eigenschaft ändern – am ausgewählten Objekt und als Vorgabe für neue
  setProp(patch, stylePatch) {
    Object.assign(this.style, stylePatch || patch);
    if (this.sel) {
      Object.assign(this.sel, patch);
      if (this.editing && this.editing.o === this.sel) this.positionEditor();
      this.commit();
    }
    this.renderProps();
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Ansicht: Einpassen, Zoomen, Verschieben
  // -------------------------------------------------------------------------

  resize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = r.width; this.H = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    if (this.fitMode) this.fit();
    this.draw();
    if (this.editing) this.positionEditor();
  }

  fit() {
    if (!this.L) return;
    const pad = 28;
    const r = this.cropMode ? { x: 0, y: 0, ...M.spaceSize(this.L) } : M.outRect(this.L);
    const s = Math.min((this.W - 2 * pad) / r.w, (this.H - 2 * pad) / r.h, 4);
    this.view = { s, ox: (this.W - r.w * s) / 2 - r.x * s, oy: (this.H - r.h * s) / 2 - r.y * s };
    this.updateZoom();
  }

  zoomBy(f, cx = this.W / 2, cy = this.H / 2) {
    const v = this.view;
    const s = Math.min(16, Math.max(0.02, v.s * f));
    const k = s / v.s;
    this.view = { s, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k };
    this.fitMode = false;
    this.updateZoom();
    this.draw();
    if (this.editing) this.positionEditor();
  }

  updateZoom() {
    if (this.zoomInfo) this.zoomInfo.textContent = Math.round(this.view.s * 100) + ' %';
  }

  toSpace(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.ox) / this.view.s, y: (e.clientY - r.top - this.view.oy) / this.view.s };
  }

  // -------------------------------------------------------------------------
  // Zeichnen
  // -------------------------------------------------------------------------

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.paint(); });
  }

  paint() {
    const L = this.L, img = this.img;
    if (!L || !img) return;
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1, { s, ox, oy } = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const full = M.spaceSize(L);
    const out = this.cropMode ? { x: 0, y: 0, ...full } : M.outRect(L);
    // Blatt mit Schatten
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(ox + out.x * s, oy + out.y * s, out.w * s, out.h * s);
    ctx.restore();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.rect(out.x, out.y, out.w, out.h);
    ctx.clip();
    ctx.save();
    M.applyBaseTransform(ctx, L);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, L.w, L.h);
    ctx.restore();
    for (const o of L.objects) {
      if (this.editing && this.editing.o === o) continue;
      drawObject(ctx, o, full.w);
    }
    if (this.draft) drawObject(ctx, this.draft, full.w);
    ctx.restore();
    if (this.cropMode) this.paintCrop(ctx);
    else if (this.sel && !(this.editing && this.editing.o === this.sel)) this.paintSelection(ctx, this.sel);
  }

  paintSelection(ctx, o) {
    const { s, ox, oy } = this.view;
    const b = M.bbox(o);
    const pad = 4;
    ctx.save();
    ctx.strokeStyle = '#2383e2';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(o.type === 'line' || o.type === 'arrow' ? [] : [4, 3]);
    if (o.type !== 'line' && o.type !== 'arrow') ctx.strokeRect(ox + b.x * s - pad, oy + b.y * s - pad, b.w * s + 2 * pad, b.h * s + 2 * pad);
    ctx.setLineDash([]);
    for (const hd of M.handles(o)) {
      ctx.beginPath();
      ctx.arc(ox + hd.x * s, oy + hd.y * s, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  paintCrop(ctx) {
    const { s, ox, oy } = this.view;
    const full = M.spaceSize(this.L);
    const c = this.cropRect;
    const X = ox + c.x * s, Y = oy + c.y * s, Wc = c.w * s, Hc = c.h * s;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(ox, oy, full.w * s, full.h * s);
    ctx.rect(X, Y, Wc, Hc);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(X, Y, Wc, Hc);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(X + Wc * i / 3, Y); ctx.lineTo(X + Wc * i / 3, Y + Hc); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X, Y + Hc * i / 3); ctx.lineTo(X + Wc, Y + Hc * i / 3); ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const hd of M.handles({ type: 'rect', ...c })) ctx.fillRect(ox + hd.x * s - 5, oy + hd.y * s - 5, 10, 10);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Maus und Stift
  // -------------------------------------------------------------------------

  bindPointer() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this.down(e));
    cv.addEventListener('pointermove', (e) => this.move(e));
    cv.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('pointercancel', (e) => this.up(e));
    cv.addEventListener('dblclick', (e) => {
      const p = this.toSpace(e);
      const o = M.topHit(this.L.objects, p.x, p.y, 6 / this.view.s);
      if (o && o.type === 'text') { this.sel = o; this.startEdit(o); }
      else if (o && o.type === 'badge') { this.sel = o; this.renderProps(); const n = this.props.querySelector('.imged-num'); if (n) { n.focus(); n.select(); } }
    });
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else {
        this.view.ox -= e.deltaX;
        this.view.oy -= e.deltaY;
        this.fitMode = false;
        this.draw();
        if (this.editing) this.positionEditor();
      }
    }, { passive: false });
  }

  handleAt(e, o) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const { s, ox, oy } = this.view;
    for (const hd of M.handles(o)) if (Math.hypot(ox + hd.x * s - mx, oy + hd.y * s - my) <= 8) return hd.id;
    return null;
  }

  down(e) {
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) { this.startPan(e); return; }
    if (e.button !== 0) return;
    this.stage.focus({ preventScroll: true });
    if (this.editing) { this.endEdit(); if (this.tool === 'select') return; }
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toSpace(e);
    const tol = 6 / this.view.s;
    const L = this.L;
    const D = M.defaults(L);
    this.moved = false;
    if (this.cropMode) {
      const id = this.handleAt(e, { type: 'rect', ...this.cropRect });
      const c = this.cropRect;
      if (id) this.drag = { kind: 'crop-handle', id, orig: { type: 'rect', ...c } };
      else if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) this.drag = { kind: 'crop-move', start: p, orig: { ...c } };
      else this.drag = { kind: 'crop-new', start: p };
      return;
    }
    const tool = this.tool;
    if (tool === 'select') {
      if (this.sel) {
        const id = this.handleAt(e, this.sel);
        if (id) { this.drag = { kind: 'handle', id, orig: clone(this.sel) }; return; }
      }
      const o = M.topHit(L.objects, p.x, p.y, tol);
      this.sel = o;
      this.renderProps();
      if (o) this.drag = { kind: 'move', start: p, orig: clone(o) };
      else this.startPan(e);
      this.draw();
      return;
    }
    if (tool === 'text') {
      const hitText = M.topHit(L.objects.filter(o => o.type === 'text'), p.x, p.y, tol);
      if (hitText) { this.sel = hitText; this.startEdit(hitText); return; }
      const size = Math.round(D.size * this.style.sizeK);
      const o = { id: uid(), type: 'text', x: p.x, y: p.y - size * 0.62, w: size * 2, size, text: '', auto: true,
        font: this.style.font, color: this.style.color, bold: this.style.bold, italic: this.style.italic, align: this.style.align, bg: this.style.bg, border: this.style.border };
      L.objects.push(o);
      this.sel = o;
      this.startEdit(o, true);
      return;
    }
    if (tool === 'badge') {
      const o = { id: uid(), type: 'badge', x: p.x, y: p.y, r: Math.round(D.size * 0.72), n: M.nextBadge(L.objects), color: this.style.color };
      L.objects.push(o);
      this.sel = o;
      this.commit();
      this.renderProps();
      this.draw();
      return;
    }
    const width = tool === 'marker' ? D.width * (this.style.markerK || 6) : Math.round(D.width * this.style.widthK * 10) / 10;
    const color = tool === 'marker' ? this.style.marker : tool === 'cover' ? this.style.cover : this.style.color;
    if (tool === 'pen' || tool === 'marker') {
      this.draft = { id: uid(), type: tool, points: [[p.x, p.y]], width, color };
    } else if (tool === 'arrow' || tool === 'line') {
      this.draft = { id: uid(), type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, width, color, head: this.style.head };
    } else {
      this.draft = { id: uid(), type: tool, x: p.x, y: p.y, w: 0, h: 0, width, color, fill: tool === 'cover' ? 'solid' : this.style.fill };
    }
    this.drag = { kind: 'create', start: p };
  }

  startPan(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy };
    this.stage.classList.add('panning');
  }

  move(e) {
    const d = this.drag;
    if (!d) {
      // Mauszeiger über Griffen/Objekten anpassen
      if (this.tool === 'select' && !this.cropMode) {
        const handle = this.sel && this.handleAt(e, this.sel);
        const p = this.toSpace(e);
        const over = !handle && M.topHit(this.L ? this.L.objects : [], p.x, p.y, 6 / this.view.s);
        this.canvas.style.cursor = handle ? 'crosshair' : over ? 'move' : '';
      }
      return;
    }
    const p = this.toSpace(e);
    this.moved = true;
    const full = this.L && M.spaceSize(this.L);
    switch (d.kind) {
      case 'pan':
        this.view.ox = d.ox + e.clientX - d.sx;
        this.view.oy = d.oy + e.clientY - d.sy;
        this.fitMode = false;
        break;
      case 'move': {
        Object.assign(this.sel, clone(d.orig));
        M.moveObject(this.sel, p.x - d.start.x, p.y - d.start.y);
        break;
      }
      case 'handle':
        M.dragHandle(this.sel, d.orig, d.id, p.x, p.y);
        break;
      case 'create': {
        const o = this.draft;
        if (o.type === 'pen' || o.type === 'marker') {
          const last = o.points[o.points.length - 1];
          if (Math.hypot(p.x - last[0], p.y - last[1]) * this.view.s > 1.5) o.points.push([p.x, p.y]);
        } else if (o.type === 'arrow' || o.type === 'line') {
          let x = p.x, y = p.y;
          if (e.shiftKey) {
            // Auf 45°-Schritte einrasten
            const ang = Math.round(Math.atan2(y - o.y1, x - o.x1) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x - o.x1, y - o.y1);
            x = o.x1 + Math.cos(ang) * len; y = o.y1 + Math.sin(ang) * len;
          }
          o.x2 = x; o.y2 = y;
        } else {
          let w = p.x - d.start.x, hgt = p.y - d.start.y;
          if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hgt)); w = Math.sign(w || 1) * m; hgt = Math.sign(hgt || 1) * m; }
          o.x = Math.min(d.start.x, d.start.x + w); o.y = Math.min(d.start.y, d.start.y + hgt); o.w = Math.abs(w); o.h = Math.abs(hgt);
        }
        break;
      }
      case 'crop-handle': {
        const r = { ...d.orig };
        M.dragHandle(r, d.orig, d.id, p.x, p.y);
        this.cropRect = M.clampRect(r, full.w, full.h);
        break;
      }
      case 'crop-move': {
        const c = d.orig;
        this.cropRect = { ...c, x: Math.max(0, Math.min(full.w - c.w, c.x + p.x - d.start.x)), y: Math.max(0, Math.min(full.h - c.h, c.y + p.y - d.start.y)) };
        break;
      }
      case 'crop-new':
        this.cropRect = M.clampRect({ x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y }, full.w, full.h);
        break;
    }
    this.draw();
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    this.stage.classList.remove('panning');
    if (!d) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* egal */ }
    if (d.kind === 'move' || d.kind === 'handle') {
      if (this.moved) this.commit();
      return;
    }
    if (d.kind === 'create') {
      const o = this.draft;
      this.draft = null;
      const tiny = 4 / this.view.s;
      let keep = true;
      if (o.type === 'pen' || o.type === 'marker') {
        o.points = M.simplify(o.points, 0.6 / this.view.s);
        if (o.points.length === 1) o.points.push([o.points[0][0] + 0.01, o.points[0][1]]);
      } else if (o.type === 'arrow' || o.type === 'line') keep = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) > tiny;
      else keep = o.w > tiny && o.h > tiny;
      if (keep) {
        this.L.objects.push(o);
        if (o.type !== 'pen' && o.type !== 'marker') this.sel = o;
        this.commit();
        this.renderProps();
      }
      this.draw();
    }
  }

  // -------------------------------------------------------------------------
  // Textfelder bearbeiten
  // -------------------------------------------------------------------------

  startEdit(o, isNew = false) {
    this.endEdit();
    const ta = h('textarea', { class: 'imged-text', spellcheck: 'true', placeholder: 'Text …' });
    ta.value = o.text || '';
    this.editing = { o, isNew, ta };
    this.stage.append(ta);
    ta.addEventListener('input', () => { o.text = ta.value; this.positionEditor(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.endEdit(); this.stage.focus(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (this.editing && this.editing.ta === ta && document.activeElement !== ta && !document.querySelector('.popover')) this.endEdit(); }, 120));
    this.positionEditor();
    this.renderProps();
    this.draw();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  positionEditor() {
    const ed = this.editing;
    if (!ed) return;
    const { o, ta } = ed;
    const { s, ox, oy } = this.view;
    const mctx = this.measureCtx;
    mctx.font = M.fontCSS(o);
    const { pad } = M.layoutText(o, (t) => mctx.measureText(t).width, M.spaceSize(this.L).w);
    Object.assign(ta.style, {
      left: ox + o.x * s + 'px', top: oy + o.y * s + 'px', width: Math.max(24, o.w * s) + 'px', height: Math.max(o.size * s * M.LINE_HEIGHT, o.h * s) + 'px',
      font: M.fontCSS(o, s), lineHeight: String(M.LINE_HEIGHT), padding: pad * s + 'px', color: o.color, textAlign: o.align || 'left',
      background: o.bg || 'transparent', borderColor: o.border ? o.color : ''
    });
  }

  endEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.ta.remove();
    const { o } = ed;
    const L = this.L;
    if (!String(o.text || '').trim()) {
      const i = L.objects.indexOf(o);
      if (i >= 0) L.objects.splice(i, 1);
      if (this.sel === o) this.sel = null;
      if (!ed.isNew) this.commit();
    } else this.commit();
    this.renderProps();
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Bearbeiten: Verlauf, Löschen, Reihenfolge …
  // -------------------------------------------------------------------------

  commit() {
    const hs = this.hist[this.page];
    const snap = JSON.stringify(this.L);
    if (hs.stack[hs.idx] === snap) return;
    hs.stack.splice(hs.idx + 1);
    hs.stack.push(snap);
    if (hs.stack.length > 150) hs.stack.shift();
    hs.idx = hs.stack.length - 1;
    this.changed();
  }

  restore(snap) {
    const selId = this.sel && this.sel.id;
    this.doc.pages[this.page] = JSON.parse(snap);
    this.sel = selId ? this.L.objects.find(o => o.id === selId) || null : null;
    if (this.fitMode) this.fit();
    this.renderProps();
    this.draw();
    this.changed();
  }

  undo() {
    if (this.editing) { this.endEdit(); }
    const hs = this.hist[this.page];
    if (!hs || hs.idx <= 0) return;
    hs.idx--;
    this.restore(hs.stack[hs.idx]);
  }

  redo() {
    const hs = this.hist[this.page];
    if (!hs || hs.idx >= hs.stack.length - 1) return;
    hs.idx++;
    this.restore(hs.stack[hs.idx]);
  }

  deleteSel() {
    if (!this.sel) return;
    const i = this.L.objects.indexOf(this.sel);
    if (i >= 0) this.L.objects.splice(i, 1);
    this.sel = null;
    this.commit();
    this.renderProps();
    this.draw();
  }

  duplicate() {
    if (!this.sel) return;
    const c = clone(this.sel);
    c.id = uid();
    M.moveObject(c, 16 / this.view.s, 16 / this.view.s);
    if (c.type === 'badge') c.n = M.nextBadge(this.L.objects);
    this.L.objects.push(c);
    this.sel = c;
    this.commit();
    this.renderProps();
    this.draw();
  }

  reorder(dir) {
    const objs = this.L.objects, i = objs.indexOf(this.sel);
    if (i < 0) return;
    objs.splice(i, 1);
    if (dir > 0) objs.push(this.sel); else objs.unshift(this.sel);
    this.commit();
    this.draw();
  }

  transform(fn) {
    this.endEdit();
    fn(this.L);
    this.fitMode = true;
    this.fit();
    this.commit();
    this.draw();
  }

  startCrop() {
    this.endEdit();
    this.sel = null;
    this.cropMode = true;
    const s = M.spaceSize(this.L);
    this.cropRect = this.L.crop ? { ...this.L.crop } : { x: 0, y: 0, w: s.w, h: s.h };
    this.cropBtn.classList.add('on');
    this.fitMode = true;
    this.fit();
    this.renderProps();
    this.draw();
  }

  endCrop(apply) {
    this.cropMode = false;
    this.cropBtn && this.cropBtn.classList.remove('on');
    if (apply) {
      const s = M.spaceSize(this.L);
      const c = this.cropRect;
      this.L.crop = c.x <= 0 && c.y <= 0 && c.w >= s.w && c.h >= s.h ? null : { ...c };
      this.commit();
    }
    this.fitMode = true;
    this.fit();
    this.renderProps();
    this.draw();
  }

  async clearAll() {
    if (!this.L.objects.length) return;
    if (!await confirmDialog('Alle Textfelder und Zeichnungen löschen?', 'Das Bild selbst bleibt, Drehen und Zuschnitt auch. Mit ⌘Z lässt sich das rückgängig machen.', { confirm: 'Löschen', danger: true })) return;
    this.L.objects = [];
    this.sel = null;
    this.commit();
    this.renderProps();
    this.draw();
  }

  async revert() {
    if (!await confirmDialog('Original wiederherstellen?', 'Alle Änderungen an diesem Bild – Textfelder, Zeichnungen, Drehen und Zuschnitt – werden verworfen.', { confirm: 'Wiederherstellen', danger: true })) return;
    clearTimeout(this.saveTimer);
    this.dirtyPages.clear();
    try {
      const ok = await call('image.revert', { uuid: this.uuid });
      touchAsset(this.uuid);
      if (!ok) this.doc = { v: 1, pages: {} };
      this.images = [];
      this.hist = {};
      this.stamp = Date.now();
      this.info = await call('image.info', { uuid: this.uuid });
      this.doc = this.info.layer && this.info.layer.v ? this.info.layer : { v: 1, pages: {} };
      await this.showPage(0);
      this.app.setSaveState('saved');
      toast('Original wiederhergestellt', { type: 'success' });
    } catch (e) { toast('Wiederherstellen fehlgeschlagen: ' + e.message, { type: 'error' }); }
  }

  // -------------------------------------------------------------------------
  // Tastatur
  // -------------------------------------------------------------------------

  keydown(e) {
    if (this.closed || this.editing) return;
    if (document.querySelector('body > .overlay, body > .popover')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!this.el.isConnected) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === ' ' && !mod) { this.spaceDown = true; this.stage.classList.add('pan-ready'); e.preventDefault(); const up = (ev) => { if (ev.key === ' ') { this.spaceDown = false; this.stage.classList.remove('pan-ready'); document.removeEventListener('keyup', up, true); } }; document.addEventListener('keyup', up, true); return; }
    if (e.key === 'Escape') {
      if (this.cropMode) this.endCrop(false);
      else if (this.sel) { this.sel = null; this.renderProps(); this.draw(); }
      else if (this.tool !== 'select') this.setTool('select');
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && this.cropMode) { e.preventDefault(); this.endCrop(true); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.sel) { e.preventDefault(); this.deleteSel(); return; }
    if (e.key === 'Enter' && this.sel && this.sel.type === 'text') { e.preventDefault(); this.startEdit(this.sel); return; }
    if (mod && e.key.toLowerCase() === 'd' && this.sel) { e.preventDefault(); this.duplicate(); return; }
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.zoomBy(1.25); return; }
    if (mod && e.key === '-') { e.preventDefault(); this.zoomBy(1 / 1.25); return; }
    if (mod && e.key === '0') { e.preventDefault(); this.fitMode = true; this.fit(); this.draw(); return; }
    if (this.sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / this.view.s;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      M.moveObject(this.sel, dx, dy);
      this.draw();
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => this.commit(), 400);
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1) {
      const tool = TOOLS.find(x => x[3] === e.key.toUpperCase());
      if (tool) { e.preventDefault(); this.setTool(tool[0]); }
    }
  }

  // -------------------------------------------------------------------------
  // Speichern
  // -------------------------------------------------------------------------

  changed() {
    this.dirtyPages.add(this.page);
    this.app.setSaveState('dirty');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 1500);
  }

  // Ebene einer Seite als durchsichtiges Bild in Originalgröße
  exportPage(i) {
    const L = this.doc.pages[i];
    const out = M.outRect(L);
    let overlay = null;
    if (L.objects.length) {
      const k = Math.min(1, Math.sqrt(40e6 / (out.w * out.h)));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(out.w * k));
      c.height = Math.max(1, Math.round(out.h * k));
      const x = c.getContext('2d');
      x.scale(k, k);
      x.translate(-out.x, -out.y);
      const full = M.spaceSize(L);
      for (const o of L.objects) drawObject(x, o, full.w);
      overlay = c.toDataURL('image/png').split(',')[1];
    }
    return { index: Number(i), rot: L.rot, flipX: !!L.flipX, crop: L.crop, overlay };
  }

  async ensureWritable() {
    if (this.writable) return true;
    // Nicht zurückschreibbares Format: PNG-Kopie daneben anlegen und die bearbeiten
    const parent = this.app.lib.parentOf(this.uuid);
    const r = await call('image.copy', { uuid: this.uuid, parent: parent ? parent.uuid : this.app.lib.root.uuid });
    if (!r || !r.uuid) throw new Error('Kopie konnte nicht angelegt werden');
    const from = this.uuid;
    this.uuid = r.uuid;
    // Aus einem Eintrag heraus geöffnet: der Eintrag zeigt ab jetzt die Kopie
    const cur = this.app.current;
    const relinked = cur && cur.back ? await this.app.relinkImage(cur.back, from, r.uuid) : false;
    if (cur && cur.backAt && cur.backAt.uuid === from) cur.backAt = { ...cur.backAt, uuid: r.uuid };
    this.writable = true;
    this.banner.style.display = 'none';
    this.app.current.uuid = r.uuid;
    this.app.current.name = r.name;
    await this.app.lib.refresh();
    this.app.renderTopbar();
    this.app.sidebar.reveal(r.uuid);
    toast(`Bearbeitet wird die Kopie „${r.name}“` + (relinked ? ' – der Eintrag zeigt ab jetzt die Kopie' : ''), { type: 'success' });
    return true;
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    if (this.saving) { this.saveAgain = true; return this.saving; }
    if (!this.dirtyPages.size || !this.doc) return Promise.resolve();
    this.dirtyPages.clear();
    this.app.setSaveState('saving');
    this.saving = (async () => {
      try {
        await this.ensureWritable();
        // Alle Seiten mit Änderungen mitschicken – die Mac-App setzt jedes Mal neu aus dem Original zusammen
        const pages = Object.keys(this.doc.pages).filter(i => !M.isEmptyLayer(this.doc.pages[i])).map(i => this.exportPage(i));
        await call('image.save', { uuid: this.uuid, pages, layer: this.doc });
        touchAsset(this.uuid);
        this.info.base = 'original';
        if (!this.closed) this.app.setSaveState(this.dirtyPages.size ? 'dirty' : 'saved');
      } catch (e) {
        this.dirtyPages.add(this.page);
        this.app.setSaveState('error');
        toast('Bild nicht gespeichert: ' + e.message, { type: 'error', action: { label: 'Erneut', onClick: () => this.saveNow() } });
      } finally {
        this.saving = null;
        if (this.saveAgain) { this.saveAgain = false; if (this.dirtyPages.size) this.saveNow(); }
      }
    })();
    return this.saving;
  }
}

// ---------------------------------------------------------------------------
// Ein Objekt zeichnen (Editor und Speichern nutzen dieselbe Funktion)
// ---------------------------------------------------------------------------

export function drawObject(ctx, o, spaceW) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (o.type) {
    case 'text': drawText(ctx, o, spaceW); break;
    case 'rect': case 'ellipse': {
      ctx.beginPath();
      if (o.type === 'rect') ctx.rect(o.x, o.y, o.w, o.h);
      else ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.max(0.5, o.w / 2), Math.max(0.5, o.h / 2), 0, 0, Math.PI * 2);
      if (o.fill) {
        ctx.fillStyle = o.color;
        ctx.globalAlpha = o.fill === 'soft' ? 0.22 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.width;
      ctx.stroke();
      break;
    }
    case 'cover':
      ctx.fillStyle = o.color || '#fff';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      break;
    case 'line': case 'arrow': drawLine(ctx, o); break;
    case 'pen': case 'marker': {
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.width;
      if (o.type === 'marker') { ctx.globalAlpha = 0.42; ctx.lineCap = 'square'; }
      const p = o.points;
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      ctx.stroke();
      break;
    }
    case 'badge': {
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fillStyle = o.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1, o.r * 0.12);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      const label = String(o.n);
      ctx.fillStyle = isLight(o.color) ? '#111' : '#fff';
      ctx.font = `700 ${o.r * (label.length > 2 ? 0.8 : 1.05)}px ${M.FONTS.sans.css}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, o.x, o.y + o.r * 0.04);
      break;
    }
  }
  ctx.restore();
}

function drawText(ctx, o, spaceW) {
  ctx.font = M.fontCSS(o);
  const { lines, pad, lh } = M.layoutText(o, (t) => ctx.measureText(t).width, spaceW);
  const r = Math.min(o.size * 0.25, o.h / 2);
  if (o.bg || o.border) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(o.x, o.y, o.w, o.h, r) : ctx.rect(o.x, o.y, o.w, o.h);
    if (o.bg) { ctx.fillStyle = o.bg; ctx.fill(); }
    if (o.border) { ctx.strokeStyle = o.color; ctx.lineWidth = Math.max(1, o.size / 14); ctx.stroke(); }
  }
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'top';
  const align = o.align || 'left';
  ctx.textAlign = align;
  const x = align === 'center' ? o.x + o.w / 2 : align === 'right' ? o.x + o.w - pad : o.x + pad;
  lines.forEach((line, i) => ctx.fillText(line, x, o.y + pad + i * lh + (lh - o.size) / 2));
}

function drawLine(ctx, o) {
  const { x1, y1, x2, y2 } = o;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const head = o.type === 'arrow' ? Math.min(len * 0.6, Math.max(10, o.width * 4.2)) : 0;
  const both = o.type === 'arrow' && o.head === 'both';
  // Linie bis zum Ansatz der Spitze, damit sie nicht durch die Spitze sticht
  const sx = both ? x1 + Math.cos(ang) * head * 0.8 : x1, sy = both ? y1 + Math.sin(ang) * head * 0.8 : y1;
  const ex = x2 - Math.cos(ang) * head * 0.8, ey = y2 - Math.sin(ang) * head * 0.8;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  const tip = (x, y, a) => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(a - 0.45) * head, y - Math.sin(a - 0.45) * head);
    ctx.lineTo(x - Math.cos(a + 0.45) * head, y - Math.sin(a + 0.45) * head);
    ctx.closePath();
    ctx.fill();
  };
  if (head) { tip(x2, y2, ang); if (both) tip(x1, y1, ang + Math.PI); }
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}
