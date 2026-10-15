// UI-Bausteine: Icons, Dialoge, Feature-Dashboard (wie Creo), Kontextmenue, Statusmeldungen
import { el, $ } from './util.js';

const P = (d, extra = '') => `<path d="${d}" ${extra}/>`;
const ICONS = {
  new: P('M6 3h8l4 4v14H6z M14 3v4h4'),
  open: P('M3 7h6l2 2h10v10H3z'),
  save: P('M5 3h12l2 2v16H5z M8 3v6h8V3 M8 21v-7h8v7'),
  undo: P('M9 7L4 12l5 5 M4 12h11a5 5 0 010 10h-3'),
  redo: P('M15 7l5 5-5 5 M20 12H9a5 5 0 000 10h3'),
  regen: P('M12 3v4 M12 3l-3 2 M12 3l3 2') + '<path d="M18.4 8A7.5 7.5 0 1 1 5.6 8" fill="none"/><path d="M9 12h6" stroke-width="2.4" stroke="#ffcf3d"/>',
  close: P('M6 6l12 12 M18 6L6 18'),
  exit: P('M14 4h6v16h-6 M10 8l-4 4 4 4 M6 12h10'),
  folder: P('M3 6h7l2 2h9v11H3z'),
  workdir: P('M3 6h7l2 2h9v11H3z M12 12v5 M9.5 14.5h5'),
  import: P('M12 3v11 M8 10l4 4 4-4 M4 15v5h16v-5'),
  export: P('M12 14V3 M8 7l4-4 4 4 M4 15v5h16v-5'),
  plane: P('M3 9l8-5 10 6-8 5z', 'fill="rgba(217,160,91,.25)"') + P('M3 9v6l10 6v-6 M13 21l8-5v-6'),
  axis: P('M4 20L20 4', 'stroke-dasharray="3 2"') + P('M15 4h5v5'),
  point: P('M12 8v8 M8 12h8') + '<circle cx="12" cy="12" r="2.2"/>',
  csys: P('M6 18V5 M6 18h13 M6 18l-3 3 M6 5l-2 3 M6 5l2 3 M19 18l-3-2 M19 18l-3 2'),
  extrude: P('M5 15l6-3 8 3-6 3z', 'fill="rgba(41,200,255,.25)"') + P('M5 15V7l6-3 8 3v8 M11 12V4 M13 18v-8 M5 7l8 3 6-3'),
  revolve: P('M12 3v18', 'stroke-dasharray="3 2"') + P('M8 6a8 3 0 1 0 8 0 M7 17a5 2 0 0 0 10 0 M7 17V8 M17 17V8'),
  hole: '<ellipse cx="12" cy="7" rx="7" ry="3"/>' + P('M5 7v10a7 3 0 0 0 14 0V7') + '<ellipse cx="12" cy="7" rx="3" ry="1.3" fill="currentColor"/>' + P('M12 8.3V17', 'stroke-dasharray="2 2"'),
  round: P('M4 20V9a5 5 0 0 1 5-5h11') + P('M4 4h5', 'stroke-dasharray="2 2"') + P('M4 4v5', 'stroke-dasharray="2 2"'),
  chamfer: P('M4 20V10l6-6h10') + P('M4 4h6 M4 4v6', 'stroke-dasharray="2 2"'),
  pattern: '<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6" stroke-dasharray="2 2"/><rect x="3" y="15" width="6" height="6" stroke-dasharray="2 2"/><rect x="15" y="15" width="6" height="6" stroke-dasharray="2 2"/>',
  mirror: P('M12 2v20', 'stroke-dasharray="3 2"') + P('M10 6L3 18h7z M14 6l7 12h-7z'),
  shell: P('M4 8l8-4 8 4v9l-8 4-8-4z') + P('M7 9.5l5-2.5 5 2.5v6l-5 2.5-5-2.5z', 'stroke-dasharray="2 1.5"'),
  sketch: P('M4 20l4-1L19 8l-3-3L5 16z M14 7l3 3'),
  measure: P('M3 17L17 3l4 4L7 21z M7 13l2 2 M10 10l2 2 M13 7l2 2'),
  mass: P('M7 8h10l3 12H4z M9 8a3 3 0 0 1 6 0'),
  fit: P('M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5') + '<rect x="8" y="8" width="8" height="8"/>',
  zoomin: '<circle cx="10" cy="10" r="6"/>' + P('M15 15l6 6 M7 10h6 M10 7v6'),
  zoomout: '<circle cx="10" cy="10" r="6"/>' + P('M15 15l6 6 M7 10h6'),
  view: P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z') + '<circle cx="12" cy="12" r="3"/>',
  style: P('M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'fill="rgba(185,195,204,.35)"') + P('M12 12l8-4.5 M12 12v9 M12 12L4 7.5'),
  datums: P('M3 9l8-5 10 6-8 5z') + P('M18 4L6 20', 'stroke-dasharray="3 2"'),
  spin: '<circle cx="12" cy="12" r="2.5"/>' + P('M12 3v4 M12 17v4 M3 12h4 M17 12h4'),
  params: P('M4 6h16 M4 12h16 M4 18h10') + '<text x="15" y="21" font-size="8" fill="currentColor" stroke="none">=</text>',
  settings: '<circle cx="12" cy="12" r="3"/>' + P('M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1'),
  spacemouse: '<ellipse cx="12" cy="16" rx="9" ry="4"/>' + P('M7 15V9a5 3 0 0 1 10 0v6') + '<ellipse cx="12" cy="9" rx="5" ry="2.2"/>',
  assemble: '<rect x="3" y="11" width="9" height="9"/>' + P('M14 4h7v7h-7z', 'stroke-dasharray="2 2"') + P('M13 10l-3 3 M10 9v4h4'),
  create: '<rect x="4" y="6" width="12" height="12"/>' + P('M19 3v6 M16 6h6'),
  drag: P('M12 3v18 M3 12h18 M12 3l-3 3 M12 3l3 3 M12 21l-3-3 M12 21l3-3 M3 12l3-3 M3 12l3 3 M21 12l-3-3 M21 12l-3 3'),
  constraint: P('M4 16h16 M4 20h16') + '<rect x="7" y="6" width="10" height="6"/>',
  part: P('M12 3l8 4.5v9L12 21l-8-4.5v-9z') + P('M12 12l8-4.5 M12 12v9 M12 12L4 7.5'),
  assembly: '<rect x="3" y="12" width="8" height="8"/><rect x="13" y="12" width="8" height="8"/><rect x="8" y="3" width="8" height="8"/>',
  step: P('M6 3h8l4 4v14H6z') + '<text x="7" y="17" font-size="6" fill="currentColor" stroke="none">STP</text>',
  stl: P('M6 3h8l4 4v14H6z') + '<text x="7.5" y="17" font-size="6" fill="currentColor" stroke="none">STL</text>',
  creo: P('M6 3h8l4 4v14H6z') + '<text x="7" y="17" font-size="5.5" fill="currentColor" stroke="none">PRT</text>',
  solidworks: P('M6 3h8l4 4v14H6z') + '<text x="8" y="17" font-size="6" fill="currentColor" stroke="none">SW</text>',
  select: P('M5 3l14 8-6 2-3 6z'),
  line: P('M4 19L20 5') + '<circle cx="4" cy="19" r="1.6" fill="currentColor"/><circle cx="20" cy="5" r="1.6" fill="currentColor"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  circle: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  arc: P('M4 18a9 9 0 0 1 16 0'),
  centerline: P('M3 21L21 3', 'stroke-dasharray="5 2 1 2"'),
  polygon: P('M12 3l8 6-3 10H7L4 9z'),
  slot: P('M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z'),
  project: P('M4 20L20 4', 'stroke-dasharray="2 2"') + P('M4 14l6 6'),
  ok: P('M4 12l5 5L20 6'),
  cancel: P('M6 6l12 12 M18 6L6 18'),
  eye: P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z') + '<circle cx="12" cy="12" r="2.5"/>',
  eyeoff: P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M4 4l16 16'),
  layer: P('M12 3l9 5-9 5-9-5z M3 13l9 5 9-5'),
  tree: P('M4 4h6v4H4z M4 8v10h5 M4 13h5 M14 11h6v4h-6z M14 16h6v4h-6z'),
  insert: P('M3 12h14 M13 8l4 4-4 4', 'stroke="#4ce06a"'),
  error: '<circle cx="12" cy="12" r="9"/>' + P('M12 7v6 M12 16v1'),
  upload: P('M12 15V4 M8 8l4-4 4 4 M4 15v5h16v-5'),
  refresh: P('M20 11a8 8 0 1 0-2 6 M20 5v6h-6'),
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/>' + '<circle cx="12" cy="13" r="3.5"/>' + P('M8 7l2-3h4l2 3'),
  help: '<circle cx="12" cy="12" r="9"/>' + P('M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7 M12 17v.5'),
  window: '<rect x="3" y="4" width="18" height="16"/>' + P('M3 8h18'),
  measureAngle: P('M4 20L20 20 M4 20L16 6') + P('M10 20a6 6 0 0 0-2-4.5'),
  info: '<circle cx="12" cy="12" r="9"/>' + P('M12 11v6 M12 7v1'),
  color: '<circle cx="8" cy="9" r="4"/><circle cx="16" cy="9" r="4"/><circle cx="12" cy="15" r="4"/>',
};
export function icon(name, cls = 'ic') {
  const span = document.createElement('span'); span.className = cls;
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.info}</svg>`;
  return span;
}

// ------------------------------------------------------------ Status
let statusEl = null, statusTimer = null;
export function setStatusEl(e) { statusEl = e; }
export function status(msg, kind = 'info', ms = 0) {
  if (!statusEl) return; statusEl.textContent = msg; statusEl.className = `status-msg ${kind}`;
  clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
}
export function toast(msg, kind = 'info', ms = 3500) {
  const t = el('div', { class: `toast ${kind}` }, msg); $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), ms); setTimeout(() => t.remove(), ms + 400);
}

// ------------------------------------------------------------ Modale Dialoge
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width = 460, onOpen, closable = true }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape' && closable) { e.stopPropagation(); close(null); } };
    const btns = buttons.map(b => el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: async () => {
      if (b.validate) { const ok = await b.validate(); if (!ok) return; }
      close(typeof b.value === 'function' ? b.value() : b.value);
    } }, b.label));
    const box = el('div', { class: 'modal', style: { width: `${width}px` } },
      el('div', { class: 'modal-h' }, el('span', {}, title), closable ? el('button', { class: 'x', onclick: () => close(null) }, '×') : null),
      el('div', { class: 'modal-b' }, body),
      buttons.length ? el('div', { class: 'modal-f' }, btns) : null);
    const wrap = el('div', { class: 'modal-wrap' }, box);
    root.append(wrap); document.addEventListener('keydown', key, true);
    onOpen?.(box, close);
    const first = box.querySelector('input,select,textarea'); if (first) setTimeout(() => { first.focus(); first.select?.(); }, 30);
  });
}
export async function promptDialog(title, label, value = '', { type = 'text', hint } = {}) {
  const inp = el('input', { type, value, class: 'w100', onkeydown: (e) => { if (e.key === 'Enter') e.target.closest('.modal').querySelector('.btn.primary').click(); } });
  const r = await modal({ title, body: el('div', {}, el('label', { class: 'fld' }, label, inp), hint ? el('div', { class: 'muted small' }, hint) : null),
    buttons: [{ label: 'Abbrechen', value: null }, { label: 'OK', primary: true, value: () => inp.value }] });
  return r;
}
export async function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return !!(await modal({ title, body: el('p', {}, text), buttons: [{ label: 'Abbrechen', value: false }, { label: okLabel, primary: !danger, danger, value: true }] }));
}

// ------------------------------------------------------------ Kontextmenue
export function contextMenu(x, y, items) {
  const root = $('#ctx-menu'); root.replaceChildren();
  for (const it of items) {
    if (it === '-') { root.append(el('div', { class: 'sep' })); continue; }
    if (!it) continue;
    root.append(el('div', { class: `mi ${it.disabled ? 'dis' : ''}`, onclick: () => { hide(); if (!it.disabled) it.action(); } },
      it.icon ? icon(it.icon) : el('span', { class: 'ic' }), el('span', {}, it.label), it.key ? el('span', { class: 'key' }, it.key) : null));
  }
  root.style.display = 'block';
  const w = root.offsetWidth, h = root.offsetHeight;
  root.style.left = `${Math.min(x, innerWidth - w - 4)}px`; root.style.top = `${Math.min(y, innerHeight - h - 4)}px`;
  const hide = () => { root.style.display = 'none'; document.removeEventListener('pointerdown', out, true); };
  const out = (e) => { if (!root.contains(e.target)) hide(); };
  setTimeout(() => document.addEventListener('pointerdown', out, true), 0);
}

// ------------------------------------------------------------ Feature-Dashboard (Creo-Stil)
/**
 * fields: [{key, label, type: expr|number|select|check|button|ref|info|color|text, options:[[v,l]], value, onClick, show:(vals)=>bool, width}]
 * Liefert ein Objekt mit close(), values(), set(k,v), refresh(), error(msg)
 */
export function dashboard({ title, iconName, fields, onChange, onOk, onCancel, tabs }) {
  const host = $('#dashboard'); host.replaceChildren(); host.hidden = false;
  const vals = {}; for (const f of fields) if (f.key) vals[f.key] = f.value;
  const errEl = el('div', { class: 'dash-err' });
  const row = el('div', { class: 'dash-fields' });
  const okBtn = el('button', { class: 'dash-ok', title: 'Übernehmen (Enter)', onclick: () => api.ok() }, icon('ok'));
  const cancelBtn = el('button', { class: 'dash-cancel', title: 'Abbrechen (Esc)', onclick: () => api.cancel() }, icon('cancel'));
  const render = () => {
    row.replaceChildren();
    for (const f of fields) {
      if (f.show && !f.show(vals)) continue;
      let ctl;
      const ch = (v) => { vals[f.key] = v; if (f.rerender) render(); onChange?.(vals, f.key); };
      switch (f.type) {
        case 'select': ctl = el('select', { onchange: (e) => ch(e.target.value) }, (typeof f.options === 'function' ? f.options(vals) : f.options).map(([v, l]) => el('option', { value: v, selected: String(vals[f.key]) === String(v) }, l))); break;
        case 'check': ctl = el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: !!vals[f.key], onchange: (e) => ch(e.target.checked) }), f.label); break;
        case 'button': ctl = el('button', { class: `btn sm ${f.primary ? 'primary' : ''}`, onclick: () => f.onClick(vals, api) }, f.icon ? icon(f.icon) : null, f.label); break;
        case 'info': ctl = el('span', { class: 'dash-info' }, typeof f.value === 'function' ? f.value(vals) : f.value); break;
        case 'color': ctl = el('input', { type: 'color', value: vals[f.key], oninput: (e) => ch(e.target.value) }); break;
        default: ctl = el('input', { class: f.type === 'text' ? 'txt' : 'num', value: vals[f.key] ?? '', style: f.width ? { width: f.width } : null,
          onkeydown: (e) => { if (e.key === 'Enter') { ch(e.target.value); api.ok(); } e.stopPropagation(); },
          onchange: (e) => ch(e.target.value) });
      }
      row.append(f.type === 'check' || f.type === 'button' || f.type === 'info' ? el('div', { class: 'dash-f' }, ctl) : el('div', { class: 'dash-f' }, el('span', { class: 'lab' }, f.label), ctl));
    }
  };
  render();
  host.append(el('div', { class: 'dash-title' }, iconName ? icon(iconName) : null, el('span', {}, title)), row, errEl, el('div', { class: 'dash-btns' }, okBtn, cancelBtn));
  const key = (e) => { if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return; if (e.key === 'Escape') api.cancel(); };
  document.addEventListener('keydown', key);
  const close = () => { host.hidden = true; host.replaceChildren(); document.removeEventListener('keydown', key); };
  const api = {
    vals, render,
    set(k, v) { vals[k] = v; render(); },
    error(msg) { errEl.textContent = msg || ''; errEl.style.display = msg ? '' : 'none'; },
    async ok() { try { const r = await onOk?.(vals); if (r !== false) close(); } catch (e) { api.error(e.message); } },
    cancel() { close(); onCancel?.(); },
    close,
  };
  api.error('');
  return api;
}
