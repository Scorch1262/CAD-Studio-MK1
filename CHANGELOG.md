# Changelog

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
- Eigene offene Dateiformate .bcprt/.bcasm (JSON) mit Sicherung der Vorversion
- Messen und Masseeigenschaften
- 3Dconnexion-SpaceMouse über WebHID (Empfindlichkeit, Totzone, Achsumkehr, Tastenbelegung)
- GitHub Actions: Windows-exe, macOS-App, automatisches Release
