"""
主窗口
应用入口和主界面框架
"""
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import os
import threading
import webbrowser
from urllib.parse import quote
import pandas as pd
from config import APP_NAME, WINDOW_WIDTH, WINDOW_HEIGHT, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT
# #region agent log
try:
    from debug_logger import _write as _dbg
except Exception:
    _dbg = lambda **kw: None
# #endregion
from file_handler import FileHandler
from merge_engine import MergeEngine
from pivot_engine import PivotEngine
from exporter import Exporter
from gui.file_selector import FileSelector
from gui.file_and_match_config import FileAndMatchConfig
from gui.match_config import MatchConfig
from gui.data_preview import DataPreview
from gui.column_selector import ColumnSelector
from gui.pivot_config import PivotConfig
from gui.export_settings import ExportSettings


class MainWindow:
    """主窗口类"""
    
    def __init__(self, root=None):
        self._embedded = root is not None
        self.root = root if root is not None else tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")
        self.root.minsize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        
        # 初始化核心模块
        self.file_handler = FileHandler()
        self.supp_file_handler = FileHandler()
        self.merge_engine = MergeEngine()
        self.pivot_engine = PivotEngine()
        self.exporter = Exporter()
        
        # 当前状态
        self.current_step = 0
        self.merged_df = None
        self.selected_columns = None
        self.pivot_df = None
        # 保存匹配列配置（固定资产编号，支持多列）
        self.match_columns1 = []  # 改为列表
        self.match_columns2 = []  # 改为列表
        # 保存原值和累计折旧列配置
        self.original_value_col1 = None
        self.original_value_col2 = None
        self.depreciation_col1 = None
        self.depreciation_col2 = None
        # 保存文件显示名称（用于替换列名中的_文件1/_文件2）
        self.file1_display_name = None
        self.file2_display_name = None
        self.balance_sheet_date = "2025/12/31"
        # 保存透视行字段（资产类别），用于汇总表
        self.pivot_row_fields = None
        # 保存字段映射配置
        self.field_mapping_config = None
        # 补充清单（新增/处置）配置状态
        self.use_supplement_lists = False
        self.supplement_config = None
        self.supplement_done = False
        self.unmatched_add_df = None
        self.unmatched_disp_df = None
        self.step_widgets = {}
        
        # 创建界面
        self._create_widgets()
        
        # 绑定关闭事件
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

    def _show_progress_dialog(self, title: str, message: str):
        """显示模态进度提示框（不定进度条），返回窗口对象。"""
        win = tk.Toplevel(self.root)
        win.title(title)
        win.geometry("360x140")
        win.transient(self.root)
        win.grab_set()
        win.resizable(False, False)
        win.protocol("WM_DELETE_WINDOW", lambda: None)  # 禁止关闭

        # 居中显示
        win.update_idletasks()
        x = (win.winfo_screenwidth() // 2) - (win.winfo_width() // 2)
        y = (win.winfo_screenheight() // 2) - (win.winfo_height() // 2)
        win.geometry(f"+{x}+{y}")

        ttk.Label(win, text=message, font=("Arial", 10)).pack(pady=(20, 10))
        bar = ttk.Progressbar(win, maximum=100, length=300, mode="indeterminate")
        bar.pack(pady=(0, 10))
        bar.start(10)
        return win
    
    def _create_widgets(self):
        """创建界面组件"""
        # 主容器
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # 标题
        title_label = ttk.Label(
            main_frame,
            text=APP_NAME,
            font=("Arial", 16, "bold")
        )
        title_label.pack(pady=(0, 20))
        
        # 步骤指示器
        self.steps_frame = ttk.Frame(main_frame)
        self.steps_frame.pack(fill=tk.X, pady=(0, 20))
        
        self.steps = [
            "1. 选择文件并配置",
            "2. 补充清单映射（可选）",
            "3. 选择导出列【大于5万行优先选择CSV格式】"
        ]
        self.step_labels = []
        
        for i, step_text in enumerate(self.steps):
            step_frame = ttk.Frame(self.steps_frame)
            step_frame.pack(side=tk.LEFT, padx=5)
            
            step_label = ttk.Label(
                step_frame,
                text=step_text,
                foreground="gray",
                font=("Arial", 9),
                cursor="hand2"  # 鼠标悬停时显示手型光标
            )
            step_label.pack()
            # 绑定点击事件
            step_label.bind('<Button-1>', lambda e, idx=i: self._on_step_clicked(idx))
            self.step_labels.append(step_label)
            
            # 添加箭头（除了最后一个）
            if i < len(self.steps) - 1:
                arrow_label = ttk.Label(self.steps_frame, text="→", foreground="gray")
                arrow_label.pack(side=tk.LEFT, padx=2)
        
        # 内容区域
        self.content_frame = ttk.Frame(main_frame)
        self.content_frame.pack(fill=tk.BOTH, expand=True)
        
        # 底部行：左侧状态栏 + 右下角「点赞」「建议」链接（用 grid 固定左右列，保证链接始终可见）
        self.status_var = tk.StringVar(value="就绪")
        bottom_row = ttk.Frame(main_frame)
        bottom_row.pack(fill=tk.X, pady=(12, 0))
        bottom_row.columnconfigure(0, weight=1)
        bottom_row.columnconfigure(1, weight=0)
        
        def _open_mailto(subject: str, body: str):
            to = "John.SX.Yan@cn.ey.com;melody.bt.liu@cn.ey.com;april.yl.wang@cn.ey.com"
            url = f"mailto:{to}?subject={quote(subject, safe='')}&body={quote(body, safe='')}"
            try:
                webbrowser.open(url)
            except Exception:
                pass
        
        status_bar = ttk.Label(
            bottom_row,
            textvariable=self.status_var,
            relief=tk.SUNKEN,
            anchor=tk.W,
            padding=5
        )
        status_bar.grid(row=0, column=0, sticky="ew", padx=(0, 12))
        
        links_frame = ttk.Frame(bottom_row)
        links_frame.grid(row=0, column=1, sticky="e", padx=(0, 0))
        
        lbl_like = tk.Label(
            links_frame,
            text="点赞",
            fg="#0066cc",
            cursor="hand2",
            font=("Arial", 9),
        )
        lbl_like.pack(side=tk.LEFT, padx=(0, 14))
        lbl_like.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 点赞反馈", "加油，整体使用体验良好。"))
        
        lbl_suggest = tk.Label(
            links_frame,
            text="建议",
            fg="#0066cc",
            cursor="hand2",
            font=("Arial", 9),
        )
        lbl_suggest.pack(side=tk.LEFT)
        lbl_suggest.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 功能建议", "我的建议如下：[]"))
        
        # 显示第一步
        self.show_step(0)
    
    def show_step(self, step_index: int):
        """显示指定步骤的界面"""
        self.current_step = step_index
        # 各步骤均允许窗口拉伸/最大化，避免第三步无法全屏
        self.root.resizable(True, True)
        
        # 更新步骤指示器
        for i, label in enumerate(self.step_labels):
            if i == step_index:
                label.config(foreground="blue", font=("Arial", 9, "bold"))
            elif i < step_index:
                label.config(foreground="green")
            else:
                label.config(foreground="gray")
        
        # 清除内容区域
        for widget in self.content_frame.winfo_children():
            widget.destroy()
        
        # 显示对应步骤的界面
        if step_index == 0:
            self._show_file_and_match_config()
        elif step_index == 1:
            self._show_supplement_config()
        elif step_index == 2:
            self._show_column_selector()
    
    def _show_file_and_match_config(self):
        """显示文件选择和匹配列配置合并界面"""
        file_and_match_config = FileAndMatchConfig(
            self.content_frame,
            self.file_handler,
            on_complete=self._on_file_and_match_configured,
            status_callback=self.update_status
        )
        file_and_match_config.pack(fill=tk.BOTH, expand=True)

    def _show_supplement_config(self):
        """显示新增/处置清单配置界面（可选步骤）。"""
        supplement_config = FileAndMatchConfig(
            self.content_frame,
            self.supp_file_handler,
            on_complete=self._on_supplement_configured,
            status_callback=self.update_status,
            mode="supplement",
            on_back=lambda: self.show_step(0),
            on_skip=self._skip_supplement_step,
        )
        supplement_config.pack(fill=tk.BOTH, expand=True)
    
    def _show_file_selector(self):
        """显示文件选择界面（保留用于兼容）"""
        file_selector = FileSelector(
            self.content_frame,
            self.file_handler,
            on_complete=self._on_files_selected,
            status_callback=self.update_status
        )
        file_selector.pack(fill=tk.BOTH, expand=True)
    
    def _show_match_config(self):
        """显示匹配列配置界面（保留用于兼容）"""
        if self.file_handler.file1_df is None or self.file_handler.file2_df is None:
            messagebox.showwarning("警告", "请先选择文件")
            self.show_step(0)
            return
        
        match_config = MatchConfig(
            self.content_frame,
            self.file_handler,
            on_complete=self._on_match_configured,
            on_back=lambda: self.show_step(0)
        )
        match_config.pack(fill=tk.BOTH, expand=True)
    
    def _show_data_preview(self):
        """显示数据预览界面"""
        if self.merged_df is None:
            messagebox.showwarning("警告", "请先完成合并操作")
            self.show_step(0)
            return
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="main_window._show_data_preview",
             message="creating DataPreview", data={"merged_rows": len(self.merged_df), "merged_cols": len(self.merged_df.columns), "columns": list(self.merged_df.columns)[:5]})
        # #endregion
        data_preview = DataPreview(
            self.content_frame,
            self.merged_df,
            on_complete=self._on_preview_next,
            on_back=lambda: self.show_step(0)
        )
        data_preview.pack(fill=tk.BOTH, expand=True)
    
    def _show_column_selector(self):
        """显示列选择界面"""
        if self.merged_df is None:
            messagebox.showwarning("警告", "请先完成合并操作")
            self.show_step(0)
            return
        
        column_selector = ColumnSelector(
            self.content_frame,
            self.merged_df,
            on_complete=self._on_columns_selected,
            on_back=lambda: self.show_step(1) if self.use_supplement_lists else self.show_step(0),
            file1_display_name=self.file1_display_name,
            file2_display_name=self.file2_display_name
        )
        column_selector.pack(fill=tk.BOTH, expand=True)
    
    def _show_pivot_config(self):
        """显示数据透视配置界面"""
        if self.merged_df is None:
            messagebox.showwarning("警告", "请先完成合并操作")
            self.show_step(2)
            return
        
        # 获取用户映射的资产类别配置
        fm = self.field_mapping_config or {}
        pivot_config = PivotConfig(
            self.content_frame,
            self.merged_df,
            self.pivot_engine,
            on_complete=self._on_pivot_configured,
            on_back=lambda: self.show_step(2),
            original_value_col1=self.original_value_col1,  # 传递配置的原值列
            original_value_col2=self.original_value_col2,
            depreciation_col1=self.depreciation_col1,
            depreciation_col2=self.depreciation_col2,
            file1_display_name=self.file1_display_name,  # 传递文件显示名称
            file2_display_name=self.file2_display_name,
            category_col1=fm.get('category_col1'),  # 传递用户映射的资产类别配置
            category_col2=fm.get('category_col2')
        )
        pivot_config.pack(fill=tk.BOTH, expand=True)
    
    def _show_export_settings(self):
        """显示导出设置界面（category_col 仅来自映射列，与 _build_summary_config 一致）"""
        export_data = self.merged_df
        if export_data is None:
            messagebox.showwarning("警告", "没有可导出的数据")
            return
        summary_config = self._build_summary_config()

        # 使用用户选择的列进行导出，同时传递数据透视表（如果有）和完整数据（用于原值增加/减少清单）
        export_settings = ExportSettings(
            self.content_frame,
            export_data,
            self.selected_columns,
            self.exporter,
            pivot_df=self.pivot_df,  # 传递数据透视表
            full_df=self.merged_df,  # 传递完整数据（用于原值增加/减少清单，包含所有列）
            on_complete=self._on_export_complete,
            on_back=self._on_export_back,
            file1_display_name=self.file1_display_name,  # 传递文件显示名称
            file2_display_name=self.file2_display_name,
            summary_config=summary_config  # 传递汇总表配置
        )
        export_settings.pack(fill=tk.BOTH, expand=True)
    
    def show_step(self, step_index: int):
        """显示指定步骤页面（回退时保留组件状态）。"""
        self.current_step = step_index
        self.root.resizable(True, True)

        for i, label in enumerate(self.step_labels):
            if i == step_index:
                label.config(foreground="blue", font=("Arial", 9, "bold"))
            elif i < step_index:
                label.config(foreground="green")
            else:
                label.config(foreground="gray")

        for widget in self.content_frame.winfo_children():
            try:
                widget.pack_forget()
            except Exception:
                pass

        if step_index == 0:
            self._show_file_and_match_config()
        elif step_index == 1:
            self._show_supplement_config()
        elif step_index == 2:
            self._show_column_selector()

    def _invalidate_step_widget(self, step_index: int):
        """销毁某个步骤组件，下次进入时重建。"""
        widget = self.step_widgets.pop(step_index, None)
        if widget is not None:
            try:
                widget.destroy()
            except Exception:
                pass

    def _show_file_and_match_config(self):
        """显示文件与匹配配置页面。"""
        widget = self.step_widgets.get(0)
        if widget is None or not widget.winfo_exists():
            widget = FileAndMatchConfig(
                self.content_frame,
                self.file_handler,
                on_complete=self._on_file_and_match_configured,
                status_callback=self.update_status
            )
            self.step_widgets[0] = widget
        widget.pack(fill=tk.BOTH, expand=True)

    def _show_supplement_config(self):
        """显示补充清单映射页面。"""
        widget = self.step_widgets.get(1)
        if widget is None or not widget.winfo_exists():
            widget = FileAndMatchConfig(
                self.content_frame,
                self.supp_file_handler,
                on_complete=self._on_supplement_configured,
                status_callback=self.update_status,
                mode="supplement",
                on_back=lambda: self.show_step(0),
                on_skip=self._skip_supplement_step,
            )
            self.step_widgets[1] = widget
        widget.pack(fill=tk.BOTH, expand=True)

    def _show_column_selector(self):
        """显示导出列选择页面。"""
        if self.merged_df is None:
            messagebox.showwarning("警告", "请先完成合并操作")
            self.show_step(0)
            return

        widget = self.step_widgets.get(2)
        if widget is None or not widget.winfo_exists():
            widget = ColumnSelector(
                self.content_frame,
                self.merged_df,
                on_complete=self._on_columns_selected,
                on_back=lambda: self.show_step(1) if self.use_supplement_lists else self.show_step(0),
                file1_display_name=self.file1_display_name,
                file2_display_name=self.file2_display_name
            )
            self.step_widgets[2] = widget
        widget.pack(fill=tk.BOTH, expand=True)

    def _format_column_name(self, col_name):
        """将列名中的_文件1/_文件2替换为显示名称（与 export_settings 一致）"""
        if col_name is None:
            return col_name
        s = str(col_name)
        if "_文件1" in s:
            return s.replace("_文件1", f"_{self.file1_display_name or '文件1'}")
        if "_文件2" in s:
            return s.replace("_文件2", f"_{self.file2_display_name or '文件2'}")
        return s
    
    def _build_summary_config(self):
        """构建汇总表配置。category_col 仅来自映射的 category_col1/2，不用透视行字段。"""
        _fm = self.field_mapping_config or {}
        mapped_col1 = f"{_fm['category_col1']}_文件1" if _fm.get("category_col1") else None
        mapped_col2 = f"{_fm['category_col2']}_文件2" if _fm.get("category_col2") else None
        category_col = mapped_col1 or mapped_col2
        if not category_col:
            return None
        orig1 = f"{self.original_value_col1}_文件1" if self.original_value_col1 else None
        orig2 = f"{self.original_value_col2}_文件2" if self.original_value_col2 else None
        dep1 = f"{self.depreciation_col1}_文件1" if self.depreciation_col1 else None
        dep2 = f"{self.depreciation_col2}_文件2" if self.depreciation_col2 else None
        # 多列匹配键（带后缀）
        match1 = [f"{col}_文件1" for col in self.match_columns1] if self.match_columns1 else []
        match2 = [f"{col}_文件2" for col in self.match_columns2] if self.match_columns2 else []
        # 向后兼容：如果只有一个匹配列，也提供单列格式
        match1_single = match1[0] if match1 else None
        match2_single = match2[0] if match2 else None
        
        cat1 = f"{_fm['category_col1']}_文件1" if _fm.get("category_col1") else None
        cat2 = f"{_fm['category_col2']}_文件2" if _fm.get("category_col2") else None
        return {
            "category_col": category_col,
            "category_col1": cat1,
            "category_col2": cat2,
            "match_col": match1_single,  # 向后兼容：第一个匹配列
            "match_col2": match2_single,  # 向后兼容：第一个匹配列
            "match_cols": match1,  # 多列格式
            "match_cols2": match2,  # 多列格式
            "original_value_col1": orig1,
            "original_value_col2": orig2,
            "depreciation_col1": dep1,
            "depreciation_col2": dep2,
            "file1_display_name": self.file1_display_name or "期初",
            "file2_display_name": self.file2_display_name or "期末",
            "balance_sheet_date": self.balance_sheet_date or "2025/12/31",
            "field_mapping": self.field_mapping_config,
            "extended_summary_mode": (not self.use_supplement_lists) or bool(self.supplement_config),
            "use_supplement_lists": bool(self.use_supplement_lists),
            "unmatched_add_df": self.unmatched_add_df,
            "unmatched_disp_df": self.unmatched_disp_df,
            "has_unmatched_supplement": bool(
                (self.unmatched_add_df is not None and not self.unmatched_add_df.empty)
                or (self.unmatched_disp_df is not None and not self.unmatched_disp_df.empty)
            ),
            # 导出阶段用于“重复ID组回填”的原始来源数据（保持原列名）
            "source_file1_df": self.file_handler.file1_df if self.file_handler and self.file_handler.file1_df is not None else None,
            "source_file2_df": self.file_handler.file2_df if self.file_handler and self.file_handler.file2_df is not None else None,
            "source_match_cols1_raw": list(self.match_columns1 or []),
            "source_match_cols2_raw": list(self.match_columns2 or []),
            "source_field_mapping_raw": (self.field_mapping_config or {}).copy(),
            "source_original_value_col1_raw": self.original_value_col1,
            "source_original_value_col2_raw": self.original_value_col2,
            "source_depreciation_col1_raw": self.depreciation_col1,
            "source_depreciation_col2_raw": self.depreciation_col2,
            "pivot_export_config": self.pivot_engine.get_pivot_config() if self.pivot_engine else None,
        }
    
    def _run_export_to_path(self, export_path: str, export_format: str, summary_config: dict, progress_window=None):
        """格式化并导出到指定路径（后台线程，完成后弹窗）。"""
        if export_format == "xlsx" and not export_path.lower().endswith(".xlsx"):
            export_path = os.path.splitext(export_path)[0] + ".xlsx"
        elif export_format == "csv" and not export_path.lower().endswith(".csv"):
            export_path = os.path.splitext(export_path)[0] + ".csv"

        def task():
            try:
                df_to_export = self.merged_df.copy()
                full_to_export = self.merged_df.copy() if self.merged_df is not None else None
                pivot_to_export = self.pivot_df.copy() if self.pivot_df is not None else None
                df_to_export.columns = [self._format_column_name(c) for c in df_to_export.columns]
                if full_to_export is not None:
                    full_to_export.columns = [self._format_column_name(c) for c in full_to_export.columns]
                if pivot_to_export is not None and not pivot_to_export.empty:
                    if isinstance(pivot_to_export.columns, pd.MultiIndex):
                        pivot_to_export.columns = pd.MultiIndex.from_tuples([
                            tuple(self._format_column_name(str(x)) for x in t) for t in pivot_to_export.columns
                        ])
                    else:
                        pivot_to_export.columns = [self._format_column_name(c) for c in pivot_to_export.columns]
                    if isinstance(pivot_to_export.index, pd.MultiIndex):
                        pivot_to_export.index.names = [
                            self._format_column_name(str(n)) if n else n for n in pivot_to_export.index.names
                        ]
                    elif pivot_to_export.index.name:
                        pivot_to_export.index.name = self._format_column_name(pivot_to_export.index.name)
                sc = None
                if summary_config:
                    sc = summary_config.copy()
                    # 格式化单列匹配（向后兼容）
                    for k in ("category_col", "match_col", "match_col2", "original_value_col1", "original_value_col2",
                              "depreciation_col1", "depreciation_col2"):
                        if sc.get(k):
                            sc[k] = self._format_column_name(sc[k])
                    # 格式化多列匹配
                    if sc.get("match_cols"):
                        sc["match_cols"] = [self._format_column_name(col) for col in sc["match_cols"]]
                    if sc.get("match_cols2"):
                        sc["match_cols2"] = [self._format_column_name(col) for col in sc["match_cols2"]]
                    fm_raw = sc.get("field_mapping") or {}
                    fm_fmt = {}
                    for k, v in fm_raw.items():
                        if not v:
                            fm_fmt[k] = None
                        elif k.endswith("_col1"):
                            fm_fmt[k] = self._format_column_name(f"{v}_文件1")
                        elif k.endswith("_col2"):
                            fm_fmt[k] = self._format_column_name(f"{v}_文件2")
                        else:
                            fm_fmt[k] = v
                    sc["field_mapping"] = fm_fmt
                    sc["category_col1"] = fm_fmt.get("category_col1")
                    sc["category_col2"] = fm_fmt.get("category_col2")
                    # 透视配置字段名同步格式化，确保可在导出端基于“增强后的合并数据”重算透视表
                    pc = sc.get("pivot_export_config") or {}
                    if isinstance(pc, dict):
                        pc_fmt = dict(pc)
                        for k in ("index", "columns", "values"):
                            vals = pc_fmt.get(k)
                            if isinstance(vals, list):
                                pc_fmt[k] = [self._format_column_name(v) for v in vals if v]
                        sc["pivot_export_config"] = pc_fmt
                sel = [self._format_column_name(c) for c in self.selected_columns] if self.selected_columns else None
                ok, err = self.exporter.export_dataframe(
                    df_to_export, export_path, sel, export_format,
                    pivot_df=pivot_to_export, full_df=full_to_export, summary_config=sc
                )

                def _finish():
                    try:
                        if progress_window is not None and progress_window.winfo_exists():
                            progress_window.destroy()
                    except Exception:
                        pass
                    self._on_direct_export_complete(ok, err)

                self.root.after(0, _finish)
            except Exception as e:
                def _fail():
                    try:
                        if progress_window is not None and progress_window.winfo_exists():
                            progress_window.destroy()
                    except Exception:
                        pass
                    self._on_direct_export_complete(False, str(e))

                self.root.after(0, _fail)
        threading.Thread(target=task, daemon=True).start()
    
    def _on_direct_export_complete(self, success: bool, error_msg: str):
        """直接导出完成：更新状态并弹窗。检查是否有纠偏警告需要单独提示。"""
        if success:
            self.update_status("导出完成")
            
            # 解析纠偏警告（如果有）
            correction_warnings = []
            if "===CORRECTION_WARNINGS===" in error_msg:
                parts = error_msg.split("===CORRECTION_WARNINGS===")
                error_msg = parts[0].strip()
                if len(parts) > 1:
                    warnings_text = parts[1].strip()
                    for line in warnings_text.split('\n'):
                        line = line.strip()
                        if line:
                            correction_warnings.append(line)
            
            # 先显示导出成功消息
            messagebox.showinfo("导出完成", "文件已成功导出！")
            
            # 如果有纠偏警告，分别显示弹窗
            for warning in correction_warnings:
                if "【残值率纠偏】" in warning:
                    messagebox.showwarning(
                        "残值率纠偏提示",
                        f"{warning}\n\n请确认导出的FA List和新增清单_BKD中的残值率是否正确。"
                    )
                elif "【使用寿命纠偏】" in warning:
                    messagebox.showwarning(
                        "使用寿命纠偏提示",
                        f"{warning}\n\n请确认导出的FA List和新增清单_BKD中的使用寿命(月)是否正确。"
                    )
                elif "【未匹配资产变动清单】" in warning:
                    messagebox.showwarning(
                        "未匹配资产变动清单提示",
                        warning
                    )
                elif "【导出提速】" in warning:
                    messagebox.showwarning(
                        "折旧测算公式填充提示",
                        warning
                    )
                else:
                    messagebox.showwarning(
                        "导出提示",
                        warning
                    )
        else:
            self.update_status("导出失败")
            messagebox.showerror("导出失败", error_msg)
    
    def _on_preview_next(self):
        """预览界面点击「下一步：选择导出列」后的回调（已删除预览步骤，不再使用）"""
        pass

    def _skip_supplement_step(self):
        """跳过补充清单步骤。"""
        self.use_supplement_lists = False
        self.supplement_config = None
        self.supplement_done = True
        self.unmatched_add_df = None
        self.unmatched_disp_df = None
        self.update_status("已跳过补充清单映射")
        self.show_step(2)

    @staticmethod
    def _normalize_key_series(series: pd.Series) -> pd.Series:
        """将匹配键标准化为可用于映射的字符串。"""
        if series is None:
            return pd.Series(dtype=str)
        import re

        def normalize_one(v):
            if v is None or pd.isna(v):
                return ""
            s = str(v)
            # 去除常见空白字符（含全角空格）并统一大小写
            s = s.replace("\u3000", " ").strip()
            s = re.sub(r"\s+", "", s).upper()
            if not s:
                return ""
            # 兼容Excel/CSV常见数值化ID：1500000.0 -> 1500000
            if re.fullmatch(r"[+-]?\d+\.0+", s):
                s = s.split(".", 1)[0]
            # 兼容科学计数法且结果为整数：1.5E+06 -> 1500000
            if re.fullmatch(r"[+-]?\d+(\.\d+)?E[+-]?\d+", s):
                try:
                    num = float(s)
                    if num.is_integer():
                        s = str(int(num))
                except Exception:
                    pass
            return s

        return series.apply(normalize_one)

    def _find_main_key_column(self, base_col: str, suffix: str) -> str:
        """在合并数据中按基础列名+后缀定位实际列名（兼容重名后缀）。"""
        if not base_col or self.merged_df is None:
            return None
        target = f"{base_col}{suffix}"
        if target in self.merged_df.columns:
            return target
        for col in self.merged_df.columns:
            col_str = str(col)
            if col_str == target or col_str.startswith(target + "_"):
                return col
        return None

    def _find_main_key_columns(self, base_cols, suffix: str):
        """按基础列名列表定位合并数据中的实际列名列表（去重且保持顺序）。"""
        if not base_cols:
            return []
        if isinstance(base_cols, str):
            base_cols = [base_cols]
        actual_cols = []
        seen = set()
        for base_col in base_cols:
            actual = self._find_main_key_column(base_col, suffix)
            if actual and actual not in seen:
                seen.add(actual)
                actual_cols.append(actual)
        return actual_cols

    def _build_composite_key_series(self, df: pd.DataFrame, columns):
        """将多列键标准化并拼接为组合键；若所有键列均为空则返回空字符串。"""
        if df is None or df.empty:
            return pd.Series(dtype=str)
        if not columns:
            return pd.Series([""] * len(df), index=df.index)
        if isinstance(columns, str):
            columns = [columns]
        valid_cols = [c for c in columns if c in df.columns]
        if not valid_cols:
            return pd.Series([""] * len(df), index=df.index)

        parts = [self._normalize_key_series(df[c]) for c in valid_cols]
        all_empty = pd.Series(True, index=df.index)
        for p in parts:
            all_empty &= (p == "")

        key = parts[0].astype(str)
        for p in parts[1:]:
            key = key + "||" + p.astype(str)
        key = key.where(~all_empty, "")
        return key

    def _apply_supplement_data(self, config: dict):
        """将新增/处置清单信息按唯一识别码回填到合并数据。"""
        if self.merged_df is None or self.merged_df.empty:
            return

        def _merge_text_values(values: pd.Series) -> str:
            merged_vals = []
            seen = set()
            for v in values:
                if v is None or pd.isna(v):
                    continue
                s = str(v).strip()
                if not s:
                    continue
                if s not in seen:
                    seen.add(s)
                    merged_vals.append(s)
            if not merged_vals:
                return ""
            return merged_vals[0] if len(merged_vals) == 1 else "；".join(merged_vals)

        def _sum_numeric_values(values: pd.Series):
            nums = pd.to_numeric(values, errors="coerce")
            if nums.notna().any():
                return float(nums.fillna(0).sum())
            return ""

        def _sum_numeric_abs_values(values: pd.Series):
            """金额归一为绝对值后求和，避免用户上传正负方向不一致导致对冲。"""
            nums = pd.to_numeric(values, errors="coerce")
            if nums.notna().any():
                return float(nums.fillna(0).abs().sum())
            return ""

        main_key_cols1 = self._find_main_key_columns(self.match_columns1, "_文件1")
        main_key_cols2 = self._find_main_key_columns(self.match_columns2, "_文件2")
        if not main_key_cols1 and not main_key_cols2:
            return

        merged = self.merged_df.copy()
        key1 = self._build_composite_key_series(merged, main_key_cols1)
        key2 = self._build_composite_key_series(merged, main_key_cols2)
        main_key = key1.where(key1 != "", key2)
        valid_main_keys = set(main_key[main_key != ""].astype(str).tolist())

        add_df = self.supp_file_handler.file1_df
        disp_df = self.supp_file_handler.file2_df
        self.unmatched_add_df = None
        self.unmatched_disp_df = None

        # 新增清单映射：唯一识别码 -> 新增方式（以及可选新增时间）
        add_keys = config.get("match_column1") or []
        if isinstance(add_keys, str):
            add_keys = [add_keys]
        add_key_cols = [c for c in add_keys if c in (add_df.columns if add_df is not None else [])]
        add_method_col = config.get("addition_method_col1")
        add_date_col = config.get("addition_date_col1")
        if add_df is not None and add_key_cols:
            add_work = add_df.copy()
            add_work["__k__"] = self._build_composite_key_series(add_work, add_key_cols)
            add_work = add_work[add_work["__k__"] != ""]
            unmatched_add = add_work[~add_work["__k__"].isin(valid_main_keys)].copy()
            if not unmatched_add.empty:
                self.unmatched_add_df = unmatched_add.drop(columns=["__k__"], errors="ignore")
            if not add_work.empty:
                add_agg_rules = {}
                if add_method_col and add_method_col in add_work.columns:
                    add_agg_rules[add_method_col] = _merge_text_values
                if add_date_col and add_date_col in add_work.columns:
                    add_agg_rules[add_date_col] = _merge_text_values
                add_agg = add_work.groupby("__k__", sort=False).agg(add_agg_rules) if add_agg_rules else pd.DataFrame()
                if add_method_col and add_method_col in add_agg.columns:
                    merged["新增方式_辅助_文件2"] = main_key.map(add_agg[add_method_col])
                    self.field_mapping_config["addition_method_col2"] = "新增方式_辅助"
                if add_date_col and add_date_col in add_agg.columns:
                    merged["新增时间_辅助_文件2"] = main_key.map(add_agg[add_date_col])
                    self.field_mapping_config["addition_date_col2"] = "新增时间_辅助"
        elif add_df is not None and not add_df.empty:
            self.unmatched_add_df = add_df.copy()

        # 处置清单映射：唯一识别码 -> 处置方式/处置时间/处置原值/处置折旧
        disp_keys = config.get("match_column2") or []
        if isinstance(disp_keys, str):
            disp_keys = [disp_keys]
        disp_key_cols = [c for c in disp_keys if c in (disp_df.columns if disp_df is not None else [])]
        disp_method_col = config.get("disposal_method_col2")
        disp_date_col = config.get("disposal_date_col2")
        disp_orig_col = config.get("disposal_orig_col2")
        disp_dep_col = config.get("disposal_dep_col2")
        if disp_df is not None and disp_key_cols:
            disp_work = disp_df.copy()
            disp_work["__k__"] = self._build_composite_key_series(disp_work, disp_key_cols)
            disp_work = disp_work[disp_work["__k__"] != ""]
            unmatched_disp = disp_work[~disp_work["__k__"].isin(valid_main_keys)].copy()
            if not unmatched_disp.empty:
                self.unmatched_disp_df = unmatched_disp.drop(columns=["__k__"], errors="ignore")
            if not disp_work.empty:
                disp_agg_rules = {}
                if disp_method_col and disp_method_col in disp_work.columns:
                    disp_agg_rules[disp_method_col] = _merge_text_values
                if disp_date_col and disp_date_col in disp_work.columns:
                    disp_agg_rules[disp_date_col] = _merge_text_values
                if disp_orig_col and disp_orig_col in disp_work.columns:
                    disp_agg_rules[disp_orig_col] = _sum_numeric_abs_values
                if disp_dep_col and disp_dep_col in disp_work.columns:
                    disp_agg_rules[disp_dep_col] = _sum_numeric_abs_values

                disp_agg = disp_work.groupby("__k__", sort=False).agg(disp_agg_rules) if disp_agg_rules else pd.DataFrame()
                if disp_method_col and disp_method_col in disp_agg.columns:
                    merged["处置方式_辅助_文件1"] = main_key.map(disp_agg[disp_method_col])
                    self.field_mapping_config["disposal_method_col1"] = "处置方式_辅助"
                if disp_date_col and disp_date_col in disp_agg.columns:
                    merged["处置时间_辅助_文件1"] = main_key.map(disp_agg[disp_date_col])
                    self.field_mapping_config["disposal_date_col1"] = "处置时间_辅助"
                if disp_orig_col and disp_orig_col in disp_agg.columns:
                    merged["处置原值_辅助_文件1"] = main_key.map(disp_agg[disp_orig_col])
                    self.field_mapping_config["disposal_orig_col1"] = "处置原值_辅助"
                if disp_dep_col and disp_dep_col in disp_agg.columns:
                    merged["处置折旧_辅助_文件1"] = main_key.map(disp_agg[disp_dep_col])
                    self.field_mapping_config["disposal_dep_col1"] = "处置折旧_辅助"
        elif disp_df is not None and not disp_df.empty:
            self.unmatched_disp_df = disp_df.copy()

        self.merged_df = merged

    def _on_supplement_configured(self, config):
        """补充清单配置完成回调。"""
        self.use_supplement_lists = True
        self.supplement_config = config
        self.supplement_done = True
        self._apply_supplement_data(config)
        self._invalidate_step_widget(2)
        self.update_status("补充清单映射已完成")
        self.show_step(2)
    
    def _on_file_and_match_configured(self, config):
        """文件选择和匹配列配置完成回调"""
        # 每次重新执行第一步后，重置补充清单状态
        self.use_supplement_lists = False
        self.supplement_config = None
        self.supplement_done = False
        self.supp_file_handler.clear()
        self.unmatched_add_df = None
        self.unmatched_disp_df = None
        self.selected_columns = None
        self.pivot_df = None
        self._invalidate_step_widget(1)
        self._invalidate_step_widget(2)

        # 保存匹配列配置（固定资产编号，支持多列）
        match_cols1 = config.get('match_column1', [])
        match_cols2 = config.get('match_column2', [])
        # 确保是列表格式（向后兼容）
        if isinstance(match_cols1, str):
            match_cols1 = [match_cols1]
        if isinstance(match_cols2, str):
            match_cols2 = [match_cols2]
        self.match_columns1 = match_cols1
        self.match_columns2 = match_cols2
        # 保存原值和累计折旧列配置
        self.original_value_col1 = config.get('original_value_col1')
        self.original_value_col2 = config.get('original_value_col2')
        self.depreciation_col1 = config.get('depreciation_col1')
        self.depreciation_col2 = config.get('depreciation_col2')
        # 保存文件显示名称
        self.file1_display_name = config.get('file1_display_name')
        self.file2_display_name = config.get('file2_display_name')
        self.balance_sheet_date = config.get('balance_sheet_date') or "2025/12/31"
        # 保存完整的字段映射配置
        self.field_mapping_config = {
            'category_col1': config.get('category_col1'),
            'category_col2': config.get('category_col2'),
            'name_col1': config.get('name_col1'),
            'name_col2': config.get('name_col2'),
            'date_col1': config.get('date_col1'),
            'date_col2': config.get('date_col2'),
            'life_col1': config.get('life_col1'),
            'life_col2': config.get('life_col2'),
            'residual_col1': config.get('residual_col1'),
            'residual_col2': config.get('residual_col2'),
            'current_year_dep_col1': config.get('current_year_dep_col1'),
            'current_year_dep_col2': config.get('current_year_dep_col2'),
            'addition_method_col1': config.get('addition_method_col1'),
            'addition_method_col2': config.get('addition_method_col2'),
            'addition_date_col1': config.get('addition_date_col1'),
            'addition_date_col2': config.get('addition_date_col2'),
            'disposal_method_col1': config.get('disposal_method_col1'),
            'disposal_method_col2': config.get('disposal_method_col2'),
            'disposal_date_col1': config.get('disposal_date_col1'),
            'disposal_date_col2': config.get('disposal_date_col2'),
            'disposal_orig_col1': config.get('disposal_orig_col1'),
            'disposal_orig_col2': config.get('disposal_orig_col2'),
            'disposal_dep_col1': config.get('disposal_dep_col1'),
            'disposal_dep_col2': config.get('disposal_dep_col2'),
        }
        
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.root)
        progress_window.title("处理中")
        progress_window.geometry("300x120")
        progress_window.transient(self.root)
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        ttk.Label(progress_window, text="正在执行合并，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        self.update_status("正在执行合并，请稍候...")
        
        # 在后台线程中执行合并
        def merge_task():
            try:
                # 更新状态提示
                self.root.after(0, lambda: self.update_status("正在预处理数据，请稍候..."))
                
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="main_window.merge_task.entry", message="merge task started", data={"df1_shape": [len(self.file_handler.file1_df), len(self.file_handler.file1_df.columns)] if self.file_handler.file1_df is not None else None, "df2_shape": [len(self.file_handler.file2_df), len(self.file_handler.file2_df.columns)] if self.file_handler.file2_df is not None else None})
                # #endregion
                
                # 获取匹配列（确保是列表格式）
                match_cols1 = config.get('match_column1', [])
                match_cols2 = config.get('match_column2', [])
                if isinstance(match_cols1, str):
                    match_cols1 = [match_cols1]
                if isinstance(match_cols2, str):
                    match_cols2 = [match_cols2]
                
                success, message, merged_df = self.merge_engine.perform_full_outer_join(
                    self.file_handler.file1_df,
                    self.file_handler.file2_df,
                    match_cols1,
                    match_cols2,
                    config.get('data_type1', 'auto'),
                    config.get('data_type2', 'auto'),
                    config.get('remove_spaces', False),
                    config.get('case_sensitive', True),
                    config.get('handle_duplicates', 'pivot'),
                    config.get('original_value_col1'),
                    config.get('original_value_col2'),
                    config.get('depreciation_col1'),
                    config.get('depreciation_col2'),
                    config.get('residual_col2')
                )
                
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="main_window.merge_task.complete", message="merge task completed", data={"success": success, "merged_shape": [len(merged_df), len(merged_df.columns)] if merged_df is not None and not merged_df.empty else None})
                # #endregion
                
                # 替换合并结果中的"仅文件1"和"仅文件2"为文件显示名称
                if success and merged_df is not None and '数据来源' in merged_df.columns:
                    file1_display = self.file1_display_name or "文件1"
                    file2_display = self.file2_display_name or "文件2"
                    merged_df['数据来源'] = merged_df['数据来源'].replace({
                        '仅文件1': f'仅{file1_display}',
                        '仅文件2': f'仅{file2_display}',
                        '两文件都有': '两文件都有'
                    })
                    # 替换消息中的文本
                    message = message.replace('仅文件1', f'仅{file1_display}').replace('仅文件2', f'仅{file2_display}').replace('文件1', file1_display)
                
                # 关闭进度窗口
                self.root.after(0, lambda: progress_window.destroy())
                self.root.after(0, lambda: self._on_merge_complete(success, message, merged_df))
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="main_window.merge_task.error", message="merge task error", data={"error": str(e)})
                # #endregion
                # 关闭进度窗口
                self.root.after(0, lambda: progress_window.destroy())
                self.root.after(0, lambda e=e: self._on_merge_complete(False, f"合并过程中发生错误: {str(e)}", None))
        
        threading.Thread(target=merge_task, daemon=True).start()
    
    def _on_files_selected(self):
        """文件选择完成回调（保留用于兼容）"""
        self.update_status("文件已选择，请配置匹配列")
        # 不再使用，已合并到_file_and_match_configured
    
    def _on_match_configured(self, config):
        """匹配列配置完成回调（保留用于兼容）"""
        # 已合并到_file_and_match_configured，这里保留用于向后兼容
        self._on_file_and_match_configured(config)
    
    def _on_merge_complete(self, success: bool, message: str, merged_df):
        """合并完成回调"""
        # #region agent log
        sh = [len(merged_df), len(merged_df.columns)] if merged_df is not None and not merged_df.empty else None
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="main_window._on_merge_complete",
             message="merge complete", data={"success": success, "merged_shape": sh})
        # #endregion
        if success:
            self.merged_df = merged_df
            self.update_status(message)
            
            # 不再显示"合并完成"消息框，只在状态栏显示消息
            # 检查是否有重复值警告（仅记录日志，不显示弹窗）
            duplicate_info = self.merge_engine.get_duplicate_info()
            if duplicate_info and duplicate_info.get('has_duplicates'):
                file1_display = self.file1_display_name or "文件1"
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="main_window.duplicate_warning",
                     message="duplicate warning", data={"file1_display": file1_display, "message": message})
                # #endregion
                # 只在状态栏显示警告信息，不显示弹窗
                self.update_status(f"{message}（注意：{file1_display}的匹配列存在重复值，已按数据透视逻辑处理）")
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="main_window.before_show_step_1",
                 message="before show_step(1)", data={})
            # #endregion
            has_supplement = messagebox.askyesno(
                "补充清单确认",
                "是否有新增清单和处置清单需要映射？\n\n"
                "选择“是”：进入补充清单映射界面。\n"
                "选择“否”：直接进入选择导出列。"
            )
            if has_supplement:
                self.use_supplement_lists = True
                self.supplement_done = False
                self.update_status("请继续配置新增清单和处置清单")
                self.show_step(1)
            else:
                self.use_supplement_lists = False
                self.supplement_done = True
                self.update_status("已跳过补充清单映射")
                self.show_step(2)
        else:
            messagebox.showerror("合并失败", message)
            self.update_status("合并失败")
    
    def _on_columns_selected(self, selected_columns):
        """列选择完成回调：直接弹出保存路径，选路径后导出（不跳转界面）"""
        self.selected_columns = selected_columns
        self.update_status(f"已选择 {len(selected_columns)} 列")
        self._auto_create_pivot_table()
        summary_config = self._build_summary_config()
        path = filedialog.asksaveasfilename(
            title="选择导出路径",
            defaultextension=".xlsx",
            filetypes=[("Excel文件", "*.xlsx"), ("CSV文件", "*.csv"), ("所有文件", "*.*")]
        )
        if path:
            if path.lower().endswith(".xlsx"):
                fmt = "xlsx"
            elif path.lower().endswith(".csv"):
                fmt = "csv"
            else:
                fmt = "xlsx"
                path = os.path.splitext(path)[0] + ".xlsx"
            self.update_status("正在导出...")
            progress_win = self._show_progress_dialog("导出中", "正在导出数据，请稍候...")
            self._run_export_to_path(path, fmt, summary_config, progress_window=progress_win)
    
    def _auto_create_pivot_table(self):
        """自动创建数据透视表（优先使用用户映射的资产类别字段，否则自动查找）"""
        if self.merged_df is None or self.merged_df.empty:
            self.pivot_df = None
            self.pivot_row_fields = None
            return
        
        cols = list(self.merged_df.columns)
        file1_cols = [c for c in cols if str(c).endswith("_文件1")]
        file2_cols = [c for c in cols if str(c).endswith("_文件2")]

        def _base(col_str):
            for suf in ("_文件1_2", "_文件1_3", "_文件1_4", "_文件2_2", "_文件2_3", "_文件2_4"):
                if col_str.endswith(suf):
                    return col_str.rsplit("_文件1" if "_文件1" in suf else "_文件2", 1)[0]
            if col_str.endswith("_文件1") or col_str.endswith("_文件2"):
                return col_str[:-4]
            return col_str

        def _is_numeric(col_str):
            for kw in ("原值", "累计折旧", "成本", "净值", "残值", "减值", "折旧", "金额", "价值"):
                if kw in col_str:
                    return True
            return False

        def _find_row_field(file_cols):
            for c in file_cols:
                s = str(c)
                if _is_numeric(s):
                    continue
                if _base(s) in ("资产大类", "资产类别"):
                    return c
            for c in file_cols:
                s = str(c)
                if _is_numeric(s):
                    continue
                if "资产大类" in s or "资产类别" in s:
                    return c
            for c in file_cols:
                s = str(c)
                if _is_numeric(s):
                    continue
                if "类别" in s or "种类" in s or "大类" in s:
                    return c
            return None

        def _find_mapped_col_in_df(base_col, suffix):
            """在DataFrame中查找用户映射的列（处理可能的重命名后缀）"""
            if not base_col:
                return None
            target = f"{base_col}{suffix}"
            # 精确匹配
            if target in cols:
                return target
            # 处理重命名后缀（如 _文件1_2, _文件1_3 等）
            for c in cols:
                if str(c).startswith(target) and (str(c) == target or str(c).startswith(target + "_")):
                    return c
            return None

        row_fields = []
        
        # 优先使用用户映射的资产类别字段（来自 field_mapping_config）
        fm = self.field_mapping_config or {}
        mapped_cat1 = fm.get('category_col1')
        mapped_cat2 = fm.get('category_col2')
        
        # 文件1：优先用户映射，其次自动查找
        r1 = None
        if mapped_cat1:
            r1 = _find_mapped_col_in_df(mapped_cat1, "_文件1")
        if not r1:
            r1 = _find_row_field(file1_cols)
        if r1 and r1 not in row_fields:
            row_fields.append(r1)
        
        # 文件2：优先用户映射，其次自动查找
        r2 = None
        if mapped_cat2:
            r2 = _find_mapped_col_in_df(mapped_cat2, "_文件2")
        if not r2:
            r2 = _find_row_field(file2_cols)
        if r2 and r2 not in row_fields:
            row_fields.append(r2)

        value_fields = []
        for base, suf in [
            (self.original_value_col1, "_文件1"),
            (self.original_value_col2, "_文件2"),
            (self.depreciation_col1, "_文件1"),
            (self.depreciation_col2, "_文件2"),
        ]:
            if not base:
                continue
            name = f"{base}{suf}"
            if name in cols:
                value_fields.append(name)
            else:
                for c in cols:
                    if str(c).startswith(name) and (str(c) == name or str(c).startswith(name + "_")):
                        value_fields.append(c)
                        break

        if not row_fields:
            self.pivot_df = None
            self.pivot_row_fields = None
            return

        success, error_msg, pivot_df = self.pivot_engine.create_pivot_table(
            self.merged_df,
            index=row_fields,
            columns=None,
            values=value_fields if value_fields else None,
            aggfunc="sum"
        )

        if success and pivot_df is not None:
            self.pivot_df = pivot_df
            self.pivot_row_fields = row_fields
            self.update_status("数据透视表已自动创建")
        else:
            self.pivot_df = None
            self.pivot_row_fields = None
            self.update_status("数据透视表创建失败，将跳过")
    
    def _on_pivot_configured(self, pivot_result):
        """数据透视配置完成回调"""
        # pivot_result 是字典格式，包含 pivot_df 和 row_fields
        if isinstance(pivot_result, dict):
            pivot_df = pivot_result.get('pivot_df')
            row_fields = pivot_result.get('row_fields')
        else:
            # 兼容旧格式
            pivot_df = pivot_result
            row_fields = None
        
        if pivot_df is not None:
            self.pivot_df = pivot_df
            self.pivot_row_fields = row_fields
            self.update_status("数据透视表已创建")
        else:
            self.pivot_row_fields = None
            self.update_status("已跳过数据透视表")
        self.show_step(2)  # 跳转到导出步骤
    
    def _on_step_clicked(self, step_index: int):
        """步骤点击事件处理"""
        # 检查是否可以跳转到目标步骤
        if not self._can_jump_to_step(step_index):
            messagebox.showwarning("警告", "请先完成前置步骤")
            return
        
        # 跳转到目标步骤
        self.show_step(step_index)
    
    def _can_jump_to_step(self, target_step: int) -> bool:
        """检查是否可以跳转到目标步骤"""
        if target_step == 0:
            return True  # 总是可以回到第一步
        elif target_step == 1:
            return self.merged_df is not None  # 补充清单步骤
        elif target_step == 2:
            return self.merged_df is not None and self.supplement_done  # 选择导出列
        return False
    
    def _on_export_back(self):
        """导出界面上一步：返回选择导出列"""
        self._column_selection_done = False
        self.show_step(2)
    
    def _on_export_complete(self):
        """导出完成回调"""
        messagebox.showinfo("导出完成", "文件已成功导出！")
        self.update_status("导出完成")
    
    def update_status(self, message: str):
        """更新状态栏"""
        self.status_var.set(message)
        self.root.update_idletasks()
    
    def on_closing(self):
        """关闭窗口事件"""
        prompt = ("关闭", "确定要关闭此工具吗？") if self._embedded else ("退出", "确定要退出吗？")
        if messagebox.askokcancel(prompt[0], prompt[1]):
            self.root.destroy()
    
    def run(self):
        """运行应用"""
        if self._embedded:
            self.root.wait_window()
        else:
            self.root.mainloop()
