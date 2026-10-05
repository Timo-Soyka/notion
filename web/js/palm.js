// Handballen-Erkennung (iPad).
//
// Wer mit dem Apple Pencil schreibt, legt die Hand aufs Display – bei
// Linkshändern links neben der Schrift, also genau auf die Griffe ⋮⋮ und die
// Seitenleiste. iPadOS filtert den Handballen nur teilweise heraus. Deshalb gilt:
//   • Solange der Pencil auf dem Display ist und kurz danach zählen
//     Berührungen mit dem Finger nicht.
//   • Liegt ein Finger schon auf, wenn der Pencil aufsetzt, war es der
//     Handballen: Laufende Finger-Aktionen (Ziehen, langes Drücken) brechen ab,
//     und die nachgemachten Klicks von iPadOS an dieser Stelle verfallen.

const AFTER_PEN_MS = 1000;
const CLICK_WINDOW_MS = 800;

let penDown = 0;
let lastPen = -Infinity;
const listeners = new Set();
const touches = new Map();      // Finger auf dem Display: pointerId → {x, y}
const palmIds = new Set();      // davon als Handballen erkannt
let palmSpots = [];             // wo ein Handballen losgelassen hat: {x, y, until}

// Wird gerade (oder eben noch) mit dem Pencil geschrieben?
export const penActive = () => penDown > 0 || performance.now() - lastPen < AFTER_PEN_MS;

// Berührung, die vermutlich vom Handballen kommt
export const isPalm = (e) => e.pointerType === 'touch' && (palmIds.has(e.pointerId) || penActive());

// Aufruf, sobald der Pencil aufsetzt; gibt eine Abmeldefunktion zurück
export function onPenDown(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function watchPalm() {
  // Fensterebene, Erfassungsphase: vor allen anderen Behandlungen
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (penActive()) palmIds.add(e.pointerId);
      return;
    }
    if (e.pointerType !== 'pen') return;
    penDown++;
    lastPen = performance.now();
    for (const id of touches.keys()) palmIds.add(id);
    for (const f of listeners) { try { f(e); } catch (err) { console.error(err); } }
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen') lastPen = performance.now();
    else if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }, { capture: true, passive: true });
  const up = (e) => {
    if (e.pointerType === 'pen') {
      penDown = Math.max(0, penDown - 1);
      lastPen = performance.now();
      return;
    }
    if (e.pointerType !== 'touch') return;
    touches.delete(e.pointerId);
    if (!palmIds.delete(e.pointerId)) return;
    const now = performance.now();
    palmSpots = palmSpots.filter(s => s.until > now);
    palmSpots.push({ x: e.clientX, y: e.clientY, until: now + CLICK_WINDOW_MS });
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);

  // Nachgemachte Mausereignisse und Klicks vom Handballen verwerfen
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, (e) => {
      if (e.heftTouch || !palmSpots.length) return;
      const now = performance.now();
      if (palmSpots.some(s => s.until > now && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 40)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }
}
