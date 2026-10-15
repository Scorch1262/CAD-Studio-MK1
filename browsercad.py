#!/usr/bin/env python3
"""
BrowserCAD - browserbasiertes CAD im Stil von PTC Creo Parametric.

Startet einen lokalen Webserver (nur 127.0.0.1) und oeffnet die Oberflaeche
im Browser (bevorzugt als App-Fenster von Edge/Chrome, wegen WebHID fuer die
3Dconnexion SpaceMouse).

Alle Dateien (Parts, Baugruppen, Importe, Exporte) liegen im Arbeitsverzeichnis,
das beim Start in der Oberflaeche festgelegt wird.
"""
from __future__ import annotations

import json
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

# --- Windowed Mac-App / exe ohne Konsole: stdout/stderr koennen None sein ---
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

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
    "app_window": True,
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
        app_window=CFG.get("app_window", True),
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
        if "app_window" in data:
            CFG["app_window"] = bool(data["app_window"])
        save_config(CFG)
    return jsonify(ok=True)


@app.post("/api/shutdown")
def api_shutdown():
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return jsonify(ok=True)


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


def find_browser_app() -> list[str] | None:
    """Edge/Chrome fuer ein App-Fenster suchen (WebHID fuer SpaceMouse)."""
    system = platform.system()
    if system == "Windows":
        cands = [
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        ]
        for c in cands:
            if os.path.isfile(c):
                return [c]
    elif system == "Darwin":
        for c in (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ):
            if os.path.isfile(c):
                return [c]
    else:
        for c in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
            w = shutil.which(c)
            if w:
                return [w]
    return None


def open_ui(url: str) -> None:
    if os.environ.get("BROWSERCAD_NO_BROWSER"):
        return
    if CFG.get("app_window", True):
        b = find_browser_app()
        if b:
            try:
                subprocess.Popen(b + [f"--app={url}", "--new-window"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                pass
    webbrowser.open(url)


def main() -> None:
    port = int(os.environ.get("BROWSERCAD_PORT") or CFG.get("port") or DEFAULT_PORT)
    if running_instance(port):
        print(f"BrowserCAD laeuft bereits auf Port {port} - oeffne Oberflaeche.")
        open_ui(f"http://127.0.0.1:{port}/")
        return
    while not port_free(port):
        port += 1
    url = f"http://127.0.0.1:{port}/"
    print("=" * 60, flush=True)
    print(f"  BrowserCAD {VERSION}")
    print(f"  Oberflaeche: {url}")
    print("  Beenden: Datei > Beenden oder dieses Fenster schliessen", flush=True)
    print("=" * 60, flush=True)
    threading.Timer(1.0, open_ui, args=(url,)).start()
    from waitress import serve

    serve(app, host="127.0.0.1", port=port, threads=8, max_request_body_size=1024 ** 3, _quiet=True)


if __name__ == "__main__":
    main()
