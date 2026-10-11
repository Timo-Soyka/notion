// Pencil-Modus im Hefteintrag (iPad).
//
// Doppeltippen auf den Apple Pencil wechselt zwischen
//   • Schreiben: wie gewohnt, Scribble schreibt in die Textfelder
//   • Blöcke:    Antippen öffnet das Blockmenü, Ziehen verschiebt den Block;
//                Scribble ist aus (die App nimmt es der Web-Ansicht weg,
//                dazu .pen-grip in editor.css als Rückfall)
// Den Modus führt die App (sie hört das Doppeltippen) und meldet ihn mit
// „pen-mode“. Arbeitsblätter haben ihr eigenes Doppeltippen (PadPDFEditor).

import { h, toast, closeAllPopovers } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { on } from '../bridge.js';

let blocks = false;
let badge = null;

export const penBlocks = () => blocks;

function set(on) {
  if (on === blocks) return;
  blocks = on;
  document.documentElement.classList.toggle('pen-blocks', on);
  if (on) {
    // Offenes Textfeld schließen – sonst schreibt man noch hinein
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    if (!badge) badge = h('div', { class: 'pen-mode-badge', html: icon('grip', 'sm') + '<span>Pencil: Blöcke</span>' });
    document.body.append(badge);
  } else {
    badge && badge.remove();
    closeAllPopovers();
  }
  toast(on ? 'Pencil: Blöcke – Antippen öffnet das Menü, Ziehen verschiebt' : 'Pencil: Schreiben', { timeout: 1800 });
}

on('pen-mode', (p) => set(!!(p && p.blocks)));
