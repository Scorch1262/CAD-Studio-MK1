# -*- mode: python ; coding: utf-8 -*-
# PyInstaller-Spezifikation fuer BrowserCAD (eigenes Programmfenster, keine Konsole)
#   Windows: dist/BrowserCAD.exe   (eine Datei)
#   macOS:   dist/BrowserCAD.app
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

VERSION = Path('VERSION').read_text(encoding='utf-8').strip()

datas = [('static', 'static'), ('VERSION', '.')]
datas += collect_data_files('webview')          # JS-Bruecke, WebView2Loader usw.
binaries = collect_dynamic_libs('webview') + collect_dynamic_libs('hid')

hidden = ['waitress', 'hid'] + collect_submodules('webview')
if sys.platform == 'win32':
    hidden += ['clr', 'clr_loader']               # pythonnet fuer WebView2
elif sys.platform == 'darwin':
    hidden += ['objc', 'Foundation', 'AppKit', 'WebKit', 'Quartz']

# Linux-/Qt-Backends von pywebview nicht mitpacken
excludes = ['tkinter', 'numpy', 'matplotlib', 'PIL', 'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'qtpy', 'gi']

a = Analysis(
    ['browsercad.py'],
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
            'LSMinimumSystemVersion': '12.0',
            # lokaler Server auf 127.0.0.1 im eigenen Fenster
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        },
    )
else:
    exe = EXE(
        pyz, a.scripts, a.binaries, a.datas, [],
        name='BrowserCAD',
        debug=False, strip=False, upx=False,
        console=False,
        runtime_tmpdir=None,
    )
