// Baugruppen: Komponenten, Platzierung mit Bedingungen (Koinzident/Ausrichten/Abstand), Regenerierung
import * as THREE from '../vendor/three.module.js';
import { uid, evalExpr, evalParams } from './util.js';
import { regenerate, defaultLayers } from './part.js';
import * as G from './geom.js';

export const ASM_FORMAT = 'cadstudio-assembly';
export const ASM_DATUMS = {
  ASM_RIGHT: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 0, -1] },
  ASM_TOP: { origin: [0, 0, 0], normal: [0, 1, 0], xdir: [1, 0, 0] },
  ASM_FRONT: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
};
export const CONSTRAINT_NAMES = { mate: 'Koinzident', align: 'Ausrichten', distance: 'Abstand' };

export function newAssembly(name = 'ASM0001') {
  return { format: ASM_FORMAT, version: 1, name, units: 'mm', params: [], components: [], layers: defaultLayers('ASM') };
}
export function newComponent(file, name) {
  return { id: uid('c'), file, name, matrix: new THREE.Matrix4().toArray(), constraints: [], hidden: false, suppressed: false };
}

/**
 * Baugruppe regenerieren.
 * loadDoc(file) -> Promise<partOrAsmJson>  (beruecksichtigt offene, ungespeicherte Fenster)
 */
export async function regenerateAssembly(asm, loadDoc, cache, depth = 0, stack = []) {
  const params = evalParams(asm.params);
  const out = { comps: [], errors: [], planes: new Map(), axes: new Map(), points: new Map(), csys: new Map(), bbox: new THREE.Box3() };
  for (const [id, pl] of Object.entries(ASM_DATUMS)) out.planes.set(id, { frame: G.planeFrame(pl), name: id, fid: id });
  out.csys.set('ASM_DEF_CSYS', { name: 'ASM_DEF_CSYS' });
  const world = new Map();
  for (const c of asm.components) {
    const entry = { comp: c, matrix: new THREE.Matrix4().fromArray(c.matrix), kind: null, regen: null, children: null, error: null };
    out.comps.push(entry);
    if (c.suppressed) continue;
    try {
      if (stack.includes(c.file)) throw new Error('Zirkulärer Verweis auf ' + c.file);
      const data = await loadDoc(c.file);
      if (data.format === ASM_FORMAT) {
        if (depth > 6) throw new Error('Baugruppe zu tief verschachtelt');
        entry.kind = 'assembly';
        entry.sub = await regenerateAssembly(data, loadDoc, cache, depth + 1, [...stack, c.file]);
      } else {
        entry.kind = 'part';
        const key = c.file + '|' + JSON.stringify(data).length + '|' + (data._rev || '');
        let r = cache.get(key);
        if (!r) { r = await regenerate(data); cache.set(key, r); }
        entry.regen = r; entry.color = c.color || data.color;
        if (r.errors.length) entry.error = `${r.errors.length} Feature-Fehler im Part`;
      }
      entry.data = data;
      // Bedingungen loesen
      if (c.constraints?.length) {
        const m = solve(c, entry, world, params);
        entry.matrix = m; c.matrix = m.toArray();
      }
    } catch (e) { entry.error = e.message; out.errors.push({ id: c.id, name: c.name, msg: e.message }); }
    world.set(c.id, entry);
    const bb = entryBox(entry); if (bb && !c.hidden) out.bbox.union(bb);
  }
  return out;
}

export function entryBox(entry) {
  let bb = null;
  if (entry.regen?.display) bb = entry.regen.display.boundingBox.clone();
  else if (entry.sub && !entry.sub.bbox.isEmpty()) bb = entry.sub.bbox.clone();
  return bb ? bb.applyMatrix4(entry.matrix) : null;
}

/** Bezugsflaeche einer Bedingung in Weltkoordinaten */
export function refWorld(ref, world) {
  if (ref.datum) { const f = G.planeFrame(ASM_DATUMS[ref.datum]); return { p: f.o, n: f.n }; }
  const e = world.get(ref.compId); if (!e) throw new Error('Referenzkomponente fehlt');
  const m = e.matrix; return { p: new THREE.Vector3(...ref.point).applyMatrix4(m), n: new THREE.Vector3(...ref.normal).transformDirection(m).normalize() };
}

/** Sequenzieller Loeser: 1. Bedingung voll, 2. nur Drehung um n1 + Verschiebung in der Ebene, 3. nur Verschiebung */
function solve(c, entry, world, params) {
  const m0 = new THREE.Matrix4().fromArray(c.matrix);
  const R = new THREE.Quaternion(); const t = new THREE.Vector3(); const sc = new THREE.Vector3();
  m0.decompose(t, R, sc);
  let axis1 = null, move2 = null;
  c.constraints.forEach((k, i) => {
    if (k.disabled) return;
    const tg = refWorld(k.target, world);
    const pl = new THREE.Vector3(...k.comp.point), nl = new THREE.Vector3(...k.comp.normal).normalize();
    const s = k.type === 'align' ? 1 : -1;
    const want = tg.n.clone().multiplyScalar(s);
    const off = k.type === 'distance' || k.type === 'align' ? evalExpr(k.offset ?? 0, params) : 0;
    const cur = () => nl.clone().applyQuaternion(R);
    const rotAbout = (q, center) => { R.premultiply(q); t.sub(center).applyQuaternion(q).add(center); };
    if (!axis1) {
      const q = new THREE.Quaternion().setFromUnitVectors(cur(), want);
      if (q.lengthSq() > 0) rotAbout(q, pl.clone().applyQuaternion(R).add(t));
      const P = pl.clone().applyQuaternion(R).add(t);
      const dist = P.clone().sub(tg.p).dot(tg.n);
      t.addScaledVector(tg.n, off - dist);
      axis1 = tg.n.clone();
    } else if (!move2) {
      const a = axis1; const u = cur(); u.sub(a.clone().multiplyScalar(u.dot(a))); const w = want.clone(); w.sub(a.clone().multiplyScalar(w.dot(a)));
      if (u.lengthSq() > 1e-8 && w.lengthSq() > 1e-8) {
        u.normalize(); w.normalize(); let ang = Math.acos(THREE.MathUtils.clamp(u.dot(w), -1, 1));
        if (u.clone().cross(w).dot(a) < 0) ang = -ang;
        const P0 = pl.clone().applyQuaternion(R).add(t);
        rotAbout(new THREE.Quaternion().setFromAxisAngle(a, ang), P0);
      }
      const mdir = tg.n.clone().sub(a.clone().multiplyScalar(tg.n.dot(a)));
      if (mdir.lengthSq() > 1e-8) {
        mdir.normalize(); const P = pl.clone().applyQuaternion(R).add(t); const dist = P.clone().sub(tg.p).dot(tg.n);
        const den = mdir.dot(tg.n); if (Math.abs(den) > 1e-6) t.addScaledVector(mdir, (off - dist) / den);
        move2 = mdir;
      } else k._warn = 'parallel zur 1. Bedingung';
    } else {
      const e = axis1.clone().cross(move2).normalize(); const P = pl.clone().applyQuaternion(R).add(t);
      const dist = P.clone().sub(tg.p).dot(tg.n); const den = e.dot(tg.n);
      if (Math.abs(den) > 1e-6) t.addScaledVector(e, (off - dist) / den); else k._warn = 'keine freie Richtung';
    }
    k._ok = i;
  });
  return new THREE.Matrix4().compose(t, R, new THREE.Vector3(1, 1, 1));
}

/** Alle Koerper der Baugruppe in Weltkoordinaten (fuer Export/Analyse) */
export function flattenBodies(res, parent = new THREE.Matrix4(), prefix = '') {
  const out = [];
  for (const e of res.comps) {
    if (e.comp.suppressed || e.comp.hidden) continue;
    const m = parent.clone().multiply(e.matrix);
    if (e.regen?.display) out.push({ name: prefix + e.comp.name, geom: e.regen.display, matrix: m, color: e.color });
    if (e.sub) out.push(...flattenBodies(e.sub, m, prefix + e.comp.name + '_'));
  }
  return out;
}
