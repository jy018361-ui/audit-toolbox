"""供 PyInstaller Analysis 追踪的重依赖锚点（suite_main 导入一次即可）。"""
# 注意：此文件中的 import 列表用于 PyInstaller 追踪依赖。
# 新增子工具若引入新的第三方库，请在此补充 import，否则打包后可能找不到该模块。


def touch_bundle_deps() -> None:
    import dateutil  # noqa: F401
    import numpy  # noqa: F401
    import openpyxl  # noqa: F401
    import pandas  # noqa: F401
    import polars  # noqa: F401
    import python_calamine  # noqa: F401
    import xlsxwriter  # noqa: F401
    import xlrd  # noqa: F401

    try:
        import pythoncom  # noqa: F401
        import pywintypes  # noqa: F401
        import win32com.client  # noqa: F401
    except ImportError:
        # pywin32 只用于“多 Sheet 原样复制”的可选快路径。
        # 开发环境缺失时不应阻止整个工具箱启动；打包追踪由 suite.spec 兜底。
        pass
