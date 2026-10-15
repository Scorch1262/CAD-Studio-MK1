"""
CAD-Studio-MK1 - Modellierkern auf Basis von NVIDIA usd-brep (https://github.com/NVIDIA-Omniverse/usd-brep).

Die Oberflaeche berechnet Bezuege und Skizzen und schickt eine Liste von
Operationen (Extrudieren, Drehen, Bohrung, Rundung, Fase, Muster, Spiegeln,
Schale). Hier werden daraus exakte NURBS-B-Rep-Koerper mit usd-brep gebaut,
fuer die Anzeige tesselliert und als USD-B-Rep oder SMLib-B-Rep exportiert.

usd-brep gibt es als Python-Paket fuer Windows und Linux (CPython 3.12).
Ist es nicht installiert, meldet KERNEL.available False und die Oberflaeche
verwendet ihren internen Netzkern.
"""
from __future__ import annotations

import base64
import math
import os
import struct
import sys
import threading
from pathlib import Path

_lock = threading.RLock()
_load_lock = threading.Lock()


def _prepare_environment() -> None:
    """Im PyInstaller-Paket den OpenUSD-Plugin-Pfad von usd-brep setzen (vor dem Import)."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", "")) / "usd_brep"
        plug = base / "usd"
        if plug.is_dir():
            cur = os.environ.get("PXR_PLUGINPATH_NAME", "")
            os.environ["PXR_PLUGINPATH_NAME"] = os.pathsep.join(p for p in (str(plug), cur) if p)
        schema = base / "omniSolid" / "resources"
        if schema.is_dir():
            os.environ.setdefault("OMNISOLID_PLUGIN_PATH", str(schema))


class Kernel:
    def __init__(self):
        self.sm = None
        self.version = ""
        self.error = ""
        self._tried = False

    def load(self):
        with _load_lock:
            return self._load()

    def _load(self):
        if self._tried:
            return self.sm
        self._tried = True
        try:
            _prepare_environment()
            import usd_brep as sm  # noqa: WPS433
            self.sm = sm
            try:
                from importlib.metadata import version
                self.version = version("usd-brep")
            except Exception:  # noqa: BLE001
                self.version = "?"
        except Exception as e:  # noqa: BLE001
            self.error = f"usd-brep nicht verfuegbar: {e}"
        return self.sm

    @property
    def available(self) -> bool:
        return self.load() is not None

    def info(self):
        self.load()
        return {"available": self.sm is not None, "name": "usd-brep", "version": self.version, "error": self.error}


KERNEL = Kernel()


# ------------------------------------------------------------------ Vektorhilfen
def _v(a):
    return (float(a[0]), float(a[1]), float(a[2]))


def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a):
    n = math.sqrt(_dot(a, a))
    if n < 1e-15:
        raise ValueError("Richtung hat Laenge 0")
    return _mul(a, 1.0 / n)


def _basis_from_z(z):
    z = _unit(z)
    h = (1.0, 0.0, 0.0) if abs(z[0]) < 0.9 else (0.0, 1.0, 0.0)
    x = _unit(_cross(h, z))
    y = _cross(z, x)
    return x, y, z


class BuildError(Exception):
    pass


def _german(msg: str) -> str:
    """Kernmeldungen von usd-brep verstaendlich machen."""
    m = msg
    if "SM_ERR" in m or "failed" in m:
        what = "Operation"
        for key, txt in (("Boolean", "Boolesche Operation"), ("Fillet", "Rundung/Fase"), ("Sweep", "Profilerzeugung"),
                         ("Shell", "Schale"), ("FindFace", "Flaechensuche"), ("FindEdge", "Kantensuche"), ("Tessellat", "Tessellierung")):
            if key.lower() in m.lower():
                what = txt
                break
        hint = {"Boolesche Operation": " – evtl. ueberlappende oder deckungsgleiche Geometrie",
                "Rundung/Fase": " – Radius/Abstand zu gross fuer die angrenzenden Flaechen?",
                "Profilerzeugung": " – Skizze geschlossen und ueberschneidungsfrei?",
                "Schale": " – Wandstaerke zu gross?", "Flaechensuche": " – Flaeche existiert nicht mehr, neu waehlen"}.get(what, "")
        return f"usd-brep: {what} fehlgeschlagen{hint} ({m})"
    return m


# ------------------------------------------------------------------ Aufbau
class Builder:
    def __init__(self, sm):
        self.sm = sm
        self.body = None
        self.tools = {}   # fid -> [(op, brep)]
        self.status = {}  # fid -> 'ok' | Fehlermeldung

    # --- Grundfunktionen
    def place(self, b, o, x, y):
        self.sm.transform(b, self.sm.Axis2Placement(_v(o), _v(x), _v(y)))
        return b

    def place_matrix(self, b, m):
        """4x4-Matrix (Spalten-Hauptordnung wie three.js), starr."""
        o = (m[12], m[13], m[14])
        x = (m[0], m[1], m[2])
        y = (m[4], m[5], m[6])
        return self.place(b, o, x, y)

    def reflect(self, b, o, n):
        """Spiegelung an der Ebene (o, n)."""
        sm = self.sm
        X, Y, Z = _basis_from_z(n)
        X, Y, Z = Z, X, Y  # lokale x-Achse = Ebenennormale
        # in lokale Koordinaten (inverse Platzierung)
        oi = (-_dot(X, o), -_dot(Y, o), -_dot(Z, o))
        xi = (X[0], Y[0], Z[0])
        yi = (X[1], Y[1], Z[1])
        self.place(b, oi, xi, yi)
        sm.scale(b, (-1.0, 1.0, 1.0))
        self.place(b, o, X, Y)
        return b

    def size(self):
        if self.body is None:
            return 200.0
        (x0, y0, z0), (x1, y1, z1) = self.body.bounding_box()
        return max(50.0, math.dist((x0, y0, z0), (x1, y1, z1)) * 2.0)

    def curve(self, c):
        sm = self.sm
        t = c["t"]
        if t == "line":
            a, b = c["a"], c["b"]
            return sm.create_line_segment((a[0], a[1], 0.0), (b[0], b[1], 0.0))
        if t == "arc":
            return sm.create_arc((c["c"][0], c["c"][1], 0.0), float(c["r"]), float(c["a0"]), float(c["a1"]))
        if t == "circle":
            return sm.create_circle((c["c"][0], c["c"][1], 0.0), float(c["r"]))
        raise BuildError(f"Unbekanntes Skizzenelement {t}")

    def curves(self, loop):
        return [self.curve(c) for c in loop]

    def shapes_solid(self, shapes, make):
        """make(curves) -> Brep. Konturen mit Inseln: aussen - Loecher, mehrere Konturen vereinigen."""
        sm = self.sm
        result = None
        for s in shapes:
            solid = make(self.curves(s["outer"]))
            for h in s.get("holes", []):
                solid = sm.boolean_difference(solid, make(self.curves(h)))
            result = solid if result is None else sm.boolean_union(result, solid)
        if result is None:
            raise BuildError("Skizze enthaelt keine geschlossene Kontur")
        return result

    def apply(self, fid, tool, op):
        sm = self.sm
        self.tools.setdefault(fid, []).append((op, tool.copy()))
        if op in ("cut", "intersect") and self.body is None:
            raise BuildError("Kein Material zum Entfernen vorhanden" if op == "cut" else "Kein Koerper vorhanden")
        if self.body is None:
            self.body = tool
        else:
            fn = {"cut": sm.boolean_difference, "intersect": sm.boolean_intersection}.get(op, sm.boolean_union)
            self.body = self.boolean_robust(fn, self.body, tool)
        if self.body is not None and self.body.face_count() == 0:
            raise BuildError("Ergebnis ist leer")

    def boolean_robust(self, fn, body, tool):
        """Boolesche Operation; bei Fehlschlag (z. B. deckungsgleiche Flaechen) mit minimal versetztem Werkzeug wiederholen."""
        b0, t0 = body.copy(), tool.copy()
        try:
            return fn(body, tool)
        except Exception as first:  # noqa: BLE001
            eps = self.size() * 1e-6
            for k, d in enumerate(((1.0, 0.7, 0.3), (-0.6, 1.0, -0.8), (0.4, -0.9, 1.0))):
                b, t = b0.copy(), t0.copy()
                self.sm.translate(t, _mul(d, eps * (k + 1) * 3))
                try:
                    return fn(b, t)
                except Exception:  # noqa: BLE001
                    continue
            raise first

    # --- Features
    def op_extrude(self, o):
        sm = self.sm
        size = self.size()
        d = size if o.get("through") else float(o["depth"])
        if d <= 0:
            raise BuildError("Tiefe muss > 0 sein")
        w0, w1 = 0.0, d
        if o.get("side") == "sym":
            w0, w1 = -d / 2, d / 2
        elif o.get("side") == "two":
            w0 = -(size if o.get("through") else float(o.get("depth2") or d))
        if o.get("flip"):
            w0, w1 = -w1, -w0
        op = o.get("op", "add")
        if op == "cut" and o.get("side") != "sym":  # minimal ueber die Skizzenebene hinaus
            eps = max(1e-4, size * 1e-6)
            if w0 == 0:
                w0 = -eps
            if w1 == 0:
                w1 = eps

        def make(cv):
            b = sm.linear_sweep(cv, (0.0, 0.0, 1.0), w1 - w0)
            if w0:
                sm.translate(b, (0.0, 0.0, w0))
            return b

        tool = self.shapes_solid(o["shapes"], make)
        fr = o["frame"]
        self.place(tool, fr["o"], fr["x"], fr["y"])
        self.apply(o["fid"], tool, op)

    def op_revolve(self, o):
        sm = self.sm
        ax = o["axis"]
        p = (ax["p"][0], ax["p"][1], 0.0)
        dv = (ax["d"][0], ax["d"][1], 0.0)
        ang = float(o.get("angle", 360))
        if abs(ang) < 1e-6:
            raise BuildError("Winkel ist 0")
        if ang < 0:  # Gegenrichtung: Achse umdrehen
            dv = _mul(dv, -1.0)
            ang = -ang
        ang = min(ang, 360.0)
        tool = self.shapes_solid(o["shapes"], lambda cv: sm.rotational_sweep(cv, p, dv, ang))
        fr = o["frame"]
        self.place(tool, fr["o"], fr["x"], fr["y"])
        self.apply(o["fid"], tool, o.get("op", "add"))

    def op_hole(self, o):
        sm = self.sm
        size = self.size()
        r = float(o["r"])
        if r <= 0:
            raise BuildError("Durchmesser muss > 0 sein")
        through = o.get("depth") is None
        depth = size if through else float(o["depth"])
        eps = max(1e-4, size * 1e-6)
        # lokal: Achse +Z ab Ursprung, Platzierung mit Z = Bohrrichtung
        tool = sm.create_cylinder((0.0, 0.0, -eps), r, depth + eps)
        if not through and o.get("tip", True):
            h = r / math.tan(math.radians(59))
            tool = sm.boolean_union(tool, sm.create_cone((0.0, 0.0, depth), r, r * 1e-3, h))
        if o.get("cbore"):
            cr, cd = float(o["cbore"]["r"]), float(o["cbore"]["depth"])
            tool = sm.boolean_union(tool, sm.create_cylinder((0.0, 0.0, -1.0), cr, cd + 1.0))
        elif o.get("csink"):
            cr = float(o["csink"]["r"])
            h = cr - r
            if h > 0:
                tool = sm.boolean_union(tool, sm.create_cone((0.0, 0.0, -0.5), cr + 0.5, r * 0.98, h + 0.5))
        X, Y, _ = _basis_from_z(o["dir"])
        self.place(tool, o["o"], X, Y)
        self.apply(o["fid"], tool, "cut")

    @staticmethod
    def _edge_sig(e):
        t0, t1 = e.parameter_range()
        a, b, m = _v(e.point_at(t0)), _v(e.point_at(t1)), _v(e.point_at((t0 + t1) / 2))
        try:
            ln = float(e.length())
        except Exception:  # noqa: BLE001
            ln = math.dist(a, b)
        return a, b, m, ln

    def _match_edge(self, ref, all_edges):
        """Kante wiederfinden, wenn sie sich durch eine Massaenderung verschoben hat:
        1. gleiche Laenge und Richtung (nur verschoben), 2. gleiche Richtung, naechste Mitte."""
        if not ref.get("a") or not ref.get("b"):
            return None
        ra, rb, rm = _v(ref["a"]), _v(ref["b"]), _v(ref["mid"])
        rlen = float(ref.get("len") or math.dist(ra, rb))
        rdir = _sub(rb, ra)
        closed = math.dist(ra, rb) < 1e-6 * (1 + rlen)
        size = self.size()
        best = [None, None]
        bestd = [float("inf"), float("inf")]
        for e in all_edges:
            try:
                a, b, m, ln = self._edge_sig(e)
            except Exception:  # noqa: BLE001
                continue
            d = _sub(b, a)
            if closed:
                same_dir = math.dist(a, b) < 1e-6 * (1 + ln)
            else:
                nd, nr = math.sqrt(_dot(d, d)), math.sqrt(_dot(rdir, rdir))
                if nd < 1e-12 or nr < 1e-12:
                    continue
                same_dir = abs(_dot(d, rdir)) / (nd * nr) > 0.99999
            if not same_dir:
                continue
            dist = math.dist(m, rm)
            tier = 0 if abs(ln - rlen) <= max(1e-4, rlen * 1e-5) else 1
            if dist < bestd[tier]:
                bestd[tier], best[tier] = dist, e
        if best[0] is not None and bestd[0] < size:
            return best[0]
        if best[1] is not None and bestd[1] < size * 0.25:
            return best[1]
        return None

    def find_edges(self, refs):
        sm = self.sm
        edges = []
        all_edges = self.body.edges()
        for ref in refs:
            mid = _v(ref["mid"])
            idx, prm = sm.find_edge(self.body, mid)[:2]
            e = all_edges[idx]
            try:
                q = _v(e.point_at(prm))
                dist = math.dist(mid, q)
            except Exception:  # noqa: BLE001
                dist = 0.0
            if dist > max(1e-3, self.size() * 1e-4):
                e = self._match_edge(ref, all_edges)
                if e is None:
                    raise BuildError("Gewaehlte Kante existiert nicht mehr (Modell geaendert) - Kanten neu waehlen")
            if all(e is not x for x in edges):
                edges.append(e)
        return edges

    def op_edges(self, o, chamfer):
        sm = self.sm
        if self.body is None:
            raise BuildError("Kein Koerper vorhanden")
        s = float(o["size"])
        if s <= 0:
            raise BuildError("Wert muss > 0 sein")
        if not o.get("edges"):
            raise BuildError("Keine Kanten gewaehlt")
        keep = self.body
        xs = 0 if chamfer else 1

        def attempt(groups):
            cur = keep
            for g in groups:
                work = cur.copy()
                self.body = work  # find_edges sucht im aktuellen Koerper
                edges = self.find_edges(g)
                sm.fillet_edges(work, edges, radius=s, xsect_type=xs)
                if not work.is_manifold_solid() or work.face_count() == 0:
                    raise BuildError("Rundung/Fase nicht moeglich (Wert zu gross?)")
                cur = work
            return cur

        try:
            res = attempt([o["edges"]])
        except Exception as first:  # noqa: BLE001
            # mehrere Kanten in einem Schritt scheitern im Kern manchmal (z. B. an tangentialen Uebergaengen):
            # dann Kante fuer Kante nacheinander verrunden
            if len(o["edges"]) < 2:
                self.body = keep
                raise
            try:
                res = attempt([[e] for e in o["edges"]])
            except Exception:  # noqa: BLE001
                self.body = keep
                raise BuildError("Rundung/Fase an dieser Kantenkombination nicht moeglich - Wert verkleinern oder die ganze Tangentenkette waehlen") from first
        self.tools.setdefault(o["fid"], [])
        self.body = res

    def op_pattern(self, o):
        sm = self.sm
        src = self.tools.get(o["ref"])
        if not src:
            raise BuildError("Referenz-Feature hat keine Geometrie (unterdrueckt oder fehlerhaft?)")
        mats = o.get("mats") or []
        if len(mats) > 400:
            raise BuildError("Zu viele Musterelemente (max. 400)")
        by = {"cut": None, "add": None}
        for m in mats:
            for op, t in src:
                c = self.place_matrix(t.copy(), m)
                key = "cut" if op == "cut" else "add"
                by[key] = c if by[key] is None else sm.boolean_union(by[key], c)
        for op in ("cut", "add"):
            if by[op] is not None:
                self.apply(o["fid"], by[op], op)

    def op_mirror(self, o):
        sm = self.sm
        pn = _unit(o["n"])
        po = _v(o["o"])
        if o.get("what") == "feature":
            src = self.tools.get(o.get("ref"))
            if not src:
                raise BuildError("Referenz-Feature hat keine Geometrie")
            for op, t in src:
                self.apply(o["fid"], self.reflect(t.copy(), po, pn), op)
            return
        if self.body is None:
            raise BuildError("Keine Geometrie zum Spiegeln")
        # Koerper schneidet die Ebene? -> gewaehlte Seite behalten (wie bisher), sonst Kopie vereinigen
        (x0, y0, z0), (x1, y1, z1) = self.body.bounding_box()
        ds = [_dot(_sub((x, y, z), po), pn) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
        tol = max(1e-6, self.size() * 1e-7)
        crossing = min(ds) < -tol and max(ds) > tol
        if crossing and o.get("cross") != "union":
            keep_pos = o.get("cross") != "neg"
            R = math.dist((x0, y0, z0), (x1, y1, z1)) + 10.0
            X, Y, _ = _basis_from_z(pn)
            dirv = _mul(pn, -1.0 if keep_pos else 1.0)
            half = sm.create_box((-R, -R, 0.0), 2 * R, 2 * R, R)
            Xh, Yh, _ = _basis_from_z(dirv)
            self.place(half, po, Xh, Yh)
            self.body = sm.boolean_difference(self.body, half)
            if self.body.face_count() == 0:
                raise BuildError("Auf der gewaehlten Seite liegt keine Geometrie")
        mir = self.reflect(self.body.copy(), po, pn)
        self.apply(o["fid"], mir, "add")

    def op_shell(self, o):
        sm = self.sm
        if self.body is None:
            raise BuildError("Kein Koerper vorhanden")
        t = float(o["thickness"])
        if t == 0:
            raise BuildError("Wandstaerke ist 0")
        faces = [sm.find_face(self.body, _v(p)) for p in o.get("faces", [])]
        res = sm.shell_brep(self.body, -abs(t) if not o.get("outward") else abs(t), faces_to_shell=faces)
        if res is None or res.face_count() == 0 or not res.is_manifold_solid():
            raise BuildError("Schale nicht moeglich (Wandstaerke zu gross?)")
        self.body = res
        self.tools.setdefault(o["fid"], [])

    def run(self, ops):
        handlers = {
            "extrude": self.op_extrude, "revolve": self.op_revolve, "hole": self.op_hole,
            "round": lambda o: self.op_edges(o, False), "chamfer": lambda o: self.op_edges(o, True),
            "pattern": self.op_pattern, "mirror": self.op_mirror, "shell": self.op_shell,
        }
        for o in ops:
            fid = o.get("fid")
            backup = self.body.copy() if self.body is not None else None
            try:
                h = handlers.get(o.get("kind"))
                if h is None:
                    raise BuildError(f"Unbekannte Operation {o.get('kind')}")
                h(o)
                self.status[fid] = "ok"
            except Exception as e:  # noqa: BLE001
                self.body = backup
                msg = _german(str(e) or type(e).__name__)
                self.status[fid] = msg if len(msg) < 300 else msg[:300] + "…"
        return self.body


# ------------------------------------------------------------------ Ausgabe
def _b64(fmt, values):
    return base64.b64encode(struct.pack(f"<{len(values)}{fmt}", *values)).decode("ascii")


def mesh_of(sm, brep, chord):
    pb = sm.tessellate(brep, chord_height_tolerance=chord, curve_angle_tolerance_deg=12.0,
                       surface_angle_tolerance_deg=12.0, allow_partial=True, return_failures=True)
    if isinstance(pb, tuple):
        pb = pb[0]
    m = pb.to_mesh_arrays()
    pos = [c for p in m["points"] for c in p]
    tri = []
    f = m["faces"]
    i = 0
    while i < len(f):
        n = f[i]
        idx = f[i + 1:i + 1 + n]
        for k in range(1, n - 1):
            tri += (idx[0], idx[k], idx[k + 1])
        i += n + 1
    return pos, tri


def build(ops, want_tools=True):
    sm = KERNEL.load()
    if sm is None:
        raise RuntimeError(KERNEL.error or "usd-brep nicht verfuegbar")
    with _lock:
        b = Builder(sm)
        body = b.run(ops)
        out = {"status": b.status, "kernel": KERNEL.info(), "tools": {}}
        if body is None:
            out["mesh"] = None
            return out, b
        (x0, y0, z0), (x1, y1, z1) = body.bounding_box()
        diag = max(1e-6, math.dist((x0, y0, z0), (x1, y1, z1)))
        chord = max(0.002, diag * 4e-4)
        pos, tri = mesh_of(sm, body, chord)
        pts, counts, _edges = sm.tessellate_boundaries(body, angle_tolerance_deg=6.0, allow_partial=True)
        flat = [c for p in pts for c in p]
        try:
            mp = body.mass_properties()
        except Exception:  # noqa: BLE001
            mp = {"volume": body.volume(), "area": body.area(), "centroid": body.center()}
        out.update({
            "mesh": {"pos": _b64("f", pos), "tri": _b64("I", tri)},
            "edges": {"pts": _b64("f", flat), "counts": list(counts)},
            "bbox": [[x0, y0, z0], [x1, y1, z1]],
            "props": {"volume": mp.get("volume"), "area": mp.get("area"), "centroid": list(mp.get("centroid") or (0, 0, 0)),
                      "faces": body.face_count(), "edges": body.edge_count(), "vertices": body.vertex_count(),
                      "manifold": bool(body.is_manifold_solid())},
        })
        if want_tools:
            for fid, lst in b.tools.items():
                ms = []
                for op, t in lst[:6]:
                    try:
                        p2, t2 = mesh_of(sm, t, chord * 4)
                        ms.append({"op": op, "pos": _b64("f", p2), "tri": _b64("I", t2)})
                    except Exception:  # noqa: BLE001
                        pass
                if ms:
                    out["tools"][fid] = ms
        return out, b


def export(parts, path, fmt):
    """parts: [{ops, matrix?(16), name}] -> Datei (usd: OpenUSD B-Rep, brep: SMLib nativ)."""
    sm = KERNEL.load()
    if sm is None:
        raise RuntimeError(KERNEL.error or "usd-brep nicht verfuegbar")
    with _lock:
        breps = []
        for p in parts:
            b = Builder(sm)
            body = b.run(p["ops"])
            if body is None:
                continue
            if p.get("matrix"):
                b.place_matrix(body, p["matrix"])
            breps.append(body)
        if not breps:
            raise RuntimeError("Keine B-Rep-Geometrie zum Exportieren")
        if fmt == "brep":
            if len(breps) > 1:
                raise RuntimeError("Das SMLib-B-Rep-Format enthaelt genau einen Koerper - fuer Baugruppen OpenUSD verwenden")
            breps[0].write_to_file(str(path), True)
        else:
            if len(breps) == 1:
                sm.usd.export_brep(breps[0], str(path))
            else:
                sm.usd.export_breps(breps, str(path))
        return len(breps)


def selftest():
    """Kurzpruefung des Kerns (fuer CI und die Info-Anzeige)."""
    ops = [
        {"fid": "a", "kind": "extrude", "op": "add", "depth": 20,
         "frame": {"o": [0, 0, 0], "x": [1, 0, 0], "y": [0, 0, -1]},
         "shapes": [{"outer": [{"t": "line", "a": [-40, -25], "b": [40, -25]}, {"t": "line", "a": [40, -25], "b": [40, 25]},
                               {"t": "line", "a": [40, 25], "b": [-40, 25]}, {"t": "line", "a": [-40, 25], "b": [-40, -25]}],
                     "holes": [[{"t": "circle", "c": [0, 0], "r": 8}]]}]},
        {"fid": "b", "kind": "round", "size": 3, "edges": [{"mid": [0, 20, 25]}]},
    ]
    out, _ = build(ops, want_tools=False)
    return {"status": out["status"], "volume": out["props"]["volume"], "manifold": out["props"]["manifold"]}
