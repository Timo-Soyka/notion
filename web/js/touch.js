// Finger und Apple Pencil auf dem iPad.
//
// Die Oberfläche ist für Maus und Trackpad gebaut. Hier wird ergänzt, was
// iPadOS von sich aus nicht übersetzt:
//   • Ziehgriffe (Block verschieben, Bild-/Spaltenbreite, Graphgröße,
//     Seitenleiste): Ziehen mit Finger oder Stift wird zu Mausziehen.
//   • Lange drücken öffnet das Kontextmenü (Seitenleiste, Spaltengriffe …).
//   • Doppeltippen auf Griffe wirkt wie Doppelklick.
// Berührungen vom Handballen (palm.js) lösen nichts davon aus.

import { isPalm, onPenDown } from './palm.js';

// (Der Block-Griff ⋮⋮ hat in editor/dnd.js eine eigene Behandlung für Finger und Pencil)
const DRAG = '.sidebar-resizer, .tcol-resize, .col-resize, .plot-resize, .img-handle, .blk.editing .plot-svg';
const CONTEXT = '.tree-row, .tcol-resize, .col-resize, .blk-text .am';
const DOUBLE = '.tcol-resize, .col-resize, .plot-resize, .img-handle, .imged-stage canvas';
const LONG_PRESS_MS = 480;

function fire(target, type, src, extra = {}) {
  const ev = new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: src.clientX, clientY: src.clientY, screenX: src.screenX, screenY: src.screenY,
    button: type === 'contextmenu' ? 2 : 0, buttons: type === 'mouseup' || type === 'dblclick' ? 0 : type === 'contextmenu' ? 2 : 1,
    altKey: src.altKey, shiftKey: src.shiftKey, metaKey: src.metaKey, ctrlKey: src.ctrlKey, ...extra
  });
  ev.heftTouch = true;
  return target.dispatchEvent(ev);
}

export function installTouch() {
  // --- Ziehgriffe ---
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || drag || isPalm(e)) return;
    const t = e.target.closest && e.target.closest(DRAG);
    if (!t) return;
    // Verhindert die nachgemachten Mausereignisse von iPadOS (sonst doppelt)
    e.preventDefault();
    drag = { id: e.pointerId, target: t, touch: e.pointerType === 'touch', start: { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY } };
    fire(t, 'mousedown', e);
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    fire(document.elementFromPoint(e.clientX, e.clientY) || drag.target, 'mousemove', e);
  }, { capture: true, passive: false });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const t = document.elementFromPoint(e.clientX, e.clientY) || drag.target;
    drag = null;
    fire(t, 'mouseup', e);
  };
  // Abgebrochen (iPadOS hat den Handballen erkannt, oder der Pencil setzt
  // auf): zurück zum Ausgangspunkt, damit sich nichts verändert
  const abortDrag = () => {
    if (!drag) return;
    const { target, start } = drag;
    drag = null;
    fire(target, 'mousemove', start);
    fire(target, 'mouseup', start);
  };
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) abortDrag(); }, true);
  onPenDown(() => { if (drag && drag.touch) abortDrag(); });

  // --- Lange drücken = Kontextmenü ---
  // Das Menü kommt beim Loslassen: So bleibt Halten und Ziehen frei für das
  // Verschieben (Seitenleiste), und iPadOS schließt das Menü nicht gleich wieder.
  let press = null;
  let swallowUntil = 0;
  const cancelPress = () => { press = null; };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (isPalm(e)) { press = null; return; }
    const t = e.target.closest && e.target.closest(CONTEXT);
    press = t ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), t } : null;
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  }, true);
  window.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || e.pointerId !== p.id || performance.now() - p.at < LONG_PRESS_MS) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
    if (drag && drag.target === p.t) { fire(p.t, 'mouseup', e); drag = null; }
    // Nachgemachte Maus-Ereignisse (Antippen) würden das Menü sofort wieder schließen
    swallowUntil = performance.now() + 700;
    fire(p.t, 'contextmenu', { clientX: p.x, clientY: p.y, screenX: e.screenX, screenY: e.screenY });
  }, true);
  window.addEventListener('pointercancel', cancelPress, true);
  onPenDown((e) => { if (press && press.id !== e.pointerId) cancelPress(); });
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (e) => {
      if (e.heftTouch || performance.now() > swallowUntil) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // --- Unsichtbare und eben erst erschienene Knöpfe ---
  // Am Mac erscheinen viele Knöpfe erst beim Darüberfahren (⋮⋮ und + neben
  // Blöcken, „Zeile anfügen“ an Tabellen, Knöpfe in der Seitenleiste …). Auf
  // dem iPad kommen Darüberfahren und Klick im selben Antippen – man träfe
  // Knöpfe, die man gar nicht gesehen hat, und bekäme neue Blöcke, Zeilen oder
  // markierte Blöcke. Solche Klicks zählen nicht; das Antippen zeigt die
  // Knöpfe nur, das nächste Antippen trifft sie dann.
  const CONTROL = 'button, a[href], [role="button"], .table-add, .img-handle, .plot-resize, .col-resize, .tcol-resize';
  let tap = null;
  const shown = (el) => {
    for (let x = el; x && x.nodeType === 1 && x !== document.body; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.2) return false;
    }
    return true;
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') { tap = null; return; }
    // Mathe-Tastatur: immer sichtbar, und jedes Nachrechnen bremst schnelles Tippen
    if (e.target.closest && e.target.closest('.math-kbd, .math-kbd-show')) { tap = null; return; }
    const ctl = e.target.closest && e.target.closest(CONTROL);
    tap = { target: e.target, ctl, visible: !ctl || shown(ctl), until: 0 };
  }, true);
  window.addEventListener('pointerup', (e) => { if (tap && e.pointerType !== 'mouse') tap.until = performance.now() + 800; }, true);
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (e) => {
      if (e.heftTouch || !tap || performance.now() > tap.until) return;
      const ctl = e.target.closest && e.target.closest(CONTROL);
      if (!ctl) return;
      if ((tap.ctl === ctl || ctl.contains(tap.target)) && tap.visible) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // --- Doppeltippen auf Griffe ---
  let lastTap = null;
  let lastSynth = 0;
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    if (isPalm(e)) { lastTap = null; return; }
    const t = e.target.closest && e.target.closest(DOUBLE);
    if (!t) { lastTap = null; return; }
    const now = performance.now();
    if (lastTap && lastTap.target === t && now - lastTap.time < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
      lastTap = null;
      lastSynth = now;
      fire(t, 'dblclick', e, { detail: 2 });
    } else {
      lastTap = { target: t, time: now, x: e.clientX, y: e.clientY };
    }
  }, true);
  // Falls iPadOS selbst auch einen Doppelklick meldet: nur einmal auswerten
  document.addEventListener('dblclick', (e) => {
    if (!e.heftTouch && performance.now() - lastSynth < 600) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
