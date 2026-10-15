# -*- mode: python ; coding: utf-8 -*-
# PyInstaller-Spezifikation fuer CAD-Studio-MK1 (eigenes Programmfenster, keine Konsole)
#   Windows: dist/CAD-Studio-MK1.exe   (eine Datei)
#   macOS:   dist/CAD-Studio-MK1.app
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata

VERSION = Path('VERSION').read_text(encoding='utf-8').strip()

import importlib.util

datas = [('static', 'static'), ('VERSION', '.')]
binaries = []
hidden = ['waitress', 'hid', 'kernel']
try:
    datas += collect_data_files('webview')      # JS-Bruecke, WebView2Loader usw.
    binaries += collect_dynamic_libs('webview')
    hidden += collect_submodules('webview')
except Exception:
    pass
binaries += collect_dynamic_libs('hid')

# Modellierkern usd-brep: kompletter Paketordner unveraendert mitnehmen
# (bringt eigene OpenUSD-Laufzeit, Plugin-Beschreibungen und omniSolid-Schema mit)
excludes_extra = []
_spec = importlib.util.find_spec('usd_brep')
if _spec and _spec.origin:
    _pkg = Path(_spec.origin).parent
    for _p in _pkg.rglob('*'):
        if _p.is_file() and '__pycache__' not in _p.parts:
            datas.append((str(_p), str(Path('usd_brep') / _p.relative_to(_pkg).parent)))
    excludes_extra.append('usd_brep')
    try:
        datas += copy_metadata('usd-brep')   # Versionsanzeige
    except Exception:
        pass
    hidden += ['importlib.util', 'importlib.metadata', 'types']
    print('CAD-Studio-MK1.spec: usd-brep wird eingebunden aus', _pkg)
else:
    print('CAD-Studio-MK1.spec: usd-brep nicht installiert - interner Kern')
if sys.platform == 'win32':
    hidden += ['clr', 'clr_loader']               # pythonnet fuer WebView2
    # Microsoft-C++-Laufzeit app-lokal neben die usd-brep-DLLs legen (kein VC++ Redistributable noetig)
    if _spec and _spec.origin:
        import os
        _sys32 = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32'
        for _dll in ('msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll',
                     'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll', 'vcomp140.dll'):
            if (_sys32 / _dll).is_file():
                binaries.append((str(_sys32 / _dll), 'usd_brep'))
elif sys.platform == 'darwin':
    hidden += ['objc', 'Foundation', 'AppKit', 'WebKit', 'Quartz']

# Linux-/Qt-Backends von pywebview nicht mitpacken
excludes = ['tkinter', 'numpy', 'matplotlib', 'PIL', 'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'qtpy', 'gi'] + excludes_extra

a = Analysis(
    ['cadstudio.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

if sys.platform == 'darwin':
    exe = EXE(
        pyz, a.scripts, [],
        exclude_binaries=True,
        name='CAD-Studio-MK1',
        debug=False, strip=False, upx=False,
        console=False,
        argv_emulation=False,
    )
    coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='CAD-Studio-MK1')
    app = BUNDLE(
        coll,
        name='CAD-Studio-MK1.app',
        bundle_identifier='de.scorch1262.cad-studio-mk1',
        version=VERSION,
        info_plist={
            'CFBundleName': 'CAD-Studio-MK1',
            'CFBundleDisplayName': 'CAD-Studio-MK1',
            'CFBundleShortVersionString': VERSION,
            'CFBundleVersion': VERSION,
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '12.0',
            # lokaler Server auf 127.0.0.1 im eigenen Fenster
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        },
    )
else:
    exe = EXE(
        pyz, a.scripts, a.binaries, a.datas, [],
        name='CAD-Studio-MK1',
        debug=False, strip=False, upx=False,
        console=False,
        runtime_tmpdir=None,
    )
