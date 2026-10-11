// Modus im Hefteintrag (iPad): Schreiben oder Blöcke – streng getrennt.
//
//   • Schreiben (Standard): nur schreiben. Keine Griffe (+ und ⋮⋮), kein
//     Blockmenü, kein Verschieben – weder mit Pencil noch Finger oder Maus.
//     Scribble ist an.
//   • Blöcke: Griffe sichtbar; mit dem Pencil ist der ganze Block Griff –
//     Antippen öffnet das Blockmenü, Ziehen verschiebt. Scribble ist aus
//     (die App nimmt es der Web-Ansicht weg, dazu .pen-grip in editor.css).
//
// Umschalten: Doppeltippen auf den Apple Pencil (die App hört es und meldet
// „pen-mode“) oder der Knopf unten in der Mitte (meldet es der App mit
// „pen.mode“, damit sie Scribble mitschaltet). Arbeitsblätter haben ihr
// eigenes Doppeltippen (PadPDFEditor). Am Mac bleibt alles beim Alten.

import { h, toast, closeAllPopovers } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { on, call, isPad, isNative } from '../bridge.js';

let blocks = false;
let badge = null;

export const penBlocks = () => blocks;
// Ist das Blockmenü samt Griffen gerade gesperrt?
export const writeOnly = () => isPad && !blocks;

function render() {
  const root = document.documentElement;
  root.classList.toggle('pen-blocks', blocks);
  root.classList.toggle('pen-write', !blocks);
  if (!badge) return;
  badge.innerHTML = icon(blocks ? 'grip' : 'pencil', 'sm') + `<span>${blocks ? 'Blöcke' : 'Schreiben'}</span>`;
  badge.dataset.tip = blocks ? 'Antippen: zurück zum Schreiben' : 'Antippen: Blöcke verschieben und Blockmenü';
}

function set(on, { tell = false } = {}) {
  if (on === blocks) return;
  blocks = on;
  // Offenes Textfeld schließen (sonst schreibt man noch hinein) bzw. offene Blockmenüs
  const a = document.activeElement;
  if (on && a && a !== document.body && a.blur) a.blur();
  closeAllPopovers();
  render();
  if (tell && isNative) call('pen.mode', { blocks: on }).catch(() => {});
  toast(on ? 'Blöcke: Antippen öffnet das Menü, Ziehen verschiebt' : 'Schreiben', { timeout: 1600 });
}

if (isPad) {
  on('pen-mode', (p) => set(!!(p && p.blocks)));
  badge = h('button', { class: 'pen-mode-badge' });
  // Nicht den Fokus aus dem Textfeld nehmen; umschalten erst beim Loslassen
  badge.addEventListener('mousedown', (e) => e.preventDefault());
  badge.addEventListener('click', (e) => { e.preventDefault(); set(!blocks, { tell: true }); });
  const mount = () => { document.body.append(badge); render(); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
}
