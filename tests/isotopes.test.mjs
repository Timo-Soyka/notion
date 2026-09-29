// Tests für Isotope: Ausrichtung in Formeln und Prüfen von Kernreaktionen
import { alignPrescripts, checkNuclear, ATOMIC_NUMBER, hasNuclide } from '../web/js/core/isotopes.js';
import { checkEquation } from '../web/js/core/chem.js';
import { toLatex } from '../web/js/core/typstmath.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};

eq('ordnungszahlen', [ATOMIC_NUMBER.H, ATOMIC_NUMBER.C, ATOMIC_NUMBER.U, ATOMIC_NUMBER.Og], [1, 6, 92, 118]);

// Formeln
eq('nuklid', alignPrescripts('{}^{14}_{6}C'), '{}^{14}_{\\hphantom{1}6}\\mathrm{C}');
eq('mathlive-reihenfolge', alignPrescripts('{}_6^{14}C'), '{}^{14}_{\\hphantom{1}6}\\mathrm{C}');
eq('gleich lang', alignPrescripts('{}^{12}_{11}Na'), '{}^{12}_{11}\\mathrm{Na}');
eq('elektron', alignPrescripts('{}^{0}_{-1}e'), '{}^{\\hphantom{-}0}_{-1}\\mathrm{e}');
eq('schon aufrecht', alignPrescripts('{}^{235}_{92}\\mathrm{U}'), '{}^{235}_{\\hphantom{2}92}\\mathrm{U}');
eq('in gleichung', alignPrescripts('{}^{1}_{0}n+{}^{235}_{92}U\\rightarrow x'), '{}^{1}_{0}\\mathrm{n}+{}^{235}_{\\hphantom{2}92}\\mathrm{U}\\rightarrow x');
eq('nach quad', alignPrescripts('a\\quad {}^{4}_{2}He'), 'a\\quad {}^{4}_{2}\\mathrm{He}');
eq('nur hochzahl bleibt', alignPrescripts('{}^{14}C'), '{}^{14}C');
eq('grad bleibt', alignPrescripts('90{}^{\\circ}'), '90{}^{\\circ}');
eq('bruch bleibt', alignPrescripts('\\frac{}{}^{2}_{3}'), '\\frac{}{}^{2}_{3}');
eq('buchstaben nur ausrichten', alignPrescripts('{}^{ab}_{c}T'), '{}^{ab}_{\\hphantom{a}c}T');
eq('ohne sockel unverändert', alignPrescripts('x^{2}_{1}'), 'x^{2}_{1}');

// Automatische Erkennung: geschweifte Klammern an Skripten sind LaTeX, Mengen bleiben Typst
eq('erkennung', ['x^{12}', '{}_6^{14}C', 'a_{n+1}'].map(x => toLatex(x)), ['x^{12}', '{}_6^{14}C', 'a_{n+1}']);
eq('menge bleibt typst', toLatex('x in {1, 2}'), 'x\\in\\{1,2\\}');

// Typst: attach
eq('typst attach', toLatex('attach(upright(C), tl: 14, bl: 6)'), '{}^{14}_{6}\\mathrm{C}');
eq('typst attach rechts', toLatex('attach(X, tr: 2, br: i)'), '{X}^{2}_{i}');
eq('typst attach ganz', alignPrescripts(toLatex('attach(U, tl: 235, bl: 92)')), '{}^{235}_{\\hphantom{2}92}\\mathrm{U}');

// Kernreaktionen
eq('erkannt', [hasNuclide('^{14}_{6}C'), hasNuclide('2H2 + O2 -> 2H2O')], [true, false]);
eq('alpha-zerfall', checkNuclear('^{238}_{92}U -> ^{234}_{90}Th + ^{4}_{2}He'), { balanced: true, mass: [238, 238], charge: [92, 92], wrong: [] });
eq('spaltung', checkNuclear('^{235}_{92}U + ^{1}_{0}n -> ^{141}_{56}Ba + ^{92}_{36}Kr + 3 ^{1}_{0}n').balanced, true);
eq('beta', checkNuclear('^{14}_{6}C -> ^{14}_{7}N + ^{0}_{-1}e').balanced, true);
eq('beta kurz', checkNuclear('^{14}_{6}C -> ^{14}_{7}N + e^- + \\bar{\\nu}').balanced, true);
eq('gamma', checkNuclear('^{60}_{28}Ni -> ^{60}_{28}Ni + \\gamma').balanced, true);
eq('ohne klammern', checkNuclear('^235_92U + n -> ^236_92U').balanced, true);
const bad = checkNuclear('^{238}_{92}U -> ^{234}_{90}Th + ^{3}_{2}He');
eq('falsch', [bad.balanced, bad.mass], [false, [238, 237]]);
eq('falsche ordnungszahl', checkNuclear('^{14}_{7}C -> ^{14}_{7}N + ^{0}_{-1}e').wrong, [{ sym: 'C', Z: 7, expected: 6 }]);
eq('ladung', checkNuclear('^{4}_{2}He^{2+} -> ^{4}_{2}He^{2+}').balanced, true);

// In der normalen Gleichungsprüfung
const c = checkEquation('^{238}_{92}U -> ^{234}_{90}Th + ^{4}_{2}He');
eq('checkEquation kern', [c.nuclear, c.balanced], [true, true]);
eq('checkEquation chemie unverändert', checkEquation('2H2 + O2 -> 2H2O').balanced, true);

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
