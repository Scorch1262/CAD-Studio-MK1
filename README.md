# CAD-Studio-MK1 1.4.0

Eigenständiges 3D-CAD-Programm für Windows und macOS im dunklen Dashboard-Stil, dessen Bedienung sich an
**PTC Creo Parametric** orientiert: Menüband mit Registerkarten, Modellbaum mit Einfügemarke, Feature-Dashboard
mit ✔/✖, Layerbaum, Bezugsanzeige-Filter, Creo-Maussteuerung und 3Dconnexion-SpaceMouse.

CAD-Studio-MK1 läuft in **einem eigenen Programmfenster** – es wird kein Browser geöffnet und keiner benötigt.
Modellierkern ist **[NVIDIA usd-brep](https://github.com/NVIDIA-Omniverse/usd-brep)**: alle Volumenkörper sind exakte
NURBS-B-Rep-Modelle.
GitHub Actions baut daraus eine **Windows-exe** und eine **macOS-App** und legt automatisch ein **Release** an.

---

## Schnellstart

| System | Start |
|---|---|
| Windows 10/11 | `CAD-Studio-MK1-1.3.0-windows-x64.exe` doppelklicken. Benötigt die Microsoft-WebView2-Laufzeit (auf Windows 11 und aktuellen Windows-10-Systemen vorhanden; sonst kostenlos bei Microsoft). |
| macOS 12+ | ZIP entpacken, `CAD-Studio-MK1.app` beim ersten Mal per **Rechtsklick › Öffnen** starten (App ist nicht notarisiert). |
| Quellcode | `pip install -r requirements.txt` und `python cadstudio.py` |

Als Erstes wird das **Arbeitsverzeichnis** festgelegt (mit nativem Ordnerdialog) – dort liegen alle Parts,
Baugruppen, Importe und Exporte. Beim Schließen des Fensters mit ungespeicherten Änderungen fragt CAD-Studio-MK1 nach.
Ein zweiter Start holt das bereits laufende Fenster nach vorn.

### Technik
- Fenster: [pywebview](https://pywebview.flowrl.com/) – Windows: Edge WebView2, macOS: WKWebView
- Intern arbeitet ein Server auf `127.0.0.1` (Standardport 8765), den nur das Programmfenster nutzt
- Einstellungen: `~/.cad-studio-mk1/config.json`, Protokoll: `~/.cad-studio-mk1/cad-studio-mk1.log`
  (Einstellungen der Vorgängerversion werden beim ersten Start übernommen)
- Startoptionen: `--browser` (Oberfläche ersatzweise im Standardbrowser), `--server` (nur interner Server, für Tests).
  Unter *Werkzeuge › Optionen* lässt sich der Browser-Modus dauerhaft einstellen. Ist kein WebView verfügbar,
  weicht das Programm automatisch auf den Browser aus.

---

## Funktionen

### Part-Modellierung (Feature-Historie, parametrisch)
- **Bezüge:** Standard-Ebenen RIGHT/TOP/FRONT, PRT_CSYS_DEF, Bezugsebene (Versatz/Winkel zu Ebene oder Fläche), Bezugsachse (Schnitt zweier Ebenen oder Punkt+Richtung), Bezugspunkt
- **Skizze (eigenständig):** Skizze als eigenes Element im Modellbaum auf Ebene oder ebener Fläche anlegen; danach mit Extrudieren/Drehen verwenden (auch mehrfach). Auswahl im Modellbaum, im Grafikbereich oder im Dashboard; verwendete Skizzen werden wie in Creo ausgeblendet
- **Skizzierer:** Linie (Kette), Rechteck (mit Eckenradius), Kreis, Bogen (3 Punkte), Mittellinie, Polygon, Langloch, Verrundung, Kante übernehmen; Fangen an Punkten/Raster/Referenzen; Maße im Grafikbereich anklicken und ändern; **Bemaßungswerkzeug** für steuernde Abstands-, Horizontal-, Vertikal- und Winkelmaße; Konstruktionselemente
- **Formen:** Extrudieren (eine Seite / symmetrisch / beide Seiten / durch alles, hinzufügen/entfernen, Richtung ins Material wird wie in Creo automatisch vorgeschlagen), Drehen (um Mittellinie)
- **Konstruktion:** Bohrung (Platzierung per Klick auf Fläche, Ø, Tiefe/durch, Bohrerspitze, zylindrische/kegelige Senkung), Rundung und Fase an beliebigen Kanten (gerade und gekrümmt, konvex und konkav; mehrere Kanten nacheinander anklicken, Tangentenkette, Vorschau sofort beim Anklicken), Schale (Flächen entfernen, Wandstärke)
- **Editieren:** Muster (Richtung, 2 Richtungen, Achse), Spiegeln (Feature oder gesamte Geometrie)
- **Modellbaum:** Definition editieren (Doppelklick), Umbenennen, Unterdrücken/Fortsetzen, Ausblenden, Löschen mit Abhängigkeiten, **Hier einfügen** (Einfügemarke/Rollback)
- **Maße am Modell:** beim Bearbeiten eines Features werden seine Maße (mm/°) am Modell eingeblendet und lassen sich anklicken und ändern
- **Bemaßung am Körper:** Kantenlänge, Ø, Punkt- und Flächenabstand als gespeicherte Referenzmaße (Modell › Bemaßung)
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
- Masseeigenschaften exakt aus der B-Rep (Volumen, Oberfläche, Masse mit Dichte, Schwerpunkt, Topologie)

### Dateiformate
| Format | Import | Export |
|---|---|---|
| CAD-Studio-MK1 Part `.csprt` / Baugruppe `.csasm` (offenes JSON, s. u.) | ✔ | ✔ (Speichern) |
| OpenUSD B-Rep `.usda` (usd-brep, exakt) | – | ✔ (Windows) |
| SMLib B-Rep `.brep` (usd-brep, exakt) | – | ✔ (Windows, Parts) |
| STEP `.stp/.step` | ✔ (OpenCascade/WASM als Netz, auch Mehrkörper → Baugruppe) | ✔ AP214, facettiert |
| IGES `.igs/.iges` | ✔ | – |
| STL `.stl` (binär/ASCII) | ✔ | ✔ |
| OpenUSD `.usda` | – | ✔ (Netz, `metersPerUnit = 0.001`) |
| Creo `.prt/.asm` (inkl. `.prt.3`) | über Konverter, s. u. | – |
| SolidWorks `.sldprt/.sldasm` | über Konverter, s. u. | – |

**Creo- und SolidWorks-Dateien:** Das sind geschlossene, proprietäre Formate. Ohne Hersteller-Software oder lizenzierten
Konverter kann sie kein freies Programm lesen. CAD-Studio-MK1 bietet deshalb zwei Wege:
1. Im Ursprungsprogramm als STEP speichern (Creo: *Datei › Speichern als › STEP*, SolidWorks: *Speichern unter › STEP AP214*) und die `.stp` öffnen.
2. Unter **Werkzeuge › Optionen** einen Konverter-Befehl hinterlegen (z. B. CAD Exchanger CLI), Platzhalter `{in}` und `{out}`.
   CAD-Studio-MK1 ruft ihn beim Öffnen/Importieren automatisch auf und importiert das STEP-Ergebnis (Ablage in `_konvertiert/`).

### 3Dconnexion SpaceMouse
Das Programm liest die SpaceMouse **direkt per USB-HID** (hidapi) – anstecken genügt, sie wird automatisch
erkannt (Kabel und Funkempfänger, alte Logitech-/3Dconnexion- und neue Geräte). Der Status steht unten in der
Statusleiste. Einstellbar unter *Werkzeuge › SpaceMouse*: Empfindlichkeit, Totzone, Achsen umkehren, nur dominante
Achse, Funktionen der Tasten 1/2.

Reagiert das Gerät nicht: den 3Dconnexion-Treiber (3DxWare / 3Dconnexion Home) beenden, er kann das Gerät exklusiv
belegen. Unter macOS ggf. in *Systemeinstellungen › Datenschutz & Sicherheit › Eingabeüberwachung* CAD-Studio-MK1
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
| Mehrfachauswahl (z. B. Kanten) | Strg + Links |

### Vom Skizzieren zum 3D-Körper

**Weg 1 – eigenständige Skizze (wie Creo „Skizze“):**
1. Ebene im Modellbaum (RIGHT/TOP/FRONT/DTM…) oder eine ebene Körperfläche im Grafikbereich anklicken.
2. *Modell › Skizze* – die Ansicht dreht sich senkrecht auf die Ebene.
3. Zeichnen (Linie, Rechteck, Kreis, Bogen …), Maße anklicken und Werte eintippen, **OK**.
4. Die neue Skizze ist ausgewählt: *Extrudieren* oder *Drehen* klicken – das Dashboard öffnet sich sofort mit dieser Skizze.
5. Tiefe/Winkel, Hinzufügen/Entfernen einstellen, **✔**.

Eine vorhandene Skizze kann auch später verwendet werden: im Modellbaum oder im Grafikbereich anklicken und
*Extrudieren*/*Drehen* wählen, per Rechtsklick › „Extrudieren mit dieser Skizze“ oder im Dashboard unter „Skizze“.
Ändert man die Skizze (Doppelklick im Modellbaum), folgen alle Körper, die sie verwenden.

**Maße:** Alle Maße sind in Millimetern (Winkel in Grad), die Einheit wird immer angezeigt. Während ein Feature oder
eine Skizze bearbeitet wird, stehen die Maße am Modell – Klick auf ein Maß, Wert eintippen (auch Ausdrücke wie `L/2`),
Enter. Im Skizzierer legt das Werkzeug *Bemaßung* zusätzliche steuernde Maße an: zwei Punkte anklicken und
Abstand/Horizontal/Vertikal wählen, oder eine Linie anklicken für ihren Winkel.

**Rundung/Fase:** Werkzeug wählen und Kanten nacheinander anklicken – die Vorschau erscheint sofort. Bei aktiver
Tangentenkette werden tangential anschließende Kanten mitgenommen. Kanten können auch vorher mit Strg+Klick gewählt werden.

**Weg 2 – Skizze im Feature:** Ebene/Fläche wählen → *Extrudieren* → Skizze zeichnen → **OK** → Tiefe → **✔**.

Geschlossene Konturen ergeben Volumen (innere Konturen werden zu Aussparungen); für *Drehen* gehört eine Mittellinie
als Achse in die Skizze. Für eine Skizze an beliebiger Stelle vorher *Modell › Ebene* mit Versatz anlegen.

---

## Modellierkern NVIDIA usd-brep

[usd-brep](https://github.com/NVIDIA-Omniverse/usd-brep) ist NVIDIAs Bibliothek für NURBS-basierte
B-Rep-Volumenmodellierung mit OpenUSD-Anbindung. CAD-Studio-MK1 nutzt das offizielle Python-Paket
([`usd-brep` auf PyPI](https://pypi.org/project/usd-brep/), CPython 3.12), das in der Windows-exe enthalten ist.

**Aufgabenteilung:** Die Oberfläche wertet Parameter, Bezugsebenen/-achsen und Skizzen aus und schickt je Feature eine
Operation an den Kern (`kernel.py`). Dort entstehen die Körper exakt:

| Feature | usd-brep-Funktion |
|---|---|
| Extrudieren (Linien, Bögen, Kreise, Inseln) | `linear_sweep`, `boolean_difference/union` |
| Drehen | `rotational_sweep` |
| Bohrung, Senkungen, Bohrerspitze | `create_cylinder`, `create_cone`, Boolesche Operationen |
| Rundung / Fase (gerade **und gekrümmte** Kanten) | `fillet_edges` (Kreisquerschnitt bzw. linear) |
| Schale | `shell_brep` |
| Muster / Spiegeln | `transform`, `scale`, Boolesche Operationen |
| Anzeige | `tessellate`, `tessellate_boundaries` |
| Masseeigenschaften | `mass_properties` |
| Export | `usd.export_brep(s)` (OpenUSD, omniSolid-Schema), `write_to_file` (SMLib) |

Gewählte Kanten werden über ihren Mittelpunkt referenziert und bei jeder Regenerierung mit `find_edge` wiedergefunden.
Scheitert eine Boolesche Operation an deckungsgleichen Flächen, wird sie mit einem minimal versetzten Werkzeug
(Millionstel der Modellgröße) wiederholt.

**Plattformen:** NVIDIA bietet usd-brep nur für **Windows und Linux** an. Für macOS gibt es kein Paket, und der
Quellcode-Build benötigt laut NVIDIA ein nicht öffentliches Werkzeugpaket. Die **macOS-App verwendet deshalb den
internen Netzkern** (three.js/three-bvh-csg): Extrudieren, Drehen, Bohrung, Muster und Spiegeln funktionieren dort auch,
Rundung/Fase nur an geraden Kanten, keine Schale, kein exakter Export. Die Statusleiste zeigt den aktiven Kern.

**Grenzen:** usd-brep hat keine STEP-Ein-/Ausgabe in Python. STEP/IGES werden deshalb mit OpenCascade (WebAssembly)
als Netz importiert (Referenzgeometrie, nicht mit Features bearbeitbar), und der STEP-Export ist facettiert. Exakt
exportieren CAD-Studio-MK1-Modelle nach **OpenUSD-B-Rep** und **SMLib-B-Rep**. Skizzen auf angeklickten Flächen merken sich
deren Lage zum Zeitpunkt der Auswahl; für voll parametrische Modelle Bezugsebenen mit (parametrischem) Versatz nutzen.
Nicht enthalten sind u. a. Zeichnungen, Sweep/Blend und Formschrägen.

## Dateiformat `.csprt` / `.csasm`

Offenes JSON, lesbar und versionierbar:

```json
{
  "format": "cadstudio-part", "version": 1, "name": "prt0001", "units": "mm",
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

Referenzmaße am Körper stehen in `annotations` (Typ `len`, `dia`, `dist`, `pdist`).
Baugruppen (`cadstudio-assembly`) enthalten `components` mit relativem Dateipfad, 4×4-Matrix und Bedingungen.
Beim Speichern bleibt die Vorversion als `*.bak` erhalten.

**Dateien der Vorgängerversion** (`.bcprt` / `.bcasm`) lassen sich weiter öffnen. Beim Wechsel in ein Arbeitsverzeichnis
mit solchen Dateien bietet das Programm die Umwandlung in `.csprt` / `.csasm` an (Originale bleiben erhalten, Verweise in
Baugruppen werden angepasst); einzeln geöffnete Altdateien werden beim Speichern im neuen Format abgelegt.

---

## Build

Abhängigkeiten: Flask, Waitress, pywebview, hidapi, usd-brep (`requirements.txt`; Python **3.12** erforderlich, da usd-brep nur dafür angeboten wird). Der Workflow `.github/workflows/build-release.yml` läuft bei jedem Push auf `main`/`master`, bei Tags `v*`
und manuell. Er prüft den usd-brep-Kern (Selbsttest im Quellcode und in der fertigen exe), baut mit PyInstaller (`CAD-Studio-MK1.spec`) und erzeugt ein Release
`v<VERSION>-build<Nummer>` (bzw. den Tag-Namen) mit beiden Paketen. Die Version steht in `VERSION`.

Das Programmsymbol liegt unter `assets/` (`icon.svg` als Vorlage, `icon.ico` für Windows, `icon.icns` für macOS,
`icon-256.png` für das Fenster) und wird von PyInstaller in exe und App eingebunden.

Lokal: `pip install -r requirements.txt pyinstaller` und `pyinstaller --noconfirm CAD-Studio-MK1.spec`.

## Lizenzen der enthaltenen Bibliotheken
NVIDIA usd-brep (Apache-2.0, mit gebündelter OpenUSD-Laufzeit), three.js (MIT), three-mesh-bvh (MIT), three-bvh-csg (MIT), occt-import-js (LGPL-2.1, mit OpenCascade LGPL-2.1 + Ausnahme) –
Lizenztexte unter `static/vendor/`.
