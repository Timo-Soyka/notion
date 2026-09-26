// Arbeitsblatt-Ansicht: Werkzeugleiste in HTML, die Seiten selbst zeigt und
// bearbeitet die Mac-App mit PDFKit (Apples PDF-Technik aus Vorschau). Die
// Anmerkungen landen als echte PDF-Anmerkungen in der Datei – sichtbar auch in
// DEVONthink, Vorschau und auf dem iPad.

import { h, esc, menu, toast } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { call, on, isNative, assetURL, itemLink } from '../bridge.js';

const COLORS = [
  ['#1d4ed8', 'Blau'], ['#111111', 'Schwarz'], ['#dc2626', 'Rot'], ['#16a34a', 'Grün'], ['#ea580c', 'Orange'], ['#9333ea', 'Lila']
];
const HIGHLIGHTS = [
  ['#fde047', 'Gelb'], ['#86efac', 'Grün'], ['#93c5fd', 'Blau'], ['#f9a8d4', 'Rosa'], ['#fdba74', 'Orange']
];

export class PDFView {
  constructor(app, uuid, node) {
    this.app = app;
    this.uuid = uuid;
    this.node = node;
    this.tool = 'select';
    this.color = COLORS[0][0];
    this.hlColor = HIGHLIGHTS[0][0];
    this.width = 2;
    this.el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });
    this.toolbar = h('div', { class: 'pdf-toolbar' });
    this.host = h('div', { class: 'pdf-host' });
    this.el.append(this.toolbar, this.host);
    this.buildToolbar();
    this.off = on('pdf-state', (st) => this.onState(st));
  }

  async mount(container) {
    container.innerHTML = '';
    container.classList.add('no-scroll');
    container.append(this.el);
    if (!isNative) return this.fallback();
    await new Promise(r => requestAnimationFrame(r));
    const res = await call('pdf.open', { uuid: this.uuid, rect: this.rect() });
    if (!res || !res.ok) {
      toast('PDF konnte nicht geöffnet werden: ' + (res && res.reason || 'unbekannter Fehler'), { type: 'error' });
      return this.fallback();
    }
    this.pages = res.pages;
    this.updatePageInfo(1, res.pages);
    this.ro = new ResizeObserver(() => this.sendRect());
    this.ro.observe(this.host);
    // Menüs und Dialoge liegen im HTML – solange eins offen ist, das native PDF ausblenden
    this.mo = new MutationObserver(() => this.checkOverlays());
    this.mo.observe(document.body, { childList: true });
  }

  rect() {
    const r = this.host.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  sendRect() {
    if (this.closed) return;
    call('pdf.rect', { rect: this.rect() });
  }

  async checkOverlays() {
    const covered = !!document.querySelector('body > .overlay, body > .popover');
    if (covered === this.covered) return;
    this.covered = covered;
    const res = await call('pdf.visible', { visible: !covered });
    let snap = this.host.querySelector('.pdf-snapshot');
    if (covered && res && res.snapshot) {
      if (!snap) { snap = h('div', { class: 'pdf-snapshot' }); this.host.append(snap); }
      snap.style.backgroundImage = `url(${res.snapshot})`;
      snap.style.backgroundSize = '100% 100%';
    } else if (snap) snap.remove();
  }

  async fallback() {
    // Im Browser: Seiten als Bilder zeigen (nur Ansicht)
    const box = h('div', { class: 'pdf-fallback' });
    this.host.append(box);
    let pages = 2;
    try { pages = (await call('pdf.info', { uuid: this.uuid })).pages || 1; } catch { /* egal */ }
    for (let p = 1; p <= pages; p++) box.append(h('img', { src: assetURL(itemLink(this.uuid), { page: p }) }));
  }

  close() {
    this.closed = true;
    this.off && this.off();
    this.ro && this.ro.disconnect();
    this.mo && this.mo.disconnect();
    if (isNative) call('pdf.close', {});
  }

  onState(st) {
    if (!st || st.uuid && st.uuid !== this.uuid) return;
    if (st.page) this.updatePageInfo(st.page, st.pages || this.pages);
    if (st.saved !== undefined) this.app.setSaveState(st.saving ? 'saving' : st.dirty ? 'dirty' : 'saved');
    if (st.tool) this.setTool(st.tool, true);
  }

  updatePageInfo(page, pages) {
    this.pageInfo.textContent = `Seite ${page} / ${pages}`;
  }

  setTool(tool, fromNative) {
    this.tool = tool;
    for (const b of this.toolbar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    this.colorRow.style.display = ['pen', 'text', 'rect', 'ellipse', 'line', 'arrow', 'underline', 'strike'].includes(tool) ? 'flex' : 'none';
    this.hlRow.style.display = tool === 'highlight' ? 'flex' : 'none';
    this.widthBtn.style.display = ['pen', 'rect', 'ellipse', 'line', 'arrow'].includes(tool) ? '' : 'none';
    if (!fromNative) this.sendTool();
  }

  sendTool() {
    call('pdf.tool', { tool: this.tool, color: this.tool === 'highlight' ? this.hlColor : this.color, width: this.width, fontSize: this.fontSize || 14 });
  }

  action(name, extra = {}) {
    return call('pdf.action', { action: name, ...extra });
  }

  buildToolbar() {
    const tb = this.toolbar;
    const tool = (id, ic, tip, kbd) => {
      const b = h('button', { class: 'tool-btn', 'data-tool': id, 'data-tip': tip, 'data-kbd': kbd || '', html: icon(ic) });
      b.addEventListener('click', () => this.setTool(id));
      tb.append(b);
      return b;
    };
    const act = (ic, tip, fn, label) => {
      const b = h('button', { class: 'tool-btn', 'data-tip': tip, html: icon(ic) + (label ? `<span>${esc(label)}</span>` : '') });
      b.addEventListener('click', fn);
      tb.append(b);
      return b;
    };
    const sep = () => tb.append(h('span', { class: 'sep' }));
    tool('select', 'cursor', 'Auswählen und Text markieren', 'V');
    tool('text', 'textTool', 'Text schreiben (Arbeitsblatt ausfüllen)', 'T');
    tool('pen', 'pen', 'Stift', 'P');
    tool('highlight', 'highlighter', 'Textmarker', 'H');
    tool('underline', 'underline', 'Unterstreichen');
    tool('strike', 'strike', 'Durchstreichen');
    const shapes = h('button', { class: 'tool-btn', 'data-tool': 'rect', 'data-tip': 'Formen', html: icon('square') + icon('chevronDown', 'sm') });
    shapes.addEventListener('click', () => {
      menu(shapes, [
        { label: 'Rechteck', icon: 'square', onSelect: () => { shapes.dataset.tool = 'rect'; shapes.innerHTML = icon('square') + icon('chevronDown', 'sm'); this.setTool('rect'); } },
        { label: 'Kreis', icon: 'circle', onSelect: () => { shapes.dataset.tool = 'ellipse'; shapes.innerHTML = icon('circle') + icon('chevronDown', 'sm'); this.setTool('ellipse'); } },
        { label: 'Linie', icon: 'line', onSelect: () => { shapes.dataset.tool = 'line'; shapes.innerHTML = icon('line') + icon('chevronDown', 'sm'); this.setTool('line'); } },
        { label: 'Pfeil', icon: 'arrowTool', onSelect: () => { shapes.dataset.tool = 'arrow'; shapes.innerHTML = icon('arrowTool') + icon('chevronDown', 'sm'); this.setTool('arrow'); } }
      ]);
    });
    tb.append(shapes);
    tool('eraser', 'eraser', 'Radierer (Anmerkung anklicken)', 'E');
    sep();
    this.colorRow = h('div', { class: 'swatch-row' });
    for (const [c, name] of COLORS) {
      const s = h('button', { class: 'swatch' + (c === this.color ? ' on' : ''), style: { background: c }, 'data-tip': name });
      s.addEventListener('click', () => { this.color = c; this.colorRow.querySelectorAll('.swatch').forEach(x => x.classList.toggle('on', x === s)); this.sendTool(); });
      this.colorRow.append(s);
    }
    this.hlRow = h('div', { class: 'swatch-row' });
    for (const [c, name] of HIGHLIGHTS) {
      const s = h('button', { class: 'swatch' + (c === this.hlColor ? ' on' : ''), style: { background: c }, 'data-tip': name });
      s.addEventListener('click', () => { this.hlColor = c; this.hlRow.querySelectorAll('.swatch').forEach(x => x.classList.toggle('on', x === s)); this.sendTool(); });
      this.hlRow.append(s);
    }
    tb.append(this.colorRow, this.hlRow);
    this.widthBtn = h('button', { class: 'tool-btn', 'data-tip': 'Strichstärke', text: 'Stärke' });
    this.widthBtn.addEventListener('click', () => menu(this.widthBtn, [1, 2, 3, 5, 8].map(w => ({ label: `${w} pt`, checked: this.width === w, onSelect: () => { this.width = w; this.sendTool(); } }))));
    tb.append(this.widthBtn);
    sep();
    act('undo', 'Rückgängig', () => this.action('undo'));
    act('redo', 'Wiederholen', () => this.action('redo'));
    sep();
    act('pagePlus', 'Seite einfügen', (e) => menu(e.currentTarget, [
      { label: 'Leere Seite dahinter', icon: 'file', onSelect: () => this.action('addPage', { style: 'blank' }) },
      { label: 'Karierte Seite dahinter', icon: 'table', onSelect: () => this.action('addPage', { style: 'grid' }) },
      { label: 'Linierte Seite dahinter', icon: 'alignJustify', onSelect: () => this.action('addPage', { style: 'lines' }) }
    ]));
    act('rotate', 'Seite drehen', () => this.action('rotate'));
    act('trash', 'Seite löschen', () => this.action('deletePage'));
    sep();
    act('zoomOut', 'Verkleinern', () => this.action('zoomOut'));
    act('zoomIn', 'Vergrößern', () => this.action('zoomIn'));
    this.pageInfo = h('span', { class: 'hint', style: { fontSize: '12.5px', color: 'var(--muted)', padding: '0 8px', whiteSpace: 'nowrap' } });
    tb.append(this.pageInfo);
    tb.append(h('span', { class: 'grow' }));
    act('scan', 'Text erkennen (OCR) – macht eingescannte Blätter durchsuchbar', async () => {
      const t = toast('Text wird erkannt …', { type: 'busy', timeout: 0 });
      try { const r = await this.action('ocr'); t.close(); toast(r && r.chars ? `Text erkannt (${r.chars} Zeichen) – jetzt in DEVONthink durchsuchbar` : 'Kein Text gefunden', { type: 'success' }); }
      catch (e) { t.close(); toast('Texterkennung fehlgeschlagen: ' + e.message, { type: 'error' }); }
    }, 'Text erkennen');
    act('note', 'Neuen Eintrag mit diesem Arbeitsblatt anlegen', () => this.app.noteFromPDF(this.uuid, this.node), 'Eintrag dazu');
    this.setTool('select', true);
  }
}
