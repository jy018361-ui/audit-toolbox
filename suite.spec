# -*- mode: python ; coding: utf-8 -*-
# 审计工具箱单文件 exe

import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

block_cipher = None
ROOT = Path(SPECPATH)
TOOLS_DIR = ROOT / "tools"
MODULES_DIR = ROOT / "modules"

pathex = [str(ROOT)]

# 将 tools/ 和 modules/ 下所有子目录加入 path，供 PyInstaller 追踪导入
for base in (TOOLS_DIR, MODULES_DIR):
    if base.is_dir():
        for sub in base.iterdir():
            if sub.is_dir() and sub.name != "__pycache__":
                pathex.append(str(sub))

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
    "fastexcel",
]
hiddenimports += collect_submodules("fastexcel")

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
datas += collect_data_files("fastexcel")
binaries = collect_dynamic_libs("fastexcel")

def collect_runtime_tree(src: Path, dest: str):
    collected = []
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in {"build", "dist"}]
        rel = Path(dirpath).relative_to(src)
        target = Path(dest) / rel
        for fname in filenames:
            collected.append((str(Path(dirpath) / fname), str(target)))
    return collected

if TOOLS_DIR.is_dir():
    datas += collect_runtime_tree(TOOLS_DIR, "tools")
if MODULES_DIR.is_dir():
    datas += collect_runtime_tree(MODULES_DIR, "modules")

a = Analysis(
    ["suite_main.py"],
    pathex=pathex,
    binaries=binaries,
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
