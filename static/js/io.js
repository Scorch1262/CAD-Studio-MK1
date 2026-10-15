// Import/Export: STL, STEP (Lesen ueber OpenCascade/WASM, Schreiben als B-Rep mit ebenen Flaechen), USD
import * as THREE from '../vendor/three.module.js';
import { prepGeom, concatGeoms, cleanMesh, ensureOutward } from './geom.js';

// ------------------------------------------------------------------ STL
export function parseSTL(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const isBinary = () => {
    if (u8.length < 84) return false;
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.length) return true;
    const head = new TextDecoder().decode(u8.subarray(0, Math.min(512, u8.length))).trim().toLowerCase();
    return !(head.startsWith('solid') && head.includes('facet'));
  };
  let pos;
  if (isBinary()) {
    const n = dv.getUint32(80, true); pos = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
  } else {
    const txt = new TextDecoder().decode(u8); const arr = [];
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; let m;
    while ((m = re.exec(txt))) arr.push(+m[1], +m[2], +m[3]);
    pos = new Float32Array(arr);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

export function writeSTL(geoms, name = 'BrowserCAD', binary = true) {
  const tris = [];
  for (const g0 of geoms) {
    const g = g0.index ? g0.toNonIndexed() : g0; const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) tris.push(p.subarray(i, i + 9));
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const nrm = (t) => { a.fromArray(t, 0); b.fromArray(t, 3); c.fromArray(t, 6); return b.sub(a).cross(c.sub(a)).normalize(); };
  if (binary) {
    const buf = new ArrayBuffer(84 + tris.length * 50); const dv = new DataView(buf);
    const head = new TextEncoder().encode(`BrowserCAD STL ${name}`.slice(0, 79)); new Uint8Array(buf).set(head);
    dv.setUint32(80, tris.length, true);
    tris.forEach((t, i) => {
      const o = 84 + i * 50; const n = nrm(t);
      dv.setFloat32(o, n.x, true); dv.setFloat32(o + 4, n.y, true); dv.setFloat32(o + 8, n.z, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, t[k], true);
    });
    return new Uint8Array(buf);
  }
  const L = [`solid ${name}`];
  for (const t of tris) {
    const n = nrm(t);
    L.push(` facet normal ${n.x} ${n.y} ${n.z}`, '  outer loop');
    for (let k = 0; k < 9; k += 3) L.push(`   vertex ${t[k]} ${t[k + 1]} ${t[k + 2]}`);
    L.push('  endloop', ' endfacet');
  }
  L.push(`endsolid ${name}`);
  return new TextEncoder().encode(L.join('\n'));
}

// ------------------------------------------------------------------ STEP lesen (OpenCascade WASM)
let occtPromise = null;
function loadOcct() {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = 'vendor/occt/occt-import-js.js';
    s.onload = () => {
      // eslint-disable-next-line no-undef
      occtimportjs({ locateFile: (f) => `vendor/occt/${f}` }).then(resolve, reject);
    };
    s.onerror = () => reject(new Error('OpenCascade-Modul konnte nicht geladen werden'));
    document.head.append(s);
  });
  return occtPromise;
}

/** STEP/IGES -> [{name, color, geom}] in mm */
export async function readCAD(bytes, kind = 'step') {
  const occt = await loadOcct();
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 };
  const res = kind === 'iges' ? occt.ReadIgesFile(bytes, params) : occt.ReadStepFile(bytes, params);
  if (!res || !res.success) throw new Error('Datei konnte nicht gelesen werden (ungültiges STEP/IGES?)');
  const out = [];
  for (const m of res.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.index) g.setIndex(Array.from(m.index.array));
    out.push({ name: m.name || 'Körper', color: m.color || null, geom: ensureOutward(prepGeom(g)) });
  }
  if (!out.length) throw new Error('Datei enthält keine Volumenkörper/Flächen');
  return out;
}

// ------------------------------------------------------------------ STEP schreiben
/**
 * Schreibt geschlossene Dreiecksnetze als STEP AP214 B-Rep.
 * Koplanare, zusammenhaengende Dreiecke werden zu ebenen Flaechen (PLANE + Kanten-Schleifen)
 * zusammengefasst; Kanten werden zwischen Nachbarflaechen geteilt.
 * bodies: [{name, geom, matrix?}]
 */
export function writeSTEP(bodies, productName = 'BrowserCAD') {
  const E = []; let id = 0;
  const add = (s) => { E.push(`#${++id}=${s};`); return `#${id}`; };
  const f = (x) => { if (!isFinite(x) || Math.abs(x) < 1e-12) return '0.'; const s = String(+x.toPrecision(12)); if (s.includes('e')) { let [m, e] = s.split('e'); if (!m.includes('.')) m += '.'; return `${m}E${e}`; } return s.includes('.') ? s : `${s}.`; };
  const str = (s) => `'${String(s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;

  const appCtx = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = add(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const pdCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const lenU = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angU = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solU = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),${lenU},'distance_accuracy_value','confusion accuracy')`);
  const geoCtx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lenU},${angU},${solU}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);
  const pt = (v) => add(`CARTESIAN_POINT('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
  const dirE = (v) => add(`DIRECTION('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
  const originAx = add(`AXIS2_PLACEMENT_3D('',${pt([0, 0, 0])},${dirE([0, 0, 1])},${dirE([1, 0, 0])})`);

  const solids = []; let stats = { faces: 0, edges: 0, open: 0 };
  for (const body of bodies) {
    let g = prepGeom(body.geom); if (body.matrix) g.applyMatrix4(body.matrix);
    const mesh = cleanMesh(g); const { pos, tri } = mesh; const nT = tri.length / 3;
    if (!nT) continue;
    const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    // Dreiecksnormalen + Ebenen
    const N = new Float64Array(nT * 3); const D = new Float64Array(nT);
    for (let t = 0; t < nT; t++) {
      const a = P(tri[t * 3]), b = P(tri[t * 3 + 1]), c = P(tri[t * 3 + 2]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...n) || 1; n = n.map(x => x / l);
      N.set(n, t * 3); D[t] = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    }
    // Kanten -> Dreiecke
    const ek = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
    const edgeTris = new Map();
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const k = ek(tri[t * 3 + e], tri[t * 3 + (e + 1) % 3]); const l = edgeTris.get(k); if (l) l.push(t); else edgeTris.set(k, [t]);
    }
    // Flood-Fill koplanarer Nachbarn
    const group = new Int32Array(nT).fill(-1); const groups = [];
    const tolD = mesh.tol * 20;
    for (let t = 0; t < nT; t++) {
      if (group[t] >= 0) continue;
      const gi = groups.length; const members = [t]; group[t] = gi; const stack = [t];
      while (stack.length) {
        const s = stack.pop();
        for (let e = 0; e < 3; e++) {
          const l = edgeTris.get(ek(tri[s * 3 + e], tri[s * 3 + (e + 1) % 3]));
          if (!l || l.length !== 2) continue;
          const o = l[0] === s ? l[1] : l[0];
          if (group[o] >= 0) continue;
          const dot = N[t * 3] * N[o * 3] + N[t * 3 + 1] * N[o * 3 + 1] + N[t * 3 + 2] * N[o * 3 + 2];
          if (dot > 0.999999 && Math.abs(D[o] - D[t]) < tolD) { group[o] = gi; members.push(o); stack.push(o); }
        }
      }
      groups.push(members);
    }
    // gemeinsame Punkte/Kanten
    const vtxE = new Map(); const vertexPoint = (i) => { let v = vtxE.get(i); if (!v) { v = add(`VERTEX_POINT('',${pt(P(i))})`); vtxE.set(i, v); } return v; };
    const edgeE = new Map();
    const edgeCurve = (a, b) => {
      const k = ek(a, b); let e = edgeE.get(k);
      if (!e) {
        const lo = Math.min(a, b), hi = Math.max(a, b); const A = P(lo), B = P(hi);
        const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]; const L = Math.hypot(...d) || 1;
        const line = add(`LINE('',${pt(A)},${add(`VECTOR('',${dirE(d.map(x => x / L))},${f(L)})`)})`);
        e = { id: add(`EDGE_CURVE('',${vertexPoint(lo)},${vertexPoint(hi)},${line},.T.)`), lo };
        edgeE.set(k, e); stats.edges++;
      }
      return `ORIENTED_EDGE('',*,*,${e.id},${a === e.lo ? '.T.' : '.F.'})`;
    };
    const faces = [];
    for (const members of groups) {
      // Randkanten der Gruppe (gerichtet)
      const inGroup = new Set(members); const next = new Map(); const bnd = [];
      for (const t of members) for (let e = 0; e < 3; e++) {
        const a = tri[t * 3 + e], b = tri[t * 3 + (e + 1) % 3];
        const l = edgeTris.get(ek(a, b));
        const shared = l && l.length === 2 && inGroup.has(l[0]) && inGroup.has(l[1]);
        if (!shared) { bnd.push([a, b]); const arr = next.get(a); if (arr) arr.push(b); else next.set(a, [b]); }
        if (!l || l.length !== 2) stats.open++;
      }
      // Schleifen verketten
      const usedE = new Set(); const loops = [];
      for (const [a0, b0] of bnd) {
        if (usedE.has(`${a0}>${b0}`)) continue;
        const loop = [a0]; let a = a0, b = b0; let guard = 0;
        while (guard++ < 100000) {
          usedE.add(`${a}>${b}`); if (b === a0) break; loop.push(b);
          const cand = (next.get(b) || []).filter(c => !usedE.has(`${b}>${c}`));
          if (!cand.length) break; a = b; b = cand[0];
        }
        if (loop.length >= 3) loops.push(loop);
      }
      if (!loops.length) continue;
      // Aeussere Schleife = groesste Flaeche (in Normalenrichtung positiv)
      const t0 = members[0]; const n = [N[t0 * 3], N[t0 * 3 + 1], N[t0 * 3 + 2]];
      const areaN = (loop) => { let s = [0, 0, 0]; for (let i = 0; i < loop.length; i++) { const p = P(loop[i]), q = P(loop[(i + 1) % loop.length]); s[0] += p[1] * q[2] - p[2] * q[1]; s[1] += p[2] * q[0] - p[0] * q[2]; s[2] += p[0] * q[1] - p[1] * q[0]; } return (s[0] * n[0] + s[1] * n[1] + s[2] * n[2]) / 2; };
      loops.sort((x, y) => areaN(y) - areaN(x));
      const p0 = P(loops[0][0]);
      let xd = [P(loops[0][1])[0] - p0[0], P(loops[0][1])[1] - p0[1], P(loops[0][1])[2] - p0[2]];
      const dn = xd[0] * n[0] + xd[1] * n[1] + xd[2] * n[2]; xd = xd.map((v, i) => v - dn * n[i]); const xl = Math.hypot(...xd) || 1; xd = xd.map(v => v / xl);
      const plane = add(`PLANE('',${add(`AXIS2_PLACEMENT_3D('',${pt(p0)},${dirE(n)},${dirE(xd)})`)})`);
      const bounds = loops.map((loop, li) => {
        const oes = loop.map((a, i) => add(edgeCurve(a, loop[(i + 1) % loop.length])));
        const el = add(`EDGE_LOOP('',(${oes.join(',')}))`);
        return add(`${li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${el},.T.)`);
      });
      faces.push(add(`ADVANCED_FACE('',(${bounds.join(',')}),${plane},.T.)`));
      stats.faces++;
    }
    if (!faces.length) continue;
    const shell = add(`CLOSED_SHELL('',(${faces.join(',')}))`);
    solids.push(add(`MANIFOLD_SOLID_BREP(${str(body.name || 'Solid')},${shell})`));
  }
  const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(productName)},(${[originAx, ...solids].join(',')}),${geoCtx})`);
  const prod = add(`PRODUCT(${str(productName)},${str(productName)},'',(${prodCtx}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${prod}))`);
  const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pd = add(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = add(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  const now = new Date().toISOString().slice(0, 19);
  const header = [
    'ISO-10303-21;', 'HEADER;',
    `FILE_DESCRIPTION(('BrowserCAD export'),'2;1');`,
    `FILE_NAME(${str(productName + '.stp')},'${now}',(''),(''),'BrowserCAD','BrowserCAD','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
  ];
  const text = [...header, ...E, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  return { text, stats };
}

// ------------------------------------------------------------------ USD (OpenUSD ASCII, Netz)
export function writeUSDA(bodies, name = 'BrowserCAD') {
  const safe = (s) => (String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'Body');
  const L = ['#usda 1.0', '(', `    defaultPrim = "${safe(name)}"`, '    metersPerUnit = 0.001', '    upAxis = "Y"', '    doc = "Exportiert von BrowserCAD"', ')', '', `def Xform "${safe(name)}"`, '{'];
  const used = new Set();
  bodies.forEach((b, bi) => {
    let g = prepGeom(b.geom); if (b.matrix) g.applyMatrix4(b.matrix);
    const m = cleanMesh(g); let nm = safe(b.name || `Body${bi}`); while (used.has(nm)) nm += '_'; used.add(nm);
    const pts = []; for (let i = 0; i < m.pos.length; i += 3) pts.push(`(${m.pos[i]}, ${m.pos[i + 1]}, ${m.pos[i + 2]})`);
    const c = b.color || [0.7, 0.74, 0.78];
    L.push(`    def Mesh "${nm}"`, '    {', `        int[] faceVertexCounts = [${new Array(m.tri.length / 3).fill(3).join(', ')}]`,
      `        int[] faceVertexIndices = [${Array.from(m.tri).join(', ')}]`, `        point3f[] points = [${pts.join(', ')}]`,
      '        uniform token subdivisionScheme = "none"', `        color3f[] primvars:displayColor = [(${c.join(', ')})]`, '    }');
  });
  L.push('}', '');
  return L.join('\n');
}

export function geomsFromImport(list) { return concatGeoms(list.map(x => x.geom)); }
