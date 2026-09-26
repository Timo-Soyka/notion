// Druckansicht: rendert einen Eintrag ohne Bedienelemente. Die Mac-App lädt
// diese Seite unsichtbar, wartet auf "print.ready" und druckt sie als PDF.
// Seitenzahlen und Kopfzeile zeichnet die Mac-App danach selbst auf die Seiten.

import { call } from './bridge.js';
import { parseDocument } from './core/markdown.js';
import { Editor } from './editor/editor.js';
import { withDefaults } from './app/settings.js';
import { formatDate } from './ui/ui.js';

// Fehler immer melden, damit die Mac-App nicht auf "fertig" wartet
window.addEventListener('error', (e) => call('print.ready', { ok: false, error: String(e.message || e) }));
window.addEventListener('unhandledrejection', (e) => call('print.ready', { ok: false, error: String((e.reason && e.reason.message) || e.reason) }));

export async function renderPrint(uuid) {
  try { await renderPrintInner(uuid); }
  catch (e) { call('print.ready', { ok: false, error: String(e.message || e) }); }
}

async function renderPrintInner(uuid) {
  document.documentElement.dataset.theme = 'light';
  document.body.classList.add('print-mode');
  const root = document.getElementById('root');
  let settings, res;
  try {
    settings = withDefaults(await call('settings.get'));
    res = await call('note.read', { uuid });
  } catch (e) {
    root.textContent = 'Fehler: ' + e.message;
    call('print.ready', { ok: false, error: e.message });
    return;
  }
  const doc = parseDocument(res.markdown || '', { defaultTitle: res.name, recordName: res.name });
  const pdf = settings.pdf || {};
  const ed = new Editor(root, { readonly: true, print: true, settings: { ...settings, printOpenToggles: pdf.openToggles !== false } });
  ed.load(doc);
  const d = ed.docEl;
  d.classList.add('print');
  if (pdf.titleCentered !== false) d.classList.add('title-centered');
  // Eigenschaften im Kopf: Fach und Datum als schlichte Zeile, keine Schlagwörter
  const props = d.querySelector('.doc-props');
  if (props) {
    const parts = [doc.meta.subject, doc.meta.date ? formatDate(doc.meta.date) : null].filter(Boolean);
    props.innerHTML = '';
    if (parts.length) props.textContent = parts.join(' · ');
    else props.remove();
  }
  await settle(d);
  // Ausrichtungspunkte erst ausrichten, wenn die Schriften sicher geladen sind
  ed.alignMarks();
  // Tabellenbreiten erst jetzt berechnen – die Druckansicht hat ihre endgültige Breite
  for (const w of ed.blocksEl.querySelectorAll('.table-wrap')) w._layout && w._layout();
  keepTogether(ed.blocksEl);
  await new Promise(r => setTimeout(r, 30));
  const m = doc.meta;
  call('print.ready', {
    ok: true,
    title: [m.number, m.title].filter(Boolean).join(' '),
    subject: m.subject || '',
    date: m.date ? formatDate(m.date) : '',
    name: settings.name || '',
    font: m.font || settings.font || 'sans'
  });
}

// Seitenumbrüche: Zusammengehöriges in einen Block fassen, den der Druck
// nicht teilt – eine Aufgabennummer ("10a", "12a (1)") mit der Rechnung
// darunter und jede Überschrift mit dem, was direkt folgt.
const TASK_LABEL = /^\s*(Aufgabe\s*|Nr\.?\s*)?\d+\s*[a-z]?\s*\)?\s*(\(\s*\d+\s*\))?\s*:?\s*$/i;
const SOLUTION_TYPES = new Set(['math', 'chem', 'plot', 'smiles', 'table', 'image', 'code']);

function keepTogether(root) {
  if (!root) return;
  const wrap = (els) => {
    const box = document.createElement('div');
    box.className = 'keep-together';
    els[0].before(box);
    box.append(...els);
    return box;
  };
  for (const container of [root, ...root.querySelectorAll('.blk-children')]) {
    let kids = [...container.children];
    // 1) Aufgabennummer + folgende Formeln/Graphen
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (!el.classList.contains('blk') || el.dataset.type !== 'p') continue;
      const text = (el.querySelector(':scope > .blk-main > .blk-text')?.textContent || '').replace(/\u200B/g, '');
      if (!TASK_LABEL.test(text)) continue;
      const group = [el];
      let j = i + 1;
      while (j < kids.length && kids[j].classList.contains('blk') && SOLUTION_TYPES.has(kids[j].dataset.type)) group.push(kids[j++]);
      if (group.length > 1) wrap(group);
      i = j - 1;
    }
    // 2) Überschrift + nächster Block (oder nächste Aufgabe)
    kids = [...container.children];
    for (let i = 0; i < kids.length - 1; i++) {
      const el = kids[i];
      if (!el.classList.contains('blk') || !/^h[123]$/.test(el.dataset.type)) continue;
      const next = kids[i + 1];
      if (next.classList.contains('blk') && next.dataset.type === 'pagebreak') continue;
      wrap([el, next]);
      i++;
    }
  }
}

// Warten, bis Schriften, Bilder und Strukturformeln fertig sind
async function settle(root) {
  try { await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))]); } catch { /* egal */ }
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 8000); })));
  // SmilesDrawer zeichnet asynchron
  for (let i = 0; i < 40; i++) {
    const pending = [...root.querySelectorAll('.smiles-svg')].some(s => !s.childNodes.length);
    if (!pending) break;
    await new Promise(r => setTimeout(r, 50));
  }
  // Kein requestAnimationFrame: In einem unsichtbaren Fenster feuert es nie
  await new Promise(r => setTimeout(r, 120));
}
