// Tests für Graphen: Einschränkungen, abschnittsweise Funktionen, Ableitungen,
// Integrale, Tangenten – und dass sich Funktionen nicht endlos selbst aufrufen
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {} };

const M = await import('../web/js/core/mathexpr.js');
const { prepare, legendItems } = await import('../web/js/editor/blocks/plot.js');

let ok = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { fail++; console.log('✗ ' + name + '\n   erwartet: ' + w + '\n   erhalten: ' + g); }
};
const near = (name, got, want, eps = 1e-6) => eq(name, Math.abs(got - want) < eps, true) || (Math.abs(got - want) >= eps && console.log('   ', got));
const P = (...fns) => prepare({ functions: fns.map(expr => ({ expr })) });
const tex = (...fns) => legendItems(P(...fns)).map(x => x.tex);

// Ableiten
const d = (s, k = 1) => M.toTex(M.derive(M.parseExpr(s), k));
eq('ableitung polynom', d('0,5x^3 - 2x + 1'), '1{,}5 x^{2} - 2');
eq('ableitung zweite', d('x^3 - 3x', 2), '6 x');
eq('ableitung produkt', d('x*e^x'), 'e^{x} + x e^{x}');
eq('ableitung quotient', d('(x+1)/(x-1)'), '-\\frac{2}{\\left(x - 1\\right)^{2}}');
eq('ableitung kette', d('sin(2x)'), '2 \\cos\\left(2 x\\right)');
eq('ableitung parameter', d('a*x^2'), '2 a x');

// Einschränkungen
const sc = (s) => { const r = M.splitCondition(s); return [r.body, r.cond && M.conditionTex(r.cond)]; };
eq('für', sc('x^2 für x < 3'), ['x^2', 'x < 3']);
eq('komma', sc('x^2, 0 <= x <= 3'), ['x^2', '0 \\le x \\le 3']);
eq('intervall', sc('x^2, x ∈ [0; 3['), ['x^2', '0 \\le x < 3']);
eq('desmos', sc('x^2 {x > -1}'), ['x^2', 'x > -1']);
eq('unendlich', sc('x^2 für x ∈ ]0; ∞['), ['x^2', 'x > 0']);
eq('kein komma-irrtum', [sc('max(1, x)'), sc('2,5x')], [['max(1, x)', null], ['2,5x', null]]);
eq('rand', [M.inInterval({ lo: 0, hi: 3, loIncl: true, hiIncl: false }, 0), M.inInterval({ lo: 0, hi: 3, loIncl: true, hiIncl: false }, 3)], [true, false]);

// Integrale und Tangenten
const ev = (s, x = 0, env) => M.compile(M.parseExpr(s, env && env.known), env)(x);
near('integral', ev('∫_0^3 x^2 dx'), 9);
near('integral klammer', ev('integral(x^2, 0, 3)'), 9);
near('integral negativ', ev('∫_{-1}^{2} xdx'), 1.5);
near('integralfunktion', ev('∫_0^x t^2 dt', 3), 9);
const f = M.compile(M.parseExpr('x^2'));
near('tangente', ev('tangente(f, 1)', 3, { known: { f: true }, funcs: { f } }), 5, 1e-6);

// Absturz: "g(x)" beim Eintippen darf sich nicht selbst aufrufen
const t0 = Date.now();
const crash = P('f(x) = x^2', 'g(x)');
eq('g(x) eintippen', [crash.list[1].name !== 'g', Date.now() - t0 < 500], [true, true]);
eq('selbstbezug', P('g(x) = g(x) + 1').list[0].error, 'g darf sich nicht selbst enthalten');
eq('kreis', P('f(x) = g(x)', 'g(x) = f(x)').list[0].error, 'f und g verweisen aufeinander');
const env = { known: { g: true }, funcs: {} };
env.funcs.g = M.compile(M.parseExpr('g(x) + 1', env.known), env);
eq('schutz vor endlosschleife', Number.isNaN(env.funcs.g(1)), true);

// Graphen: abschnittsweise, Ableitung, Fläche, Tangente in der Legende
eq('legende abschnittsweise', tex('f(x) = x^2 für x < 0', 'f(x) = 2x + 1 für x ≥ 0'), ['f(x) = \\begin{cases} x^{2}, & x < 0 \\\\ 2 x + 1, & x \\ge 0 \\end{cases}']);
const pw = P('f(x) = x^2 für x < 0', 'f(x) = 2x + 1 für x ≥ 0');
eq('abschnittsweise werte', [pw.funcs.f(-2), pw.funcs.f(0), pw.funcs.f(2)], [4, 1, 5]);
eq('legende ableitung', tex('f(x) = 0,5x^3 - 2x', "f'(x)")[1], "f'(x) = 1{,}5 x^{2} - 2");
eq('legende eingeschränkt', tex('f(x) = x^2 für x < 3'), ['f(x) = x^{2},\\; x < 3']);
eq('legende tangente', tex('f(x) = x^2', 'tangente(f, 1)')[1], 't(x) = 2 x - 1');
eq('legende fläche', tex('f(x) = x^2', 'A = ∫_0^3 f(x) dx')[1], 'A = \\int_{0}^{3} f\\left(x\\right) \\,\\mathrm{d}x = 9');
eq('fläche mit vorzeichenwechsel', tex('∫_-1^1 x^3 dx')[0], '\\int_{-1}^{1} x^{3} \\,\\mathrm{d}x = 0\\quad\\text{(Fläche: 0{,}5)}');
const jump = P('f(x) = x^2 für x < 1', 'f(x) = -x + 3 für x ≥ 1', '∫_0^2 f(x) dx');
near('integral über sprungstelle', jump.areas[0].value, 1 / 3 + 1.5, 1e-6);
near('integral bis zum offenen rand', P('f(x) = x^2 für x < 2', '∫_0^2 f(x) dx').areas[0].value, 8 / 3, 1e-6);
eq('unbekannter name', P('f(x) = x^2', 'g(x) = k(x)').list[1].error.startsWith('„k“ ist noch nicht festgelegt'), true);

console.log(`${ok} ok, ${fail} fehlgeschlagen`);
if (fail) process.exit(1);
