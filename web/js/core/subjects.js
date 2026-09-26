// Fächer und ihre Farben.
//
// Die Farbe eines Fachs erscheint in der Seitenleiste (Fachordner und alles
// darin), beim Fach im Eintrag und in "Zuletzt geöffnet". Festgelegt wird sie
// in den Einstellungen; ohne eigene Wahl gilt eine sinnvolle Voreinstellung.

export const SUBJECT_COLORS = ['blue', 'red', 'orange', 'yellow', 'green', 'purple', 'pink', 'brown', 'gray'];
export const COLOR_LABELS = { blue: 'Blau', red: 'Rot', orange: 'Orange', yellow: 'Gelb', green: 'Grün', purple: 'Lila', pink: 'Rosa', brown: 'Braun', gray: 'Grau' };

export const DEFAULT_SUBJECT_COLORS = {
  mathe: 'blue', mathematik: 'blue', deutsch: 'red', englisch: 'orange', latein: 'brown', französisch: 'pink', spanisch: 'pink',
  physik: 'purple', chemie: 'green', biologie: 'yellow', geschichte: 'brown', ethik: 'gray', religion: 'gray',
  geographie: 'green', erdkunde: 'green', informatik: 'blue', wirtschaft: 'yellow', sozialkunde: 'pink', politik: 'pink',
  kunst: 'pink', musik: 'purple', sport: 'orange'
};

const norm = (s) => String(s || '').trim().toLowerCase();

// Farbe eines Fachs (eigene Wahl vor Voreinstellung); null = keine Farbe
export function subjectColor(settings, name) {
  if (!name) return null;
  const own = (settings && settings.subjectColors) || {};
  for (const k of Object.keys(own)) if (norm(k) === norm(name)) return own[k] || null;
  return DEFAULT_SUBJECT_COLORS[norm(name)] || null;
}

// Gehört ein Ordner zu einem Fach? ("Mathe", "02 Mathe", "Mathe LK" → Mathe)
export function subjectOfFolder(folderName, subjects) {
  const clean = norm(String(folderName || '').replace(/^[\d.\s_-]+/, ''));
  if (!clean) return null;
  for (const s of subjects || []) {
    const n = norm(s);
    if (clean === n || clean.startsWith(n + ' ')) return s;
  }
  return null;
}

export function colorDot(color, size = 10) {
  const bg = color ? `var(--t-${color})` : 'transparent';
  const border = color ? 'transparent' : 'var(--border-strong)';
  return `<span class="subject-dot" style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:1px solid ${border};flex:none"></span>`;
}
