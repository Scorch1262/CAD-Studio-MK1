// Szenenaufbau fuer Parts und Bezugselemente
import * as THREE from '../vendor/three.module.js';
import { toCreasedNormals } from '../vendor/addons/utils/BufferGeometryUtils.js';
import { hiddenByLayer } from './part.js';

export const DATUM_COLOR = 0xd9a05b;

export function bodyMaterial(color) {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color || '#b9c3cc'), metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}

/** Koerper + Kanten aus Regenerierungs-Ergebnis */
export function buildBody(regen, color) {
  const g = new THREE.Group(); g.userData.role = 'part';
  if (!regen.display) return g;
  const shaded = toCreasedNormals(regen.display, 30 * Math.PI / 180);
  const mesh = new THREE.Mesh(shaded, bodyMaterial(color));
  mesh.userData = { role: 'body', mesh: regen.mesh };
  const edges = new THREE.LineSegments(regen.edges, new THREE.LineBasicMaterial({ color: 0x10161d }));
  edges.userData = { role: 'edges' };
  g.add(mesh, edges);
  return g;
}

export function applyDisplayStyle(root, style) {
  root.traverse(o => {
    if (o.userData.role === 'body') {
      o.visible = style !== 'wire';
      o.material.colorWrite = style !== 'hidden';
      o.material.transparent = false;
    }
    if (o.userData.role === 'edges') {
      o.visible = style !== 'shaded';
      o.material.depthTest = style !== 'wire';
      o.material.color.set(style === 'hidden' || style === 'wire' ? 0xd8e2ec : 0x10161d);
    }
  });
}

/** Bezugselemente; filter = {planes, axes, points, csys, tags} */
export function buildDatums(regen, doc, viewer, filter, prefix = '', hiddenFn = null) {
  const g = new THREE.Group(); g.userData.role = 'datums';
  viewer.clearLabels('datum');
  const bb = regen.bbox && !regen.bbox.isEmpty() ? regen.bbox : new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
  const c = bb.getCenter(new THREE.Vector3()); const sz = bb.getSize(new THREE.Vector3());
  const half = Math.max(20, Math.max(sz.x, sz.y, sz.z) * 0.62 + 5);
  const isHidden = hiddenFn || ((id) => { const f = doc.features?.find(x => x.id === id); return f ? (f.hidden || hiddenByLayer(doc, f)) : false; });
  const mk = (kind) => { const s = new THREE.Group(); s.userData.kind = kind; g.add(s); return s; };
  const gp = mk('planes'), ga = mk('axes'), gpt = mk('points'), gc = mk('csys');
  gp.visible = filter.planes; ga.visible = filter.axes; gpt.visible = filter.points; gc.visible = filter.csys;
  for (const [id, pl] of regen.planes) {
    if (isHidden(id)) continue;
    const f = pl.frame; const d = c.clone().sub(f.o); const u = d.dot(f.x), v = d.dot(f.y);
    const ctr = f.to3(u, v);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ctr.clone().addScaledVector(f.x, a * half).addScaledVector(f.y, b * half));
    const fillGeo = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
    const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: DATUM_COLOR, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    fill.userData = { pick: 'plane', id, name: pl.name };
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: DATUM_COLOR }));
    line.userData = { pick: 'plane', id, name: pl.name, outline: true };
    const s = new THREE.Group(); s.add(fill, line); s.userData = { datumId: id }; gp.add(s);
    if (filter.tags) viewer.addLabel(prefix + pl.name, corners[3], 'lbl datum', 'datum', s);
  }
  for (const [id, ax] of regen.axes) {
    if (isHidden(id)) continue;
    const t = c.clone().sub(ax.o).dot(ax.d); const m = ax.o.clone().addScaledVector(ax.d, t);
    const a = m.clone().addScaledVector(ax.d, -half * 1.1), b = m.clone().addScaledVector(ax.d, half * 1.1);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({ color: DATUM_COLOR, dashSize: half / 12, gapSize: half / 30 }));
    l.computeLineDistances(); l.userData = { pick: 'axis', id, name: ax.name };
    const s = new THREE.Group(); s.add(l); s.userData = { datumId: id }; ga.add(s);
    if (filter.tags) viewer.addLabel(prefix + ax.name, b, 'lbl datum', 'datum', s);
  }
  for (const [id, pt] of regen.points) {
    if (isHidden(id)) continue;
    const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([pt.p]), new THREE.PointsMaterial({ color: DATUM_COLOR, size: 7, sizeAttenuation: false }));
    p.userData = { pick: 'point', id, name: pt.name };
    const s = new THREE.Group(); s.add(p); s.userData = { datumId: id }; gpt.add(s);
    if (filter.tags) viewer.addLabel(prefix + pt.name, pt.p, 'lbl datum', 'datum', s);
  }
  for (const [id, cs] of regen.csys) {
    if (isHidden(id)) continue;
    const s = new THREE.Group(); s.userData = { datumId: id };
    const L = half * 0.28; const o = new THREE.Vector3();
    [[1, 0, 0, 0xff5c5c, 'X'], [0, 1, 0, 0x5cdc6e, 'Y'], [0, 0, 1, 0x5c9cff, 'Z']].forEach(([x, y, z, col, n]) => {
      const dir = new THREE.Vector3(x, y, z); const ar = new THREE.ArrowHelper(dir, o, L, col, L * 0.18, L * 0.08); s.add(ar);
      if (filter.tags) viewer.addLabel(n, dir.clone().multiplyScalar(L * 1.12), 'lbl axis', 'datum', s);
    });
    gc.add(s);
    if (filter.tags) viewer.addLabel(prefix + cs.name, new THREE.Vector3(L * 0.15, -L * 0.15, 0), 'lbl datum', 'datum', s);
  }
  return g;
}

/** Hervorhebung einer Werkzeug-/Flaechengeometrie */
export function highlightMesh(geom, color = 0x29c8ff, opacity = 0.35) {
  return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }));
}

/** Koplanare zusammenhaengende Dreiecke ab Dreieck t (fuer Flaechenauswahl) */
export function faceGroup(mesh, t0) {
  const { pos, tri } = mesh; const nT = tri.length / 3;
  const nrm = (t) => { const a = new THREE.Vector3().fromArray(pos, tri[t * 3] * 3), b = new THREE.Vector3().fromArray(pos, tri[t * 3 + 1] * 3), c = new THREE.Vector3().fromArray(pos, tri[t * 3 + 2] * 3); return b.sub(a).cross(c.sub(a)).normalize(); };
  if (!mesh._adj) {
    const m = new Map(); const ek = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) { const k = ek(tri[t * 3 + e], tri[t * 3 + (e + 1) % 3]); (m.get(k) || m.set(k, []).get(k)).push(t); }
    mesh._adj = { m, ek };
  }
  const { m, ek } = mesh._adj; const n0 = nrm(t0); const seen = new Set([t0]); const st = [t0];
  while (st.length) {
    const t = st.pop();
    for (let e = 0; e < 3; e++) for (const o of m.get(ek(tri[t * 3 + e], tri[t * 3 + (e + 1) % 3])) || []) {
      if (seen.has(o)) continue; if (nrm(o).dot(n0) > 0.99999) { seen.add(o); st.push(o); }
    }
  }
  const pts = []; for (const t of seen) for (let k = 0; k < 3; k++) { const i = tri[t * 3 + k]; pts.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return { geom: g, normal: n0, planar: seen.size > 1 || true };
}
