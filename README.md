# BrowserCAD 1.1.0

Eigenständiges 3D-CAD-Programm für Windows und macOS im dunklen Dashboard-Stil, dessen Bedienung sich an
**PTC Creo Parametric** orientiert: Menüband mit Registerkarten, Modellbaum mit Einfügemarke, Feature-Dashboard
mit ✔/✖, Layerbaum, Bezugsanzeige-Filter, Creo-Maussteuerung und 3Dconnexion-SpaceMouse.

BrowserCAD läuft in **einem eigenen Programmfenster** – es wird kein Browser geöffnet und keiner benötigt.
GitHub Actions baut daraus eine **Windows-exe** und eine **macOS-App** und legt automatisch ein **Release** an.

---

## Schnellstart

| System | Start |
|---|---|
| Windows 10/11 | `BrowserCAD-1.1.0-windows-x64.exe` doppelklicken. Benötigt die Microsoft-WebView2-Laufzeit (auf Windows 11 und aktuellen Windows-10-Systemen vorhanden; sonst kostenlos bei Microsoft). |
| macOS 12+ | ZIP entpacken, `BrowserCAD.app` beim ersten Mal per **Rechtsklick › Öffnen** starten (App ist nicht notarisiert). |
| Quellcode | `pip install -r requirements.txt` und `python browsercad.py` |

Als Erstes wird das **Arbeitsverzeichnis** festgelegt (mit nativem Ordnerdialog) – dort liegen alle Parts,
Baugruppen, Importe und Exporte. Beim Schließen des Fensters mit ungespeicherten Änderungen fragt BrowserCAD nach.
Ein zweiter Start holt das bereits laufende Fenster nach vorn.

### Technik
- Fenster: [pywebview](https://pywebview.flowrl.com/) – Windows: Edge WebView2, macOS: WKWebView
- Intern arbeitet ein Server auf `127.0.0.1` (Standardport 8765), den nur das Programmfenster nutzt
- Einstellungen: `~/.browsercad/config.json`, Protokoll: `~/.browsercad/browsercad.log`
- Startoptionen: `--browser` (Oberfläche ersatzweise im Standardbrowser), `--server` (nur interner Server, für Tests).
  Unter *Werkzeuge › Optionen* lässt sich der Browser-Modus dauerhaft einstellen. Ist kein WebView verfügbar,
  weicht das Programm automatisch auf den Browser aus.

---

## Funktionen

### Part-Modellierung (Feature-Historie, parametrisch)
- **Bezüge:** Standard-Ebenen RIGHT/TOP/FRONT, PRT_CSYS_DEF, Bezugsebene (Versatz/Winkel zu Ebene oder Fläche), Bezugsachse (Schnitt zweier Ebenen oder Punkt+Richtung), Bezugspunkt
- **Skizzierer:** Linie (Kette), Rechteck (mit Eckenradius), Kreis, Bogen (3 Punkte), Mittellinie, Polygon, Langloch, Verrundung, Kante übernehmen; Fangen an Punkten/Raster/Referenzen; Maße im Grafikbereich anklicken und ändern; Konstruktionselemente
- **Formen:** Extrudieren (eine Seite / symmetrisch / beide Seiten / durch alles, hinzufügen/entfernen, Richtung ins Material wird wie in Creo automatisch vorgeschlagen), Drehen (um Mittellinie)
- **Konstruktion:** Bohrung (Platzierung per Klick auf Fläche, Ø, Tiefe/durch, Bohrerspitze, zylindrische/kegelige Senkung), Rundung und Fase an geraden Kanten (konvex und konkav)
- **Editieren:** Muster (Richtung, 2 Richtungen, Achse), Spiegeln (Feature oder gesamte Geometrie)
- **Modellbaum:** Definition editieren (Doppelklick), Umbenennen, Unterdrücken/Fortsetzen, Ausblenden, Löschen mit Abhängigkeiten, **Hier einfügen** (Einfügemarke/Rollback)
- **Parameter & Relationen:** in jedem Maßfeld nutzbar, z. B. `L/2+5`, `sqrt(A^2+B^2)`
- Rückgängig/Wiederherstellen, Regenerieren mit Fehleranzeige im Baum

### Baugruppen
- Komponenten **einbauen** (Parts und Unterbaugruppen), **erzeugen** (neues Part direkt in der Baugruppe)
- Platzierungsbedingungen per Flächenwahl: **Koinzident**, **Ausrichten**, **Abstand** (bis zu 3 Bedingungen, sequenziell gelöst; Referenz auf andere Komponenten oder ASM-Bezugsebenen)
- **Ziehen** mit Gizmo (T = verschieben, R = drehen), numerisch **Verschieben/Drehen**, Standardposition
- Komponente öffnen, ausblenden, unterdrücken, umbenennen, einfärben, löschen
- Ungespeicherte Änderungen an geöffneten Parts werden in der Baugruppe sofort berücksichtigt

### Ebenen und Darstellung (wie Creo)
- **Layerbaum** mit Regel-Layern (alle Bezugsebenen, Achsen, Punkte, KS, Standard-Ebenen) und eigenen Layern; Layer ein-/ausblenden
- **Bezugsanzeige-Filter** (Ebenen, Achsen, Punkte, Koordinatensysteme, Beschriftungen)
- Darstellungsstile: Schattiert mit Kanten, Schattiert, Keine verdeckten, Drahtmodell
- Gespeicherte Ausrichtungen: Standard, FRONT, BACK, TOP, BOTTOM, LEFT, RIGHT, Isometrisch; Neu einpassen; Drehzentrum

### Analyse
- Messen (Punkt-Punkt mit Eckpunktfang, ΔX/ΔY/ΔZ, Winkel und Abstand paralleler Flächen)
- Masseeigenschaften (Volumen, Oberfläche, Masse mit Dichte, Schwerpunkt, Begrenzungsquader)

### Dateiformate
| Format | Import | Export |
|---|---|---|
| BrowserCAD Part `.bcprt` / Baugruppe `.bcasm` (offenes JSON, s. u.) | ✔ | ✔ (Speichern) |
| STEP `.stp/.step` | ✔ (OpenCascade/WASM, auch Mehrkörper → Baugruppe) | ✔ AP214 B-Rep |
| IGES `.igs/.iges` | ✔ | – |
| STL `.stl` (binär/ASCII) | ✔ | ✔ |
| OpenUSD `.usda` | – | ✔ (Netz, `metersPerUnit = 0.001`) |
| Creo `.prt/.asm` (inkl. `.prt.3`) | über Konverter, s. u. | – |
| SolidWorks `.sldprt/.sldasm` | über Konverter, s. u. | – |

**Creo- und SolidWorks-Dateien:** Das sind geschlossene, proprietäre Formate. Ohne Hersteller-Software oder lizenzierten
Konverter kann sie kein freies Programm lesen. BrowserCAD bietet deshalb zwei Wege:
1. Im Ursprungsprogramm als STEP speichern (Creo: *Datei › Speichern als › STEP*, SolidWorks: *Speichern unter › STEP AP214*) und die `.stp` öffnen.
2. Unter **Werkzeuge › Optionen** einen Konverter-Befehl hinterlegen (z. B. CAD Exchanger CLI), Platzhalter `{in}` und `{out}`.
   BrowserCAD ruft ihn beim Öffnen/Importieren automatisch auf und importiert das STEP-Ergebnis (Ablage in `_konvertiert/`).

### 3Dconnexion SpaceMouse
Das Programm liest die SpaceMouse **direkt per USB-HID** (hidapi) – anstecken genügt, sie wird automatisch
erkannt (Kabel und Funkempfänger, alte Logitech-/3Dconnexion- und neue Geräte). Der Status steht unten in der
Statusleiste. Einstellbar unter *Werkzeuge › SpaceMouse*: Empfindlichkeit, Totzone, Achsen umkehren, nur dominante
Achse, Funktionen der Tasten 1/2.

Reagiert das Gerät nicht: den 3Dconnexion-Treiber (3DxWare / 3Dconnexion Home) beenden, er kann das Gerät exklusiv
belegen. Unter macOS ggf. in *Systemeinstellungen › Datenschutz & Sicherheit › Eingabeüberwachung* BrowserCAD
erlauben. Im Browser-Modus wird ersatzweise WebHID (Chrome/Edge) verwendet.

---

## Bedienung

| Aktion | Maus / Taste |
|---|---|
| Drehen | Mittlere Maustaste ziehen (Trackpad: Alt + Links ziehen) |
| Verschieben | Shift + Mitte ziehen (Trackpad: Alt + Shift + Links) |
| Zoomen | Mausrad (an Mausposition) oder Strg + Mitte ziehen |
| Auswählen / Kontextmenü | Links / Rechts |
| Speichern, Rückgängig, Wiederherstellen | Strg+S, Strg+Z, Strg+Y |
| Regenerieren, Standardausrichtung, Neu zeichnen | Strg+G, Strg+D, Strg+R |
| Abbrechen / Gewähltes Feature löschen | Esc / Entf |

Ablauf wie in Creo: Ebene oder Fläche wählen → **Extrudieren** → Skizze zeichnen → **OK** → Tiefe im Dashboard → **✔**.

---

## Bezug zu NVIDIA usd-brep

[usd-brep](https://github.com/NVIDIA-Omniverse/usd-brep) ist eine C++/Python-Bibliothek für NURBS-B-Rep-Volumenmodellierung
in OpenUSD. Sie wird mit NVIDIAs eigener Build-Kette (Packman, Visual Studio 2019-Toolset, nicht öffentliches
macOS-Premake-Paket) gebaut und lässt sich daher nicht in eine per GitHub Actions erzeugte Einzeldatei-exe/-App einbetten.
BrowserCAD lehnt sich konzeptionell daran an (B-Rep-Export, OpenUSD-Export mit Millimeter-Einheit, offene Datenformate)
und verwendet einen eigenen, im Programmfenster (JavaScript/WebGL) laufenden Kern:

- **Modellkern:** facettierter B-Rep-Ansatz (three.js + three-bvh-csg für Boolesche Operationen), eigene Profil-,
  Extrusions-, Rotations-, Rundungs-/Fasen- und Musterlogik, Netzbereinigung (Verschweißen, T-Stöße)
- **STEP-Export:** eigene AP214-Ausgabe; koplanare Dreiecke werden zu ebenen Flächen mit gemeinsamen Kanten zusammengefasst
- **STEP/IGES-Import:** OpenCascade als WebAssembly (occt-import-js)

**Grenzen des Kerns:** Gekrümmte Flächen sind facettiert (Feinheit unter *Werkzeuge › Optionen*). Rundung/Fase
arbeiten an geraden Kanten zwischen ebenen Flächen. Bei exakt deckungsgleichen Flächen zweier Körper können kleine
Netzfehler entstehen; Creo/SolidWorks vernähen diese beim STEP-Import normalerweise. Skizzen, Bohrungen und
Bezugsebenen auf einer **angeklickten Fläche** merken sich deren Lage zum Zeitpunkt der Auswahl (keine echte
Flächenreferenz): Ändert sich danach die Tiefe eines vorherigen Features, im Dashboard die Ebene neu wählen. Für voll
parametrische Modelle Bezugsebenen mit Versatz verwenden – der Versatz darf ein Parameter sein (z. B. `L`). Nicht enthalten sind u. a.
Zeichnungen, Sweep/Blend, Schale und Formschrägen.

---

## Dateiformat `.bcprt` / `.bcasm`

Offenes JSON, lesbar und versionierbar:

```json
{
  "format": "browsercad-part", "version": 1, "name": "prt0001", "units": "mm",
  "params": [{ "name": "L", "value": "80", "desc": "Länge" }],
  "features": [
    { "id": "FRONT", "type": "datumPlane", "name": "FRONT", "params": { "kind": "fixed", "origin": [0,0,0], "normal": [0,0,1], "xdir": [1,0,0] } },
    { "id": "f1", "type": "extrude", "name": "Extrudieren 1",
      "params": { "sketch": { "plane": "TOP", "entities": [{ "type": "rect", "x": "-L/2", "y": -25, "w": "L", "h": 50, "r": 0 }] },
                  "depth": 20, "side": "one", "op": "add" } }
  ],
  "layers": [{ "name": "01___PRT_ALL_DTM_PLN", "rule": "datumPlane", "items": [], "visible": true }],
  "insertAt": null
}
```

Baugruppen (`browsercad-assembly`) enthalten `components` mit relativem Dateipfad, 4×4-Matrix und Bedingungen.
Beim Speichern bleibt die Vorversion als `*.bak` erhalten.

---

## Build

Abhängigkeiten: Flask, Waitress, pywebview, hidapi (`requirements.txt`). Der Workflow `.github/workflows/build-release.yml` läuft bei jedem Push auf `main`/`master`, bei Tags `v*`
und manuell. Er testet kurz den Server, baut mit PyInstaller (`BrowserCAD.spec`) und erzeugt ein Release
`v<VERSION>-build<Nummer>` (bzw. den Tag-Namen) mit beiden Paketen. Die Version steht in `VERSION`.

Lokal: `pip install -r requirements.txt pyinstaller` und `pyinstaller --noconfirm BrowserCAD.spec`.

## Lizenzen der enthaltenen Bibliotheken
three.js (MIT), three-mesh-bvh (MIT), three-bvh-csg (MIT), occt-import-js (LGPL-2.1, mit OpenCascade LGPL-2.1 + Ausnahme) –
Lizenztexte unter `static/vendor/`.
