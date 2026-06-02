"""
数据透视表配置界面
"""
import tkinter as tk
from tkinter import ttk, messagebox
import pandas as pd
import re
from pivot_engine import PivotEngine


class PivotConfig(ttk.Frame):
    """数据透视表配置组件"""
    
    def __init__(self, parent, df: pd.DataFrame, pivot_engine: PivotEngine, on_complete=None, on_back=None, 
                 original_value_col1=None, original_value_col2=None, depreciation_col1=None, depreciation_col2=None,
                 file1_display_name=None, file2_display_name=None,
                 category_col1=None, category_col2=None):
        super().__init__(parent, padding="10")
        self.df = df
        self.pivot_engine = pivot_engine
        self.on_complete = on_complete
        self.on_back = on_back
        # 保存配置的原值和累计折旧列（带_文件1/_文件2后缀）
        self.original_value_col1 = original_value_col1
        self.original_value_col2 = original_value_col2
        self.depreciation_col1 = depreciation_col1
        self.depreciation_col2 = depreciation_col2
        # 保存用户映射的资产类别列（不带后缀，需要加上_文件1/_文件2）
        self.category_col1 = category_col1
        self.category_col2 = category_col2
        # 保存文件显示名称（用于替换列名中的_文件1/_文件2）
        self.file1_display_name = file1_display_name or "原始文件1"
        self.file2_display_name = file2_display_name or "原始文件2"
        
        self.row_fields = []
        self.column_fields = []
        self.value_fields = []
        self.aggfunc = 'sum'
        
        self._create_widgets()
        self._auto_map_fields()  # 自动预映射字段
    
    def _auto_map_fields(self):
        """自动预映射字段：优先使用用户映射的资产类别字段，否则自动查找；原值/累计折旧直接使用配置的列"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="pivot_config._auto_map_fields.display_names", 
             message="file display names", data={"file1_display_name": self.file1_display_name, "file2_display_name": self.file2_display_name,
                                                  "category_col1": self.category_col1, "category_col2": self.category_col2})
        # #endregion
        
        if self.df is None or self.df.empty:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="pivot_config._auto_map_fields.entry", message="df is None or empty", data={"df_is_none": self.df is None, "df_empty": self.df.empty if self.df is not None else None})
            # #endregion
            return
        
        columns = list(self.df.columns)
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="pivot_config._auto_map_fields.columns", message="all columns", data={"total_cols": len(columns), "sample_cols": [str(c) for c in columns[:20]]})
        # #endregion
        
        # 1. 预映射行字段：每个文件仅匹配一个标题
        # 优先级：用户映射 > 资产大类 > 资产类别 > 类别/种类/大类
        # 注意：合并后的DataFrame中，列名会带_文件1或_文件2后缀
        file1_row_field = None
        file2_row_field = None
        
        # 分离文件1和文件2的列
        # 注意：列名可能同时包含_文件1和_文件2（如"资产大类_文件2_文件1"），
        # 应该以列名结尾来判断属于哪个文件
        file1_cols = [col for col in columns if str(col).endswith('_文件1')]
        file2_cols = [col for col in columns if str(col).endswith('_文件2')]
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="pivot_config._auto_map_fields.separated", message="separated columns", data={"file1_cols_count": len(file1_cols), "file2_cols_count": len(file2_cols), "file1_sample": [str(c) for c in file1_cols[:5]], "file2_sample": [str(c) for c in file2_cols[:5]]})
        # #endregion
        
        def is_numeric_field(col_str):
            """判断是否是数值字段"""
            numeric_keywords = ['原值', '累计折旧', '成本', '净值', '残值', '减值', '折旧', '金额', '价值']
            for keyword in numeric_keywords:
                if keyword in col_str:
                    return True
            return False
        
        def get_base_column_name(col_str):
            """获取基础列名（移除_文件1或_文件2后缀）"""
            if col_str.endswith('_文件1_2') or col_str.endswith('_文件1_3') or col_str.endswith('_文件1_4'):
                return col_str.rsplit('_文件1', 1)[0]
            elif col_str.endswith('_文件2_2') or col_str.endswith('_文件2_3') or col_str.endswith('_文件2_4'):
                return col_str.rsplit('_文件2', 1)[0]
            elif col_str.endswith('_文件1'):
                return col_str[:-4]
            elif col_str.endswith('_文件2'):
                return col_str[:-4]
            return col_str
        
        def find_mapped_col_in_df(base_col, suffix):
            """在DataFrame中查找用户映射的列（处理可能的重命名后缀）"""
            if not base_col:
                return None
            target = f"{base_col}{suffix}"
            # 精确匹配
            if target in columns:
                return target
            # 处理重命名后缀（如 _文件1_2, _文件1_3 等）
            for c in columns:
                if str(c).startswith(target) and (str(c) == target or str(c).startswith(target + "_")):
                    return c
            return None
        
        def auto_find_row_field(file_cols):
            """自动查找行字段（关键词匹配）"""
            # 第一步：精确匹配"资产大类"或"资产类别"
            for col in file_cols:
                col_str = str(col)
                base_name = get_base_column_name(col_str)
                if is_numeric_field(col_str):
                    continue
                if base_name == '资产大类' or base_name == '资产类别':
                    return col
            # 第二步：包含匹配"资产大类"或"资产类别"
            for col in file_cols:
                col_str = str(col)
                if is_numeric_field(col_str):
                    continue
                if '资产大类' in col_str or '资产类别' in col_str:
                    return col
            # 第三步：包含匹配"类别"、"种类"、"大类"
            for col in file_cols:
                col_str = str(col)
                if is_numeric_field(col_str):
                    continue
                if '类别' in col_str or '种类' in col_str or '大类' in col_str:
                    return col
            return None
        
        # 文件1：优先使用用户映射，其次自动查找
        if self.category_col1:
            file1_row_field = find_mapped_col_in_df(self.category_col1, "_文件1")
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="pivot_config._auto_map_fields.file1_mapped", 
                 message="file1 use mapped category", data={"category_col1": self.category_col1, "found": file1_row_field})
            # #endregion
        if not file1_row_field:
            file1_row_field = auto_find_row_field(file1_cols)
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="pivot_config._auto_map_fields.file1_auto", 
                 message="file1 auto find", data={"found": str(file1_row_field) if file1_row_field else None})
            # #endregion
        
        # 文件2：优先使用用户映射，其次自动查找
        if self.category_col2:
            file2_row_field = find_mapped_col_in_df(self.category_col2, "_文件2")
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="pivot_config._auto_map_fields.file2_mapped", 
                 message="file2 use mapped category", data={"category_col2": self.category_col2, "found": file2_row_field})
            # #endregion
        if not file2_row_field:
            file2_row_field = auto_find_row_field(file2_cols)
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="pivot_config._auto_map_fields.file2_auto", 
                 message="file2 auto find", data={"found": str(file2_row_field) if file2_row_field else None})
            # #endregion
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="pivot_config._auto_map_fields.before_add", message="row fields found", data={"file1_row_field": str(file1_row_field) if file1_row_field else None, "file2_row_field": str(file2_row_field) if file2_row_field else None})
        # #endregion
        
        # 添加到行字段（每个文件最多一个）
        if file1_row_field and file1_row_field not in self.row_fields:
            self.row_fields.append(file1_row_field)
            # 显示格式化后的名称
            display_name = self._format_column_name(file1_row_field)
            self.row_listbox.insert(tk.END, display_name)
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="pivot_config._auto_map_fields.added_file1", message="added file1 row field", data={"field": str(file1_row_field), "display_name": display_name})
            # #endregion
        
        if file2_row_field and file2_row_field not in self.row_fields:
            self.row_fields.append(file2_row_field)
            # 显示格式化后的名称
            display_name = self._format_column_name(file2_row_field)
            self.row_listbox.insert(tk.END, display_name)
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="pivot_config._auto_map_fields.added_file2", message="added file2 row field", data={"field": str(file2_row_field), "display_name": display_name})
            # #endregion
        
        # 2. 预映射值字段：直接使用配置的原值和累计折旧列（带_文件1/_文件2后缀）
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.before_value_mapping",
             message="before value mapping", data={"orig_col1": self.original_value_col1, "orig_col2": self.original_value_col2,
                                                   "dep_col1": self.depreciation_col1, "dep_col2": self.depreciation_col2})
        # #endregion
        
        value_fields_to_add = []
        if self.original_value_col1:
            # 查找带_文件1后缀的原值列
            orig_col1_name = f"{self.original_value_col1}_文件1"
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.check_orig1",
                 message="check orig1", data={"orig_col1_name": orig_col1_name, "in_columns": orig_col1_name in columns})
            # #endregion
            if orig_col1_name in columns and orig_col1_name not in self.value_fields:
                value_fields_to_add.append(orig_col1_name)
        
        if self.original_value_col2:
            # 查找带_文件2后缀的原值列
            orig_col2_name = f"{self.original_value_col2}_文件2"
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.check_orig2",
                 message="check orig2", data={"orig_col2_name": orig_col2_name, "in_columns": orig_col2_name in columns})
            # #endregion
            if orig_col2_name in columns and orig_col2_name not in self.value_fields:
                value_fields_to_add.append(orig_col2_name)
        
        if self.depreciation_col1:
            # 查找带_文件1后缀的累计折旧列（可能被重命名为_文件1_2等）
            dep_col1_name = f"{self.depreciation_col1}_文件1"
            # 先尝试标准名称
            if dep_col1_name in columns and dep_col1_name not in self.value_fields:
                value_fields_to_add.append(dep_col1_name)
            else:
                # 如果标准名称不存在，查找重命名后的列（如累计折旧_文件1_2）
                for col in columns:
                    col_str = str(col)
                    if col_str.startswith(dep_col1_name) and (col_str == dep_col1_name or col_str.startswith(dep_col1_name + '_')):
                        if col not in self.value_fields:
                            value_fields_to_add.append(col)
                            break
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.check_dep1",
                 message="check dep1", data={"dep_col1_name": dep_col1_name, "in_columns": dep_col1_name in columns,
                                            "found_renamed": any(str(c).startswith(dep_col1_name) for c in columns if c != dep_col1_name)})
            # #endregion
        
        if self.depreciation_col2:
            # 查找带_文件2后缀的累计折旧列（可能被重命名为_文件2_2等）
            dep_col2_name = f"{self.depreciation_col2}_文件2"
            # 先尝试标准名称
            if dep_col2_name in columns and dep_col2_name not in self.value_fields:
                value_fields_to_add.append(dep_col2_name)
            else:
                # 如果标准名称不存在，查找重命名后的列（如累计折旧_文件2_2）
                for col in columns:
                    col_str = str(col)
                    if col_str.startswith(dep_col2_name) and (col_str == dep_col2_name or col_str.startswith(dep_col2_name + '_')):
                        if col not in self.value_fields:
                            value_fields_to_add.append(col)
                            break
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.check_dep2",
                 message="check dep2", data={"dep_col2_name": dep_col2_name, "in_columns": dep_col2_name in columns,
                                            "found_renamed": any(str(c).startswith(dep_col2_name) for c in columns if c != dep_col2_name)})
            # #endregion
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.value_fields_found",
             message="value fields to add", data={"count": len(value_fields_to_add), "fields": [str(f) for f in value_fields_to_add]})
        # #endregion
        
        for field in value_fields_to_add:
            if field not in self.value_fields:
                self.value_fields.append(field)
                # 显示格式化后的名称
                display_name = self._format_column_name(field)
                self.value_listbox.insert(tk.END, display_name)
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="pivot_config._auto_map_fields.added_value_field",
                     message="added value field", data={"field": str(field), "display_name": display_name})
                # #endregion
        
        # 更新可用字段列表
        self._update_available_list()
    
    def _create_widgets(self):
        """创建界面组件"""
        # 说明文字
        info_label = ttk.Label(
            self,
            text="配置数据透视表（可选，可直接跳过）",
            font=("Arial", 10)
        )
        info_label.pack(pady=(0, 10))
        
        # 主容器：一个框内显示所有功能
        main_frame = ttk.LabelFrame(self, text="数据透视表配置", padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # 左侧：字段配置区域
        left_frame = ttk.Frame(main_frame)
        left_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5)
        
        # 可用字段列表（支持右键菜单和关键字检索）
        ttk.Label(left_frame, text="可用字段（右键添加到相应区域）:", font=("Arial", 9, "bold")).pack(anchor=tk.W, pady=5)
        
        # 关键字检索框
        search_frame = ttk.Frame(left_frame)
        search_frame.pack(fill=tk.X, pady=(0, 5))
        ttk.Label(search_frame, text="关键字检索:", width=12).pack(side=tk.LEFT, padx=5)
        self.search_var = tk.StringVar()
        search_entry = ttk.Entry(search_frame, textvariable=self.search_var, width=30)
        search_entry.pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        # 绑定输入事件，实时过滤
        self.search_var.trace('w', lambda *args: self._filter_available_fields())
        
        available_frame = ttk.Frame(left_frame)
        available_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        
        self.available_listbox = tk.Listbox(available_frame, selectmode=tk.EXTENDED, height=12)
        self.available_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        available_scroll = ttk.Scrollbar(available_frame, orient=tk.VERTICAL, command=self.available_listbox.yview)
        available_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.available_listbox.configure(yscrollcommand=available_scroll.set)
        
        # 保存所有字段（用于过滤）
        self.all_columns = list(self.df.columns) if self.df is not None else []
        
        # 加载可用字段
        self._update_available_list()
        
        # 右键菜单
        self.context_menu = tk.Menu(self, tearoff=0)
        self.context_menu.add_command(label="添加到行字段", command=self._add_to_row)
        self.context_menu.add_command(label="添加到列字段", command=self._add_to_col)
        self.context_menu.add_command(label="添加到值字段", command=self._add_to_value)
        
        self.available_listbox.bind("<Button-3>", self._show_context_menu)
        
        # 字段配置区域（紧凑布局）
        config_frame = ttk.Frame(left_frame)
        config_frame.pack(fill=tk.X, pady=10)
        
        # 行字段
        row_frame = ttk.LabelFrame(config_frame, text="行字段", padding="5")
        row_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=2)
        
        self.row_listbox = tk.Listbox(row_frame, height=3)
        self.row_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        # 绑定右键菜单
        self.row_listbox.bind('<Button-3>', lambda e: self._show_field_context_menu(e, 'row'))
        
        row_btn_frame = ttk.Frame(row_frame)
        row_btn_frame.pack(side=tk.RIGHT, padx=2)
        ttk.Button(row_btn_frame, text="移除", command=self._remove_row_field, width=6).pack(pady=1)
        
        # 列字段
        col_frame = ttk.LabelFrame(config_frame, text="列字段", padding="5")
        col_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=2)
        
        self.col_listbox = tk.Listbox(col_frame, height=3)
        self.col_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        # 绑定右键菜单
        self.col_listbox.bind('<Button-3>', lambda e: self._show_field_context_menu(e, 'col'))
        
        col_btn_frame = ttk.Frame(col_frame)
        col_btn_frame.pack(side=tk.RIGHT, padx=2)
        ttk.Button(col_btn_frame, text="移除", command=self._remove_col_field, width=6).pack(pady=1)
        
        # 值字段
        value_frame = ttk.LabelFrame(config_frame, text="值字段", padding="5")
        value_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=2)
        
        self.value_listbox = tk.Listbox(value_frame, height=3)
        self.value_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        # 绑定右键菜单
        self.value_listbox.bind('<Button-3>', lambda e: self._show_field_context_menu(e, 'value'))
        
        value_btn_frame = ttk.Frame(value_frame)
        value_btn_frame.pack(side=tk.RIGHT, padx=2)
        ttk.Button(value_btn_frame, text="移除", command=self._remove_value_field, width=6).pack(pady=1)
        
        # 聚合函数选择
        agg_frame = ttk.Frame(left_frame)
        agg_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(agg_frame, text="聚合函数:").pack(side=tk.LEFT, padx=5)
        self.aggfunc_var = tk.StringVar(value="sum")
        agg_combo = ttk.Combobox(
            agg_frame,
            textvariable=self.aggfunc_var,
            values=["sum", "mean", "count", "max", "min"],
            state="readonly",
            width=10
        )
        agg_combo.pack(side=tk.LEFT, padx=5)
        
        # 右侧：预览区域
        right_frame = ttk.LabelFrame(main_frame, text="预览", padding="10")
        right_frame.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=5)
        
        # 预览表格
        preview_frame = ttk.Frame(right_frame)
        preview_frame.pack(fill=tk.BOTH, expand=True)
        
        self.preview_tree = ttk.Treeview(preview_frame)
        self.preview_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        preview_scroll = ttk.Scrollbar(preview_frame, orient=tk.VERTICAL, command=self.preview_tree.yview)
        preview_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.preview_tree.configure(yscrollcommand=preview_scroll.set)
        
        preview_h_scroll = ttk.Scrollbar(right_frame, orient=tk.HORIZONTAL, command=self.preview_tree.xview)
        preview_h_scroll.pack(fill=tk.X, pady=(5, 0))
        self.preview_tree.configure(xscrollcommand=preview_h_scroll.set)
        
        # 预览按钮
        ttk.Button(
            right_frame,
            text="刷新预览",
            command=self._refresh_preview
        ).pack(pady=5)
        
        # 按钮区域
        button_frame = ttk.Frame(self)
        button_frame.pack(pady=20)
        
        ttk.Button(
            button_frame,
            text="上一步",
            command=self._on_back,
            width=15
        ).pack(side=tk.LEFT, padx=5)
        
        ttk.Button(
            button_frame,
            text="跳过数据透视",
            command=self._skip_pivot,
            width=15
        ).pack(side=tk.LEFT, padx=5)
        
        ttk.Button(
            button_frame,
            text="下一步：导出",
            command=self._on_next,
            width=20
        ).pack(side=tk.LEFT, padx=5)
    
    def _show_context_menu(self, event):
        """显示右键菜单"""
        selection = self.available_listbox.curselection()
        if selection:
            try:
                self.context_menu.tk_popup(event.x_root, event.y_root)
            finally:
                self.context_menu.grab_release()
    
    def _add_to_row(self):
        """添加到行字段"""
        selection = self.available_listbox.curselection()
        if selection:
            display_field = self.available_listbox.get(selection[0])
            # 还原原始列名
            original_field = self._get_original_column_name(display_field)
            if original_field not in self.row_fields:
                self.row_fields.append(original_field)
                # 显示格式化后的名称
                self.row_listbox.insert(tk.END, display_field)
                self._update_available_list()
    
    def _add_to_col(self):
        """添加到列字段"""
        selection = self.available_listbox.curselection()
        if selection:
            display_field = self.available_listbox.get(selection[0])
            # 还原原始列名
            original_field = self._get_original_column_name(display_field)
            if original_field not in self.column_fields:
                self.column_fields.append(original_field)
                # 显示格式化后的名称
                self.col_listbox.insert(tk.END, display_field)
                self._update_available_list()
    
    def _add_to_value(self):
        """添加到值字段"""
        selection = self.available_listbox.curselection()
        if selection:
            display_field = self.available_listbox.get(selection[0])
            # 还原原始列名
            original_field = self._get_original_column_name(display_field)
            if original_field not in self.value_fields:
                self.value_fields.append(original_field)
                # 显示格式化后的名称
                self.value_listbox.insert(tk.END, display_field)
                self._update_available_list()
    
    def _remove_row_field(self):
        """移除行字段"""
        selection = self.row_listbox.curselection()
        if selection:
            idx = selection[0]
            display_field = self.row_listbox.get(idx)
            # 还原原始列名
            original_field = self._get_original_column_name(display_field)
            if original_field in self.row_fields:
                self.row_fields.remove(original_field)
            self.row_listbox.delete(idx)
            self._update_available_list()
    
    def _remove_col_field(self):
        """移除列字段"""
        selection = self.col_listbox.curselection()
        if selection:
            idx = selection[0]
            display_field = self.col_listbox.get(idx)
            # 还原原始列名
            original_field = self._get_original_column_name(display_field)
            if original_field in self.column_fields:
                self.column_fields.remove(original_field)
            self.col_listbox.delete(idx)
            self._update_available_list()
    
    def _remove_value_field(self):
        """移除值字段"""
        selection = self.value_listbox.curselection()
        if selection:
            idx = selection[0]
            display_field = self.value_listbox.get(idx)
            # 还原原始列名
            original_field = self._get_original_column_name(display_field)
            if original_field in self.value_fields:
                self.value_fields.remove(original_field)
            self.value_listbox.delete(idx)
            self._update_available_list()
    
    def _show_field_context_menu(self, event, field_type):
        """显示字段右键菜单（行字段、列字段、值字段）"""
        # 确定是哪个列表框
        if field_type == 'row':
            listbox = self.row_listbox
            current_list = self.row_fields
        elif field_type == 'col':
            listbox = self.col_listbox
            current_list = self.column_fields
        else:  # value
            listbox = self.value_listbox
            current_list = self.value_fields
        
        selection = listbox.curselection()
        if not selection:
            return
        
        field = listbox.get(selection[0])
        
        # 创建右键菜单
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="移除", command=lambda: self._remove_field_from_list(field_type, selection[0]))
        menu.add_separator()
        if field_type != 'row':
            menu.add_command(label="移动到行字段", command=lambda: self._move_field(field_type, 'row', selection[0]))
        if field_type != 'col':
            menu.add_command(label="移动到列字段", command=lambda: self._move_field(field_type, 'col', selection[0]))
        if field_type != 'value':
            menu.add_command(label="移动到值字段", command=lambda: self._move_field(field_type, 'value', selection[0]))
        menu.add_separator()
        menu.add_command(label="从可用字段添加", command=lambda: self._show_available_field_picker())
        
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
    
    def _remove_field_from_list(self, field_type, idx):
        """从指定列表中移除字段"""
        if field_type == 'row':
            display_field = self.row_listbox.get(idx)
            original_field = self._get_original_column_name(display_field)
            if original_field in self.row_fields:
                self.row_fields.remove(original_field)
            self.row_listbox.delete(idx)
        elif field_type == 'col':
            display_field = self.col_listbox.get(idx)
            original_field = self._get_original_column_name(display_field)
            if original_field in self.column_fields:
                self.column_fields.remove(original_field)
            self.col_listbox.delete(idx)
        else:  # value
            display_field = self.value_listbox.get(idx)
            original_field = self._get_original_column_name(display_field)
            if original_field in self.value_fields:
                self.value_fields.remove(original_field)
            self.value_listbox.delete(idx)
        
        self._update_available_list()
    
    def _move_field(self, from_type, to_type, idx):
        """移动字段从一个列表到另一个列表"""
        # 获取字段（显示名称）
        if from_type == 'row':
            display_field = self.row_listbox.get(idx)
            original_field = self._get_original_column_name(display_field)
            if original_field in self.row_fields:
                self.row_fields.remove(original_field)
            self.row_listbox.delete(idx)
        elif from_type == 'col':
            display_field = self.col_listbox.get(idx)
            original_field = self._get_original_column_name(display_field)
            if original_field in self.column_fields:
                self.column_fields.remove(original_field)
            self.col_listbox.delete(idx)
        else:  # value
            display_field = self.value_listbox.get(idx)
            original_field = self._get_original_column_name(display_field)
            if original_field in self.value_fields:
                self.value_fields.remove(original_field)
            self.value_listbox.delete(idx)
        
        # 添加到目标列表
        if to_type == 'row':
            if original_field not in self.row_fields:
                self.row_fields.append(original_field)
                self.row_listbox.insert(tk.END, display_field)
        elif to_type == 'col':
            if original_field not in self.column_fields:
                self.column_fields.append(original_field)
                self.col_listbox.insert(tk.END, display_field)
        else:  # value
            if original_field not in self.value_fields:
                self.value_fields.append(original_field)
                self.value_listbox.insert(tk.END, display_field)
        
        self._update_available_list()
    
    def _show_available_field_picker(self):
        """显示可用字段选择对话框"""
        if self.df is None:
            messagebox.showwarning("警告", "没有可用的字段")
            return
        
        # 获取可用字段（未使用的字段）
        used_fields = set(self.row_fields + self.column_fields + self.value_fields)
        available_fields = [col for col in self.df.columns if col not in used_fields]
        
        if not available_fields:
            messagebox.showinfo("提示", "所有字段都已被使用")
            return
        
        # 创建对话框
        dialog = tk.Toplevel(self)
        dialog.title("选择字段")
        dialog.geometry("400x300")
        dialog.transient(self.winfo_toplevel())
        dialog.grab_set()
        
        ttk.Label(dialog, text="请选择要添加的字段:", font=("Arial", 10)).pack(pady=10)

        button_frame = ttk.Frame(dialog)
        button_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=10)
        
        list_frame = ttk.Frame(dialog)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        listbox = tk.Listbox(list_frame, height=10)
        listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=listbox.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        listbox.configure(yscrollcommand=scrollbar.set)
        
        for field in available_fields:
            # 显示格式化后的列名
            display_name = self._format_column_name(field)
            listbox.insert(tk.END, display_name)
        
        def on_ok():
            selection = listbox.curselection()
            if selection:
                display_field = listbox.get(selection[0])
                # 还原原始列名
                selected_field = self._get_original_column_name(display_field)
                # 询问添加到哪个列表
                choice_dialog = tk.Toplevel(dialog)
                choice_dialog.title("选择目标")
                choice_dialog.geometry("300x150")
                choice_dialog.transient(dialog)
                choice_dialog.grab_set()
                
                ttk.Label(choice_dialog, text=f"将字段 '{display_field}' 添加到:", font=("Arial", 10)).pack(pady=10)
                
                choice_frame = ttk.Frame(choice_dialog)
                choice_frame.pack(pady=10)
                
                def add_to_row():
                    if selected_field not in self.row_fields:
                        self.row_fields.append(selected_field)
                        self.row_listbox.insert(tk.END, display_field)
                        self._update_available_list()
                    choice_dialog.destroy()
                    dialog.destroy()
                
                def add_to_col():
                    if selected_field not in self.column_fields:
                        self.column_fields.append(selected_field)
                        self.col_listbox.insert(tk.END, display_field)
                        self._update_available_list()
                    choice_dialog.destroy()
                    dialog.destroy()
                
                def add_to_value():
                    if selected_field not in self.value_fields:
                        self.value_fields.append(selected_field)
                        self.value_listbox.insert(tk.END, display_field)
                        self._update_available_list()
                    choice_dialog.destroy()
                    dialog.destroy()
                
                ttk.Button(choice_frame, text="行字段", command=add_to_row, width=12).pack(pady=2)
                ttk.Button(choice_frame, text="列字段", command=add_to_col, width=12).pack(pady=2)
                ttk.Button(choice_frame, text="值字段", command=add_to_value, width=12).pack(pady=2)
            else:
                messagebox.showwarning("警告", "请选择一个字段")
        
        def on_cancel():
            dialog.destroy()
        
        ttk.Button(button_frame, text="确定", command=on_ok, width=10).pack(side=tk.LEFT, padx=8)
        ttk.Button(button_frame, text="取消", command=on_cancel, width=10).pack(side=tk.LEFT, padx=5)
        
        listbox.bind('<Double-Button-1>', lambda e: on_ok())
    
    def _format_column_name(self, col_name):
        """将列名中的_文件1/_文件2替换为显示名称（只替换最后一个匹配的后缀）"""
        if col_name is None:
            return col_name
        col_str = str(col_name)
        # 优先替换列名结尾的后缀（因为这是合并时添加的，表示该列属于哪个文件）
        # 处理可能的重命名后缀（如_文件1_2, _文件2_2等）
        # 注意：len('_文件1') = len('_文件2') = 4
        if col_str.endswith('_文件2_2') or col_str.endswith('_文件2_3') or col_str.endswith('_文件2_4'):
            # 移除最后的数字后缀和_文件2
            base_name = col_str.rsplit('_文件2', 1)[0]
            return f"{base_name}_{self.file2_display_name}"
        elif col_str.endswith('_文件1_2') or col_str.endswith('_文件1_3') or col_str.endswith('_文件1_4'):
            # 移除最后的数字后缀和_文件1
            base_name = col_str.rsplit('_文件1', 1)[0]
            return f"{base_name}_{self.file1_display_name}"
        elif col_str.endswith('_文件2'):
            # 如果以_文件2结尾，直接替换
            return col_str[:-4] + f'_{self.file2_display_name}'
        elif col_str.endswith('_文件1'):
            # 如果以_文件1结尾，直接替换
            return col_str[:-4] + f'_{self.file1_display_name}'
        # 如果列名中同时包含_文件1和_文件2（如"资产大类_文件2_文件1"），
        # 只替换最后一个（结尾的）后缀
        elif '_文件2' in col_str and col_str.endswith('_文件1'):
            # 列名格式可能是"xxx_文件2_文件1"，应该替换最后的_文件1
            return col_str[:-4] + f'_{self.file1_display_name}'
        elif '_文件1' in col_str and col_str.endswith('_文件2'):
            # 列名格式可能是"xxx_文件1_文件2"，应该替换最后的_文件2
            return col_str[:-4] + f'_{self.file2_display_name}'
        # 如果列名中包含但不以它结尾，找到最后一个并替换
        elif '_文件2' in col_str:
            idx = col_str.rfind('_文件2')
            return col_str[:idx] + f'_{self.file2_display_name}' + col_str[idx+4:]
        elif '_文件1' in col_str:
            idx = col_str.rfind('_文件1')
            return col_str[:idx] + f'_{self.file1_display_name}' + col_str[idx+4:]
        return col_str
    
    def _get_original_column_name(self, display_name):
        """从显示名称还原原始列名"""
        if display_name is None:
            return display_name
        display_str = str(display_name)
        # 优先替换结尾的后缀（注意：这里用 +1 是因为要包含下划线）
        if display_str.endswith(f'_{self.file1_display_name}'):
            return display_str[:-(len(self.file1_display_name)+1)] + '_文件1'
        elif display_str.endswith(f'_{self.file2_display_name}'):
            return display_str[:-(len(self.file2_display_name)+1)] + '_文件2'
        # 如果找不到匹配，尝试直接匹配
        if '_文件1' in display_str or '_文件2' in display_str:
            return display_str
        # 如果都不匹配，返回原值（可能是没有后缀的列）
        return display_str
    
    def _update_available_list(self):
        """更新可用字段列表（支持关键字过滤）"""
        used_fields = set(self.row_fields + self.column_fields + self.value_fields)
        self.available_listbox.delete(0, tk.END)
        
        # 获取搜索关键字
        search_keyword = self.search_var.get().strip().lower() if hasattr(self, 'search_var') else ''
        
        if self.df is not None:
            for col in self.all_columns:
                if col not in used_fields:
                    # 如果有关键字，进行过滤
                    if not search_keyword or search_keyword in str(col).lower():
                        # 显示格式化后的列名
                        display_name = self._format_column_name(col)
                        self.available_listbox.insert(tk.END, display_name)
    
    def _filter_available_fields(self):
        """根据关键字过滤可用字段列表"""
        self._update_available_list()
    
    def _refresh_preview(self):
        """刷新预览"""
        if not self.row_fields:
            messagebox.showwarning("警告", "请至少添加一个行字段")
            return
        
        # 如果没有值字段，自动使用 count 统计
        use_values = self.value_fields if self.value_fields else None
        use_aggfunc = self.aggfunc_var.get()
        
        # 如果没有值字段，使用 count 作为默认聚合
        if not use_values:
            use_aggfunc = 'count'
        
        # 创建透视表
        success, error_msg, pivot_df = self.pivot_engine.create_pivot_table(
            self.df,
            index=self.row_fields,
            columns=self.column_fields if self.column_fields else None,
            values=use_values,
            aggfunc=use_aggfunc
        )
        
        if not success:
            messagebox.showerror("错误", error_msg)
            return
        
        # 显示预览
        self._display_preview(pivot_df)
    
    def _display_preview(self, pivot_df: pd.DataFrame):
        """显示预览数据"""
        if pivot_df is None or pivot_df.empty:
            return
        
        # 清除现有数据
        for item in self.preview_tree.get_children():
            self.preview_tree.delete(item)
        
        # 处理多级索引
        if isinstance(pivot_df.index, pd.MultiIndex):
            index_name = ' / '.join([self._format_column_name(str(name)) if name else '索引' for name in pivot_df.index.names])
        else:
            index_name = self._format_column_name(pivot_df.index.name) if pivot_df.index.name else '索引'
        
        # 设置列（使用唯一列 ID 避免重复列名问题）
        if isinstance(pivot_df.columns, pd.MultiIndex):
            column_names = [' / '.join([self._format_column_name(str(c)) for c in col]) for col in pivot_df.columns]
        else:
            column_names = [self._format_column_name(str(col)) for col in pivot_df.columns]
        
        # 使用唯一列 ID
        col_ids = [f"c{i}" for i in range(len(column_names))]
        self.preview_tree['columns'] = col_ids
        self.preview_tree['show'] = 'tree headings'
        
        # 配置列
        self.preview_tree.heading('#0', text=str(index_name))
        self.preview_tree.column('#0', width=150)
        
        for i, col_name in enumerate(column_names):
            cid = col_ids[i]
            self.preview_tree.heading(cid, text=str(col_name))
            max_len = len(str(col_name))
            if len(pivot_df) > 0:
                col_values = pivot_df.iloc[:, i]
                max_val_len = max([len(str(val)) for val in col_values.head(10) if pd.notna(val)], default=0)
                max_len = max(max_len, max_val_len)
            self.preview_tree.column(cid, width=min(max_len * 10 + 20, 200))
        
        # 插入数据（按列索引取值）
        for row_idx, idx in enumerate(pivot_df.index):
            if isinstance(pivot_df.index, pd.MultiIndex):
                idx_text = ' / '.join([str(i) for i in idx])
            else:
                idx_text = str(idx)
            
            values = []
            for col_idx in range(len(column_names)):
                val = pivot_df.iloc[row_idx, col_idx]
                if pd.notna(val):
                    val_str = str(val)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + '...'
                    values.append(val_str)
                else:
                    values.append('')
            
            self.preview_tree.insert('', tk.END, text=idx_text, values=values)
    
    def _skip_pivot(self):
        """跳过数据透视"""
        if messagebox.askyesno("确认", "确定要跳过数据透视表配置吗？"):
            if self.on_complete:
                # 返回字典格式，包含pivot_df和row_fields
                self.on_complete({'pivot_df': None, 'row_fields': None})
    
    def _on_back(self):
        """上一步按钮"""
        if self.on_back:
            self.on_back()
    
    def _on_next(self):
        """下一步按钮"""
        if not self.row_fields:
            messagebox.showwarning("警告", "请至少添加一个行字段，或选择跳过数据透视")
            return
        
        # 如果没有值字段，自动使用 count 统计
        use_values = self.value_fields if self.value_fields else None
        use_aggfunc = self.aggfunc_var.get()
        
        # 如果没有值字段，使用 count 作为默认聚合
        if not use_values:
            use_aggfunc = 'count'
        
        # 创建透视表
        success, error_msg, pivot_df = self.pivot_engine.create_pivot_table(
            self.df,
            index=self.row_fields,
            columns=self.column_fields if self.column_fields else None,
            values=use_values,
            aggfunc=use_aggfunc
        )
        
        if not success:
            messagebox.showerror("错误", error_msg)
            return
        
        # 调用完成回调，返回字典格式，包含pivot_df和row_fields
        if self.on_complete:
            self.on_complete({
                'pivot_df': pivot_df,
                'row_fields': self.row_fields.copy()  # 传递行字段（资产类别）
            })
