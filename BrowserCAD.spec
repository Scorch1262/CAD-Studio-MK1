# -*- mode: python ; coding: utf-8 -*-
# PyInstaller-Spezifikation fuer BrowserCAD
#   Windows: dist/BrowserCAD.exe (eine Datei, mit Konsolenfenster = Serverlog, schliessen beendet)
#   macOS:   dist/BrowserCAD.app (ohne Konsole, Beenden ueber Datei > Beenden in der Oberflaeche)
import sys
from pathlib import Path

VERSION = Path('VERSION').read_text(encoding='utf-8').strip()

a = Analysis(
    ['browsercad.py'],
    pathex=[],
    binaries=[],
    datas=[('static', 'static'), ('VERSION', '.')],
    hiddenimports=['waitress'],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'numpy', 'matplotlib', 'PIL'],
    noarchive=False,
)
pyz = PYZ(a.pure)

if sys.platform == 'darwin':
    exe = EXE(
        pyz, a.scripts, [],
        exclude_binaries=True,
        name='BrowserCAD',
        debug=False, strip=False, upx=False,
        console=False,
        argv_emulation=False,
    )
    coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='BrowserCAD')
    app = BUNDLE(
        coll,
        name='BrowserCAD.app',
        bundle_identifier='de.scorch1262.browsercad',
        version=VERSION,
        info_plist={
            'CFBundleName': 'BrowserCAD',
            'CFBundleDisplayName': 'BrowserCAD',
            'CFBundleShortVersionString': VERSION,
            'CFBundleVersion': VERSION,
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '11.0',
        },
    )
else:
    exe = EXE(
        pyz, a.scripts, a.binaries, a.datas, [],
        name='BrowserCAD',
        debug=False, strip=False, upx=False,
        console=True,
        runtime_tmpdir=None,
    )
