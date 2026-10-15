// Geometriekern: Profile, Volumenkoerper, Boolesche Operationen, Netzbereinigung
import * as THREE from '../vendor/three.module.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from '../vendor/three-bvh-csg.module.js';
import { evalExpr } from './util.js';

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
export const v3arr = (v) => [v.x, v.y, v.z];

// ------------------------------------------------------------------ Ebenen
/** Ebene {origin, normal, xdir} -> Basis mit ydir = normal x xdir */
export function planeFrame(pl) {
  const o = pl.origin.isVector3 ? pl.origin.clone() : V3(pl.origin);
  const n = (pl.normal.isVector3 ? pl.normal.clone() : V3(pl.normal)).normalize();
  let x = pl.xdir ? (pl.xdir.isVector3 ? pl.xdir.clone() : V3(pl.xdir)) : null;
  if (!x || Math.abs(x.dot(n)) > 0.999 || x.lengthSq() < 1e-12) {
    x = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(n) : new THREE.Vector3(1, 0, 0).cross(n).negate();
  }
  x.sub(n.clone().multiplyScalar(x.dot(n))).normalize();
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, n).setPosition(o);
  return { o, x, y, n, m, to3: (u, v, w = 0) => o.clone().addScaledVector(x, u).addScaledVector(y, v).addScaledVector(n, w) };
}
export function planeToJson(f) { return { origin: v3arr(f.o), normal: v3arr(f.n), xdir: v3arr(f.x) }; }

// ------------------------------------------------------------------ CSG
const evaluator = new Evaluator();
evaluator.attributes = ['position'];
evaluator.useGroups = false;
evaluator.useCDTClipping = true; // robuster bei koplanaren Schnitten
export const __setCDT = (v) => { evaluator.useCDTClipping = v; };

export function prepGeom(g) {
  let geo = g.index ? g.toNonIndexed() : g;
  if (geo === g) geo = g.clone();
  for (const k of Object.keys(geo.attributes)) if (k !== 'position') geo.deleteAttribute(k);
  geo.clearGroups();
  return geo;
}
function brush(g) { const b = new Brush(prepGeom(g)); b.updateMatrixWorld(); return b; }

export function boolOp(a, b, op) {
  if (!a) return op === 'cut' ? null : prepGeom(b);
  if (!b) return a;
  const OP = op === 'cut' ? SUBTRACTION : op === 'intersect' ? INTERSECTION : ADDITION;
  const r = evaluator.evaluate(brush(a), brush(b), OP);
  let g = r.geometry;
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.clearGroups();
  // Ergebnis verschweissen/T-Stoesse aufloesen, damit sich Fehler nicht ueber Features aufschaukeln
  if (globalThis.__CLEAN !== false) g = prepGeom(meshToGeom(cleanMesh(g)));
  return g;
}

/** Mehrere geschlossene Huellen ohne Boolesche Operation zusammenfassen */
export function concatGeoms(list) {
  const arrs = list.filter(Boolean).map(g => prepGeom(g).attributes.position.array);
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

// ------------------------------------------------------------------ Netzanalyse
export function signedVolume(g) {
  const p = g.attributes.position.array; const idx = g.index ? g.index.array : null;
  const n = idx ? idx.length : p.length / 3; let v = 0;
  for (let i = 0; i < n; i += 3) {
    const a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}
export function surfaceArea(g) {
  const p = g.attributes.position.array; const idx = g.index ? g.index.array : null;
  const n = idx ? idx.length : p.length / 3; let A = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromArray(p, (idx ? idx[i] : i) * 3); b.fromArray(p, (idx ? idx[i + 1] : i + 1) * 3); c.fromArray(p, (idx ? idx[i + 2] : i + 2) * 3);
    A += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return A;
}
export function flipGeom(g) {
  if (g.index) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.index.needsUpdate = true; }
  else {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    g.attributes.position.needsUpdate = true;
  }
  return g;
}
export function ensureOutward(g) { if (signedVolume(g) < 0) flipGeom(g); return g; }

// ------------------------------------------------------------------ Netzbereinigung
/** Verschweissen, entartete Dreiecke entfernen, T-Stoesse aufloesen -> {pos, tri} */
export function cleanMesh(geom, tolIn) {
  const src = geom.attributes.position.array;
  const sidx = geom.index ? geom.index.array : null;
  const nIdx = sidx ? sidx.length : src.length / 3;
  geom.computeBoundingBox();
  const diag = geom.boundingBox.isEmpty() ? 1 : geom.boundingBox.getSize(new THREE.Vector3()).length();
  const tol = tolIn || Math.max(1e-5, diag * 2e-7);
  const inv = 1 / tol;
  const cells = new Map(); const pos = []; const remap = new Int32Array(src.length / 3);
  const key = (i, j, k) => `${i},${j},${k}`;
  for (let v = 0; v < src.length / 3; v++) {
    const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
    const ci = Math.round(x * inv), cj = Math.round(y * inv), ck = Math.round(z * inv);
    let found = -1;
    for (let di = -1; di <= 1 && found < 0; di++) for (let dj = -1; dj <= 1 && found < 0; dj++) for (let dk = -1; dk <= 1 && found < 0; dk++) {
      const l = cells.get(key(ci + di, cj + dj, ck + dk));
      if (!l) continue;
      for (const w of l) {
        const dx = pos[w * 3] - x, dy = pos[w * 3 + 1] - y, dz = pos[w * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= tol * tol) { found = w; break; }
      }
    }
    if (found < 0) {
      found = pos.length / 3; pos.push(x, y, z);
      const k = key(ci, cj, ck); (cells.get(k) || cells.set(k, []).get(k)).push(found);
    }
    remap[v] = found;
  }
  let tri = [];
  for (let i = 0; i < nIdx; i += 3) {
    const a = remap[sidx ? sidx[i] : i], b = remap[sidx ? sidx[i + 1] : i + 1], c = remap[sidx ? sidx[i + 2] : i + 2];
    if (a === b || b === c || a === c) continue;
    tri.push(a, b, c);
  }
  // Nullflaechige Dreiecke (kollinear) entfernen -> erzeugt T-Stoesse, die danach aufgeloest werden
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const triArea2 = (a, b, c) => {
    const A = P(a), B = P(b), C = P(c);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx; return Math.sqrt(cx * cx + cy * cy + cz * cz);
  };
  { const t2 = []; for (let i = 0; i < tri.length; i += 3) if (triArea2(tri[i], tri[i + 1], tri[i + 2]) > tol * tol * 0.5) t2.push(tri[i], tri[i + 1], tri[i + 2]); tri = t2; }

  // Vertex-Raster fuer Punkt-auf-Kante-Suche
  const gsize = Math.max(tol * 10, diag / 64);
  const ginv = 1 / gsize; const grid = new Map();
  for (let v = 0; v < pos.length / 3; v++) {
    const k = key(Math.floor(pos[v * 3] * ginv), Math.floor(pos[v * 3 + 1] * ginv), Math.floor(pos[v * 3 + 2] * ginv));
    (grid.get(k) || grid.set(k, []).get(k)).push(v);
  }
  for (let iter = 0; iter < 6; iter++) {
    const ecount = new Map();
    const ek = (a, b) => a < b ? a * 4294967 + b : b * 4294967 + a;
    for (let i = 0; i < tri.length; i += 3) for (let e = 0; e < 3; e++) {
      const k = ek(tri[i + e], tri[i + (e + 1) % 3]); ecount.set(k, (ecount.get(k) || 0) + 1);
    }
    let changed = false; const out = [];
    for (let i = 0; i < tri.length; i += 3) {
      let split = null;
      for (let e = 0; e < 3 && !split; e++) {
        const a = tri[i + e], b = tri[i + (e + 1) % 3], c = tri[i + (e + 2) % 3];
        if (ecount.get(ek(a, b)) !== 1) continue;
        const A = P(a), B = P(b);
        const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]; const L2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2; if (L2 < tol * tol) continue;
        const mn = [0, 1, 2].map(k => Math.floor((Math.min(A[k], B[k]) - tol) * ginv));
        const mx = [0, 1, 2].map(k => Math.floor((Math.max(A[k], B[k]) + tol) * ginv));
        if ((mx[0] - mn[0] + 1) * (mx[1] - mn[1] + 1) * (mx[2] - mn[2] + 1) > 20000) continue;
        const hits = [];
        for (let gi = mn[0]; gi <= mx[0]; gi++) for (let gj = mn[1]; gj <= mx[1]; gj++) for (let gk = mn[2]; gk <= mx[2]; gk++) {
          const l = grid.get(key(gi, gj, gk)); if (!l) continue;
          for (const v of l) {
            if (v === a || v === b || v === c) continue;
            const V = P(v); const w = [V[0] - A[0], V[1] - A[1], V[2] - A[2]];
            const t = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / L2;
            if (t <= 1e-9 || t >= 1 - 1e-9) continue;
            const px = w[0] - t * d[0], py = w[1] - t * d[1], pz = w[2] - t * d[2];
            if (px * px + py * py + pz * pz <= (tol * 2) ** 2) hits.push([t, v]);
          }
        }
        if (hits.length) { hits.sort((x, y) => x[0] - y[0]); split = { a, b, c, vs: hits.map(h => h[1]) }; }
      }
      if (split) {
        const chain = [split.a, ...split.vs, split.b];
        for (let k = 0; k < chain.length - 1; k++) out.push(chain[k], chain[k + 1], split.c);
        changed = true;
      } else out.push(tri[i], tri[i + 1], tri[i + 2]);
    }
    tri = out;
    if (!changed) break;
  }
  return { pos: new Float32Array(pos), tri: new Uint32Array(tri), tol };
}

export function meshToGeom(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.tri, 1));
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Kanten fuer die Darstellung (Knickwinkel) aus bereinigtem Netz */
export function featureEdges(mesh, angleDeg = 18) {
  const { pos, tri } = mesh; const cosT = Math.cos(angleDeg * Math.PI / 180);
  const normals = new Float32Array(tri.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < tri.length; i += 3) {
    a.fromArray(pos, tri[i] * 3); b.fromArray(pos, tri[i + 1] * 3); c.fromArray(pos, tri[i + 2] * 3);
    const n = b.sub(a).cross(c.sub(a)).normalize(); normals[i] = n.x; normals[i + 1] = n.y; normals[i + 2] = n.z;
  }
  const map = new Map(); const ek = (x, y) => x < y ? `${x}_${y}` : `${y}_${x}`;
  for (let i = 0; i < tri.length; i += 3) for (let e = 0; e < 3; e++) {
    const x = tri[i + e], y = tri[i + (e + 1) % 3]; const k = ek(x, y);
    const l = map.get(k); if (l) l.push(i); else map.set(k, [i]);
  }
  const out = [];
  // Offene/mehrfache Kanten nur zeigen, wenn das Netz ueberwiegend offen ist (z. B. importierte Flaechen)
  let bad = 0; for (const l of map.values()) if (l.length !== 2) bad++;
  const showOpen = bad > map.size * 0.05;
  for (const [k, l] of map) {
    if (l.length !== 2 && !showOpen) continue;
    let sharp = l.length !== 2;
    if (!sharp) {
      const i = l[0], j = l[1];
      const d = normals[i] * normals[j] + normals[i + 1] * normals[j + 1] + normals[i + 2] * normals[j + 2];
      sharp = d < cosT;
    }
    if (sharp) { const [x, y] = k.split('_').map(Number); out.push(pos[x * 3], pos[x * 3 + 1], pos[x * 3 + 2], pos[y * 3], pos[y * 3 + 1], pos[y * 3 + 2]); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

/** Fuer Rundung/Fase: Flaechennormalen an einer Kante (a,b) bestimmen und kollinear verlaengern */
export function edgeInfo(mesh, A, B) {
  const { pos, tri } = mesh;
  const P = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const dir = B.clone().sub(A); const len = dir.length(); dir.normalize();
  const tol = Math.max(mesh.tol * 5, len * 1e-5);
  const onLine = (p) => { const w = p.clone().sub(A); return w.clone().sub(dir.clone().multiplyScalar(w.dot(dir))).length() < tol; };
  const ns = []; let tmin = 0, tmax = len;
  const third = [];
  for (let i = 0; i < tri.length; i += 3) {
    const v = [P(tri[i]), P(tri[i + 1]), P(tri[i + 2])];
    for (let e = 0; e < 3; e++) {
      const p = v[e], q = v[(e + 1) % 3];
      if (!onLine(p) || !onLine(q)) continue;
      const tp = p.clone().sub(A).dot(dir), tq = q.clone().sub(A).dot(dir);
      // Ueberlappung mit gewaehltem Segment?
      if (Math.max(tp, tq) < tol || Math.min(tp, tq) > len - tol) continue;
      const n = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();
      if (!ns.some(m => m.dot(n) > 0.9999)) { ns.push(n); third.push(v[(e + 2) % 3].clone()); }
    }
  }
  if (ns.length !== 2) throw new Error('Kante gehört nicht zu genau zwei ebenen Flächen');
  const [n1, n2] = ns;
  // Kante entlang beider Flaechen ausdehnen (kollineare Kantensegmente sammeln)
  for (let i = 0; i < tri.length; i += 3) {
    const v = [P(tri[i]), P(tri[i + 1]), P(tri[i + 2])];
    const n = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();
    if (!(n.dot(n1) > 0.9999 || n.dot(n2) > 0.9999)) continue;
    for (const p of v) if (onLine(p)) { const t = p.clone().sub(A).dot(dir); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
  }
  const a = A.clone().addScaledVector(dir, tmin), b = A.clone().addScaledVector(dir, tmax);
  // konvex, wenn der dritte Punkt von Flaeche 1 hinter Ebene 2 liegt
  const convex = third[0].clone().sub(A).dot(n2) < 0;
  return { a: v3arr(a), b: v3arr(b), n1: v3arr(n1), n2: v3arr(n2), convex };
}

// ------------------------------------------------------------------ Skizzen -> Profile
export function arcPoints(cx, cy, r, a0, a1, segPerRev = 64) {
  let sweep = a1 - a0; // a0->a1 gegen den Uhrzeigersinn
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil(segPerRev * sweep / (Math.PI * 2)));
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = a0 + sweep * i / n; pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }); }
  return pts;
}

/** Entitaeten (Werte bereits Zahlen) -> geschlossene Konturen + offene Ketten */
export function sketchLoops(entities, seg = 64) {
  const loops = []; const segs = []; let axis = null;
  for (const e of entities) {
    if (e.construction) { if (e.type === 'centerline' && !axis) axis = e; continue; }
    switch (e.type) {
      case 'centerline': if (!axis) axis = e; break;
      case 'circle': loops.push(arcPoints(e.cx, e.cy, e.r, 0, Math.PI * 2, seg).slice(0, -1)); break;
      case 'rect': {
        const x0 = Math.min(e.x, e.x + e.w), x1 = Math.max(e.x, e.x + e.w), y0 = Math.min(e.y, e.y + e.h), y1 = Math.max(e.y, e.y + e.h);
        const r = Math.min(e.r || 0, (x1 - x0) / 2 - 1e-6, (y1 - y0) / 2 - 1e-6);
        if (r > 1e-6) {
          const q = Math.max(2, Math.round(seg / 4)); const pts = [];
          const corner = (cx, cy, a0) => { for (let i = 0; i <= q; i++) { const t = a0 + Math.PI / 2 * i / q; pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }); } };
          corner(x1 - r, y0 + r, -Math.PI / 2); corner(x1 - r, y1 - r, 0); corner(x0 + r, y1 - r, Math.PI / 2); corner(x0 + r, y0 + r, Math.PI);
          loops.push(pts);
        } else loops.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
        break;
      }
      case 'polygon': {
        const pts = []; for (let i = 0; i < e.n; i++) { const t = (e.rot || 0) * Math.PI / 180 + i * Math.PI * 2 / e.n; pts.push({ x: e.cx + e.r * Math.cos(t), y: e.cy + e.r * Math.sin(t) }); }
        loops.push(pts); break;
      }
      case 'slot': {
        const dx = e.x2 - e.x1, dy = e.y2 - e.y1, a = Math.atan2(dy, dx);
        const p1 = arcPoints(e.x2, e.y2, e.r, a - Math.PI / 2, a + Math.PI / 2, seg);
        const p2 = arcPoints(e.x1, e.y1, e.r, a + Math.PI / 2, a + Math.PI * 1.5, seg);
        loops.push([...p1, ...p2]); break;
      }
      case 'line': segs.push({ pts: [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }] }); break;
      case 'arc': segs.push({ pts: arcPoints(e.cx, e.cy, e.r, e.a0 * Math.PI / 180, e.a1 * Math.PI / 180, seg) }); break;
      default: break;
    }
  }
  // Linien/Boegen zu Ketten verbinden
  const tol = 1e-4; const same = (p, q) => Math.abs(p.x - q.x) < tol && Math.abs(p.y - q.y) < tol;
  const used = new Array(segs.length).fill(false); let open = 0;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue; used[i] = true;
    let chain = segs[i].pts.slice();
    let grown = true;
    while (grown && !same(chain[0], chain[chain.length - 1])) {
      grown = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue; const s = segs[j].pts; const end = chain[chain.length - 1];
        if (same(s[0], end)) { chain = chain.concat(s.slice(1)); used[j] = true; grown = true; break; }
        if (same(s[s.length - 1], end)) { chain = chain.concat(s.slice().reverse().slice(1)); used[j] = true; grown = true; break; }
        if (same(s[s.length - 1], chain[0])) { chain = s.slice(0, -1).concat(chain); used[j] = true; grown = true; break; }
        if (same(s[0], chain[0])) { chain = s.slice().reverse().slice(0, -1).concat(chain); used[j] = true; grown = true; break; }
      }
    }
    if (chain.length > 3 && same(chain[0], chain[chain.length - 1])) loops.push(chain.slice(0, -1));
    else open++;
  }
  return { loops, open, axis };
}

export const loopArea = (l) => { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };
function pointInLoop(pt, l) {
  let inside = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Konturen verschachteln -> [{outer, holes}] (gerade Tiefe = Material) */
export function nestLoops(loops) {
  const L = loops.map(l => ({ l, A: Math.abs(loopArea(l)), parent: null, depth: 0 })).sort((a, b) => b.A - a.A);
  for (let i = 0; i < L.length; i++) {
    const p = L[i].l[0];
    for (let j = i - 1; j >= 0; j--) if (pointInLoop(p, L[j].l)) { L[i].parent = L[j]; L[i].depth = L[j].depth + 1; break; }
  }
  const shapes = [];
  for (const o of L) if (o.depth % 2 === 0) shapes.push({ outer: o.l, holes: L.filter(h => h.parent === o).map(h => h.l) });
  return shapes;
}

/** Skizze mit Ausdruecken -> Zahlen */
export function resolveEntities(entities, params) {
  return entities.map(e => {
    const r = { ...e };
    for (const [k, v] of Object.entries(e)) if (!['type', 'id', 'construction', 'n'].includes(k) && (typeof v === 'string' || typeof v === 'number')) {
      if (k === 'type') continue;
      try { r[k] = evalExpr(v, params); } catch { r[k] = Number(v) || 0; }
    }
    if (e.n !== undefined) r.n = Math.max(3, Math.round(evalExpr(e.n, params)));
    return r;
  });
}

// ------------------------------------------------------------------ Volumen erzeugen
/** Extrusion der Profile zwischen w0 und w1 (lokal), dann auf Ebene */
export function extrudeProfiles(shapes, frame, w0, w1, seg = 64) {
  if (!shapes.length) throw new Error('Skizze enthält keine geschlossene Kontur');
  const depth = w1 - w0; if (Math.abs(depth) < 1e-6) throw new Error('Tiefe ist 0');
  const geos = shapes.map(s => {
    const sh = new THREE.Shape(s.outer.map(p => new THREE.Vector2(p.x, p.y)));
    sh.holes = s.holes.map(h => new THREE.Path(h.map(p => new THREE.Vector2(p.x, p.y))));
    const g = new THREE.ExtrudeGeometry(sh, { depth: Math.abs(depth), bevelEnabled: false, curveSegments: Math.max(4, seg / 4) });
    g.translate(0, 0, Math.min(w0, w1));
    return g;
  });
  const g = geos.length === 1 ? prepGeom(geos[0]) : concatGeoms(geos);
  g.applyMatrix4(frame.m);
  return ensureOutward(g);
}

/** Rotationskoerper um Achse in der Skizzenebene (Winkel in Grad) */
export function revolveProfiles(shapes, frame, ax, angleDeg, seg = 64) {
  if (!shapes.length) throw new Error('Skizze enthält keine geschlossene Kontur');
  const p0 = { x: ax.x1, y: ax.y1 }; let d = { x: ax.x2 - ax.x1, y: ax.y2 - ax.y1 };
  const dl = Math.hypot(d.x, d.y); if (dl < 1e-9) throw new Error('Rotationsachse hat Länge 0');
  d = { x: d.x / dl, y: d.y / dl }; let perp = { x: -d.y, y: d.x };
  const toHR = (p) => ({ x: (p.x - p0.x) * d.x + (p.y - p0.y) * d.y, y: (p.x - p0.x) * perp.x + (p.y - p0.y) * perp.y });
  const all = shapes.flatMap(s => [s.outer, ...s.holes]).flat().map(toHR);
  const mn = Math.min(...all.map(p => p.y)), mx = Math.max(...all.map(p => p.y));
  let sgn = 1;
  if (mn < -1e-6 && mx > 1e-6) throw new Error('Profil liegt auf beiden Seiten der Rotationsachse');
  if (mx <= 1e-6) sgn = -1;
  const A3 = frame.to3(p0.x, p0.y); const D3 = frame.x.clone().multiplyScalar(d.x).add(frame.y.clone().multiplyScalar(d.y)).normalize();
  const R3 = frame.x.clone().multiplyScalar(perp.x * sgn).add(frame.y.clone().multiplyScalar(perp.y * sgn)).normalize();
  const N3 = frame.n.clone();
  const full = Math.abs(angleDeg) >= 359.999;
  const ang = Math.abs(angleDeg) * Math.PI / 180 * (angleDeg < 0 ? -1 : 1);
  const steps = Math.max(3, Math.ceil(seg * Math.abs(ang) / (Math.PI * 2)));
  const pos = []; const tri = [];
  const vert = (h, r, phi) => { const v = A3.clone().addScaledVector(D3, h).addScaledVector(R3, r * Math.cos(phi)).addScaledVector(N3, r * Math.sin(phi)); pos.push(v.x, v.y, v.z); return pos.length / 3 - 1; };
  for (const s of shapes) {
    const contours = [s.outer, ...s.holes].map((c, ci) => {
      let hr = c.map(toHR).map(p => ({ x: p.x, y: Math.max(0, p.y * sgn) }));
      const ar = loopArea(hr); if ((ci === 0 && ar < 0) || (ci > 0 && ar > 0)) hr = hr.reverse();
      return hr;
    });
    for (const c of contours) {
      const rings = [];
      for (let j = 0; j <= steps; j++) {
        if (full && j === steps) { rings.push(rings[0]); break; }
        const phi = ang * j / steps; rings.push(c.map(p => vert(p.x, p.y, phi)));
      }
      const n = c.length;
      for (let j = 0; j < steps; j++) for (let i = 0; i < n; i++) {
        const a = rings[j][i], b = rings[j][(i + 1) % n], cc = rings[j + 1][(i + 1) % n], dd = rings[j + 1][i];
        tri.push(a, b, cc, a, cc, dd);
      }
    }
    if (!full) {
      const flat = contours.flat(); const t = THREE.ShapeUtils.triangulateShape(contours[0].map(p => new THREE.Vector2(p.x, p.y)), contours.slice(1).map(h => h.map(p => new THREE.Vector2(p.x, p.y))));
      const i0 = flat.map(p => vert(p.x, p.y, 0)); const i1 = flat.map(p => vert(p.x, p.y, ang));
      for (const [a, b, c] of t) {
        const A = flat[a], B = flat[b], C = flat[c]; const s2 = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
        if (s2 > 0) { tri.push(i0[a], i0[c], i0[b], i1[a], i1[b], i1[c]); } else { tri.push(i0[a], i0[b], i0[c], i1[a], i1[c], i1[b]); }
      }
    }
  }
  // Achsenpunkte (r=0) erzeugen entartete Dreiecke -> raus
  const out = [];
  const P = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  for (let i = 0; i < tri.length; i += 3) { const a = P(tri[i]), b = P(tri[i + 1]), c = P(tri[i + 2]); if (b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() > 1e-14) out.push(tri[i], tri[i + 1], tri[i + 2]); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(out);
  return ensureOutward(prepGeom(g));
}

/** Zylinder / Kegelstumpf von p entlang dir */
export function cylinderTool(p, dir, r1, len, seg = 48, r2 = r1) {
  const g = new THREE.CylinderGeometry(r2, r1, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q); g.translate(p.x, p.y, p.z);
  return ensureOutward(prepGeom(g));
}

/** Prisma aus ebenem 3D-Polygon (senkrecht zu dir) entlang dir */
export function prismTool(polyIn, dir, len) {
  const d = dir.clone().normalize();
  // lokale 2D-Basis mit u x v = d -> CCW in (u,v) bedeutet Normale +d
  const u = polyIn[1].clone().sub(polyIn[0]).normalize(); const v = d.clone().cross(u).normalize();
  const to2 = (p) => new THREE.Vector2(p.clone().sub(polyIn[0]).dot(u), p.clone().sub(polyIn[0]).dot(v));
  let poly = polyIn;
  if (THREE.ShapeUtils.isClockWise(poly.map(to2))) poly = poly.slice().reverse();
  const pos = []; const n = poly.length;
  for (const p of poly) pos.push(p.x, p.y, p.z);
  for (const p of poly) { const q = p.clone().addScaledVector(d, len); pos.push(q.x, q.y, q.z); }
  const pts2 = poly.map(to2);
  const t = THREE.ShapeUtils.triangulateShape(pts2, []);
  const idx = [];
  for (let [a, b, c] of t) {
    const A = pts2[a], B = pts2[b], C = pts2[c];
    if ((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y) < 0) [b, c] = [c, b];
    idx.push(a, c, b, a + n, b + n, c + n); // Boden CW (Normale -d), Deckel CCW
  }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, j, j + n, i, j + n, i + n); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const gg = prepGeom(g);
  // Konsistenz: Deckel vs. Mantel abhaengig vom Umlaufsinn -> ueber Volumen pruefen
  const vol = signedVolume(gg);
  if (Math.abs(vol) < 1e-12) throw new Error('Werkzeugkörper hat kein Volumen');
  return ensureOutward(gg);
}

/** Werkzeug fuer Rundung (kind='round') oder Fase (kind='chamfer') an einer Kante */
export function edgeTool(edge, size, kind = 'round', seg = 48) {
  const A = V3(edge.a), B = V3(edge.b), n1 = V3(edge.n1), n2 = V3(edge.n2);
  const k = n1.dot(n2); if (k < -0.999) throw new Error('Kante ohne Knick');
  const dir = B.clone().sub(A); const len = dir.length(); dir.normalize();
  const s = edge.convex ? -1 : 1; // konvex: Material entfernen
  const r = size; const delta = Math.max(1e-3, r * 0.02);
  const c = A.clone().addScaledVector(n1.clone().add(n2), s * r / (1 + k));
  const t1 = c.clone().addScaledVector(n1, -s * r), t2 = c.clone().addScaledVector(n2, -s * r);
  const bis = n1.clone().add(n2).normalize();
  let T1 = t1, T2 = t2;
  if (kind !== 'round') { T1 = A.clone().addScaledVector(t1.clone().sub(A).normalize(), r); T2 = A.clone().addScaledVector(t2.clone().sub(A).normalize(), r); }
  const poly = [A.clone().addScaledVector(bis, -s * delta), T1.clone().addScaledVector(n1, -s * delta)];
  if (kind === 'round') {
    const u = t1.clone().sub(c).normalize(), w = t2.clone().sub(c).normalize();
    const total = Math.acos(Math.max(-1, Math.min(1, u.dot(w))));
    const ax = u.clone().cross(w).normalize(); const nseg = Math.max(4, Math.ceil(seg * total / (Math.PI * 2)));
    for (let i = 0; i <= nseg; i++) { const q = new THREE.Quaternion().setFromAxisAngle(ax, total * i / nseg); poly.push(c.clone().add(u.clone().applyQuaternion(q).multiplyScalar(r))); }
  } else poly.push(T1.clone(), T2.clone());
  poly.push(T2.clone().addScaledVector(n2, -s * delta));
  const ext = edge.convex ? delta : 0;
  const start = poly.map(p => p.clone().addScaledVector(dir, -ext));
  const tool = prismTool(start, dir, len + 2 * ext);
  return { tool, op: edge.convex ? 'cut' : 'add' };
}

/** Normale + Punkt einer gepickten Flaeche (Weltkoordinaten) -> Ebene */
export function planeFromHit(hit) {
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  const p = hit.point.clone();
  return { origin: v3arr(p), normal: v3arr(n), xdir: null };
}

export function bboxOf(geom) { geom.computeBoundingBox(); return geom.boundingBox.clone(); }
export { THREE };

// ------------------------------------------------------------------ Exakte Konturen fuer den usd-brep-Kern
/**
 * Entitaeten (Zahlenwerte) -> exakte Konturen: [{outer:[kurve], holes:[[kurve]]}]
 * Kurve: {t:'line',a:[x,y],b:[x,y]} | {t:'arc',c:[x,y],r,a0,a1 (Grad, gegen Uhrzeigersinn)} | {t:'circle',c:[x,y],r}
 */
export function sketchCurveLoops(entities, seg = 64) {
  const loops = []; const pieces = []; let axis = null;
  const P = (x, y) => [x, y]; const deg = (r) => r * 180 / Math.PI;
  const line = (a, b) => ({ t: 'line', a, b });
  const arc = (c, r, a0, a1) => ({ t: 'arc', c, r, a0, a1 });
  const poly = (curves) => {
    const pts = [];
    for (const c of curves) {
      if (c.t === 'line') pts.push({ x: c.a[0], y: c.a[1] });
      else if (c.t === 'arc') pts.push(...arcPoints(c.c[0], c.c[1], c.r, c.a0 * Math.PI / 180, c.a1 * Math.PI / 180, seg).slice(0, -1));
      else pts.push(...arcPoints(c.c[0], c.c[1], c.r, 0, Math.PI * 2, seg).slice(0, -1));
    }
    return pts;
  };
  for (const e of entities) {
    if (e.construction) { if (e.type === 'centerline' && !axis) axis = e; continue; }
    switch (e.type) {
      case 'centerline': if (!axis) axis = e; break;
      case 'circle': if (e.r > 0) loops.push([{ t: 'circle', c: P(e.cx, e.cy), r: e.r }]); break;
      case 'rect': {
        const x0 = Math.min(e.x, e.x + e.w), x1 = Math.max(e.x, e.x + e.w), y0 = Math.min(e.y, e.y + e.h), y1 = Math.max(e.y, e.y + e.h);
        if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) break;
        const r = Math.min(e.r || 0, (x1 - x0) / 2 - 1e-6, (y1 - y0) / 2 - 1e-6);
        if (r > 1e-6) {
          loops.push([
            line(P(x0 + r, y0), P(x1 - r, y0)), arc(P(x1 - r, y0 + r), r, 270, 360),
            line(P(x1, y0 + r), P(x1, y1 - r)), arc(P(x1 - r, y1 - r), r, 0, 90),
            line(P(x1 - r, y1), P(x0 + r, y1)), arc(P(x0 + r, y1 - r), r, 90, 180),
            line(P(x0, y1 - r), P(x0, y0 + r)), arc(P(x0 + r, y0 + r), r, 180, 270)]);
        } else loops.push([line(P(x0, y0), P(x1, y0)), line(P(x1, y0), P(x1, y1)), line(P(x1, y1), P(x0, y1)), line(P(x0, y1), P(x0, y0))]);
        break;
      }
      case 'polygon': {
        const v = []; for (let i = 0; i < e.n; i++) { const t = (e.rot || 0) * Math.PI / 180 + i * Math.PI * 2 / e.n; v.push(P(e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t))); }
        loops.push(v.map((p, i) => line(p, v[(i + 1) % v.length]))); break;
      }
      case 'slot': {
        const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1); const r = e.r;
        const at = (cx, cy, ang) => P(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
        const h = Math.PI / 2;
        loops.push([
          arc(P(e.x2, e.y2), r, deg(a - h), deg(a + h)), line(at(e.x2, e.y2, a + h), at(e.x1, e.y1, a + h)),
          arc(P(e.x1, e.y1), r, deg(a + h), deg(a + 3 * h)), line(at(e.x1, e.y1, a + 3 * h), at(e.x2, e.y2, a - h))]);
        break;
      }
      case 'line': pieces.push({ s: P(e.x1, e.y1), e: P(e.x2, e.y2), c: line(P(e.x1, e.y1), P(e.x2, e.y2)) }); break;
      case 'arc': {
        const a0 = e.a0 * Math.PI / 180, a1 = e.a1 * Math.PI / 180;
        pieces.push({ s: P(e.cx + e.r * Math.cos(a0), e.cy + e.r * Math.sin(a0)), e: P(e.cx + e.r * Math.cos(a1), e.cy + e.r * Math.sin(a1)), c: arc(P(e.cx, e.cy), e.r, e.a0, e.a1) });
        break;
      }
      default: break;
    }
  }
  // Linien/Boegen ueber gemeinsame Endpunkte zu geschlossenen Ketten verbinden
  const tol = 1e-4; const same = (p, q) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
  const used = new Array(pieces.length).fill(false); let open = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue; used[i] = true;
    const chain = [pieces[i]]; let start = pieces[i].s, end = pieces[i].e; let grown = true;
    while (grown && !same(start, end)) {
      grown = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue; const pc = pieces[j];
        if (same(pc.s, end)) { end = pc.e; } else if (same(pc.e, end)) { end = pc.s; } else continue;
        chain.push(pc); used[j] = true; grown = true; break;
      }
    }
    if (chain.length >= 2 && same(start, end)) loops.push(chain.map(x => x.c)); else open++;
  }
  // Verschachtelung ueber Polygonnaeherung
  const L = loops.map(curves => { const l = poly(curves); return { curves, l, A: Math.abs(loopArea(l)), parent: null, depth: 0 }; }).sort((a, b) => b.A - a.A);
  for (let i = 0; i < L.length; i++) {
    const p = L[i].l[0];
    for (let j = i - 1; j >= 0; j--) if (pointInPoly(p, L[j].l)) { L[i].parent = L[j]; L[i].depth = L[j].depth + 1; break; }
  }
  const shapes = [];
  for (const o of L) if (o.depth % 2 === 0) shapes.push({ outer: o.curves, holes: L.filter(h => h.parent === o).map(h => h.curves) });
  return { shapes, open, axis };
}
function pointInPoly(pt, l) {
  let inside = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
