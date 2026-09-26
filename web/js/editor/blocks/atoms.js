// Nicht-Text-Blöcke: Formel, Reaktionsgleichung, Code, Bild, PDF,
// Inhaltsverzeichnis, Trennlinie, Seitenumbruch, Spalten.
//
// Jeder Block hat eine "Ansicht" (render) und optional ein Bearbeitungsfeld
// (activate), das beim Anklicken unter der Ansicht aufklappt – wie bei den
// Formeln in Notion, nur ohne schwebendes Fenster, damit auch mehrzeilige
// Umformungen bequem zu bearbeiten sind.

import { h, esc, popover, menu } from '../../ui/ui.js';
import { icon } from '../../ui/icons.js';
import { renderDisplay, renderToString } from '../render/katex.js';
import { createField, GERMAN_SHORTCUTS } from '../mathfield.js';
import { widthDialog } from '../widthdialog.js';
import { flexFor, fromPx, ratioOf, widthKind, formatWidth } from '../../core/widths.js';
import { latexToLines, linesToLatex, cleanFieldLatex, needsSource, repairLatex, MARK_COLORS } from '../../core/mathlines.js';
import { assetURL, assetVersion, uuidFromLink } from '../../bridge.js';
import { htmlToSegs, segsToHTML, normalizeHTML } from '../../core/inline.js';
import { balanceEquation, checkEquation } from '../../core/chem.js';
import { SIZE_PRESETS, snapWidth, roundWidth, widthOf, formatPct, otherWidths, sameContextImages } from '../../core/imagesize.js';

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

export function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

function insertAtCursor(ta, text, selectFrom, selectTo) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const before = ta.value.slice(0, s), after = ta.value.slice(e);
  const selected = ta.value.slice(s, e);
  let ins = text;
  if (ins.includes('▯')) ins = ins.replace('▯', selected || '▯');
  ta.value = before + ins + after;
  const mark = ins.indexOf('▯');
  if (mark >= 0) {
    ta.value = before + ins.replace('▯', '') + after;
    ta.selectionStart = ta.selectionEnd = s + mark;
  } else if (selectFrom !== undefined) {
    ta.selectionStart = s + selectFrom;
    ta.selectionEnd = s + (selectTo ?? selectFrom);
  } else ta.selectionStart = ta.selectionEnd = s + ins.length;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

function srcTextarea(value, placeholder) {
  const ta = h('textarea', { class: 'src', spellcheck: 'false', placeholder, rows: 1 });
  ta.value = value || '';
  requestAnimationFrame(() => autosize(ta));
  return ta;
}

// Gemeinsame Tastenlogik für Quelltextfelder in Atom-Blöcken.
function panelKeys(ed, b, ta, { multilineWhen } = {}) {
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); ed.deactivate({ select: true }); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ed.exitAtom(b, 'after'); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      const multi = multilineWhen ? multilineWhen(ta.value) : false;
      if (!multi) { e.preventDefault(); ed.exitAtom(b, 'after'); return; }
      // Ausgerichtete Umformung: Zeile mit "\" abschließen
      e.preventDefault();
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
      const lineEnd = ta.value.indexOf('\n', s) < 0 ? ta.value.length : ta.value.indexOf('\n', s);
      const line = ta.value.slice(lineStart, lineEnd);
      if (s === lineEnd && !/\\\s*$/.test(line) && line.trim()) insertAtCursor(ta, ' \\\n');
      else insertAtCursor(ta, '\n');
      return;
    }
    if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) { e.preventDefault(); ed.exitAtom(b, 'before'); return; }
    if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length) { e.preventDefault(); ed.exitAtom(b, 'after'); return; }
    if (e.key === 'Backspace' && !ta.value) { e.preventDefault(); ed.removeAtomAndFocusPrev(b); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertAtCursor(ta, e.shiftKey ? '' : '&'); }
  });
}

// ---------------------------------------------------------------------------
// Formel
// ---------------------------------------------------------------------------

export const math = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    const view = h('div', { class: 'atom-view math-view' });
    renderDisplay(view, b.tex, ed.mathMode());
    view.addEventListener('mousedown', (e) => { if (!ed.readonly) { e.preventDefault(); ed.activate(b); } });
    main.append(h('div', { class: 'atom' }, view));
  },
  activate(ed, b, main) {
    const atom = main.querySelector('.atom');
    const view = atom.querySelector('.math-view');
    if (b._source || needsSource(b.tex)) mathSource(ed, b, atom, view);
    else mathFields(ed, b, atom, view);
  }
};

// Formel zum Anklicken: jede Zeile ein Formelfeld, "&" setzt Ausrichtungspunkte
async function mathFields(ed, b, atom, view) {
  const box = h('div', { class: 'math-lines' });
  const help = h('button', { class: 'btn sm ghost', 'data-tip': 'Alle Kürzel anzeigen' }, icon('info', 'sm'), 'Kürzel');
  const srcBtn = h('button', { class: 'btn sm ghost', 'data-tip': 'Formel als LaTeX-Quelltext bearbeiten' }, icon('code', 'sm'), 'LaTeX');
  const barBtn = h('button', { class: 'btn sm ghost', 'data-tip': 'Kommandostrich ans Zeilenende (auch mit || oder „kstrich“)' }, '| Kommandostrich');
  const tools = h('div', { class: 'math-tools' },
    h('span', { class: 'hint grow', html: '<b>wurzel</b>, <b>bruch</b> … · <kbd>&amp;</kbd> ausrichten · <kbd>||</kbd> Strich · <kbd>~</kbd> √' }),
    barBtn, help, srcBtn);
  view.style.display = 'none';
  atom.append(box, tools);
  const fields = [];
  let last = null;
  const sync = () => {
    b.tex = linesToLatex(fields.map(fieldValue), { left: b.align === 'left' });
    ed.changed({ soft: true });
    alignSoon();
  };
  const focusLine = (i, where = 'end') => {
    const f = fields[Math.max(0, Math.min(fields.length - 1, i))];
    if (!f) return;
    f.focus();
    f.position = where === 'start' ? 0 : f.lastOffset;
  };
  const removeLine = (f) => {
    const i = fields.indexOf(f);
    fields.splice(i, 1);
    f.remove();
    sync();
    return i;
  };
  const addLine = async (index, value, where = 'end') => {
    const f = await createField({
      value,
      onInput: sync,
      onKey: (e, mf) => onKey(e, mf),
      onMoveOut: (dir, mf) => {
        const i = fields.indexOf(mf);
        if (dir === 'upward' || dir === 'backward') {
          if (i > 0) focusLine(i - 1, dir === 'backward' ? 'end' : 'end');
          else ed.exitAtom(b, 'before');
        } else if (i < fields.length - 1) focusLine(i + 1, 'start');
        else ed.exitAtom(b, 'after');
      },
      extraMenu: () => [
        { label: 'Neue Zeile darunter', icon: 'plus', hint: 'Enter', onSelect: () => addLine(fields.length, '') },
        { label: 'Als LaTeX bearbeiten', icon: 'code', onSelect: () => toSource() }
      ]
    });
    if (!atom.isConnected) return null;
    f.addEventListener('focusin', () => { last = f; });
    const ref = fields[index];
    if (ref) box.insertBefore(f, ref); else box.append(f);
    fields.splice(index, 0, f);
    requestAnimationFrame(() => { f.focus(); f.position = where === 'start' ? 0 : f.lastOffset; alignSoon(); });
    return f;
  };
  const onKey = (e, mf) => {
    const i = fields.indexOf(mf);
    if (e.key === 'Escape') { ed.deactivate({ select: true }); return true; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { ed.exitAtom(b, 'after'); return true; }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      const pos = mf.position, end = mf.lastOffset;
      let tail = '';
      if (pos < end && mf.getOffsetDepth(pos) === 0) {
        tail = cleanFieldLatex(mf.getValue(pos, end));
        mf.value = cleanFieldLatex(mf.getValue(0, pos));
      }
      // Neue Umformungszeile beginnt am selben Ausrichtungspunkt
      const mark = /\\heftmark\{(\d+)\}/.exec(fieldValue(mf));
      if (!tail && mark) tail = `\\heftmark{${mark[1]}}`;
      addLine(i + 1, tail, tail.startsWith('\\heftmark') && !pos ? 'end' : (tail && pos < end ? 'start' : 'end')).then(sync);
      return true;
    }
    if (e.key === 'Backspace' && mf.position === 0 && mf.selectionIsCollapsed) {
      const v = fieldValue(mf);
      if (!v) {
        if (fields.length > 1) { const k = removeLine(mf); focusLine(k - 1, 'end'); }
        else ed.removeAtomAndFocusPrev(b);
        return true;
      }
      if (i > 0) {
        const prev = fields[i - 1];
        const at = prev.lastOffset;
        prev.value = fieldValue(prev) + v;
        removeLine(mf);
        prev.focus();
        prev.position = at;
        return true;
      }
    }
    return false;
  };
  // Beim Bearbeiten schon so ausrichten, wie es später aussieht
  let alignTimer = 0;
  const alignSoon = () => { cancelAnimationFrame(alignTimer); alignTimer = requestAnimationFrame(() => alignFields(box, fields)); };
  const toSource = () => {
    b._source = true;
    atom.querySelector('.math-lines')?.remove();
    atom.querySelector('.math-tools')?.remove();
    mathSource(ed, b, atom, view);
  };
  srcBtn.addEventListener('click', toSource);
  barBtn.addEventListener('mousedown', (e) => e.preventDefault());
  barBtn.addEventListener('click', () => {
    const f = last || fields[fields.length - 1];
    if (!f) return;
    f.focus();
    // Nur ein Kommandostrich pro Zeile – ans Ende setzen
    if (!/\\heftbar/.test(f.getValue('latex'))) {
      f.position = f.lastOffset;
      f.insert('\\heftbar', { selectionMode: 'after' });
      sync();
    }
  });
  help.addEventListener('mousedown', (e) => e.preventDefault());
  help.addEventListener('click', () => shortcutHelp(help, (tex) => {
    const f = last || fields[0];
    if (!f) return;
    f.focus();
    f.insert(tex.replace(/#\?/g, '\\placeholder{}'), { selectionMode: 'placeholder' });
    sync();
  }));
  const lines = latexToLines(repairLatex(b.tex));
  for (let k = 0; k < lines.length; k++) await addLine(k, lines[k]);
  if (fields.length) requestAnimationFrame(() => focusLine(fields.length - 1, 'end'));
}

function fieldValue(mf) { return cleanFieldLatex(mf.getValue('latex')); }

// Ausrichtungspunkte gleicher ID in allen Zeilen auf dieselbe Höhe schieben
function alignFields(box, fields) {
  if (!box.isConnected) return;
  const pos = fields.map(f => {
    f.style.paddingLeft = '';
    const map = new Map();
    const root = f.shadowRoot;
    if (!root) return map;
    const fl = f.getBoundingClientRect().left;
    for (const el of root.querySelectorAll('.ML__rule')) {
      const id = markIdFromColor(getComputedStyle(el).color);
      if (id && !map.has(id)) map.set(id, el.getBoundingClientRect().left - fl);
    }
    return map;
  });
  const ids = [...new Set(pos.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const anchor = ids.find(id => pos.filter(m => m.has(id)).length >= 2);
  box.classList.toggle('aligned', !!ids.length);
  if (!anchor) return;
  const max = Math.max(...pos.filter(m => m.has(anchor)).map(m => m.get(anchor)));
  fields.forEach((f, i) => { if (pos[i].has(anchor)) f.style.paddingLeft = `calc(var(--mf-pad) + ${Math.round(max - pos[i].get(anchor))}px)`; });
}

function markIdFromColor(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
  if (!m) return null;
  const hex = '#' + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('');
  const i = MARK_COLORS.indexOf(hex);
  return i >= 0 ? i + 1 : null;
}

// Liste der deutschen Kürzel (zum Nachschlagen und Anklicken)
function shortcutHelp(anchor, onPick) {
  const list = h('div', { class: 'mf-help' });
  for (const [names, tex, desc] of GERMAN_SHORTCUTS) {
    const r = renderToString(tex.replace(/#\?/g, '\\square'), { display: false, mode: 'latex' });
    const row = h('button', { class: 'mf-help-row' },
      h('span', { class: 'k', text: names[0] }),
      h('span', { class: 'v', html: r.html || '' }),
      h('span', { class: 'd', text: desc }));
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => { pop.close(); onPick(tex); });
    list.append(row);
  }
  const box = h('div', { class: 'mf-help-box' },
    h('div', { class: 'hint', html: 'Einfach das Wort in der Formel tippen – es wird sofort ersetzt. Außerdem: <kbd>/</kbd> Bruch, <kbd>^</kbd> hoch, <kbd>_</kbd> Index, <kbd>*</kbd> Malpunkt, <kbd>Tab</kbd> nächstes Kästchen, <kbd>\\</kbd> LaTeX-Befehl. Einheiten: <kbd>"</kbd>dm<kbd>"</kbd> (danach geht auch <kbd>^</kbd>2); cm, dm, km, kg … nach einer Zahl werden automatisch aufrecht.' }),
    list);
  const pop = popover(anchor, box, { align: 'right' });
}

// Quelltext-Bearbeitung (für Profis und für Formeln mit \ce{…})
function mathSource(ed, b, atom, view) {
  view.style.display = '';
  const ta = srcTextarea(b.tex, 'LaTeX, z. B.  \\frac{a}{b}   \\sqrt{x}   x^{2}');
  const err = h('div', { class: 'err' });
  const back = h('button', { class: 'btn sm ghost', 'data-tip': 'Wieder mit Kästchen bearbeiten' }, icon('sigma', 'sm'), 'Formelfeld');
  const panel = h('div', { class: 'atom-panel' },
    ta,
    h('div', { class: 'panel-row' },
      h('span', { class: 'hint grow', html: '<kbd>Enter</kbd> fertig · <kbd>⇧ Enter</kbd> neue Zeile · <kbd>&amp;</kbd> ausrichten · <kbd>\\\\</kbd> Zeilenende' }),
      back),
    err);
  atom.append(panel);
  back.addEventListener('click', () => {
    if (needsSource(ta.value)) { err.textContent = 'Diese Formel enthält Befehle (z. B. \\ce), die nur als Quelltext gehen.'; return; }
    delete b._source;
    panel.remove();
    mathFields(ed, b, atom, view);
  });
  ta.addEventListener('input', () => {
    autosize(ta);
    b.tex = ta.value;
    const e = renderDisplay(view, ta.value, ed.mathMode());
    err.textContent = e ? '⚠︎ ' + e : '';
    ed.changed({ soft: true });
  });
  panelKeys(ed, b, ta, { multilineWhen: (v) => v.includes('&') || v.includes('\n') });
  requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; autosize(ta); });
}

// ---------------------------------------------------------------------------
// Reaktionsgleichung (mhchem)
// ---------------------------------------------------------------------------

const CHEM_SNIPPETS = [
  ['→', ' -> ', 'Reaktionspfeil'], ['⇌', ' <=> ', 'Gleichgewicht'], ['→Δ', ' ->[\\Delta] ', 'Pfeil mit Wärme'],
  ['→ᵗ', ' ->[▯] ', 'Pfeil mit Beschriftung'], ['↑', ' ^ ', 'Gas entweicht'], ['↓', ' v ', 'Niederschlag'],
  ['+', ' + ', 'Plus'], ['(aq)', '(aq)', 'gelöst'], ['(s)', '(s)', 'fest'], ['(l)', '(l)', 'flüssig'], ['(g)', '(g)', 'gasförmig'],
  ['⁺', '^+', 'positive Ladung'], ['⁻', '^-', 'negative Ladung'], ['²⁺', '^{2+}', 'zweifach positiv'], ['e⁻', 'e^-', 'Elektron'],
  ['·', ' * ', 'Kristallwasser'], ['ΔH', ' \\quad \\Delta H = ▯ kJ/mol', 'Reaktionsenthalpie']
];

export const chem = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    const view = h('div', { class: 'atom-view math-view' });
    renderDisplay(view, b.tex ? `\\ce{${b.tex}}` : '', 'latex');
    if (!b.tex) view.innerHTML = '<span class="math-empty">Reaktionsgleichung eingeben …</span>';
    view.addEventListener('mousedown', (e) => { if (!ed.readonly) { e.preventDefault(); ed.activate(b); } });
    main.append(h('div', { class: 'atom' }, view));
  },
  activate(ed, b, main) {
    const atom = main.querySelector('.atom');
    const view = atom.querySelector('.math-view');
    const ta = srcTextarea(b.tex, 'z. B.  2H2 + O2 -> 2H2O    CaCO3 ->[\\Delta] CaO + CO2 ^');
    const err = h('div', { class: 'err' });
    const bar = h('div', { class: 'chem-helpers' });
    for (const [label, snippet, tip] of CHEM_SNIPPETS) {
      const btn = h('button', { 'data-tip': tip }, label);
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); insertAtCursor(ta, snippet); });
      bar.append(btn);
    }
    // Stimmt die Gleichung? (Atome und Ladungen links = rechts)
    const check = h('span', { class: 'chem-check' });
    const balanceBtn = h('button', { class: 'btn sm outline', 'data-tip': 'Stöchiometrische Faktoren automatisch einsetzen' }, icon('scale', 'sm'), 'Ausgleichen');
    const updateCheck = () => {
      const c = ta.value.trim() ? checkEquation(ta.value) : null;
      check.className = 'chem-check' + (c ? (c.balanced ? ' ok' : ' bad') : '');
      check.textContent = !c ? '' : c.balanced ? '✓ ausgeglichen'
        : c.diff.length ? `✗ stimmt nicht bei ${c.diff.join(', ')}` : '✗ Ladungen stimmen nicht';
      balanceBtn.disabled = !c || c.balanced;
    };
    balanceBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      try {
        const res = balanceEquation(ta.value);
        ta.value = res.text;
        ta.dispatchEvent(new Event('input'));
      } catch (ex) { err.textContent = '⚠︎ ' + ex.message; }
      ta.focus();
    });
    atom.append(h('div', { class: 'atom-panel' }, ta, h('div', { class: 'panel-row' }, bar),
      h('div', { class: 'panel-row' },
        h('span', { class: 'hint grow', html: 'Zahlen hinter Elementen werden automatisch tiefgestellt (H2O → H₂O). <kbd>Enter</kbd> fertig' }),
        check, balanceBtn), err));
    ta.addEventListener('input', () => {
      autosize(ta);
      b.tex = ta.value;
      const e = renderDisplay(view, ta.value ? `\\ce{${ta.value}}` : '', 'latex');
      if (!ta.value) view.innerHTML = '<span class="math-empty">Reaktionsgleichung eingeben …</span>';
      err.textContent = e ? '⚠︎ ' + e : '';
      updateCheck();
      ed.changed({ soft: true });
    });
    updateCheck();
    panelKeys(ed, b, ta);
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; });
  }
};

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const LANGS = [
  ['', 'Einfacher Text'], ['python', 'Python'], ['java', 'Java'], ['javascript', 'JavaScript'], ['c', 'C'], ['cpp', 'C++'],
  ['csharp', 'C#'], ['html', 'HTML'], ['css', 'CSS'], ['sql', 'SQL'], ['bash', 'Shell'], ['json', 'JSON'], ['xml', 'XML'],
  ['latex', 'LaTeX'], ['markdown', 'Markdown'], ['swift', 'Swift'], ['kotlin', 'Kotlin'], ['php', 'PHP'], ['rust', 'Rust'], ['go', 'Go'], ['mermaid', 'Mermaid']
];

function highlight(code, lang) {
  const hl = window.hljs;
  if (!hl || !lang || lang === 'mermaid') return esc(code);
  try {
    if (hl.getLanguage(lang)) return hl.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch { /* unbekannte Sprache */ }
  return esc(code);
}

export const code = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    const wrap = h('div', { class: 'code-wrap' });
    const langName = (LANGS.find(l => l[0] === (b.lang || '')) || [b.lang, b.lang || 'Einfacher Text'])[1];
    const langBtn = h('button', { class: 'code-lang' }, langName, ' ▾');
    const copyBtn = h('button', { class: 'code-lang' }, 'Kopieren');
    const head = h('div', { class: 'code-head' }, langBtn, copyBtn);
    const ed2 = h('div', { class: 'code-editor' });
    const pre = h('pre', { class: 'hljs' });
    const ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    ta.value = b.text || '';
    if (ed.readonly) ta.readOnly = true;
    const paint = () => {
      pre.innerHTML = highlight(ta.value, b.lang) + (ta.value.endsWith('\n') ? ' ' : '');
      ta.style.height = '0px';
      ed2.style.minHeight = '';
    };
    paint();
    ed2.append(pre, ta);
    wrap.append(head, ed2);
    main.append(wrap);
    // Die Textarea liegt exakt über dem eingefärbten <pre>; ihre Höhe folgt dem <pre>.
    const sync = () => { ta.style.height = pre.offsetHeight + 'px'; };
    requestAnimationFrame(sync);
    ta.addEventListener('input', () => {
      b.text = ta.value;
      paint();
      sync();
      ed.changed({ soft: true });
    });
    ta.addEventListener('focus', () => ed.setFocusBlock(b));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        if (e.shiftKey) {
          const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
          if (ta.value.slice(ls, ls + 4) === '    ') { ta.value = ta.value.slice(0, ls) + ta.value.slice(ls + 4); ta.selectionStart = ta.selectionEnd = Math.max(ls, s - 4); }
        } else {
          ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd);
          ta.selectionStart = ta.selectionEnd = s + 4;
        }
        ta.dispatchEvent(new Event('input'));
      } else if (e.key === 'Escape') { e.preventDefault(); ta.blur(); ed.selectBlocks([b]); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ed.exitAtom(b, 'after'); }
      else if (e.key === 'ArrowUp' && ta.selectionStart === 0) { e.preventDefault(); ed.exitAtom(b, 'before'); }
      else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length) { e.preventDefault(); ed.exitAtom(b, 'after'); }
      else if (e.key === 'Backspace' && !ta.value) { e.preventDefault(); ed.removeAtomAndFocusPrev(b); }
      else if (e.key === 'Enter') {
        // Einrückung der aktuellen Zeile übernehmen
        e.preventDefault();
        const s = ta.selectionStart;
        const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
        const indent = /^[ \t]*/.exec(ta.value.slice(ls))[0];
        const extra = /[:{(\[]\s*$/.test(ta.value.slice(ls, s)) ? '    ' : '';
        const ins = '\n' + indent + extra;
        ta.value = ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = s + ins.length;
        ta.dispatchEvent(new Event('input'));
      }
    });
    langBtn.addEventListener('click', () => {
      ed.ui.menu(langBtn, LANGS.map(([id, name]) => ({
        label: name, checked: (b.lang || '') === id,
        onSelect: () => { ed.checkpoint(); b.lang = id; ed.rerender(b); ed.changed(); }
      })));
    });
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(ta.value).then(() => ed.ui.toast('Code kopiert', { type: 'success', timeout: 1500 }));
    });
  },
  focus(ed, b, main, where) {
    const ta = main.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    const pos = where === 'start' ? 0 : ta.value.length;
    ta.selectionStart = ta.selectionEnd = pos;
  }
};

// ---------------------------------------------------------------------------
// Trennlinie, Seitenumbruch
// ---------------------------------------------------------------------------

export const hr = {
  atom: true,
  render(ed, b, main) { main.innerHTML = ''; main.addEventListener('mousedown', (e) => { e.preventDefault(); ed.selectBlocks([b]); }); }
};

export const pagebreak = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    main.append(h('span', { text: 'Seitenumbruch' }));
    main.addEventListener('mousedown', (e) => { e.preventDefault(); ed.selectBlocks([b]); });
  }
};

// ---------------------------------------------------------------------------
// Inhaltsverzeichnis
// ---------------------------------------------------------------------------

export const toc = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    const box = h('div', { class: 'toc' });
    const heads = ed.headings();
    if (!heads.length) box.append(h('div', { class: 'toc-empty', text: 'Inhaltsverzeichnis – füge Überschriften hinzu, dann erscheinen sie hier.' }));
    for (const hd of heads) {
      const a = h('a', { class: 'toc-item l' + hd.level });
      a.textContent = (hd.number ? hd.number + ' ' : '') + hd.text;
      a.addEventListener('mousedown', (e) => { e.preventDefault(); ed.scrollToBlock(hd.id); });
      box.append(a);
    }
    main.append(box);
  }
};

// ---------------------------------------------------------------------------
// Bild
// ---------------------------------------------------------------------------

function captionEl(ed, b, placeholder, kind) {
  const cap = h('div', { class: 'caption ' + kind, 'data-ph': placeholder, contenteditable: ed.readonly ? 'false' : 'true', spellcheck: 'true' });
  cap.innerHTML = b.caption || '';
  cap.addEventListener('input', () => { b.caption = normalizeHTML(cap.innerHTML).replace(/<br>/g, ' '); ed.changed({ soft: true }); ed.renumberCaptions && ed.renumberCaptions(); });
  cap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ed.exitAtom(b, 'after'); }
    if (e.key === 'Escape') { e.preventDefault(); cap.blur(); ed.selectBlocks([b]); }
    e.stopPropagation();
  });
  cap.addEventListener('focus', () => ed.setFocusBlock(b));
  return cap;
}

export const image = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    if (!b.src) {
      const ph = h('div', { class: 'atom-placeholder atom-view' }, h('span', { html: icon('image') }), 'Bild hinzufügen – klicken, hineinziehen oder einfügen (⌘V)');
      ph.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        if (ed.readonly) return;
        const res = await ed.host.pickFiles('image');
        if (res && res[0]) { ed.checkpoint(); b.src = res[0].link; b.caption = b.caption || ''; ed.rerender(b); ed.sizeNewImages([b]); ed.changed(); }
      });
      main.append(h('div', { class: 'img-wrap' }, ph));
      return;
    }
    const wrap = h('div', { class: 'img-wrap' });
    const frame = h('div', { class: 'img-frame loading' });
    frame.style.width = widthOf(b) + '%';
    const img = h('img', { src: assetURL(b.src), alt: b.caption ? b.caption.replace(/<[^>]+>/g, '') : '', draggable: 'false' });
    img.dataset.src = b.src;
    img.addEventListener('load', () => frame.classList.remove('loading'));
    img.addEventListener('error', () => { frame.classList.remove('loading'); frame.classList.add('broken'); });
    frame.append(img);
    if (!ed.readonly) {
      for (const side of ['l', 'r']) {
        const hd = h('div', { class: 'img-handle ' + side, 'data-tip': 'Ziehen: Größe ändern (rastet ein) · mit ⌥ stufenlos · Doppelklick: ganze Breite' });
        hd.addEventListener('mousedown', (e) => startResize(e, ed, b, frame, wrap, side));
        hd.addEventListener('dblclick', (e) => { e.stopPropagation(); setImageWidth(ed, [b], 100); });
        frame.append(hd);
      }
      frame.append(mediaBar(ed, b, [
        ...(ed.host.editImage ? [{ label: 'Bearbeiten', onClick: () => ed.host.editImage(b.src, b.id) }] : []),
        { label: formatPct(widthOf(b)), tip: 'Größe', onClick: (btn) => menu(btn, imageSizeItems(ed, b)) },
        { label: 'Beschriftung', onClick: () => { const c = wrap.querySelector('.caption'); if (c) c.focus(); else { b.caption = b.caption || ''; b._cap = true; ed.rerender(b); requestAnimationFrame(() => ed.elOf(b).querySelector('.caption')?.focus()); } } },
        { icon: 'alignLeft', tip: 'Links', onClick: () => setAlign(ed, b, 'left') },
        { icon: 'alignCenter', tip: 'Mitte', onClick: () => setAlign(ed, b, null) },
        { icon: 'alignRight', tip: 'Rechts', onClick: () => setAlign(ed, b, 'right') },
        { icon: 'database', tip: 'In DEVONthink zeigen', onClick: () => ed.host.revealLink(b.src) },
        { icon: 'more', tip: 'Mehr', onClick: (btn) => ed.openBlockMenu(b, btn) }
      ]));
      frame.addEventListener('mousedown', (e) => {
        if (e.target.closest('.media-bar, .img-handle')) return;
        e.preventDefault();
        ed.selectBlocks([b]);
      });
      // Doppelklick öffnet den Bildeditor (Textfelder, Pfeile, Zuschneiden …)
      frame.addEventListener('dblclick', (e) => {
        if (e.target.closest('.media-bar, .img-handle') || !ed.host.editImage) return;
        ed.host.editImage(b.src, b.id);
      });
    }
    wrap.append(frame);
    if (b.caption || b._cap) wrap.append(captionEl(ed, b, 'Bildunterschrift …', 'fig'));
    main.append(wrap);
  }
};

function setAlign(ed, b, align) {
  ed.checkpoint();
  if (align) b.align = align; else delete b.align;
  ed.rerender(b);
  ed.changed();
}

function mediaBar(ed, b, buttons) {
  const bar = h('div', { class: 'media-bar' });
  for (const bt of buttons) {
    const btn = h('button', { class: 'btn ' + (bt.icon ? 'icon-only' : ''), 'data-tip': bt.tip || '' });
    btn.innerHTML = bt.icon ? icon(bt.icon, 'sm') : esc(bt.label);
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => { e.stopPropagation(); bt.onClick(btn); });
    bar.append(btn);
  }
  return bar;
}

// Größe per Ziehen: rastet auf 25, 33, 50, 66, 75 und 100 % ein und auf die
// Breiten der anderen Bilder im Eintrag – mit gedrückter ⌥-Taste stufenlos
function startResize(e, ed, b, frame, wrap, side) {
  e.preventDefault();
  e.stopPropagation();
  ed.checkpoint();
  const startX = e.clientX;
  const startW = frame.getBoundingClientRect().width;
  const total = wrap.getBoundingClientRect().width || 1;
  const centered = !b.align || b.align === 'center';
  const others = otherWidths(ed.doc.blocks, b);
  // Einrasten in einem Bereich von etwa 10 Pixeln (bei zentrierten Bildern bewegt sich jede Seite halb so weit)
  const threshold = (10 / total) * 100 * (centered ? 2 : 1);
  const label = h('div', { class: 'img-size-label' });
  frame.append(label);
  frame.classList.add('resizing');
  const show = (w, snap) => {
    label.textContent = formatPct(w) + (snap === 'other' ? ' · wie anderes Bild' : '');
    label.classList.toggle('snapped', !!snap);
  };
  show(widthOf(b), null);
  const move = (ev) => {
    let dx = ev.clientX - startX;
    if (side === 'l') dx = -dx;
    if (centered) dx *= 2;
    const { width, snap } = snapWidth(((startW + dx) / total) * 100, { others, threshold, free: ev.altKey });
    frame.style.width = width + '%';
    if (width >= 100) delete b.width; else b.width = width;
    show(width, snap);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    label.remove();
    frame.classList.remove('resizing');
    ed.rerender(b, { keepFocus: false });
    ed.selectBlocks([b]);
    ed.changed();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

export const imageSizeLabel = (b) => formatPct(widthOf(b));

export function setImageWidth(ed, list, w) {
  ed.checkpoint();
  const v = roundWidth(w);
  for (const x of list) {
    if (v >= 100) delete x.width; else x.width = v;
    ed.rerender(x, { keepFocus: false });
  }
  ed.selectBlocks(list.length === 1 ? list : [list[0]].filter(Boolean));
  ed.changed();
}

// Menü „Größe“ (Bildleiste und Blockmenü)
export function imageSizeItems(ed, b) {
  const cur = roundWidth(widthOf(b));
  const same = (w) => Math.abs(w - cur) < 0.05;
  const items = SIZE_PRESETS.map(p => ({ label: p.label, hint: formatPct(p.width), checked: same(p.width), onSelect: () => setImageWidth(ed, [b], p.width) }));
  // Größen, die andere Bilder im Eintrag schon haben
  const others = otherWidths(ed.doc.blocks, b).filter(w => !SIZE_PRESETS.some(p => Math.abs(p.width - w) < 0.05));
  for (const w of others) items.push({ label: 'Wie anderes Bild', hint: formatPct(w), checked: same(w), onSelect: () => setImageWidth(ed, [b], w) });
  items.push({ label: 'Eigene Größe …', hint: SIZE_PRESETS.some(p => same(p.width)) || others.some(same) ? '' : formatPct(cur), onSelect: async () => {
    const v = await ed.ui.prompt('Breite des Bildes', String(cur).replace('.', ','), { placeholder: 'in Prozent der Spalte, z. B. 40', description: 'In Prozent der Spaltenbreite (10 bis 100).' });
    if (v === null) return;
    const n = parseFloat(String(v).replace(',', '.').replace('%', ''));
    if (Number.isFinite(n)) setImageWidth(ed, [b], n);
  } });
  const group = sameContextImages(ed.doc.blocks, b);
  if (group.length > 1) {
    const differs = group.some(x => Math.abs(roundWidth(widthOf(x)) - cur) >= 0.05);
    items.push('-', { label: `Alle Bilder auf ${formatPct(cur)}`, icon: 'image', disabled: !differs, hint: differs ? `${group.length} Bilder` : 'schon gleich', onSelect: () => setImageWidth(ed, group, cur) });
  }
  return items;
}

// ---------------------------------------------------------------------------
// PDF / Arbeitsblatt
// ---------------------------------------------------------------------------

function parsePages(spec, count) {
  if (!spec) return Array.from({ length: count }, (_, i) => i + 1);
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = +m[1], z = m[2] ? +m[2] : a;
    for (let p = a; p <= Math.min(z, count || z); p++) out.push(p);
  }
  return out;
}

export const pdf = {
  atom: true,
  render(ed, b, main) {
    main.innerHTML = '';
    if (!b.src) {
      const ph = h('div', { class: 'atom-placeholder atom-view' }, h('span', { html: icon('pdf') }), 'Arbeitsblatt (PDF) einbetten – klicken oder hineinziehen');
      ph.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        if (ed.readonly) return;
        const res = await ed.host.pickFiles('pdf');
        if (res && res[0]) { ed.checkpoint(); b.src = res[0].link; b.caption = b.caption || res[0].name || ''; ed.rerender(b); ed.changed(); }
      });
      main.append(ph);
      return;
    }
    const box = h('div', { class: 'pdf-embed' });
    const uuid = uuidFromLink(b.src);
    const title = h('span', { class: 't', text: (b.caption || 'Arbeitsblatt').replace(/<[^>]+>/g, '') });
    const head = h('div', { class: 'pdf-embed-head' }, h('span', { html: icon('pdf') }), title);
    if (!ed.readonly) {
      const openBtn = h('button', { class: 'btn sm outline' }, icon('pencil', 'sm'), 'Bearbeiten');
      openBtn.addEventListener('click', () => ed.host.openPDF(uuid, b.id));
      const pagesBtn = h('button', { class: 'btn sm' }, b.pages ? `Seiten ${b.pages}` : 'Alle Seiten');
      pagesBtn.addEventListener('click', async () => {
        const v = await ed.ui.prompt('Welche Seiten sollen angezeigt werden?', b.pages || '', { placeholder: 'z. B. 1-2 oder 1,3 (leer = alle)' });
        if (v === null) return;
        ed.checkpoint();
        b.pages = v.trim() || undefined;
        ed.rerender(b);
        ed.changed();
      });
      const more = h('button', { class: 'btn icon-only sm', html: icon('more', 'sm') });
      more.addEventListener('click', () => ed.openBlockMenu(b, more));
      head.append(pagesBtn, openBtn, more);
    }
    const pages = h('div', { class: 'pdf-pages' });
    pages.dataset.v = assetVersion(uuid);
    box.append(head, pages);
    main.append(box);
    const width = Math.round(Math.min(1800, (main.clientWidth || 700) * (window.devicePixelRatio || 2)));
    ed.host.pdfInfo(uuid).then(info => {
      const list = parsePages(b.pages, info && info.pages || 1);
      pages.innerHTML = '';
      for (const p of list) pages.append(h('img', { src: assetURL(b.src, { page: p, width }), loading: 'lazy', draggable: 'false', alt: `Seite ${p}` }));
      ed.notifyLayout();
    }).catch(() => {
      pages.innerHTML = '';
      pages.append(h('div', { class: 'hint', text: 'PDF nicht gefunden.' }));
    });
    box.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      ed.selectBlocks([b]);
    });
    box.addEventListener('dblclick', () => ed.host.openPDF(uuid, b.id));
  }
};

// ---------------------------------------------------------------------------
// Spalten
// ---------------------------------------------------------------------------

export const columns = {
  atom: false,
  container: true,
  render(ed, b, main) {
    main.innerHTML = '';
    const cols = h('div', { class: 'cols' });
    b.children.forEach((col, i) => {
      const colEl = h('div', { class: 'col blk', 'data-id': col.id, 'data-type': 'column' });
      colEl.style.flex = flexFor(col.width);
      const kids = h('div', { class: 'blk-children' });
      if (!col.children.length) col.children.push(ed.makeBlock('p'));
      for (const c of col.children) kids.append(ed.renderBlock(c));
      colEl.append(kids);
      // Griff zwischen zwei Spalten: ziehen = Breiten ändern, Doppelklick = gleich breit
      if (i > 0 && !ed.readonly) colEl.append(columnResizer(ed, b, i, cols));
      ed.registerEl(col, colEl);
      cols.append(colEl);
    });
    main.append(cols);
  }
};

function columnResizer(ed, b, i, cols) {
  const grip = h('div', { class: 'col-resize', 'data-tip': 'Ziehen: Breite ändern · Doppelklick: gleich breit · Rechtsklick: genaue Werte' });
  const label = h('div', { class: 'col-resize-label' });
  grip.append(label);
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const left = b.children[i - 1], right = b.children[i];
    const els = [...cols.children];
    const total = cols.getBoundingClientRect().width;
    const w1 = els[i - 1].getBoundingClientRect().width, w2 = els[i].getBoundingClientRect().width;
    const ratioSum = ratioOf(left.width) + ratioOf(right.width);
    const x0 = e.clientX;
    ed.checkpoint();
    grip.classList.add('dragging');
    document.body.classList.add('col-resizing');
    const apply = (dx) => {
      const a = Math.max(60, Math.min(w1 + w2 - 60, w1 + dx)), c = w1 + w2 - a;
      // Feste Breiten bleiben fest (in ihrer Einheit), Anteile bleiben Anteile
      left.width = widthKind(left.width) === 'fixed' ? fromPx(a, left.width, total) : `${+(ratioSum * a / (a + c)).toFixed(2)}fr`;
      right.width = widthKind(right.width) === 'fixed' ? fromPx(c, right.width, total) : `${+(ratioSum * c / (a + c)).toFixed(2)}fr`;
      if (widthKind(left.width) === 'ratio' && widthKind(right.width) === 'ratio' && Math.abs(parseFloat(left.width) - parseFloat(right.width)) < 0.04) {
        left.width = right.width = `${+(ratioSum / 2).toFixed(2)}fr`;
      }
      els[i - 1].style.flex = flexFor(left.width);
      els[i].style.flex = flexFor(right.width);
      label.textContent = `${formatWidth(left.width) || '1'}  |  ${formatWidth(right.width) || '1'}`;
    };
    const move = (ev) => apply(ev.clientX - x0);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      grip.classList.remove('dragging');
      document.body.classList.remove('col-resizing');
      ed.changed();
      ed.alignSoon && ed.alignSoon();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  grip.addEventListener('dblclick', (e) => {
    e.preventDefault();
    ed.checkpoint();
    for (const col of b.children) delete col.width;
    ed.rerender(b);
    ed.changed();
  });
  grip.addEventListener('contextmenu', (e) => { e.preventDefault(); columnWidthsDialog(ed, b); });
  return grip;
}

export async function columnWidthsDialog(ed, b) {
  const specs = await widthDialog({
    title: 'Spaltenbreiten',
    labels: b.children.map((_, i) => `Spalte ${i + 1}`),
    specs: b.children.map(c => c.width || null)
  });
  if (!specs) return;
  ed.checkpoint();
  b.children.forEach((c, i) => { if (specs[i]) c.width = specs[i]; else delete c.width; });
  ed.rerender(b);
  ed.changed();
}

export { captionEl, mediaBar, insertAtCursor, srcTextarea, panelKeys };
