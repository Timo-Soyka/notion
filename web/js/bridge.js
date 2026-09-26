// Verbindung zur Mac-App.
//
// In der App läuft die Oberfläche in einem WKWebView; Befehle gehen per
// postMessage an Swift und kommen als Promise zurück. Im normalen Browser
// (zum Entwickeln und Testen) springt stattdessen ein Nachbau ein, der eine
// kleine Beispiel-Datenbank im localStorage hält.

const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.heft;
export const isNative = !!handler;

const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

export function emit(name, payload) {
  const set = listeners.get(name);
  if (set) for (const fn of [...set]) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

// Swift ruft window.HeftNative.emit(name, payload) auf.
window.HeftNative = { emit };

export async function call(cmd, args = {}) {
  if (isNative) {
    const res = await handler.postMessage({ cmd, args });
    return res;
  }
  const { mock } = await import('./mock.js');
  if (!mock[cmd]) throw new Error('Nicht verfügbar: ' + cmd);
  return mock[cmd](args);
}

// Bild-/PDF-Adressen aus dem Markdown (x-devonthink-item://UUID) in etwas
// verwandeln, das der WebView laden kann.
export function assetURL(src, opts = {}) {
  if (!src) return '';
  const m = /^x-devonthink-item:\/\/([^?#/]+)/i.exec(src);
  if (m) {
    const uuid = m[1];
    if (opts.page) {
      const w = opts.width || 1400;
      return isNative ? `heft://pdfpage/${uuid}/${opts.page}?w=${w}` : mockAsset(uuid, opts.page);
    }
    return isNative ? `heft://item/${uuid}` : mockAsset(uuid);
  }
  return src;
}

function mockAsset(uuid, page) {
  try {
    const store = JSON.parse(localStorage.getItem('heft-mock-assets') || '{}');
    if (store[uuid]) return store[uuid];
  } catch { /* egal */ }
  const label = page ? `Seite ${page}` : 'Bild';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${page ? 848 : 340}"><rect width="100%" height="100%" fill="#f1f1ef"/><text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#9b9a97">${label}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function itemLink(uuid) {
  return `x-devonthink-item://${uuid}`;
}

export function uuidFromLink(href) {
  const m = /^x-devonthink-item:\/\/([^?#/]+)/i.exec(href || '');
  return m ? m[1] : null;
}
