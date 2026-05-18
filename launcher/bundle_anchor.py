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
