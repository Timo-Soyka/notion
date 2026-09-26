// Ablage nach Fach und Thema.
//
// Ein Fach hat einen Ordner (z. B. „2026/27 / Mathe“), darin meist
// „Hefteinträge“. Darunter liegen die Themen – so tief verschachtelt, wie man
// möchte: „1 Reelle Zahlen / 1.1 Quadratzahlen / …“. Die Nummer eines Eintrags
// setzt sich aus den Themennummern zusammen und nimmt dahinter den nächsten
// freien Platz: im Unterthema 1.1 mit einem Eintrag also 1.1.2.
// Themen und Einträge teilen sich die Plätze einer Ebene, damit „1.2“ nie
// gleichzeitig ein Unterthema und ein Eintrag ist.

// Führende Nummer eines Namens: „1.2 Wurzeln“ → „1.2“, „2026/27“ → null
export function leadNumber(name) {
  const m = /^\s*(\d+(?:\.\d+)*)\.?(?:[\s)_-]|$)/.exec(String(name || ''));
  return m ? m[1] : null;
}

// Nummer ohne führende Nummer: „1.2 Wurzeln“ → „Wurzeln“
export function stripLead(name) {
  const s = String(name || '');
  return leadNumber(s) ? s.replace(/^\s*\d+(?:\.\d+)*\.?[\s)_-]*/, '') : s;
}

// Themennummer aus den Ordnernamen von oben nach unten.
// Unterthemen dürfen relativ („1 Quadratzahlen“) oder vollständig („1.1 Quadratzahlen“) heißen.
export function topicChain(names) {
  let chain = '';
  for (const n of names) {
    const lead = leadNumber(n);
    if (!lead) continue;
    if (chain && lead.startsWith(chain + '.')) chain = lead;
    else if (lead.includes('.')) chain = lead;
    else chain = chain ? `${chain}.${lead}` : lead;
  }
  return chain;
}

// Belegter Platz eines Namens auf der Ebene unter `chain` (oder null)
export function slotOf(name, chain) {
  const lead = leadNumber(name);
  if (!lead) return null;
  if (!chain) return parseInt(lead, 10);
  if (lead.startsWith(chain + '.')) return parseInt(lead.slice(chain.length + 1), 10);
  if (!lead.includes('.')) return parseInt(lead, 10);  // relativ benanntes Unterthema
  return null;
}

// Nächster freier Platz: eins mehr als der höchste belegte
export function nextSlot(names, chain) {
  let max = 0;
  for (const n of names) {
    const s = slotOf(n, chain);
    if (Number.isFinite(s)) max = Math.max(max, s);
  }
  return max + 1;
}

export const joinNumber = (chain, slot) => (chain ? `${chain}.${slot}` : String(slot));

// Ordner, in dem die Hefteinträge eines Fachs liegen
export const isEntriesFolder = (name) => /^\s*(\d+[\s._-]*)?hefte?(einträge|eintraege)?\s*$/i.test(String(name || ''));
