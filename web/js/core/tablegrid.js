// Tabellen mit verbundenen Zellen.
//
// Die Tabelle bleibt intern ein volles Raster (b.rows[r][c]). Verbundene
// Zellen stehen zusätzlich in b.merges als Rechtecke {r, c, rs, cs}: die Zelle
// oben links ("Anker") zeigt den Inhalt, die übrigen sind verdeckt und leer.
// Zellfarben liegen in b.bg (gleiches Raster, Farbname oder null).
// So bleiben Zeilen/Spalten einfügen und löschen einfache Operationen.

export function ncols(b) {
  return Math.max(1, ...(b.rows || [[]]).map(r => r.length));
}

// Raster rechteckig machen und ungültige Verbindungen entfernen
export function normalizeTable(b) {
  if (!b.rows || !b.rows.length) b.rows = [['']];
  const R = b.rows.length, C = ncols(b);
  for (const r of b.rows) while (r.length < C) r.push('');
  if (b.bg) {
    const bg = [];
    let any = false;
    for (let r = 0; r < R; r++) {
      bg.push([]);
      for (let c = 0; c < C; c++) {
        const v = (b.bg[r] && b.bg[r][c]) || null;
        bg[r].push(v);
        if (v) any = true;
      }
    }
    if (any) b.bg = bg; else delete b.bg;
  }
  const taken = Array.from({ length: R }, () => Array(C).fill(false));
  const ok = [];
  for (const m of (b.merges || []).slice().sort((x, y) => x.r - y.r || x.c - y.c)) {
    let { r, c, rs, cs } = m;
    if (!(r >= 0 && c >= 0 && r < R && c < C)) continue;
    rs = Math.max(1, Math.min(rs | 0, R - r));
    cs = Math.max(1, Math.min(cs | 0, C - c));
    if (rs === 1 && cs === 1) continue;
    let clash = false;
    for (let i = r; i < r + rs && !clash; i++) for (let j = c; j < c + cs; j++) if (taken[i][j]) { clash = true; break; }
    if (clash) continue;
    for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) taken[i][j] = true;
    ok.push({ r, c, rs, cs });
  }
  if (ok.length) b.merges = ok; else delete b.merges;
  if (b.colWidths) {
    b.colWidths = Array.from({ length: C }, (_, i) => b.colWidths[i] || null);
    if (!b.colWidths.some(Boolean)) delete b.colWidths;
  }
  return b;
}

// Für jede Position: zu welcher (Anker-)Zelle gehört sie?
export function cellMap(b) {
  const R = b.rows.length, C = ncols(b);
  const map = Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => ({ r, c, rs: 1, cs: 1, anchor: true })));
  for (const m of b.merges || []) {
    for (let i = m.r; i < m.r + m.rs; i++) {
      for (let j = m.c; j < m.c + m.cs; j++) {
        if (!map[i] || !map[i][j]) continue;
        map[i][j] = { r: m.r, c: m.c, rs: m.rs, cs: m.cs, anchor: i === m.r && j === m.c };
      }
    }
  }
  return map;
}

export function anchorAt(b, r, c) {
  const map = cellMap(b);
  const R = map.length, C = map[0].length;
  r = Math.max(0, Math.min(R - 1, r));
  c = Math.max(0, Math.min(C - 1, c));
  const x = map[r][c];
  return { r: x.r, c: x.c, rs: x.rs, cs: x.cs };
}

// Rechteck aus zwei Zellen, so vergrößert, dass keine Verbindung angeschnitten ist
export function rectFrom(b, a, z) {
  let r1 = Math.min(a.r, z.r), c1 = Math.min(a.c, z.c);
  let r2 = Math.max(a.r + (a.rs || 1) - 1, z.r + (z.rs || 1) - 1);
  let c2 = Math.max(a.c + (a.cs || 1) - 1, z.c + (z.cs || 1) - 1);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of b.merges || []) {
      const mr2 = m.r + m.rs - 1, mc2 = m.c + m.cs - 1;
      const hit = m.r <= r2 && mr2 >= r1 && m.c <= c2 && mc2 >= c1;
      if (!hit) continue;
      if (m.r < r1) { r1 = m.r; grew = true; }
      if (m.c < c1) { c1 = m.c; grew = true; }
      if (mr2 > r2) { r2 = mr2; grew = true; }
      if (mc2 > c2) { c2 = mc2; grew = true; }
    }
  }
  return { r1, c1, r2, c2 };
}

export const rectSize = (x) => (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1);
export const inRect = (x, r, c) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2;

const isEmpty = (html) => !String(html || '').replace(/<br\s*\/?>|&nbsp;|\s/g, '');

// Zellen im Rechteck zu einer verbinden; Inhalte werden untereinander übernommen
export function mergeRect(b, rect) {
  normalizeTable(b);
  const x = rectFrom(b, { r: rect.r1, c: rect.c1 }, { r: rect.r2, c: rect.c2 });
  if (rectSize(x) < 2) return false;
  const parts = [];
  for (let r = x.r1; r <= x.r2; r++) {
    for (let c = x.c1; c <= x.c2; c++) {
      if (!isEmpty(b.rows[r][c])) parts.push(b.rows[r][c]);
      b.rows[r][c] = '';
    }
  }
  b.rows[x.r1][x.c1] = parts.join('<br>');
  b.merges = (b.merges || []).filter(m => !(m.r >= x.r1 && m.r <= x.r2 && m.c >= x.c1 && m.c <= x.c2));
  b.merges.push({ r: x.r1, c: x.c1, rs: x.r2 - x.r1 + 1, cs: x.c2 - x.c1 + 1 });
  return normalizeTable(b), true;
}

// Verbindungen im Rechteck (oder an einer Zelle) wieder aufheben
export function splitRect(b, rect) {
  const before = (b.merges || []).length;
  b.merges = (b.merges || []).filter(m => !(m.r + m.rs - 1 >= rect.r1 && m.r <= rect.r2 && m.c + m.cs - 1 >= rect.c1 && m.c <= rect.c2));
  normalizeTable(b);
  return (b.merges || []).length !== before;
}

export function hasMergeIn(b, rect) {
  return (b.merges || []).some(m => m.r + m.rs - 1 >= rect.r1 && m.r <= rect.r2 && m.c + m.cs - 1 >= rect.c1 && m.c <= rect.c2);
}

// Zeile/Spalte einfügen: Verbindungen, die darüber hinweg gehen, werden länger
export function insertRow(b, at) {
  const C = ncols(b);
  b.rows.splice(at, 0, Array(C).fill(''));
  if (b.bg) b.bg.splice(at, 0, Array(C).fill(null));
  for (const m of b.merges || []) {
    if (at <= m.r) m.r++;
    else if (at < m.r + m.rs) m.rs++;
  }
  normalizeTable(b);
}

export function insertCol(b, at) {
  for (const row of b.rows) row.splice(at, 0, '');
  if (b.bg) for (const row of b.bg) row.splice(at, 0, null);
  if (b.aligns && b.aligns.length > at) b.aligns.splice(at, 0, null);
  if (b.colWidths) b.colWidths.splice(at, 0, null);
  for (const m of b.merges || []) {
    if (at <= m.c) m.c++;
    else if (at < m.c + m.cs) m.cs++;
  }
  normalizeTable(b);
}

// Zeile/Spalte löschen: steht dort der Anker einer Verbindung, wandert der Inhalt mit
export function deleteRow(b, at) {
  if (b.rows.length <= 1) return false;
  for (const m of b.merges || []) {
    if (m.r === at && m.rs > 1) b.rows[at + 1][m.c] = b.rows[at][m.c];
  }
  b.rows.splice(at, 1);
  if (b.bg) b.bg.splice(at, 1);
  for (const m of b.merges || []) {
    if (at < m.r) m.r--;
    else if (at < m.r + m.rs) m.rs--;
  }
  b.merges = (b.merges || []).filter(m => m.rs > 0);
  normalizeTable(b);
  return true;
}

export function deleteCol(b, at) {
  if (ncols(b) <= 1) return false;
  for (const m of b.merges || []) {
    if (m.c === at && m.cs > 1) b.rows[m.r][at + 1] = b.rows[m.r][at];
  }
  for (const row of b.rows) row.splice(at, 1);
  if (b.bg) for (const row of b.bg) row.splice(at, 1);
  if (b.aligns) b.aligns.splice(at, 1);
  if (b.colWidths) b.colWidths.splice(at, 1);
  for (const m of b.merges || []) {
    if (at < m.c) m.c--;
    else if (at < m.c + m.cs) m.cs--;
  }
  b.merges = (b.merges || []).filter(m => m.cs > 0);
  normalizeTable(b);
  return true;
}

export function setBg(b, rect, color) {
  const R = b.rows.length, C = ncols(b);
  if (!b.bg) b.bg = Array.from({ length: R }, () => Array(C).fill(null));
  for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) b.bg[r][c] = color || null;
  normalizeTable(b);
}

export function clearRect(b, rect) {
  for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) b.rows[r][c] = '';
}

// Nächste/vorige Zelle in Lesereihenfolge (verdeckte Zellen werden übersprungen)
export function stepCell(b, r, c, dir) {
  const map = cellMap(b);
  const R = map.length, C = map[0].length;
  let i = r * C + c;
  const cur = map[r][c];
  for (;;) {
    i += dir;
    if (i < 0 || i >= R * C) return null;
    const x = map[Math.floor(i / C)][i % C];
    if (x.anchor && !(x.r === cur.r && x.c === cur.c)) return { r: x.r, c: x.c };
  }
}

// Braucht die Tabelle HTML statt der einfachen Markdown-Schreibweise?
export function needsHtmlTable(b) {
  return !!((b.merges && b.merges.length) || (b.bg && b.bg.some(row => row.some(Boolean))) || b.headerCol ||
    b.tableWidth || (b.colWidths && b.colWidths.some(Boolean)));
}
