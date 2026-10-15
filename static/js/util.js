// Allgemeine Hilfsfunktionen
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let _uid = Date.now() % 100000;
export const uid = (p = 'f') => `${p}${(++_uid).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const fmt = (v, d = 3) => {
  if (!isFinite(v)) return String(v);
  const s = Number(v).toFixed(d);
  return s.replace(/\.?0+$/, '') || '0';
};

// ---------- Ausdruecke (Parameter/Relationen wie in Creo) ----------
const MATH = {
  sin: d => Math.sin(d * Math.PI / 180), cos: d => Math.cos(d * Math.PI / 180), tan: d => Math.tan(d * Math.PI / 180),
  asin: x => Math.asin(x) * 180 / Math.PI, acos: x => Math.acos(x) * 180 / Math.PI, atan: x => Math.atan(x) * 180 / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  pi: Math.PI, PI: Math.PI,
};

/** Wertet Zahl oder Ausdruck aus ("L*2+5", "D/2"). Wirft bei Fehler. */
export function evalExpr(v, params = {}) {
  if (typeof v === 'number') return v;
  if (v === undefined || v === null || v === '') throw new Error('Leerer Wert');
  const s = String(v).trim().replace(/,/g, '.');
  if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return parseFloat(s);
  if (!/^[\w\s.+\-*/()^%]*$/.test(s)) throw new Error(`Ungültiger Ausdruck: ${s}`);
  const names = s.match(/[A-Za-z_]\w*/g) || [];
  const scope = {};
  for (const n of names) {
    if (n in params) scope[n] = Number(params[n]);
    else if (n in MATH) scope[n] = MATH[n];
    else throw new Error(`Unbekannter Parameter: ${n}`);
  }
  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `"use strict"; return (${s.replace(/\^/g, '**')});`);
  const r = fn(...keys.map(k => scope[k]));
  if (typeof r !== 'number' || !isFinite(r)) throw new Error(`Ausdruck ergibt keine Zahl: ${s}`);
  return r;
}

/** Parameter auswerten (Parameter duerfen sich aufeinander beziehen). */
export function evalParams(list = []) {
  const out = {};
  for (let pass = 0; pass < 5; pass++) {
    for (const p of list) {
      try { out[p.name] = evalExpr(p.value, out); } catch { /* naechster Durchlauf */ }
    }
  }
  return out;
}

// ---------- Server-API ----------
export async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json();
  else data = await r.text();
  if (!r.ok) {
    const msg = (data && data.error) || (typeof data === 'string' ? data.replace(/<[^>]+>/g, ' ').trim().slice(0, 300) : r.statusText);
    const err = new Error(msg);
    err.data = data;
    throw err;
  }
  return data;
}
export const apiJson = (path, body, method = 'POST') => api(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export async function readFileBytes(rel) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(rel)}`);
  if (!r.ok) throw new Error(`Datei nicht lesbar: ${rel}`);
  return new Uint8Array(await r.arrayBuffer());
}
export async function readFileText(rel) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(rel)}`);
  if (!r.ok) throw new Error(`Datei nicht lesbar: ${rel}`);
  return r.text();
}
export async function writeFile(rel, data, backup = true) {
  return api(`/api/file?path=${encodeURIComponent(rel)}&backup=${backup ? 1 : 0}`, { method: 'PUT', body: data });
}

export function downloadBlob(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Base64 fuer Netzdaten in JSON ----------
export function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64); const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
export const f32ToB64 = a => bytesToB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
export const b64ToF32 = b => { const u = b64ToBytes(b); return new Float32Array(u.buffer, 0, u.byteLength / 4); };
export const u32ToB64 = a => bytesToB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
export const b64ToU32 = b => { const u = b64ToBytes(b); return new Uint32Array(u.buffer, 0, u.byteLength / 4); };

export const clone = o => JSON.parse(JSON.stringify(o));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const baseName = p => p.split('/').pop();
export const stem = p => baseName(p).replace(/\.[^.]+(\.\d+)?$/, '').replace(/\.(prt|asm|sldprt|sldasm|stp|step|stl)$/i, '');
