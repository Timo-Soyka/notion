// Mehrzeilige Formeln mit Ausrichtungspunkten.
//
// Im Editor ist jede Zeile ein eigenes Formelfeld. Ein Ausrichtungspunkt ist
// dort der Befehl \heftmark{ID} (ein farbiger Strich). Gespeichert wird
// gewöhnliches LaTeX, das auch DEVONthink und andere Programme anzeigen:
//
//   Zeilen:  x \heftmark{1} = 2 + 3      →   \begin{aligned}
//            \heftmark{1} = 5                  x &= 2 + 3 \\
//                                              &= 5
//                                             \end{aligned}
//
// Punkte mit derselben ID stehen später genau untereinander. Mehrere IDs in
// einer Zeile ergeben mehrere Spalten (alignedat); die ID ist die Spalte,
// deshalb bleibt sie beim Speichern und Wiederöffnen erhalten.

import { toLatex } from './typstmath.js';

export const MARK_RE = /\\heftmark\{(\d+)\}/g;

const ALIGN_ENVS = 'aligned|alignedat|align\\*?|gathered|gather\\*?|split|flalign\\*?|eqnarray\\*?|multline\\*?';
const ENV_RE = new RegExp(`^\\\\begin\\{(${ALIGN_ENVS})\\}(?:\\{\\d+\\})?([\\s\\S]*?)\\\\end\\{\\1\\}$`);

// Zerlegt LaTeX auf oberster Ebene (nicht in {…} und nicht in \begin…\end)
// an Zeilenumbrüchen "\\", Spaltentrennern "&" und Ausrichtungspunkten.
function scanTop(src) {
  const parts = [];
  let depth = 0, env = 0, start = 0, i = 0;
  const cut = (end, sep) => { parts.push({ text: src.slice(start, end), sep: null }); parts.push(sep); };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const rest = src.slice(i);
      let m;
      if ((m = /^\\begin\{[^}]*\}/.exec(rest))) { env++; i += m[0].length; continue; }
      if ((m = /^\\end\{[^}]*\}/.exec(rest))) { env = Math.max(0, env - 1); i += m[0].length; continue; }
      if (depth === 0 && env === 0) {
        if ((m = /^\\\\(\s*\[[^\]]*\])?/.exec(rest))) { cut(i, { sep: 'row' }); i += m[0].length; start = i; continue; }
        if ((m = /^\\heftmark\{(\d+)\}/.exec(rest))) { cut(i, { sep: 'mark', id: parseInt(m[1], 10) }); i += m[0].length; start = i; continue; }
        if ((m = /^\\heftbar(?![a-zA-Z])/.exec(rest))) { cut(i, { sep: 'bar' }); i += m[0].length; start = i; continue; }
      }
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '&' && depth === 0 && env === 0) { cut(i, { sep: 'cell' }); i++; start = i; continue; }
    i++;
  }
  parts.push({ text: src.slice(start), sep: null });
  return parts;
}

function splitRows(src) {
  const rows = [[]];
  for (const p of scanTop(src)) {
    if (p.sep === 'row') rows.push([]);
    else rows[rows.length - 1].push(p);
  }
  return rows;
}

const tidy = (s) => s.replace(/\s+/g, ' ').trim();

// Punkte, die nicht auf oberster Ebene stehen (z. B. in einem Bruch), zählen nicht
function dropNestedMarks(s) { return s.replace(MARK_RE, ''); }

// Gespeichertes LaTeX → Zeilen für den Editor
export function latexToLines(tex) {
  let s = String(tex ?? '').trim();
  const m = ENV_RE.exec(s);
  if (m) s = m[2];
  const rows = splitRows(s).map(parts => {
    // erst in Spalten zerlegen
    const cells = [''];
    for (const p of parts) {
      if (p.sep === 'cell') { cells.push(''); continue; }
      if (p.sep === 'mark') { cells[cells.length - 1] += `\\heftmark{${p.id}}`; continue; }
      if (p.sep === 'bar') { cells[cells.length - 1] += '\\heftbar '; continue; }
      cells[cells.length - 1] += p.text;
    }
    let out = '';
    for (let col = 0; col < cells.length; col++) {
      const t = tidy(cells[col]);
      // Kommandostrich: leere Abstandsspalte "\qquad", danach "\vert …"
      if (col % 2 === 0 && col > 0 && t === '\\qquad' && /^\\vert(?![a-zA-Z])/.test(tidy(cells[col + 1] || ''))) {
        out += '\\heftbar ' + tidy(cells[col + 1]).replace(/^\\vert(\\[;,: ]|\s)*/, '');
        col++;
        continue;
      }
      if (!t) continue;
      // Linksbündige Spalte = Ausrichtungspunkt; leere Spalten zählen nicht
      if (col % 2 === 1) out += `\\heftmark{${(col + 1) / 2}}`;
      else if (col > 0 && out) out += ' ';
      out += t;
    }
    return out.replace(/\s*(\\heftmark\{\d+\})\s*/g, '$1').trim();
  });
  while (rows.length > 1 && !rows[rows.length - 1]) rows.pop();
  return rows.length ? rows : [''];
}

// Eine Editorzeile in Stücke zwischen den Ausrichtungspunkten zerlegen
function lineParts(line) {
  const parts = [{ id: 0, text: '' }];
  let bar = null;
  for (const p of scanTop(String(line ?? ''))) {
    if (bar !== null) { if (p.sep === null && p.text !== undefined) bar += p.text; continue; }
    if (p.sep === 'bar') { bar = ''; continue; }
    if (p.sep === 'mark') parts.push({ id: p.id, text: '' });
    else if (p.sep === 'row' || p.sep === 'cell') parts[parts.length - 1].text += p.sep === 'row' ? ' ' : ' ';
    else if (p.sep === null && p.text !== undefined) parts[parts.length - 1].text += p.text;
  }
  const out = parts.map(p => ({ id: p.id, text: tidy(dropNestedMarks(p.text)) }));
  out.bar = bar === null ? null : tidy(dropNestedMarks(bar));
  return out;
}

// Zeilen aus dem Editor → LaTeX zum Speichern
// opts.left: Zeilen ohne Ausrichtungspunkte linksbündig untereinander (statt mittig)
export function linesToLatex(lines, opts = {}) {
  const rows = (lines || []).map(l => String(l ?? '')).filter(l => tidy(l.replace(MARK_RE, '')));
  if (!rows.length) return '';
  const parsed = rows.map(lineParts);
  // IDs pro Zeile müssen aufsteigen; ein "falscher" Punkt wird ignoriert
  let maxId = 0;
  const clean = parsed.map(parts => {
    const out = [{ id: 0, text: parts[0].text }];
    let last = 0;
    for (const p of parts.slice(1)) {
      if (p.id > last) { out.push({ id: p.id, text: p.text }); last = p.id; maxId = Math.max(maxId, p.id); }
      else out[out.length - 1].text = tidy(out[out.length - 1].text + ' ' + p.text);
    }
    out.bar = parts.bar;
    return out;
  });
  // Kommandostriche ("| −3") bekommen eine eigene Spalte ganz rechts, damit sie
  // untereinander stehen. Ohne Ausrichtungspunkte stehen die Zeilen links.
  if (clean.some(p => p.bar !== null && p.bar !== undefined)) {
    if (!maxId) {
      for (const p of clean) { p.splice(0, 1, { id: 0, text: '' }, { id: 1, text: p[0].text }); }
      maxId = 1;
    }
    const barCol = maxId + 1;
    const body = clean.map(parts => {
      const cells = new Array(2 * barCol).fill('');
      cells[0] = parts[0].text;
      for (const p of parts.slice(1)) cells[2 * p.id - 1] = p.text;
      if (parts.bar !== null && parts.bar !== undefined) { cells[2 * barCol - 2] = '\\qquad'; cells[2 * barCol - 1] = ('\\vert\\; ' + parts.bar).trim(); }
      while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
      let out = cells[0];
      for (let i = 1; i < cells.length; i++) out += (out && !out.endsWith('&') ? ' ' : '') + '&' + cells[i];
      return out;
    });
    return `\\begin{alignedat}{${barCol}}\n` + body.join(' \\\\\n') + '\n\\end{alignedat}';
  }
  if (!maxId) {
    const plain = clean.map(p => p[0].text).filter(Boolean);
    if (plain.length <= 1) return plain[0] || '';
    if (opts.left) return '\\begin{aligned}\n' + plain.map(l => '&' + l).join(' \\\\\n') + '\n\\end{aligned}';
    return '\\begin{gathered}\n' + plain.join(' \\\\\n') + '\n\\end{gathered}';
  }
  const body = clean.map(parts => {
    const cells = new Array(2 * maxId).fill('');
    cells[0] = parts[0].text;
    for (const p of parts.slice(1)) cells[2 * p.id - 1] = p.text;
    while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    let out = cells[0];
    for (let i = 1; i < cells.length; i++) out += (out && !out.endsWith('&') ? ' ' : '') + '&' + cells[i];
    return out;
  });
  const env = maxId === 1 ? 'aligned' : 'alignedat';
  const arg = maxId === 1 ? '' : `{${maxId}}`;
  return `\\begin{${env}}${arg}\n` + body.join(' \\\\\n') + `\n\\end{${env}}`;
}

// Hat die Formel Ausrichtungspunkte / mehrere Zeilen?
export function isMultiline(tex) {
  return latexToLines(tex).length > 1;
}

// Aufräumen, was das Formelfeld liefert: leere Platzhalter entfernen
export function cleanFieldLatex(latex) {
  return repairLatex(String(latex ?? '')
    .replace(/\\placeholder(\[[^\]]*\])?\{\}/g, '')
    .replace(/\\placeholder(\[[^\]]*\])?\{([^{}]*)\}/g, '{$2}'));
}

// Typische Tippfehler reparieren (auch in schon gespeicherten Formeln):
// "dm" (Typst-Schreibweise für Text/Einheiten) → \text{dm};
// \2 (entsteht durch die ^-Tottaste der deutschen Tastatur) → ^{2}
export function repairLatex(tex) {
  return String(tex ?? '')
    .replace(/"([^"\\{}]*)"/g, (_, t) => `\\text{${t}}`)
    .replace(/(?<!\\)\\(\d)/g, '^{$1}');
}

// Formeln mit Befehlen, die das Formelfeld nicht kennt, werden als Quelltext bearbeitet
export function needsSource(tex) {
  return /\\(ce|pu|tag|label|href|url|htmlClass|includegraphics)\b/.test(String(tex ?? ''));
}

// Farben der Ausrichtungs-IDs (auch für das Kontextmenü)
export const MARK_COLORS = ['#2383e2', '#e16f24', '#2f9e5b', '#9b51e0', '#d6336c', '#0f9fb5', '#b8860b', '#6b7280'];
export const MARK_NAMES = ['Blau', 'Orange', 'Grün', 'Lila', 'Pink', 'Türkis', 'Gelb', 'Grau'];
export const markColor = (id) => MARK_COLORS[(Math.max(1, id) - 1) % MARK_COLORS.length];
export const markName = (id) => MARK_NAMES[(Math.max(1, id) - 1) % MARK_NAMES.length];

// ---------------------------------------------------------------------------
// Ältere Einträge mit Typst-Formeln einheitlich auf LaTeX umstellen, damit
// das Formelfeld sie bearbeiten kann. Aussehen und PDF bleiben gleich.
// ---------------------------------------------------------------------------


const unescAttr = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function convertInlineHTML(html, mode) {
  return html.replace(/data-tex="([^"]*)"/g, (_, v) => `data-tex="${escAttr(toLatex(unescAttr(v), mode))}"`);
}

export function normalizeMathSyntax(doc, fallback = 'auto') {
  const meta = doc.meta || (doc.meta = {});
  if (meta.mathSyntax === 'latex') return false;
  const mode = meta.mathSyntax || fallback || 'auto';
  if (mode === 'latex') { meta.mathSyntax = 'latex'; return false; }
  let changed = false;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (k === 'tex' && v.type === 'math' && typeof x === 'string') {
          const t = toLatex(x, mode);
          if (t !== x) { v[k] = t; changed = true; }
        } else if (typeof x === 'string' && x.includes('data-tex="')) {
          const t = convertInlineHTML(x, mode);
          if (t !== x) { v[k] = t; changed = true; }
        } else if (x && typeof x === 'object') walk(x);
      }
    }
    return v;
  };
  walk(doc.blocks || []);
  meta.mathSyntax = 'latex';
  return changed;
}
