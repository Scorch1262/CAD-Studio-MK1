// Part-Dokument (Feature-Historie wie in Creo) und Regenerierung
import * as THREE from '../vendor/three.module.js';
import * as G from './geom.js';
import { evalExpr, evalParams, uid, b64ToF32, f32ToB64, b64ToU32, apiJson } from './util.js';

export const PART_FORMAT = 'browsercad-part';
export const FEATURE_INFO = {
  datumPlane: { label: 'Bezugsebene', icon: 'plane' },
  datumAxis: { label: 'Bezugsachse', icon: 'axis' },
  datumPoint: { label: 'Bezugspunkt', icon: 'point' },
  csys: { label: 'Koordinatensystem', icon: 'csys' },
  extrude: { label: 'Extrudieren', icon: 'extrude' },
  revolve: { label: 'Drehen', icon: 'revolve' },
  hole: { label: 'Bohrung', icon: 'hole' },
  round: { label: 'Rundung', icon: 'round' },
  chamfer: { label: 'Fase', icon: 'chamfer' },
  pattern: { label: 'Muster', icon: 'pattern' },
  mirror: { label: 'Spiegeln', icon: 'mirror' },
  shell: { label: 'Schale', icon: 'shell' },
  import: { label: 'Importierte Geometrie', icon: 'import' },
};

export function newPart(name = 'PRT0001') {
  const f = (id, nm, origin, normal, xdir) => ({ id, type: 'datumPlane', name: nm, params: { kind: 'fixed', origin, normal, xdir } });
  return {
    format: PART_FORMAT, version: 1, name, units: 'mm', color: '#b9c3cc',
    params: [],
    features: [
      f('RIGHT', 'RIGHT', [0, 0, 0], [1, 0, 0], [0, 0, -1]),
      f('TOP', 'TOP', [0, 0, 0], [0, 1, 0], [1, 0, 0]),
      f('FRONT', 'FRONT', [0, 0, 0], [0, 0, 1], [1, 0, 0]),
      { id: 'PRT_CSYS_DEF', type: 'csys', name: 'PRT_CSYS_DEF', params: {} },
    ],
    layers: defaultLayers('PRT'),
    insertAt: null,
    settings: { seg: 64 },
  };
}
export function defaultLayers(p) {
  return [
    { name: `01___${p}_ALL_DTM_PLN`, rule: 'datumPlane', items: [], visible: true },
    { name: `02___${p}_ALL_AXES`, rule: 'datumAxis', items: [], visible: true },
    { name: `03___${p}_ALL_DTM_PNT`, rule: 'datumPoint', items: [], visible: true },
    { name: `04___${p}_ALL_DTM_CSYS`, rule: 'csys', items: [], visible: true },
    { name: `05___${p}_DEF_DTM_PLN`, rule: 'default', items: [], visible: true },
  ];
}

export function nextName(doc, type) {
  const base = { datumPlane: 'DTM', datumAxis: 'A_', datumPoint: 'PNT', csys: 'CS' }[type];
  if (base) {
    let i = type === 'datumPoint' ? 0 : 1;
    while (doc.features.some(f => f.name === `${base}${i}`)) i++;
    return `${base}${i}`;
  }
  const label = FEATURE_INFO[type]?.label || type; let i = 1;
  while (doc.features.some(f => f.name === `${label} ${i}`)) i++;
  return `${label} ${i}`;
}
export const makeFeature = (doc, type, params) => ({ id: uid('f'), type, name: nextName(doc, type), params });

/** Ist ein Element durch Layer oder direkt ausgeblendet? */
export function hiddenByLayer(doc, f) {
  for (const l of doc.layers || []) {
    if (l.visible) continue;
    if (l.items.includes(f.id)) return true;
    if (l.rule === f.type) return true;
    if (l.rule === 'default' && ['RIGHT', 'TOP', 'FRONT'].includes(f.id)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ Regenerierung
/** Modellierkern: usd-brep (Server) oder interner Netzkern (Rueckfallebene) */
export let KERNEL = { available: false };
export function setKernel(k) { KERNEL = k && k.available ? k : { available: false, ...(k || {}) }; }

export async function regenerate(doc, opts = {}) {
  if (KERNEL.available) return regenerateKernel(doc, opts);
  return regenerateLocal(doc, opts);
}

function featureList(doc, opts) {
  const stop = doc.insertAt === null || doc.insertAt === undefined ? doc.features.length : doc.insertAt;
  const list = doc.features.map((f, i) => ({ f, rolled: i >= stop }));
  if (opts.extra) {
    const ri = opts.replaceId ? list.findIndex(x => x.f.id === opts.replaceId) : -1;
    if (ri >= 0) list[ri] = { f: opts.extra, rolled: false };
    else list.splice(stop, 0, { f: opts.extra, rolled: false });
  }
  return list;
}

/** usd-brep: Bezuege/Skizzen hier auswerten, Koerper exakt im Kern bauen */
async function regenerateKernel(doc, opts = {}) {
  const params = evalParams(doc.params);
  const seg = doc.settings?.seg || 64;
  const ctx = { params, seg, body: null, planes: new Map(), axes: new Map(), points: new Map(), csys: new Map(),
    tools: new Map(), status: new Map(), errors: [], size: 200, ops: [], imports: [], kernel: true };
  ctx.X = (v, nm = 'Wert') => { try { return evalExpr(v, params); } catch (e) { throw new Error(`${nm}: ${e.message}`); } };
  const names = new Map();
  for (const { f, rolled } of featureList(doc, opts)) {
    names.set(f.id, f.name);
    if (rolled) { ctx.status.set(f.id, 'rolledback'); continue; }
    if (f.suppressed) { ctx.status.set(f.id, 'suppressed'); continue; }
    try {
      if (OPS[f.type]) { const op = OPS[f.type](f, ctx); if (op) ctx.ops.push({ fid: f.id, kind: f.type, ...op }); ctx.status.set(f.id, 'pending'); }
      else if (f.type === 'import') { importGeom(f, ctx); ctx.status.set(f.id, 'ok'); }
      else if (BUILD[f.type]) { BUILD[f.type](f, ctx); ctx.status.set(f.id, 'ok'); }
      else throw new Error(`Unbekannter Feature-Typ ${f.type}`);
    } catch (e) { ctx.status.set(f.id, 'error'); ctx.errors.push({ id: f.id, name: f.name, msg: e.message || String(e) }); }
  }
  let res = null;
  if (ctx.ops.length) {
    try { res = await apiJson('/api/kernel/regen', { ops: ctx.ops, tools: !opts.preview }); }
    catch (e) { res = { status: Object.fromEntries(ctx.ops.map(o => [o.fid, `Kern nicht erreichbar: ${e.message}`])) }; }
    for (const o of ctx.ops) {
      const st = res.status?.[o.fid] ?? 'nicht ausgeführt';
      if (st === 'ok') ctx.status.set(o.fid, 'ok');
      else { ctx.status.set(o.fid, 'error'); ctx.errors.push({ id: o.fid, name: names.get(o.fid) || o.fid, msg: st }); }
    }
    for (const [fid, list] of Object.entries(res.tools || {})) ctx.tools.set(fid, list.map(t => ({ op: t.op, geom: G.prepGeom(geomFrom(t.pos, t.tri)) })));
  }
  // Anzeige-Netz: exakter Koerper (tesselliert) + importierte Netze
  let mesh = null, display = null, edges = null;
  const parts = [];
  if (res?.mesh) parts.push({ pos: b64ToF32(res.mesh.pos), tri: b64ToU32(res.mesh.tri) });
  for (const g of ctx.imports) { const m = G.cleanMesh(g); parts.push({ pos: m.pos, tri: m.tri }); }
  if (parts.length) {
    const np = parts.reduce((s, p) => s + p.pos.length, 0), nt = parts.reduce((s, p) => s + p.tri.length, 0);
    const pos = new Float32Array(np), tri = new Uint32Array(nt); let po = 0, to = 0;
    for (const p of parts) { pos.set(p.pos, po); for (let i = 0; i < p.tri.length; i++) tri[to + i] = p.tri[i] + po / 3; po += p.pos.length; to += p.tri.length; }
    const bb = new THREE.Box3().setFromArray(pos); const diag = bb.isEmpty() ? 1 : bb.getSize(new THREE.Vector3()).length();
    mesh = { pos, tri, tol: Math.max(1e-5, diag * 2e-7) };
    display = G.meshToGeom(mesh);
    edges = kernelEdges(res, ctx.imports);
  }
  const bb = display ? display.boundingBox.clone() : new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
  return { ...ctx, mesh, display, edges, bbox: bb, props: res?.props || null, body: display ? true : null };
}

function geomFrom(posB64, triB64) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(b64ToF32(posB64), 3)); g.setIndex(new THREE.BufferAttribute(b64ToU32(triB64), 1));
  return g;
}
/** Kanten des B-Rep (eine Polylinie je Kante) als Liniensegmente; userData: Segment -> Kante */
function kernelEdges(res, imports) {
  const seg = []; const segEdge = []; const polys = [];
  if (res?.edges) {
    const p = b64ToF32(res.edges.pts); let o = 0;
    res.edges.counts.forEach((n, ei) => {
      const pl = []; for (let k = 0; k < n; k++) pl.push([p[(o + k) * 3], p[(o + k) * 3 + 1], p[(o + k) * 3 + 2]]);
      polys.push(pl);
      for (let k = 0; k + 1 < n; k++) { seg.push(...pl[k], ...pl[k + 1]); segEdge.push(ei); }
      o += n;
    });
  }
  for (const g of imports) {
    const e = G.featureEdges(G.cleanMesh(g)).attributes.position.array;
    for (let i = 0; i < e.length; i += 6) { seg.push(...e.slice(i, i + 6)); segEdge.push(-1); }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  geo.userData = { segEdge, polys };
  return geo;
}
/** Referenz einer gewaehlten B-Rep-Kante (Mittelpunkt nach Bogenlaenge) */
export function edgeRefFromPoly(pl) {
  let L = 0; const acc = [0];
  for (let i = 1; i < pl.length; i++) { L += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1], pl[i][2] - pl[i - 1][2]); acc.push(L); }
  let mid = pl[0];
  for (let i = 1; i < pl.length; i++) if (acc[i] >= L / 2) { const t = (L / 2 - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1); mid = pl[i - 1].map((v, k) => v + (pl[i][k] - v) * t); break; }
  const step = Math.max(1, Math.floor(pl.length / 24)); const poly = pl.filter((_, i) => i % step === 0 || i === pl.length - 1).map(p => p.map(v => +v.toFixed(5)));
  return { mid: mid.map(v => +v.toFixed(6)), a: pl[0], b: pl[pl.length - 1], poly, len: +L.toFixed(4) };
}

function importGeom(f, ctx) {
  const p = f.params; const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b64ToF32(p.mesh), 3));
  const tr = p.offset ? p.offset.map((v, i) => ctx.X(v, 'XYZ'[i])) : [0, 0, 0];
  if (tr.some(Boolean)) g.translate(...tr);
  if (p.scale && Number(p.scale) !== 1) g.scale(Number(p.scale), Number(p.scale), Number(p.scale));
  ctx.imports.push(g); ctx.tools.set(f.id, [{ geom: g, op: 'add' }]);
}

const frameJson = (fr) => ({ o: G.v3arr(fr.o), x: G.v3arr(fr.x), y: G.v3arr(fr.y) });
function exactSketch(ctx, sk) {
  const frame = planeRef(ctx, sk.plane);
  const ents = G.resolveEntities(sk.entities || [], ctx.params);
  const r = G.sketchCurveLoops(ents, ctx.seg);
  if (r.open) throw new Error(`Skizze nicht geschlossen (${r.open} offene Kette${r.open > 1 ? 'n' : ''})`);
  if (!r.shapes.length) throw new Error('Skizze enthält keine geschlossene Kontur');
  return { frame, shapes: r.shapes, axis: r.axis };
}
function patternMats(ctx, p) {
  const mats = [];
  if (p.kind === 'axial') {
    const ax = axisRef(ctx, p.axis); const n = Math.round(ctx.X(p.count, 'Anzahl')); const ang = ctx.X(p.angle, 'Winkel') * Math.PI / 180;
    for (let i = 1; i < n; i++) {
      const m = new THREE.Matrix4().makeTranslation(-ax.o.x, -ax.o.y, -ax.o.z);
      m.premultiply(new THREE.Matrix4().makeRotationAxis(ax.d, ang * i)); m.premultiply(new THREE.Matrix4().makeTranslation(ax.o.x, ax.o.y, ax.o.z));
      mats.push(m);
    }
  } else {
    const d1 = axisRef(ctx, p.dir).d; const n1 = Math.round(ctx.X(p.count, 'Anzahl')); const s1 = ctx.X(p.spacing, 'Abstand');
    const n2 = p.dir2 ? Math.round(ctx.X(p.count2 ?? 1, 'Anzahl 2')) : 1; const d2 = p.dir2 ? axisRef(ctx, p.dir2).d : null; const s2 = p.dir2 ? ctx.X(p.spacing2 ?? 0, 'Abstand 2') : 0;
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const t = d1.clone().multiplyScalar(s1 * i); if (d2) t.addScaledVector(d2, s2 * j);
      mats.push(new THREE.Matrix4().makeTranslation(t.x, t.y, t.z));
    }
  }
  if (mats.length > 400) throw new Error('Zu viele Musterelemente (max. 400)');
  return mats;
}
/** Feature -> Operation fuer den usd-brep-Kern */
const OPS = {
  extrude(f, ctx) {
    const p = f.params; const { frame, shapes } = exactSketch(ctx, p.sketch);
    const depth = p.through ? null : ctx.X(p.depth, 'Tiefe');
    if (!p.through && !(depth > 0)) throw new Error('Tiefe muss > 0 sein');
    const depth2 = p.side === 'two' && !p.through ? ctx.X(p.depth2 ?? p.depth, 'Tiefe 2') : null;
    return { op: p.op || 'add', side: p.side || 'one', depth, depth2, through: !!p.through, flip: !!p.flip, frame: frameJson(frame), shapes };
  },
  revolve(f, ctx) {
    const p = f.params; const { frame, shapes, axis } = exactSketch(ctx, p.sketch);
    let ax = axis;
    if (p.axis === 'H') ax = { x1: 0, y1: 0, x2: 1, y2: 0 }; else if (p.axis === 'V') ax = { x1: 0, y1: 0, x2: 0, y2: 1 };
    if (!ax) throw new Error('Keine Mittellinie als Rotationsachse in der Skizze');
    if (Math.hypot(ax.x2 - ax.x1, ax.y2 - ax.y1) < 1e-9) throw new Error('Rotationsachse hat Länge 0');
    let ang = ctx.X(p.angle ?? 360, 'Winkel'); if (p.flip) ang = -ang;
    return { op: p.op || 'add', frame: frameJson(frame), shapes, axis: { p: [ax.x1, ax.y1], d: [ax.x2 - ax.x1, ax.y2 - ax.y1] }, angle: ang };
  },
  hole(f, ctx) {
    const p = f.params; const fr = planeRef(ctx, p.plane);
    const o = fr.to3(ctx.X(p.u ?? 0, 'Position 1'), ctx.X(p.v ?? 0, 'Position 2'));
    const dir = fr.n.clone().multiplyScalar(p.flip ? 1 : -1);
    const r = ctx.X(p.d, 'Durchmesser') / 2; if (!(r > 0)) throw new Error('Durchmesser muss > 0 sein');
    const out = { o: G.v3arr(o), dir: G.v3arr(dir), r, depth: p.through ? null : ctx.X(p.depth, 'Tiefe'), tip: p.tip !== false };
    if (p.cbore) out.cbore = { r: ctx.X(p.cboreD, 'Senkdurchmesser') / 2, depth: ctx.X(p.cboreDepth, 'Senktiefe') };
    else if (p.csink) out.csink = { r: ctx.X(p.csinkD, 'Senkdurchmesser') / 2 };
    return out;
  },
  round(f, ctx) { return edgeOp(f, ctx); },
  chamfer(f, ctx) { return edgeOp(f, ctx); },
  pattern(f, ctx) { const p = f.params; return { ref: p.ref, mats: patternMats(ctx, p).map(m => Array.from(m.elements)) }; },
  mirror(f, ctx) { const p = f.params; const fr = planeRef(ctx, p.plane); return { o: G.v3arr(fr.o), n: G.v3arr(fr.n), what: p.what, ref: p.ref, cross: p.cross || 'pos' }; },
  shell(f, ctx) {
    const p = f.params; const t = ctx.X(p.thickness, 'Wandstärke'); if (!(t > 0)) throw new Error('Wandstärke muss > 0 sein');
    return { thickness: t, faces: (p.faces || []).map(x => x.point || x), outward: !!p.outward };
  },
};
function edgeOp(f, ctx) {
  const p = f.params; const s = ctx.X(p.size, f.type === 'round' ? 'Radius' : 'Abstand'); if (!(s > 0)) throw new Error('Wert muss > 0 sein');
  if (!p.edges?.length) throw new Error('Keine Kanten gewählt');
  const mid = (e) => e.mid || e.a.map((v, i) => (v + e.b[i]) / 2);
  return { size: s, edges: p.edges.map(e => ({ mid: mid(e) })) };
}

/** Interner Netzkern (Rueckfallebene ohne usd-brep, z. B. macOS) */
function regenerateLocal(doc, opts = {}) {
  const params = evalParams(doc.params);
  const seg = doc.settings?.seg || 64;
  const ctx = {
    params, seg, body: null, planes: new Map(), axes: new Map(), points: new Map(), csys: new Map(),
    tools: new Map(), status: new Map(), errors: [], size: 200,
  };
  const X = (v, nm = 'Wert') => { try { return evalExpr(v, params); } catch (e) { throw new Error(`${nm}: ${e.message}`); } };
  ctx.X = X;
  for (const { f, rolled } of featureList(doc, opts)) {
    if (rolled) { ctx.status.set(f.id, 'rolledback'); continue; }
    if (f.suppressed) { ctx.status.set(f.id, 'suppressed'); continue; }
    if (ctx.body) { const bb = G.bboxOf(ctx.body); if (!bb.isEmpty()) ctx.size = Math.max(50, bb.getSize(new THREE.Vector3()).length() * 2); }
    try {
      if (!BUILD[f.type]) throw new Error(`Unbekannter Feature-Typ ${f.type}`);
      BUILD[f.type](f, ctx);
      ctx.status.set(f.id, 'ok');
    } catch (e) {
      ctx.status.set(f.id, 'error');
      ctx.errors.push({ id: f.id, name: f.name, msg: e.message || String(e) });
    }
  }
  let mesh = null, display = null, edges = null;
  if (ctx.body && ctx.body.attributes.position.count) {
    mesh = G.cleanMesh(ctx.body);
    display = G.meshToGeom(mesh);
    edges = G.featureEdges(mesh);
  }
  const bb = display ? display.boundingBox.clone() : new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
  return { ...ctx, mesh, display, edges, bbox: bb };
}

function planeRef(ctx, ref) {
  if (!ref) throw new Error('Keine Ebene gewählt');
  if (typeof ref === 'object') return G.planeFrame(ref);
  const p = ctx.planes.get(ref);
  if (!p) throw new Error('Referenzebene fehlt');
  return p.frame;
}
function axisRef(ctx, ref) {
  if (!ref) throw new Error('Keine Achse/Richtung gewählt');
  if (typeof ref === 'object') return { o: new THREE.Vector3(...ref.origin), d: new THREE.Vector3(...ref.dir).normalize() };
  if (['X', 'Y', 'Z'].includes(ref)) return { o: new THREE.Vector3(), d: new THREE.Vector3(ref === 'X' ? 1 : 0, ref === 'Y' ? 1 : 0, ref === 'Z' ? 1 : 0) };
  if (ctx.axes.has(ref)) return ctx.axes.get(ref);
  if (ctx.planes.has(ref)) { const fr = ctx.planes.get(ref).frame; return { o: fr.o.clone(), d: fr.n.clone() }; }
  throw new Error('Referenzachse fehlt');
}
export { planeRef, axisRef };

function apply(ctx, f, geom, op) {
  const list = ctx.tools.get(f.id) || []; list.push({ geom, op }); ctx.tools.set(f.id, list);
  if (op === 'cut' && !ctx.body) throw new Error('Kein Material zum Entfernen vorhanden');
  ctx.body = G.boolOp(ctx.body, geom, op);
}

function sketchShapes(ctx, sk) {
  const frame = planeRef(ctx, sk.plane);
  const ents = G.resolveEntities(sk.entities || [], ctx.params);
  const { loops, open, axis } = G.sketchLoops(ents, ctx.seg);
  if (open) throw new Error(`Skizze nicht geschlossen (${open} offene Kette${open > 1 ? 'n' : ''})`);
  return { frame, shapes: G.nestLoops(loops), axis, ents };
}

const BUILD = {
  datumPlane(f, ctx) {
    const p = f.params; let frame;
    if (p.kind === 'fixed') frame = G.planeFrame(p);
    else {
      const ref = planeRef(ctx, p.ref);
      const off = ctx.X(p.offset ?? 0, 'Versatz'); const ang = ctx.X(p.angle ?? 0, 'Winkel') * Math.PI / 180;
      let n = ref.n.clone(), x = ref.x.clone();
      if (ang) { const q = new THREE.Quaternion().setFromAxisAngle(ref.x, ang); n.applyQuaternion(q); }
      if (p.flip) { n.negate(); x = x.clone(); }
      const o = ref.o.clone().addScaledVector(ref.n, off);
      frame = G.planeFrame({ origin: G.v3arr(o), normal: G.v3arr(n), xdir: G.v3arr(x) });
    }
    ctx.planes.set(f.id, { frame, name: f.name, fid: f.id });
  },
  datumAxis(f, ctx) {
    const p = f.params; let o, d;
    if (p.kind === 'twoPlanes') {
      const a = planeRef(ctx, p.ref1), b = planeRef(ctx, p.ref2);
      d = a.n.clone().cross(b.n); if (d.lengthSq() < 1e-10) throw new Error('Ebenen sind parallel');
      d.normalize();
      // Punkt auf beiden Ebenen: Loese n1.x=d1, n2.x=d2, d.x=0
      const d1 = a.n.dot(a.o), d2 = b.n.dot(b.o);
      const m = new THREE.Matrix3().set(a.n.x, a.n.y, a.n.z, b.n.x, b.n.y, b.n.z, d.x, d.y, d.z).invert();
      o = new THREE.Vector3(d1, d2, 0).applyMatrix3(m);
    } else {
      o = new THREE.Vector3(...(p.point || [0, 0, 0]).map((v, i) => ctx.X(v, 'Punkt ' + 'XYZ'[i])));
      d = new THREE.Vector3(...(p.dir || [0, 1, 0]).map((v, i) => ctx.X(v, 'Richtung ' + 'XYZ'[i])));
      if (d.lengthSq() < 1e-12) throw new Error('Richtung ist 0'); d.normalize();
    }
    ctx.axes.set(f.id, { o, d, name: f.name, fid: f.id });
  },
  datumPoint(f, ctx) {
    const p = f.params;
    const v = new THREE.Vector3(...(p.point || [0, 0, 0]).map((x, i) => ctx.X(x, 'XYZ'[i])));
    ctx.points.set(f.id, { p: v, name: f.name, fid: f.id });
  },
  csys(f, ctx) { ctx.csys.set(f.id, { m: new THREE.Matrix4(), name: f.name, fid: f.id }); },
  extrude(f, ctx) {
    const p = f.params; const { frame, shapes } = sketchShapes(ctx, p.sketch);
    let d = p.through ? ctx.size * 2 : ctx.X(p.depth, 'Tiefe');
    if (d <= 0 && !p.through) throw new Error('Tiefe muss > 0 sein');
    let w0 = 0, w1 = d;
    if (p.side === 'sym') { w0 = -d / 2; w1 = d / 2; }
    else if (p.side === 'two') { w0 = -(p.through ? ctx.size * 2 : ctx.X(p.depth2 ?? d, 'Tiefe 2')); }
    if (p.flip) [w0, w1] = [-w1, -w0];
    // Werkzeug 1 µm ueber bzw. in die Skizzenebene verlaengern -> keine deckungsgleichen Flaechen bei der Booleschen Operation
    if (p.side !== 'sym' && (p.op === 'cut' || ctx.body)) { if (w0 === 0) w0 = -1e-3; if (w1 === 0) w1 = 1e-3; }
    apply(ctx, f, G.extrudeProfiles(shapes, frame, w0, w1, ctx.seg), p.op || 'add');
  },
  revolve(f, ctx) {
    const p = f.params; const { frame, shapes, axis } = sketchShapes(ctx, p.sketch);
    let ax = axis;
    if (p.axis === 'H') ax = { x1: 0, y1: 0, x2: 1, y2: 0 };
    else if (p.axis === 'V') ax = { x1: 0, y1: 0, x2: 0, y2: 1 };
    if (!ax) throw new Error('Keine Mittellinie als Rotationsachse in der Skizze');
    let ang = ctx.X(p.angle ?? 360, 'Winkel'); if (p.flip) ang = -ang;
    apply(ctx, f, G.revolveProfiles(shapes, frame, ax, ang, ctx.seg), p.op || 'add');
  },
  hole(f, ctx) {
    const p = f.params; const fr = planeRef(ctx, p.plane);
    const o = fr.to3(ctx.X(p.u ?? 0, 'Position 1'), ctx.X(p.v ?? 0, 'Position 2'));
    const dir = fr.n.clone().multiplyScalar(p.flip ? 1 : -1);
    const r = ctx.X(p.d, 'Durchmesser') / 2; if (r <= 0) throw new Error('Durchmesser muss > 0 sein');
    const depth = p.through ? ctx.size * 2 : ctx.X(p.depth, 'Tiefe');
    const start = o.clone().addScaledVector(dir, -1e-3);
    const tools = [G.cylinderTool(start, dir, r, depth + 1e-3, ctx.seg)];
    if (!p.through && p.tip !== false) {
      // Bohrerspitze 118 Grad
      const h = r / Math.tan(59 * Math.PI / 180);
      tools.push(G.cylinderTool(o.clone().addScaledVector(dir, depth - 1e-3), dir, r, h, ctx.seg, 1e-3));
    }
    if (p.cbore) {
      const cr = ctx.X(p.cboreD, 'Senkdurchmesser') / 2; const cd = ctx.X(p.cboreDepth, 'Senktiefe');
      tools.push(G.cylinderTool(o.clone().addScaledVector(dir, -1), dir, cr, cd + 1, ctx.seg));
    } else if (p.csink) {
      const cr = ctx.X(p.csinkD, 'Senkdurchmesser') / 2; const h = (cr - r) / Math.tan(45 * Math.PI / 180);
      if (h > 0) tools.push(G.cylinderTool(o.clone().addScaledVector(dir, -0.5), dir, cr + 0.5, h + 0.5, ctx.seg, r * 0.98));
    }
    let tool = tools[0]; for (let i = 1; i < tools.length; i++) tool = G.boolOp(tool, tools[i], 'add');
    apply(ctx, f, tool, 'cut');
  },
  round(f, ctx) { edgeFeature(f, ctx, 'round'); },
  chamfer(f, ctx) { edgeFeature(f, ctx, 'chamfer'); },
  pattern(f, ctx) {
    const p = f.params; const src = ctx.tools.get(p.ref);
    if (!src) throw new Error('Referenz-Feature hat keine Geometrie (unterdrückt oder fehlerhaft?)');
    const mats = [];
    if (p.kind === 'axial') {
      const ax = axisRef(ctx, p.axis); const n = Math.round(ctx.X(p.count, 'Anzahl')); const ang = ctx.X(p.angle, 'Winkel') * Math.PI / 180;
      for (let i = 1; i < n; i++) {
        const m = new THREE.Matrix4().makeTranslation(-ax.o.x, -ax.o.y, -ax.o.z);
        m.premultiply(new THREE.Matrix4().makeRotationAxis(ax.d, ang * i)); m.premultiply(new THREE.Matrix4().makeTranslation(ax.o.x, ax.o.y, ax.o.z));
        mats.push(m);
      }
    } else {
      const d1 = axisRef(ctx, p.dir).d; const n1 = Math.round(ctx.X(p.count, 'Anzahl')); const s1 = ctx.X(p.spacing, 'Abstand');
      const n2 = p.dir2 ? Math.round(ctx.X(p.count2 ?? 1, 'Anzahl 2')) : 1; const d2 = p.dir2 ? axisRef(ctx, p.dir2).d : null; const s2 = p.dir2 ? ctx.X(p.spacing2 ?? 0, 'Abstand 2') : 0;
      for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
        if (!i && !j) continue;
        const t = d1.clone().multiplyScalar(s1 * i); if (d2) t.addScaledVector(d2, s2 * j);
        mats.push(new THREE.Matrix4().makeTranslation(t.x, t.y, t.z));
      }
    }
    if (mats.length > 400) throw new Error('Zu viele Musterelemente (max. 400)');
    const by = { cut: [], add: [] };
    for (const m of mats) for (const t of src) by[t.op].push(t.geom.clone().applyMatrix4(m));
    for (const op of ['cut', 'add']) {
      if (!by[op].length) continue;
      let tool = by[op][0]; for (let i = 1; i < by[op].length; i++) tool = G.boolOp(tool, by[op][i], 'add');
      apply(ctx, f, tool, op);
    }
  },
  mirror(f, ctx) {
    const p = f.params; const fr = planeRef(ctx, p.plane);
    const n = fr.n; const d = n.dot(fr.o);
    const m = new THREE.Matrix4().set(
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 2 * d * n.x,
      -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 2 * d * n.y,
      -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 2 * d * n.z,
      0, 0, 0, 1);
    if (p.what === 'feature') {
      const src = ctx.tools.get(p.ref); if (!src) throw new Error('Referenz-Feature hat keine Geometrie');
      for (const t of src) apply(ctx, f, G.flipGeom(t.geom.clone().applyMatrix4(m)), t.op);
    } else {
      if (!ctx.body) throw new Error('Keine Geometrie zum Spiegeln');
      const pa = ctx.body.attributes.position.array; let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < pa.length; i += 3) { const dd = n.x * pa[i] + n.y * pa[i + 1] + n.z * pa[i + 2] - d; if (dd < mn) mn = dd; if (dd > mx) mx = dd; }
      const tol = Math.max(1e-4, ctx.size * 1e-6);
      const crossing = mn < -tol && mx > tol;
      if (crossing && p.cross === 'union') { apply(ctx, f, G.flipGeom(ctx.body.clone().applyMatrix4(m)), 'add'); return; }
      if (crossing) {
        // Koerper an der Ebene abschneiden, die gewaehlte Seite behalten
        // eng anliegendes Prisma auf der wegfallenden Seite (kleine Koordinaten -> genaue Schnittpunkte)
        const keepPos = p.cross !== 'neg';
        const bb = G.bboxOf(ctx.body); const c0 = bb.getCenter(new THREE.Vector3()); const R = bb.getSize(new THREE.Vector3()).length() / 2 + 1;
        const cp = c0.clone().addScaledVector(n, d - n.dot(c0)); const sq = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => cp.clone().addScaledVector(fr.x, a * R).addScaledVector(fr.y, b * R));
        const depth = (keepPos ? -mn : mx) + 1; const dir = n.clone().multiplyScalar(keepPos ? -1 : 1);
        ctx.body = G.boolOp(ctx.body, G.prismTool(sq, dir, depth), 'cut');
        if (!ctx.body || !ctx.body.attributes.position.count) throw new Error('Auf der gewählten Seite liegt keine Geometrie');
      }
      // Punkte nahe der Ebene exakt auf die Ebene ziehen, damit Original und Spiegelbild an der Naht verschweissen
      { const q0 = ctx.body.attributes.position.array; const snap = Math.max(1e-3, ctx.size * 2e-6);
        for (let i = 0; i < q0.length; i += 3) { const dd = n.x * q0[i] + n.y * q0[i + 1] + n.z * q0[i + 2] - d; if (Math.abs(dd) < snap) { q0[i] -= dd * n.x; q0[i + 1] -= dd * n.y; q0[i + 2] -= dd * n.z; } }
        ctx.body.attributes.position.needsUpdate = true; }
      // Haelfte + Spiegelbild direkt zusammenfuegen; deckungsgleiche Kontaktflaechen in der Ebene entfallen (exakt, ohne CSG)
      const mir = G.flipGeom(ctx.body.clone().applyMatrix4(m));
      const both = G.concatGeoms([ctx.body, mir]); const q = both.attributes.position.array; const keep = [];
      const onPl = (i) => Math.abs(n.x * q[i] + n.y * q[i + 1] + n.z * q[i + 2] - d) < tol * 10;
      for (let i = 0; i < q.length; i += 9) if (!(onPl(i) && onPl(i + 3) && onPl(i + 6))) for (let k = 0; k < 9; k++) keep.push(q[i + k]);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
      ctx.body = G.prepGeom(G.meshToGeom(G.cleanMesh(g)));
      ctx.tools.set(f.id, [{ geom: mir, op: 'add' }]);
    }
  },
  shell() { throw new Error('Schale benötigt den usd-brep-Kern (unter macOS nicht verfügbar)'); },
  import(f, ctx) {
    const p = f.params; const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b64ToF32(p.mesh), 3));
    const tr = p.offset ? p.offset.map((v, i) => ctx.X(v, 'XYZ'[i])) : [0, 0, 0];
    if (tr.some(Boolean)) g.translate(...tr);
    if (p.scale && Number(p.scale) !== 1) g.scale(Number(p.scale), Number(p.scale), Number(p.scale));
    if (!ctx.body) { ctx.body = g; ctx.tools.set(f.id, [{ geom: g, op: 'add' }]); }
    else if (p.merge === 'concat') { ctx.body = G.concatGeoms([ctx.body, g]); ctx.tools.set(f.id, [{ geom: g, op: 'add' }]); }
    else apply(ctx, f, g, 'add');
  },
};

function edgeFeature(f, ctx, kind) {
  const p = f.params; if (!ctx.body) throw new Error('Kein Körper vorhanden');
  const s = ctx.X(p.size, kind === 'round' ? 'Radius' : 'Abstand'); if (s <= 0) throw new Error('Wert muss > 0 sein');
  if (!p.edges?.length) throw new Error('Keine Kanten gewählt');
  // Werkzeuge je Operation erst vereinigen, dann in einem Schritt anwenden (robust an Ecken)
  const by = { cut: null, add: null };
  for (const e of p.edges) {
    if (!e.n1) throw new Error('Diese Kante wurde mit dem usd-brep-Kern gewählt und kann vom internen Kern nicht verarbeitet werden');
    const { tool, op } = G.edgeTool(e, s, kind, ctx.seg); by[op] = by[op] ? G.boolOp(by[op], tool, 'add') : tool;
  }
  if (by.cut) apply(ctx, f, by.cut, 'cut');
  if (by.add) apply(ctx, f, by.add, 'add');
}

export function importFeature(doc, name, geom, source) {
  const g = G.prepGeom(geom);
  return { id: uid('f'), type: 'import', name: `${name}`, params: { source, mesh: f32ToB64(g.attributes.position.array), merge: 'concat' } };
}

/** Abhaengigkeiten (fuer Loeschen): Features, die f.id referenzieren */
export function dependents(doc, id) {
  const out = [];
  const refs = (p) => JSON.stringify(p).includes(`"${id}"`);
  for (const f of doc.features) if (f.id !== id && refs(f.params)) out.push(f);
  return out;
}
