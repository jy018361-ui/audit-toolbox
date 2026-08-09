# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

ROOT = Path(SPECPATH)
hiddenimports = [
    "pandas", "numpy", "openpyxl", "xlsxwriter", "dateutil", "xlrd", "PIL", "lxml",
    # FA List's exporter is loaded from a tool path at runtime, so PyInstaller
    # cannot discover these launcher imports from its static import graph.
    "launcher.llm_analysis", "launcher.llm_client", "launcher.llm_settings",
]
datas = []
binaries = []

EXCLUDED_DIRS = {".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"}
EXCLUDED_SUFFIXES = {".exe", ".dll", ".pdb", ".pyc"}

def collect_tree(source: Path, target: str):
    rows = []
    if not source.is_dir():
        return rows
    for path in source.rglob("*"):
        rel = path.relative_to(source)
        if not path.is_file() or any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        if source.name == "modules" and rel.parts and rel.parts[0] == "Excel-Merger":
            continue
        if source.name == "modules" and rel.parts and rel.parts[0] == "AudiPick":
            continue
        if source.name == "modules" and rel.parts and rel.parts[0] == "confirmation_progress":
            continue
        if source.name == "tools" and len(rel.parts) >= 2 and rel.parts[:2] == ("fa_list", "折旧测算工具"):
            continue
        if source.name == "tools" and rel.parts and rel.parts[0] in {"TS", "kanzhang"}:
            continue
        if path.suffix.lower() in EXCLUDED_SUFFIXES:
            continue
        rows.append((str(path), str(Path(target) / rel.parent)))
    return rows

datas += collect_tree(ROOT / "tools", "tools")
datas += collect_tree(ROOT / "modules", "modules")
datas += [(str(ROOT / "tools.json"), ".")]
a = Analysis(
    [str(ROOT / "audit_engine_entry.py")], pathex=[str(ROOT)], binaries=binaries,
    datas=datas, hiddenimports=hiddenimports, hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=["tkinter", "_tkinter", "PyQt6", "polars", "fastexcel", "python_calamine", "matplotlib", "scipy", "IPython", "jupyter", "pytest", "torch", "tensorflow"],
    noarchive=False,
)
pyz = PYZ(a.pure)
# The engine is launched with CREATE_NO_WINDOW by Rust, but it must keep a
# console subsystem so stdin/stdout remain usable for the JSON Lines protocol.
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="audit-engine", console=True, debug=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="audit-engine")
