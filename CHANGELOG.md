# Changelog

## [1.3.0] - 2026-10-15
### Geändert
- Neuer Programmname **CAD-Studio-MK1**: Fenster, exe/App, Dateinamen, Einstellungsordner (`~/.cad-studio-mk1`), Umgebungsvariablen (`CADSTUDIO_*`)
- Eigene Dateiformate `.csprt` (Part) und `.csasm` (Baugruppe)
- Transparente Flächen von Bezugsebenen verdecken bei der Auswahl keine Kanten oder Skizzen mehr
### Neu
- Eigenständiges Feature „Skizze“ (Modell › Skizze): Skizze im Modellbaum, Anzeige im Grafikbereich, Auswahl per Baum/Grafik/Dashboard
- Extrudieren und Drehen verwenden eine vorhandene Skizze direkt; eine Skizze kann von mehreren Features genutzt werden
- Verwendete Skizzen werden automatisch ausgeblendet (Rechtsklick › Einblenden), Anzeigefilter und Layer „Skizzen“
- Kontextmenü an Skizzen: „Extrudieren mit dieser Skizze“, „Drehen mit dieser Skizze“
- Übernahme der Vorgängerversion: alte Part-/Baugruppendateien bleiben lesbar und können per Klick umgewandelt werden; Einstellungen werden übernommen

## [1.2.0] - 2026-10-15
### Geändert
- Modellierkern ist jetzt NVIDIA usd-brep: alle Körper sind exakte NURBS-B-Rep-Modelle (Windows; macOS mangels usd-brep-Paket weiter mit internem Kern)
- Skizzen werden als exakte Linien, Bögen und Kreise an den Kern übergeben
- Masseeigenschaften exakt aus der B-Rep inkl. Topologie (Flächen, Kanten, Ecken)
### Neu
- Rundung und Fase an beliebigen, auch gekrümmten Kanten
- Feature „Schale“ (Flächen entfernen, Wandstärke, nach innen/außen)
- Export als OpenUSD-B-Rep (omniSolid-Schema) und SMLib-B-Rep, exakt
- Kernanzeige in der Statusleiste, verständliche Fehlermeldungen des Kerns
- Robuste Boolesche Operationen: Wiederholung mit minimal versetztem Werkzeug bei deckungsgleichen Flächen
- CI prüft den Kern im Quellcode und in der fertigen exe; Microsoft-C++-Laufzeit wird mitgeliefert

## [1.1.0] - 2026-10-15
### Geändert
- CAD-Studio-MK1 ist jetzt ein eigenständiges Desktop-Programm mit eigenem Fenster (Windows: WebView2, macOS: WKWebView) – es öffnet sich kein Browser mehr
- exe ohne Konsolenfenster; Protokoll in ~/.cad-studio-mk1/cad-studio-mk1.log
- SpaceMouse wird direkt per USB-HID gelesen (hidapi), automatische Erkennung beim Anstecken; WebHID nur noch im Browser-Modus
- Import-Map entfernt, alle Module mit relativen Pfaden (läuft auch in älteren macOS-WebViews)
### Neu
- Nativer Ordnerdialog für das Arbeitsverzeichnis, nativer Dateidialog zum Hinzufügen von Dateien
- Rückfrage beim Schließen des Fensters mit ungespeicherten Änderungen
- „Kopie speichern unter…“ und „Im Explorer/Finder zeigen“ im Ordner-Browser, Arbeitsverzeichnis öffnen
- Fenstertitel zeigt das aktive Modell und den Speicherstatus
- Zweiter Programmstart holt das laufende Fenster nach vorn
- Startoptionen --browser und --server, Browser-Modus wählbar unter Werkzeuge › Optionen
- Bild (PNG) wird im Arbeitsverzeichnis gespeichert

## [1.0.0] - 2026-10-14
### Neu
- Browserbasiertes CAD mit Creo-orientierter Oberfläche (Menüband, Modellbaum, Feature-Dashboard, Layerbaum, Ordner-Browser) im dunklen Dashboard-Thema
- Arbeitsverzeichnis wird beim Programmstart festgelegt (mit Ordnerauswahl und zuletzt verwendeten Pfaden)
- Part-Features: Bezugsebene/-achse/-punkt, Extrudieren, Drehen, Bohrung, Rundung, Fase, Muster, Spiegeln, Import
- Skizzierer mit Linie, Rechteck, Kreis, Bogen, Mittellinie, Polygon, Langloch, Verrundung, Kante übernehmen und anklickbaren Maßen
- Parameter/Relationen in allen Maßfeldern, Einfügemarke, Unterdrücken, Rückgängig/Wiederherstellen
- Baugruppen mit Einbauen, Erzeugen, Bedingungen (Koinzident, Ausrichten, Abstand), Ziehen und numerischem Verschieben
- Layer und Bezugsanzeige-Filter zum Ein-/Ausblenden von Ebenen, Achsen, Punkten und Koordinatensystemen
- Import: STEP, IGES, STL; Creo/SolidWorks über konfigurierbaren Konverter
- Export: STEP AP214 (B-Rep), STL binär/ASCII, OpenUSD (.usda)
- Eigene offene Dateiformate .csprt/.csasm (JSON) mit Sicherung der Vorversion
- Messen und Masseeigenschaften
- 3Dconnexion-SpaceMouse über WebHID (Empfindlichkeit, Totzone, Achsumkehr, Tastenbelegung)
- GitHub Actions: Windows-exe, macOS-App, automatisches Release
