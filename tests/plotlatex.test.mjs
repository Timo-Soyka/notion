// Tests: Formelfeld (LaTeX) ↔ Rechenausdruck für Graphen
import { latexToExpr, exprToLatex } from '../web/js/core/plotlatex.js';
import { parseExpr, compile, splitDefinition, splitCondition, evalCondition } from '../web/js/core/mathexpr.js';

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};
// Wert eines Ausdrucks (Rechts vom "=", ohne Einschränkung) an einer Stelle
const val = (expr, x) => {
  const d = splitDefinition(expr);
  const sc = splitCondition(d.body);
  return Math.round(compile(parseExpr(sc.body, { f: true }), { funcs: { f: (u) => u * u } })(x) * 1e9) / 1e9;
};

eq('einfach', latexToExpr('f(x)=0{,}5x^2'), 'f(x)=0,5x^2');
eq('bruch', val(latexToExpr('f(x)=\\frac{1}{2}x^2+\\frac13'), 2), Math.round((2 + 1 / 3) * 1e9) / 1e9);
eq('wurzel', val(latexToExpr('g(x)=\\sqrt{x}+\\sqrt[3]{x}'), 8), Math.round((Math.sqrt(8) + 2) * 1e9) / 1e9);
eq('betrag', val(latexToExpr('h(x)=\\left|x-1\\right|'), -2), 3);
eq('e und sin', val(latexToExpr('k(x)=\\exponentialE^{x}\\cdot\\sin\\left(x\\right)'), 1), Math.round(Math.E * Math.sin(1) * 1e9) / 1e9);
eq('ableitung', latexToExpr("f^{\\prime}(x)"), "f'(x)");
eq('zweite ableitung', latexToExpr("f^{\\prime\\prime}(x)"), "f''(x)");
eq('integral', latexToExpr('\\int_{0}^{2}f(x)\\,\\mathrm{d}x'), '∫_0^2f(x) dx');
eq('integral wert', val(latexToExpr('\\int_{0}^{2}f(x)\\,\\mathrm{d}x'), 0), 8 / 3 + 0 === 8 / 3 ? Math.round(8 / 3 * 1e9) / 1e9 : 0);
eq('für getippt', latexToExpr('f(x)=x^2fürx<3'), 'f(x)=x^2 für x<3');
eq('für als text', latexToExpr('f(x)=x^2\\text{ für }x\\le3'), 'f(x)=x^2 für x≤3');
eq('mehrere bedingungen', evalCondition(splitCondition(splitDefinition(latexToExpr('f(x)=x^2\\text{ für }x>0;x<4')).body).cond, {}).map(v => [v.lo, v.hi]), [[0, 4]]);
eq('intervall', latexToExpr('f(x)=x\\text{ für }x\\in\\left]0;\\infty\\right['), 'f(x)=x für x∈]0;∞[');
eq('tangente', latexToExpr('\\operatorname{tangente}\\left(f,1\\right)'), 'tangente(f,1)');
// Senkrechte Gerade, eingeschränkt über y
const vert = (tex) => { const d = splitDefinition(latexToExpr(tex)); const sc = splitCondition(d.body, 'y'); return [d.vertical, sc.body, sc.cond && evalCondition(sc.cond, {}).map(v => [v.lo, v.hi, v.loIncl, v.hiIncl])]; };
eq('senkrecht eingeschränkt', vert('x=3\\text{ für }0\\le y\\le4'), [true, '3', [[0, 4, true, true]]]);
eq('senkrecht intervall', vert('x=3\\text{ für }y\\in\\left[0;4\\right['), [true, '3', [[0, 4, true, false]]]);
eq('senkrecht zurück', exprToLatex('x=3 für 0≤y<4'), 'x=3\\text{ für }0 \\le y < 4');
eq('platzhalter', latexToExpr('\\int_{\\placeholder{}}^{2}f(x)\\,\\mathrm{d}x'), '∫_()^2f(x) dx');

// Rückweg: ältere Graphen im Formelfeld anzeigen
for (const e of ['f(x) = x^2 - 1', 'f(x) = 0,5x^3 - 2x für x < 3', 'g(x) = sqrt(x), x ∈ [0; 4[', 'a = 2', 'x = 3', "f'(x)", '∫_0^2 f(x) dx', 'tangente(f, 1)', 'f(x) = x^2; x > 0; x < 4']) {
  const back = latexToExpr(exprToLatex(e));
  const same = (() => { try { return [0.5, 1.5, 3.5].every(x => val(back, x) === val(e, x) || (Number.isNaN(val(back, x)) && Number.isNaN(val(e, x)))); } catch { return 'fehler'; } })();
  eq('hin und zurück: ' + e, same, true);
  const c1 = splitCondition(splitDefinition(e).body).cond, c2 = splitCondition(splitDefinition(back).body).cond;
  eq('bedingung bleibt: ' + e, JSON.stringify(c1 && evalCondition(c1, {})), JSON.stringify(c2 && evalCondition(c2, {})));
}

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
