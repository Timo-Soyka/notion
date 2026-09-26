// Tests für die Ablage nach Fach und Thema
import { leadNumber, stripLead, topicChain, slotOf, nextSlot, joinNumber, isEntriesFolder } from '../web/js/core/filing.js';
import { nextEntryNumber } from '../web/js/core/numbering.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};

eq('lead', ['1 Reelle Zahlen', '1.1.2 Test', '1. Thema', '2026/27', 'Mathe', '10a Aufgabe', '3'].map(leadNumber), ['1', '1.1.2', '1', null, null, null, '3']);
eq('strip', ['1.2 Wurzeln', 'Mathe', '1. Thema'].map(stripLead), ['Wurzeln', 'Mathe', 'Thema']);
eq('kette relativ', topicChain(['1 Reelle Zahlen', '1 Quadratzahlen']), '1.1');
eq('kette voll', topicChain(['2 Funktionen', '2.3 Parabeln']), '2.3');
eq('kette tief', topicChain(['1 A', '2 B', '1 C']), '1.2.1');
eq('kette ohne nummer', topicChain(['Hefteinträge', '3 Geometrie', 'Zusatz']), '3');
eq('kette leer', topicChain(['Hefteinträge']), '');
eq('platz', [slotOf('1.1.2 X', '1.1'), slotOf('3 Unterthema', '1.1'), slotOf('2.4 X', '1.1'), slotOf('Ohne', '1')], [2, 3, null, null]);
// Beispiel von Timo: erstes Thema, Unterthema 1, zweiter Eintrag
eq('1.1.2', joinNumber('1.1', nextSlot(['1.1.1 Quadratzahlen'], '1.1')), '1.1.2');
eq('erster eintrag', joinNumber('1.1', nextSlot([], '1.1')), '1.1.1');
// Themen und Einträge teilen sich die Plätze einer Ebene
eq('geteilte plätze', joinNumber('1', nextSlot(['1 Quadratzahlen', '1.2 Test'], '1')), '1.3');
eq('lücke bleibt', nextSlot(['1.1 A', '1.3 C'], '1'), 4);
eq('oberste ebene', joinNumber('', nextSlot(['1 Reelle Zahlen', '2 Funktionen', 'Arbeitsblätter'], '')), '3');
eq('einträge-ordner', ['Hefteinträge', 'Hefteintraege', 'Heft', '01 Hefteinträge', 'Hausaufgaben', 'Heftung'].map(isEntriesFolder), [true, true, true, true, false, false]);
eq('nextEntry kapitel', nextEntryNumber(['1.1.1 A'], '1.1', 'chapter'), '1.1.2');
eq('nextEntry ordnername', nextEntryNumber(['1.1 A', '1.2 B'], '1 Reelle Zahlen', 'chapter'), '1.3');
eq('nextEntry ohne thema', nextEntryNumber(['1 A', '2 B'], '', 'chapter'), '3');

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
