// 3Dconnexion SpaceMouse
// Bevorzugt: nativ ueber das Programm (USB-HID per hidapi, Stream /api/sm/stream).
// Rueckfallebene im Browser-Modus: WebHID (Chrome/Edge).
// Unterstuetzt alte Geraete (Report 1 = Translation, 2 = Rotation) und neue (Report 1 mit 12 Byte).
const VENDORS = [0x046d, 0x256f]; // Logitech (alte 3Dconnexion), 3Dconnexion

export const SM_DEFAULTS = {
  sensitivity: 1.0, deadzone: 0.04, pan: true, zoom: true, rotate: true, dominant: false,
  invert: { tx: false, ty: false, tz: false, rx: false, ry: false, rz: false },
  buttons: { 1: 'fit', 2: 'standard' },
};

export class SpaceMouse {
  constructor({ onMotion, onButton, onStatus, native }) {
    this.onMotion = onMotion; this.onButton = onButton; this.onStatus = onStatus || (() => {});
    this.cfg = loadCfg();
    this.t = [0, 0, 0]; this.r = [0, 0, 0]; this.lastInput = 0; this.device = null; this.buttons = 0;
    this.native = !!native?.available; this.nativeName = null;
    this.supported = this.native || 'hid' in navigator;
    if (this.native) { this.startNative(); return; }
    if (this.supported) {
      navigator.hid.addEventListener('disconnect', (e) => { if (e.device === this.device) { this.device = null; this.onStatus('getrennt'); } });
      navigator.hid.addEventListener('connect', () => this.autoConnect());
      this.autoConnect();
    }
  }
  /** Nativer Stream vom Programm */
  startNative() {
    this.onStatus('suche Gerät…');
    const es = new EventSource('/api/sm/stream'); this.es = es;
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.name !== this.nativeName) { this.nativeName = m.name; this.onStatus(m.name ? `verbunden: ${m.name}` : 'kein Gerät gefunden'); }
      this.device = m.name ? { productName: m.name, native: true } : null;
      const norm = (v) => Math.max(-1, Math.min(1, v / 350));
      const moving = m.t.some(v => v) || m.r.some(v => v);
      this.t = m.t.map(norm); this.r = m.r.map(norm);
      if (moving) this.lastInput = performance.now(); else this.lastInput = 0;
      const pressed = m.b & ~this.buttons; this.buttons = m.b;
      for (let i = 0; i < 16; i++) if (pressed & (1 << i)) this.onButton?.(i + 1, this.cfg.buttons[i + 1]);
    };
    es.onerror = () => { this.device = null; this.nativeName = ''; this.onStatus('Verbindung zum Programm unterbrochen'); };
  }
  saveCfg() { try { localStorage.setItem('browsercad.spacemouse', JSON.stringify(this.cfg)); } catch { /* egal */ } }

  async autoConnect() {
    if (!this.supported || this.device) return;
    try {
      const devs = (await navigator.hid.getDevices()).filter(d => VENDORS.includes(d.vendorId));
      if (devs.length) await this.open(devs[0]);
    } catch { /* keine Berechtigung */ }
  }
  async request() {
    if (this.native) throw new Error('Die SpaceMouse wird vom Programm automatisch erkannt – einfach anstecken.');
    if (!this.supported) throw new Error('WebHID wird von diesem Browser nicht unterstützt (Chrome oder Edge verwenden).');
    const devs = await navigator.hid.requestDevice({ filters: VENDORS.map(v => ({ vendorId: v })) });
    if (!devs.length) throw new Error('Kein Gerät gewählt');
    await this.open(devs[0]);
  }
  async open(dev) {
    if (!dev.opened) await dev.open();
    this.device = dev;
    dev.addEventListener('inputreport', (e) => this.report(e));
    this.onStatus(`verbunden: ${dev.productName || 'SpaceMouse'}`);
  }
  report(e) {
    const d = e.data; const id = e.reportId; const s16 = (o) => d.getInt16(o, true);
    const norm = (v) => Math.max(-1, Math.min(1, v / 350));
    if (id === 1) {
      this.t = [norm(s16(0)), norm(s16(2)), norm(s16(4))];
      if (d.byteLength >= 12) this.r = [norm(s16(6)), norm(s16(8)), norm(s16(10))];
      this.lastInput = performance.now();
    } else if (id === 2) {
      this.r = [norm(s16(0)), norm(s16(2)), norm(s16(4))]; this.lastInput = performance.now();
    } else if (id === 3) {
      const b = d.byteLength >= 2 ? d.getUint16(0, true) : d.getUint8(0);
      const pressed = b & ~this.buttons; this.buttons = b;
      for (let i = 0; i < 16; i++) if (pressed & (1 << i)) this.onButton?.(i + 1, this.cfg.buttons[i + 1]);
    }
  }
  /** pro Frame aufrufen */
  frame(dt) {
    if (!this.device) return;
    // nativ: Werte bleiben bis zum naechsten Bericht gueltig (Geraet sendet beim Loslassen Nullen)
    if (!this.native && performance.now() - this.lastInput > 400) { this.t = [0, 0, 0]; this.r = [0, 0, 0]; return; }
    if (this.native && !this.lastInput) return;
    const c = this.cfg; const dz = c.deadzone; const k = c.sensitivity;
    const f = (v, inv) => { const a = Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz); return (inv ? -a : a) * k; };
    // Geraeteachsen: TX rechts, TY vor/zurueck, TZ hoch/runter (gedrueckt = +), RX kippen, RY rollen, RZ drehen
    let tx = f(this.t[0], c.invert.tx), ty = f(this.t[1], c.invert.ty), tz = f(this.t[2], c.invert.tz);
    let rx = f(this.r[0], c.invert.rx), ry = f(this.r[1], c.invert.ry), rz = f(this.r[2], c.invert.rz);
    if (c.dominant) {
      const all = [tx, ty, tz, rx, ry, rz].map(Math.abs); const m = all.indexOf(Math.max(...all));
      [tx, ty, tz, rx, ry, rz] = [tx, ty, tz, rx, ry, rz].map((v, i) => (i === m ? v : 0));
    }
    if (!(tx || ty || tz || rx || ry || rz)) return;
    // Kamera: x rechts, y hoch, Zoom = vor/zurueck
    this.onMotion([tx, -tz, -ty], [-rx, -rz, ry], dt, c);
  }
}

function loadCfg() {
  const base = JSON.parse(JSON.stringify(SM_DEFAULTS));
  try { const s = JSON.parse(localStorage.getItem('browsercad.spacemouse') || '{}'); return { ...base, ...s, invert: { ...base.invert, ...(s.invert || {}) }, buttons: { ...base.buttons, ...(s.buttons || {}) } }; }
  catch { return base; }
}
