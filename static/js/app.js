// CAD-Studio-MK1 - Hauptanwendung
import * as THREE from '../vendor/three.module.js';
import { TransformControls } from '../vendor/addons/controls/TransformControls.js';
import { $, el, api, apiJson, readFileBytes, readFileText, writeFile, downloadBlob, clone, debounce, fmt, stem, baseName, evalParams, evalExpr, uid } from './util.js';
import * as G from './geom.js';
import { Viewer, VIEWS } from './viewer.js';
import { Sketcher, SKETCH_TOOLS } from './sketcher.js';
import { SpaceMouse } from './spacemouse.js';
import { PART_FORMAT, FEATURE_INFO, newPart, regenerate, makeFeature, importFeature, dependents, hiddenByLayer, planeRef, setKernel, KERNEL, edgeRefFromPoly, normalizeFormat, isLegacyPath } from './part.js';
import { ASM_FORMAT, ASM_DATUMS, CONSTRAINT_NAMES, newAssembly, newComponent, regenerateAssembly, flattenBodies, entryBox } from './assembly.js';
import { buildBody, buildDatums, applyDisplayStyle, highlightMesh, faceGroup, DATUM_COLOR } from './render.js';
import { parseSTL, writeSTL, readCAD, writeSTEP, writeUSDA } from './io.js';
import { icon, status, toast, modal, promptDialog, confirmDialog, contextMenu, dashboard, setStatusEl } from './ui.js';
import { MM, DEG, parseDimInput, entityDims, moveCoincident } from './dims.js';

const App = {
  server: null, docs: [], active: null, viewer: null, sm: null,
  display: loadDisplay(),
  sel: [], picking: null, sketcher: null, busy: false, tab: 'model', navTab: 'tree',
  partCache: new Map(), files: [], tctl: null,
};
window.CADStudio = App;
App.run = (id) => runCmd(id);

function loadDisplay() {
  const d = { style: 'shadedEdges', planes: true, axes: true, points: true, csys: true, sketches: true, tags: true, annots: true, spin: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('cadstudio.display') || '{}') }; } catch { return d; }
}
function saveDisplay() { try { localStorage.setItem('cadstudio.display', JSON.stringify(App.display)); } catch { /* egal */ } }
const doc = () => App.active;
const d0 = doc;
const isPart = (d = doc()) => d && d.kind === 'part';
const isAsm = (d = doc()) => d && d.kind === 'assembly';

// =====================================================================================
// Start
// =====================================================================================
async function init() {
  setStatusEl($('#status-msg'));
  App.viewer = new Viewer($('#viewport'));
  App.viewer.spinCenterVisible = App.display.spin;
  App.viewer.handlers.click = onViewClick;
  App.viewer.handlers.hover = debounceFrame(onViewHover);
  App.viewer.handlers.dblclick = onViewDbl;
  App.viewer.handlers.context = onViewContext;
  App.hl = new THREE.Group(); App.viewer.overlay.add(App.hl);
  App.selHl = new THREE.Group(); App.viewer.overlay.add(App.selHl);
  App.measureG = new THREE.Group(); App.viewer.overlay.add(App.measureG);
  App.fdimG = new THREE.Group(); App.viewer.overlay.add(App.fdimG);
  App.annotG = new THREE.Group(); App.viewer.overlay.add(App.annotG);
  App.previewG = new THREE.Group(); App.viewer.world.add(App.previewG);
  let last = performance.now();
  App.viewer.onFrame = (t) => { const dt = Math.min(0.05, (t - last) / 1000); last = t; App.sm?.frame(dt); };
  buildIGT(); bindKeys(); bindNavTabs(); bindDesktop();
  try { App.server = await api('/api/state'); } catch (e) { status('Server nicht erreichbar: ' + e.message, 'err'); return; }
  App.desktop = App.server.mode === 'desktop';
  setKernel(App.server.kernel);
  { const k = $('#kernel-status'); k.textContent = KERNEL.available ? `Kern: usd-brep ${KERNEL.version}` : 'Kern: intern (Netz)';
    k.title = KERNEL.available ? 'Exakter NURBS-B-Rep-Kern NVIDIA usd-brep' : `usd-brep nicht verfügbar – interner Netzkern aktiv. ${App.server.kernel?.error || ''}`; k.classList.toggle('on', KERNEL.available); }
  document.body.classList.toggle('desktop', App.desktop);
  if (!App.desktop) window.addEventListener('beforeunload', (e) => { if (App.docs.some(d => d.dirty)) { e.preventDefault(); e.returnValue = ''; } });
  App.sm = new SpaceMouse({
    native: App.server.hid,
    onMotion: (tr, rot, dt, cfg) => App.viewer.spaceMouse(tr, rot, dt, cfg),
    onButton: (n, action) => smButton(action),
    onStatus: (s) => { const e = $('#sm-status'); if (!e) return; e.textContent = `SpaceMouse: ${s}`; e.classList.toggle('on', s.startsWith('verbunden')); },
  });
  if (!App.sm.supported) $('#sm-status').textContent = 'SpaceMouse: nicht verfügbar';
  $('#version').textContent = `v${App.server.version}`;
  document.title = `CAD-Studio-MK1 ${App.server.version}`;
  renderRibbon(); renderDocTabs(); renderNav();
  await workdirDialog(true);
  newDoc('part', nextDefaultName('part'), true);
}

// ---------------------------------------------------------------- Desktop-Fenster
/** Programmfenster (pywebview): natives API oder null im Browser */
const nativeApi = () => (App.desktop && window.pywebview?.api) || null;
async function waitNative(ms = 3000) {
  if (!App.desktop) return null; const t0 = performance.now();
  while (!window.pywebview?.api?.pick_folder && performance.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
  return nativeApi();
}
function bindDesktop() {
  // Browser-Eigenheiten im Programmfenster unterdruecken: Kontextmenue, Neuladen, Drucken, Suchen, Zoom
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input,textarea')) e.preventDefault(); });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase(); const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F5' || (mod && ['r', 'p', 'f', 'u', '+', '-', '=', '0'].includes(k)) || (mod && e.shiftKey && k === 'i')) e.preventDefault();
  }, true);
  window.addEventListener('wheel', (e) => { if (e.ctrlKey && !e.target.closest('#viewport')) e.preventDefault(); }, { passive: false });
}
let lastDirty = null;
function syncDirty() {
  const dirty = App.docs.some(d => d.dirty);
  if (dirty !== lastDirty) { lastDirty = dirty; apiJson('/api/dirty', { dirty }).catch(() => {}); }
}
App.requestExit = () => exitApp();

function debounceFrame(fn) { let pending = null; return (e) => { const first = !pending; pending = e; if (first) requestAnimationFrame(() => { const x = pending; pending = null; fn(x); }); }; }

// =====================================================================================
// Arbeitsverzeichnis
// =====================================================================================
async function workdirDialog(initial = false) {
  const st = await api('/api/state'); App.server = st;
  const inp = el('input', { class: 'w100', value: st.workdir || st.recent[0] || `${st.home}${st.platform === 'Windows' ? '\\' : '/'}CAD-Studio-MK1-Arbeit` });
  const create = el('input', { type: 'checkbox', checked: true });
  const err = el('div', { class: 'dash-err' });
  const recent = st.recent.length ? el('div', { class: 'recent' }, el('div', { class: 'muted small' }, 'Zuletzt verwendet:'),
    st.recent.map(r => el('button', { class: 'link', onclick: () => { inp.value = r; } }, r))) : null;
  const body = el('div', {},
    el('p', { class: 'muted' }, 'Alle Parts, Baugruppen, Importe und Exporte werden in diesem Ordner gespeichert (wie das Arbeitsverzeichnis in Creo).'),
    el('label', { class: 'fld' }, 'Pfad des Arbeitsverzeichnisses',
      el('div', { class: 'row' }, inp, el('button', { class: 'btn', onclick: async () => { const p = await folderBrowser(inp.value); if (p) inp.value = p; } }, icon('folder'), 'Durchsuchen…'))),
    el('label', { class: 'chk' }, create, 'Ordner anlegen, falls er nicht existiert'),
    recent, err);
  const res = await modal({
    title: 'Arbeitsverzeichnis festlegen', body, width: 620, closable: !initial,
    buttons: [...(initial ? [] : [{ label: 'Abbrechen', value: null }]), {
      label: 'Übernehmen', primary: true, value: () => inp.value,
      validate: async () => {
        try { await apiJson('/api/workdir', { path: inp.value, create: create.checked }); return true; }
        catch (e) { err.textContent = e.message; err.style.display = ''; return false; }
      },
    }],
  });
  if (res) {
    App.server = await api('/api/state'); $('#workdir').textContent = App.server.workdir;
    status(`Arbeitsverzeichnis: ${App.server.workdir}`, 'ok', 5000); await refreshFiles();
    await offerLegacyMigration();
  }
}

async function folderBrowser(start) {
  const na = await waitNative();
  if (na) { try { return await na.pick_folder(start || ''); } catch (e) { toast(e.message || String(e), 'err'); return null; } }
  let cur = start;
  const list = el('div', { class: 'flist' }); const pathEl = el('div', { class: 'path' });
  const load = async (p) => {
    const r = await api(`/api/browse?path=${encodeURIComponent(p || '')}`); cur = r.path; pathEl.textContent = r.path;
    list.replaceChildren(
      ...(r.drives || []).map(d => el('div', { class: 'fitem drive', onclick: () => load(d) }, icon('folder'), d)),
      r.parent ? el('div', { class: 'fitem', onclick: () => load(r.parent) }, icon('folder'), '..') : null,
      ...r.dirs.map(d => el('div', { class: 'fitem', ondblclick: () => load(`${r.path}${r.path.endsWith('/') || r.path.endsWith('\\') ? '' : (r.path.includes('\\') ? '\\' : '/')}${d}`),
        onclick: (e) => { list.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); } }, icon('folder'), d)));
  };
  try { await load(start); } catch { await load(''); }
  return modal({ title: 'Ordner wählen', width: 560, body: el('div', {}, pathEl, list, el('div', { class: 'muted small' }, 'Doppelklick öffnet einen Ordner.')),
    buttons: [{ label: 'Abbrechen', value: null }, { label: 'Diesen Ordner wählen', primary: true, value: () => {
      const s = list.querySelector('.fitem.sel'); if (s && s.textContent !== '..') return `${cur}${cur.endsWith('/') || cur.endsWith('\\') ? '' : (cur.includes('\\') ? '\\' : '/')}${s.textContent}`; return cur; } }] });
}

/** Dateien der Vorgaengerversion (.bcprt/.bcasm) gefunden? Umwandlung anbieten */
async function offerLegacyMigration(force = false) {
  const n = App.files.filter(f => f.legacy).length; if (!n) { if (force) toast('Keine Dateien im alten Format gefunden', 'info'); return; }
  if (!(await confirmDialog('Dateien im alten Format', `Im Arbeitsverzeichnis liegen ${n} Part-/Baugruppendatei(en) im alten Format (.bcprt/.bcasm). In das aktuelle Format (.csprt/.csasm) umwandeln? Die Originale bleiben erhalten, Verweise in Baugruppen werden angepasst.`, 'Umwandeln'))) return;
  try {
    const r = await apiJson('/api/migrate_legacy', {});
    await refreshFiles();
    toast(`${r.converted.length} umgewandelt${r.skipped.length ? `, ${r.skipped.length} übersprungen (neue Datei existiert schon)` : ''}${r.errors.length ? `, ${r.errors.length} Fehler` : ''}`, r.errors.length ? 'warn' : 'ok', 6000);
  } catch (e) { toast(e.message, 'err'); }
}

async function refreshFiles() {
  try { const r = await api('/api/files'); App.files = r.files; } catch { App.files = []; }
  if (App.navTab === 'folder') renderNav();
}

// =====================================================================================
// Dokumente
// =====================================================================================
function nextDefaultName(kind) {
  const pre = kind === 'part' ? 'prt' : 'asm'; let i = 1;
  const taken = new Set([...App.docs.map(d => d.data.name.toLowerCase()), ...App.files.map(f => stem(f.name).toLowerCase())]);
  while (taken.has(`${pre}${String(i).padStart(4, '0')}`)) i++;
  return `${pre}${String(i).padStart(4, '0')}`;
}
function makeDoc(kind, data, path = null) {
  const g = new THREE.Group(); g.visible = false; App.viewer.world.add(g);
  const d = { uid: uid('d'), kind, data, path, dirty: false, undo: [], redo: [], res: null, group: g, cam: null };
  App.docs.push(d); return d;
}
async function newDoc(kind, name, silent = false) {
  if (!silent) {
    const typ = el('select', {}, el('option', { value: 'part', selected: kind === 'part' }, 'Part'), el('option', { value: 'assembly', selected: kind === 'assembly' }, 'Baugruppe'));
    const nm = el('input', { value: name || nextDefaultName(kind) });
    typ.onchange = () => { nm.value = nextDefaultName(typ.value); };
    const r = await modal({ title: 'Neu', body: el('div', {}, el('label', { class: 'fld' }, 'Typ', typ), el('label', { class: 'fld' }, 'Name', nm)),
      buttons: [{ label: 'Abbrechen', value: null }, { label: 'OK', primary: true, value: () => ({ kind: typ.value, name: nm.value.trim() }) }] });
    if (!r || !r.name) return null; kind = r.kind; name = r.name;
  }
  const data = kind === 'part' ? newPart(name) : newAssembly(name);
  const d = makeDoc(kind, data);
  await activate(d, true);
  return d;
}

async function activate(d, fitView = false) {
  if (App.sketcher) { toast('Bitte zuerst die Skizze beenden', 'warn'); return; }
  closeDash(); clearPick(); detachDrag(); clearMeasure();
  const prev = App.active;
  if (prev && prev !== d) { prev.group.visible = false; prev.cam = saveCam(); }
  App.active = d; d.group.visible = true; App.sel = []; clearSelHl();
  await rebuild(d);
  if (d.cam && !fitView) restoreCam(d.cam); else { App.viewer.setView('standard', d.res?.bbox, false); }
  renderRibbon(); renderDocTabs(); renderNav(); updateTitle();
}
function saveCam() { const c = App.viewer.camera; return { p: c.position.clone(), q: c.quaternion.clone(), z: c.zoom, pv: App.viewer.pivot.clone(), r: App.viewer.modelRadius }; }
function restoreCam(s) { const c = App.viewer.camera; c.position.copy(s.p); c.quaternion.copy(s.q); c.up.set(0, 1, 0).applyQuaternion(s.q); c.zoom = s.z; c.updateProjectionMatrix(); App.viewer.pivot.copy(s.pv); App.viewer.modelRadius = s.r; App.viewer.request(); }

function updateTitle() {
  const d = doc();
  const t = d ? `${d.data.name.toUpperCase()}${d.kind === 'part' ? ' (Part)' : ' (Baugruppe)'}${d.dirty ? ' *' : ''}` : '';
  $('#doc-title').textContent = t;
  const full = `CAD-Studio-MK1 ${App.server?.version || ''}${t ? ' – ' + t : ''}`;
  document.title = full;
  if (full !== App._winTitle) { App._winTitle = full; nativeApi()?.set_title(full); }
  syncDirty();
}

/** Regenerieren und anzeigen */
async function rebuild(d = doc(), opts = {}) {
  if (!d) return;
  try {
    if (d.kind === 'part') {
      d.res = await regenerate(d.data, opts);
    } else {
      d.res = await regenerateAssembly(d.data, loadDocForAsm, App.partCache);
    }
  } catch (e) { console.error(e); status('Regenerierung fehlgeschlagen: ' + e.message, 'err'); return; }
  showResult(d, d.res);
  if (d === doc() && !opts.preview) { renderNav(); reportErrors(d.res); }
}
function reportErrors(res) {
  if (res.errors?.length) status(`${res.errors.length} Fehler: ${res.errors.map(e => `${e.name}: ${e.msg}`).join(' · ')}`, 'err');
  else status('Regenerierung erfolgreich', 'ok', 3000);
}

function showResult(d, res) {
  d.group.clear();
  if (d.kind === 'part') {
    const body = buildBody(res, d.data.color); d.group.add(body);
  } else {
    for (const e of res.comps) {
      if (e.comp.suppressed) continue;
      const cg = buildCompGroup(e); cg.visible = !e.comp.hidden; d.group.add(cg); e.group = cg;
    }
  }
  applyDisplayStyle(d.group, App.display.style);
  if (d === doc()) {
    const hiddenFn = d.kind === 'assembly' ? (id) => d.data.layers.some(l => !l.visible && (l.items.includes(id) || l.rule === 'default' || (l.rule === 'datumPlane' && id.startsWith('ASM_')) || (l.rule === 'csys' && id === 'ASM_DEF_CSYS'))) : null;
    const dg = buildDatums(res, d.data, App.viewer, App.display, '', hiddenFn); d.group.add(dg);
    renderAnnotations(d, res);
  }
  App.viewer.request();
}
function buildCompGroup(e, depth = 0) {
  const g = new THREE.Group(); g.matrixAutoUpdate = false; g.matrix.copy(e.matrix); g.userData.compId = e.comp.id; g.userData.entry = e;
  if (e.regen) { const b = buildBody(e.regen, e.color); b.traverse(o => { o.userData.compId = e.comp.id; }); g.add(b); }
  if (e.sub) for (const s of e.sub.comps) if (!s.comp.suppressed && !s.comp.hidden) { const sg = buildCompGroup(s, depth + 1); sg.traverse(o => { o.userData.compId = e.comp.id; }); g.add(sg); }
  return g;
}

async function loadDocForAsm(file) {
  const open = App.docs.find(x => x.path === file);
  if (open) return open.data;
  const txt = await readFileText(file);
  return normalizeFormat(JSON.parse(txt));
}

// ---------------------------------------------------------------- Aenderungen mit Undo
async function commit(fn, d = doc()) {
  d.undo.push(JSON.stringify(d.data)); if (d.undo.length > 60) d.undo.shift(); d.redo = [];
  await fn(d.data);
  d.data._rev = (d.data._rev || 0) + 1;
  d.dirty = true; updateTitle(); renderDocTabs();
  App.sel = []; clearSelHl();
  await rebuild(d);
}
async function undo() {
  const d = doc(); if (!d || !d.undo.length || App.sketcher) return;
  d.redo.push(JSON.stringify(d.data)); d.data = JSON.parse(d.undo.pop()); d.dirty = true; await rebuild(d); updateTitle(); status('Rückgängig', 'info', 2000);
}
async function redo() {
  const d = doc(); if (!d || !d.redo.length || App.sketcher) return;
  d.undo.push(JSON.stringify(d.data)); d.data = JSON.parse(d.redo.pop()); d.dirty = true; await rebuild(d); updateTitle(); status('Wiederherstellen', 'info', 2000);
}

// =====================================================================================
// Dateien: Oeffnen, Speichern, Import, Export
// =====================================================================================
const KIND_LABEL = { part: 'Part', assembly: 'Baugruppe', step: 'STEP', iges: 'IGES', stl: 'STL', creo: 'Creo', solidworks: 'SolidWorks', usd: 'USD' };
async function fileChooser({ title, kinds, okLabel = 'Öffnen' }) {
  await refreshFiles();
  const search = el('input', { placeholder: 'Filter…', class: 'w100' });
  const list = el('div', { class: 'flist tall' }); let chosen = null;
  const draw = () => {
    const q = search.value.toLowerCase();
    const files = App.files.filter(f => kinds.includes(f.kind) && f.path.toLowerCase().includes(q));
    list.replaceChildren(...(files.length ? files.map(f => el('div', { class: 'fitem', title: f.path,
      onclick: (e) => { list.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); chosen = f.path; },
      ondblclick: (e) => { chosen = f.path; e.currentTarget.closest('.modal').querySelector('.btn.primary').click(); } },
    icon(fileIcon(f.kind)), el('span', { class: 'fn' }, f.path), el('span', { class: 'fk' }, KIND_LABEL[f.kind]), el('span', { class: 'fs' }, `${(f.size / 1024).toFixed(0)} KB`)))
      : [el('div', { class: 'muted pad' }, 'Keine passenden Dateien im Arbeitsverzeichnis.')]));
  };
  search.oninput = draw; draw();
  const up = el('input', { type: 'file', multiple: true, style: 'display:none', onchange: async (e) => {
    const fd = new FormData(); for (const f of e.target.files) fd.append('files', f, f.name);
    try { const r = await api('/api/upload', { method: 'POST', body: fd }); await refreshFiles(); draw(); toast(`${r.files.length} Datei(en) ins Arbeitsverzeichnis kopiert`, 'ok'); }
    catch (er) { toast(er.message, 'err'); }
  } });
  return modal({ title, width: 720, body: el('div', {}, el('div', { class: 'row' }, search, el('button', { class: 'btn', onclick: async () => {
    const na = nativeApi(); if (!na) { up.click(); return; }
    const paths = await na.pick_files(); if (!paths?.length) return;
    try { const r = await apiJson('/api/import_paths', { paths }); await refreshFiles(); draw(); toast(`${r.files.length} Datei(en) ins Arbeitsverzeichnis kopiert`, 'ok'); } catch (er) { toast(er.message, 'err'); }
  } }, icon('upload'), 'Vom Computer hinzufügen…'), up),
    list, el('div', { class: 'muted small' }, `Arbeitsverzeichnis: ${App.server.workdir}`)),
  buttons: [{ label: 'Abbrechen', value: null }, { label: okLabel, primary: true, value: () => chosen }] });
}
const fileIcon = (k) => ({ part: 'part', assembly: 'assembly', step: 'step', iges: 'step', stl: 'stl', creo: 'creo', solidworks: 'solidworks', usd: 'export' }[k] || 'new');

async function openFile(path) {
  if (!path) path = await fileChooser({ title: 'Datei öffnen', kinds: ['part', 'assembly', 'step', 'iges', 'stl', 'creo', 'solidworks'] });
  if (!path) return;
  const existing = App.docs.find(d => d.path === path); if (existing) { await activate(existing); return; }
  const kind = App.files.find(f => f.path === path)?.kind || kindOf(path);
  await busy(`Öffne ${path}…`, async () => {
    if (kind === 'part' || kind === 'assembly') {
      const data = normalizeFormat(JSON.parse(await readFileText(path)));
      if (![PART_FORMAT, ASM_FORMAT].includes(data.format)) throw new Error('Keine CAD-Studio-MK1-Datei');
      if (isLegacyPath(path)) toast('Datei im alten Format – beim Speichern entsteht eine Datei mit neuer Endung (.csprt/.csasm).', 'info', 6000);
      const d = makeDoc(data.format === PART_FORMAT ? 'part' : 'assembly', data, path); await activate(d, true);
    } else {
      const meshes = await readForeign(path, kind);
      const data = newPart(stem(path));
      data.features.push(importFeature(data, `Import ${baseName(path)}`, meshes.length > 1 ? G.concatGeoms(meshes.map(m => m.geom)) : meshes[0].geom, path));
      if (meshes[0].color) data.color = `#${new THREE.Color(...meshes[0].color).getHexString()}`;
      const d = makeDoc('part', data, null); d.dirty = true; await activate(d, true);
      toast(`${baseName(path)} importiert (${meshes.length} Körper). Speichern legt ${data.name}.csprt an.`, 'ok', 5000);
    }
  });
}
function kindOf(p) {
  const n = p.toLowerCase().replace(/\.\d+$/, '');
  if (n.endsWith('.csprt') || n.endsWith('.bcprt')) return 'part'; if (n.endsWith('.csasm') || n.endsWith('.bcasm')) return 'assembly'; if (/\.(stp|step)$/.test(n)) return 'step';
  if (/\.(igs|iges)$/.test(n)) return 'iges'; if (n.endsWith('.stl')) return 'stl'; if (/\.(prt|asm)$/.test(n)) return 'creo'; if (/\.(sldprt|sldasm)$/.test(n)) return 'solidworks'; return 'other';
}
/** Fremdformat -> [{name, geom, color}] */
async function readForeign(path, kind) {
  if (kind === 'creo' || kind === 'solidworks') {
    try { const r = await apiJson('/api/convert', { path }); path = r.path; kind = 'step'; await refreshFiles(); }
    catch (e) {
      if (e.data?.needs_converter) {
        await modal({ title: `${KIND_LABEL[kind]}-Datei`, width: 560, body: el('div', {},
          el('p', {}, 'Native Creo- (.prt/.asm) und SolidWorks-Dateien (.sldprt/.sldasm) sind geschlossene, herstellerspezifische Formate. Ohne die Hersteller-Software oder einen lizenzierten Konverter lassen sie sich nicht auslesen.'),
          el('p', {}, el('b', {}, 'So geht es: '), 'Im Ursprungsprogramm als STEP speichern (Creo: Datei › Speichern als › STEP; SolidWorks: Datei › Speichern unter › STEP AP214) und die .stp-Datei öffnen.'),
          el('p', {}, 'Oder unter ', el('b', {}, 'Werkzeuge › Optionen'), ' einen Konverter-Befehl hinterlegen (z. B. CAD Exchanger CLI). CAD-Studio-MK1 ruft ihn dann automatisch auf und importiert das STEP-Ergebnis.')) });
        throw new Error('Import abgebrochen');
      }
      throw e;
    }
  }
  const bytes = await readFileBytes(path);
  if (kind === 'stl') { const g = G.ensureOutward(G.prepGeom(parseSTL(bytes))); return [{ name: stem(path), geom: g }]; }
  return readCAD(bytes, kind === 'iges' ? 'iges' : 'step');
}

async function saveDoc(d = doc(), asName = null) {
  if (!d) return;
  if (asName) { d.data.name = asName; d.path = null; }
  const ext = d.kind === 'part' ? 'csprt' : 'csasm';
  if (isLegacyPath(d.path)) { d.path = d.path.replace(/\.(bcprt|bcasm)$/i, `.${ext}`); toast(`Gespeichert im aktuellen Format: ${d.path}`, 'info', 5000); }
  if (!d.path) {
    const target = `${d.data.name.toLowerCase()}.${ext}`;
    if (App.files.some(f => f.path === target) && !asName && !(await confirmDialog('Datei existiert', `${target} existiert bereits im Arbeitsverzeichnis. Überschreiben?`, 'Überschreiben', true))) return;
    d.path = target;
  }
  const data = { ...d.data, appVersion: App.server.version, savedAt: new Date().toISOString() };
  delete data._rev;
  await busy('Speichern…', async () => { await writeFile(d.path, JSON.stringify(data)); });
  d.dirty = false; updateTitle(); renderDocTabs(); await refreshFiles();
  App.partCache.clear();
  status(`Gespeichert: ${d.path}`, 'ok', 4000);
}
async function saveAs() {
  const d = doc(); if (!d) return;
  const n = await promptDialog('Speichern unter', 'Neuer Name', `${d.data.name}_kopie`); if (!n) return;
  await saveDoc(d, n.trim());
}
async function closeDoc(d = doc()) {
  if (!d) return;
  if (d.dirty && !(await confirmDialog('Nicht gespeichert', `${d.data.name} hat ungespeicherte Änderungen. Trotzdem schließen?`, 'Schließen', true))) return;
  App.viewer.world.remove(d.group); App.docs = App.docs.filter(x => x !== d);
  if (App.active === d) { App.active = null; if (App.docs.length) await activate(App.docs[App.docs.length - 1]); else await newDoc('part', nextDefaultName('part'), true); }
  renderDocTabs();
}

async function exportDialog() {
  const d = doc(); if (!d) return;
  const fmtSel = el('select', {},
    KERNEL.available ? el('option', { value: 'usdb' }, 'OpenUSD B-Rep, exakt NURBS – usd-brep (.usda)') : null,
    KERNEL.available && isPart(d) ? el('option', { value: 'smb' }, 'SMLib B-Rep, exakt – usd-brep (.brep)') : null,
    el('option', { value: 'step', selected: true }, 'STEP AP214 (.stp)'), el('option', { value: 'stlb' }, 'STL binär (.stl)'), el('option', { value: 'stla' }, 'STL ASCII (.stl)'), el('option', { value: 'usda' }, 'OpenUSD Netz (.usda)'));
  const name = el('input', { value: d.data.name.toLowerCase() });
  const dl = el('input', { type: 'checkbox', checked: !App.desktop });
  const r = await modal({ title: 'Exportieren', body: el('div', {}, el('label', { class: 'fld' }, 'Format', fmtSel), el('label', { class: 'fld' }, 'Dateiname (ohne Endung)', name),
    el('label', { class: 'chk' }, dl, App.desktop ? 'Zusätzlich an einem anderen Ort speichern…' : 'Zusätzlich im Browser herunterladen'),
    el('p', { class: 'muted small' }, 'Die Datei wird ins Arbeitsverzeichnis geschrieben. ' + (KERNEL.available ? 'OpenUSD B-Rep und SMLib B-Rep enthalten die exakte NURBS-Geometrie aus usd-brep (omniSolid-Schema). ' : '') + 'STEP wird als Volumenkörper mit ebenen Flächen ausgegeben (gekrümmte Flächen facettiert), da usd-brep keine STEP-Ausgabe bietet. Baugruppen werden als Mehrkörper-Datei exportiert.')),
  buttons: [{ label: 'Abbrechen', value: null }, { label: 'Exportieren', primary: true, value: () => ({ f: fmtSel.value, n: name.value.trim(), dl: dl.checked }) }] });
  if (!r) return;
  if (r.f === 'usdb' || r.f === 'smb') {
    const parts = isPart(d) ? [{ ops: d.res.ops || [], name: d.data.name }] : flattenKernelParts(d.res);
    if (!parts.some(p => p.ops.length)) { toast('Keine B-Rep-Geometrie (importierte Netze werden in diesen Formaten nicht ausgegeben)', 'warn'); return; }
    await busy('Exportiere exakte B-Rep…', async () => {
      const file = `${r.n}.${r.f === 'smb' ? 'brep' : 'usda'}`;
      const res = await apiJson('/api/kernel/export', { parts, path: file, format: r.f === 'smb' ? 'brep' : 'usd' });
      if (r.dl) { const na = nativeApi(); if (na) { const p = await na.save_copy(file); if (p) toast(`Kopie gespeichert: ${p}`, 'ok'); } else window.open(`/api/file?path=${encodeURIComponent(file)}&download=1`); }
      await refreshFiles(); status(`Exportiert (exakt, ${res.bodies} Körper): ${file}`, 'ok', 6000);
    });
    return;
  }
  const bodies = isPart(d) ? (d.res.display ? [{ name: d.data.name, geom: d.res.display, color: hexToRgb(d.data.color) }] : []) : flattenBodies(d.res).map(b => ({ ...b, color: hexToRgb(b.color) }));
  if (!bodies.length) { toast('Keine Geometrie zum Exportieren', 'warn'); return; }
  await busy('Exportiere…', async () => {
    let data, ext, type = 'application/octet-stream';
    if (r.f === 'step') { const s = writeSTEP(bodies, d.data.name); data = s.text; ext = 'stp'; type = 'application/step'; if (s.stats.open) toast(`Hinweis: Das Netz ist an ${s.stats.open} Kanten nicht vollständig geschlossen. Creo/SolidWorks vernähen das beim Import in der Regel automatisch.`, 'warn', 7000); }
    else if (r.f === 'usda') { data = writeUSDA(bodies, d.data.name); ext = 'usda'; type = 'text/plain'; }
    else { data = writeSTL(bodies.map(b => { const g = G.prepGeom(b.geom); if (b.matrix) g.applyMatrix4(b.matrix); return g; }), d.data.name, r.f === 'stlb'); ext = 'stl'; }
    const file = `${r.n}.${ext}`;
    await writeFile(file, data, false);
    if (r.dl) { const na = nativeApi(); if (na) { const p = await na.save_copy(file); if (p) toast(`Kopie gespeichert: ${p}`, 'ok'); } else downloadBlob(data, file, type); }
    await refreshFiles();
    status(`Exportiert: ${file}`, 'ok', 5000);
  });
}
/** Baugruppe -> Liste aus Kern-Operationen je Part mit Weltmatrix (fuer exakten Export) */
function flattenKernelParts(res, parent = new THREE.Matrix4()) {
  const out = [];
  for (const e of res.comps) {
    if (e.comp.suppressed || e.comp.hidden) continue;
    const m = parent.clone().multiply(e.matrix);
    if (e.regen?.ops?.length) out.push({ ops: e.regen.ops, matrix: Array.from(m.elements), name: e.comp.name });
    if (e.sub) out.push(...flattenKernelParts(e.sub, m));
  }
  return out;
}
const hexToRgb = (h) => { if (!h) return null; const c = new THREE.Color(h); return [c.r, c.g, c.b]; };

async function importIntoPart() {
  const d = doc(); if (!isPart(d)) return;
  const path = await fileChooser({ title: 'Geometrie importieren', kinds: ['step', 'iges', 'stl', 'creo', 'solidworks'], okLabel: 'Importieren' }); if (!path) return;
  await busy('Importiere…', async () => {
    const meshes = await readForeign(path, App.files.find(f => f.path === path)?.kind || kindOf(path));
    const geom = meshes.length > 1 ? G.concatGeoms(meshes.map(m => m.geom)) : meshes[0].geom;
    await commit((data) => insertFeature(data, importFeature(data, `Import ${baseName(path)}`, geom, path)));
    App.viewer.fit(d.res.bbox);
  });
}

function insertFeature(data, f) {
  if (data.insertAt === null || data.insertAt === undefined) data.features.push(f);
  else { data.features.splice(data.insertAt, 0, f); data.insertAt++; }
}

async function busy(msg, fn) {
  const ov = $('#busy'); $('#busy-msg').textContent = msg; ov.hidden = false;
  await new Promise(r => setTimeout(r, 30));
  try { return await fn(); } catch (e) { console.error(e); if (e.message !== 'Import abgebrochen') toast(e.message, 'err', 6000); return null; } finally { ov.hidden = true; }
}

// =====================================================================================
// Auswahl, Picken, Hervorheben
// =====================================================================================
function pickables(kinds) {
  const objs = [];
  const d = doc(); if (!d) return objs;
  d.group.traverse(o => {
    if (!o.visible) return;
    if (o.userData.role === 'body' && (kinds.includes('face') || kinds.includes('point') || kinds.includes('comp'))) objs.push(o);
    if (o.userData.role === 'edges' && kinds.includes('edge')) objs.push(o);
    if (o.userData.pick === 'plane' && kinds.includes('plane')) objs.push(o);
    if (o.userData.pick === 'axis' && kinds.includes('axis')) objs.push(o);
    if (o.userData.pick === 'sketch' && kinds.includes('sketch')) objs.push(o);
  });
  return objs;
}
/** Treffertest -> normiertes Ergebnis */
function hitTest(ev, kinds, filter) {
  const hits = App.viewer.pick(ev, pickables(kinds)).filter(h => !filter || filter(h));
  if (!hits.length) return null;
  // nur echte Koerperflaechen verdecken – die transparente Flaeche einer Bezugsebene nicht
  const surf = hits.find(h => h.object.userData.role === 'body');
  let h = hits[0];
  if (kinds.includes('edge')) {
    const eh = hits.find(x => x.object.userData.role === 'edges');
    if (eh && (!surf || eh.distance <= surf.distance + (App.viewer.modelRadius || 100) * 0.02)) h = eh;
    else if (!kinds.includes('face') && !kinds.includes('plane')) return eh ? toResult(eh) : null;
  }
  // wie Creo: Geometrie hat Vorrang vor der (transparenten) Flaeche einer Bezugsebene; Ebenen per Rand/Baum waehlbar
  const body = hits.find(x => x.object.userData.role === 'body');
  if (h.object.userData.pick === 'plane' && !h.object.userData.outline && body && kinds.includes('face')) h = body;
  // Skizzenlinien liegen meist auf einer Flaeche: sie haben Vorrang vor Flaeche, Ebene und Kante
  if (kinds.includes('sketch')) {
    const sh = hits.find(x => x.object.userData.pick === 'sketch');
    if (sh && (!surf || sh.distance <= surf.distance + (App.viewer.modelRadius || 100) * 0.02)) h = sh;
  }
  return toResult(h);
}
function toResult(h) {
  const o = h.object; const u = o.userData;
  if (u.pick === 'plane') return { kind: 'plane', ref: u.id, name: u.name, obj: o };
  if (u.pick === 'axis') return { kind: 'axis', ref: u.id, name: u.name, obj: o };
  if (u.pick === 'sketch') return { kind: 'sketch', ref: u.id, name: u.name, obj: o };
  if (u.role === 'edges') {
    const p = o.geometry.attributes.position; const i = h.index - (h.index % 2);
    const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
    const body = o.parent.children.find(c => c.userData.role === 'body');
    const ud = o.geometry.userData || {}; const ei = ud.segEdge ? ud.segEdge[i / 2] : -1;
    const edgeRef = ei >= 0 && ud.polys ? edgeRefFromPoly(ud.polys[ei]) : null;
    return { kind: 'edge', a, b, mesh: body?.userData.mesh, compId: u.compId, obj: o, name: edgeRef ? `Kante (${fmt(edgeRef.len, 2)} mm)` : 'Kante', world: o.matrixWorld.clone(), edgeRef, edgePoly: ei >= 0 ? ud.polys[ei] : null, edgeIndex: ei, polys: ud.polys || null };
  }
  if (u.role === 'body') {
    const mesh = u.mesh; const fg = faceGroup(mesh, h.faceIndex);
    const mw = o.matrixWorld; const nW = fg.normal.clone().transformDirection(mw).normalize();
    return { kind: 'face', point: h.point.clone(), normal: nW, localPoint: h.point.clone().applyMatrix4(mw.clone().invert()), localNormal: fg.normal.clone(),
      plane: { origin: G.v3arr(h.point), normal: G.v3arr(nW), xdir: null }, hlGeom: fg.geom, world: mw.clone(), compId: u.compId, name: 'Fläche', obj: o, faceIndex: h.faceIndex };
  }
  return null;
}
function drawHl(group, r, color = 0x29c8ff, keep = false) {
  if (!keep) group.clear(); if (!r) { App.viewer.request(); return; }
  if (r.kind === 'face') { const m = highlightMesh(r.hlGeom, color, 0.45); m.matrixAutoUpdate = false; m.matrix.copy(r.world); group.add(m); }
  else if (r.kind === 'edge') {
    const pts = (r.edgePoly || [G.v3arr(r.a), G.v3arr(r.b)]).map(p => new THREE.Vector3(...p));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 }));
    l.matrixAutoUpdate = false; l.matrix.copy(r.world); l.renderOrder = 30; group.add(l);
  } else if (r.kind === 'plane' && keep) { planeHl(group, r.ref, r.name, color);
  } else if (r.obj) {
    const src = r.obj.type === 'Mesh' ? r.obj.parent.children.find(c => c.type === 'LineLoop') || r.obj : r.obj;
    const c = src.clone(); c.material = new THREE.LineBasicMaterial({ color, depthTest: false }); c.renderOrder = 30; group.add(c);
  }
  App.viewer.request();
}
function clearSelHl() { App.selHl.clear(); App.viewer.clearLabels('sel'); App.viewer.request(); }
/** Gewaehlte Bezugsebene deutlich hervorheben: Flaeche, doppelter Rand, Namensschild */
function planeHl(group, id, name, color = 0xffb020) {
  let fill = null;
  doc()?.group.traverse(o => { if (o.userData.pick === 'plane' && o.userData.id === id && !o.userData.outline) fill = o; });
  if (!fill) return;
  const loop = fill.parent.children.find(c => c.type === 'LineLoop');
  const f = new THREE.Mesh(fill.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
  f.renderOrder = 24; group.add(f);
  if (loop) {
    const pts = []; const pa = loop.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pa, i));
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    for (const k of [1, 0.985, 0.97]) {
      const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(p => c.clone().lerp(p, k))), new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 26; group.add(l);
    }
    App.viewer.addLabel(`▶ ${name || id}`, pts[3] || pts[0], 'lbl selplane', 'sel');
  }
}
/** Alle gewaehlten Elemente zeichnen (Mehrfachauswahl mit Strg) */
function drawSel() {
  App.selHl.clear(); App.viewer.clearLabels('sel');
  for (const r of App.sel) {
    if (r.kind === 'plane') planeHl(App.selHl, r.ref, r.name);
    else if (r.kind === 'face') { drawHl(App.selHl, r, 0xffb020, true); if (r.point && !r.compId) App.viewer.addLabel('▶ Fläche', r.point, 'lbl selplane', 'sel'); }
    else drawHl(App.selHl, r, 0xffb020, true);
  }
  App.viewer.request();
}
const selKey = (r) => r.kind === 'edge' ? `e:${(r.edgeRef?.mid || G.v3arr(r.a)).map(v => v.toFixed(3))}` : r.kind === 'face' ? `f:${r.faceIndex}:${r.compId || ''}` : `${r.kind}:${r.ref || r.compId}`;

function pick({ kinds, prompt, filter, multi = false, onToggle }) {
  clearPick();
  status(prompt + ' (Esc = abbrechen' + (multi ? ', Enter/Mittelklick = fertig' : '') + ')', 'pick');
  App.viewer.el.classList.add('picking');
  return new Promise((resolve) => { App.picking = { kinds, resolve, filter, multi, onToggle, list: [] }; });
}
function clearPick(result = null) {
  const p = App.picking; if (!p) return;
  App.picking = null; App.hl.clear(); App.viewer.el.classList.remove('picking'); status('');
  p.resolve(p.multi ? (result === null ? null : p.list) : result);
}

function onViewHover(ev) {
  if (!ev) { App.hl.clear(); App.viewer.request(); return; }
  const kinds = App.picking ? App.picking.kinds : App.dashPick ? App.dashPick.kinds : isAsm() ? ['face', 'plane', 'axis'] : ['sketch', 'face', 'plane', 'axis', 'edge'];
  const r = hitTest(ev, kinds, App.picking?.filter || App.dashPick?.filter);
  drawHl(App.hl, r, App.picking || App.dashPick ? 0x4ce06a : 0x29c8ff);
}
function onViewClick(ev) {
  const P = App.picking;
  if (P) {
    const r = hitTest(ev, P.kinds, P.filter); if (!r) return;
    if (P.multi) { P.onToggle?.(r, P.list); return; }
    clearPick(r); return;
  }
  // Auswahlmodus eines offenen Dashboards (Kanten fuer Rundung/Fase, Flaechen fuer Schale)
  if (App.dashPick) { const r = hitTest(ev, App.dashPick.kinds, App.dashPick.filter); if (r) App.dashPick.onPick(r, ev); return; }
  // normale Auswahl
  const r = hitTest(ev, isAsm() ? ['face', 'plane', 'axis'] : ['sketch', 'face', 'plane', 'axis', 'edge']);
  if ((ev.ctrlKey || ev.metaKey) && r) {
    // Mehrfachauswahl: Strg+Klick fuegt hinzu bzw. entfernt (z. B. mehrere Kanten fuer eine Rundung)
    const k = selKey(r); const i = App.sel.findIndex(x => selKey(x) === k);
    if (i >= 0) App.sel.splice(i, 1); else App.sel.push(r);
  } else App.sel = r ? [r] : [];
  drawSel();
  if (App.sel.length > 1) { status(`${App.sel.length} Elemente gewählt (Strg+Klick fügt hinzu/entfernt)`, 'info', 5000); return; }
  if (r?.ref) highlightTree(r.ref); else if (r?.compId) highlightTree(r.compId); else highlightTree(null);
  if (r) status(`Gewählt: ${r.name}${r.compId ? ' (' + (doc().data.components.find(c => c.id === r.compId)?.name || '') + ')' : ''}`, 'info', 4000);
}
function onViewDbl(ev) {
  const r = hitTest(ev, ['sketch', 'plane', 'axis']);
  const d = doc();
  if (r && isPart(d)) { const f = d.data.features.find(x => x.id === r.ref); if (f) editFeature(f); }
}
function onViewContext(ev) {
  if (App.picking) { clearPick(App.picking.multi ? [] : null); return; }
  const d = doc(); const r = App.sel[0];
  const items = [
    { label: 'Neu einpassen', icon: 'fit', action: () => App.viewer.fit(d?.res?.bbox) },
    { label: 'Standardausrichtung', icon: 'view', key: 'Strg+D', action: () => App.viewer.setView('standard', d?.res?.bbox) },
  ];
  if (isPart(d) && r && (r.kind === 'plane' || r.kind === 'face')) {
    items.push('-', { label: 'Extrudieren auf dieser Ebene', icon: 'extrude', action: () => featExtrude() }, { label: 'Drehen auf dieser Ebene', icon: 'revolve', action: () => featRevolve() }, { label: 'Bohrung hier', icon: 'hole', action: () => featHole() });
  }
  if (isAsm(d) && r?.compId) {
    const c = d.data.components.find(x => x.id === r.compId);
    items.push('-', { label: `${c.name} öffnen`, icon: 'open', action: () => openFile(c.file) }, { label: 'Platzierung bearbeiten', icon: 'constraint', action: () => placementDash(c) });
  }
  contextMenu(ev.clientX, ev.clientY, items);
}

// =====================================================================================
// Skizze
// =====================================================================================
function sketchFrame(planeRefVal) {
  const d = doc();
  return planeRef(d.res, planeRefVal);
}
function editSketch(sk, title = 'Skizze') {
  return new Promise((resolve) => {
    const d = doc(); let frame;
    try { frame = sketchFrame(sk.plane); } catch (e) { toast(e.message, 'err'); resolve(false); return; }
    const params = evalParams(d.data.params);
    $('#side').hidden = false;
    App.sketchTitle = title;
    const planeName = typeof sk.plane === 'string' ? (d.res.planes.get(sk.plane)?.name || sk.plane) : 'Gewählte Fläche';
    App.annotG?.clear(); App.viewer.clearLabels('annot');
    App.sketcher = new Sketcher({ viewer: App.viewer, frame, entities: sk.entities, params, refsEdges: d.res.edges, panel: $('#side'), status: (m) => status(m, 'info'),
      ask: (t, l, v) => promptDialog(t, l, v), dims: sk.dims, planeName: `${planeName}  ·  ${title}` });
    App.sketchDone = (ok) => {
      if (ok) { sk.entities = App.sketcher.entities.map(e => ({ ...e })); sk.dims = App.sketcher.dims.map(x => ({ ...x })); }
      App.sketcher.dispose(); App.sketcher = null; $('#side').hidden = true; App.tab = 'model'; renderRibbon();
      // wie Creo: nach der Skizze zurueck in die vorherige 3D-Ausrichtung (aus Skizzenansicht -> Standard)
      const c0 = App._camBeforeSketch; const fromTop = c0 && Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(c0.q).dot(frame.n)) > 0.999;
      if (c0 && !fromTop) restoreCam(c0); else App.viewer.setView('standard', d.res.bbox.isEmpty() ? null : d.res.bbox, true);
      resolve(ok);
    };
    App.sel = []; clearSelHl(); App._camBeforeSketch = saveCam();
    App.tab = 'sketch'; renderRibbon();
    App.viewer.orient(frame.n.clone(), frame.y.clone(), d.res.bbox.isEmpty() ? null : d.res.bbox, true);
    App.sketcher.setTool(sk.entities?.length ? 'select' : 'line');
  });
}

// =====================================================================================
// Feature-Ablaeufe (Dashboards)
// =====================================================================================
function closeDash() { if (App.dash) { App.dash.close(); App.dash = null; endFeatureUI(doc()); } }

/** Ende eines Feature-Dashboards: Vorschau-Ueberlagerung, Auswahlmodus und Modellmasse entfernen */
function endFeatureUI(d) {
  App.dashPick = null; App.dashPreview = null;
  App.previewG?.clear(); App.selHl?.clear(); if (d) setBodyGhost(d, false);
  clearFeatureDims(); App.viewer?.request();
}
/** Originalkoerper unsichtbar zeichnen, aber waehlbar lassen (Vorschau liegt darueber) */
function setBodyGhost(d, on) {
  d.group.traverse(o => { if ((o.userData.role === 'body' || o.userData.role === 'edges') && o.material) o.material.visible = !on; });
}
function showOverlay(d, res) {
  App.previewG.clear();
  const body = buildBody(res, d.data.color); applyDisplayStyle(body, App.display.style); App.previewG.add(body);
  setBodyGhost(d, true); App.viewer.request();
}

// ---------------------------------------------------------------- Masse am Modell waehrend der Bearbeitung
function clearFeatureDims() { App.fdimG?.clear(); App.viewer?.clearLabels('fdim'); }
/** Anklickbares Mass im 3D: Eingabefeld direkt am Mass */
function dimLabel3D(pos, text, onEdit, start, unit = 'mm') {
  const l = App.viewer.addLabel(text, pos, onEdit ? 'dim dim3d' : 'dim dim3d ro', 'fdim');
  if (!onEdit) return l;
  l.el.title = 'Klicken zum Ändern';
  l.el.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation(); if (l.el.querySelector('input')) return;
    const inp = el('input', { class: 'dim-edit', value: start ?? '' });
    l.el.replaceChildren(inp, unit ? el('span', { class: 'dim-unit' }, unit) : ''); setTimeout(() => { inp.focus(); inp.select(); }, 0);
    let fin = false;
    const done = async (ok) => {
      if (fin) return; fin = true;
      if (ok) { try { await onEdit(parseDimInput(inp.value, evalParams(doc().data.params))); } catch (e) { toast(e.message, 'err'); } }
      l.el.textContent = text;
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('blur', () => done(true), { once: true });
  });
  return l;
}
function arrow3D(from, to, color = 0xffe066) {
  const dir = to.clone().sub(from); const len = dir.length(); if (len < 1e-9) return;
  const head = Math.min(len * 0.25, App.viewer.pxToWorld(14));
  const a = new THREE.ArrowHelper(dir.normalize(), from, len, color, head, head * 0.45);
  a.traverse(o => { if (o.material) { o.material.depthTest = false; o.renderOrder = 28; } });
  App.fdimG.add(a);
  const b = new THREE.ArrowHelper(dir.clone().negate(), to, len, color, head, head * 0.45);
  b.traverse(o => { if (o.material) { o.material.depthTest = false; o.renderOrder = 28; } }); b.line.visible = false;
  App.fdimG.add(b);
}
/** Masse des bearbeiteten Features einblenden (Tiefe, Winkel, Ø, R, Abstaende, Skizzenmasse) – alle anklickbar */
function renderFeatureDims(feat, res) {
  clearFeatureDims(); if (!App.dash || !res) return;
  const vals = App.dash.vals; const P = res.params || {};
  const X = (v, def = 0) => { try { return evalExpr(v, P); } catch { return def; } };
  const chg = (key) => async (v) => { App.dash.change(key, v); };
  const start = (key) => (vals[key] === undefined ? '' : String(vals[key]));
  const pad = App.viewer.pxToWorld(16);
  const t = feat.type;
  // Skizzenmasse von Extrudieren/Drehen
  if (t === 'extrude' || t === 'revolve') {
    let frame, ents, entsSrc, refId = vals.skref || feat.params.sketch?.ref;
    try {
      if (refId) { const s = res.sketches.get(refId); if (!s) return; frame = s.frame; entsSrc = s.entities; }
      else { frame = planeRef(res, vals.plane ?? feat.params.sketch.plane); entsSrc = feat.params.sketch.entities || []; }
      ents = G.resolveEntities(entsSrc, P);
    } catch { return; }
    ents.forEach((e, i) => {
      for (const dm of entityDims({ ...entsSrc[i] }, e, pad, P)) {
        dimLabel3D(frame.to3(dm.x, dm.y), dm.text, async (v) => {
          if (refId) {
            const f = doc().data.features.find(x => x.id === refId); if (!f) return;
            const ff = clone(f); const tgt = ff.params.entities[i];
            const tmp = entityDims(tgt, G.resolveEntities(ff.params.entities, P)[i], pad, P, (ox, oy, nx, ny, ex) => moveCoincident(ff.params.entities, ox, oy, nx, ny, ex));
            tmp.find(z => z.text === dm.text)?.apply(v);
            await commit((data) => { data.features[data.features.findIndex(x => x.id === refId)] = ff; });
          } else {
            const tgt = entsSrc[i];
            const tmp = entityDims(tgt, e, pad, P, (ox, oy, nx, ny, ex) => moveCoincident(entsSrc, ox, oy, nx, ny, ex));
            tmp.find(z => z.text === dm.text)?.apply(v);
          }
          App.dashPreview?.();
        }, dm.start);
      }
    });
    const loops = G.sketchLoops(ents).loops.flat();
    const c2 = loops.length ? loops.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 }) : { x: 0, y: 0 };
    if (loops.length) { c2.x /= loops.length; c2.y /= loops.length; }
    const p0 = frame.to3(c2.x, c2.y);
    if (t === 'extrude') {
      const n = frame.n.clone().multiplyScalar(vals.flip ? -1 : 1);
      if (vals.through) { dimLabel3D(p0.clone().addScaledVector(n, res.bbox.getSize(new THREE.Vector3()).length() * 0.3), 'Durch alles'); }
      else {
        const dd = X(vals.depth); let w0 = 0, w1 = dd;
        if (vals.side === 'sym') { w0 = -dd / 2; w1 = dd / 2; } else if (vals.side === 'two') w0 = -X(vals.depth2, dd);
        const a = p0.clone().addScaledVector(n, w0), b = p0.clone().addScaledVector(n, w1);
        if (vals.side === 'two') {
          arrow3D(p0, b); arrow3D(p0, a);
          dimLabel3D(p0.clone().addScaledVector(n, w1 / 2).addScaledVector(frame.x, pad), MM(dd), chg('depth'), start('depth'));
          dimLabel3D(p0.clone().addScaledVector(n, w0 / 2).addScaledVector(frame.x, pad), MM(-w0), chg('depth2'), start('depth2'));
        } else {
          arrow3D(a, b);
          dimLabel3D(a.clone().lerp(b, 0.5).addScaledVector(frame.x, pad), MM(dd), chg('depth'), start('depth'));
        }
      }
    } else {
      dimLabel3D(p0.clone().addScaledVector(frame.y, pad * 2), DEG(X(vals.angle, 360)), chg('angle'), start('angle'), '°');
    }
  } else if (t === 'hole') {
    let fr; try { fr = planeRef(res, vals.plane); } catch { return; }
    const u = X(vals.u), v = X(vals.v); const o = fr.to3(u, v);
    const dir = fr.n.clone().multiplyScalar(vals.flip ? 1 : -1); const r = X(vals.d) / 2;
    dimLabel3D(o.clone().addScaledVector(fr.x, r + pad), `Ø ${MM(X(vals.d))}`, chg('d'), start('d'));
    if (!vals.through) { const e = o.clone().addScaledVector(dir, X(vals.depth)); arrow3D(o.clone().addScaledVector(fr.x, -r - pad * 0.5), e.clone().addScaledVector(fr.x, -r - pad * 0.5)); dimLabel3D(o.clone().lerp(e, 0.5).addScaledVector(fr.x, -r - pad * 1.5), MM(X(vals.depth)), chg('depth'), start('depth')); }
    if (Math.abs(u) > 1e-9) { arrow3D(fr.o, fr.to3(u, 0)); dimLabel3D(fr.o.clone().lerp(fr.to3(u, 0), 0.5).addScaledVector(fr.y, -pad), MM(Math.abs(u)), chg('u'), start('u')); }
    if (Math.abs(v) > 1e-9) { arrow3D(fr.to3(u, 0), o); dimLabel3D(fr.to3(u, 0).lerp(o, 0.5).addScaledVector(fr.x, pad), MM(Math.abs(v)), chg('v'), start('v')); }
  } else if (t === 'round' || t === 'chamfer') {
    // ein Mass genuegt (gilt fuer alle gewaehlten Kanten) – an der zuletzt gewaehlten Kante
    const e = feat.params.edges[feat.params.edges.length - 1];
    if (e) {
      const m = e.mid || e.a.map((q, k) => (q + e.b[k]) / 2); const n = feat.params.edges.length;
      dimLabel3D(new THREE.Vector3(...m), `${t === 'round' ? 'R ' : ''}${MM(X(vals.size))}${n > 1 ? `  (${n} Kanten)` : ''}`, chg('size'), start('size'));
    }
  } else if (t === 'shell') {
    const f0 = feat.params.faces[0]; if (f0) dimLabel3D(new THREE.Vector3(...(f0.point || f0)), `Wand ${MM(X(vals.thickness))}`, chg('thickness'), start('thickness'));
  } else if (t === 'pattern') {
    const tools = res.tools?.get(vals.ref); if (!tools?.length) return;
    const bb = new THREE.Box3(); for (const tt of tools) { tt.geom.computeBoundingBox(); bb.union(tt.geom.boundingBox); }
    const c = bb.getCenter(new THREE.Vector3()); const up = new THREE.Vector3(0, 1, 0).applyQuaternion(App.viewer.camera.quaternion).multiplyScalar(pad * 1.6);
    dimLabel3D(c.clone().add(up), `${Math.round(X(vals.count, 1))} ×`, chg('count'), start('count'), '');
    if (vals.kind === 'axial') dimLabel3D(c.clone().sub(up), DEG(X(vals.angle)), chg('angle'), start('angle'), '°');
    else dimLabel3D(c.clone().sub(up), MM(X(vals.spacing)), chg('spacing'), start('spacing'));
  } else if (t === 'datumPlane') {
    const pl = res.planes.get(feat.id); if (!pl) return;
    let ref; try { ref = planeRef(res, vals.ref); } catch { ref = null; }
    const c = pl.frame.o.clone();
    if (ref) arrow3D(ref.o.clone(), c);
    dimLabel3D(c.clone().addScaledVector(pl.frame.x, pad), MM(X(vals.offset)), chg('offset'), start('offset'));
    if (X(vals.angle)) dimLabel3D(c.clone().addScaledVector(pl.frame.y, pad * 2), DEG(X(vals.angle)), chg('angle'), start('angle'), '°');
  }
  App.viewer.request();
}

function planeOptions(vals, key) {
  const d = doc(); const out = [];
  for (const [id, p] of d.res.planes) out.push([id, p.name]);
  if (vals[key] && typeof vals[key] === 'object') out.unshift(['__obj', 'Gewählte Fläche']);
  out.push(['__pick', 'In der Grafik wählen…']);
  return out;
}
function axisOptions(withPlanes = true) {
  const d = doc(); const out = [['X', 'X-Achse (PRT_CSYS_DEF)'], ['Y', 'Y-Achse (PRT_CSYS_DEF)'], ['Z', 'Z-Achse (PRT_CSYS_DEF)']];
  for (const [id, a] of d.res.axes) out.push([id, a.name]);
  if (withPlanes) for (const [id, p] of d.res.planes) out.push([id, `Normale von ${p.name}`]);
  return out;
}
const refVal = (v) => (v && typeof v === 'object') ? '__obj' : v;

/** generischer Dashboard-Lauf mit Live-Vorschau */
function runFeature({ feat, replaceId, title, fields, apply, after, overlay = false, pickKinds = null, onPick = null, pickFilter = null }) {
  const d = doc(); closeDash();
  const preview = debounce(async () => {
    if (!App.dash) return;
    try { apply(App.dash.vals, feat); } catch (e) { App.dash.error(e.message); if (overlay) { App.previewG.clear(); setBodyGhost(d, false); clearFeatureDims(); App.viewer.request(); } return; }
    const seq = (App._pseq = (App._pseq || 0) + 1);
    const res = await regenerate(d.data, { extra: feat, replaceId, preview: true });
    if (seq !== App._pseq || !App.dash) return; // veraltete Vorschau verwerfen
    if (overlay) showOverlay(d, res); else showResult(d, res);
    App._preview = res;
    const err = res.errors.find(x => x.id === feat.id); App.dash?.error(err ? err.msg : '');
    renderFeatureDims(feat, res);
  }, 160);
  App.dash = dashboard({
    title, iconName: FEATURE_INFO[feat.type].icon, fields: fields.map(f => ({ ...f, value: f.value })),
    onChange: async (vals, key) => {
      const f = fields.find(x => x.key === key);
      if (f?.ref && vals[key] === '__pick') {
        const r = await pick({ kinds: f.ref, prompt: f.prompt || 'Referenz wählen' });
        if (r) { vals[key] = r.kind === 'face' ? r.plane : r.ref; f.onPicked?.(r, vals); } else vals[key] = f._last;
        App.dash.render();
      } else if (f?.ref && vals[key] === '__obj') { /* unveraendert */ }
      if (f) f._last = vals[key];
      if (f?.after) { await f.after(vals); App.dash.render(); }
      preview();
    },
    onOk: async (vals) => {
      apply(vals, feat);
      const res = await regenerate(d.data, { extra: feat, replaceId });
      const err = res.errors.find(x => x.id === feat.id);
      if (err) { App.dash.error(err.msg); return false; }
      endFeatureUI(d);
      await commit((data) => {
        if (replaceId) { const i = data.features.findIndex(x => x.id === replaceId); data.features[i] = feat; }
        else insertFeature(data, feat);
      });
      App.dash = null; after?.();
      return true;
    },
    onCancel: () => { App.dash = null; endFeatureUI(d); clearSelHl(); rebuild(d); },
  });
  for (const f of fields) f._last = f.value;
  App.dashPreview = preview;
  if (onPick) App.dashPick = { kinds: pickKinds, onPick, filter: pickFilter };
  preview();
  return App.dash;
}

function selectedPlaneRef() {
  const r = App.sel[0]; if (!r) return null;
  if (r.kind === 'plane') return r.ref; if (r.kind === 'face' && !r.compId) return r.plane; return null;
}
/** Vorhandene Skizze (Verweis) oder Skizzierebene fuer Extrudieren/Drehen */
function selectedSketchRef() {
  const r = App.sel[0]; if (r?.kind === 'sketch') return r.ref;
  const f = doc()?.data.features.find(x => x.id === App.treeSel); return f?.type === 'sketch' ? f.id : null;
}
async function askSketchSource() {
  const sr = selectedSketchRef(); if (sr) return { ref: sr };
  const pre = selectedPlaneRef(); if (pre) return { plane: pre };
  const r = await pick({ kinds: ['sketch', 'plane', 'face'], prompt: 'Vorhandene Skizze oder Skizzierebene (Bezugsebene / ebene Fläche) wählen' });
  if (!r) return null;
  if (r.kind === 'sketch') return { ref: r.ref };
  return { plane: r.kind === 'face' ? r.plane : r.ref };
}
/** Skizzen-Features vor der Einfuegemarke (fuer Auswahllisten) */
function sketchOptions(excludeId) {
  const d = doc(); const ins = d.data.insertAt ?? d.data.features.length;
  return d.data.features.filter((f, i) => f.type === 'sketch' && f.id !== excludeId && (i < ins || d.data.insertAt == null)).map(f => [f.id, f.name]);
}
async function editSketchFeature(id) {
  const f = doc().data.features.find(x => x.id === id); if (!f) { toast('Skizze nicht gefunden', 'err'); return false; }
  const ff = clone(f);
  if (await editSketch(ff.params, ff.name)) { await commit((data) => { data.features[data.features.findIndex(x => x.id === id)] = ff; }); return true; }
  await rebuild(); return false;
}
async function featSketch(existing) {
  if (!isPart()) return;
  if (existing) { await editSketchFeature(existing.id); return; }
  const pl = selectedPlaneRef() || await (async () => { const r = await pick({ kinds: ['plane', 'face'], prompt: 'Skizzierebene wählen: Bezugsebene oder ebene Fläche' }); return r ? (r.kind === 'face' ? r.plane : r.ref) : null; })();
  if (!pl) return;
  const feat = makeFeature(doc().data, 'sketch', { plane: pl, entities: [] });
  if (await editSketch(feat.params, feat.name)) {
    if (!feat.params.entities.length) { toast('Leere Skizze – nicht angelegt', 'warn'); await rebuild(); return; }
    await commit((data) => insertFeature(data, feat));
    App.treeSel = feat.id; App.sel = [{ kind: 'sketch', ref: feat.id, name: feat.name }]; highlightTree(feat.id);
    status(`${feat.name} angelegt – jetzt z. B. Extrudieren oder Drehen wählen, die Skizze ist schon ausgewählt`, 'ok', 8000);
  } else await rebuild();
}

async function askSketchPlane() {
  const pre = selectedPlaneRef(); if (pre) return pre;
  const r = await pick({ kinds: ['plane', 'face'], prompt: 'Skizzierebene wählen: Bezugsebene oder ebene Fläche' });
  if (!r) return null; return r.kind === 'face' ? r.plane : r.ref;
}

async function featExtrude(existing) {
  if (!isPart()) return;
  const feat = existing ? clone(existing) : makeFeature(doc().data, 'extrude', { sketch: { plane: null, entities: [] }, depth: 20, side: 'one', op: 'add', flip: false, through: false });
  if (!existing) {
    const src = await askSketchSource(); if (!src) return;
    if (src.ref) feat.params.sketch = { ref: src.ref, plane: null, entities: [] };
    else {
      feat.params.sketch.plane = src.plane;
      if (!(await editSketch(feat.params.sketch, feat.name))) { rebuild(); return; }
    }
  }
  openExtrudeDash(feat, existing);
}

async function featRevolve(existing) {
  if (!isPart()) return;
  const feat = existing ? clone(existing) : makeFeature(doc().data, 'revolve', { sketch: { plane: null, entities: [] }, angle: 360, axis: 'centerline', op: 'add', flip: false });
  if (!existing) {
    const src = await askSketchSource(); if (!src) return;
    if (src.ref) feat.params.sketch = { ref: src.ref, plane: null, entities: [] };
    else {
      feat.params.sketch.plane = src.plane;
      status('Mittellinie als Rotationsachse zeichnen, dann die Kontur auf einer Seite davon', 'info');
      feat.params.sketch.entities = [{ type: 'centerline', x1: 0, y1: 0, x2: 0, y2: 10 }];
      if (!(await editSketch(feat.params.sketch, feat.name))) { rebuild(); return; }
    }
  }
  openRevolveDash(feat, existing);
}
function openRevolveDash(feat, existing) {
  const p = feat.params;
  runFeature({
    feat, replaceId: existing?.id, title: feat.name,
    fields: [
      { key: 'angle', label: 'Winkel [°]', type: 'expr', value: p.angle ?? 360 },
      { key: 'axis', label: 'Achse', type: 'select', value: p.axis || 'centerline', options: [['centerline', 'Mittellinie der Skizze'], ['H', 'Horizontale Skizzenreferenz'], ['V', 'Vertikale Skizzenreferenz']] },
      { key: 'flip', label: 'Richtung umkehren', type: 'check', value: !!p.flip },
      { key: 'op', label: 'Material', type: 'select', value: p.op || 'add', options: [['add', 'Hinzufügen'], ['cut', 'Entfernen']] },
      { key: 'skref', label: 'Skizze', type: 'select', value: p.sketch.ref || '', rerender: true, options: () => [['', 'Eigene Skizze im Feature'], ...sketchOptions()] },
      { key: 'plane', label: 'Skizzierebene', type: 'select', ref: ['plane', 'face'], value: p.sketch.plane, options: (v) => planeOptions(v, 'plane'), show: (v) => !v.skref },
      { type: 'button', label: 'Skizze bearbeiten', icon: 'sketch', onClick: async (vals) => {
        closeDash(); Object.assign(feat.params, { angle: vals.angle, axis: vals.axis, flip: vals.flip, op: vals.op }); feat.params.sketch = sketchParam(feat.params.sketch, vals);
        if (feat.params.sketch.ref) await editSketchFeature(feat.params.sketch.ref); else { await rebuild(); await editSketch(feat.params.sketch, feat.name); }
        openRevolveDash(feat, existing);
      } },
    ],
    apply: (v, f) => Object.assign(f.params, { angle: v.angle, axis: v.axis, flip: v.flip, op: v.op, sketch: sketchParam(f.params.sketch, v) }),
  });
}
/** Skizzen-Parameter aus Dashboard-Werten: Verweis auf Skizzen-Feature oder eigene Skizze */
function sketchParam(sk, v) {
  const out = { plane: sk.plane ?? null, entities: sk.entities || [] };
  if (v.skref) out.ref = v.skref; else if (v.plane !== undefined) out.plane = v.plane;
  return out;
}
/** Creo-Verhalten: Schnittrichtung so waehlen, dass Material entfernt wird */
async function cutDirection(feat, v) {
  const d = doc(); if (!d.res.display) return !!v.flip;
  const vol = async (flip) => { const t = clone(feat); Object.assign(t.params, { side: v.side, depth: v.depth, depth2: v.depth2, through: v.through, op: 'cut', flip }); t.params.sketch = sketchParam(t.params.sketch, { skref: v.skref ?? t.params.sketch.ref, plane: v.plane });
    const r = await regenerate(d.data, { extra: t, preview: true, replaceId: d.data.features.some(x => x.id === feat.id) ? feat.id : undefined });
    if (r.errors.some(e => e.id === feat.id)) return Infinity;
    return r.props?.volume ?? (r.display ? G.signedVolume(r.display) : 0); };
  try { const [a, b] = [await vol(true), await vol(false)]; return a < b - 1e-6; } catch { return !!v.flip; }
}
async function openExtrudeDash(feat, existing) {
  const p = feat.params;
  // Neues Feature auf vorhandenem Koerper: Richtung vorschlagen (ins Material bei Entfernen)
  if (!existing && d0().res.display && p.op === 'cut' && p._dirAuto === undefined) { p._dirAuto = true; p.flip = await cutDirection(feat, { ...p, plane: p.sketch.plane, skref: p.sketch.ref }); }
  runFeature({
    feat, replaceId: existing?.id, title: feat.name,
    fields: [
      { key: 'side', label: 'Tiefe', type: 'select', value: p.side || 'one', options: [['one', 'Eine Seite'], ['sym', 'Symmetrisch'], ['two', 'Beide Seiten']], rerender: true },
      { key: 'depth', label: 'Wert', type: 'expr', value: p.depth, show: (v) => !v.through },
      { key: 'depth2', label: 'Seite 2', type: 'expr', value: p.depth2 ?? p.depth, show: (v) => v.side === 'two' && !v.through },
      { key: 'through', label: 'Durch alles', type: 'check', value: !!p.through, rerender: true },
      { key: 'flip', label: 'Richtung umkehren', type: 'check', value: !!p.flip },
      { key: 'op', label: 'Material', type: 'select', value: p.op || 'add', options: [['add', 'Hinzufügen'], ['cut', 'Entfernen']], after: async (v) => { if (v.op === 'cut') v.flip = await cutDirection(feat, v); } },
      { key: 'skref', label: 'Skizze', type: 'select', value: p.sketch.ref || '', rerender: true, options: () => [['', 'Eigene Skizze im Feature'], ...sketchOptions()] },
      { key: 'plane', label: 'Skizzierebene', type: 'select', ref: ['plane', 'face'], value: p.sketch.plane, options: (v) => planeOptions(v, 'plane'), show: (v) => !v.skref },
      { type: 'button', label: 'Skizze bearbeiten', icon: 'sketch', onClick: async (vals) => {
        closeDash(); Object.assign(feat.params, { side: vals.side, depth: vals.depth, depth2: vals.depth2, through: vals.through, flip: vals.flip, op: vals.op }); feat.params.sketch = sketchParam(feat.params.sketch, vals);
        if (feat.params.sketch.ref) await editSketchFeature(feat.params.sketch.ref); else { await rebuild(); await editSketch(feat.params.sketch, feat.name); }
        openExtrudeDash(feat, existing);
      } },
    ],
    apply: (v, f) => Object.assign(f.params, { side: v.side, depth: v.depth, depth2: v.depth2, through: v.through, flip: v.flip, op: v.op, sketch: sketchParam(f.params.sketch, v) }),
  });
}

async function featHole(existing) {
  if (!isPart()) return;
  const d = doc(); if (!existing && !d.res.body) { toast('Bohrung benötigt einen vorhandenen Körper', 'warn'); return; }
  const feat = existing ? clone(existing) : makeFeature(d.data, 'hole', { plane: null, u: 0, v: 0, d: 8, depth: 20, through: true, flip: false, sink: 'none', cboreD: 14, cboreDepth: 8, csinkD: 16, tip: true });
  if (!existing) {
    const pre = App.sel[0]; let r = pre && (pre.kind === 'face' || pre.kind === 'plane') && !pre.compId ? pre : null;
    if (!r) r = await pick({ kinds: ['face', 'plane'], prompt: 'Platzierung der Bohrung: Punkt auf einer Fläche anklicken (oder Bezugsebene)' });
    if (!r) return;
    feat.params.plane = r.kind === 'face' ? r.plane : r.ref;
  }
  const p = feat.params;
  runFeature({
    feat, replaceId: existing?.id, title: feat.name,
    fields: [
      { key: 'd', label: 'Ø', type: 'expr', value: p.d },
      { key: 'through', label: 'Durch alles', type: 'check', value: !!p.through, rerender: true },
      { key: 'depth', label: 'Tiefe', type: 'expr', value: p.depth, show: (v) => !v.through },
      { key: 'tip', label: 'Bohrerspitze 118°', type: 'check', value: p.tip !== false, show: (v) => !v.through },
      { key: 'sink', label: 'Senkung', type: 'select', value: p.cbore ? 'cbore' : p.csink ? 'csink' : 'none', options: [['none', 'keine'], ['cbore', 'Zylindrisch'], ['csink', 'Kegelig 90°']], rerender: true },
      { key: 'cboreD', label: 'Senk-Ø', type: 'expr', value: p.cboreD ?? 14, show: (v) => v.sink === 'cbore' },
      { key: 'cboreDepth', label: 'Senktiefe', type: 'expr', value: p.cboreDepth ?? 8, show: (v) => v.sink === 'cbore' },
      { key: 'csinkD', label: 'Senk-Ø', type: 'expr', value: p.csinkD ?? 16, show: (v) => v.sink === 'csink' },
      { key: 'plane', label: 'Platzierung', type: 'select', ref: ['face', 'plane'], value: p.plane, options: (v) => planeOptions(v, 'plane'), onPicked: (r, v) => { v.u = 0; v.v = 0; } },
      { key: 'u', label: 'Versatz 1', type: 'expr', value: p.u ?? 0, width: '60px' },
      { key: 'v', label: 'Versatz 2', type: 'expr', value: p.v ?? 0, width: '60px' },
      { key: 'flip', label: 'Richtung umkehren', type: 'check', value: !!p.flip },
    ],
    apply: (v, f) => Object.assign(f.params, { d: v.d, through: v.through, depth: v.depth, tip: v.tip, cbore: v.sink === 'cbore', csink: v.sink === 'csink', cboreD: v.cboreD, cboreDepth: v.cboreDepth, csinkD: v.csinkD, plane: v.plane, u: v.u, v: v.v, flip: v.flip }),
  });
}

async function featEdge(type, existing) {
  if (!isPart()) return;
  const d = doc(); if (!d.res.body) { toast('Kein Körper vorhanden', 'warn'); return; }
  const feat = existing ? clone(existing) : makeFeature(d.data, type, { size: type === 'round' ? 3 : 1, edges: [] });
  const edgeData = (r) => { if (KERNEL.available) { if (!r.edgeRef) throw new Error('Kante gehört nicht zum B-Rep-Körper (importierte Geometrie?)'); return r.edgeRef; } return G.edgeInfo(r.mesh, r.a, r.b); };
  const midOf = (e) => e.mid || e.a.map((v, i) => (v + e.b[i]) / 2);
  const findIdx = (info) => { const mi = midOf(info); return feat.params.edges.findIndex(e => Math.hypot(...midOf(e).map((x, i) => x - mi[i])) < 1e-3); };
  const showSel = () => {
    App.selHl.clear();
    for (const e of feat.params.edges) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints((e.poly || [e.a, e.b]).map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false })); l.renderOrder = 30; App.selHl.add(l); }
    App.viewer.request();
  };
  // vorausgewaehlte Kanten (auch mehrere per Strg+Klick)
  if (!existing) for (const r of App.sel.filter(x => x.kind === 'edge')) { try { if (findIdx(edgeData(r)) < 0) feat.params.edges.push(edgeData(r)); } catch (e) { toast(e.message, 'warn'); } }
  App.sel = []; clearSelHl();
  let chain = true; // wie Creo: tangentiale Kanten werden standardmaessig mitgewaehlt
  const onPick = (r) => {
    try {
      const list = [r];
      if (chain && r.edgeIndex >= 0 && r.polys) for (const ei of tangentChain(r.polys, r.edgeIndex)) if (ei !== r.edgeIndex) list.push({ ...r, edgeRef: edgeRefFromPoly(r.polys[ei]), edgePoly: r.polys[ei], edgeIndex: ei });
      const first = findIdx(edgeData(r));
      if (first >= 0) { for (const x of list) { const k = findIdx(edgeData(x)); if (k >= 0) feat.params.edges.splice(k, 1); } }
      else for (const x of list) { const info = edgeData(x); if (findIdx(info) < 0) feat.params.edges.push(info); }
      showSel(); App.dash?.render(); App.dashPreview?.();
      status(`${feat.params.edges.length} Kante(n) gewählt – weitere Kanten anklicken (erneut = abwählen)`, 'pick');
    } catch (e) { toast(e.message, 'warn'); }
  };
  runFeature({
    feat, replaceId: existing?.id, title: feat.name, overlay: true, pickKinds: ['edge'], onPick,
    fields: [
      { key: 'size', label: type === 'round' ? 'Radius' : 'Abstand D', type: 'expr', value: feat.params.size },
      { type: 'info', value: () => `${feat.params.edges.length} Kante(n)` },
      { key: 'chain', label: 'Tangentenkette', type: 'check', value: true },
      { type: 'button', label: 'Auswahl leeren', icon: 'select', onClick: () => { feat.params.edges.length = 0; showSel(); App.dash?.render(); App.dashPreview?.(); } },
      { type: 'info', value: KERNEL.available ? 'Kanten nacheinander anklicken – die Vorschau folgt sofort' : 'Nur gerade Kanten zwischen ebenen Flächen (interner Kern)' },
    ],
    apply: (v, f) => { f.params.size = v.size; chain = !!v.chain; if (!f.params.edges.length) throw new Error('Kanten im Modell anklicken'); },
  });
  showSel();
  status('Kanten anklicken (erneut = abwählen) – Vorschau erscheint sofort', 'pick');
}

/** Tangential anschliessende Kanten (gemeinsamer Endpunkt, gleiche Richtung) – Breitensuche */
function tangentChain(polys, start) {
  const ends = polys.map(pl => {
    const n = pl.length; const V = (p) => new THREE.Vector3(...p);
    return [{ p: V(pl[0]), t: V(pl[0]).sub(V(pl[1])).normalize() }, { p: V(pl[n - 1]), t: V(pl[n - 1]).sub(V(pl[n - 2])).normalize() }];
  });
  let L = 0; for (const e of ends) L = Math.max(L, e[0].p.length(), e[1].p.length()); const tol = Math.max(1e-4, L * 1e-6);
  const seen = new Set([start]); const q = [start];
  while (q.length) {
    const i = q.shift();
    for (const ea of ends[i]) for (let j = 0; j < ends.length; j++) {
      if (seen.has(j)) continue;
      for (const eb of ends[j]) if (ea.p.distanceTo(eb.p) < tol && -ea.t.dot(eb.t) > 0.985) { seen.add(j); q.push(j); break; }
    }
  }
  return [...seen];
}

function featureOptions(types = ['extrude', 'revolve', 'hole', 'round', 'chamfer', 'pattern', 'mirror']) {
  const d = doc(); return d.data.features.filter(f => types.includes(f.type) && d.res.tools?.has(f.id)).map(f => [f.id, f.name]);
}
async function featPattern(existing) {
  if (!isPart()) return;
  const d = doc(); const opts = featureOptions(['extrude', 'revolve', 'hole', 'round', 'chamfer']);
  if (!opts.length) { toast('Kein musterbares Feature vorhanden (Extrusion, Drehen, Bohrung, Rundung, Fase)', 'warn'); return; }
  const selF = App.treeSel && opts.find(o => o[0] === App.treeSel) ? App.treeSel : opts[opts.length - 1][0];
  const feat = existing ? clone(existing) : makeFeature(d.data, 'pattern', { ref: selF, kind: 'linear', dir: 'X', count: 3, spacing: 20, dir2: '', count2: 2, spacing2: 20, axis: 'Y', angle: 45 });
  const p = feat.params;
  runFeature({
    feat, replaceId: existing?.id, title: feat.name,
    fields: [
      { key: 'ref', label: 'Feature', type: 'select', value: p.ref, options: opts },
      { key: 'kind', label: 'Typ', type: 'select', value: p.kind, options: [['linear', 'Richtung'], ['axial', 'Achse']], rerender: true },
      { key: 'dir', label: 'Richtung 1', type: 'select', value: p.dir, options: () => axisOptions(), show: (v) => v.kind === 'linear' },
      { key: 'count', label: 'Anzahl', type: 'expr', value: p.count, width: '50px' },
      { key: 'spacing', label: 'Abstand', type: 'expr', value: p.spacing, show: (v) => v.kind === 'linear' },
      { key: 'dir2', label: 'Richtung 2', type: 'select', value: p.dir2 || '', options: () => [['', '—'], ...axisOptions()], show: (v) => v.kind === 'linear', rerender: true },
      { key: 'count2', label: 'Anzahl 2', type: 'expr', value: p.count2 ?? 2, width: '50px', show: (v) => v.kind === 'linear' && v.dir2 },
      { key: 'spacing2', label: 'Abstand 2', type: 'expr', value: p.spacing2 ?? 20, show: (v) => v.kind === 'linear' && v.dir2 },
      { key: 'axis', label: 'Achse', type: 'select', value: p.axis, options: () => axisOptions(false), show: (v) => v.kind === 'axial' },
      { key: 'angle', label: 'Winkelschritt [°]', type: 'expr', value: p.angle, show: (v) => v.kind === 'axial' },
    ],
    apply: (v, f) => Object.assign(f.params, { ref: v.ref, kind: v.kind, dir: v.dir, count: v.count, spacing: v.spacing, dir2: v.dir2 || null, count2: v.count2, spacing2: v.spacing2, axis: v.axis, angle: v.angle }),
  });
}
async function featShell(existing) {
  if (!isPart()) return;
  const d = doc(); if (!d.res.body) { toast('Kein Körper vorhanden', 'warn'); return; }
  if (!KERNEL.available) { toast('Schale benötigt den usd-brep-Kern (unter macOS nicht verfügbar)', 'warn'); return; }
  const feat = existing ? clone(existing) : makeFeature(d.data, 'shell', { thickness: 2, faces: [], outward: false });
  const sel = feat.params.faces.map(f => ({ point: f.point || f, normal: f.normal || null, hl: null }));
  const findIdx = (r) => sel.findIndex(f => new THREE.Vector3(...(f.normal || [0, 0, 0])).dot(r.normal) > 0.9999 && Math.abs(new THREE.Vector3(...f.point).sub(r.point).dot(r.normal)) < 1e-4);
  const showSel = () => { App.selHl.clear(); for (const f of sel) if (f.hl) App.selHl.add(highlightMesh(f.hl, 0xffb020, 0.45)); App.viewer.request(); };
  const add = (r) => { const k = findIdx(r); if (k >= 0) sel.splice(k, 1); else sel.push({ point: G.v3arr(r.point).map(v => +v.toFixed(6)), normal: G.v3arr(r.normal), hl: r.hlGeom }); };
  if (!existing) for (const r of App.sel.filter(x => x.kind === 'face' && !x.compId)) add(r);
  App.sel = []; clearSelHl();
  runFeature({
    feat, replaceId: existing?.id, title: feat.name, overlay: true, pickKinds: ['face'], pickFilter: (h) => !h.object.userData.compId,
    onPick: (r) => { add(r); showSel(); App.dash?.render(); App.dashPreview?.(); status(`${sel.length} Fläche(n) gewählt – weitere anklicken (erneut = abwählen)`, 'pick'); },
    fields: [
      { key: 'thickness', label: 'Wandstärke', type: 'expr', value: feat.params.thickness },
      { key: 'outward', label: 'Nach außen', type: 'check', value: !!feat.params.outward },
      { type: 'info', value: () => `${sel.length} Fläche(n) entfernt` },
      { type: 'button', label: 'Auswahl leeren', icon: 'select', onClick: () => { sel.length = 0; showSel(); App.dash?.render(); App.dashPreview?.(); } },
    ],
    apply: (v, f) => { f.params.thickness = v.thickness; f.params.outward = v.outward; f.params.faces = sel.map(x => ({ point: x.point, normal: x.normal })); },
  });
  showSel();
  status('Zu entfernende Flächen anklicken (erneut = abwählen)', 'pick');
}

async function featMirror(existing) {
  if (!isPart()) return;
  const d = doc(); if (!existing && !d.res.body) { toast('Kein Körper zum Spiegeln', 'warn'); return; }
  const feat = existing ? clone(existing) : makeFeature(d.data, 'mirror', { plane: selectedPlaneRef() || 'RIGHT', what: 'all', ref: featureOptions()[0]?.[0] || '' });
  const p = feat.params;
  runFeature({
    feat, replaceId: existing?.id, title: feat.name,
    fields: [
      { key: 'plane', label: 'Spiegelebene', type: 'select', ref: ['plane', 'face'], value: p.plane, options: (v) => planeOptions(v, 'plane') },
      { key: 'what', label: 'Spiegeln', type: 'select', value: p.what, options: [['all', 'Gesamte Geometrie'], ['feature', 'Einzelnes Feature']], rerender: true },
      { key: 'ref', label: 'Feature', type: 'select', value: p.ref, options: () => featureOptions(), show: (v) => v.what === 'feature' },
      { key: 'cross', label: 'Körper schneidet Ebene', type: 'select', value: p.cross || 'pos', show: (v) => v.what === 'all',
        options: [['pos', 'Seite in Normalenrichtung spiegeln'], ['neg', 'Gegenseite spiegeln'], ['union', 'Beide vereinigen (langsam)']] },
    ],
    apply: (v, f) => Object.assign(f.params, { plane: v.plane, what: v.what, ref: v.ref, cross: v.cross }),
  });
}
async function featDatumPlane(existing) {
  if (!isPart()) return;
  const d = doc();
  if (existing?.params.kind === 'fixed') { toast('Standard-Bezugsebenen sind fest', 'info'); return; }
  const feat = existing ? clone(existing) : makeFeature(d.data, 'datumPlane', { kind: 'offset', ref: selectedPlaneRef() || 'FRONT', offset: 20, angle: 0, flip: false });
  const p = feat.params;
  runFeature({
    feat, replaceId: existing?.id, title: `Bezugsebene ${feat.name}`,
    fields: [
      { key: 'ref', label: 'Referenz', type: 'select', ref: ['plane', 'face'], value: p.ref, options: (v) => planeOptions(v, 'ref') },
      { key: 'offset', label: 'Versatz', type: 'expr', value: p.offset },
      { key: 'angle', label: 'Drehwinkel [°]', type: 'expr', value: p.angle ?? 0 },
      { key: 'flip', label: 'Normale umkehren', type: 'check', value: !!p.flip },
    ],
    apply: (v, f) => Object.assign(f.params, { ref: v.ref, offset: v.offset, angle: v.angle, flip: v.flip }),
  });
}
async function featDatumAxis(existing) {
  if (!isPart()) return;
  const d = doc();
  const feat = existing ? clone(existing) : makeFeature(d.data, 'datumAxis', { kind: 'twoPlanes', ref1: 'FRONT', ref2: 'RIGHT', point: [0, 0, 0], dir: [0, 1, 0] });
  const p = feat.params; const po = () => [...d.res.planes].map(([id, x]) => [id, x.name]);
  runFeature({
    feat, replaceId: existing?.id, title: `Bezugsachse ${feat.name}`,
    fields: [
      { key: 'kind', label: 'Definition', type: 'select', value: p.kind, options: [['twoPlanes', 'Schnitt zweier Ebenen'], ['pointDir', 'Punkt + Richtung']], rerender: true },
      { key: 'ref1', label: 'Ebene 1', type: 'select', value: p.ref1, options: po, show: (v) => v.kind === 'twoPlanes' },
      { key: 'ref2', label: 'Ebene 2', type: 'select', value: p.ref2, options: po, show: (v) => v.kind === 'twoPlanes' },
      ...['X', 'Y', 'Z'].map((n, i) => ({ key: `p${i}`, label: `Punkt ${n}`, type: 'expr', width: '56px', value: p.point?.[i] ?? 0, show: (v) => v.kind === 'pointDir' })),
      ...['X', 'Y', 'Z'].map((n, i) => ({ key: `d${i}`, label: `Richt. ${n}`, type: 'expr', width: '56px', value: p.dir?.[i] ?? 0, show: (v) => v.kind === 'pointDir' })),
    ],
    apply: (v, f) => Object.assign(f.params, { kind: v.kind, ref1: v.ref1, ref2: v.ref2, point: [v.p0, v.p1, v.p2], dir: [v.d0, v.d1, v.d2] }),
  });
}
async function featDatumPoint(existing) {
  if (!isPart()) return;
  const d = doc();
  const feat = existing ? clone(existing) : makeFeature(d.data, 'datumPoint', { point: [0, 0, 0] });
  if (!existing && App.sel[0]?.kind === 'face' && !App.sel[0].compId) feat.params.point = App.sel[0].point.toArray().map(x => +x.toFixed(4));
  runFeature({
    feat, replaceId: existing?.id, title: `Bezugspunkt ${feat.name}`,
    fields: ['X', 'Y', 'Z'].map((n, i) => ({ key: `p${i}`, label: n, type: 'expr', width: '70px', value: feat.params.point[i] })),
    apply: (v, f) => { f.params.point = [v.p0, v.p1, v.p2]; },
  });
}

function editFeature(f) {
  const map = { extrude: () => openExtrudeDash(clone(f), f), revolve: () => openRevolveDash(clone(f), f), hole: () => featHole(f), round: () => featEdge('round', f), chamfer: () => featEdge('chamfer', f),
    pattern: () => featPattern(f), mirror: () => featMirror(f), shell: () => featShell(f), datumPlane: () => featDatumPlane(f), datumAxis: () => featDatumAxis(f), datumPoint: () => featDatumPoint(f),
    import: () => editImport(f), sketch: () => featSketch(f), csys: () => toast('Das Standard-Koordinatensystem ist fest', 'info') };
  map[f.type]?.();
}
function editImport(f) {
  const feat = clone(f); const p = feat.params;
  runFeature({ feat, replaceId: f.id, title: f.name, fields: [
    ...['X', 'Y', 'Z'].map((n, i) => ({ key: `o${i}`, label: `Versatz ${n}`, type: 'expr', width: '60px', value: p.offset?.[i] ?? 0 })),
    { key: 'scale', label: 'Maßstab', type: 'expr', value: p.scale ?? 1, width: '60px' },
    { key: 'merge', label: 'Verknüpfung', type: 'select', value: p.merge || 'concat', options: [['concat', 'Als eigene Hülle(n)'], ['union', 'Vereinigen (Boolesch)']] },
  ], apply: (v, ff) => Object.assign(ff.params, { offset: [v.o0, v.o1, v.o2], scale: v.scale, merge: v.merge }) });
}

// ---------------------------------------------------------------- Feature-Verwaltung
async function deleteFeature(f) {
  const d = doc(); const deps = dependents(d.data, f.id);
  if (['RIGHT', 'TOP', 'FRONT', 'PRT_CSYS_DEF'].includes(f.id) && !(await confirmDialog('Standard-Bezug löschen', `${f.name} ist ein Standard-Bezug. Wirklich löschen?`, 'Löschen', true))) return;
  const txt = deps.length ? `${f.name} und ${deps.length} abhängige(s) Feature(s) löschen? (${deps.map(x => x.name).join(', ')})` : `${f.name} löschen?`;
  if (!(await confirmDialog('Löschen', txt, 'Löschen', true))) return;
  await commit((data) => {
    const ids = new Set([f.id, ...deps.map(x => x.id)]);
    const before = data.features.filter((x, i) => ids.has(x.id) && data.insertAt !== null && i < data.insertAt).length;
    data.features = data.features.filter(x => !ids.has(x.id));
    if (data.insertAt !== null && data.insertAt !== undefined) data.insertAt = Math.max(0, data.insertAt - before);
    for (const l of data.layers) l.items = l.items.filter(i => !ids.has(i));
  });
}
async function renameFeature(f) {
  const n = await promptDialog('Umbenennen', 'Neuer Name', f.name); if (!n) return;
  await commit((data) => { data.features.find(x => x.id === f.id).name = n.trim(); });
}
async function toggleFlag(f, flag) { await commit((data) => { const x = data.features.find(y => y.id === f.id); x[flag] = !x[flag]; }); }
async function setInsert(idx) { await commit((data) => { data.insertAt = idx >= data.features.length ? null : idx; }); }

// =====================================================================================
// Baugruppe
// =====================================================================================
async function asmAssemble() {
  const d = doc(); if (!isAsm(d)) return;
  const path = await fileChooser({ title: 'Komponente einbauen', kinds: ['part', 'assembly'], okLabel: 'Einbauen' }); if (!path) return;
  if (path === d.path) { toast('Eine Baugruppe kann sich nicht selbst enthalten', 'err'); return; }
  let name = stem(path).toUpperCase(); let i = 2; while (d.data.components.some(c => c.name === name)) name = `${stem(path).toUpperCase()}_${i++}`;
  const comp = newComponent(path, name);
  // nicht ueberlappend neben die bisherige Baugruppe setzen, wenn schon etwas eingebaut ist
  await commit((data) => { data.components.push(comp); });
  placementDash(d.data.components.find(c => c.id === comp.id), true);
}
async function asmCreate() {
  const d = doc(); if (!isAsm(d)) return;
  if (!d.path) { toast('Baugruppe bitte zuerst speichern', 'warn'); return; }
  const n = await promptDialog('Komponente erzeugen', 'Name des neuen Parts', nextDefaultName('part')); if (!n) return;
  const data = newPart(n.trim()); const path = `${n.trim().toLowerCase()}.csprt`;
  if (App.files.some(f => f.path === path)) { toast(`${path} existiert bereits`, 'err'); return; }
  await writeFile(path, JSON.stringify(data)); await refreshFiles();
  await commit((a) => { a.components.push(newComponent(path, n.trim().toUpperCase())); });
  toast(`${path} angelegt und eingebaut. Zum Modellieren: Komponente im Baum › Öffnen.`, 'ok', 5000);
}
async function asmImport() {
  const d = doc(); if (!isAsm(d)) return;
  const path = await fileChooser({ title: 'STEP/STL als Komponenten importieren', kinds: ['step', 'iges', 'stl', 'creo', 'solidworks'], okLabel: 'Importieren' }); if (!path) return;
  await busy('Importiere Komponenten…', async () => {
    const meshes = await readForeign(path, App.files.find(f => f.path === path)?.kind || kindOf(path));
    const base = stem(path).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const comps = [];
    for (let i = 0; i < meshes.length; i++) {
      const nm = meshes.length > 1 ? `${base}_${String(i + 1).padStart(2, '0')}` : base;
      const pd = newPart(nm); pd.features.push(importFeature(pd, `Import ${meshes[i].name || nm}`, meshes[i].geom, path));
      if (meshes[i].color) pd.color = `#${new THREE.Color(...meshes[i].color).getHexString()}`;
      const fp = `${nm}.csprt`; await writeFile(fp, JSON.stringify(pd)); comps.push(newComponent(fp, (meshes[i].name || nm).toUpperCase().slice(0, 40)));
    }
    await refreshFiles();
    await commit((a) => { a.components.push(...comps); });
    App.viewer.fit(d.res.bbox);
    toast(`${comps.length} Komponente(n) als Parts im Arbeitsverzeichnis angelegt`, 'ok', 5000);
  });
}

function compEntry(id) { return doc().res.comps.find(e => e.comp.id === id); }
function placementDash(comp, isNew = false) {
  const d = doc(); closeDash(); detachDrag();
  const snapshot = JSON.stringify(d.data);
  const listInfo = () => comp.constraints.length ? comp.constraints.map((k, i) => `${i + 1}. ${CONSTRAINT_NAMES[k.type]}${k.offset ? ` (${k.offset})` : ''} → ${k.target.datum || d.data.components.find(c => c.id === k.target.compId)?.name || '?'}${k._warn ? ' ⚠ ' + k._warn : ''}`).join('  ·  ') : 'Keine Bedingungen (frei/fest)';
  const fresh = () => d.data.components.find(c => c.id === comp.id);
  const addC = async (type, vals) => {
    App.dash.close();
    const a = await pick({ kinds: ['face'], prompt: `${CONSTRAINT_NAMES[type]}: ebene Fläche auf ${comp.name} wählen`, filter: (h) => h.object.userData.compId === comp.id });
    if (!a) { placementDash(fresh()); return; }
    const b = await pick({ kinds: ['face', 'plane'], prompt: `${CONSTRAINT_NAMES[type]}: Referenzfläche (andere Komponente) oder Baugruppen-Bezugsebene wählen`, filter: (h) => h.object.userData.compId !== comp.id });
    if (!b) { placementDash(fresh()); return; }
    let target;
    if (b.kind === 'plane') target = { datum: b.ref };
    else { const e = compEntry(b.compId); const inv = e.matrix.clone().invert(); target = { compId: b.compId, point: G.v3arr(b.point.clone().applyMatrix4(inv)), normal: G.v3arr(b.normal.clone().transformDirection(inv).normalize()) }; }
    const e = compEntry(comp.id); const inv = e.matrix.clone().invert();
    const k = { type, offset: type === 'mate' ? 0 : (vals.offset || 0), comp: { point: G.v3arr(a.point.clone().applyMatrix4(inv)), normal: G.v3arr(a.normal.clone().transformDirection(inv).normalize()) }, target };
    await commit((data) => { data.components.find(c => c.id === comp.id).constraints.push(k); });
    placementDash(fresh());
  };
  App.dash = dashboard({
    title: `Platzierung: ${comp.name}`, iconName: 'constraint',
    fields: [
      { type: 'info', value: listInfo },
      { key: 'offset', label: 'Versatz', type: 'expr', value: 0, width: '60px' },
      { type: 'button', label: 'Koinzident', icon: 'constraint', onClick: (v) => addC('mate', v) },
      { type: 'button', label: 'Ausrichten', icon: 'constraint', onClick: (v) => addC('align', v) },
      { type: 'button', label: 'Abstand', icon: 'constraint', onClick: (v) => addC('distance', v) },
      { type: 'button', label: 'Letzte entfernen', onClick: async () => { await commit((data) => { data.components.find(c => c.id === comp.id).constraints.pop(); }); placementDash(fresh()); } },
      { type: 'button', label: 'Standard (Ursprung)', onClick: async () => { await commit((data) => { const c = data.components.find(x => x.id === comp.id); c.constraints = []; c.matrix = new THREE.Matrix4().toArray(); }); placementDash(fresh()); } },
      { type: 'button', label: 'Ziehen', icon: 'drag', onClick: () => attachDrag(comp.id) },
      { type: 'button', label: 'Verschieben…', icon: 'drag', onClick: () => moveDialog(comp) },
    ],
    onOk: () => { detachDrag(); return true; },
    onCancel: async () => { detachDrag(); d.data = JSON.parse(snapshot); await rebuild(d); },
  });
  if (isNew) status('Bedingungen hinzufügen oder mit OK an der Standardposition belassen', 'info');
}
async function moveDialog(comp) {
  const inp = (l, v = 0) => el('input', { value: v, style: 'width:80px' });
  const t = [inp(), inp(), inp()], r = [inp(), inp(), inp()];
  const res = await modal({ title: `${comp.name} verschieben/drehen`, body: el('div', {},
    el('div', { class: 'row' }, el('span', { class: 'w80' }, 'Verschieben [mm]'), ...t.map((x, i) => el('label', {}, 'XYZ'[i], x, el('span', { class: 'unit' }, 'mm')))),
    el('div', { class: 'row' }, el('span', { class: 'w80' }, 'Drehen [°]'), ...r.map((x, i) => el('label', {}, 'XYZ'[i], x, el('span', { class: 'unit' }, '°')))),
    el('p', { class: 'muted small' }, 'Relativ zur aktuellen Lage (Baugruppen-Koordinaten). Vorhandene Bedingungen werden danach erneut gelöst.')),
  buttons: [{ label: 'Abbrechen', value: null }, { label: 'Anwenden', primary: true, value: () => ({ t: t.map(x => +x.value.replace(',', '.') || 0), r: r.map(x => +x.value.replace(',', '.') || 0) }) }] });
  if (!res) return;
  await commit((data) => {
    const c = data.components.find(x => x.id === comp.id); const m = new THREE.Matrix4().fromArray(c.matrix);
    const ctr = (compEntry(comp.id) && entryBox(compEntry(comp.id))?.getCenter(new THREE.Vector3())) || new THREE.Vector3();
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...res.r.map(x => x * Math.PI / 180)));
    const M = new THREE.Matrix4().makeTranslation(ctr.x, ctr.y, ctr.z).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
    M.premultiply(new THREE.Matrix4().makeTranslation(...res.t));
    c.matrix = M.multiply(m).toArray();
  });
}
function attachDrag(compId) {
  detachDrag(); const e = compEntry(compId); if (!e?.group) return;
  const g = e.group; g.matrixAutoUpdate = true; g.matrix.decompose(g.position, g.quaternion, g.scale);
  const tc = new TransformControls(App.viewer.camera, App.viewer.renderer.domElement);
  tc.attach(g); tc.setSize(0.9); App.viewer.scene.add(tc.getHelper()); App.tctl = tc;
  tc.addEventListener('change', () => App.viewer.request());
  tc.addEventListener('mouseUp', async () => {
    g.updateMatrix(); const m = g.matrix.toArray();
    await commit((data) => { data.components.find(c => c.id === compId).matrix = m; });
    if (App.tctl) { const ne = compEntry(compId); if (ne?.group) { ne.group.matrixAutoUpdate = true; ne.group.matrix.decompose(ne.group.position, ne.group.quaternion, ne.group.scale); App.tctl.attach(ne.group); } }
  });
  status('Ziehen: Pfeile verschieben · Taste R = Drehen, T = Verschieben · Esc beendet', 'pick');
  App.tctlKey = (ev) => { if (ev.key === 'r' || ev.key === 'R') tc.setMode('rotate'); if (ev.key === 't' || ev.key === 'T') tc.setMode('translate'); if (ev.key === 'Escape') detachDrag(); };
  window.addEventListener('keydown', App.tctlKey);
}
function detachDrag() {
  if (!App.tctl) return; App.tctl.detach(); App.viewer.scene.remove(App.tctl.getHelper()); App.tctl.dispose(); App.tctl = null;
  window.removeEventListener('keydown', App.tctlKey); status(''); App.viewer.request();
}

// =====================================================================================
// Analyse
// =====================================================================================
async function measureDistance() {
  App.measureG.clear(); App.viewer.clearLabels('measure');
  const snapPt = (r) => {
    if (r.kind === 'edge') { const a = r.a.clone().applyMatrix4(r.world), b = r.b.clone().applyMatrix4(r.world); return { p: a.clone().add(b).multiplyScalar(0.5), label: 'Kantenmitte' }; }
    if (r.kind === 'face') {
      // auf naechsten Eckpunkt fangen, wenn nahe
      const m = r.obj.userData.mesh; const loc = r.localPoint; let best = null, bd = App.viewer.pxToWorld(12);
      for (let i = 0; i < m.pos.length; i += 3) { const d = Math.hypot(m.pos[i] - loc.x, m.pos[i + 1] - loc.y, m.pos[i + 2] - loc.z); if (d < bd) { bd = d; best = i; } }
      return best !== null ? { p: new THREE.Vector3(m.pos[best], m.pos[best + 1], m.pos[best + 2]).applyMatrix4(r.world), label: 'Eckpunkt' } : { p: r.point, label: 'Flächenpunkt' };
    }
    return null;
  };
  const a = await pick({ kinds: ['face', 'edge'], prompt: 'Messen: ersten Punkt wählen (Eckpunkte werden gefangen)' }); if (!a) return;
  const pa = snapPt(a); drawPt(pa.p);
  const b = await pick({ kinds: ['face', 'edge'], prompt: 'Messen: zweiten Punkt wählen' }); if (!b) { App.measureG.clear(); return; }
  const pb = snapPt(b); drawPt(pb.p);
  const dvec = pb.p.clone().sub(pa.p); const dist = dvec.length();
  App.measureG.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pa.p, pb.p]), new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false })));
  App.viewer.addLabel(`${fmt(dist, 3)} mm`, pa.p.clone().add(pb.p).multiplyScalar(0.5), 'lbl measure', 'measure');
  let ang = '';
  if (a.kind === 'face' && b.kind === 'face') { const w = Math.acos(THREE.MathUtils.clamp(a.normal.dot(b.normal), -1, 1)) * 180 / Math.PI; ang = ` · Winkel zwischen Flächen ${fmt(180 - w, 3)}° (Normalen ${fmt(w, 3)}°)`; if (Math.abs(a.normal.dot(b.normal)) > 0.99999) { const pd = Math.abs(b.point.clone().sub(a.point).dot(a.normal)); ang += ` · Ebenenabstand ${fmt(pd, 4)} mm`; } }
  status(`Abstand ${fmt(dist, 4)} mm (${pa.label} → ${pb.label}) · ΔX ${fmt(dvec.x, 3)} mm · ΔY ${fmt(dvec.y, 3)} mm · ΔZ ${fmt(dvec.z, 3)} mm${ang}`, 'ok');
  App.viewer.request();
  function drawPt(p) { const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints([p]), new THREE.PointsMaterial({ color: 0xffe066, size: 9, sizeAttenuation: false, depthTest: false })); m.renderOrder = 40; App.measureG.add(m); App.viewer.request(); }
}
function clearMeasure() { App.measureG.clear(); App.viewer.clearLabels('measure'); App.viewer.request(); }

// ---------------------------------------------------------------- Bemassung am Koerper (Referenzmasse)
const V3 = (p) => new THREE.Vector3(...p);
/** Kreis erkennen: alle Punkte gleich weit vom Schwerpunkt, geschlossen */
function circleOf(pl) {
  if (!pl || pl.length < 8) return null;
  const P = pl.map(V3); const closed = P[0].distanceTo(P[P.length - 1]) < 1e-6 * (1 + P[0].length());
  if (!closed) return null;
  const c = P.slice(0, -1).reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / (P.length - 1));
  const rs = P.map(p => p.distanceTo(c)); const r = rs.reduce((s, x) => s + x, 0) / rs.length;
  return rs.every(x => Math.abs(x - r) < Math.max(1e-4, r * 1e-3)) ? { c, r } : null;
}
/** Kantenzuege des Ergebnisses (usd-brep: exakte Kanten; interner Kern: einzelne Segmente) */
function edgePolys(res) {
  const ud = res.edges?.userData; if (ud?.polys) return ud.polys;
  if (res._segPolys) return res._segPolys;
  const p = res.edges?.attributes?.position; const out = [];
  if (p) for (let i = 0; i + 1 < p.count; i += 2) out.push([[p.getX(i), p.getY(i), p.getZ(i)], [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)]]);
  res._segPolys = out; return out;
}
function polyLen(pl) { let L = 0; for (let i = 1; i < pl.length; i++) L += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1], pl[i][2] - pl[i - 1][2]); return L; }
/** Punkt fangen: Eckpunkt in der Naehe, sonst Kantenmitte bzw. Flaechenpunkt */
function snapPoint(r) {
  if (r.kind === 'edge') {
    const pl = r.edgePoly; if (!pl) return r.a.clone().add(r.b).multiplyScalar(0.5);
    const cir = circleOf(pl); if (cir) return cir.c;
    return V3(edgeRefFromPoly(pl).mid);
  }
  const m = r.obj.userData.mesh; const loc = r.localPoint; let best = null, bd = App.viewer.pxToWorld(14);
  for (let i = 0; i < m.pos.length; i += 3) { const dd = Math.hypot(m.pos[i] - loc.x, m.pos[i + 1] - loc.y, m.pos[i + 2] - loc.z); if (dd < bd) { bd = dd; best = i; } }
  return best !== null ? new THREE.Vector3(m.pos[best], m.pos[best + 1], m.pos[best + 2]) : r.point.clone();
}
async function createAnnotation() {
  const d = doc(); if (!isPart(d) || !d.res.body) { toast('Bemaßung: zuerst einen Körper erzeugen', 'warn'); return; }
  const a = await pick({ kinds: ['edge', 'face'], prompt: 'Bemaßung: Kante (Länge/Ø) oder ersten Punkt/Fläche wählen' }); if (!a) return;
  let ann = null;
  const b = await pick({ kinds: ['edge', 'face'], prompt: a.kind === 'edge' ? 'Zweiten Punkt/Fläche wählen – Enter oder Rechtsklick = Länge bzw. Ø dieser Kante' : 'Zweiten Punkt bzw. parallele Fläche wählen' });
  if (!b) {
    if (a.kind !== 'edge') { status('Bemaßung abgebrochen', 'info', 2500); return; }
    const pl = a.edgePoly || [G.v3arr(a.a), G.v3arr(a.b)];
    const cir = circleOf(pl); const ref = edgeRefFromPoly(pl);
    ann = cir ? { id: uid('a'), type: 'dia', mid: ref.mid, len: ref.len } : { id: uid('a'), type: 'len', mid: ref.mid, len: ref.len };
  } else if (a.kind === 'face' && b.kind === 'face' && Math.abs(a.normal.dot(b.normal)) > 0.99999) {
    ann = { id: uid('a'), type: 'pdist', p1: G.v3arr(a.point), n1: G.v3arr(a.normal), p2: G.v3arr(b.point), n2: G.v3arr(b.normal) };
  } else {
    ann = { id: uid('a'), type: 'dist', p1: G.v3arr(snapPoint(a)), p2: G.v3arr(snapPoint(b)) };
  }
  await commit((data) => { (data.annotations ||= []).push(ann); });
  status('Bemaßung erstellt – Rechtsklick auf das Maß löscht sie', 'ok', 4000);
}
/** Referenzmass nach der Regenerierung neu fangen: Rueckgabe {pts, text, pos} oder {stale} */
function resolveAnnotation(an, res) {
  const tol = Math.max(1e-3, (res.bbox?.getSize(new THREE.Vector3()).length() || 100) * 1e-4);
  const polys = edgePolys(res);
  const onMesh = (p) => { const m = res.mesh; if (!m) return false; for (let i = 0; i < m.pos.length; i += 3) if (Math.hypot(m.pos[i] - p.x, m.pos[i + 1] - p.y, m.pos[i + 2] - p.z) < tol) return true;
    for (const pl of polys) { const mid = V3(edgeRefFromPoly(pl).mid); if (mid.distanceTo(p) < tol) return true; const c = circleOf(pl); if (c && c.c.distanceTo(p) < tol) return true; } return false; };
  const onPlane = (p, n) => { const m = res.mesh; if (!m) return false; const N = V3(n); const t = m.tri;
    for (let i = 0; i < t.length; i += 3) { const A = new THREE.Vector3(m.pos[t[i] * 3], m.pos[t[i] * 3 + 1], m.pos[t[i] * 3 + 2]); const B = new THREE.Vector3(m.pos[t[i + 1] * 3], m.pos[t[i + 1] * 3 + 1], m.pos[t[i + 1] * 3 + 2]); const C = new THREE.Vector3(m.pos[t[i + 2] * 3], m.pos[t[i + 2] * 3 + 1], m.pos[t[i + 2] * 3 + 2]);
      const fn = B.clone().sub(A).cross(C.clone().sub(A)); if (fn.lengthSq() < 1e-20) continue; fn.normalize(); if (fn.dot(N) > 0.9999 && Math.abs(V3(p).sub(A).dot(N)) < tol) return true; } return false; };
  if (an.type === 'len' || an.type === 'dia') {
    let best = null, bd = tol * 10;
    for (const pl of polys) { const dd = V3(edgeRefFromPoly(pl).mid).distanceTo(V3(an.mid)); if (dd < bd) { bd = dd; best = pl; } }
    if (!best) return { stale: true, pos: V3(an.mid), text: an.type === 'dia' ? `Ø ${MM(an.len / Math.PI)}` : MM(an.len) };
    if (an.type === 'dia') { const c = circleOf(best); if (!c) return { stale: true, pos: V3(an.mid), text: 'Ø ?' }; return { pts: [c.c.clone().addScaledVector(V3(best[0]).sub(c.c).normalize(), c.r), c.c.clone().addScaledVector(V3(best[0]).sub(c.c).normalize(), -c.r)], text: `Ø ${MM(c.r * 2)}`, pos: V3(best[0]) }; }
    return { pts: best.map(V3), line: true, text: MM(polyLen(best)), pos: V3(edgeRefFromPoly(best).mid) };
  }
  if (an.type === 'dist') {
    const onSurf = (p) => { const m = res.mesh; if (!m) return false; const t = m.tri; const T = new THREE.Triangle(); const q = new THREE.Vector3();
      for (let i = 0; i < t.length; i += 3) { T.a.fromArray(m.pos, t[i] * 3); T.b.fromArray(m.pos, t[i + 1] * 3); T.c.fromArray(m.pos, t[i + 2] * 3); T.closestPointToPoint(p, q); if (q.distanceTo(p) < tol * 10) return true; } return false; };
    const p1 = V3(an.p1), p2 = V3(an.p2); const ok = (onMesh(p1) || onSurf(p1)) && (onMesh(p2) || onSurf(p2));
    return { stale: !ok, pts: [p1, p2], text: MM(p1.distanceTo(p2)), pos: p1.clone().lerp(p2, 0.5) };
  }
  if (an.type === 'pdist') {
    const p1 = V3(an.p1), N = V3(an.n1); const dd = Math.abs(V3(an.p2).sub(p1).dot(N)); const p2 = p1.clone().addScaledVector(N, V3(an.p2).sub(p1).dot(N));
    const ok = onPlane(an.p1, an.n1) && onPlane(an.p2, an.n2);
    return { stale: !ok, pts: [p1, p2], text: MM(dd), pos: p1.clone().lerp(p2, 0.5) };
  }
  return { stale: true, pos: new THREE.Vector3(), text: '?' };
}
function renderAnnotations(d, res) {
  App.annotG?.clear(); App.viewer.clearLabels('annot');
  if (!isPart(d) || App.sketcher || !App.display.annots || !d.data.annotations?.length || !res) return;
  for (const an of d.data.annotations) {
    let r; try { r = resolveAnnotation(an, res); } catch { r = { stale: true, pos: new THREE.Vector3(), text: '?' }; }
    const col = r.stale ? 0xff5050 : 0x6fd3ff;
    if (r.pts && !r.line) arrowPair(r.pts[0], r.pts[1], col);
    else if (r.pts) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(r.pts), new THREE.LineBasicMaterial({ color: col, depthTest: false })); l.renderOrder = 27; App.annotG.add(l); }
    const lb = App.viewer.addLabel(r.text, r.pos, `dim ref${r.stale ? ' stale' : ''}`, 'annot');
    lb.el.title = r.stale ? 'Referenz nicht mehr vorhanden – Rechtsklick löscht' : 'Referenzmaß – Rechtsklick löscht';
    lb.el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation();
      contextMenu(ev.clientX, ev.clientY, [{ label: 'Bemaßung löschen', icon: 'close', action: () => commit((data) => { data.annotations = data.annotations.filter(x => x.id !== an.id); }) }]); });
  }
  App.viewer.request();
}
function arrowPair(p1, p2, col) {
  const dir = p2.clone().sub(p1); const len = dir.length(); if (len < 1e-9) return; dir.normalize();
  const head = Math.min(len * 0.3, App.viewer.pxToWorld(12));
  for (const [o, dv] of [[p1, dir], [p2, dir.clone().negate()]]) {
    const ah = new THREE.ArrowHelper(dv, o, len / 2, col, head, head * 0.45);
    ah.traverse(x => { if (x.material) { x.material.depthTest = false; x.renderOrder = 27; } }); App.annotG.add(ah);
  }
}

async function massProps() {
  const d = doc(); if (!d?.res) return;
  if (isPart(d) && d.res.props && !d.res.imports?.length) return massDialog(d, d.res.props);
  const bodies = isPart(d) ? (d.res.display ? [{ geom: d.res.display, matrix: null, name: d.data.name }] : []) : flattenBodies(d.res);
  if (!bodies.length) { toast('Keine Geometrie', 'warn'); return; }
  let V = 0, A = 0; const C = new THREE.Vector3(); const bb = new THREE.Box3();
  for (const b of bodies) {
    const g = G.prepGeom(b.geom); if (b.matrix) g.applyMatrix4(b.matrix);
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) {
      const v = (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
      V += v; C.x += v * (p[i] + p[i + 3] + p[i + 6]) / 4; C.y += v * (p[i + 1] + p[i + 4] + p[i + 7]) / 4; C.z += v * (p[i + 2] + p[i + 5] + p[i + 8]) / 4;
    }
    A += G.surfaceArea(g); g.computeBoundingBox(); bb.union(g.boundingBox);
  }
  C.divideScalar(V || 1); const sz = bb.getSize(new THREE.Vector3());
  const dens = el('input', { value: localStorage.getItem('cadstudio.density') || '7.85', style: 'width:80px' });
  const massEl = el('b');
  const upd = () => { const rho = +dens.value.replace(',', '.') || 0; massEl.textContent = `${fmt(V / 1000 * rho, 3)} g  (${fmt(V / 1e6 * rho, 4)} kg)`; try { localStorage.setItem('cadstudio.density', dens.value); } catch { /* egal */ } };
  dens.oninput = upd; upd();
  const row = (k, v) => el('tr', {}, el('td', {}, k), el('td', {}, v));
  await modal({ title: `Masseeigenschaften – ${d.data.name}`, width: 520, body: el('table', { class: 'props' },
    row('Volumen', `${fmt(V, 3)} mm³  (${fmt(V / 1000, 4)} cm³)`), row('Oberfläche', `${fmt(A, 3)} mm²`),
    row('Dichte', el('span', {}, dens, ' g/cm³')), row('Masse', massEl),
    row('Schwerpunkt', `X ${fmt(C.x, 3)}  Y ${fmt(C.y, 3)}  Z ${fmt(C.z, 3)}`),
    row('Begrenzungsquader', `${fmt(sz.x, 3)} × ${fmt(sz.y, 3)} × ${fmt(sz.z, 3)} mm`),
    row('Körper', String(bodies.length))), buttons: [{ label: 'Schließen', value: true, primary: true }] });
}

// =====================================================================================
// Werkzeuge
// =====================================================================================
async function paramsDialog() {
  const d = doc(); if (!d) return;
  const rows = clone(d.data.params || []);
  const tbody = el('tbody');
  const draw = () => {
    const vals = evalParams(rows);
    tbody.replaceChildren(...rows.map((p, i) => el('tr', {},
      el('td', {}, el('input', { value: p.name, oninput: (e) => { p.name = e.target.value.replace(/[^A-Za-z0-9_]/g, ''); } })),
      el('td', {}, el('input', { value: p.value, oninput: (e) => { p.value = e.target.value; }, onchange: draw })),
      el('td', { class: 'muted' }, vals[p.name] !== undefined ? fmt(vals[p.name], 4) : '⚠'),
      el('td', {}, el('input', { value: p.desc || '', oninput: (e) => { p.desc = e.target.value; } })),
      el('td', {}, el('button', { class: 'x', onclick: () => { rows.splice(i, 1); draw(); } }, '×')))));
  };
  draw();
  const r = await modal({ title: `Parameter – ${d.data.name}`, width: 700, body: el('div', {},
    el('table', { class: 'params' }, el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Wert / Relation'), el('th', {}, 'Ergebnis'), el('th', {}, 'Beschreibung'), el('th'))), tbody),
    el('button', { class: 'btn sm', onclick: () => { let n = 1; while (rows.some(p => p.name === `P${n}`)) n++; rows.push({ name: `P${n}`, value: '10', desc: '' }); draw(); } }, '+ Parameter'),
    el('p', { class: 'muted small' }, 'Parameter können in jedem Maßfeld (Tiefe, Durchmesser, Skizzenmaße …) verwendet werden, z. B. "L/2+5". Relationen dürfen andere Parameter und Funktionen (sin, cos, sqrt, min, max …) nutzen.')),
  buttons: [{ label: 'Abbrechen', value: null }, { label: 'OK', primary: true, value: true }] });
  if (r) await commit((data) => { data.params = rows.filter(p => p.name); });
}

async function optionsDialog() {
  const st = await api('/api/state');
  const creo = el('input', { class: 'w100', value: st.converters.creo || '', placeholder: '"C:\\Programme\\CAD Exchanger\\bin\\ExchangerConv.exe" -i {in} -e {out}' });
  const sw = el('input', { class: 'w100', value: st.converters.solidworks || '', placeholder: '"…\\ExchangerConv.exe" -i {in} -e {out}' });
  const appw = el('input', { type: 'checkbox', checked: st.ui_mode === 'browser' });
  const d = doc(); const seg = el('input', { type: 'number', min: 16, max: 256, value: isPart(d) ? d.data.settings?.seg || 64 : 64, style: 'width:80px' });
  const r = await modal({ title: 'Optionen', width: 640, body: el('div', {},
    el('h4', {}, 'Konverter für native CAD-Formate'),
    el('p', { class: 'muted small' }, 'Befehl, der eine Creo- bzw. SolidWorks-Datei nach STEP wandelt. Platzhalter {in} = Quelldatei, {out} = Ziel-STEP. Ohne Eintrag bitte im Ursprungsprogramm als STEP exportieren.'),
    el('label', { class: 'fld' }, 'Creo (.prt/.asm)', creo), el('label', { class: 'fld' }, 'SolidWorks (.sldprt/.sldasm)', sw),
    el('h4', {}, 'Programm'), el('label', { class: 'chk' }, appw, 'Oberfläche im Standardbrowser statt im eigenen Programmfenster öffnen (ab dem nächsten Start)'),
    isPart(d) ? el('label', { class: 'fld' }, 'Facettierung des aktiven Parts (Segmente pro Vollkreis)', seg) : null),
  buttons: [{ label: 'Abbrechen', value: null }, { label: 'Speichern', primary: true, value: true }] });
  if (!r) return;
  await apiJson('/api/config', { converters: { creo: creo.value, solidworks: sw.value }, ui_mode: appw.checked ? 'browser' : 'desktop' });
  if (isPart(d) && +seg.value !== (d.data.settings?.seg || 64)) await commit((data) => { data.settings = { ...(data.settings || {}), seg: Math.max(16, Math.min(256, +seg.value || 64)) }; });
  toast('Optionen gespeichert', 'ok');
}

async function spaceMouseDialog() {
  const sm = App.sm; const c = sm.cfg;
  const stat = el('div', { class: 'muted' }, sm.device ? `Verbunden: ${sm.device.productName}${sm.native ? ' (USB, direkt vom Programm gelesen)' : ' (WebHID)'}`
    : sm.native ? 'Kein Gerät gefunden. SpaceMouse (Kabel oder Funkempfänger) anstecken – sie wird automatisch erkannt.'
      : sm.supported ? 'Nicht verbunden' : 'SpaceMouse nicht verfügbar (Programm ohne USB-HID-Unterstützung und Browser ohne WebHID).');
  const rng = (k, min, max, step) => el('input', { type: 'range', min, max, step, value: c[k], oninput: (e) => { c[k] = +e.target.value; sm.saveCfg(); } });
  const chk = (obj, k, label) => el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: obj[k], onchange: (e) => { obj[k] = e.target.checked; sm.saveCfg(); } }), label);
  const btnSel = (n) => el('select', { onchange: (e) => { c.buttons[n] = e.target.value; sm.saveCfg(); } }, [['fit', 'Einpassen'], ['standard', 'Standardausrichtung'], ['FRONT', 'FRONT'], ['TOP', 'TOP'], ['RIGHT', 'RIGHT'], ['', '—']].map(([v, l]) => el('option', { value: v, selected: c.buttons[n] === v }, l)));
  await modal({ title: '3Dconnexion SpaceMouse', width: 560, body: el('div', {}, stat,
    sm.native ? null : el('button', { class: 'btn primary', disabled: !sm.supported, onclick: async () => { try { await sm.request(); stat.textContent = `Verbunden: ${sm.device.productName}`; } catch (e) { stat.textContent = e.message; } } }, icon('spacemouse'), 'Gerät verbinden…'),
    el('label', { class: 'fld' }, 'Empfindlichkeit', rng('sensitivity', 0.1, 3, 0.05)), el('label', { class: 'fld' }, 'Totzone', rng('deadzone', 0, 0.3, 0.01)),
    el('div', { class: 'row wrap' }, chk(c, 'pan', 'Verschieben'), chk(c, 'zoom', 'Zoomen'), chk(c, 'rotate', 'Drehen'), chk(c, 'dominant', 'Nur dominante Achse')),
    el('div', { class: 'muted small' }, 'Achsen umkehren:'),
    el('div', { class: 'row wrap' }, ...['tx', 'ty', 'tz', 'rx', 'ry', 'rz'].map(k => chk(c.invert, k, k.toUpperCase()))),
    el('div', { class: 'row' }, el('label', {}, 'Taste 1 ', btnSel(1)), el('label', {}, 'Taste 2 ', btnSel(2))),
    el('p', { class: 'muted small' }, sm.native
      ? 'Das Programm liest die SpaceMouse direkt per USB. Reagiert sie nicht, den 3Dconnexion-Treiber (3DxWare / 3Dconnexion Home) beenden – er kann das Gerät exklusiv belegen. Unter macOS ggf. in Systemeinstellungen › Datenschutz › Eingabeüberwachung CAD-Studio-MK1 erlauben.'
      : 'Im Browser-Modus über WebHID (Chrome/Edge). Falls das Gerät nicht reagiert, den 3Dconnexion-Treiber kurz beenden.')),
  buttons: [{ label: 'Schließen', value: true, primary: true }] });
}
function smButton(action) {
  const bb = doc()?.res?.bbox;
  if (action === 'fit') App.viewer.fit(bb); else if (action === 'standard') App.viewer.setView('standard', bb); else if (VIEWS[action]) App.viewer.setView(action, bb);
}

function helpDialog() {
  const r = (a, b) => el('tr', {}, el('td', {}, a), el('td', {}, b));
  modal({ title: `Hilfe – CAD-Studio-MK1 ${App.server.version}`, width: 620, body: el('div', {},
    el('h4', {}, 'Maus (wie Creo)'), el('table', { class: 'props' },
      r('Mittlere Maustaste ziehen', 'Drehen'), r('Shift + Mitte ziehen', 'Verschieben'), r('Strg + Mitte ziehen', 'Zoomen'), r('Mausrad', 'Zoomen an Mausposition'),
      r('Alt + Linke Taste ziehen', 'Drehen (Trackpad/Mac)'), r('Alt + Shift + Linke Taste', 'Verschieben (Trackpad/Mac)'), r('Linksklick', 'Auswählen'), r('Rechtsklick', 'Kontextmenü')),
    el('h4', {}, 'Tastatur'), el('table', { class: 'props' },
      r('Strg+S', 'Speichern'), r('Strg+Z / Strg+Y', 'Rückgängig / Wiederherstellen'), r('Strg+G', 'Regenerieren'), r('Strg+D', 'Standardausrichtung'), r('Strg+R', 'Neu zeichnen'),
      r('Esc', 'Aktion abbrechen'), r('Entf', 'Gewähltes Feature löschen')),
    el('h4', {}, 'Modellierkern'),
    el('p', {}, KERNEL.available
      ? `NVIDIA usd-brep ${KERNEL.version}: exakte NURBS-B-Rep-Volumenkörper. Rundung und Fase an beliebigen Kanten, Schale, exakte Masseeigenschaften, Export als OpenUSD-B-Rep und SMLib-B-Rep.`
      : `Interner Netzkern (usd-brep ist auf diesem System nicht verfügbar – NVIDIA bietet es nur für Windows und Linux an). Rundung/Fase nur an geraden Kanten, keine Schale. ${App.server?.kernel?.error || ''}`),
    el('h4', {}, 'Arbeitsweise'),
    el('p', {}, 'Eigenständige Skizze: Ebene oder ebene Fläche wählen → Modell › Skizze → zeichnen → OK. Die neue Skizze ist danach ausgewählt; Extrudieren oder Drehen verwendet sie direkt. Eine Skizze lässt sich auch im Grafikbereich anklicken oder im Dashboard unter „Skizze“ wählen und von mehreren Features nutzen. Verwendete Skizzen werden ausgeblendet (Rechtsklick › Einblenden).'),
    el('p', {}, 'Wie in Creo: Ebene oder Fläche wählen → Extrudieren/Drehen → Skizze zeichnen → ✔ → Tiefe im Dashboard einstellen → ✔. Doppelklick im Modellbaum öffnet die Definition. „Hier einfügen“ im Kontextmenü setzt die Einfügemarke.')),
  buttons: [{ label: 'Schließen', value: true, primary: true }] });
}

async function massDialog(d, p) {
  const dens = el('input', { value: localStorage.getItem('cadstudio.density') || '7.85', style: 'width:80px' });
  const massEl = el('b');
  const upd = () => { const rho = +dens.value.replace(',', '.') || 0; massEl.textContent = `${fmt(p.volume / 1000 * rho, 3)} g  (${fmt(p.volume / 1e6 * rho, 4)} kg)`; try { localStorage.setItem('cadstudio.density', dens.value); } catch { /* egal */ } };
  dens.oninput = upd; upd();
  const bb = d.res.bbox.getSize(new THREE.Vector3()); const c = p.centroid || [0, 0, 0];
  const row = (k, v) => el('tr', {}, el('td', {}, k), el('td', {}, v));
  await modal({ title: `Masseeigenschaften – ${d.data.name}`, width: 540, body: el('div', {}, el('table', { class: 'props' },
    row('Volumen', `${fmt(p.volume, 4)} mm³  (${fmt(p.volume / 1000, 5)} cm³)`), row('Oberfläche', `${fmt(p.area, 4)} mm²`),
    row('Dichte', el('span', {}, dens, ' g/cm³')), row('Masse', massEl),
    row('Schwerpunkt', `X ${fmt(c[0], 4)}  Y ${fmt(c[1], 4)}  Z ${fmt(c[2], 4)}`),
    row('Begrenzungsquader', `${fmt(bb.x, 3)} × ${fmt(bb.y, 3)} × ${fmt(bb.z, 3)} mm`),
    row('Topologie', `${p.faces} Flächen · ${p.edges} Kanten · ${p.vertices} Ecken${p.manifold ? ' · geschlossener Volumenkörper' : ' · nicht geschlossen'}`)),
    el('p', { class: 'muted small' }, 'Exakt aus der NURBS-B-Rep berechnet (usd-brep).')), buttons: [{ label: 'Schließen', value: true, primary: true }] });
}

async function exitApp() {
  if (App.docs.some(d => d.dirty) && !(await confirmDialog('Beenden', 'Es gibt ungespeicherte Änderungen. Trotzdem beenden?', 'Beenden', true))) return;
  App.docs.forEach(d => { d.dirty = false; });
  syncDirty(); App.sm?.es?.close();
  try { await api('/api/shutdown', { method: 'POST' }); } catch { /* Server weg */ }
  if (App.desktop) return; // Programmfenster wird vom Programm geschlossen
  document.body.replaceChildren(el('div', { class: 'bye' }, el('h2', {}, 'CAD-Studio-MK1 wurde beendet'), el('p', {}, 'Dieses Fenster kann geschlossen werden.')));
  setTimeout(() => window.close(), 400);
}

// =====================================================================================
// Ansicht
// =====================================================================================
function setStyle(s) { App.display.style = s; saveDisplay(); for (const d of App.docs) applyDisplayStyle(d.group, s); App.viewer.request(); buildIGT(); }
function toggleDatum(k) { App.display[k] = !App.display[k]; saveDisplay(); if (doc()) showResult(doc(), doc().res); buildIGT(); }
async function modelColor() {
  const d = doc(); if (!d) return;
  const r = await modal({ title: 'Darstellung', body: el('label', { class: 'fld' }, 'Farbe', el('input', { type: 'color', id: 'clr', value: isPart(d) ? d.data.color : '#b9c3cc' })),
    buttons: [{ label: 'Abbrechen', value: null }, { label: 'OK', primary: true, value: () => $('#clr').value }] });
  if (!r) return;
  if (isPart(d)) await commit((data) => { data.color = r; });
  else { const c = App.sel[0]?.compId; if (!c) { toast('Komponente im Grafikbereich wählen', 'warn'); return; } await commit((data) => { data.components.find(x => x.id === c).color = r; }); }
}
async function screenshot() {
  const blob = dataURLtoBlob(App.viewer.screenshot()); const name = `${(doc()?.data.name || 'bild').toLowerCase()}.png`;
  try { await writeFile(name, blob, false); await refreshFiles(); status(`Bild gespeichert: ${name} (Arbeitsverzeichnis)`, 'ok', 5000); } catch (e) { toast(e.message, 'err'); }
  if (!App.desktop) downloadBlob(blob, name);
}
function dataURLtoBlob(u) { const [h, b] = u.split(','); const bin = atob(b); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: h.match(/:(.*?);/)[1] }); }

// =====================================================================================
// Befehle + Menueband
// =====================================================================================
const CMD = {
  new: () => newDoc('part'), open: () => openFile(), save: () => saveDoc(), saveAs: () => saveAs(), export: () => exportDialog(), close: () => closeDoc(), exit: () => exitApp(),
  workdir: () => workdirDialog(false), undo: () => undo(), redo: () => redo(), regen: async () => { App.partCache.clear(); await rebuild(); }, import: () => (isAsm() ? asmImport() : importIntoPart()),
  datumPlane: () => featDatumPlane(), datumAxis: () => featDatumAxis(), datumPoint: () => featDatumPoint(), sketch: () => featSketch(),
  extrude: () => featExtrude(), revolve: () => featRevolve(), hole: () => featHole(), round: () => featEdge('round'), chamfer: () => featEdge('chamfer'),
  pattern: () => featPattern(), mirror: () => featMirror(), shell: () => featShell(),
  measure: () => measureDistance(), clearMeasure: () => clearMeasure(), mass: () => massProps(), annotate: () => createAnnotation(),
  fit: () => App.viewer.fit(doc()?.res?.bbox), zoomin: () => App.viewer.zoomAt(1.25), zoomout: () => App.viewer.zoomAt(0.8), repaint: () => App.viewer.request(),
  standard: () => App.viewer.setView('standard', doc()?.res?.bbox), color: () => modelColor(), screenshot: () => screenshot(),
  params: () => paramsDialog(), options: () => optionsDialog(), spacemouse: () => spaceMouseDialog(), help: () => helpDialog(),
  assemble: () => asmAssemble(), createComp: () => asmCreate(), placement: () => { const c = App.sel[0]?.compId || App.treeSel; const comp = doc().data.components.find(x => x.id === c); if (comp) placementDash(comp); else toast('Komponente wählen (Grafik oder Modellbaum)', 'warn'); },
  drag: () => { const c = App.sel[0]?.compId || App.treeSel; if (c) attachDrag(c); else toast('Komponente wählen (Grafik oder Modellbaum)', 'warn'); },
  sketchOk: () => App.sketchDone?.(true), sketchCancel: () => App.sketchDone?.(false),
  spin: () => { App.display.spin = !App.display.spin; App.viewer.spinCenterVisible = App.display.spin; saveDisplay(); App.viewer.request(); buildIGT(); },
};
async function runCmd(id) {
  if (App.busy) return;
  if (App.sketcher && !id.startsWith('sketch') && !['fit', 'zoomin', 'zoomout', 'standard', 'repaint', 'spin', 'help'].includes(id) && !id.startsWith('view:') && !id.startsWith('style:') && !id.startsWith('sk:')) { toast('Zuerst die Skizze beenden (✔ oder ✖)', 'warn'); return; }
  if (App.picking && !['fit', 'zoomin', 'zoomout', 'standard'].includes(id) && !id.startsWith('view:')) clearPick(null);
  if (id.startsWith('view:')) { App.viewer.setView(id.slice(5), doc()?.res?.bbox); return; }
  if (id.startsWith('style:')) { setStyle(id.slice(6)); return; }
  if (id.startsWith('dtm:')) { toggleDatum(id.slice(4)); return; }
  if (id.startsWith('sk:')) { App.sketcher?.setTool(id.slice(3)); renderRibbon(); return; }
  if (App.dash && !['fit', 'zoomin', 'zoomout', 'standard', 'repaint', 'measure', 'help'].includes(id)) { App.dash.cancel(); }
  try { await CMD[id]?.(); } catch (e) { console.error(e); toast(e.message, 'err', 6000); }
}

function ribbonSpec() {
  const d = doc();
  if (App.tab === 'sketch') {
    return { tabs: [['sketch', 'Skizze']], groups: [
      { label: 'Skizzieren', items: SKETCH_TOOLS.map(([id, label, ic]) => ({ id: `sk:${id}`, label, icon: ic, big: ['line', 'rect', 'circle'].includes(id), active: App.sketcher?.tool === id })) },
      { label: 'Schließen', items: [{ id: 'sketchOk', label: 'OK', icon: 'ok', big: true, cls: 'okbtn' }, { id: 'sketchCancel', label: 'Abbrechen', icon: 'cancel', big: true, cls: 'cancelbtn' }] },
      { label: 'Ansicht', items: [{ id: 'fit', label: 'Einpassen', icon: 'fit' }, { id: 'standard', label: 'Standard', icon: 'view' }] },
    ] };
  }
  const tabs = [['model', 'Modell'], ['analysis', 'Analyse'], ['view', 'Ansicht'], ['tools', 'Werkzeuge']];
  const groups = {
    model: isAsm(d) ? [
      { label: 'Operationen', items: [{ id: 'regen', label: 'Regenerieren', icon: 'regen', big: true }] },
      { label: 'Komponente', items: [{ id: 'assemble', label: 'Einbauen', icon: 'assemble', big: true }, { id: 'createComp', label: 'Erzeugen', icon: 'create', big: true }, { id: 'import', label: 'Importieren', icon: 'import' }] },
      { label: 'Platzierung', items: [{ id: 'placement', label: 'Bedingungen', icon: 'constraint', big: true }, { id: 'drag', label: 'Ziehen', icon: 'drag', big: true }] },
    ] : [
      { label: 'Operationen', items: [{ id: 'regen', label: 'Regenerieren', icon: 'regen', big: true }] },
      { label: 'Daten holen', items: [{ id: 'import', label: 'Importieren', icon: 'import', big: true }] },
      { label: 'Bezug', items: [{ id: 'datumPlane', label: 'Ebene', icon: 'plane', big: true }, { id: 'sketch', label: 'Skizze', icon: 'sketch', big: true }, { id: 'datumAxis', label: 'Achse', icon: 'axis' }, { id: 'datumPoint', label: 'Punkt', icon: 'point' }] },
      { label: 'Formen', items: [{ id: 'extrude', label: 'Extrudieren', icon: 'extrude', big: true }, { id: 'revolve', label: 'Drehen', icon: 'revolve', big: true }] },
      { label: 'Konstruktion', items: [{ id: 'hole', label: 'Bohrung', icon: 'hole', big: true }, { id: 'round', label: 'Rundung', icon: 'round', big: true }, { id: 'chamfer', label: 'Fase', icon: 'chamfer', big: true }, { id: 'shell', label: 'Schale', icon: 'shell', big: true }] },
      { label: 'Editieren', items: [{ id: 'pattern', label: 'Muster', icon: 'pattern', big: true }, { id: 'mirror', label: 'Spiegeln', icon: 'mirror', big: true }] },
      { label: 'Beschriften', items: [{ id: 'annotate', label: 'Bemaßung', icon: 'dim', big: true }] },
    ],
    analysis: [
      { label: 'Messen', items: [{ id: 'measure', label: 'Messen', icon: 'measure', big: true }, { id: 'clearMeasure', label: 'Messung löschen', icon: 'close' }] },
      { label: 'Modellbericht', items: [{ id: 'mass', label: 'Masseeigenschaften', icon: 'mass', big: true }] },
    ],
    view: [
      { label: 'Ausrichtung', items: [{ id: 'fit', label: 'Einpassen', icon: 'fit', big: true }, { id: 'standard', label: 'Standard', icon: 'view', big: true },
        ...['FRONT', 'BACK', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT'].map(v => ({ id: `view:${v}`, label: v, icon: 'view' }))] },
      { label: 'Modelldarstellung', items: [['shadedEdges', 'Schattiert mit Kanten'], ['shaded', 'Schattiert'], ['hidden', 'Keine verdeckten'], ['wire', 'Drahtmodell']].map(([s, l]) => ({ id: `style:${s}`, label: l, icon: 'style', active: App.display.style === s })) },
      { label: 'Anzeigen', items: [['planes', 'Ebenen'], ['axes', 'Achsen'], ['points', 'Punkte'], ['csys', 'Koord.-Systeme'], ['sketches', 'Skizzen'], ['annots', 'Bemaßungen'], ['tags', 'Beschriftungen']].map(([k, l]) => ({ id: `dtm:${k}`, label: l, icon: { planes: 'plane', axes: 'axis', points: 'point', csys: 'csys', sketches: 'sketch', annots: 'dim', tags: 'datums' }[k], active: App.display[k] })) },
      { label: 'Darstellung', items: [{ id: 'color', label: 'Farbe', icon: 'color', big: true }, { id: 'screenshot', label: 'Bild (PNG)', icon: 'camera', big: true }] },
    ],
    tools: [
      { label: 'Modellintention', items: [{ id: 'params', label: 'Parameter', icon: 'params', big: true }] },
      { label: 'Geräte', items: [{ id: 'spacemouse', label: 'SpaceMouse', icon: 'spacemouse', big: true }] },
      { label: 'Einstellungen', items: [{ id: 'options', label: 'Optionen', icon: 'settings', big: true }, { id: 'workdir', label: 'Arbeitsverz.', icon: 'workdir', big: true }, { id: 'help', label: 'Hilfe', icon: 'help', big: true }] },
    ],
  };
  if (!tabs.find(t => t[0] === App.tab)) App.tab = 'model';
  return { tabs, groups: groups[App.tab] };
}
function renderRibbon() {
  const spec = ribbonSpec();
  const fileBtn = el('button', { class: 'rtab file', onclick: (e) => fileMenu(e) }, 'Datei');
  $('#ribbon-tabs').replaceChildren(App.tab === 'sketch' ? el('span') : fileBtn,
    ...spec.tabs.map(([id, l]) => el('button', { class: `rtab ${App.tab === id ? 'on' : ''}`, onclick: () => { App.tab = id; renderRibbon(); } }, l)));
  $('#ribbon').replaceChildren(...spec.groups.map(g => el('div', { class: 'rgroup' },
    el('div', { class: 'ritems' }, groupItems(g.items)), el('div', { class: 'rlabel' }, g.label))));
}
function groupItems(items) {
  const big = items.filter(i => i.big); const small = items.filter(i => !i.big);
  const btn = (i) => el('button', { class: `rbtn ${i.big ? 'big' : 'small'} ${i.active ? 'on' : ''} ${i.cls || ''}`, title: i.label, onclick: () => runCmd(i.id) }, icon(i.icon), el('span', {}, i.label));
  const cols = []; for (let k = 0; k < small.length; k += 3) cols.push(el('div', { class: 'rcol' }, small.slice(k, k + 3).map(btn)));
  return [...big.map(btn), ...cols];
}
function fileMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  contextMenu(r.left, r.bottom, [
    { label: 'Neu…', icon: 'new', key: 'Strg+N', action: () => runCmd('new') },
    { label: 'Öffnen…', icon: 'open', key: 'Strg+O', action: () => runCmd('open') },
    { label: 'Speichern', icon: 'save', key: 'Strg+S', action: () => runCmd('save') },
    { label: 'Speichern unter…', icon: 'save', action: () => runCmd('saveAs') },
    { label: 'Exportieren (STEP/STL/USD)…', icon: 'export', action: () => runCmd('export') }, '-',
    { label: 'Arbeitsverzeichnis wählen…', icon: 'workdir', action: () => runCmd('workdir') },
    { label: 'Fenster schließen', icon: 'window', action: () => runCmd('close') }, '-',
    { label: 'Hilfe', icon: 'help', action: () => runCmd('help') },
    { label: 'Beenden', icon: 'exit', action: () => runCmd('exit') },
  ]);
}

// In-Graphics-Toolbar (oben in der Grafik, wie Creo)
function buildIGT() {
  const b = (id, ic, title, on) => el('button', { class: `igb ${on ? 'on' : ''}`, title, onclick: () => runCmd(id) }, icon(ic));
  const dd = (ic, title, items) => el('button', { class: 'igb dd', title, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 2, items); } }, icon(ic), el('span', { class: 'caret' }, '▾'));
  $('#igt').replaceChildren(
    b('fit', 'fit', 'Neu einpassen'), b('zoomin', 'zoomin', 'Vergrößern'), b('zoomout', 'zoomout', 'Verkleinern'), b('repaint', 'refresh', 'Neu zeichnen (Strg+R)'),
    dd('view', 'Gespeicherte Ausrichtungen', Object.entries(VIEWS).map(([k, v]) => ({ label: v.label, action: () => runCmd(k === 'standard' ? 'standard' : `view:${k}`) }))),
    dd('style', 'Darstellungsstil', [['shadedEdges', 'Schattiert mit Kanten'], ['shaded', 'Schattiert'], ['hidden', 'Keine verdeckten Kanten'], ['wire', 'Drahtmodell']].map(([s, l]) => ({ label: (App.display.style === s ? '● ' : '○ ') + l, action: () => runCmd(`style:${s}`) }))),
    dd('datums', 'Bezugsanzeige-Filter', [['planes', 'Ebenen'], ['axes', 'Achsen'], ['points', 'Punkte'], ['csys', 'Koordinatensysteme'], ['sketches', 'Skizzen'], ['tags', 'Bezugsbeschriftungen']].map(([k, l]) => ({ label: `${App.display[k] ? '☑' : '☐'} ${l}`, action: () => runCmd(`dtm:${k}`) }))),
    b('spin', 'spin', 'Drehzentrum anzeigen', App.display.spin),
    el('span', { class: 'igsep' }),
    b('measure', 'measure', 'Messen'),
  );
}

// =====================================================================================
// Navigator: Modellbaum, Layerbaum, Ordner
// =====================================================================================
function bindNavTabs() {
  for (const t of document.querySelectorAll('#nav-tabs button')) t.onclick = () => { App.navTab = t.dataset.tab; renderNav(); if (App.navTab === 'folder') refreshFiles(); };
}
function renderNav() {
  for (const t of document.querySelectorAll('#nav-tabs button')) t.classList.toggle('on', t.dataset.tab === App.navTab);
  const body = $('#nav-body'); const d = doc();
  if (!d) { body.replaceChildren(); return; }
  if (App.navTab === 'tree') body.replaceChildren(isPart(d) ? partTree(d) : asmTree(d));
  else if (App.navTab === 'layers') body.replaceChildren(layerTree(d));
  else body.replaceChildren(folderTree());
}
function highlightTree(id) {
  App.treeSel = id;
  document.querySelectorAll('#nav-body .trow').forEach(r => r.classList.toggle('sel', r.dataset.id === id));
}
function partTree(d) {
  const data = d.data; const res = d.res;
  const ins = data.insertAt === null || data.insertAt === undefined ? data.features.length : data.insertAt;
  const rows = [el('div', { class: 'trow root' }, icon('part'), el('span', {}, `${data.name.toUpperCase()}.CSPRT`))];
  const marker = () => el('div', { class: 'trow insert', title: 'Einfügemarke – neue Features werden hier eingefügt',
    oncontextmenu: (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: 'Ans Ende verschieben', action: () => setInsert(data.features.length) }]); } }, icon('insert'), el('span', {}, 'Hier einfügen'));
  data.features.forEach((f, i) => {
    if (i === ins) rows.push(marker());
    const st = res?.status.get(f.id) || 'ok';
    const err = res?.errors.find(e => e.id === f.id);
    const hidden = f.type === 'sketch' ? !sketchVisible(f) : (f.hidden || hiddenByLayer(data, f));
    const row = el('div', { class: `trow st-${st} ${hidden ? 'hid' : ''} ${App.treeSel === f.id ? 'sel' : ''}`, 'data-id': f.id, title: err ? err.msg : `${FEATURE_INFO[f.type]?.label}${hidden ? ' (ausgeblendet)' : ''}`,
      onclick: () => selectFeature(f), ondblclick: () => editFeature(f),
      oncontextmenu: (e) => { e.preventDefault(); selectFeature(f); featureMenu(e, f, i); } },
    icon(FEATURE_INFO[f.type]?.icon || 'info'), el('span', { class: 'tn' }, f.name), err ? icon('error', 'ic err') : null, hidden ? icon('eyeoff', 'ic faint') : null);
    rows.push(row);
  });
  if (ins >= data.features.length) rows.push(marker());
  return el('div', { class: 'tree' }, rows);
}
function selectFeature(f) {
  highlightTree(f.id); App.sel = [];
  const d = doc(); App.selHl.clear();
  const tools = d.res?.tools.get(f.id);
  if (tools) for (const t of tools) App.selHl.add(highlightMesh(t.geom, t.op === 'cut' ? 0xff6b6b : 0x29c8ff, 0.22));
  App.viewer.clearLabels('sel');
  if (f.type === 'datumPlane') { App.sel = [{ kind: 'plane', ref: f.id, name: f.name }]; planeHl(App.selHl, f.id, f.name); }
  else d.group.traverse(o => { if (o.userData.datumId === f.id) { const c = o.clone(); c.traverse(x => { if (x.material) { x.material = x.material.clone(); x.material.color?.set(0xffb020); if (x.type === 'Mesh') x.material.opacity = 0.12; x.material.depthTest = false; x.renderOrder = 25; } }); App.selHl.add(c); } });
  if (f.type === 'sketch') App.sel = [{ kind: 'sketch', ref: f.id, name: f.name }];
  App.viewer.request();
}
/** Skizzen-Features: von Features verwendete Skizzen sind ausgeblendet, solange nicht ausdruecklich eingeblendet (wie Creo) */
function sketchVisible(f) {
  const res = doc()?.res; if (f.hidden || hiddenByLayer(doc().data, f)) return false;
  return !(res?.usedSketches?.has(f.id)) || !!f.show;
}
function featureMenu(e, f, i) {
  const d = doc(); const isDatum = ['datumPlane', 'datumAxis', 'datumPoint', 'csys'].includes(f.type);
  const isSketch = f.type === 'sketch'; const skVisible = isSketch && sketchVisible(f);
  contextMenu(e.clientX, e.clientY, [
    { label: isSketch ? 'Skizze bearbeiten' : 'Definition editieren', icon: 'sketch', action: () => editFeature(f), disabled: f.type === 'csys' },
    isSketch ? { label: 'Extrudieren mit dieser Skizze', icon: 'extrude', action: () => { App.sel = [{ kind: 'sketch', ref: f.id, name: f.name }]; featExtrude(); } } : null,
    isSketch ? { label: 'Drehen mit dieser Skizze', icon: 'revolve', action: () => { App.sel = [{ kind: 'sketch', ref: f.id, name: f.name }]; featRevolve(); } } : null,
    ['extrude', 'revolve'].includes(f.type) ? { label: f.params.sketch?.ref ? 'Verwendete Skizze bearbeiten' : 'Skizze bearbeiten', icon: 'sketch', action: async () => {
      if (f.params.sketch?.ref) { await editSketchFeature(f.params.sketch.ref); return; }
      const ff = clone(f); if (await editSketch(ff.params.sketch, ff.name)) await commit((data) => { data.features[data.features.findIndex(x => x.id === f.id)] = ff; }); else rebuild(); } } : null,
    { label: 'Umbenennen', icon: 'params', action: () => renameFeature(f) },
    isDatum ? { label: f.hidden ? 'Einblenden' : 'Ausblenden', icon: f.hidden ? 'eye' : 'eyeoff', action: () => toggleFlag(f, 'hidden') } : null,
    isSketch ? { label: skVisible ? 'Ausblenden' : 'Einblenden', icon: skVisible ? 'eyeoff' : 'eye', action: () => commit((data) => { const x = data.features.find(y => y.id === f.id); x.hidden = skVisible; x.show = !skVisible; }) } : null,
    { label: f.suppressed ? 'Fortsetzen' : 'Unterdrücken', icon: 'eyeoff', action: () => toggleFlag(f, 'suppressed') },
    { label: 'Hier einfügen (nach diesem Feature)', icon: 'insert', action: () => setInsert(i + 1) },
    (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole' || f.type === 'round' || f.type === 'chamfer') ? { label: 'Mustern…', icon: 'pattern', action: () => { App.treeSel = f.id; featPattern(); } } : null,
    '-', { label: 'Löschen', icon: 'close', key: 'Entf', action: () => deleteFeature(f) },
  ]);
}
function asmTree(d) {
  const data = d.data; const res = d.res;
  const rows = [el('div', { class: 'trow root' }, icon('assembly'), el('span', {}, `${data.name.toUpperCase()}.CSASM`))];
  for (const id of Object.keys(ASM_DATUMS)) rows.push(el('div', { class: 'trow', 'data-id': id }, icon('plane'), el('span', { class: 'tn' }, id)));
  rows.push(el('div', { class: 'trow' }, icon('csys'), el('span', { class: 'tn' }, 'ASM_DEF_CSYS')));
  for (const c of data.components) {
    const e = res?.comps.find(x => x.comp.id === c.id);
    const n = c.constraints?.length || 0;
    const row = el('div', { class: `trow comp ${c.suppressed ? 'st-suppressed' : ''} ${c.hidden ? 'hid' : ''} ${e?.error ? 'st-error' : ''} ${App.treeSel === c.id ? 'sel' : ''}`, 'data-id': c.id,
      title: `${c.file}${e?.error ? ' – ' + e.error : ''}\n${n ? n + ' Bedingung(en)' : 'Keine Bedingungen'}`,
      onclick: () => { highlightTree(c.id); const en = compEntry(c.id); App.selHl.clear(); if (en?.group) { const bb = entryBox(en); if (bb) { const h = new THREE.Box3Helper(bb, 0xffb020); App.selHl.add(h); } } App.sel = [{ kind: 'comp', compId: c.id, name: c.name }]; App.viewer.request(); },
      ondblclick: () => placementDash(c),
      oncontextmenu: (ev) => { ev.preventDefault(); highlightTree(c.id); compMenu(ev, c); } },
    icon(e?.kind === 'assembly' ? 'assembly' : 'part'), el('span', { class: 'tn' }, c.name), el('span', { class: 'tc' }, n ? `⛓${n}` : ''), e?.error ? icon('error', 'ic err') : null, c.hidden ? icon('eyeoff', 'ic faint') : null);
    rows.push(row);
  }
  if (!data.components.length) rows.push(el('div', { class: 'muted pad small' }, 'Noch keine Komponenten. Modell › Einbauen.'));
  return el('div', { class: 'tree' }, rows);
}
function compMenu(e, c) {
  contextMenu(e.clientX, e.clientY, [
    { label: 'Öffnen', icon: 'open', action: () => openFile(c.file) },
    { label: 'Platzierung bearbeiten', icon: 'constraint', action: () => placementDash(c) },
    { label: 'Ziehen', icon: 'drag', action: () => attachDrag(c.id) },
    { label: 'Umbenennen', icon: 'params', action: async () => { const n = await promptDialog('Umbenennen', 'Name', c.name); if (n) await commit((data) => { data.components.find(x => x.id === c.id).name = n.trim(); }); } },
    { label: c.hidden ? 'Einblenden' : 'Ausblenden', icon: c.hidden ? 'eye' : 'eyeoff', action: () => commit((data) => { const x = data.components.find(y => y.id === c.id); x.hidden = !x.hidden; }) },
    { label: c.suppressed ? 'Fortsetzen' : 'Unterdrücken', icon: 'eyeoff', action: () => commit((data) => { const x = data.components.find(y => y.id === c.id); x.suppressed = !x.suppressed; }) },
    { label: 'Farbe…', icon: 'color', action: () => { App.sel = [{ compId: c.id }]; modelColor(); } },
    '-', { label: 'Löschen', icon: 'close', action: async () => {
      const users = doc().data.components.filter(x => x.id !== c.id && x.constraints?.some(k => k.target.compId === c.id));
      if (!(await confirmDialog('Komponente löschen', `${c.name} entfernen?${users.length ? ` Bedingungen von ${users.map(u => u.name).join(', ')} verweisen darauf und werden entfernt.` : ''}`, 'Löschen', true))) return;
      await commit((data) => { data.components = data.components.filter(x => x.id !== c.id); for (const x of data.components) x.constraints = (x.constraints || []).filter(k => k.target.compId !== c.id); });
    } },
  ]);
}
function layerTree(d) {
  const data = d.data; const names = new Map((data.features || []).map(f => [f.id, f.name]));
  for (const c of data.components || []) names.set(c.id, c.name);
  const rows = data.layers.map((l, li) => {
    const ruleTxt = l.rule ? `Regel: ${({ datumPlane: 'alle Bezugsebenen', datumAxis: 'alle Achsen', datumPoint: 'alle Punkte', csys: 'alle Koordinatensysteme', sketch: 'alle Skizzen', default: 'Standard-Ebenen' })[l.rule]}` : `${l.items.length} Element(e)`;
    const members = l.rule ? 'auto' : String(l.items.length);
    return el('div', { class: 'layer' },
      el('div', { class: `trow ${l.visible ? '' : 'hid'}`, title: `${l.name} – ${ruleTxt}`, oncontextmenu: (e) => { e.preventDefault(); layerMenu(e, li); } },
        el('button', { class: 'eye', title: l.visible ? 'Ausblenden' : 'Einblenden', onclick: () => commit((dd) => { dd.layers[li].visible = !dd.layers[li].visible; }) }, icon(l.visible ? 'eye' : 'eyeoff')),
        icon('layer'), el('span', { class: 'tn' }, l.name), el('span', { class: 'tc' }, members)),
      ...(l.items || []).map(id => el('div', { class: 'trow sub' }, el('span', { class: 'tn' }, names.get(id) || id))));
  });
  return el('div', { class: 'tree' },
    el('div', { class: 'row pad' }, el('button', { class: 'btn sm', onclick: async () => { const n = await promptDialog('Neuer Layer', 'Name', `LAY${String(data.layers.length + 1).padStart(4, '0')}`); if (n) await commit((dd) => { dd.layers.push({ name: n.trim(), rule: null, items: [], visible: true }); }); } }, '+ Layer')),
    rows, el('div', { class: 'muted small pad' }, 'Layer ausblenden blendet alle zugeordneten Elemente aus (wie Creo-Layer). Element im Modellbaum wählen, dann im Layer-Kontextmenü hinzufügen.'));
}
function layerMenu(e, li) {
  const d = doc(); const l = d.data.layers[li]; const sel = App.treeSel;
  contextMenu(e.clientX, e.clientY, [
    { label: l.visible ? 'Ausblenden' : 'Einblenden', icon: 'eye', action: () => commit((dd) => { dd.layers[li].visible = !dd.layers[li].visible; }) },
    { label: 'Gewähltes Element hinzufügen', icon: 'layer', disabled: !sel || l.rule, action: () => commit((dd) => { if (!dd.layers[li].items.includes(sel)) dd.layers[li].items.push(sel); }) },
    { label: 'Gewähltes Element entfernen', icon: 'close', disabled: !sel || !l.items.includes(sel), action: () => commit((dd) => { dd.layers[li].items = dd.layers[li].items.filter(x => x !== sel); }) },
    { label: 'Umbenennen', icon: 'params', action: async () => { const n = await promptDialog('Layer umbenennen', 'Name', l.name); if (n) await commit((dd) => { dd.layers[li].name = n.trim(); }); } },
    '-', { label: 'Löschen', icon: 'close', disabled: !!l.rule, action: () => commit((dd) => { dd.layers.splice(li, 1); }) },
  ]);
}
function folderTree() {
  const rows = App.files.map(f => el('div', { class: 'trow file', title: `${f.path} · ${(f.size / 1024).toFixed(0)} KB`,
    ondblclick: () => openFile(f.path),
    oncontextmenu: (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [
      { label: 'Öffnen', icon: 'open', action: () => openFile(f.path) },
      isAsm() && ['part', 'assembly'].includes(f.kind) ? { label: 'In aktive Baugruppe einbauen', icon: 'assemble', action: async () => { await commit((data) => { data.components.push(newComponent(f.path, stem(f.path).toUpperCase())); }); } } : null,
      isPart() && ['step', 'iges', 'stl'].includes(f.kind) ? { label: 'In aktives Part importieren', icon: 'import', action: async () => { await busy('Importiere…', async () => { const m = await readForeign(f.path, f.kind); await commit((data) => insertFeature(data, importFeature(data, `Import ${f.name}`, m.length > 1 ? G.concatGeoms(m.map(x => x.geom)) : m[0].geom, f.path))); }); } } : null,
      App.desktop
        ? { label: 'Kopie speichern unter…', icon: 'export', action: async () => { const p = await nativeApi()?.save_copy(f.path); if (p) toast(`Kopie gespeichert: ${p}`, 'ok'); } }
        : { label: 'Herunterladen', icon: 'export', action: () => { window.open(`/api/file?path=${encodeURIComponent(f.path)}&download=1`); } },
      { label: App.server?.platform === 'Darwin' ? 'Im Finder zeigen' : 'Im Explorer zeigen', icon: 'folder', action: () => apiJson('/api/reveal', { path: f.path }).catch(e => toast(e.message, 'err')) },
    ]); } },
  icon(fileIcon(f.kind)), el('span', { class: 'tn' }, f.path), el('span', { class: 'tc' }, KIND_LABEL[f.kind])));
  return el('div', { class: 'tree' },
    el('div', { class: 'row pad' }, el('button', { class: 'btn sm', onclick: () => refreshFiles() }, icon('refresh'), 'Aktualisieren'), el('button', { class: 'btn sm', onclick: () => workdirDialog(false) }, icon('workdir'), 'Wechseln'),
      App.files.some(f => f.legacy) ? el('button', { class: 'btn sm', title: 'Dateien im alten Format umwandeln', onclick: () => offerLegacyMigration(true) }, icon('refresh'), 'Alte umwandeln') : null,
      el('button', { class: 'btn sm', title: 'Arbeitsverzeichnis im Explorer/Finder öffnen', onclick: () => apiJson('/api/reveal', {}).catch(e => toast(e.message, 'err')) }, icon('folder'), 'Öffnen')),
    el('div', { class: 'muted small pad path' }, App.server?.workdir || ''),
    rows.length ? rows : el('div', { class: 'muted pad small' }, 'Keine CAD-Dateien im Arbeitsverzeichnis.'));
}

function renderDocTabs() {
  syncDirty();
  $('#doctabs').replaceChildren(...App.docs.map(d => el('div', { class: `doctab ${d === App.active ? 'on' : ''}`, onclick: () => { if (d !== App.active) activate(d); } },
    icon(d.kind === 'part' ? 'part' : 'assembly'), el('span', {}, `${d.data.name}${d.dirty ? ' *' : ''}`),
    el('button', { class: 'x', title: 'Fenster schließen', onclick: (e) => { e.stopPropagation(); closeDoc(d); } }, '×'))));
}

// =====================================================================================
// Tastatur
// =====================================================================================
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase(); const mod = e.ctrlKey || e.metaKey;
    if (App.sketcher) { if (e.key === 'Enter') { /* nichts */ } return; }
    if (e.key === 'Escape') { if (App.picking) clearPick(App.picking.multi ? [] : null); else { App.sel = []; clearSelHl(); highlightTree(null); } return; }
    if (e.key === 'Enter' && App.picking) { clearPick(App.picking.multi ? [] : null); return; }
    if (mod && k === 's') { e.preventDefault(); runCmd('save'); } else if (mod && k === 'z') { e.preventDefault(); runCmd('undo'); }
    else if (mod && k === 'y') { e.preventDefault(); runCmd('redo'); } else if (mod && k === 'g') { e.preventDefault(); runCmd('regen'); }
    else if (mod && k === 'd') { e.preventDefault(); runCmd('standard'); } else if (mod && k === 'r') { e.preventDefault(); runCmd('repaint'); }
    else if (mod && k === 'o') { e.preventDefault(); runCmd('open'); } else if (mod && k === 'n') { e.preventDefault(); runCmd('new'); }
    else if (e.key === 'Delete' && App.treeSel && !App.dash) {
      const d = doc(); if (isPart(d)) { const f = d.data.features.find(x => x.id === App.treeSel); if (f) deleteFeature(f); }
    }
  });
}

init();
