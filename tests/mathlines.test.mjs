// Tests für mehrzeilige Formeln mit Ausrichtungspunkten
import { latexToLines, linesToLatex, cleanFieldLatex, needsSource, repairLatex } from '../web/js/core/mathlines.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};

// Einzeilig ohne Punkte bleibt unverändert
eq('einfach', linesToLatex(['x^2+1']), 'x^2+1');
eq('einfach zurück', latexToLines('x^2+1'), ['x^2+1']);
eq('leer', linesToLatex(['', '']), '');

// Eine ID → aligned
const two = linesToLatex(['x\\heftmark{1}=2+3', '\\heftmark{1}=5']);
eq('aligned', two, '\\begin{aligned}\nx &=2+3 \\\\\n&=5\n\\end{aligned}');
eq('aligned zurück', latexToLines(two), ['x\\heftmark{1}=2+3', '\\heftmark{1}=5']);

// Mehrere IDs → alignedat, IDs bleiben erhalten (auch Lücken)
const multi = linesToLatex(['a\\heftmark{1}=b\\heftmark{3}+c', 'dd\\heftmark{1}=e']);
eq('alignedat', multi, '\\begin{alignedat}{3}\na &=b &&&&+c \\\\\ndd &=e\n\\end{alignedat}');
eq('alignedat zurück', latexToLines(multi), ['a\\heftmark{1}=b\\heftmark{3}+c', 'dd\\heftmark{1}=e']);

// Mehrere Zeilen ohne Punkte → gathered
eq('gathered', linesToLatex(['a=1', 'b=2']), '\\begin{gathered}\na=1 \\\\\nb=2\n\\end{gathered}');
eq('gathered zurück', latexToLines('\\begin{gathered}\na=1 \\\\\nb=2\n\\end{gathered}'), ['a=1', 'b=2']);

// Alte Schreibweise ohne Umgebung und mit Matrizen (deren & nicht zählen)
eq('alt', latexToLines('a &= b \\\\ &= c'), ['a\\heftmark{1}= b', '\\heftmark{1}= c']);
eq('matrix', latexToLines('A &= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'), ['A\\heftmark{1}= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}']);
eq('matrix hin', linesToLatex(['A\\heftmark{1}=\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}']), '\\begin{aligned}\nA &=\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\n\\end{aligned}');

// Punkte in Klammern/Brüchen und absteigende IDs werden ignoriert
eq('verschachtelt', linesToLatex(['\\frac{a\\heftmark{1}}{b}=c']), '\\frac{a}{b}=c');
eq('absteigend', linesToLatex(['a\\heftmark{2}=b\\heftmark{1}=c']), '\\begin{alignedat}{2}\na &&&=b =c\n\\end{alignedat}');

// aligned mit Paaren (x &= 1 & y &= 2)
eq('paare', latexToLines('\\begin{aligned} x &= 1 & y &= 2 \\end{aligned}'), ['x\\heftmark{1}= 1 y\\heftmark{2}= 2']);

// Platzhalter aus dem Formelfeld
eq('platzhalter', cleanFieldLatex('\\sqrt{\\placeholder{}}+\\frac{\\placeholder{}}{2}'), '\\sqrt{}+\\frac{}{2}');
eq('quelltext', [needsSource('\\ce{H2O}'), needsSource('\\frac12')], [true, false]);

// Einheiten und Tottasten-Reste
eq('einheit', repairLatex('0{,}96"dm"\\2'), '0{,}96\\text{dm}^{2}');
eq('matrix bleibt', repairLatex('\\begin{pmatrix}1\\\\2\\end{pmatrix}'), '\\begin{pmatrix}1\\\\2\\end{pmatrix}');
eq('links', linesToLatex(['a=1', '=2'], { left: true }), '\\begin{aligned}\n&a=1 \\\\\n&=2\n\\end{aligned}');

// Kommandostrich (Äquivalenzumformung)
const um = linesToLatex(['2x+3\\heftmark{1}=7\\heftbar -3', 'x\\heftmark{1}=2']);
eq('kommandostrich', um, '\\begin{alignedat}{2}\n2x+3 &=7 &\\qquad &\\vert\\; -3 \\\\\nx &=2\n\\end{alignedat}');
eq('kommandostrich zurück', latexToLines(um), ['2x+3\\heftmark{1}=7\\heftbar -3', 'x\\heftmark{1}=2']);
eq('ohne punkte', latexToLines(linesToLatex(['x^2=16\\heftbar \\surd', 'x=4'])), ['\\heftmark{1}x^2=16\\heftbar \\surd', '\\heftmark{1}x=4']);
eq('betrag bleibt', latexToLines('\\begin{aligned} y &= \\vert x \\vert \\end{aligned}'), ['y\\heftmark{1}= \\vert x \\vert']);

console.log(`${ok} bestanden, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
