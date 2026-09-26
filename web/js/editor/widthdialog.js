// Dialog "Breiten einstellen" – für Spalten nebeneinander und Tabellenspalten.
// Pro Spalte ein Feld: Zahl = Anteil, mit Einheit = feste Breite.

import { h, dialog } from '../ui/ui.js';
import { parseWidth, formatWidth, parseRatioList } from '../core/widths.js';

// opts: title, labels[], specs[], extra (zusätzliches Element unter den Feldern)
// → Promise mit neuen Breiten (Array, null = automatisch) oder null bei Abbruch
export function widthDialog({ title, labels, specs, extra, description }) {
  return new Promise((resolve) => {
    const n = labels.length;
    const inputs = labels.map((_, i) => h('input', { class: 'input', value: formatWidth(specs[i]), placeholder: '1', spellcheck: 'false' }));
    const err = h('div', { class: 'width-err' });
    const bar = h('div', { class: 'width-bars' });
    const preview = () => {
      bar.innerHTML = '';
      const vals = inputs.map(i => parseWidth(i.value));
      vals.forEach((v, i) => {
        const fixed = v && !/fr$/.test(v);
        const seg = h('div', { class: 'width-seg' + (fixed ? ' fixed' : ''), text: labels[i] });
        seg.style.flex = fixed ? `0 0 ${Math.min(60, Math.max(12, 100 / n))}%` : `${v ? parseFloat(v) : 1} 1 0`;
        bar.append(seg);
      });
      const bad = inputs.filter((i, k) => i.value.trim() && !vals[k]);
      err.textContent = bad.length ? 'Nicht verstanden – bitte z. B. „2“, „5 cm“, „40 mm“ oder „30 %“.' : '';
    };
    inputs.forEach(i => i.addEventListener('input', preview));
    const presets = n === 2 ? ['1:1', '1:2', '2:1', '1:3', '3:1'] : n === 3 ? ['1:1:1', '1:2:1', '2:1:1', '1:1:2'] : [Array(n).fill(1).join(':')];
    const presetRow = h('div', { class: 'width-presets' }, ...presets.map(p => {
      const b = h('button', { class: 'btn sm outline', text: p.replace(/:/g, ' : ') });
      b.addEventListener('click', () => { parseRatioList(p).forEach((v, i) => { inputs[i].value = formatWidth(v); }); preview(); });
      return b;
    }));
    const quick = h('input', { class: 'input', placeholder: 'oder alles auf einmal, z. B. 1 : 2 : 1' });
    quick.addEventListener('input', () => {
      const list = parseRatioList(quick.value);
      if (list && list.length === n) { list.forEach((v, i) => { inputs[i].value = formatWidth(v); }); preview(); }
    });
    const rows = h('div', { class: 'width-rows' }, ...labels.map((l, i) => h('label', { class: 'width-row' }, h('span', { text: l }), inputs[i])));
    const body = h('div', { class: 'width-dialog' },
      h('p', { class: 'hint', html: description || 'Eine <b>Zahl</b> ist ein Anteil: „2“ ist doppelt so breit wie „1“. Mit <b>Einheit</b> ist die Breite fest: „5 cm“, „40 mm“, „30 %“. Leer = automatisch.' }),
      bar, presetRow, rows, quick, err, extra || '');
    preview();
    let done = false;
    const d = dialog({
      title, body, center: true,
      onClose: () => { if (!done) resolve(null); },
      actions: [
        { label: 'Abbrechen', value: false },
        { label: 'Übernehmen', primary: true, onClick: () => {
          const vals = inputs.map(i => (i.value.trim() ? parseWidth(i.value) : null));
          if (inputs.some((i, k) => i.value.trim() && !vals[k])) return false;
          done = true;
          resolve(vals);
        } }
      ]
    });
    setTimeout(() => inputs[0] && inputs[0].focus(), 30);
    return d;
  });
}
