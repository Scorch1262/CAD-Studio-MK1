// 2D-Skizzierer auf einer Ebene (an Creo "Skizze" angelehnt)
import * as THREE from '../vendor/three.module.js';
import * as G from './geom.js';
import { el, fmt, uid, evalExpr } from './util.js';
import { MM, DEG, parseDimInput, entityDims, handlesOf as dimHandles, handlePoints, setHandle, sketchDimValue } from './dims.js';
import { contextMenu } from './ui.js';

const COL = { ent: 0x7fd4ff, sel: 0xffb020, cons: 0x8a95a5, ref: 0x5c6b7d, prev: 0xffe066, center: 0xb48cff };
const nice = (x) => { const e = Math.pow(10, Math.floor(Math.log10(x))); const m = x / e; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e; };

export const SKETCH_TOOLS = [
  ['select', 'Auswählen', 'select'], ['line', 'Linie', 'line'], ['rect', 'Rechteck', 'rect'], ['circle', 'Kreis', 'circle'],
  ['arc', 'Bogen (3 Punkte)', 'arc'], ['centerline', 'Mittellinie', 'centerline'], ['polygon', 'Polygon', 'polygon'],
  ['slot', 'Langloch', 'slot'], ['fillet', 'Verrundung', 'round'], ['project', 'Kante übernehmen', 'project'], ['dim', 'Bemaßung', 'dim'],
];

export class Sketcher {
  constructor({ viewer, frame, entities, params, refsEdges, panel, status, onChange, ask, dims, planeName }) {
    this.dims = (dims || []).map(d => JSON.parse(JSON.stringify(d)));
    this.planeName = planeName || 'Skizzierebene';
    this.badge = el('div', { class: 'plane-badge' }, el('span', { class: 'pb-k' }, 'Skizzierebene'), el('b', {}, this.planeName));
    viewer.el.append(this.badge);
    this.ask = ask || (async (t, l, v) => prompt(l, v));
    this.v = viewer; this.frame = frame; this.params = params || {};
    this.entities = (entities || []).map(e => ({ ...e, id: e.id || uid('e') }));
    this.panel = panel; this.status = status || (() => {}); this.onChange = onChange || (() => {});
    this.group = new THREE.Group(); this.group.renderOrder = 10; viewer.overlay.add(this.group);
    this.gEnt = new THREE.Group(); this.gPrev = new THREE.Group(); this.gGrid = new THREE.Group(); this.gRef = new THREE.Group(); this.gDim = new THREE.Group();
    this.group.add(this.gGrid, this.gRef, this.gEnt, this.gDim, this.gPrev);
    this.tool = 'line'; this.pts = []; this.sel = new Set(); this.gridSnap = true; this.polyN = 6;
    this.undoStack = [];
    // Referenzen: Kanten in der Skizzenebene
    this.refs = [];
    if (refsEdges) {
      const p = refsEdges.attributes.position.array; const tol = 1e-3;
      for (let i = 0; i < p.length; i += 6) {
        const a = this.to2(new THREE.Vector3(p[i], p[i + 1], p[i + 2])), b = this.to2(new THREE.Vector3(p[i + 3], p[i + 4], p[i + 5]));
        if (Math.abs(a.w) < tol && Math.abs(b.w) < tol) this.refs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 16), new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, side: THREE.DoubleSide }));
    this.marker.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.x, frame.y, frame.n));
    this.marker.renderOrder = 20; this.marker.visible = false; this.group.add(this.marker);
    this._gridStep = 0;
    viewer.inputCapture = this;
    this._key = (e) => this.key(e); window.addEventListener('keydown', this._key);
    this._frame = () => { const s = nice(this.v.pxToWorld(22)); if (s !== this._gridStep) { this._gridStep = s; this.drawGrid(); this.redraw(); } };
    this.prevFrame = viewer.onFrame; viewer.onFrame = (t) => { this.prevFrame?.(t); this._frame(); };
    this.drawRefs(); this.redraw(); this.renderPanel();
  }

  dispose() {
    this.badge.remove();
    this.v.overlay.remove(this.group); this.v.inputCapture = null; this.v.onFrame = this.prevFrame;
    window.removeEventListener('keydown', this._key); this.v.clearLabels('sketch'); this.v.request();
  }

  // ------------------------------------------------------------ Koordinaten
  to2(p) { const d = p.clone().sub(this.frame.o); return { x: d.dot(this.frame.x), y: d.dot(this.frame.y), w: d.dot(this.frame.n) }; }
  to3(x, y, w = 0) { return this.frame.to3(x, y, w); }
  resolved() { return G.resolveEntities(this.entities, this.params); }

  keyPoints() {
    const out = [{ x: 0, y: 0, kind: 'origin' }];
    for (const e of this.resolved()) {
      if (e.type === 'line' || e.type === 'centerline') out.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, kind: 'mid' });
      else if (e.type === 'rect') out.push({ x: e.x, y: e.y }, { x: e.x + e.w, y: e.y }, { x: e.x, y: e.y + e.h }, { x: e.x + e.w, y: e.y + e.h }, { x: e.x + e.w / 2, y: e.y + e.h / 2, kind: 'mid' });
      else if (['circle', 'polygon'].includes(e.type)) out.push({ x: e.cx, y: e.cy });
      else if (e.type === 'arc') { const a0 = e.a0 * Math.PI / 180, a1 = e.a1 * Math.PI / 180; out.push({ x: e.cx, y: e.cy }, { x: e.cx + e.r * Math.cos(a0), y: e.cy + e.r * Math.sin(a0) }, { x: e.cx + e.r * Math.cos(a1), y: e.cy + e.r * Math.sin(a1) }); }
      else if (e.type === 'slot') out.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
    }
    for (const r of this.refs) out.push({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2, kind: 'mid' });
    return out;
  }

  /** Mausposition -> gefangener 2D-Punkt */
  snap(ev, noSnap = false) {
    const p3 = this.v.rayToPlane(ev, this.frame); if (!p3) return null;
    let p = this.to2(p3); const tol = this.v.pxToWorld(10);
    if (noSnap || ev.shiftKey) return { x: p.x, y: p.y, snapped: false };
    let best = null, bd = tol;
    for (const k of this.keyPoints()) { const d = Math.hypot(k.x - p.x, k.y - p.y); if (d < bd) { bd = d; best = k; } }
    if (best) return { x: best.x, y: best.y, snapped: true };
    // Horizontal/vertikal zum letzten Punkt bzw. zu den Referenzachsen
    const last = this.pts[this.pts.length - 1];
    let x = p.x, y = p.y;
    if (this.gridSnap) { const s = this._gridStep || 1; x = Math.round(x / s) * s; y = Math.round(y / s) * s; }
    if (last) { if (Math.abs(p.x - last.x) < tol) x = last.x; if (Math.abs(p.y - last.y) < tol) y = last.y; }
    if (Math.abs(p.x) < tol) x = 0; if (Math.abs(p.y) < tol) y = 0;
    return { x: +x.toFixed(6), y: +y.toFixed(6), snapped: false };
  }

  // ------------------------------------------------------------ Zeichnen
  lineObj(pts2, color, dashed = false, w = 0) {
    const pts = pts2.map(p => this.to3(p.x, p.y, w));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: this.v.pxToWorld(8), gapSize: this.v.pxToWorld(5), depthTest: false })
      : new THREE.LineBasicMaterial({ color, depthTest: false });
    const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); l.renderOrder = 15; return l;
  }
  entPoints(e) {
    switch (e.type) {
      case 'line': case 'centerline': return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
      case 'rect': { const { loops } = G.sketchLoops([e]); const l = loops[0]; return [...l, l[0]]; }
      case 'circle': return G.arcPoints(e.cx, e.cy, e.r, 0, Math.PI * 2, 96);
      case 'arc': return G.arcPoints(e.cx, e.cy, e.r, e.a0 * Math.PI / 180, e.a1 * Math.PI / 180, 96);
      case 'polygon': case 'slot': { const { loops } = G.sketchLoops([e]); const l = loops[0]; return l ? [...l, l[0]] : []; }
      default: return [];
    }
  }
  drawGrid() {
    this.gGrid.clear(); const s = this._gridStep; if (!s) return;
    const n = 40; const pts = [];
    const c = this.to2(this.v.pivot); const cx = Math.round(c.x / s) * s, cy = Math.round(c.y / s) * s;
    for (let i = -n; i <= n; i++) {
      pts.push(this.to3(cx + i * s, cy - n * s), this.to3(cx + i * s, cy + n * s), this.to3(cx - n * s, cy + i * s), this.to3(cx + n * s, cy + i * s));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a4a5c, transparent: true, opacity: 0.35, depthTest: false }));
    ls.renderOrder = 11; this.gGrid.add(ls);
  }
  drawRefs() {
    this.gRef.clear(); const L = 1e4;
    this.gRef.add(this.lineObj([{ x: -L, y: 0 }, { x: L, y: 0 }], COL.ref, true), this.lineObj([{ x: 0, y: -L }, { x: 0, y: L }], COL.ref, true));
    for (const r of this.refs) this.gRef.add(this.lineObj([{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }], 0x4f9bd0, true));
  }
  redraw() {
    this.gEnt.clear(); this.v.clearLabels('sketch');
    let ents; try { ents = this.resolved(); } catch { ents = []; }
    ents.forEach((e, i) => {
      const id = this.entities[i].id; const selected = this.sel.has(id);
      const color = selected ? COL.sel : e.type === 'centerline' ? COL.center : e.construction ? COL.cons : COL.ent;
      let pts = this.entPoints(e);
      if (e.type === 'centerline') { const dx = e.x2 - e.x1, dy = e.y2 - e.y1, l = Math.hypot(dx, dy) || 1; pts = [{ x: e.x1 - dx / l * 1e4, y: e.y1 - dy / l * 1e4 }, { x: e.x1 + dx / l * 1e4, y: e.y1 + dy / l * 1e4 }]; }
      if (pts.length) { const o = this.lineObj(pts, color, e.type === 'centerline' || !!e.construction); o.userData.entId = id; this.gEnt.add(o); }
      this.dimLabels(e, i);
    });
    this.drawDims();
    // Punkte
    const kp = this.keyPoints().filter(k => !k.kind);
    const g = new THREE.BufferGeometry().setFromPoints(kp.map(k => this.to3(k.x, k.y)));
    const pm = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false, depthTest: false })); pm.renderOrder = 16; this.gEnt.add(pm);
    this.v.request();
    let msg = '';
    try { const r = G.sketchLoops(ents); msg = `${r.loops.length} geschlossene Kontur(en)` + (r.open ? ` · ${r.open} offene Kette(n)` : ''); } catch (e) { msg = e.message; }
    this.status(msg);
  }

  /** Bemaßungen als anklickbare Beschriftung (alle Laengen in mm) */
  dimLabels(e, i) {
    const src = this.entities[i];
    for (const d of entityDims(src, e, this.v.pxToWorld(14), this.params, (ox, oy, nx, ny, ex) => this.movePoint(ox, oy, nx, ny, ex))) {
      const l = this.v.addLabel(d.text, this.to3(d.x, d.y), 'dim', 'sketch');
      l.el.title = 'Klicken zum Ändern (Wert in mm oder Ausdruck)';
      l.el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.editDim(l.el, d.start, d.apply); });
    }
  }
  editDim(labelEl, start, apply) {
    const inp = el('input', { class: 'dim-edit', value: start });
    labelEl.replaceChildren(inp, el('span', { class: 'dim-unit' }, 'mm')); setTimeout(() => { inp.focus(); inp.select(); }, 0);
    let finished = false;
    const done = (ok) => {
      if (finished) return; finished = true;
      if (ok) {
        try { const v = parseDimInput(inp.value, this.params); this.pushUndo(); apply(v); }
        catch (err) { this.status(err.message); }
      }
      this.changed();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('blur', () => done(true), { once: true });
  }

  // ------------------------------------------------------------ Bemassungswerkzeug (steuernde Masse)
  /** Punkt einer Massreferenz {origin} | {ent, h} in Skizzenkoordinaten */
  refPoint(ref) {
    if (!ref) return null;
    if (ref.origin) return { x: 0, y: 0 };
    const i = this.entities.findIndex(e => e.id === ref.ent); if (i < 0) return null;
    const e = this.resolved()[i]; const pt = handlePoints(e)[ref.h]; return pt ? { ...pt } : null;
  }
  /** naechster Griffpunkt (Endpunkt, Mittelpunkt, Ecke) oder Ursprung */
  pickHandle(p) {
    const tol = this.v.pxToWorld(10); let best = null, bd = tol;
    if (Math.hypot(p.x, p.y) < bd) { best = { origin: true }; bd = Math.hypot(p.x, p.y); }
    this.resolved().forEach((e, i) => {
      handlePoints(e).forEach((pt, h) => { const d = Math.hypot(pt.x - p.x, pt.y - p.y); if (d < bd) { bd = d; best = { ent: this.entities[i].id, h }; } });
    });
    return best;
  }
  dimClick(ev, p) {
    const raw = this.to2(this.v.rayToPlane(ev, this.frame) || this.to3(p.x, p.y)); const q = { x: raw.x, y: raw.y };
    const h = this.pickHandle(q);
    if (!this.dimA) {
      if (h) { this.dimA = h; this.status('Bemaßung: zweiten Punkt (oder Ursprung) anklicken – Esc bricht ab', 'pick'); this.redraw(); return; }
      const ent = this.hitEntity(q);
      if (ent?.type === 'line') { this.addDim({ type: 'angle', a: { ent: ent.id, h: 0 } }); return; }
      this.status('Bemaßung: Punkt (Endpunkt, Mittelpunkt, Ecke, Ursprung) oder Linie (Winkel) anklicken'); return;
    }
    if (!h || JSON.stringify(h) === JSON.stringify(this.dimA)) { this.status('Bitte einen anderen Punkt wählen'); return; }
    const a = this.dimA; this.dimA = null;
    const r = this.v.renderer.domElement.getBoundingClientRect();
    const mk = (type) => this.addDim(h.origin ? { type, a: h, b: a } : { type, a, b: h });
    contextMenu(ev.clientX ?? r.left + 20, ev.clientY ?? r.top + 20, [
      { label: 'Abstand (direkt)', icon: 'dim', action: () => mk('dist') },
      { label: 'Horizontaler Abstand', icon: 'dim', action: () => mk('hdist') },
      { label: 'Vertikaler Abstand', icon: 'dim', action: () => mk('vdist') },
    ]);
    this.redraw();
  }
  addDim(d) { this.pushUndo(); d.id = uid('d'); this.dims.push(d); this.changed(); this.status(`Maß angelegt – Wert anklicken zum Ändern`); }
  /** Steuerndes Mass auf neuen Wert setzen: zweiten Punkt verschieben (bzw. Linie drehen) */
  driveDim(d, v) {
    if (typeof v !== 'number') v = evalExpr(v, this.params);
    if (d.type === 'angle') {
      const i = this.entities.findIndex(e => e.id === d.a.ent); if (i < 0) return;
      const e = this.resolved()[i]; const src = this.entities[i];
      const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1); const t = v * Math.PI / 180;
      const nx = e.x1 + len * Math.cos(t), ny = e.y1 + len * Math.sin(t);
      this.movePoint(Number(e.x2), Number(e.y2), nx, ny, src); src.x2 = +nx.toFixed(6); src.y2 = +ny.toFixed(6); return;
    }
    if (!(v >= 0)) throw new Error('Abstand muss ≥ 0 mm sein');
    const moveRef = d.b.origin ? d.a : d.b; const fixRef = d.b.origin ? d.b : d.a;
    const A = this.refPoint(fixRef), B = this.refPoint(moveRef); if (!A || !B) return;
    let nb = { ...B };
    if (d.type === 'hdist') nb.x = A.x + (Math.sign(B.x - A.x) || 1) * v;
    else if (d.type === 'vdist') nb.y = A.y + (Math.sign(B.y - A.y) || 1) * v;
    else { const L = Math.hypot(B.x - A.x, B.y - A.y); const ux = L ? (B.x - A.x) / L : 1, uy = L ? (B.y - A.y) / L : 0; nb = { x: A.x + ux * v, y: A.y + uy * v }; }
    const i = this.entities.findIndex(e => e.id === moveRef.ent); if (i < 0) return;
    const src = this.entities[i];
    if (src.type !== 'rect') this.movePoint(B.x, B.y, nb.x, nb.y, src);
    setHandle(src, this.resolved()[i], moveRef.h, nb.x, nb.y, fixRef.ent === moveRef.ent);
  }
  drawDims() {
    this.gDim.clear();
    this.dims = this.dims.filter(d => this.refPoint(d.a) && (d.type === 'angle' || this.refPoint(d.b)));
    const col = 0xffb020;
    for (const d of this.dims) {
      const val = sketchDimValue(d, (r) => this.refPoint(r)); if (val === null) continue;
      const A = this.refPoint(d.a); let pos;
      if (d.type === 'angle') {
        const i = this.entities.findIndex(e => e.id === d.a.ent); const e = this.resolved()[i];
        const r = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) * 0.35; const a1 = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
        this.gDim.add(this.lineObj(G.arcPoints(A.x, A.y, r, Math.min(0, a1), Math.max(0, a1), 32), col, true));
        this.gDim.add(this.lineObj([{ x: A.x, y: A.y }, { x: A.x + r * 1.2, y: A.y }], col, true));
        pos = { x: A.x + r * Math.cos(a1 / 2) * 1.25, y: A.y + r * Math.sin(a1 / 2) * 1.25 };
      } else {
        const B = this.refPoint(d.b);
        let pa = A, pb = B;
        if (d.type === 'hdist') { pa = { x: A.x, y: B.y }; this.gDim.add(this.lineObj([A, pa], col, true)); }
        if (d.type === 'vdist') { pa = { x: B.x, y: A.y }; this.gDim.add(this.lineObj([A, pa], col, true)); }
        this.gDim.add(this.lineObj([pa, pb], col));
        pos = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      }
      const txt = d.type === 'angle' ? DEG(val) : `${d.type === 'hdist' ? '↔ ' : d.type === 'vdist' ? '↕ ' : ''}${MM(val)}`;
      const l = this.v.addLabel(txt, this.to3(pos.x, pos.y), 'dim drv', 'sketch');
      l.el.title = 'Steuerndes Maß – Klicken zum Ändern, Rechtsklick löscht';
      l.el.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        if (ev.button === 2) { this.pushUndo(); this.dims = this.dims.filter(x => x !== d); this.changed(); return; }
        this.editDimDrv(l.el, d, val);
      });
      l.el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    }
    if (this.dimA) { const A = this.refPoint(this.dimA); if (A) { const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints([this.to3(A.x, A.y)]), new THREE.PointsMaterial({ color: col, size: 10, sizeAttenuation: false, depthTest: false })); m.renderOrder = 22; this.gDim.add(m); } }
  }
  editDimDrv(labelEl, d, val) {
    const inp = el('input', { class: 'dim-edit', value: fmt(val, 4) });
    labelEl.replaceChildren(inp, el('span', { class: 'dim-unit' }, d.type === 'angle' ? '°' : 'mm')); setTimeout(() => { inp.focus(); inp.select(); }, 0);
    let finished = false;
    const done = (ok) => {
      if (finished) return; finished = true;
      if (ok) { try { const v = parseDimInput(inp.value, this.params); this.pushUndo(); this.driveDim(d, v); } catch (err) { this.status(err.message); } }
      this.changed();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('blur', () => done(true), { once: true });
  }

  /** Koinzidente Endpunkte anderer Elemente mitziehen */
  movePoint(ox, oy, nx, ny, except) {
    const same = (a, b) => Math.abs(Number(a) - ox) < 1e-6 && Math.abs(Number(b) - oy) < 1e-6;
    for (const e of this.entities) {
      if (e === except) continue;
      if (['line', 'centerline', 'slot'].includes(e.type)) {
        if (same(e.x1, e.y1)) { e.x1 = nx; e.y1 = ny; }
        if (same(e.x2, e.y2)) { e.x2 = nx; e.y2 = ny; }
      }
    }
  }

  // ------------------------------------------------------------ Eingabe
  setTool(t) { this.tool = t; this.pts = []; this.gPrev.clear(); this.v.request(); this.renderPanel(); const hints = {
    select: 'Element anklicken; Punkte ziehen; Entf löscht', line: 'Punkte klicken – Doppelklick/Esc beendet die Kette',
    rect: 'Zwei Eckpunkte klicken', circle: 'Mittelpunkt, dann Radius', arc: 'Startpunkt, Endpunkt, dann Punkt auf dem Bogen',
    centerline: 'Zwei Punkte für die Mittellinie (Rotationsachse)', polygon: 'Mittelpunkt, dann Eckpunkt', slot: 'Mittelpunkt 1, Mittelpunkt 2, dann Radius',
    fillet: 'Ecke zwischen zwei Linien anklicken', project: 'Blaue Referenzkante anklicken, um sie als Linie zu übernehmen',
    dim: 'Bemaßung: zwei Punkte (Endpunkte, Mittelpunkte, Ecken, Ursprung) für einen Abstand oder eine Linie für ihren Winkel anklicken' };
    this.dimA = null;
    this.status(hints[t] || ''); }
  pushUndo() { this.undoStack.push(JSON.stringify({ e: this.entities, d: this.dims })); if (this.undoStack.length > 100) this.undoStack.shift(); }
  undo() { const s = this.undoStack.pop(); if (s) { const o = JSON.parse(s); this.entities = o.e; this.dims = o.d || []; this.sel.clear(); this.changed(); } }
  add(e) { this.pushUndo(); e.id = uid('e'); this.entities.push(e); this.changed(); return e; }
  changed() { this.redraw(); this.renderPanel(); this.onChange(this.entities); }

  move(ev) {
    const p = this.snap(ev); if (!p) return;
    this.marker.visible = true; this.marker.position.copy(this.to3(p.x, p.y)); this.marker.scale.setScalar(this.v.pxToWorld(p.snapped ? 7 : 4));
    this.preview(p); this.v.request(); this.cursor = p;
  }
  preview(p) {
    this.gPrev.clear(); const a = this.pts[0]; if (!a) return;
    const tmp = this.makeEntity(p, true); if (!tmp) return;
    for (const e of [].concat(tmp)) this.gPrev.add(this.lineObj(this.entPoints(e), COL.prev));
  }
  makeEntity(p, preview = false) {
    const a = this.pts[0], b = this.pts[1];
    switch (this.tool) {
      case 'line': { const l = this.pts[this.pts.length - 1]; return { type: 'line', x1: l.x, y1: l.y, x2: p.x, y2: p.y }; }
      case 'centerline': return { type: 'centerline', x1: a.x, y1: a.y, x2: p.x, y2: p.y };
      case 'rect': return { type: 'rect', x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y), r: 0 };
      case 'circle': return { type: 'circle', cx: a.x, cy: a.y, r: Math.hypot(p.x - a.x, p.y - a.y) };
      case 'polygon': return { type: 'polygon', cx: a.x, cy: a.y, r: Math.hypot(p.x - a.x, p.y - a.y), n: this.polyN, rot: +(Math.atan2(p.y - a.y, p.x - a.x) * 180 / Math.PI).toFixed(4) };
      case 'slot': if (!b) return preview ? { type: 'line', x1: a.x, y1: a.y, x2: p.x, y2: p.y } : null;
        { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; const r = Math.abs((p.x - a.x) * -dy / l + (p.y - a.y) * dx / l); return { type: 'slot', x1: a.x, y1: a.y, x2: b.x, y2: b.y, r: Math.max(r, 1e-3) }; }
      case 'arc': if (!b) return preview ? { type: 'line', x1: a.x, y1: a.y, x2: p.x, y2: p.y } : null;
        return arc3(a, b, p);
      default: return null;
    }
  }
  click(ev) {
    const p = this.snap(ev); if (!p) return;
    const t = this.tool;
    if (t === 'select') { this.selectAt(ev, p); return; }
    if (t === 'fillet') { this.filletAt(p); return; }
    if (t === 'project') { this.projectAt(p); return; }
    if (t === 'dim') { this.dimClick(ev, p); return; }
    this.pts.push(p);
    const need = { line: 0, centerline: 2, rect: 2, circle: 2, polygon: 2, slot: 3, arc: 3 }[t];
    if (t === 'line') {
      if (this.pts.length >= 2) {
        const l = this.pts[this.pts.length - 2];
        if (Math.hypot(l.x - p.x, l.y - p.y) > 1e-9) { const save = this.pts; this.pts = [l]; this.add(this.makeEntity(p)); this.pts = save; }
        if (this.pts.length > 2 && Math.hypot(this.pts[0].x - p.x, this.pts[0].y - p.y) < 1e-9) this.pts = []; // geschlossen
      }
      return;
    }
    if (this.pts.length >= need) {
      const e = this.makeEntity(p); this.pts = []; this.gPrev.clear();
      const degenerate = (e?.type === 'rect' && (!e.w || !e.h)) || (['circle', 'polygon', 'slot', 'arc'].includes(e?.type) && !(e.r > 1e-9)) || (e?.type === 'centerline' && e.x1 === e.x2 && e.y1 === e.y2);
      if (e && !degenerate) this.add(e);
    }
  }
  dblclick() { if (this.tool === 'line') { this.pts = []; this.gPrev.clear(); this.v.request(); } }
  context() { if (this.dimA) { this.dimA = null; this.redraw(); return; } if (this.pts.length) { this.pts = []; this.gPrev.clear(); this.v.request(); } else this.setTool('select'); }

  hitEntity(p) {
    const tol = this.v.pxToWorld(8); let best = null, bd = tol;
    this.resolved().forEach((e, i) => {
      const pts = this.entPoints(e);
      for (let k = 0; k < pts.length - 1; k++) { const d = segDist(p, pts[k], pts[k + 1]); if (d < bd) { bd = d; best = this.entities[i]; } }
    });
    return best;
  }
  selectAt(ev, p) {
    const e = this.hitEntity(p);
    if (!ev.ctrlKey && !ev.shiftKey) this.sel.clear();
    if (e) { if (this.sel.has(e.id)) this.sel.delete(e.id); else this.sel.add(e.id); }
    this.redraw(); this.renderPanel();
  }
  // Ziehen von Punkten im Auswahlmodus
  down(ev) {
    if (this.tool !== 'select') return;
    const p3 = this.v.rayToPlane(ev, this.frame); if (!p3) return; const p = this.to2(p3); const tol = this.v.pxToWorld(8);
    this.dragPt = null;
    for (const e of this.entities) {
      for (const [kx, ky] of handlesOf(e)) {
        if (Math.hypot(Number(e[kx]) - p.x, Number(e[ky]) - p.y) < tol) { this.dragPt = { e, kx, ky, ox: Number(e[kx]), oy: Number(e[ky]) }; this.pushUndo(); return; }
      }
    }
  }
  drag(ev) {
    if (!this.dragPt) return; const p = this.snap(ev); if (!p) return;
    const d = this.dragPt; const ox = Number(d.e[d.kx]), oy = Number(d.e[d.ky]);
    d.e[d.kx] = p.x; d.e[d.ky] = p.y; this.movePoint(ox, oy, p.x, p.y, d.e); this.redraw();
  }
  up() { if (this.dragPt) { this.dragPt = null; this.changed(); } }

  async filletAt(p) {
    const tol = this.v.pxToWorld(10); const lines = this.entities.filter(e => e.type === 'line');
    const at = [];
    for (const l of lines) {
      if (Math.hypot(l.x1 - p.x, l.y1 - p.y) < tol) at.push([l, 1]); else if (Math.hypot(l.x2 - p.x, l.y2 - p.y) < tol) at.push([l, 2]);
    }
    if (at.length !== 2) { this.status('Ecke muss genau zwei Linien verbinden'); return; }
    const ans = await this.ask('Verrundung', 'Radius', String(nice(this.v.pxToWorld(40)))); const r = Number(String(ans ?? '').replace(',', '.'));
    if (!(r > 0)) return;
    const [[l1, e1], [l2, e2]] = at;
    const C = { x: e1 === 1 ? l1.x1 : l1.x2, y: e1 === 1 ? l1.y1 : l1.y2 };
    const far = (l, e) => ({ x: e === 1 ? l.x2 : l.x1, y: e === 1 ? l.y2 : l.y1 });
    const A = far(l1, e1), B = far(l2, e2);
    const ua = norm({ x: A.x - C.x, y: A.y - C.y }), ub = norm({ x: B.x - C.x, y: B.y - C.y });
    const ang = Math.acos(Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y)));
    if (ang < 1e-3 || ang > Math.PI - 1e-3) { this.status('Linien sind parallel'); return; }
    const t = r / Math.tan(ang / 2);
    const la = Math.hypot(A.x - C.x, A.y - C.y), lb = Math.hypot(B.x - C.x, B.y - C.y);
    if (t > la - 1e-6 || t > lb - 1e-6) { this.status('Radius zu groß für diese Ecke'); return; }
    this.pushUndo();
    const T1 = { x: C.x + ua.x * t, y: C.y + ua.y * t }, T2 = { x: C.x + ub.x * t, y: C.y + ub.y * t };
    const bis = norm({ x: ua.x + ub.x, y: ua.y + ub.y }); const dc = r / Math.sin(ang / 2);
    const M = { x: C.x + bis.x * dc, y: C.y + bis.y * dc };
    if (e1 === 1) { l1.x1 = T1.x; l1.y1 = T1.y; } else { l1.x2 = T1.x; l1.y2 = T1.y; }
    if (e2 === 1) { l2.x1 = T2.x; l2.y1 = T2.y; } else { l2.x2 = T2.x; l2.y2 = T2.y; }
    let a0 = Math.atan2(T1.y - M.y, T1.x - M.x), a1 = Math.atan2(T2.y - M.y, T2.x - M.x);
    let sweep = a1 - a0; while (sweep <= 0) sweep += 2 * Math.PI; if (sweep > Math.PI) [a0, a1] = [a1, a0];
    this.entities.push({ id: uid('e'), type: 'arc', cx: M.x, cy: M.y, r, a0: a0 * 180 / Math.PI, a1: a1 * 180 / Math.PI });
    this.changed();
  }
  projectAt(p) {
    const tol = this.v.pxToWorld(8);
    const r = this.refs.find(s => segDist(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < tol);
    if (r) this.add({ type: 'line', x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
    else this.status('Keine Referenzkante getroffen');
  }
  deleteSelected() { if (!this.sel.size) return; this.pushUndo(); this.entities = this.entities.filter(e => !this.sel.has(e.id)); this.sel.clear(); this.changed(); }
  toggleConstruction() { this.pushUndo(); for (const e of this.entities) if (this.sel.has(e.id)) e.construction = !e.construction; this.changed(); }
  key(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape' && this.dimA) { this.dimA = null; this.redraw(); return; }
    if (e.key === 'Escape') { if (this.pts.length) { this.pts = []; this.gPrev.clear(); this.v.request(); } else this.setTool('select'); }
    else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); this.undo(); }
  }

  // ------------------------------------------------------------ Elementliste mit Werten
  renderPanel() {
    if (!this.panel) return;
    const FIELDS = { line: ['x1', 'y1', 'x2', 'y2'], centerline: ['x1', 'y1', 'x2', 'y2'], rect: ['x', 'y', 'w', 'h', 'r'], circle: ['cx', 'cy', 'r'],
      arc: ['cx', 'cy', 'r', 'a0', 'a1'], polygon: ['cx', 'cy', 'r', 'n', 'rot'], slot: ['x1', 'y1', 'x2', 'y2', 'r'] };
    const NAMES = { line: 'Linie', centerline: 'Mittellinie', rect: 'Rechteck', circle: 'Kreis', arc: 'Bogen', polygon: 'Polygon', slot: 'Langloch' };
    const rows = this.entities.map((e, i) => {
      const f = FIELDS[e.type] || [];
      return el('div', { class: `sk-ent ${this.sel.has(e.id) ? 'sel' : ''}`, onclick: (ev) => { if (ev.target.tagName === 'INPUT') return; if (!ev.ctrlKey) this.sel.clear(); this.sel.add(e.id); this.redraw(); this.renderPanel(); } },
        el('div', { class: 'sk-ent-h' }, `${i + 1}. ${NAMES[e.type] || e.type}${e.construction ? ' (Konstruktion)' : ''}`),
        el('div', { class: 'sk-fields' }, f.map(k => el('label', {}, `${k} ${['a0', 'a1', 'rot'].includes(k) ? '[°]' : k === 'n' ? '' : '[mm]'}`, el('input', { value: typeof e[k] === 'number' ? fmt(e[k], 4) : e[k] ?? '', onchange: (ev) => {
          const s = ev.target.value.trim(); try { const n = evalExpr(s, this.params); this.pushUndo();
            const num = (v) => evalExpr(v, this.params); const j = /^[xy][12]$/.test(k) ? k[1] : null;
            const old = j ? { x: num(e['x' + j]), y: num(e['y' + j]) } : null;
            e[k] = /^[-\d.,]+$/.test(s) ? n : s;
            if (old) this.movePoint(old.x, old.y, num(e['x' + j]), num(e['y' + j]), e);
            this.changed(); } catch (err) { ev.target.classList.add('err'); this.status(err.message); } } })))));
    });
    this.panel.replaceChildren(
      el('div', { class: 'panel-h' }, 'Skizzenelemente'),
      el('div', { class: 'sk-plane' }, 'Skizzierebene: ', el('b', {}, this.planeName)),
      el('div', { class: 'sk-tools' },
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: this.gridSnap, onchange: (e) => { this.gridSnap = e.target.checked; } }), 'Raster fangen'),
        el('label', {}, 'Polygon-Ecken ', el('input', { type: 'number', min: 3, max: 64, value: this.polyN, style: 'width:52px', onchange: (e) => { this.polyN = Math.max(3, +e.target.value || 6); } })),
        el('div', { class: 'row' },
          el('button', { class: 'btn sm', onclick: () => this.toggleConstruction(), disabled: !this.sel.size }, 'Konstruktion an/aus'),
          el('button', { class: 'btn sm', onclick: () => this.deleteSelected(), disabled: !this.sel.size }, 'Löschen'),
          el('button', { class: 'btn sm', onclick: () => this.undo() }, 'Rückgängig'))),
      this.dims.length ? el('div', { class: 'sk-dims' }, el('div', { class: 'sk-ent-h' }, `Steuernde Maße (${this.dims.length})`),
        this.dims.map(d => { const v = sketchDimValue(d, (r) => this.refPoint(r)); const nm = { dist: 'Abstand', hdist: 'Horizontal', vdist: 'Vertikal', angle: 'Winkel' }[d.type];
          return el('div', { class: 'sk-dim' }, el('span', {}, `${nm}: ${v === null ? '–' : d.type === 'angle' ? DEG(v) : MM(v)}`),
            el('button', { class: 'x', title: 'Maß löschen', onclick: () => { this.pushUndo(); this.dims = this.dims.filter(x => x !== d); this.changed(); } }, '×')); })) : null,
      el('div', { class: 'sk-list' }, rows.length ? rows : el('div', { class: 'muted' }, 'Noch keine Elemente. Werkzeug im Menüband wählen.')),
      el('div', { class: 'muted small' }, 'Werte akzeptieren Zahlen oder Parameter-Ausdrücke (z. B. L/2). Shift hält das Fangen aus.'));
  }
}

function handlesOf(e) {
  switch (e.type) {
    case 'line': case 'centerline': case 'slot': return [['x1', 'y1'], ['x2', 'y2']];
    case 'rect': return [['x', 'y']];
    case 'circle': case 'polygon': case 'arc': return [['cx', 'cy']];
    default: return [];
  }
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
const norm = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
function arc3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return { type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  const ang = (p) => Math.atan2(p.y - uy, p.x - ux);
  const A = ang(a), B = ang(b), C = ang(c);
  const ccw = (s, e, m) => { let se = e - s; while (se < 0) se += 2 * Math.PI; let sm = m - s; while (sm < 0) sm += 2 * Math.PI; return sm < se; };
  const deg = (x) => x * 180 / Math.PI;
  return ccw(A, B, C) ? { type: 'arc', cx: ux, cy: uy, r, a0: deg(A), a1: deg(B) } : { type: 'arc', cx: ux, cy: uy, r, a0: deg(B), a1: deg(A) };
}
