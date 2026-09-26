// Tests für die Chemie-Werkzeuge
import assert from 'node:assert/strict';
import { parseSmiles, elementCounts, hillFormula, molarMass, functionalGroups, substanceClass, toSmiles, explicitHSmiles,
  condensedFormula, nameToSmiles, nameToMolecule, balanceEquation, checkEquation, gridLayout } from '../web/js/core/chem.js';

let ok = 0, bad = 0;
const t = (name, fn) => { try { fn(); ok++; } catch (e) { bad++; console.log('✗', name, '\n   ', e.message.split('\n').slice(0, 6).join('\n    ')); } };
const formula = (smi) => { const g = parseSmiles(smi); const { counts, charge } = elementCounts(g); return hillFormula(counts, charge); };
const nameF = (n) => { const g = nameToMolecule(n); const { counts } = elementCounts(g); return hillFormula(counts); };

t('Summenformeln', () => {
  assert.equal(formula('CCO'), 'C2H6O');
  assert.equal(formula('c1ccccc1'), 'C6H6');
  assert.equal(formula('CC(=O)O'), 'C2H4O2');
  assert.equal(formula('OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O'), 'C6H12O6');
  assert.equal(formula('[NH4+]'), 'H4N^{+}');
  assert.equal(formula('O=C=O'), 'CO2');
  assert.equal(formula('Cn1cnc2c1c(=O)n(C)c(=O)n2C'), 'C8H10N4O2');
});
t('Molare Masse', () => {
  const { counts } = elementCounts(parseSmiles('CCO'));
  assert.ok(Math.abs(molarMass(counts) - 46.069) < 0.01);
});
t('Funktionelle Gruppen', () => {
  assert.deepEqual(functionalGroups(parseSmiles('CCO')), ['Hydroxy-Gruppe (Alkohol)']);
  assert.deepEqual(functionalGroups(parseSmiles('CC(=O)O')), ['Carboxy-Gruppe (Carbonsäure)']);
  assert.deepEqual(functionalGroups(parseSmiles('CCOC(C)=O')), ['Ester-Gruppe']);
  assert.deepEqual(functionalGroups(parseSmiles('CC=O')), ['Aldehyd-Gruppe (Carbonylgruppe)']);
  assert.deepEqual(functionalGroups(parseSmiles('CC(C)=O')), ['Keto-Gruppe (Carbonylgruppe)']);
  assert.deepEqual(functionalGroups(parseSmiles('CCN')), ['Amino-Gruppe']);
  assert.deepEqual(functionalGroups(parseSmiles('C=CC')), ['C=C-Doppelbindung']);
  assert.equal(substanceClass(parseSmiles('CCCC')), 'Alkan');
  assert.equal(substanceClass(parseSmiles('Oc1ccccc1')), 'Phenol');
  assert.equal(substanceClass(parseSmiles('C1CCCCC1')), 'Cycloalkan');
});
t('SMILES schreiben (Rundlauf)', () => {
  for (const s of ['CCO', 'CC(C)C', 'C1CCCCC1', 'CC(=O)OCC', 'C#N', 'c1ccccc1O', 'C(C)(C)(C)C']) {
    assert.equal(formula(toSmiles(parseSmiles(s))), formula(s), s);
  }
});
t('Explizite H-Atome', () => {
  const s = explicitHSmiles('CCO');
  assert.equal((s.match(/\[H\]/g) || []).length, 6);
  assert.equal(formula(s), 'C2H6O');
});
t('Namen → Struktur', () => {
  const cases = {
    'Methan': 'CH4', 'Ethan': 'C2H6', 'Propan': 'C3H8', '2-Methylpropan': 'C4H10', '2,2-Dimethylpropan': 'C5H12',
    '3-Ethyl-2-methylhexan': 'C9H20', 'Ethen': 'C2H4', 'But-2-en': 'C4H8', '2-Buten': 'C4H8', 'Buta-1,3-dien': 'C4H6',
    'Ethin': 'C2H2', 'Pent-1-in': 'C5H8', 'Ethanol': 'C2H6O', 'Propan-2-ol': 'C3H8O', '2-Propanol': 'C3H8O',
    'Propan-1,2,3-triol': 'C3H8O3', 'Ethandiol': 'C2H6O2', 'Butanal': 'C4H8O', 'Propanon': 'C3H6O', 'Butan-2-on': 'C4H8O',
    'Ethansäure': 'C2H4O2', 'Essigsäure': 'C2H4O2', 'Butandisäure': 'C4H6O4', '2-Hydroxypropansäure': 'C3H6O3',
    'Ethansäureethylester': 'C4H8O2', 'Essigsäureethylester': 'C4H8O2', 'Ethylethanoat': 'C4H8O2', 'Methylpropanoat': 'C4H8O2',
    'Methanamin': 'CH5N', 'Chlormethan': 'CH3Cl', '2-Brom-2-methylpropan': 'C4H9Br', '1,2-Dichlorethan': 'C2H4Cl2',
    'Cyclohexan': 'C6H12', 'Cyclohexanol': 'C6H12O', 'Cyclohexen': 'C6H10', '2-Methylbut-2-en': 'C5H10',
    '3-Methylbutan-2-ol': 'C5H12O', '2-Methyl-2-propanol': 'C4H10O', 'Ethannitril': 'C2H3N', 'Methoxymethan': 'C2H6O',
    'Hexa-1,3-dien': 'C6H10', 'Propen': 'C3H6', 'Pentan-2,4-dion': 'C5H8O2'
  };
  for (const [n, f] of Object.entries(cases)) {
    let got;
    try { got = nameF(n); } catch (e) { got = 'FEHLER: ' + e.message; }
    assert.equal(got, f, n);
  }
});
t('Ungültige Namen', () => {
  assert.throws(() => nameToMolecule('2,2,2-Trimethylpropan'));
  assert.throws(() => nameToMolecule('Quatschan'));
});
t('Halbstrukturformel', () => {
  assert.equal(condensedFormula('CCO'), 'CH3-CH2-OH');
  assert.equal(condensedFormula('CC(O)C'), 'CH3-CH(OH)-CH3');
  assert.equal(condensedFormula('CC(=O)O'), 'CH3-COOH');
  assert.equal(condensedFormula('CC=O'), 'CH3-CHO');
  assert.equal(condensedFormula('CC(C)=O'), 'CH3-CO-CH3');
  assert.equal(condensedFormula('C=CC'), 'CH2=CH-CH3');
  assert.equal(condensedFormula('CC(C)C'), 'CH3-CH(CH3)-CH3');
  assert.equal(condensedFormula('CCOC(C)=O'), 'CH3-COO-CH2-CH3');
  assert.equal(condensedFormula('C'), 'CH4');
  assert.equal(condensedFormula('c1ccccc1'), null);
});
t('Gleichungen ausgleichen', () => {
  assert.equal(balanceEquation('H2 + O2 -> H2O').text, '2H2 + O2 -> 2H2O');
  assert.equal(balanceEquation('C3H8 + O2 -> CO2 + H2O').text, 'C3H8 + 5O2 -> 3CO2 + 4H2O');
  assert.equal(balanceEquation('Fe + O2 -> Fe2O3').text, '4Fe + 3O2 -> 2Fe2O3');
  assert.equal(balanceEquation('Ca(OH)2 + HCl -> CaCl2 + H2O').text, 'Ca(OH)2 + 2HCl -> CaCl2 + 2H2O');
  assert.equal(balanceEquation('C6H12O6 + O2 -> CO2 + H2O').text, 'C6H12O6 + 6O2 -> 6CO2 + 6H2O');
  assert.equal(balanceEquation('Zn + H^+ -> Zn^2+ + H2').text, 'Zn + 2H^+ -> Zn^2+ + H2');
  assert.equal(balanceEquation('CH4 + O2 ->[\\Delta] CO2 + H2O').text, 'CH4 + 2O2 ->[\\Delta] CO2 + 2H2O');
  assert.equal(balanceEquation('NaCl(aq) + AgNO3(aq) -> AgCl(s) v + NaNO3(aq)').text, 'NaCl(aq) + AgNO3(aq) -> AgCl(s) v + NaNO3(aq)');
  assert.equal(checkEquation('2H2 + O2 -> 2H2O').balanced, true);
  assert.equal(checkEquation('H2 + O2 -> H2O').balanced, false);
});
t('Raster-Layout', () => {
  const L = gridLayout('CCO');
  assert.ok(L);
  assert.equal(L.atoms.length, 9);
  const keys = new Set(L.atoms.map(a => a.x + ',' + a.y));
  assert.equal(keys.size, 9, 'keine Überlappung');
  assert.equal(L.lonePairs.length, 2);
  assert.equal(gridLayout('c1ccccc1'), null);
  const L2 = gridLayout('CC(C)C(C)C');
  assert.ok(L2 === null || new Set(L2.atoms.map(a => a.x + ',' + a.y)).size === L2.atoms.length);
});
console.log(`${ok} bestanden, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
