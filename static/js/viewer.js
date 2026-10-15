// 3D-Ansicht: orthografische Kamera, Creo-Maussteuerung, Ansichten, Beschriftungen, Picken
import * as THREE from '../vendor/three.module.js';

export const VIEWS = {
  standard: { dir: [1, 0.75, 1.15], up: [0, 1, 0], label: 'Standardausrichtung' },
  FRONT: { dir: [0, 0, 1], up: [0, 1, 0], label: 'FRONT' },
  BACK: { dir: [0, 0, -1], up: [0, 1, 0], label: 'BACK' },
  TOP: { dir: [0, 1, 0], up: [0, 0, -1], label: 'TOP' },
  BOTTOM: { dir: [0, -1, 0], up: [0, 0, 1], label: 'BOTTOM' },
  LEFT: { dir: [-1, 0, 0], up: [0, 1, 0], label: 'LEFT' },
  RIGHT: { dir: [1, 0, 0], up: [0, 1, 0], label: 'RIGHT' },
  ISO: { dir: [1, 1, 1], up: [0, 1, 0], label: 'Isometrisch' },
};

export class Viewer {
  constructor(container) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    container.append(this.renderer.domElement);
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 'labels';
    container.append(this.labelLayer);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camera.position.set(100, 80, 120); this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xe8eef5, 0x3a4048, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(0.6, 1.0, 1.4); this.camera.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45); fill.position.set(-1, -0.4, 0.6); this.camera.add(fill);

    this.world = new THREE.Group(); this.scene.add(this.world);      // Modell
    this.datums = new THREE.Group(); this.scene.add(this.datums);    // Bezugselemente
    this.overlay = new THREE.Group(); this.scene.add(this.overlay);  // Skizze, Vorschau, Hervorhebung
    this.pivot = new THREE.Vector3();
    this.labels = [];
    this.dirty = true;
    this.handlers = { click: null, hover: null, dblclick: null, context: null };
    this.inputCapture = null; // z. B. Skizzierer
    this.raycaster = new THREE.Raycaster();
    this.anim = null;
    this.spinCenterVisible = true;
    this._initSpin();
    this._bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    const loop = (t) => { requestAnimationFrame(loop); this._tick(t); };
    requestAnimationFrame(loop);
  }

  _initSpin() {
    const g = new THREE.Group();
    const mk = (c, axis) => { const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...axis)]); return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, depthTest: false })); };
    g.add(mk(0xff5050, [1, 0, 0]), mk(0x50ff70, [0, 1, 0]), mk(0x5090ff, [0, 0, 1]));
    g.renderOrder = 999; this.spinMarker = g; this.scene.add(g);
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    const a = w / h; this.camera.left = -a; this.camera.right = a; this.camera.top = 1; this.camera.bottom = -1;
    this.camera.updateProjectionMatrix(); this.dirty = true;
  }

  /** Pixel -> Weltlaenge */
  pxToWorld(px = 1) { return px * 2 / (this.el.clientHeight * this.camera.zoom); }

  ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  pick(ev, objects, { lineTol = 6, pointTol = 8 } = {}) {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    this.raycaster.params.Line.threshold = this.pxToWorld(lineTol);
    this.raycaster.params.Points.threshold = this.pxToWorld(pointTol);
    return this.raycaster.intersectObjects(objects, true).filter(h => h.object.visible && visibleChain(h.object));
  }
  rayToPlane(ev, frame) {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.n, frame.o);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(pl, p) ? p : null;
  }

  // ------------------------------------------------------------ Kamera
  _rotate(ax, ay) {
    const cam = this.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const q = new THREE.Quaternion().setFromAxisAngle(up, -ax).multiply(new THREE.Quaternion().setFromAxisAngle(right, -ay));
    this._applyRot(q);
  }
  _applyRot(q, center = this.pivot) {
    const cam = this.camera;
    cam.position.sub(center).applyQuaternion(q).add(center);
    cam.quaternion.premultiply(q); cam.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.dirty = true;
  }
  _pan(dxPx, dyPx) {
    const s = this.pxToWorld(1); const cam = this.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    cam.position.addScaledVector(right, -dxPx * s).addScaledVector(up, dyPx * s);
    this.dirty = true;
  }
  zoomAt(factor, ndc = new THREE.Vector2()) {
    const cam = this.camera;
    const before = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(cam);
    cam.zoom = THREE.MathUtils.clamp(cam.zoom * factor, 1e-6, 1e6); cam.updateProjectionMatrix();
    const after = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(cam);
    cam.position.add(before.sub(after));
    this.dirty = true;
  }

  /** Einpassen (Refit) */
  fit(box, keepDir = true) {
    if (!box || box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    const c = box.getCenter(new THREE.Vector3()); const r = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = this.camera;
    const dir = keepDir ? new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion) : new THREE.Vector3(1, 1, 1).normalize();
    cam.position.copy(c).addScaledVector(dir, r * 4);
    const a = this.el.clientWidth / this.el.clientHeight;
    cam.zoom = 1 / (r * 1.1) * Math.min(1, a); cam.near = -r * 50; cam.far = r * 50;
    cam.updateProjectionMatrix();
    this.pivot.copy(c); this.modelRadius = r; this.dirty = true;
  }

  /** Gespeicherte Ausrichtung, optional animiert */
  setView(name, box, animate = true) {
    const v = VIEWS[name]; if (!v) return;
    this.orient(new THREE.Vector3(...v.dir).normalize(), new THREE.Vector3(...v.up), box, animate);
  }
  orient(dir, up, box, animate = true) {
    const cam = this.camera;
    const target = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), up));
    const finish = () => { this.fit(box, true); };
    if (!animate) { cam.quaternion.copy(target); cam.up.copy(up); finish(); return; }
    const q0 = cam.quaternion.clone(); const t0 = performance.now(); const dur = 280;
    this.anim = (t) => {
      const k = Math.min(1, (t - t0) / dur); const e = k * (2 - k);
      cam.quaternion.slerpQuaternions(q0, target, e);
      const d = new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion);
      cam.position.copy(this.pivot).addScaledVector(d, (this.modelRadius || 100) * 4);
      this.dirty = true;
      if (k >= 1) { this.anim = null; cam.up.copy(up); finish(); }
    };
  }

  // ------------------------------------------------------------ Beschriftungen
  clearLabels(group = 'datum') {
    this.labels = this.labels.filter(l => { if (l.group === group) { l.el.remove(); return false; } return true; });
  }
  addLabel(text, pos, cls = 'lbl', group = 'datum', obj = null) {
    const e = document.createElement('div'); e.className = cls; e.textContent = text;
    this.labelLayer.append(e); const l = { el: e, pos: pos.clone(), group, obj }; this.labels.push(l); this.dirty = true; return l;
  }

  // ------------------------------------------------------------ Eingabe
  _bindInput() {
    const dom = this.renderer.domElement;
    let drag = null;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      const nav = e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 2 && e.altKey);
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, nav, moved: false,
        mode: e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'zoom' : 'rotate' };
      if (e.button === 2 && !e.altKey) drag.nav = false;
      if (!drag.nav && this.inputCapture?.down) this.inputCapture.down(e);
      if (drag.nav) e.preventDefault();
    });
    dom.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true;
        if (drag.nav) {
          if (drag.mode === 'pan') this._pan(dx, dy);
          else if (drag.mode === 'zoom') this.zoomAt(Math.exp(-dy * 0.01), this.ndc({ clientX: drag.sx, clientY: drag.sy }));
          else if (!this.rotateLocked) this._rotate(dx * 0.008, dy * 0.008);
          else this._pan(dx, dy);
          return;
        }
        if (this.inputCapture?.drag && e.buttons === 1) { this.inputCapture.drag(e); return; }
      }
      if (this.inputCapture?.move) this.inputCapture.move(e);
      else if (this.handlers.hover) this.handlers.hover(e);
    });
    dom.addEventListener('pointerup', (e) => {
      const d = drag; drag = null;
      if (!d) return;
      if (d.nav) return;
      if (this.inputCapture?.up) this.inputCapture.up(e, d.moved);
      if (d.moved) return;
      if (e.button === 0) {
        if (this.inputCapture?.click) this.inputCapture.click(e);
        else if (this.handlers.click) this.handlers.click(e);
      } else if (e.button === 2) {
        if (this.inputCapture?.context) this.inputCapture.context(e);
        else if (this.handlers.context) this.handlers.context(e);
      }
    });
    dom.addEventListener('dblclick', (e) => { if (this.inputCapture?.dblclick) this.inputCapture.dblclick(e); else if (this.handlers.dblclick) this.handlers.dblclick(e); });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Trackpad-Pinch kommt als ctrl+wheel
      const k = e.deltaMode === 1 ? 0.06 : 0.0018;
      this.zoomAt(Math.exp(-e.deltaY * k), this.ndc(e));
    }, { passive: false });
    dom.addEventListener('pointerleave', () => { if (this.handlers.hover) this.handlers.hover(null); });
  }

  /** SpaceMouse: t = Translation, r = Rotation (normiert), dt in s */
  spaceMouse(t, r, dt, cfg) {
    if (this.anim) return;
    const s = (this.modelRadius || 100);
    const cam = this.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    if (cfg.pan) {
      const k = 1.5 * dt / cam.zoom; // volle Auslenkung: ~1,5 Bildhoehen/2 pro Sekunde
      // Objektmodus: Modell folgt der Kappe -> Kamera bewegt sich entgegengesetzt
      cam.position.addScaledVector(right, -t[0] * k).addScaledVector(up, -t[1] * k);
      this.dirty = true;
    }
    if (cfg.zoom && Math.abs(t[2]) > 0) this.zoomAt(Math.exp(t[2] * dt * 1.6));
    if (cfg.rotate && !this.rotateLocked) {
      const q = new THREE.Quaternion()
        .setFromAxisAngle(right, r[0] * dt * 1.8)
        .multiply(new THREE.Quaternion().setFromAxisAngle(up, r[1] * dt * 1.8))
        .multiply(new THREE.Quaternion().setFromAxisAngle(fwd, -r[2] * dt * 1.8));
      this._applyRot(q);
    }
  }

  _tick(t) {
    if (this.anim) this.anim(t);
    if (this.onFrame) this.onFrame(t);
    if (!this.dirty) return;
    this.dirty = false;
    // Drehzentrum-Markierung (Bildschirmgroesse konstant)
    this.spinMarker.visible = this.spinCenterVisible;
    this.spinMarker.position.copy(this.pivot); this.spinMarker.scale.setScalar(this.pxToWorld(22));
    this.renderer.render(this.scene, this.camera);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const l of this.labels) {
      const vis = !l.obj || visibleChain(l.obj);
      if (!vis) { l.el.style.display = 'none'; continue; }
      const p = l.pos.clone().project(this.camera);
      const x = (p.x + 1) / 2 * w, y = (1 - p.y) / 2 * h;
      l.el.style.display = (x < -50 || x > w + 50 || y < -20 || y > h + 20) ? 'none' : '';
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
  request() { this.dirty = true; }
  screenshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

export function visibleChain(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }
