// Bildbearbeitung: Ebene über dem Bild.
//
// Eine Ebene beschreibt, wie aus dem Originalbild das Ergebnis wird:
//   rot/flipX – Drehen (90°-Schritte) und Spiegeln des Bildes
//   crop      – Zuschnitt (oder null)
//   objects   – Textfelder, Pfeile, Linien, Formen, Stift, Textmarker,
//               Nummern und Abdeckungen
// Alle Koordinaten sind Bildpunkte im gedrehten Bild (vor dem Zuschnitt).
// Gezeichnet wird mit derselben Rechnung im Editor und beim Speichern; die
// Mac-App legt das Ergebnis dann über das Original und schreibt es im
// ursprünglichen Dateiformat zurück.

export const FONTS = {
  sans: { label: 'Standard', css: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif' },
  hand: { label: 'Handschrift', css: '"Noteworthy", "Bradley Hand", "Segoe Print", cursive' },
  chalk: { label: 'Kreide', css: '"Chalkboard SE", "Chalkboard", "Comic Sans MS", cursive' },
  serif: { label: 'Serifen', css: '"New York", "Iowan Old Style", Georgia, serif' },
  mono: { label: 'Schreibmaschine', css: '"SF Mono", Menlo, Consolas, monospace' }
};

export const LINE_HEIGHT = 1.25;

export function newLayer(w, h) {
  return { v: 1, w, h, rot: 0, flipX: false, crop: null, objects: [] };
}

// Größe des gedrehten Bildes
export function spaceSize(L) {
  return L.rot % 180 ? { w: L.h, h: L.w } : { w: L.w, h: L.h };
}

// Ausschnitt, der am Ende herauskommt
export function outRect(L) {
  const s = spaceSize(L);
  return L.crop ? { ...L.crop } : { x: 0, y: 0, w: s.w, h: s.h };
}

// Sinnvolle Größen für Schrift und Linien – abhängig von der Bildgröße,
// damit ein Textfeld auf einem Handyfoto genauso wirkt wie auf einem Scan
export function defaults(L) {
  const s = spaceSize(L);
  const m = Math.max(s.w, s.h);
  return { size: Math.max(12, Math.round(m / 38)), width: Math.max(2, Math.round(m / 300)) };
}

export const isEmptyLayer = (L) => !L || (!L.rot && !L.flipX && !L.crop && !(L.objects || []).length);

// ---------------------------------------------------------------------------
// Drehen und Spiegeln (Bild samt Objekten)
// ---------------------------------------------------------------------------

function mapObject(o, P, R) {
  switch (o.type) {
    case 'text': {
      const h = o.h || o.size * LINE_HEIGHT;
      const c = P([o.x + o.w / 2, o.y + h / 2]);
      o.x = c[0] - o.w / 2; o.y = c[1] - h / 2;
      break;
    }
    case 'rect': case 'ellipse': case 'cover': Object.assign(o, R(o.x, o.y, o.w, o.h)); break;
    case 'line': case 'arrow': {
      const a = P([o.x1, o.y1]), b = P([o.x2, o.y2]);
      o.x1 = a[0]; o.y1 = a[1]; o.x2 = b[0]; o.y2 = b[1];
      break;
    }
    case 'pen': case 'marker': o.points = o.points.map(P); break;
    case 'badge': { const c = P([o.x, o.y]); o.x = c[0]; o.y = c[1]; break; }
  }
}

function rectMapper(P) {
  return (x, y, w, h) => {
    const a = P([x, y]), b = P([x + w, y + h]);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  };
}

// dir = 1: im Uhrzeigersinn, -1: dagegen
export function rotateLayer(L, dir) {
  const { w: W, h: H } = spaceSize(L);
  const P = dir > 0 ? ([x, y]) => [H - y, x] : ([x, y]) => [y, W - x];
  const R = rectMapper(P);
  for (const o of L.objects) mapObject(o, P, R);
  if (L.crop) L.crop = R(L.crop.x, L.crop.y, L.crop.w, L.crop.h);
  L.rot = (L.rot + (dir > 0 ? 90 : 270)) % 360;
  return L;
}

// Waagerecht spiegeln – so, wie das Bild gerade zu sehen ist.
// Gespeichert wird „erst spiegeln, dann drehen“; bei 90°/270° entspricht ein
// sichtbares waagerechtes Spiegeln daher Spiegeln plus halber Drehung.
export function flipLayer(L) {
  const { w: W } = spaceSize(L);
  const P = ([x, y]) => [W - x, y];
  const R = rectMapper(P);
  for (const o of L.objects) mapObject(o, P, R);
  if (L.crop) L.crop = R(L.crop.x, L.crop.y, L.crop.w, L.crop.h);
  L.flipX = !L.flipX;
  if (L.rot % 180) L.rot = (L.rot + 180) % 360;
  return L;
}

// Punkt im Originalbild → Punkt im gedrehten Bild (für Tests und Vorschau)
export function basePoint(L, [x, y]) {
  if (L.flipX) x = L.w - x;
  switch (L.rot) {
    case 90: return [L.h - y, x];
    case 180: return [L.w - x, L.h - y];
    case 270: return [y, L.w - x];
    default: return [x, y];
  }
}

// Canvas so einrichten, dass das Originalbild (w × h) im gedrehten Raum landet
export function applyBaseTransform(ctx, L) {
  const { w: RW, h: RH } = spaceSize(L);
  switch (L.rot) {
    case 90: ctx.translate(RW, 0); ctx.rotate(Math.PI / 2); break;
    case 180: ctx.translate(RW, RH); ctx.rotate(Math.PI); break;
    case 270: ctx.translate(0, RH); ctx.rotate(-Math.PI / 2); break;
  }
  if (L.flipX) { ctx.translate(L.w, 0); ctx.scale(-1, 1); }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function fontCSS(o, scale = 1) {
  const f = (FONTS[o.font] || FONTS.sans).css;
  return `${o.italic ? 'italic ' : ''}${o.bold ? '700' : '400'} ${o.size * scale}px ${f}`;
}

export const textPad = (o) => (o.bg || o.border ? o.size * 0.35 : o.size * 0.12);

// Zeilen umbrechen. measure(text) liefert die Breite in Bildpunkten.
export function wrapLines(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    if (!para) { out.push(''); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (measure(next) <= maxWidth || !line.trim()) {
        // Einzelnes Wort, das nicht passt: Zeichen für Zeichen umbrechen
        if (measure(next) > maxWidth && !line.trim()) {
          let chunk = line;
          for (const ch of w) {
            if (measure(chunk + ch) > maxWidth && chunk) { out.push(chunk); chunk = ''; }
            chunk += ch;
          }
          line = chunk;
        } else line = next;
      } else {
        out.push(line.replace(/\s+$/, ''));
        line = w.replace(/^\s+/, '');
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

// Textfeld vermessen: Zeilen, Höhe und (bei automatischer Breite) Breite
export function layoutText(o, measure, maxRight) {
  const pad = textPad(o);
  const lh = o.size * LINE_HEIGHT;
  if (o.auto) {
    const lines = String(o.text || '').split('\n');
    const widest = Math.max(o.size * 1.5, ...lines.map(l => measure(l)));
    const limit = Math.max(o.size * 3, (maxRight ?? Infinity) - o.x);
    o.w = Math.min(Math.ceil(widest + 2 * pad + 2), limit);
  }
  const lines = wrapLines(o.text, Math.max(1, o.w - 2 * pad), measure);
  o.h = Math.ceil(lines.length * lh + 2 * pad);
  return { lines, pad, lh };
}

// ---------------------------------------------------------------------------
// Treffer, Rahmen, Griffe
// ---------------------------------------------------------------------------

export function bbox(o) {
  switch (o.type) {
    case 'text': return { x: o.x, y: o.y, w: o.w, h: o.h || o.size * LINE_HEIGHT };
    case 'rect': case 'ellipse': case 'cover': return { x: o.x, y: o.y, w: o.w, h: o.h };
    case 'line': case 'arrow': return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x1 - o.x2), h: Math.abs(o.y1 - o.y2) };
    case 'pen': case 'marker': {
      const xs = o.points.map(p => p[0]), ys = o.points.map(p => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'badge': return { x: o.x - o.r, y: o.y - o.r, w: 2 * o.r, h: 2 * o.r };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const inside = (b, x, y, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

export function hit(o, x, y, tol) {
  const half = (o.width || 0) / 2;
  switch (o.type) {
    case 'text': case 'badge': case 'cover': return inside(bbox(o), x, y, tol);
    case 'rect': {
      if (o.fill || o.w < tol * 3 || o.h < tol * 3) return inside(o, x, y, tol);
      const edge = Math.min(Math.abs(x - o.x), Math.abs(x - o.x - o.w), Math.abs(y - o.y), Math.abs(y - o.y - o.h));
      return inside(o, x, y, tol + half) && edge <= tol + half;
    }
    case 'ellipse': {
      const rx = o.w / 2, ry = o.h / 2, cx = o.x + rx, cy = o.y + ry;
      if (rx < 1 || ry < 1) return inside(o, x, y, tol);
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (o.fill) return d <= 1 + tol / Math.min(rx, ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol + half;
    }
    case 'line': case 'arrow': return segDist(x, y, o.x1, o.y1, o.x2, o.y2) <= tol + half;
    case 'pen': case 'marker': {
      const p = o.points;
      if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= tol + half;
      for (let i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= tol + half) return true;
      return false;
    }
  }
  return false;
}

// Oberstes getroffenes Objekt
export function topHit(objects, x, y, tol) {
  for (let i = objects.length - 1; i >= 0; i--) if (hit(objects[i], x, y, tol)) return objects[i];
  return null;
}

export function handles(o) {
  switch (o.type) {
    case 'text': { const b = bbox(o); return [{ id: 'w', x: b.x, y: b.y + b.h / 2 }, { id: 'e', x: b.x + b.w, y: b.y + b.h / 2 }]; }
    case 'rect': case 'ellipse': case 'cover': {
      const { x, y, w, h } = o;
      return [
        { id: 'nw', x, y }, { id: 'n', x: x + w / 2, y }, { id: 'ne', x: x + w, y },
        { id: 'e', x: x + w, y: y + h / 2 }, { id: 'se', x: x + w, y: y + h }, { id: 's', x: x + w / 2, y: y + h },
        { id: 'sw', x, y: y + h }, { id: 'w', x, y: y + h / 2 }
      ];
    }
    case 'line': case 'arrow': return [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }];
    case 'badge': return [{ id: 'r', x: o.x + o.r * 0.7071, y: o.y + o.r * 0.7071 }];
  }
  return [];
}

export function moveObject(o, dx, dy) {
  switch (o.type) {
    case 'line': case 'arrow': o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; break;
    case 'pen': case 'marker': o.points = o.points.map(([x, y]) => [x + dx, y + dy]); break;
    default: o.x += dx; o.y += dy;
  }
  return o;
}

// Griff ziehen: `orig` ist der Zustand beim Anfassen, (x, y) die Mauszeigerposition
export function dragHandle(o, orig, id, x, y) {
  if (o.type === 'line' || o.type === 'arrow') {
    if (id === 'p1') { o.x1 = x; o.y1 = y; } else { o.x2 = x; o.y2 = y; }
    return o;
  }
  if (o.type === 'badge') { o.r = Math.max(6, Math.hypot(x - o.x, y - o.y)); return o; }
  if (o.type === 'text') {
    const min = o.size * 1.5;
    if (id === 'e') o.w = Math.max(min, x - orig.x);
    else { const right = orig.x + orig.w; o.x = Math.min(x, right - min); o.w = right - o.x; }
    o.auto = false;
    return o;
  }
  let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
  if (id.includes('w')) x1 = x;
  if (id.includes('e')) x2 = x;
  if (id.includes('n')) y1 = y;
  if (id.includes('s')) y2 = y;
  o.x = Math.min(x1, x2); o.y = Math.min(y1, y2); o.w = Math.abs(x2 - x1); o.h = Math.abs(y2 - y1);
  return o;
}

// Nächste Nummer für eine Beschriftung (1, 2, 3 …)
export function nextBadge(objects) {
  return objects.filter(o => o.type === 'badge').reduce((m, o) => Math.max(m, o.n || 0), 0) + 1;
}

// Zuschnitt begrenzen
export function clampRect(r, W, H, min = 8) {
  let { x, y, w, h } = r;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  x = Math.max(0, Math.min(x, W - min)); y = Math.max(0, Math.min(y, H - min));
  w = Math.max(min, Math.min(w, W - x)); h = Math.max(min, Math.min(h, H - y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// Stiftlinie glätten: Punkte, die fast auf einer Linie liegen, weglassen
export function simplify(points, tol) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
