import assert from 'node:assert/strict';
import { parseExpr, compile, toTex, findRoots, findExtrema, splitDefinition, formatNumber } from '../web/js/core/mathexpr.js';

const ev = (s, x, env) => compile(parseExpr(s, env && env.known), env)(x);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.log('✗', name, e.message); process.exitCode = 1; } };

t('Grundrechnung', () => { close(ev('2x^2 - 3', 2), 5); close(ev('0,5x + 1', 4), 3); close(ev('-x^2', 3), -9); });
t('Implizit', () => { close(ev('2(x+1)', 1), 4); close(ev('(x+1)(x-1)', 3), 8); close(ev('3x2', 1), 6); });
t('Funktionen', () => { close(ev('sin x', Math.PI / 2), 1); close(ev('sinx', Math.PI / 2), 1); close(ev('√x', 9), 3); close(ev('sqrt(x)', 16), 4); close(ev('|x-3|', 1), 2); close(ev('e^x', 1), Math.E); close(ev('ln(e)', 0), 1); close(ev('lg(100)', 0), 2); });
t('Potenzen', () => { close(ev('x^-1', 4), 0.25); close(ev('2^x^2', 2), 16); close(ev('x²', 5), 25); close(ev('(-8)^(1/3)', 0), -2); close(ev('root(3, x)', -27), -3); });
t('Konstanten', () => { close(ev('2pi', 0), 2 * Math.PI); close(ev('π', 0), Math.PI); });
t('Ableitung', () => {
  const f = compile(parseExpr('x^3'));
  const env = { known: { f: true }, funcs: { f } };
  close(ev("f'(x)", 2, env), 12, 1e-4);
  close(ev("f''(x)", 2, env), 12, 1e-2);
});
t('Nullstellen', () => {
  const f = compile(parseExpr('x^2 - 2'));
  const r = findRoots(f, -5, 5);
  assert.equal(r.length, 2); close(r[0], -Math.SQRT2, 1e-6); close(r[1], Math.SQRT2, 1e-6);
  const g = compile(parseExpr('x^2'));
  assert.deepEqual(findRoots(g, -5, 5), [0]);
  const h = compile(parseExpr('1/x'));
  assert.deepEqual(findRoots(h, -5, 5), []);
});
t('Extrema', () => {
  const f = compile(parseExpr('x^3 - 3x'));
  const e = findExtrema(f, -5, 5);
  assert.equal(e.length, 2); close(e[0].x, -1, 1e-4); assert.equal(e[0].kind, 'max');
});
t('LaTeX', () => {
  assert.equal(toTex(parseExpr('2x^2 - 3')), '2 x^{2} - 3');
  assert.equal(toTex(parseExpr('0,5x + 1')), '0{,}5 x + 1');
  assert.equal(toTex(parseExpr('(x+1)/2')), '\\frac{\\left(x + 1\\right)}{2}');
});
t('Definition', () => {
  assert.deepEqual(splitDefinition('f(x) = x^2'), { name: 'f', body: 'x^2' });
  assert.deepEqual(splitDefinition('y = 2x'), { name: null, body: '2x' });
  assert.deepEqual(splitDefinition('a = 2'), { name: 'a', body: '2', param: true });
});
t('Zahlformat', () => { assert.equal(formatNumber(1.41421356), '1,41'); assert.equal(formatNumber(-2), '−2'); assert.equal(formatNumber(2.5), '2,5'); });
console.log(n, 'Tests bestanden');
