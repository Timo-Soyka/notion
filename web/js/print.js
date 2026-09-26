// Druckansicht: rendert einen Eintrag ohne Bedienelemente. Die Mac-App lädt
// diese Seite unsichtbar, wartet auf "print.ready" und druckt sie als PDF.
// Seitenzahlen und Kopfzeile zeichnet die Mac-App danach selbst auf die Seiten.

import { call, uuidFromLink, itemLink } from './bridge.js';
import { parseDocument } from './core/markdown.js';
import { Editor } from './editor/editor.js';
import { insertMarkers as insertLineMarkers, lineStarts } from './editor/linenumbers.js';
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
  // Verweise auf andere Einträge im PDF auf deren PDF-Fassung zeigen lassen,
  // Verweise auf Überschriften und das Inhaltsverzeichnis als Sprünge im PDF
  await linkToCompanions(ed.blocksEl);
  linkHeadings(ed);
  // Textblöcke teilbar machen (siehe unflexTextBlocks)
  unflexTextBlocks(ed.blocksEl);
  // Zeilennummern als Marken im Text – so stehen sie auch nach Seitenumbrüchen neben ihrer Zeile
  insertLineMarkers(ed.blocksEl, Number(doc.meta.lineNumbers) || 0);
  keepTogether(ed.blocksEl, pageHeight(pdf));
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

// Seitenumbrüche: Zusammengehöriges nicht auseinanderreißen – aber nur, wenn
// es kurz ist. Lange Absätze, Aufgaben, Kästen und Zitate laufen über die
// Seitengrenze weiter, statt komplett auf die nächste Seite zu springen und
// eine große Lücke zu hinterlassen.
//   • Aufgabennummer ("10a", "12a (1)") + Rechnung darunter
//   • Überschrift + das, was folgt – bei langem Text nur mit den ersten Zeilen
//   • Kästen, Zitate, Code, Aufgaben mit eingerücktem Inhalt
const TASK_LABEL = /^\s*(Aufgabe\s*|Nr\.?\s*)?\d+\s*[a-z]?\s*\)?\s*(\(\s*\d+\s*\))?\s*:?\s*$/i;
const SOLUTION_TYPES = new Set(['math', 'chem', 'plot', 'smiles', 'table', 'image', 'code']);
const BOXES = new Set(['callout', 'quote', 'code']);
const PAPER_HEIGHT = { A4: 841.89, A5: 595.28, Letter: 792 };

// Höhe des bedruckbaren Bereichs einer Seite in CSS-Pixeln (wie WebKit druckt: Punkte × 1,25)
export function pageHeight(pdf = {}) {
  const paper = PAPER_HEIGHT[pdf.paper] || PAPER_HEIGHT.A4;
  const cm = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : d) * 28.3465;
  return (paper - cm(pdf.top, 3) - cm(pdf.bottom, 3)) * 1.25;
}

function keepTogether(root, pageH) {
  if (!root) return;
  const LIMIT = pageH * 0.34;
  const height = (els) => els[els.length - 1].getBoundingClientRect().bottom - els[0].getBoundingClientRect().top;
  const wrap = (els) => {
    const box = document.createElement('div');
    box.className = 'keep-together';
    els[0].before(box);
    box.append(...els);
    return box;
  };
  const isBlk = (el, ...types) => el && el.classList.contains('blk') && (!types.length || types.includes(el.dataset.type));
  const hasKids = (el) => !!el.querySelector(':scope > .blk-children > .blk');

  // Kurze Kästen, Zitate, Code und Aufgaben mit eingerücktem Inhalt ganz lassen.
  // Eine lange Aufgabe darf umbrechen – ihre Nummer bleibt aber beim ersten Schritt.
  for (const blk of [...root.querySelectorAll('.blk')]) {
    const t = blk.dataset.type;
    if (!BOXES.has(t) && !(t === 'p' && hasKids(blk))) continue;
    if (blk.getBoundingClientRect().height <= LIMIT) { blk.classList.add('keep'); continue; }
    if (t === 'p') keepHeadWithFirstChild(blk, LIMIT);
  }

  for (const container of [root, ...root.querySelectorAll('.blk-children')]) {
    let kids = [...container.children];
    // 1) Aufgabennummer + folgende Formeln/Graphen
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (!isBlk(el, 'p') || hasKids(el)) continue;
      const text = (el.querySelector(':scope > .blk-main > .blk-text')?.textContent || '').replace(/\u200B/g, '');
      if (!TASK_LABEL.test(text)) continue;
      const group = [el];
      let j = i + 1;
      while (j < kids.length && isBlk(kids[j]) && SOLUTION_TYPES.has(kids[j].dataset.type)) group.push(kids[j++]);
      if (group.length > 1) {
        if (height(group) <= LIMIT) wrap(group);
        else if (height(group.slice(0, 2)) <= LIMIT) wrap(group.slice(0, 2));
      }
      i = j - 1;
    }
    // 2) Überschrift + nächster Block
    kids = [...container.children];
    for (let i = 0; i < kids.length - 1; i++) {
      const el = kids[i];
      if (!isBlk(el) || !/^h[123]$/.test(el.dataset.type)) continue;
      const next = kids[i + 1];
      if (isBlk(next, 'pagebreak')) continue;
      if (height([el, next]) <= LIMIT) { wrap([el, next]); i++; continue; }
      // Langer Absatz: Überschrift nur mit seinen ersten beiden Zeilen zusammenhalten
      if (isBlk(next, 'p') && !hasKids(next)) {
        const head = splitAfterLines(next, 2);
        if (head) { wrap([el, head]); i++; }
      }
    }
  }
}

// Im PDF führen Verweise auf Einträge zu deren PDF-Fassung, sofern es eine gibt
// (sonst zum Eintrag selbst) – beides öffnet DEVONthink, auch auf dem iPad.
async function linkToCompanions(root) {
  const links = [...root.querySelectorAll('a[href^="x-devonthink-item://"]')];
  const ids = [...new Set(links.map(a => uuidFromLink(a.getAttribute('href'))).filter(Boolean))];
  if (!ids.length) return;
  let map = {};
  try { map = await call('links.companions', { uuids: ids }) || {}; } catch { map = {}; }
  for (const a of links) {
    const pdf = map[uuidFromLink(a.getAttribute('href'))];
    if (pdf) a.setAttribute('href', itemLink(pdf));
  }
}

// Überschriften bekommen ihren Anker als id – WebKit macht daraus Sprungziele im PDF
function linkHeadings(ed) {
  const heads = ed.headings();
  const byId = new Map(heads.map(hd => [hd.id, hd]));
  const slugs = new Set(heads.map(hd => hd.slug));
  for (const hd of heads) { const el = ed.elOf({ id: hd.id }); if (el) el.id = hd.slug; }
  for (const a of ed.blocksEl.querySelectorAll('a[href^="#"]')) {
    const target = a.getAttribute('href').slice(1);
    if (slugs.has(target)) continue;
    const hd = byId.get(target);  // ältere Verweise mit Block-ID
    if (hd) a.setAttribute('href', '#' + hd.slug);
    else a.removeAttribute('href');  // Ziel gibt es nicht mehr – lieber kein toter Link
  }
  // Inhaltsverzeichnis: jede Zeile springt zu ihrer Überschrift
  const tocs = [...ed.blocksEl.querySelectorAll('.toc')];
  for (const toc of tocs) {
    [...toc.querySelectorAll('.toc-item')].forEach((a, i) => { if (heads[i]) a.setAttribute('href', '#' + heads[i].slug); });
  }
}

// WebKit teilt Flex-Container beim Drucken nicht auf: Ein Absatz, der auf eine
// Seite passt, würde komplett auf die nächste Seite geschoben. Deshalb die
// Zeile jedes Textblocks auf normales Blocklayout umstellen – Aufzählungszeichen,
// Kästchen und Symbole vorher vermessen und genau an ihrer Stelle festhalten.
function unflexTextBlocks(root) {
  const plans = [];
  for (const m of root.querySelectorAll('.blk-main')) {
    const text = m.querySelector(':scope > .blk-text');
    if (!text || getComputedStyle(m).display !== 'flex') continue;
    const base = m.getBoundingClientRect();
    const cs = getComputedStyle(m);
    const padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0;
    const tr = text.getBoundingClientRect();
    const others = [];
    for (const c of m.children) {
      if (c === text) continue;
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
      const r = c.getBoundingClientRect();
      others.push({ c, left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
    }
    plans.push({ m, text, marginLeft: tr.left - base.left - padL, marginTop: tr.top - base.top - padT, others });
  }
  // Erst alles messen, dann umstellen – sonst verschiebt jede Änderung die nächste Messung
  for (const p of plans) {
    p.m.style.display = 'block';
    for (const o of p.others) {
      Object.assign(o.c.style, { position: 'absolute', left: o.left + 'px', top: o.top + 'px', width: o.width + 'px', height: o.height + 'px', margin: '0' });
    }
    if (p.marginLeft > 0.5) p.text.style.marginLeft = p.marginLeft + 'px';
    if (p.marginTop > 0.5) p.text.style.marginTop = p.marginTop + 'px';
  }
}

// Absatz nach n Zeilen in zwei Teile teilen (nur für den Druck); liefert den ersten Teil
function splitAfterLines(blk, n) {
  const text = blk.querySelector(':scope > .blk-main > .blk-text');
  if (!text) return null;
  const starts = lineStarts(text);
  if (starts.length <= n + 1) return null;
  const at = starts[n];
  const range = document.createRange();
  if (at.before) range.setStartBefore(at.before); else range.setStart(at.node, at.offset);
  range.setEnd(text, text.childNodes.length);
  const rest = range.extractContents();
  const cont = blk.cloneNode(false);
  const main = blk.querySelector(':scope > .blk-main').cloneNode(false);
  const contText = text.cloneNode(false);
  contText.append(rest);
  main.append(contText);
  cont.append(main);
  cont.classList.add('cont');
  blk.classList.add('split-head');
  // Blocksatz: die letzte Zeile des ersten Teils bleibt ausgeglichen
  if (getComputedStyle(text).textAlign === 'justify') text.style.textAlignLast = 'justify';
  blk.after(cont);
  return blk;
}

// Lange Aufgabe: Nummer (erste Zeile) + erster eingerückter Schritt zusammen
function keepHeadWithFirstChild(blk, limit) {
  const main = blk.querySelector(':scope > .blk-main');
  const kids = blk.querySelector(':scope > .blk-children');
  const first = kids && kids.firstElementChild;
  if (!main || !first) return;
  if (first.getBoundingClientRect().bottom - main.getBoundingClientRect().top > limit) return;
  const box = document.createElement('div');
  box.className = 'keep-together';
  const inner = kids.cloneNode(false);
  main.before(box);
  inner.append(first);
  box.append(main, inner);
  inner.classList.add('split-kids');
  kids.classList.add('split-rest');
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
