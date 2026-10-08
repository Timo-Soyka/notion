// Kleine Oberflächen-Bausteine: Menüs, Popover, Dialoge, Meldungen, Tooltips.

import { icon } from './icons.js';
import { isPalm } from '../palm.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    if (c instanceof String && c.__html) { el.insertAdjacentHTML('beforeend', String(c)); continue; }
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Popover-Positionierung
// ---------------------------------------------------------------------------

export function placeNear(el, anchor, opts = {}) {
  const r = anchor instanceof DOMRect || (anchor && 'left' in anchor && !(anchor instanceof Element))
    ? anchor : anchor.getBoundingClientRect();
  const gap = opts.gap ?? 6;
  el.style.left = '0px';
  el.style.top = '0px';
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = opts.align === 'right' ? r.right - w : opts.align === 'center' ? r.left + (r.width - w) / 2 : r.left;
  let y = opts.side === 'top' ? r.top - hgt - gap : r.bottom + gap;
  if (opts.side !== 'top' && y + hgt > vh - 8 && r.top - hgt - gap > 8) y = r.top - hgt - gap;
  if (opts.side === 'top' && y < 8) y = r.bottom + gap;
  if (opts.side === 'right') { x = r.right + gap; y = r.top - 6; if (x + w > vw - 8) x = r.left - w - gap; }
  x = Math.max(8, Math.min(x, vw - w - 8));
  y = Math.max(8, Math.min(y, vh - hgt - 8));
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
}

const openPopovers = [];

export function closeAllPopovers() {
  while (openPopovers.length) openPopovers.pop().close();
}

// Allgemeines Popover; schließt bei Klick außerhalb oder Escape.
export function popover(anchor, content, opts = {}) {
  const el = h('div', { class: 'popover ' + (opts.class || '') });
  if (typeof content === 'string') el.innerHTML = content;
  else el.append(content);
  document.body.append(el);
  placeNear(el, anchor, opts);
  // Für Bewegungen von außen (z. B. Mathe-Tastatur scrollt den Eintrag)
  el._reposition = () => placeNear(el, anchor, opts);
  let closed = false;
  const onDown = (e) => {
    if (el.contains(e.target)) return;
    // Mathe-Tastatur und ihr Textfeld (iPad) gehören zum Formelfeld im Popover
    if (e.target.closest && e.target.closest('.math-kbd, .math-kbd-show, .math-kbd-text')) return;
    if (opts.keepOn && opts.keepOn.some(k => k && k.contains && k.contains(e.target))) return;
    if (opts.keep && opts.keep(e)) return;
    api.close();
  };
  // Finger und Pencil (iPad): Antippen daneben schließt. Nachgemachte Mausklicks
  // schickt iPadOS nicht immer (z. B. wenn das Antippen erst Knöpfe einblendet) –
  // das Menü bliebe sonst offen stehen. Wischen (Scrollen) und ein aufliegender
  // Handballen schließen nicht.
  let touch = null;
  const onPointer = (e) => { touch = e.pointerType === 'mouse' || isPalm(e) ? null : { e, x: e.clientX, y: e.clientY, at: performance.now() }; };
  const onPointerUp = (e) => {
    const t = touch;
    touch = null;
    if (!t || e.pointerId !== t.e.pointerId || isPalm(e)) return;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 || performance.now() - t.at > 600) return;
    onDown(t.e);
  };
  const onKey = (e) => {
    // Escape im Textfeld der Mathe-Tastatur gilt dem Textfeld, nicht dem Formel-Fenster
    if (e.target && e.target.closest && e.target.closest('.math-kbd-text')) return;
    if (e.key === 'Escape' && openPopovers[openPopovers.length - 1] === api) {
      e.preventDefault();
      e.stopPropagation();
      api.close();
    }
  };
  const api = {
    el,
    close() {
      if (closed) return;
      closed = true;
      el.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('keydown', onKey, true);
      const i = openPopovers.indexOf(api);
      if (i >= 0) openPopovers.splice(i, 1);
      opts.onClose && opts.onClose();
    },
    reposition() { placeNear(el, anchor, opts); },
    get closed() { return closed; }
  };
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('pointerup', onPointerUp, true);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  openPopovers.push(api);
  return api;
}

// ---------------------------------------------------------------------------
// Menüs mit Tastatursteuerung und Untermenüs
// items: [{label, icon, hint, onSelect, danger, disabled, checked, submenu: items}, '-', {section: 'Titel'}]
// ---------------------------------------------------------------------------

export function menu(anchor, items, opts = {}) {
  const list = h('div', { class: 'menu-list', role: 'menu' });
  const entries = [];
  let sub = null;
  // Klicks im offenen Untermenü dürfen dieses Menü nicht schließen
  const inSub = { contains: (t) => !!(sub && !sub.closed && sub.el.contains(t)) };
  const pop = popover(anchor, list, { ...opts, keepOn: [...(opts.keepOn || []), inSub], class: 'menu ' + (opts.class || ''), onClose: () => { sub && sub.close(); opts.onClose && opts.onClose(); } });
  let active = -1;
  const setActive = (i) => {
    entries.forEach((e, k) => e.el.classList.toggle('on', k === i));
    active = i;
    if (i >= 0) entries[i].el.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    const e = entries[i];
    if (!e || e.item.disabled) return;
    if (e.item.submenu) { openSub(i); return; }
    pop.close();
    if (opts.closeParent) opts.closeParent();
    e.item.onSelect && e.item.onSelect();
  };
  const openSub = (i) => {
    sub && sub.close();
    const e = entries[i];
    sub = menu(e.el.getBoundingClientRect(), e.item.submenu, { side: 'right', keepOn: [pop.el], closeParent: () => pop.close() });
  };
  for (const item of items) {
    if (!item) continue;
    if (item === '-') { list.append(h('div', { class: 'menu-sep' })); continue; }
    if (item.section) { list.append(h('div', { class: 'menu-section', text: item.section })); continue; }
    if (item.custom) { list.append(item.custom); continue; }
    const el = h('div', { class: 'menu-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : ''), role: 'menuitem' });
    el.innerHTML = (item.icon ? icon(item.icon) : '') + (item.html || '') + `<span class="lbl">${esc(item.label)}</span>` +
      (item.checked ? icon('check', 'check sm') : '') +
      (item.hint ? `<span class="hint">${esc(item.hint)}</span>` : '') +
      (item.submenu ? icon('chevronRight', 'sub-arrow sm') : '');
    const idx = entries.length;
    el.addEventListener('mouseenter', () => { setActive(idx); if (item.submenu) openSub(idx); else if (sub) { sub.close(); sub = null; } });
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => choose(idx));
    entries.push({ el, item });
    list.append(el);
  }
  pop.reposition();
  const onKey = (e) => {
    if (pop.closed) { document.removeEventListener('keydown', onKey, true); return; }
    if (sub && !sub.closed) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((active + 1) % entries.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((active - 1 + entries.length) % entries.length); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); e.stopPropagation(); choose(active); } }
    else if (e.key === 'ArrowRight' && active >= 0 && entries[active].item.submenu) { e.preventDefault(); openSub(active); }
    else if (e.key === 'ArrowLeft' && opts.side === 'right') { e.preventDefault(); pop.close(); }
  };
  document.addEventListener('keydown', onKey, true);
  const origClose = pop.close;
  pop.close = () => { document.removeEventListener('keydown', onKey, true); origClose(); };
  if (opts.focusFirst) setActive(0);
  return pop;
}

// ---------------------------------------------------------------------------
// Dialoge
// ---------------------------------------------------------------------------

export function dialog({ title, description, body, actions = [], class: cls = '', onClose, onEscape, center = false, dismissable = true }) {
  const overlay = h('div', { class: 'overlay' + (center ? ' center' : '') });
  const box = h('div', { class: 'dialog ' + cls, role: 'dialog' });
  if (title || description) {
    const head = h('div', { class: 'dialog-head' });
    if (title) head.append(h('h2', { text: title }));
    if (description) head.append(h('p', { text: description }));
    box.append(head);
  }
  if (body) {
    const b = h('div', { class: 'dialog-body' });
    b.append(body);
    box.append(b);
  }
  if (actions.length) {
    const foot = h('div', { class: 'dialog-foot' });
    for (const a of actions) {
      const btn = h('button', { class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'outline danger' : 'outline') }, a.label);
      btn.addEventListener('click', async () => {
        if (a.onClick) {
          const r = await a.onClick();
          if (r === false) return;
        }
        api.close(a.value);
      });
      foot.append(btn);
    }
    box.append(foot);
  }
  overlay.append(box);
  document.body.append(overlay);
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      if (document.querySelector('.popover')) return;
      // Der Dialog kann Escape selbst verwenden (z. B. um ein Eingabefeld zu schließen)
      if (onEscape && onEscape() === true) { e.preventDefault(); e.stopPropagation(); return; }
      e.preventDefault();
      api.close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissable) api.close(null); });
  const api = {
    el: box,
    overlay,
    done,
    close(v) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      onClose && onClose(v);
      resolve(v);
    }
  };
  setTimeout(() => {
    const f = box.querySelector('[autofocus], input, textarea, .btn.primary');
    f && f.focus();
  }, 20);
  return api;
}

export function confirmDialog(title, description, { confirm = 'OK', danger = false } = {}) {
  const d = dialog({
    title, description, center: true,
    actions: [
      { label: 'Abbrechen', value: false },
      { label: confirm, value: true, primary: !danger, danger }
    ]
  });
  return d.done.then(v => !!v);
}

export function promptDialog(title, value = '', { placeholder = '', confirm = 'OK', description } = {}) {
  const input = h('input', { class: 'input', value, placeholder });
  let result = null;
  const d = dialog({
    title, description, body: input, center: true,
    actions: [
      { label: 'Abbrechen', value: null },
      { label: confirm, primary: true, onClick: () => { result = input.value; } }
    ]
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); result = input.value; d.close(result); }
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  return d.done.then(v => (v === null ? null : result ?? input.value));
}

// ---------------------------------------------------------------------------
// Meldungen
// ---------------------------------------------------------------------------

let toastHost;
export function toast(message, { type = 'info', action, timeout = 3600 } = {}) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts' }); document.body.append(toastHost); }
  const el = h('div', { class: 'toast ' + type });
  const ic = type === 'error' ? 'alert' : type === 'success' ? 'check' : type === 'busy' ? null : 'info';
  if (type === 'busy') el.append(h('div', { class: 'spinner' }));
  else el.insertAdjacentHTML('beforeend', icon(ic));
  el.append(h('span', { text: message }));
  if (action) {
    const b = h('button', { class: 'btn sm outline' }, action.label);
    b.addEventListener('click', () => { action.onClick(); remove(); });
    el.append(b);
  }
  toastHost.append(el);
  let timer = timeout ? setTimeout(remove, timeout) : null;
  function remove() { clearTimeout(timer); el.remove(); }
  return { close: remove, update(msg) { el.querySelector('span').textContent = msg; } };
}

// ---------------------------------------------------------------------------
// Tooltips für alles mit data-tip
// ---------------------------------------------------------------------------

let tipEl = null, tipTimer = null, tipTarget = null;
export function initTooltips() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    tipTarget = t;
    tipTimer = setTimeout(() => {
      tipEl = h('div', { class: 'tooltip' });
      tipEl.textContent = t.dataset.tip;
      if (t.dataset.kbd) tipEl.append(h('span', { class: 'kbd-hint', text: t.dataset.kbd }));
      document.body.append(tipEl);
      placeNear(tipEl, t, { side: t.dataset.tipSide || 'bottom', align: 'center', gap: 6 });
    }, 450);
  });
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('keydown', hideTip, true);
}
function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (tipEl) { tipEl.remove(); tipEl = null; }
}

// ---------------------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------------------

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const isMac = /Mac/.test(navigator.platform) || true;
export const mod = (e) => e.metaKey || e.ctrlKey;

export function formatDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso);
  const opts = { day: 'numeric', month: 'long', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', opts);
}

export function relativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.round(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.round(diff / 3600)} Std.`;
  if (diff < 86400 * 7) return `vor ${Math.round(diff / 86400)} Tagen`;
  return formatDate(iso);
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Natürliche Sortierung: "1.2" vor "1.10", "Kapitel 2" vor "Kapitel 10"
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
export function naturalCompare(a, b) { return collator.compare(a, b); }
