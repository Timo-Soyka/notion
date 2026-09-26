// Tests für die Typst→LaTeX-Übersetzung – Beispiele aus Timos Hefteinträgen.
import assert from 'node:assert/strict';
import { toLatex } from '../web/js/core/typstmath.js';

const cases = [
  ['a^b &= c \\ root(b, c) &= a', '\\begin{aligned} a^{b} &= c \\\\ \\sqrt[b]{c} &= a \\end{aligned}'],
  ['0,16 + root(2, 0.16) = 0,16 + 0,4 = 0,56', '0{,}16 + \\sqrt{0.16} = 0{,}16 + 0{,}4 = 0{,}56'],
  ['root(2, 9/16) - root(2, root(2, 81)) = 3/4 - 9', '\\sqrt{\\frac{9}{16}} - \\sqrt{\\sqrt{81}} = \\frac{3}{4} - 9'],
  ['z^2 -9 &= 16 &|+9 \\ z^2 &= 25 &|root(2, ~) \\ z &= 5', '\\begin{aligned} z^{2} -9 &= 16 &|+9 \\\\ z^{2} &= 25 &|\\sqrt{~} \\\\ z &= 5 \\end{aligned}'],
  ['(0,96"dm"^2):6 = 0,16"dm"^2', '(0{,}96\\text{dm}^{2}):6 = 0{,}16\\text{dm}^{2}'],
  ['i^2=-1', 'i^{2}=-1'],
  ['sum_(i=1)^n i = (n(n+1))/2', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}'],
  ['lim_(x -> 0) sin(x)/x = 1', '\\lim_{x \\rightarrow 0} \\frac{\\sin(x)}{x} = 1'],
  ['E_kin = 1/2 m v^2', 'E_{\\mathrm{kin}} = \\frac{1}{2} m v^{2}'],
  ['ce("2H2 + O2 -> 2H2O")', '\\ce{2H2 + O2 -> 2H2O}'],
  ['x in RR, x != 0', 'x \\in \\mathbb{R}, x \\neq 0'],
  ['100 "°C"', '100\\,\\text{°C}'],
  ['mat(1, 2; 3, 4)', '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'],
  ['root(2, 0,16) = 0,4', '\\sqrt{0{,}16} = 0{,}4'],
  ['mat(1,2;3,4)', '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'],
  ['vec(a, b)', '\\begin{pmatrix} a \\\\ b \\end{pmatrix}'],
  ['f(x)/2', '\\frac{f(x)}{2}'],
  ['e^(-x^2)', 'e^{-x^{2}}'],
  ['x^-1', 'x^{-1}'],
  ['alpha + beta = gamma', '\\alpha + \\beta = \\gamma'],
  ['2 pi r', '2 \\pi r'],
  ['3 dot 4 times 5', '3 \\cdot 4 \\times 5'],
  ['A => B <=> C', 'A \\Rightarrow B \\Leftrightarrow C'],
  ['abs(x - 1)', '\\left| x - 1 \\right|'],
  ['\\frac{1}{2}', '\\frac{1}{2}'],
  ['"Buch" &"Seite 8 Nummer 10; 12" \\ &"Seite" 9 "Nummer 18"', '\\begin{aligned} \\text{Buch} &\\text{Seite 8 Nummer 10; 12} \\\\ &\\text{Seite}\\ 9\\ \\text{Nummer 18} \\end{aligned}'],
];

// Leerzeichen sind für LaTeX meist bedeutungslos – nur die nach \befehl zählen.
const norm = (s) => s.replace(/\\ /g, '\u0001').replace(/(\\[a-zA-Z]+) +(?=[a-zA-Z])/g, '$1\u0002').replace(/ /g, '').replace(/\u0001/g, '\\ ').replace(/\u0002/g, ' ');
let fail = 0;
for (const [src, exp] of cases) {
  const got = toLatex(src);
  try { assert.equal(norm(got), norm(exp)); }
  catch { fail++; console.log('✗', JSON.stringify(src), '\n   erwartet', exp, '\n   bekommen', got); }
}
console.log(`${cases.length - fail} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
