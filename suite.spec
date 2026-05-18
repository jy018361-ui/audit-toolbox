# -*- mode: python ; coding: utf-8 -*-
# 审计工具箱单文件 exe

import os
from pathlib import Path

block_cipher = None
ROOT = Path(SPECPATH)
VENDOR_FA = ROOT / "vendor" / "fa_list"
VENDOR_KZ = ROOT / "vendor" / "kanzhang"

pathex = [str(ROOT)]
if VENDOR_FA.is_dir():
    pathex.append(str(VENDOR_FA))
if VENDOR_KZ.is_dir():
    pathex.append(str(VENDOR_KZ))

hiddenimports = [
    "pandas",
    "numpy",
    "tkinter",
    "tkinter.ttk",
    "tkinter.filedialog",
    "tkinter.messagebox",
    "tkinter.font",
    "xlsxwriter",
    "openpyxl",
    "openpyxl.cell._writer",
    "dateutil",
    "dateutil.parser",
    "dateutil.relativedelta",
    "dateutil.tz",
    "xlrd",
    "pandas._libs.tslibs.base",
    "pandas._libs.tslibs.nattype",
    "polars",
    "polars._utils",
    "python_calamine",
]

excludes = [
    "matplotlib",
    "matplotlib.backends",
    "mpl_toolkits",
    "scipy",
    "PIL",
    "Pillow",
    "IPython",
    "jupyter",
    "jupyter_client",
    "notebook",
    "nbformat",
    "nbconvert",
    "pytest",
    "_pytest",
    "setuptools",
    "pkg_resources",
    "sqlalchemy",
    "dask",
    "distributed",
    "numba",
    "requests",
    "urllib3",
    "bokeh",
    "plotly",
    "panel",
    "sklearn",
    "statsmodels",
    "torch",
    "tensorflow",
    "lxml",
    "html5lib",
    "bs4",
    "zmq",
]

datas = [(str(ROOT / "tools.json"), ".")]
if (ROOT / "vendor").is_dir():
    datas.append((str(ROOT / "vendor"), "vendor"))

a = Analysis(
    ["suite_main.py"],
    pathex=pathex,
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="审计工具箱",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
