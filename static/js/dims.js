// Masse: Text mit Einheit, Skizzenelement-Masse, Eingabe auswerten (gemeinsam fuer Skizzierer und 3D-Ansicht)
import { fmt, evalExpr } from './util.js';

export const MM = (v, d = 2) => `${fmt(v, d)} mm`;
export const DEG = (v, d = 2) => `${fmt(v, d)}°`;
const isNum = (v) => typeof v === 'number' || /^[-+]?\d*\.?\d+$/.test(String(v).trim());

/** Eingabe eines Masses: Einheiten/Praefixe entfernen; Zahl -> number, sonst Ausdruck (string) */
export function parseDimInput(s, params) {
  const t = String(s).trim().replace(/^(Ø|R|⌀)\s*/i, '').replace(/\s*(mm|°)\s*$/i, '').replace(',', '.');
  const n = evalExpr(t, params); // wirft bei Fehler
  return isNum(t) ? n : t;
}

/** Anzeige-/Startwert fuer das Eingabefeld */
export function rawValue(src, key, fallback) {
  const v = src[key];
  return v !== undefined && !isNum(v) ? String(v) : fmt(fallback, 4);
}

/**
 * Masse eines Skizzenelements.
 * src: Rohdaten (Zahlen oder Ausdruecke), e: aufgeloeste Zahlen, pad: Abstand in Modelleinheiten,
 * movePoint(ox,oy,nx,ny,except): Endpunkte anderer Elemente mitziehen.
 * Rueckgabe: [{text, x, y, start, apply(v)}] in Skizzenkoordinaten.
 */
export function entityDims(src, e, pad, params, movePoint = () => {}) {
  const out = [];
  const pre = (k) => (src[k] !== undefined && !isNum(src[k]) ? `${src[k]} = ` : '');
  const D = (text, x, y, start, apply) => out.push({ text, x, y, start, apply });
  switch (e.type) {
    case 'rect':
      D(`${pre('w')}${MM(Math.abs(e.w))}`, e.x + e.w / 2, Math.min(e.y, e.y + e.h) - pad, rawValue(src, 'w', Math.abs(e.w)), (v) => { src.w = v; });
      D(`${pre('h')}${MM(Math.abs(e.h))}`, Math.max(e.x, e.x + e.w) + pad * 1.3, e.y + e.h / 2, rawValue(src, 'h', Math.abs(e.h)), (v) => { src.h = v; });
      if (e.r) D(`R ${MM(e.r)}`, Math.max(e.x, e.x + e.w), Math.max(e.y, e.y + e.h) + pad * 0.6, rawValue(src, 'r', e.r), (v) => { src.r = v; });
      break;
    case 'circle':
      D(`Ø ${pre('r')}${MM(e.r * 2)}`, e.cx + e.r * 0.72, e.cy + e.r * 0.72, isNum(src.r) ? fmt(e.r * 2, 4) : `(${src.r})*2`,
        (v) => { src.r = typeof v === 'number' ? v / 2 : `(${v})/2`; });
      break;
    case 'arc': D(`R ${pre('r')}${MM(e.r)}`, e.cx, e.cy, rawValue(src, 'r', e.r), (v) => { src.r = v; }); break;
    case 'polygon': D(`${e.n}-Eck R ${MM(e.r)}`, e.cx, e.cy - e.r - pad, rawValue(src, 'r', e.r), (v) => { src.r = v; }); break;
    case 'slot':
      D(`R ${MM(e.r)}`, (e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2 + e.r + pad, rawValue(src, 'r', e.r), (v) => { src.r = v; });
      D(MM(Math.hypot(e.x2 - e.x1, e.y2 - e.y1)), (e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2 - e.r - pad, fmt(Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 4), (v) => {
        const nl = typeof v === 'number' ? v : evalExpr(v, params); const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1; const k = nl / len;
        src.x2 = +(e.x1 + (e.x2 - e.x1) * k).toFixed(6); src.y2 = +(e.y1 + (e.y2 - e.y1) * k).toFixed(6);
      });
      break;
    case 'line': {
      const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      D(MM(len), (e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, fmt(len, 4), (v) => {
        const nl = typeof v === 'number' ? v : evalExpr(v, params); const k = nl / (len || 1);
        const ox = Number(e.x2), oy = Number(e.y2); const nx = e.x1 + (e.x2 - e.x1) * k, ny = e.y1 + (e.y2 - e.y1) * k;
        src.x2 = +nx.toFixed(6); src.y2 = +ny.toFixed(6); movePoint(ox, oy, nx, ny, src);
      });
      break;
    }
    default: break;
  }
  return out;
}

/** Punkte (Griffe) eines Skizzenelements: [schluesselX, schluesselY] */
export function handlesOf(e) {
  switch (e.type) {
    case 'line': case 'centerline': case 'slot': return [['x1', 'y1'], ['x2', 'y2']];
    case 'rect': return [['x', 'y']];
    case 'circle': case 'polygon': case 'arc': return [['cx', 'cy']];
    default: return [];
  }
}

/** Wert eines steuernden Skizzenmasses (Bemassungswerkzeug) */
export function sketchDimValue(dim, P) {
  const a = P(dim.a), b = dim.b ? P(dim.b) : null;
  if (!a) return null;
  if (dim.type === 'angle') { const ln = P({ ...dim.a, h: 1 }); if (!ln) return null; let ang = Math.atan2(ln.y - a.y, ln.x - a.x) * 180 / Math.PI; return ((ang % 360) + 360) % 360; }
  if (!b) return null;
  if (dim.type === 'hdist') return Math.abs(b.x - a.x);
  if (dim.type === 'vdist') return Math.abs(b.y - a.y);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Endpunkte anderer Linien/Langloecher, die auf (ox,oy) liegen, nach (nx,ny) mitziehen */
export function moveCoincident(entities, ox, oy, nx, ny, except) {
  const same = (a, b) => Math.abs(Number(a) - ox) < 1e-6 && Math.abs(Number(b) - oy) < 1e-6;
  for (const e of entities) {
    if (e === except || !['line', 'centerline', 'slot'].includes(e.type)) continue;
    if (same(e.x1, e.y1)) { e.x1 = nx; e.y1 = ny; }
    if (same(e.x2, e.y2)) { e.x2 = nx; e.y2 = ny; }
  }
}

/** Griffpunkte eines (aufgeloesten) Elements fuer das Bemassungswerkzeug – beim Rechteck alle vier Ecken */
export function handlePoints(e) {
  const N = Number;
  switch (e.type) {
    case 'line': case 'centerline': case 'slot': return [{ x: N(e.x1), y: N(e.y1) }, { x: N(e.x2), y: N(e.y2) }];
    case 'rect': { const x = N(e.x), y = N(e.y), w = N(e.w), h = N(e.h); return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]; }
    case 'circle': case 'polygon': case 'arc': return [{ x: N(e.cx), y: N(e.cy) }];
    default: return [];
  }
}
/**
 * Griffpunkt h auf (nx,ny) setzen. Rechteck: resize=true -> gegenueberliegende Ecke bleibt (Groesse aendert sich),
 * sonst wird das ganze Rechteck verschoben.
 */
export function setHandle(src, e, h, nx, ny, resize = false) {
  const r6 = (v) => +v.toFixed(6);
  if (e.type === 'rect') {
    const P = handlePoints(e);
    if (!resize) { const dx = nx - P[h].x, dy = ny - P[h].y; src.x = r6(Number(e.x) + dx); src.y = r6(Number(e.y) + dy); return; }
    const o = P[(h + 2) % 4];
    if (h === 0) Object.assign(src, { x: r6(nx), y: r6(ny), w: r6(o.x - nx), h: r6(o.y - ny) });
    if (h === 1) Object.assign(src, { x: r6(o.x), y: r6(ny), w: r6(nx - o.x), h: r6(o.y - ny) });
    if (h === 2) Object.assign(src, { x: r6(o.x), y: r6(o.y), w: r6(nx - o.x), h: r6(ny - o.y) });
    if (h === 3) Object.assign(src, { x: r6(nx), y: r6(o.y), w: r6(o.x - nx), h: r6(ny - o.y) });
    return;
  }
  const keys = handlesOf(e)[h]; if (!keys) return;
  src[keys[0]] = r6(nx); src[keys[1]] = r6(ny);
}
