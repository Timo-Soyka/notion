// Welche Ansicht passt zu welcher Datei?
//
//   note    – Hefteintrag (Blockeditor)
//   pdf     – Arbeitsblatt (PDF-Editor)
//   image   – Bildeditor (Textfelder, Pfeile, Formen, Zuschneiden …)
//   text    – Text- und Code-Dateien
//   sheet   – Tabellen (CSV/TSV)
//   rich    – RTF-Dokumente
//   preview – alles andere über Quick Look (Pages, Word, Excel, Audio, Video …)
//   link    – Lesezeichen
//
// „editable“ heißt: Heft kann Änderungen verlustfrei über DEVONthink
// zurückschreiben. Word- und OpenOffice-Dateien gehören nicht dazu –
// DEVONthink würde sie beim Speichern in reinen Text umwandeln.

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'heic', 'heif', 'bmp', 'webp', 'avif', 'jp2', 'j2k', 'psd', 'tga', 'ico', 'icns',
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'srw', 'pef', 'exr', 'pbm', 'pgm', 'ppm']);

// Dateiendung → Sprache für die Farbhervorhebung (highlight.js)
export const CODE_LANG = {
  txt: 'plaintext', text: 'plaintext', log: 'plaintext', md: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', plist: 'xml',
  swift: 'swift', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', m: 'objectivec',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r', sql: 'sql', sh: 'bash', zsh: 'bash', bash: 'bash',
  command: 'bash', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', diff: 'diff', patch: 'diff',
  graphql: 'graphql', vb: 'vbnet', makefile: 'makefile', mk: 'makefile',
  tex: 'plaintext', sty: 'plaintext', bib: 'plaintext', typ: 'plaintext', csv: 'plaintext', tsv: 'plaintext', srt: 'plaintext', vtt: 'plaintext',
  applescript: 'plaintext', ris: 'plaintext', rtx: 'plaintext'
};

const OFFICE = {
  doc: 'Word-Dokument', docx: 'Word-Dokument', odt: 'OpenOffice-Dokument', pages: 'Pages-Dokument', wpd: 'WordPerfect-Dokument',
  xls: 'Excel-Tabelle', xlsx: 'Excel-Tabelle', ods: 'OpenOffice-Tabelle', numbers: 'Numbers-Tabelle',
  ppt: 'PowerPoint-Präsentation', pptx: 'PowerPoint-Präsentation', odp: 'OpenOffice-Präsentation', key: 'Keynote-Präsentation'
};
// In eine bearbeitbare RTF-Kopie umwandelbar (liest macOS selbst)
const TO_RTF = new Set(['doc', 'docx', 'odt', 'rtfd', 'wordml', 'html', 'htm', 'webarchive']);

const AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'caf']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'mpg', 'mpeg', '3gp']);

const LANG_NAME = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', css: 'CSS', scss: 'SCSS', xml: 'XML', swift: 'Swift',
  java: 'Java', kotlin: 'Kotlin', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP', sql: 'SQL', bash: 'Shell',
  yaml: 'YAML', markdown: 'Markdown', r: 'R', lua: 'Lua', perl: 'Perl', objectivec: 'Objective-C'
};

const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

// node: { kind, type (DEVONthink-Typ), ext, name }
export function classify(node) {
  const kind = node.kind || '';
  const type = node.type || '';
  const ext = (node.ext || extOf(node.filename || node.name)).toLowerCase();
  const E = ext.toUpperCase();
  if (kind === 'note' || kind === 'bundle' || type === 'markdown') return { view: 'note', editable: true, label: 'Eintrag', ext };
  if (kind === 'pdf' || type === 'PDF document' || ext === 'pdf') return { view: 'pdf', editable: true, label: 'PDF', ext };
  if (kind === 'group') return { view: 'group', editable: false, label: 'Ordner', ext };
  if (type === 'bookmark') return { view: 'link', editable: false, label: 'Lesezeichen', ext };
  if (ext === 'svg') return { view: 'preview', alt: 'text', lang: 'xml', editable: false, label: 'Vektorgrafik (SVG)', ext };
  if (type === 'picture' || IMAGE_EXT.has(ext)) {
    const label = ext === 'jpg' || ext === 'jpeg' ? 'Foto (JPEG)' : `Bild (${E === 'TIF' ? 'TIFF' : E || 'Bild'})`;
    return { view: 'image', editable: true, label, ext };
  }
  if (type === 'sheet' || ext === 'csv' || ext === 'tsv') return { view: 'sheet', editable: type === 'sheet', label: `Tabelle (${E || 'CSV'})`, ext };
  if (ext === 'rtf' && (type === 'RTF' || !type)) return { view: 'rich', editable: true, label: 'Textdokument (RTF)', ext };
  if (ext === 'rtfd' || type === 'RTFD') return { view: 'rich', editable: false, toRtf: true, label: 'Textdokument mit Bildern (RTFD)', ext };
  if (OFFICE[ext]) return { view: 'preview', editable: false, office: true, toRtf: TO_RTF.has(ext), label: OFFICE[ext], ext };
  if (type === 'HTML' || type === 'formatted note' || ext === 'html' || ext === 'htm') {
    return { view: 'preview', alt: 'text', lang: 'xml', editable: false, toRtf: true, label: type === 'formatted note' ? 'Formatierte Notiz' : 'Webseite (HTML)', ext };
  }
  if (type === 'webarchive' || ext === 'webarchive') return { view: 'preview', editable: false, toRtf: true, label: 'Webarchiv', ext };
  if (type === 'txt') {
    const lang = CODE_LANG[ext] || 'plaintext';
    return { view: 'text', lang, editable: true, label: LANG_NAME[lang] ? `${LANG_NAME[lang]}-Code` : 'Textdatei', ext };
  }
  if (CODE_LANG[ext]) {
    const lang = CODE_LANG[ext];
    const label = ext === 'typ' ? 'Typst-Dokument' : ext === 'tex' ? 'LaTeX-Dokument' : LANG_NAME[lang] ? `${LANG_NAME[lang]}-Datei` : `${E}-Datei`;
    return { view: 'text', lang, editable: false, label, ext };
  }
  if (AUDIO.has(ext) || (type === 'multimedia' && !VIDEO.has(ext))) return { view: 'preview', editable: false, label: 'Audio', media: true, ext };
  if (VIDEO.has(ext) || type === 'multimedia') return { view: 'preview', editable: false, label: 'Video', media: true, ext };
  if (type === 'email' || ext === 'eml' || ext === 'emlx') return { view: 'preview', editable: false, label: 'E-Mail', ext };
  return { view: 'preview', editable: false, label: E ? `${E}-Datei` : 'Datei', ext };
}

// Symbol für Seitenleiste und Startseite
export function iconFor(node) {
  const c = classify(node);
  if (c.office) return 'fileText';
  return { note: 'note', pdf: 'pdf', image: 'image', text: 'fileText', sheet: 'table', rich: 'fileText', link: 'link', group: 'folder' }[c.view] || 'file';
}
