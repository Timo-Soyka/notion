// Finger und Apple Pencil auf dem iPad.
//
// Die Oberfläche ist für Maus und Trackpad gebaut. Hier wird ergänzt, was
// iPadOS von sich aus nicht übersetzt:
//   • Ziehgriffe (Block verschieben, Bild-/Spaltenbreite, Graphgröße,
//     Seitenleiste): Ziehen mit Finger oder Stift wird zu Mausziehen.
//   • Lange drücken öffnet das Kontextmenü (Seitenleiste, Spaltengriffe …).
//   • Doppeltippen auf Griffe wirkt wie Doppelklick.

const DRAG = '.blk-handle .grip, .sidebar-resizer, .tcol-resize, .col-resize, .plot-resize, .img-handle, .blk.editing .plot-svg';
const CONTEXT = '.tree-row, .tcol-resize, .col-resize, .blk-text .am';
const DOUBLE = '.tcol-resize, .col-resize, .plot-resize, .img-handle';
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
    if (e.pointerType === 'mouse' || drag) return;
    const t = e.target.closest && e.target.closest(DRAG);
    if (!t) return;
    // Verhindert die nachgemachten Mausereignisse von iPadOS (sonst doppelt)
    e.preventDefault();
    drag = { id: e.pointerId, target: t };
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
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);

  // --- Lange drücken = Kontextmenü ---
  let press = null;
  let swallowClick = false;
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    cancelPress();
    const t = e.target.closest && e.target.closest(CONTEXT);
    if (!t) return;
    const start = { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
    press = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        if (drag && drag.target === t) { fire(t, 'mouseup', start); drag = null; }
        if (!fire(t, 'contextmenu', start)) swallowClick = true;
      }, LONG_PRESS_MS)
    };
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  }, true);
  window.addEventListener('pointerup', cancelPress, true);
  window.addEventListener('pointercancel', cancelPress, true);
  document.addEventListener('dragstart', cancelPress, true);
  document.addEventListener('scroll', cancelPress, true);
  // Nach dem Menü nicht auch noch den Eintrag öffnen
  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // --- Doppeltippen auf Griffe ---
  let lastTap = null;
  let lastSynth = 0;
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
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
