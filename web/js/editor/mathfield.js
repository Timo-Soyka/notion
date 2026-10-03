// Formelfeld zum Eintippen wie auf Papier (MathLive).
//
// Statt Quelltext tippt man z. B. "wurzel" und bekommt sofort eine Wurzel mit
// einem Kästchen für den Radikanden; Tab springt ins nächste Kästchen.
// "&" setzt einen farbigen Ausrichtungspunkt, eine Zahl direkt danach gibt ihm
// eine ID (gleiche ID = gleiche Farbe = steht später untereinander).
// Rechtsklick auf einen Punkt ändert oder entfernt ihn.

import { markColor, markName, cleanFieldLatex } from '../core/mathlines.js';
import { menu, promptDialog } from '../ui/ui.js';
import { isPad } from '../bridge.js';

let loading = null;

// MathLive erst laden, wenn es gebraucht wird (die Datei ist groß)
export function loadMathLive() {
  if (!loading) {
    loading = import('../../vendor/mathlive/mathlive.min.mjs').then((ML) => {
      const MFE = ML.MathfieldElement;
      // Absolut angeben: Aus WebKits Fehlerstapel kann MathLive den eigenen Ort nicht ablesen
      MFE.fontsDirectory = new URL('../../vendor/katex/fonts', import.meta.url).href;
      MFE.soundsDirectory = null;
      MFE.decimalSeparator = ',';
      return ML;
    });
  }
  return loading;
}

// Isotop: leerer Sockel mit Hoch- und Tiefzahl, davor steht nichts.
// MathLive springt hier zuerst nach unten – deshalb eigene Behandlung (siehe unten)
const ISOTOPE = '{}^{#?}_{#?}';
export const ISOTOPE_TEX = ISOTOPE;

// Deutsche Kürzel: [Namen, LaTeX mit #? für die Kästchen, Beschreibung, Beispiel für die Liste]
export const GERMAN_SHORTCUTS = [
  [['wurzel'], '\\sqrt{#?}', 'Wurzel'],
  [['nwurzel', 'ntewurzel'], '\\sqrt[#?]{#?}', 'n-te Wurzel'],
  [['bruch'], '\\frac{#?}{#?}', 'Bruch (auch mit /)'],
  [['hoch'], '^{#?}', 'Hochzahl (auch mit ^)'],
  [['index'], '_{#?}', 'Index (auch mit _)'],
  [['betrag'], '\\left|#?\\right|', 'Betrag'],
  [['intervall'], '\\left[#?;#?\\right]', 'Geschlossenes Intervall [a; b]'],
  [['offen'], '\\left]#?;#?\\right[', 'Offenes Intervall ]a; b[ – halboffen einfach tippen: [0; 3['],
  [['int', 'integral'], '\\int_{#?}^{#?}#?\\,\\mathrm{d}x', 'Integral mit Grenzen: unten, Tab, oben, Tab, Term'],
  [['unbestimmt'], '\\int #?\\,\\mathrm{d}x', 'Unbestimmtes Integral (ohne Grenzen)'],
  [['stammfunktion', 'auswerten'], '\\left[#?\\right]_{#?}^{#?}', 'Stammfunktion in Grenzen einsetzen: Term, Tab, unten, Tab, oben', '\\left[F(x)\\right]_{a}^{b}'],
  [['ableitung'], '\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(#?\\right)', "Ableitung nach x (sonst einfach f'(x) tippen)"],
  [['sum', 'summe'], '\\sum_{#?}^{#?}', 'Summe'],
  [['prod', 'produkt'], '\\prod_{#?}^{#?}', 'Produkt'],
  [['lim', 'limes', 'grenzwert'], '\\lim_{#?\\to#?}', 'Grenzwert'],
  [['vektor'], '\\vec{#?}', 'Vektorpfeil'],
  [['spaltenvektor'], '\\begin{pmatrix}#?\\\\#?\\\\#?\\end{pmatrix}', 'Spaltenvektor (3 Einträge)'],
  [['zweiervektor'], '\\begin{pmatrix}#?\\\\#?\\end{pmatrix}', 'Spaltenvektor (2 Einträge)'],
  [['matrix'], '\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}', 'Matrix 2 × 2'],
  [['fallunterscheidung', 'faelle'], '\\begin{cases}#?&#?\\\\#?&#?\\end{cases}', 'Fallunterscheidung'],
  [['quer', 'periode'], '\\overline{#?}', 'Querstrich / Periode'],
  [['binom'], '\\binom{#?}{#?}', 'Binomialkoeffizient'],
  [['stapel', 'uebereinander', 'übereinander'], '{#?\\atop#?}', 'Zwei Zeilen übereinander – wie ein Bruch ohne Bruchstrich', '{a\\atop b}'],
  [['isotop', 'nuklid'], ISOTOPE, 'Isotop, z. B. ¹⁴₆C: Massenzahl, Tab, Ordnungszahl, Tab, Element', '{}^{14}_{6}C'],
  [['grad'], '^{\\circ}', 'Grad °'],
  [['unendlich'], '\\infty', '∞'],
  [['ungefaehr', 'ungefähr'], '\\approx', '≈'],
  [['ungleich'], '\\neq', '≠'],
  [['kleinergleich'], '\\le', '≤'],
  [['groessergleich', 'größergleich'], '\\ge', '≥'],
  [['plusminus'], '\\pm', '±'],
  [['folgt'], '\\Rightarrow', '⇒'],
  [['aequivalent', 'äquivalent'], '\\Leftrightarrow', '⇔'],
  [['pfeil'], '\\rightarrow', '→'],
  [['element'], '\\in', '∈'],
  [['nichtelement'], '\\notin', '∉'],
  [['teilmenge'], '\\subseteq', '⊆'],
  [['schnitt'], '\\cap', '∩'],
  [['vereinigt'], '\\cup', '∪'],
  [['leeremenge'], '\\emptyset', '∅'],
  [['winkel'], '\\angle', '∠'],
  [['dreieck'], '\\triangle', '△'],
  [['senkrecht'], '\\perp', '⊥'],
  [['parallel'], '\\parallel', '∥'],
  [['euro'], '\\text{€}', '€'],
  [['prozent'], '\\%', '%'],
  [['einheit'], '\\,\\text{#?}', 'Einheit, z. B. m, s, N (auch mit "…")'],
  [['kstrich', 'kommandostrich'], '\\heftbar', 'Kommandostrich für Umformungen (auch mit ||)'],
  [['wurzelzeichen'], '\\surd', 'Wurzelzeichen ohne Radikand (auch mit ~)']
];

// Einheiten direkt nach einer Zahl werden aufrecht gesetzt ("0,96dm" → 0,96 dm)
const UNITS = ['mm', 'cm', 'dm', 'km', 'ml', 'cl', 'dl', 'hl', 'mg', 'kg', 'kN', 'kJ', 'kW', 'kWh', 'mA', 'kV', 'Hz', 'kHz', 'Pa', 'hPa', 'kPa', 'mol', 'cm²', 'km²', 'm²', 'm³', 'cm³', 'dm³'];
const UNIT_END_RE = new RegExp(`\\\\text\\{(${UNITS.map(u => u.replace(/[²³]$/, '')).join('|')})\\}$`);

// Englische Standard-Kürzel, die beim Tippen deutscher Wörter stören würden
const DROP = ['ii', 'jj', 'ee', 'ch', 'sh', 'th', 'tg', 'of', 'or', 'and', 'not', 'sub', 'sup', 'mean', 'median', 'fft',
  'bessel', 'randomReal', 'randomInteger', 'lb', 'mi', 'ft', 'inch', 'xin', 'sint', 'lt', 'gt', 'prop', 'approaches',
  'union', 'asterisk', 'diamond', 'square', 'divide', 'infinity', '&&', '&', 'grad', 'del', 'nn', 'nnn', 'uu', 'uuu',
  'vv', 'vvv', 'TT', 'AA', 'EE', '!EE', 'in', 'Re', 'Im', 'mod', '(mod', 'erf', 'erfc', 'cth', 'ctg', 'cotg'];

function shortcuts(defaults) {
  const out = { ...defaults };
  for (const k of DROP) delete out[k];
  for (const [names, tex] of GERMAN_SHORTCUTS) {
    if (tex === ISOTOPE) continue;
    for (const n of names) {
      out[n] = tex;
      out[n.charAt(0).toUpperCase() + n.slice(1)] = tex;
    }
  }
  for (const u of UNITS) {
    const base = u.replace(/[²³]$/, '');
    const pow = u.endsWith('²') ? '^2' : u.endsWith('³') ? '^3' : '';
    out[u] = { after: 'digit+closefence', value: `\\,\\text{${base}}${pow}` };
  }
  // Hochgestellte Ziffern, falls sie so ankommen
  out['²'] = '^2';
  out['³'] = '^3';
  // Kommandostrich für Äquivalenzumformungen und Wurzel ohne Radikand
  out['||'] = '\\heftbar';
  out['~'] = '\\surd';
  return out;
}

// "integral" tippen: Schon nach "int" steht die Vorlage da, der Rest ("egral")
// landet im ersten Kästchen. Dann Rest entfernen bzw. die gemeinte Vorlage setzen.
const PH = '\\\\placeholder\\{\\}';
const either = (cmd, rest) => new RegExp(`\\\\${cmd}_\\{(?:${rest}|${PH})\\}\\^\\{(?:${rest}|${PH})\\}`);
const LEFTOVERS = [
  [either('int', 'egral'), '\\int_{\\placeholder{}}^{\\placeholder{}}', '\\int_{'],
  [new RegExp(`\\\\int_\\{(?:ervall|${PH})\\}\\^\\{(?:ervall|${PH})\\}${PH}\\\\,\\\\mathrm\\{d\\}x`), '\\left[\\placeholder{};\\placeholder{}\\right]', '\\left['],
  [/\\lim_\{(?:es|\\placeholder\{\})\\to(?:es|\\placeholder\{\})\}/, '\\lim_{\\placeholder{}\\to\\placeholder{}}', '\\lim_{'],
  [either('sum', 'me'), '\\sum_{\\placeholder{}}^{\\placeholder{}}', '\\sum_{'],
  [either('prod', 'ukt'), '\\prod_{\\placeholder{}}^{\\placeholder{}}', '\\prod_{'],
  [/\\sqrt\{zeichen\}/, '\\surd', null]
];

// Offsets aller Kästchen in Dokumentreihenfolge
function placeholders(mf) {
  const out = [];
  for (let p = 1; p <= mf.lastOffset; p++) if (mf.getValue(p - 1, p) === '\\placeholder{}') out.push(p);
  return out;
}
const selectPlaceholder = (mf, p) => { mf.selection = { ranges: [[p - 1, p]] }; };

function fixLeftovers(mf) {
  const v = mf.getValue('latex');
  for (const [re, by, head] of LEFTOVERS) {
    const m = re.exec(v);
    if (!m || !/egral|ervall|es|me|ukt|zeichen/.test(m[0])) continue;
    const next = v.slice(0, m.index) + by + v.slice(m.index + m[0].length);
    mf.value = next;
    if (!head) { mf.position = mf.lastOffset; return true; }
    // In das erste Kästchen der Vorlage (Kästchen davor mitzählen)
    const before = (next.slice(0, m.index).match(/\\placeholder/g) || []).length;
    const ph = placeholders(mf);
    if (ph[before]) selectPlaceholder(mf, ph[before]);
    return true;
  }
  return false;
}

// Bei ∫, Σ, Π führt MathLive die obere Grenze vor der unteren und wählt sie
// nach dem Einfügen zuerst aus. Wir beginnen unten; zurückgegeben wird die
// Stelle der oberen Grenze, zu der Tab danach springt.
function preferLowerBound(mf) {
  const v = mf.getValue('latex');
  const re = /\\(int|sum|prod)_\{\\placeholder\{\}\}\^\{\\placeholder\{\}\}/g;
  let m;
  while ((m = re.exec(v))) {
    const k = (v.slice(0, m.index).match(/\\placeholder/g) || []).length;
    const ph = placeholders(mf);
    const [a, b] = mf.selection.ranges[0];
    if (ph[k + 1] && a === ph[k] - 1 && b === ph[k]) { selectPlaceholder(mf, ph[k + 1]); return ph[k]; }
  }
  return null;
}

const MARK_DEF = '\\mathord{\\mkern1mu\\textcolor{hm#1}{\\rule[-0.3em]{0.14em}{1.2em}}\\mkern1mu}';
// Kommandostrich: Abstand, senkrechter Strich, kleiner Abstand
const BAR_DEF = '\\mathord{\\qquad\\textcolor{hmbar}{\\vert}\\;}';

// Ein Formelfeld anlegen. opts: value, inline, shortcuts (zusätzliche Kürzel), onInput(latex), onKey(e) → true wenn erledigt,
// onMoveOut(direction), extraMenu() → zusätzliche Kontextmenü-Einträge
export async function createField(opts = {}) {
  const ML = await loadMathLive();
  const mf = new ML.MathfieldElement();
  mf.classList.add('heft-mf');
  if (opts.inline) mf.classList.add('inline');
  // Die meisten Einstellungen nimmt MathLive erst an, wenn das Feld auf der Seite ist
  mf.addEventListener('mount', () => {
    mf.mathVirtualKeyboardPolicy = 'manual';
    mf.menuItems = [];
    mf.smartFence = true;
    mf.removeExtraneousParentheses = true;
    mf.macros = {
      ...mf.macros,
      heftmark: { args: 1, def: MARK_DEF, captureSelection: true, expand: false },
      heftbar: { args: 0, def: BAR_DEF, captureSelection: true, expand: false }
    };
    mf.colorMap = (name) => {
      if (name === 'hmbar') return '#8a8a8a';
      const m = /^hm(\d+)$/.exec(name);
      return m ? markColor(parseInt(m[1], 10)) : undefined;
    };
    mf.inlineShortcuts = { ...shortcuts(mf.inlineShortcuts), ...(opts.shortcuts || {}) };
    mf.value = opts.value || '';
    // iPad: normale Bildschirmtastatur statt keiner (MathLive schaltet sie ab)
    const sink = isPad && mf.shadowRoot && mf.shadowRoot.querySelector('.ML__keyboard-sink');
    if (sink) sink.setAttribute('inputmode', 'text');
    opts.onMount && opts.onMount(mf);
  }, { once: true });

  // Handschrift mit dem Apple Pencil (Scribble) kommt als ganzes Wort an statt
  // Taste für Taste – dann greifen die Kürzel nicht ("wurzel" bliebe Text).
  // Deshalb Zeichen für Zeichen eingeben und Kürzel selbst auflösen.
  if (isPad) {
    let written = null;
    let buffer = null;
    const sinkEl = () => mf.shadowRoot && mf.shadowRoot.querySelector('.ML__keyboard-sink');
    // Gesammelte Handschrift in die Formel übernehmen
    const flush = () => {
      if (!buffer) return;
      clearTimeout(buffer.timer);
      document.removeEventListener('pointerdown', flush, true);
      buffer = null;
      mf.classList.remove('writing');
      const sink = sinkEl();
      const raw = sink ? sink.textContent : '';
      if (sink) sink.textContent = '';
      if (!raw.trim()) return;
      const after = written && written.end === mf.position && written.nested;
      const nested = insertWritten(mf, raw, after);
      written = { end: mf.position, nested };
      emit();
    };
    // Solange gesammelt wird, sieht MathLive die Eingaben nicht – Scribble darf
    // sein Wort in Ruhe korrigieren (sonst würde daraus z. B. eine Rücktaste)
    const hold = (e) => {
      e.stopImmediatePropagation();
      clearTimeout(buffer.timer);
      buffer.timer = setTimeout(flush, 1100);
    };
    mf.addEventListener('beforeinput', (e) => {
      // Nur echte Eingaben – MathLive meldet eigene Änderungen ebenfalls als beforeinput
      if (!e.isTrusted) return;
      if (buffer) { hold(e); return; }
      if (!['insertText', 'insertReplacementText'].includes(e.inputType) || !e.data || e.data.length < 2) return;
      // Ganzes Wort auf einmal: Handschrift (Scribble) oder ein Wortvorschlag
      buffer = { timer: 0 };
      mf.classList.add('writing');
      document.addEventListener('pointerdown', flush, true);
      hold(e);
    }, true);
    mf.addEventListener('input', (e) => { if (buffer && e.isTrusted) hold(e); }, true);
    // Taste gedrückt oder Feld verlassen: vorher übernehmen
    mf.addEventListener('keydown', flush, true);
    mf.addEventListener('blur', flush);
  }

  // Wurde gerade ein Punkt gesetzt? Dann sind folgende Ziffern seine ID.
  let fresh = null;
  // Text-Modus bewusst mit " begonnen (dann nicht automatisch verlassen)
  let quoteMode = false;
  // Gerade eingefügtes Isotop: Tab springt Massenzahl → Ordnungszahl → Element
  let iso = null;
  // Gerade eingefügtes Integral (Summe, Produkt): Tab springt von unten nach oben
  let upper = null;
  let leftoverTimer = null;
  // Stand beim letzten Tastendruck – daran sieht man, ob gerade eine ∫-Vorlage dazukam
  let lastLatex = '';
  const BOUNDS = /\\(?:int|sum|prod)_\{\\placeholder\{\}\}\^\{\\placeholder\{\}\}/g;
  const countBounds = (v) => (v.match(BOUNDS) || []).length;
  const emit = () => opts.onInput && opts.onInput(value(mf));

  mf.addEventListener('keydown', (e) => {
    if (opts.onKey && opts.onKey(e, mf)) { e.preventDefault(); e.stopImmediatePropagation(); fresh = null; return; }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    // Neue ∫-Vorlage seit dem letzten Tastendruck: zuerst die untere Grenze
    const now = mf.getValue('latex');
    if (countBounds(now) > countBounds(lastLatex)) { const up = preferLowerBound(mf); if (up) upper = up; }
    lastLatex = now;
    if (e.key === 'Tab' && iso && plain && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      isotopeTab(mf);
      emit();
      return;
    }
    if (iso && ['Escape', 'Enter', 'ArrowUp', 'ArrowDown'].includes(e.key)) endIsotope();
    if (e.key === 'Tab' && upper && plain && !e.shiftKey) {
      const at = upper;
      upper = null;
      if (mf.getValue(at - 1, at) === '\\placeholder{}') {
        e.preventDefault();
        e.stopImmediatePropagation();
        selectPlaceholder(mf, at);
        return;
      }
    }
    if (['Escape', 'Enter'].includes(e.key)) upper = null;
    // Tab: ins nächste Kästchen, sonst aus Wurzel, Bruch, Hochzahl … hinaus.
    // (MathLive markiert sonst manchmal die ganze Struktur, und das nächste
    // Zeichen ersetzt sie.) Ganz außen darf Tab das Feld verlassen.
    if (e.key === 'Tab' && plain && !e.shiftKey) {
      const ahead = mf.getValue(mf.position, mf.lastOffset);
      const p0 = mf.position;
      if (/\\placeholder/.test(ahead)) mf.executeCommand('moveToNextPlaceholder');
      else mf.executeCommand('moveAfterParent');
      if (mf.position !== p0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        mf.selection = { ranges: [[mf.position, mf.position]] };
        return;
      }
    }
    // Deutsche Tastatur: "^" ist eine Tottaste (wartet aufs nächste Zeichen) –
    // hier soll sie sofort in die Hochzahl springen.
    if (plain && !e.shiftKey && e.key === 'Dead' && /^(IntlBackslash|Backquote)$/.test(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      mf.executeCommand('moveToSuperscript');
      return;
    }
    // ~ = Wurzelzeichen ohne Radikand (z. B. für "| √" beim Umformen)
    if (plain && e.key === '~' && mf.mode !== 'text') {
      e.preventDefault();
      e.stopImmediatePropagation();
      mf.insert('\\surd', { selectionMode: 'after' });
      emit();
      return;
    }
    // " schaltet wie in Typst auf Text/Einheit um: 0,96"dm" → 0,96 dm
    if (plain && e.key === '"') {
      e.preventDefault();
      e.stopImmediatePropagation();
      quoteMode = mf.mode !== 'text';
      mf.executeCommand(['switchMode', quoteMode ? 'text' : 'math']);
      return;
    }
    if (e.key === '&' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (opts.inline) return;
      mf.insert('\\heftmark{1}', { selectionMode: 'after' });
      fresh = { pos: mf.position, digits: 0, id: 1 };
      emit();
      return;
    }
    if (/^\d$/.test(e.key) && fresh && fresh.pos === mf.position && fresh.digits < 2 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const id = fresh.digits === 0 ? parseInt(e.key, 10) : fresh.id * 10 + parseInt(e.key, 10);
      if (id < 1) return;
      setMarkBeforeCaret(mf, id);
      fresh = { pos: mf.position, digits: fresh.digits + 1, id };
      emit();
      return;
    }
    if (!['Shift', 'Alt', 'Meta', 'Control'].includes(e.key)) fresh = null;
  }, true);

  // Derselbe Ablauf, wenn "&" oder die Ziffer nicht als Taste, sondern als
  // Texteingabe ankommen (Einsetzen, Diktat, andere Tastaturbelegungen)
  let busy = false;
  mf.addEventListener('input', () => {
    if (busy) return;
    busy = true;
    try {
      let pos = mf.position;
      let pre = mf.getValue(0, pos);
      let m;
      // Nach einer automatisch erkannten Einheit ("0,96dm") im Formel-Modus weiterschreiben
      if (mf.mode === 'text' && !quoteMode && UNIT_END_RE.test(pre)) {
        mf.executeCommand(['switchMode', 'math']);
        pos = mf.position;
        pre = mf.getValue(0, pos);
      }
      if (mf.mode !== 'text') quoteMode = false;
      const up = preferLowerBound(mf);
      if (up) { upper = up; pos = mf.position; pre = mf.getValue(0, pos); }
      // Reste langer Kürzel erst aufräumen, wenn MathLive mit der Taste fertig ist
      clearTimeout(leftoverTimer);
      leftoverTimer = setTimeout(() => {
        if (!fixLeftovers(mf)) return;
        const u = preferLowerBound(mf);
        if (u) upper = u;
        emit();
      }, 0);
      // „isotop“ bzw. „nuklid“ getippt → Nuklid-Vorlage, Einfügemarke in der Massenzahl
      if (mf.mode === 'math' && (m = /(?:^|[^a-zA-Z\\])([iI]sotop|[nN]uklid)$/.exec(pre))) {
        for (let k = 0; k < 6; k++) mf.executeCommand('deleteBackward');
        insertIsotope(mf);
        pos = mf.position;
        pre = mf.getValue(0, pos);
      }
      if (/\\sim(?![a-zA-Z])/.test(mf.getValue('latex')) && mf.mode !== 'text') {
        const fromEnd = mf.lastOffset - pos;
        for (let p = mf.lastOffset; p >= 1; p--) {
          if (mf.getValue(p - 1, p) !== '\\sim') continue;
          mf.selection = { ranges: [[p - 1, p]] };
          mf.insert('\\surd', { insertionMode: 'replaceSelection', selectionMode: 'after', silenceNotifications: true });
        }
        mf.position = Math.max(0, mf.lastOffset - fromEnd);
      }
      if (!opts.inline && mf.getValue('latex').includes('\\&')) {
        // jedes eingetippte "&" (in LaTeX "\&") wird ein Ausrichtungspunkt
        const fromEnd = mf.lastOffset - pos;
        let atCaret = false;
        for (let p = mf.lastOffset; p >= 1; p--) {
          if (mf.getValue(p - 1, p) !== '\\&') continue;
          if (mf.lastOffset - p === fromEnd) atCaret = true;
          mf.selection = { ranges: [[p - 1, p]] };
          mf.insert('\\heftmark{1}', { insertionMode: 'replaceSelection', selectionMode: 'after', silenceNotifications: true });
        }
        mf.position = Math.max(0, mf.lastOffset - fromEnd);
        fresh = atCaret ? { pos: mf.position, digits: 0, id: 1 } : null;
      } else if (fresh && pos === fresh.pos + 1 && fresh.digits < 2 && (m = /\\heftmark\{\d+\}(\d)$/.exec(pre))) {
        const id = fresh.digits === 0 ? parseInt(m[1], 10) : fresh.id * 10 + parseInt(m[1], 10);
        mf.executeCommand('deleteBackward');
        if (id > 0) {
          setMarkBeforeCaret(mf, id);
          fresh = { pos: mf.position, digits: fresh.digits + 1, id };
        }
      } else if (fresh && pos !== fresh.pos) fresh = null;
    } finally { busy = false; }
    emit();
  });
  // Nuklid-Vorlage einfügen: MathLive wählt zuerst die Tiefzahl – wir starten oben
  function insertIsotope(target) {
    target.insert(ISOTOPE, { selectionMode: 'placeholder', silenceNotifications: true });
    const holes = [];
    const start = Math.max(1, target.position - 2);
    for (let p = start; p <= Math.min(target.lastOffset, start + 4); p++) if (target.getValue(p - 1, p) === '\\placeholder{}') holes.push(p);
    if (holes.length < 2) return;
    target.selection = { ranges: [[holes[1] - 1, holes[1]]] };
    // Sonst springt MathLive nach der ersten Ziffer aus der Hochzahl (praktisch bei x², hier nicht)
    target.smartSuperscript = false;
    iso = { sub: holes[0], step: 'mass' };
  }

  function endIsotope() {
    iso = null;
    mf.smartSuperscript = true;
  }

  function isotopeTab(target) {
    if (iso.step === 'mass' && target.getValue(iso.sub - 1, iso.sub) === '\\placeholder{}') {
      target.selection = { ranges: [[iso.sub - 1, iso.sub]] };
      target.smartSuperscript = true;
      iso.step = 'number';
      return;
    }
    // Hinter das Nuklid – das Elementsymbol setzt die Anzeige später aufrecht
    target.executeCommand('moveAfterParent');
    endIsotope();
  }
  mf.addEventListener('blur', () => { if (iso) endIsotope(); upper = null; });
  mf.insertIsotope = () => { insertIsotope(mf); emit(); };

  mf.addEventListener('move-out', (e) => {
    if (opts.onMoveOut) { e.preventDefault(); opts.onMoveOut(e.detail && e.detail.direction, mf); }
  });

  mf.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    openContextMenu(mf, e, opts, emit);
  }, true);
  return mf;
}

// Geschriebenen Text eingeben: Kürzel (längstes zuerst) als Vorlage einsetzen,
// alles andere wie getippt – so wird "/" zum Bruch und "^" zur Hochzahl.
// Ein Leerzeichen nach einer so entstandenen Wurzel, einem Bruch oder einer
// Hochzahl springt heraus (wie Tab). `inside`: Die Einfügemarke steht noch in
// einer Vorlage aus der letzten Handschrift.
// Ergebnis: ob die Einfügemarke am Ende in einer solchen Vorlage steht
function insertWritten(mf, text, inside = false) {
  const map = mf.inlineShortcuts || {};
  const keys = Object.keys(map).filter(k => k.length > 1).sort((a, b) => b.length - a.length);
  const allowed = (v, prev) => {
    if (!v || typeof v !== 'object' || !v.after) return true;
    return v.after.split('+').some(c => (c === 'digit' && /\d/.test(prev)) || (c === 'closefence' && /[)\]}]/.test(prev)) || (c === 'letter' && /\p{L}/u.test(prev)));
  };
  let prev = '';
  let nested = inside;
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) {
      if (nested) { mf.executeCommand('moveAfterParent'); nested = false; }
      i += 1;
      continue;
    }
    const k = keys.find(key => text.startsWith(key, i) && allowed(map[key], prev));
    if (k) {
      const v = map[k];
      const tex = typeof v === 'string' ? v : v.value;
      mf.insert(tex, { format: 'latex', selectionMode: tex.includes('#?') ? 'placeholder' : 'after' });
      if (tex.includes('#?')) nested = true;
      prev = k[k.length - 1];
      i += k.length;
      continue;
    }
    const ch = text[i];
    mf.executeCommand(['typedText', ch, { simulateKeystroke: true }]);
    if ('^_/'.includes(ch)) nested = true;
    prev = ch;
    i += 1;
  }
  return nested;
}

// Text aus dem Schreibfeld in ein Formelfeld übernehmen (√ und Kürzel aufgelöst)
export function writeInto(mf, text) {
  const t = text.replace(/√/g, 'wurzel').replace(/[→⇒]/g, '\\Rightarrow ');
  insertWritten(mf, t, false);
  mf.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

export function value(mf) {
  return cleanFieldLatex(mf.getValue('latex'));
}

// Ausrichtungspunkt direkt vor der Einfügemarke?
function markBeforeOffset(mf, pos) {
  const m = /\\heftmark\{(\d+)\}$/.exec(mf.getValue(0, pos));
  return m ? parseInt(m[1], 10) : null;
}

function setMarkBeforeCaret(mf, id) {
  mf.executeCommand('deleteBackward');
  if (id) mf.insert(`\\heftmark{${id}}`, { selectionMode: 'after', silenceNotifications: true });
}

// Offset hinter dem Punkt, auf den geklickt wurde (oder null)
function markAtPoint(mf, e) {
  let o;
  try { o = mf.getOffsetFromPoint(e.clientX, e.clientY, { bias: 0 }); } catch { return null; }
  if (typeof o !== 'number') return null;
  const onRule = e.composedPath().some(el => el.classList && /ML__rule/.test(el.className));
  const range = onRule ? [0, 1, -1, 2, 3, -2, 4] : [0, 1];
  for (const d of range) {
    const p = o + d;
    if (p < 1 || p > mf.lastOffset) continue;
    const id = markBeforeOffset(mf, p);
    // nur als Punkt werten, wenn ein Schritt weiter links kein Punkt mehr endet
    if (id && markBeforeOffset(mf, p - 1) !== id) return { pos: p, id };
  }
  return null;
}

function swatch(color) {
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color};margin-right:2px"></span>`;
}

function openContextMenu(mf, e, opts, emit) {
  const at = new DOMRect(e.clientX, e.clientY, 0, 0);
  const hit = opts.inline ? null : markAtPoint(mf, e);
  const items = [];
  if (hit) {
    const setId = (id) => {
      mf.position = hit.pos;
      setMarkBeforeCaret(mf, id);
      emit();
      mf.focus();
    };
    items.push({ section: `Ausrichtungspunkt ${hit.id}` });
    for (let id = 1; id <= 6; id++) {
      items.push({ label: `ID ${id} – ${markName(id)}`, html: swatch(markColor(id)), checked: id === hit.id, onSelect: () => setId(id) });
    }
    items.push({ label: 'Andere ID …', icon: 'hash', onSelect: async () => {
      const v = await promptDialog('ID des Ausrichtungspunkts', String(hit.id), { placeholder: 'z. B. 7', description: 'Punkte mit derselben ID stehen untereinander.' });
      const n = parseInt(v, 10);
      if (n > 0 && n < 100) setId(n);
    } });
    items.push('-');
    items.push({ label: 'Punkt entfernen', icon: 'trash', danger: true, onSelect: () => setId(0) });
  } else if (!opts.inline) {
    let o = null;
    try { o = mf.getOffsetFromPoint(e.clientX, e.clientY); } catch { /* egal */ }
    items.push({ label: 'Ausrichtungspunkt hier einfügen', icon: 'plus', hint: '&', onSelect: () => {
      if (typeof o === 'number') mf.position = o;
      mf.insert('\\heftmark{1}', { selectionMode: 'after' });
      emit();
      mf.focus();
    } });
    items.push({ label: 'Kommandostrich einfügen', icon: 'divider', hint: '||', onSelect: () => {
      mf.position = mf.lastOffset;
      mf.insert('\\heftbar', { selectionMode: 'after' });
      emit();
      mf.focus();
    } });
  }
  const extra = opts.extraMenu ? opts.extraMenu(mf) : [];
  if (extra.length) { if (items.length) items.push('-'); items.push(...extra); }
  if (items.length) menu(at, items);
}
