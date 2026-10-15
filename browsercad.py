#!/usr/bin/env python3
"""
BrowserCAD - CAD-Programm im Stil von PTC Creo Parametric.

Laeuft als eigenstaendiges Desktop-Programm mit eigenem Fenster
(Windows: WebView2, macOS: WKWebView ueber pywebview). Intern arbeitet ein
lokaler Server auf 127.0.0.1, der nur vom Programmfenster genutzt wird.
Die 3Dconnexion SpaceMouse wird direkt per USB-HID (hidapi) gelesen.

Startmodi:  (Standard) eigenes Fenster
            --browser   Oberflaeche im Standardbrowser
            --server    nur Server (Tests/CI), auch BROWSERCAD_MODE=server

Alle Dateien (Parts, Baugruppen, Importe, Exporte) liegen im Arbeitsverzeichnis,
das beim Start festgelegt wird.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import platform
import shlex
import shutil
import socket
import string
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

# --- Fensterprogramm ohne Konsole: Ausgaben in eine Logdatei umleiten ---
_LOG_DIR = Path.home() / ".browsercad"
if sys.stdout is None or sys.stderr is None or getattr(sys, "frozen", False):
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        _log = open(_LOG_DIR / "browsercad.log", "w", encoding="utf-8", buffering=1)
        sys.stdout = _log
        sys.stderr = _log
    except OSError:
        sys.stdout = sys.stdout or open(os.devnull, "w")
        sys.stderr = sys.stderr or open(os.devnull, "w")

# Windows kennt .js teils als text/plain -> ES-Module wuerden nicht laden
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/css", ".css")

from flask import Flask, Response, jsonify, request, send_from_directory, abort  # noqa: E402


def resource_dir() -> Path:
    """Ordner mit static/ und VERSION (auch im PyInstaller-Bundle)."""
    if getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


RES = resource_dir()
STATIC = RES / "static"
try:
    VERSION = (RES / "VERSION").read_text(encoding="utf-8").strip()
except OSError:
    VERSION = "0.0.0"

APP_ID = "BrowserCAD"
CONFIG_DIR = Path.home() / ".browsercad"
CONFIG_FILE = CONFIG_DIR / "config.json"
DEFAULT_PORT = 8765

DEFAULT_CONFIG = {
    "workdir": "",
    "recent": [],
    "port": DEFAULT_PORT,
    "ui_mode": "desktop",  # desktop = eigenes Fenster, browser = Standardbrowser
    # Externe Konverter fuer proprietaere Formate. Platzhalter: {in} {out}
    # Ergebnis muss eine STEP-Datei unter {out} sein.
    "converters": {
        "creo": "",
        "solidworks": "",
    },
}

CREO_EXT = (".prt", ".asm")
SW_EXT = (".sldprt", ".sldasm")

_lock = threading.Lock()


# ---------------------------------------------------------------- Konfiguration
def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        for k, v in data.items():
            if k == "converters" and isinstance(v, dict):
                cfg["converters"].update(v)
            else:
                cfg[k] = v
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, CONFIG_FILE)


CFG = load_config()


def workdir() -> Path | None:
    wd = CFG.get("workdir") or ""
    if wd and Path(wd).is_dir():
        return Path(wd)
    return None


def safe_path(rel: str) -> Path:
    """Relativer Pfad -> absoluter Pfad innerhalb des Arbeitsverzeichnisses."""
    wd = workdir()
    if wd is None:
        abort(409, "Kein Arbeitsverzeichnis festgelegt")
    rel = (rel or "").replace("\\", "/").lstrip("/")
    p = (wd / rel).resolve()
    try:
        p.relative_to(wd.resolve())
    except ValueError:
        abort(403, "Pfad ausserhalb des Arbeitsverzeichnisses")
    return p


def file_kind(name: str) -> str:
    n = name.lower()
    # Creo-Versionsendung abschneiden: teil.prt.12 -> teil.prt
    parts = n.rsplit(".", 1)
    if len(parts) == 2 and parts[1].isdigit():
        n = parts[0]
    if n.endswith(".bcprt"):
        return "part"
    if n.endswith(".bcasm"):
        return "assembly"
    if n.endswith((".stp", ".step")):
        return "step"
    if n.endswith((".igs", ".iges")):
        return "iges"
    if n.endswith(".stl"):
        return "stl"
    if n.endswith(CREO_EXT):
        return "creo"
    if n.endswith(SW_EXT):
        return "solidworks"
    if n.endswith((".usda", ".usd")):
        return "usd"
    return "other"


# ---------------------------------------------------------------------- Flask
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB


@app.after_request
def no_cache(resp: Response):
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/<path:p>")
def static_files(p):
    return send_from_directory(STATIC, p)


@app.get("/api/state")
def api_state():
    wd = workdir()
    return jsonify(
        app=APP_ID,
        version=VERSION,
        workdir=str(wd) if wd else "",
        recent=[r for r in CFG.get("recent", []) if Path(r).is_dir()][:10],
        converters=CFG.get("converters", {}),
        ui_mode=CFG.get("ui_mode", "desktop"),
        mode=RUN_MODE,
        hid=SPACEMOUSE.status(),
        kernel=cadkernel.KERNEL.info(),
        platform=platform.system(),
        home=str(Path.home()),
    )


@app.post("/api/workdir")
def api_workdir():
    data = request.get_json(force=True) or {}
    path = (data.get("path") or "").strip().strip('"')
    if not path:
        return jsonify(ok=False, error="Kein Pfad angegeben"), 400
    p = Path(os.path.expanduser(path))
    if not p.exists():
        if data.get("create"):
            try:
                p.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                return jsonify(ok=False, error=f"Ordner konnte nicht angelegt werden: {e}"), 400
        else:
            return jsonify(ok=False, error="Ordner existiert nicht", missing=True), 404
    if not p.is_dir():
        return jsonify(ok=False, error="Pfad ist kein Ordner"), 400
    if not os.access(p, os.W_OK):
        return jsonify(ok=False, error="Keine Schreibrechte in diesem Ordner"), 400
    p = p.resolve()
    with _lock:
        CFG["workdir"] = str(p)
        rec = [str(p)] + [r for r in CFG.get("recent", []) if r != str(p)]
        CFG["recent"] = rec[:10]
        save_config(CFG)
    return jsonify(ok=True, workdir=str(p))


@app.get("/api/browse")
def api_browse():
    """Ordnerauswahl fuer das Arbeitsverzeichnis (nur Ordner)."""
    path = request.args.get("path") or str(workdir() or Path.home())
    p = Path(os.path.expanduser(path))
    drives = []
    if platform.system() == "Windows":
        for d in string.ascii_uppercase:
            if os.path.exists(f"{d}:\\"):
                drives.append(f"{d}:\\")
    if not p.is_dir():
        p = Path.home()
    dirs = []
    try:
        for e in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            try:
                if e.is_dir() and not e.name.startswith("."):
                    dirs.append(e.name)
            except OSError:
                pass
    except OSError as e:
        return jsonify(path=str(p), parent=str(p.parent), dirs=[], drives=drives, error=str(e))
    return jsonify(path=str(p), parent=str(p.parent) if p.parent != p else "", dirs=dirs, drives=drives)


@app.get("/api/files")
def api_files():
    """Dateien im Arbeitsverzeichnis (rekursiv, max. 4 Ebenen)."""
    wd = workdir()
    if wd is None:
        return jsonify(ok=False, error="Kein Arbeitsverzeichnis"), 409
    sub = request.args.get("dir", "")
    base = safe_path(sub) if sub else wd
    out = []
    base_depth = len(base.parts)
    for root, dirs, files in os.walk(base):
        r = Path(root)
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        if len(r.parts) - base_depth >= 4:
            dirs[:] = []
        for f in files:
            if f.startswith("."):
                continue
            fp = r / f
            kind = file_kind(f)
            if kind == "other":
                continue
            try:
                st = fp.stat()
            except OSError:
                continue
            out.append(
                dict(
                    path=fp.relative_to(wd).as_posix(),
                    name=f,
                    kind=kind,
                    size=st.st_size,
                    mtime=st.st_mtime,
                )
            )
    out.sort(key=lambda x: x["path"].lower())
    return jsonify(ok=True, workdir=str(wd), files=out)


@app.get("/api/file")
def api_file_get():
    p = safe_path(request.args.get("path", ""))
    if not p.is_file():
        abort(404, "Datei nicht gefunden")
    as_dl = request.args.get("download") == "1"
    return send_from_directory(p.parent, p.name, as_attachment=as_dl)


@app.put("/api/file")
def api_file_put():
    p = safe_path(request.args.get("path", ""))
    p.parent.mkdir(parents=True, exist_ok=True)
    data = request.get_data()
    # Sicherung der Vorversion (wie Creo-Versionen, aber nur eine Stufe)
    if p.exists() and request.args.get("backup", "1") == "1" and p.suffix.lower() in (".bcprt", ".bcasm"):
        try:
            shutil.copy2(p, p.with_name(p.name + ".bak"))
        except OSError:
            pass
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, p)
    return jsonify(ok=True, path=p.relative_to(workdir()).as_posix(), size=len(data))


@app.delete("/api/file")
def api_file_delete():
    p = safe_path(request.args.get("path", ""))
    if p.is_file():
        p.unlink()
    return jsonify(ok=True)


@app.post("/api/upload")
def api_upload():
    wd = workdir()
    if wd is None:
        return jsonify(ok=False, error="Kein Arbeitsverzeichnis"), 409
    saved = []
    for f in request.files.getlist("files"):
        name = os.path.basename(f.filename or "upload.bin")
        target = safe_path(name)
        f.save(target)
        saved.append(target.relative_to(wd).as_posix())
    return jsonify(ok=True, files=saved)


@app.post("/api/convert")
def api_convert():
    """Proprietaere Formate (Creo/SolidWorks) per externem Konverter nach STEP."""
    data = request.get_json(force=True) or {}
    src = safe_path(data.get("path", ""))
    kind = file_kind(src.name)
    if kind not in ("creo", "solidworks"):
        return jsonify(ok=False, error="Kein Creo-/SolidWorks-Format"), 400
    cmd_tpl = (CFG.get("converters", {}) or {}).get(kind, "").strip()
    if not cmd_tpl:
        return jsonify(
            ok=False,
            needs_converter=True,
            error=(
                "Fuer dieses Format ist kein Konverter eingerichtet. "
                "Native Creo- und SolidWorks-Dateien sind proprietaer und lassen sich ohne "
                "Hersteller-Software nicht lesen. Entweder die Datei im Ursprungsprogramm als "
                "STEP exportieren oder unter Werkzeuge > Optionen einen Konverter-Befehl eintragen."
            ),
        ), 400
    conv_dir = workdir() / "_konvertiert"
    conv_dir.mkdir(exist_ok=True)
    stem = src.name.split(".")[0]
    out = conv_dir / f"{stem}.stp"
    cmd = cmd_tpl.replace("{in}", f'"{src}"').replace("{out}", f'"{out}"')
    try:
        args = cmd if platform.system() == "Windows" else shlex.split(cmd)
        res = subprocess.run(args, shell=False, capture_output=True, text=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, error=f"Konverter konnte nicht gestartet werden: {e}"), 500
    if not out.is_file():
        return jsonify(
            ok=False,
            error="Konverter hat keine STEP-Datei erzeugt.",
            stdout=res.stdout[-2000:],
            stderr=res.stderr[-2000:],
        ), 500
    return jsonify(ok=True, path=out.relative_to(workdir()).as_posix())


@app.post("/api/config")
def api_config():
    data = request.get_json(force=True) or {}
    with _lock:
        if isinstance(data.get("converters"), dict):
            CFG["converters"].update({k: str(v) for k, v in data["converters"].items()})
        if data.get("ui_mode") in ("desktop", "browser"):
            CFG["ui_mode"] = data["ui_mode"]
        save_config(CFG)
    return jsonify(ok=True)


# ------------------------------------------------------------------ Modellierkern usd-brep
import kernel as cadkernel  # noqa: E402


@app.get("/api/kernel/info")
def api_kernel_info():
    return jsonify(cadkernel.KERNEL.info())


@app.get("/api/kernel/selftest")
def api_kernel_selftest():
    try:
        return jsonify(ok=True, kernel=cadkernel.KERNEL.info(), result=cadkernel.selftest())
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, kernel=cadkernel.KERNEL.info(), error=str(e)), 500


@app.post("/api/kernel/regen")
def api_kernel_regen():
    data = request.get_json(force=True) or {}
    try:
        out, _ = cadkernel.build(data.get("ops", []), want_tools=bool(data.get("tools", True)))
        return jsonify(ok=True, **out)
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, error=str(e)), 500


@app.post("/api/kernel/export")
def api_kernel_export():
    data = request.get_json(force=True) or {}
    target = safe_path(data.get("path", ""))
    try:
        n = cadkernel.export(data.get("parts", []), target, data.get("format", "usd"))
        return jsonify(ok=True, path=target.relative_to(workdir()).as_posix(), bodies=n)
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, error=str(e)), 500


# ------------------------------------------------------------------ Desktop-Hilfen
STATE = {"dirty": False, "exiting": False}
WINDOW = None          # pywebview-Fenster (nur im Desktop-Modus)
RUN_MODE = "server"    # desktop | browser | server


@app.post("/api/dirty")
def api_dirty():
    STATE["dirty"] = bool((request.get_json(force=True) or {}).get("dirty"))
    return jsonify(ok=True)


@app.post("/api/import_paths")
def api_import_paths():
    """Dateien vom Rechner (nativer Dialog) ins Arbeitsverzeichnis kopieren."""
    wd = workdir()
    if wd is None:
        return jsonify(ok=False, error="Kein Arbeitsverzeichnis"), 409
    saved = []
    for src in (request.get_json(force=True) or {}).get("paths", []):
        sp = Path(src)
        if not sp.is_file():
            continue
        target = wd / sp.name
        if sp.resolve() != target.resolve():
            shutil.copy2(sp, target)
        saved.append(target.name)
    return jsonify(ok=True, files=saved)


@app.post("/api/reveal")
def api_reveal():
    """Datei/Ordner im Explorer bzw. Finder zeigen."""
    rel = (request.get_json(force=True) or {}).get("path", "")
    p = safe_path(rel) if rel else workdir()
    if p is None or not p.exists():
        return jsonify(ok=False, error="Nicht gefunden"), 404
    try:
        system = platform.system()
        if system == "Windows":
            if p.is_file():
                subprocess.Popen(["explorer", "/select,", str(p)])
            else:
                os.startfile(str(p))  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", "-R", str(p)] if p.is_file() else ["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p if p.is_dir() else p.parent)])
    except OSError as e:
        return jsonify(ok=False, error=str(e)), 500
    return jsonify(ok=True)


@app.post("/api/focus")
def api_focus():
    if WINDOW is not None:
        try:
            WINDOW.restore()
            WINDOW.show()
        except Exception:  # noqa: BLE001
            pass
    return jsonify(ok=True)


@app.post("/api/shutdown")
def api_shutdown():
    STATE["exiting"] = True
    if WINDOW is not None:
        threading.Timer(0.2, WINDOW.destroy).start()
        threading.Timer(3.0, lambda: os._exit(0)).start()
    else:
        threading.Timer(0.4, lambda: os._exit(0)).start()
    return jsonify(ok=True)


class DesktopApi:
    """Wird im Fenster als window.pywebview.api bereitgestellt."""

    def pick_folder(self, start=""):
        import webview
        start = start if start and Path(start).is_dir() else str(Path.home())
        r = WINDOW.create_file_dialog(webview.FileDialog.FOLDER, directory=start)
        return (r[0] if isinstance(r, (list, tuple)) else r) if r else None

    def pick_files(self):
        import webview
        r = WINDOW.create_file_dialog(
            webview.FileDialog.OPEN, directory=str(workdir() or Path.home()), allow_multiple=True,
            file_types=("CAD-Dateien (*.stp;*.step;*.igs;*.iges;*.stl;*.prt;*.asm;*.sldprt;*.sldasm;*.bcprt;*.bcasm)",
                        "Alle Dateien (*.*)"))
        return list(r) if r else []

    def save_copy(self, rel):
        """Datei aus dem Arbeitsverzeichnis an einen frei gewaehlten Ort kopieren."""
        import webview
        src = safe_path(rel)
        r = WINDOW.create_file_dialog(webview.FileDialog.SAVE, directory=str(Path.home()), save_filename=src.name)
        if not r:
            return None
        dst = r[0] if isinstance(r, (list, tuple)) else r
        shutil.copy2(src, dst)
        return str(dst)

    def set_title(self, title):
        try:
            WINDOW.set_title(str(title))
        except Exception:  # noqa: BLE001
            pass
        return True


# ------------------------------------------------------------------ SpaceMouse (USB-HID)
class SpaceMouseHID:
    """Liest 3Dconnexion-Geraete direkt per hidapi (Windows, macOS, Linux)."""

    VENDORS = (0x046D, 0x256F)  # Logitech (alte 3Dconnexion), 3Dconnexion

    def __init__(self):
        self.t = [0, 0, 0]
        self.r = [0, 0, 0]
        self.buttons = 0
        self.seq = 0
        self.name = ""
        self.error = ""
        self.available = False
        self.cond = threading.Condition()
        try:
            import hid  # noqa: F401
            self.available = True
        except Exception as e:  # noqa: BLE001
            self.error = f"hidapi nicht verfuegbar: {e}"

    def status(self):
        return {"available": self.available, "connected": bool(self.name), "name": self.name, "error": self.error}

    def start(self):
        if self.available:
            threading.Thread(target=self._run, name="spacemouse", daemon=True).start()

    def _find(self, hid):
        cands = []
        for d in hid.enumerate():
            if d.get("vendor_id") not in self.VENDORS:
                continue
            prod = (d.get("product_string") or "").lower()
            multi_axis = d.get("usage_page") == 1 and d.get("usage") == 8
            if multi_axis or "space" in prod or "3dconnexion" in (d.get("manufacturer_string") or "").lower():
                cands.append((0 if multi_axis else 1, d))
        cands.sort(key=lambda x: x[0])
        return cands[0][1] if cands else None

    def _run(self):
        import hid
        while True:
            info = self._find(hid)
            if not info:
                time.sleep(2.0)
                continue
            dev = hid.device()
            try:
                dev.open_path(info["path"])
                self.name = info.get("product_string") or "SpaceMouse"
                self.error = ""
                self._bump()
                while True:
                    data = dev.read(64, 100)
                    if data:
                        self._parse(bytes(data))
            except Exception as e:  # noqa: BLE001
                self.error = str(e) or "Geraet nicht lesbar"
            finally:
                try:
                    dev.close()
                except Exception:  # noqa: BLE001
                    pass
                self.name = ""
                self.t = [0, 0, 0]
                self.r = [0, 0, 0]
                self._bump()
            time.sleep(2.0)

    @staticmethod
    def _axes(b, o):
        return [int.from_bytes(b[o + i * 2:o + i * 2 + 2], "little", signed=True) for i in range(3)]

    def _parse(self, b):
        rid = b[0]
        if rid == 1 and len(b) >= 7:
            self.t = self._axes(b, 1)
            if len(b) >= 13:
                self.r = self._axes(b, 7)
        elif rid == 2 and len(b) >= 7:
            self.r = self._axes(b, 1)
        elif rid == 3 and len(b) >= 2:
            self.buttons = b[1] | ((b[2] << 8) if len(b) >= 3 else 0)
        else:
            return
        self._bump()

    def _bump(self):
        with self.cond:
            self.seq += 1
            self.cond.notify_all()

    def snapshot(self):
        return {"t": self.t, "r": self.r, "b": self.buttons, "name": self.name, "seq": self.seq}


SPACEMOUSE = SpaceMouseHID()


@app.get("/api/sm/stream")
def api_sm_stream():
    """Server-Sent Events: SpaceMouse-Zustand mit bis zu 60 Hz."""
    def gen():
        last = -1
        last_send = 0.0
        yield "retry: 2000\n\n"
        while True:
            with SPACEMOUSE.cond:
                SPACEMOUSE.cond.wait(timeout=1.0)
            now = time.time()
            if SPACEMOUSE.seq != last or now - last_send > 1.0:
                if now - last_send < 1 / 60:
                    time.sleep(1 / 60 - (now - last_send))
                snap = SPACEMOUSE.snapshot()
                last = snap["seq"]
                last_send = time.time()
                yield f"data: {json.dumps(snap)}\n\n"

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ Start
def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def running_instance(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1.5) as r:
            return json.loads(r.read().decode()).get("app") == APP_ID
    except Exception:  # noqa: BLE001
        return False


def choose_mode() -> str:
    args = {a.lower() for a in sys.argv[1:]}
    if "--server" in args or os.environ.get("BROWSERCAD_NO_BROWSER"):
        return "server"
    env = (os.environ.get("BROWSERCAD_MODE") or "").lower()
    if env in ("desktop", "browser", "server"):
        return env
    if "--browser" in args:
        return "browser"
    return CFG.get("ui_mode", "desktop")


def run_desktop(url: str) -> bool:
    """Eigenes Programmfenster. Liefert False, wenn kein WebView verfuegbar ist."""
    global WINDOW
    try:
        import webview
    except Exception as e:  # noqa: BLE001
        print(f"pywebview nicht verfuegbar ({e}) - verwende Browser.")
        return False

    WINDOW = webview.create_window(
        f"BrowserCAD {VERSION}", url, js_api=DesktopApi(),
        width=1440, height=900, min_size=(1024, 640), maximized=True,
        background_color="#0b1016", text_select=False, zoomable=False,
    )

    def on_closing():
        print(f"Fenster schliessen angefordert (ungespeichert: {STATE['dirty']})", flush=True)
        if STATE["exiting"] or not STATE["dirty"]:
            return True
        # Ungespeicherte Aenderungen: Abfrage in der Oberflaeche, Schliessen erst nach Bestaetigung
        threading.Thread(target=lambda: WINDOW.evaluate_js("window.BrowserCAD && BrowserCAD.requestExit()"), daemon=True).start()
        return False

    WINDOW.events.closing += on_closing
    storage = CONFIG_DIR / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    try:
        webview.start(private_mode=False, storage_path=str(storage), debug=bool(os.environ.get("BROWSERCAD_DEBUG")))
    except Exception as e:  # noqa: BLE001
        print(f"Programmfenster konnte nicht geoeffnet werden ({e}) - verwende Browser.")
        WINDOW = None
        return False
    return True


def main() -> None:
    global RUN_MODE
    RUN_MODE = choose_mode()
    port = int(os.environ.get("BROWSERCAD_PORT") or CFG.get("port") or DEFAULT_PORT)
    if running_instance(port):
        print(f"BrowserCAD laeuft bereits (Port {port}).")
        if RUN_MODE == "browser":
            webbrowser.open(f"http://127.0.0.1:{port}/")
        else:
            try:
                urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/focus", data=b"{}", method="POST"), timeout=2)
            except Exception:  # noqa: BLE001
                pass
        return
    while not port_free(port):
        port += 1
    url = f"http://127.0.0.1:{port}/"
    print(f"BrowserCAD {VERSION} - Modus {RUN_MODE} - {url}", flush=True)

    from waitress import create_server
    logging.getLogger("waitress.queue").setLevel(logging.ERROR)
    server = create_server(app, host="127.0.0.1", port=port, threads=12,
                           max_request_body_size=1024 ** 3)
    SPACEMOUSE.start()
    threading.Thread(target=cadkernel.KERNEL.load, name="kernel-load", daemon=True).start()

    if RUN_MODE == "server":
        server.run()
        return

    threading.Thread(target=server.run, name="server", daemon=True).start()
    if RUN_MODE == "desktop" and run_desktop(url):
        os._exit(0)  # Fenster geschlossen -> Programm beenden

    RUN_MODE = "browser"
    webbrowser.open(url)
    print("Oberflaeche im Browser geoeffnet. Beenden: Datei > Beenden.", flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
