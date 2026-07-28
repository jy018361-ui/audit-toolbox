#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Small Windows dialog helper used outside the PyQt process."""

import argparse
import ctypes
import re
import sys
from ctypes import wintypes
from pathlib import Path


MAX_PATH_CHARS = 32768


def write_result(result_path, value):
    Path(result_path).write_text(value or "", encoding="utf-8")


def browse_directory(title):
    shell32 = ctypes.windll.shell32
    ole32 = ctypes.windll.ole32

    class BROWSEINFOW(ctypes.Structure):
        _fields_ = [
            ("hwndOwner", wintypes.HWND),
            ("pidlRoot", ctypes.c_void_p),
            ("pszDisplayName", wintypes.LPWSTR),
            ("lpszTitle", wintypes.LPCWSTR),
            ("ulFlags", wintypes.UINT),
            ("lpfn", ctypes.c_void_p),
            ("lParam", wintypes.LPARAM),
            ("iImage", ctypes.c_int),
        ]

    display_name = ctypes.create_unicode_buffer(MAX_PATH_CHARS)
    result_path = ctypes.create_unicode_buffer(MAX_PATH_CHARS)
    flags = 0x0001 | 0x0010 | 0x0040  # filesystem dirs, edit box, new dialog style

    ole32.OleInitialize(None)
    try:
        browse_info = BROWSEINFOW(
            None,
            None,
            ctypes.cast(display_name, wintypes.LPWSTR),
            title,
            flags,
            None,
            0,
            0,
        )
        pidl = shell32.SHBrowseForFolderW(ctypes.byref(browse_info))
        if not pidl:
            return ""
        try:
            if shell32.SHGetPathFromIDListW(pidl, result_path):
                return result_path.value
            return ""
        finally:
            ole32.CoTaskMemFree(pidl)
    finally:
        ole32.OleUninitialize()


def filter_to_win32(filter_text):
    if not filter_text:
        return "All files (*.*)\0*.*\0\0"
    parts = filter_text.split("|")
    if len(parts) > 1 and len(parts) % 2 == 0:
        return "\0".join(parts) + "\0\0"

    win32_parts = []
    for segment in str(filter_text).split(";;"):
        segment = segment.strip()
        if not segment:
            continue
        patterns = re.findall(r"\(([^()]+)\)", segment)
        pattern = ";".join(patterns[-1].split()) if patterns else "*.*"
        win32_parts.extend([segment, pattern])
    if not win32_parts:
        win32_parts = ["All files (*.*)", "*.*"]
    if "*.*" not in win32_parts[1::2]:
        win32_parts.extend(["All files (*.*)", "*.*"])
    return "\0".join(win32_parts) + "\0\0"


def browse_file(title, filter_text):
    comdlg32 = ctypes.windll.comdlg32

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]

    file_buffer = ctypes.create_unicode_buffer(MAX_PATH_CHARS)
    filter_buffer = ctypes.create_unicode_buffer(filter_to_win32(filter_text))
    title_buffer = ctypes.create_unicode_buffer(title or "")
    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    ofn.lpstrFilter = ctypes.cast(filter_buffer, wintypes.LPCWSTR)
    ofn.lpstrFile = ctypes.cast(file_buffer, wintypes.LPWSTR)
    ofn.nMaxFile = MAX_PATH_CHARS
    ofn.lpstrTitle = ctypes.cast(title_buffer, wintypes.LPCWSTR)
    ofn.Flags = 0x00001000 | 0x00000800 | 0x00000008  # file must exist, path must exist, hide readonly

    if comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
        return file_buffer.value
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("directory", "file", "self-test"))
    parser.add_argument("--result", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--filter", default="")
    args = parser.parse_args()

    try:
        if args.kind == "self-test":
            value = "dialog-helper-ok"
        elif args.kind == "directory":
            value = browse_directory(args.title or "选择目录")
        else:
            value = browse_file(args.title or "选择文件", args.filter)
        write_result(args.result, value)
        return 0
    except Exception as exc:
        write_result(args.result, "")
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
