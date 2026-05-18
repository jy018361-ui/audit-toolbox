"""
列选择界面
"""
import tkinter as tk
from tkinter import ttk
import pandas as pd


class ColumnSelector(ttk.Frame):
    """列选择组件"""
    
    def __init__(self, parent, df: pd.DataFrame, on_complete=None, on_back=None, file1_display_name=None, file2_display_name=None):
        super().__init__(parent, padding="10")
        self.df = df
        self.on_complete = on_complete
        self.on_back = on_back
        self.file1_display_name = file1_display_name or "文件1"
        self.file2_display_name = file2_display_name or "文件2"
        
        self.column_vars = {}
        # 创建列名映射：原始列名 -> 显示列名
        self.column_name_map = {}
        self.reverse_column_name_map = {}
        
        self._create_widgets()
    
    def _format_column_name(self, col_name):
        """格式化列名：将_文件1和_文件2替换为文件显示名称，并移除后缀"""
        if col_name is None:
            return col_name
        col_str = str(col_name)
        
        # 优先检查结尾的后缀（因为这是合并时添加的，表示该列属于哪个文件）
        # 注意：len('_文件1') = len('_文件2') = 4
        # 处理可能的重命名后缀（如_文件1_2, _文件2_2等）
        if col_str.endswith('_文件2_2') or col_str.endswith('_文件2_3') or col_str.endswith('_文件2_4'):
            # 移除最后的数字后缀和_文件2
            base_name = col_str.rsplit('_文件2', 1)[0]
            return base_name  # 只返回基础列名，不添加文件显示名称
        elif col_str.endswith('_文件1_2') or col_str.endswith('_文件1_3') or col_str.endswith('_文件1_4'):
            # 移除最后的数字后缀和_文件1
            base_name = col_str.rsplit('_文件1', 1)[0]
            return base_name  # 只返回基础列名，不添加文件显示名称
        elif col_str.endswith('_文件2'):
            base_name = col_str[:-4]  # 移除'_文件2' (len=4)
            return base_name  # 只返回基础列名，不添加文件显示名称
        elif col_str.endswith('_文件1'):
            base_name = col_str[:-4]  # 移除'_文件1' (len=4)
            return base_name  # 只返回基础列名，不添加文件显示名称
        # 如果列名中包含但不以它结尾，找到最后一个并替换
        elif '_文件2' in col_str:
            idx = col_str.rfind('_文件2')
            remaining = col_str[idx+4:]  # len('_文件2')=4
            if remaining.startswith('_'):
                # 有数字后缀，只移除_文件2部分
                return col_str[:idx] + remaining
            else:
                return col_str[:idx]
        elif '_文件1' in col_str:
            idx = col_str.rfind('_文件1')
            remaining = col_str[idx+4:]  # len('_文件1')=4
            if remaining.startswith('_'):
                # 有数字后缀，只移除_文件1部分
                return col_str[:idx] + remaining
            else:
                return col_str[:idx]
        else:
            return col_str
    
    def _get_file_source(self, col_name):
        """判断列属于哪个文件"""
        if col_name is None:
            return None
        col_str = str(col_name)
        
        # 优先检查结尾的后缀
        if col_str.endswith('_文件2_2') or col_str.endswith('_文件2_3') or col_str.endswith('_文件2_4'):
            return 2
        elif col_str.endswith('_文件2'):
            return 2
        elif col_str.endswith('_文件1_2') or col_str.endswith('_文件1_3') or col_str.endswith('_文件1_4'):
            return 1
        elif col_str.endswith('_文件1'):
            return 1
        elif '_文件2' in col_str:
            return 2
        elif '_文件1' in col_str:
            return 1
        else:
            return None
    
    def _create_widgets(self):
        """创建界面组件"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        # 说明文字
        info_label = ttk.Label(
            self,
            text="请选择要导出的列（默认全选）",
            font=("Arial", 10)
        )
        info_label.pack(pady=(0, 10))
        
        # 主容器：左右分栏
        main_container = ttk.Frame(self)
        main_container.pack(side=tk.TOP, fill=tk.BOTH, expand=True, pady=5)
        
        # 分离文件1和文件2的列
        file1_columns = []
        file2_columns = []
        other_columns = []
        
        if self.df is not None:
            for col in self.df.columns:
                file_source = self._get_file_source(col)
                if file_source == 1:
                    file1_columns.append(col)
                elif file_source == 2:
                    file2_columns.append(col)
                else:
                    other_columns.append(col)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="column_selector._create_widgets.columns_separated", 
             message="columns separated", data={"file1_count": len(file1_columns), "file2_count": len(file2_columns), 
                                                "other_count": len(other_columns), "file1_sample": [str(c) for c in file1_columns[:5]],
                                                "file2_sample": [str(c) for c in file2_columns[:5]]})
        # #endregion
        
        # 左侧：文件1的列
        left_frame = ttk.LabelFrame(main_container, text=f"{self.file1_display_name} 的列", padding="5")
        left_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 5))
        
        # 文件1的全选/全不选按钮
        left_buttons = ttk.Frame(left_frame)
        left_buttons.pack(fill=tk.X, pady=(0, 5))
        ttk.Button(left_buttons, text="全选", command=lambda: self._select_file_columns(file1_columns, True), width=10).pack(side=tk.LEFT, padx=2)
        ttk.Button(left_buttons, text="全不选", command=lambda: self._select_file_columns(file1_columns, False), width=10).pack(side=tk.LEFT, padx=2)
        
        # 文件1的列选择区域（使用滚动框架）
        left_canvas = tk.Canvas(left_frame, height=350)
        left_scrollbar = ttk.Scrollbar(left_frame, orient=tk.VERTICAL, command=left_canvas.yview)
        left_canvas.configure(yscrollcommand=left_scrollbar.set)
        
        left_columns_frame = ttk.Frame(left_canvas)
        left_canvas.create_window((0, 0), window=left_columns_frame, anchor='nw')
        left_canvas.bind('<Configure>', lambda e: left_canvas.configure(scrollregion=left_canvas.bbox('all')))
        
        # 创建文件1的复选框
        for i, col in enumerate(file1_columns):
            var = tk.BooleanVar(value=True)  # 默认全选
            self.column_vars[col] = var
            
            # 格式化列名用于显示（移除后缀）
            display_name = self._format_column_name(col)
            self.column_name_map[col] = display_name
            self.reverse_column_name_map[display_name] = col
            
            # #region agent log
            if i < 5:  # 只记录前5个，避免日志过长
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="column_selector._create_widgets.file1_col", 
                     message="file1 column display", data={"original": str(col), "display": display_name})
            # #endregion
            
            checkbutton_frame = ttk.Frame(left_columns_frame)
            checkbutton_frame.pack(fill=tk.X, padx=5, pady=2)
            
            checkbutton = ttk.Checkbutton(
                checkbutton_frame,
                text="",
                variable=var
            )
            checkbutton.pack(side=tk.LEFT)
            
            # 使用Label显示列名，支持完整显示（不限制宽度）
            label = ttk.Label(
                checkbutton_frame,
                text=display_name,
                anchor='w',
                font=("Arial", 9)
            )
            label.pack(side=tk.LEFT, padx=(5, 0), fill=tk.X, expand=True)
        
        left_columns_frame.update_idletasks()
        left_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        left_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 右侧：文件2的列
        right_frame = ttk.LabelFrame(main_container, text=f"{self.file2_display_name} 的列", padding="5")
        right_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(5, 0))
        
        # 文件2的全选/全不选按钮
        right_buttons = ttk.Frame(right_frame)
        right_buttons.pack(fill=tk.X, pady=(0, 5))
        ttk.Button(right_buttons, text="全选", command=lambda: self._select_file_columns(file2_columns, True), width=10).pack(side=tk.LEFT, padx=2)
        ttk.Button(right_buttons, text="全不选", command=lambda: self._select_file_columns(file2_columns, False), width=10).pack(side=tk.LEFT, padx=2)
        
        # 文件2的列选择区域（使用滚动框架）
        right_canvas = tk.Canvas(right_frame, height=350)
        right_scrollbar = ttk.Scrollbar(right_frame, orient=tk.VERTICAL, command=right_canvas.yview)
        right_canvas.configure(yscrollcommand=right_scrollbar.set)
        
        right_columns_frame = ttk.Frame(right_canvas)
        right_canvas.create_window((0, 0), window=right_columns_frame, anchor='nw')
        right_canvas.bind('<Configure>', lambda e: right_canvas.configure(scrollregion=right_canvas.bbox('all')))
        
        # 创建文件2的复选框
        for i, col in enumerate(file2_columns):
            var = tk.BooleanVar(value=True)  # 默认全选
            self.column_vars[col] = var
            
            # 格式化列名用于显示（移除后缀）
            display_name = self._format_column_name(col)
            self.column_name_map[col] = display_name
            self.reverse_column_name_map[display_name] = col
            
            checkbutton_frame = ttk.Frame(right_columns_frame)
            checkbutton_frame.pack(fill=tk.X, padx=5, pady=2)
            
            checkbutton = ttk.Checkbutton(
                checkbutton_frame,
                text="",
                variable=var
            )
            checkbutton.pack(side=tk.LEFT)
            
            # 使用Label显示列名，支持完整显示（不限制宽度）
            label = ttk.Label(
                checkbutton_frame,
                text=display_name,
                anchor='w',
                font=("Arial", 9)
            )
            label.pack(side=tk.LEFT, padx=(5, 0), fill=tk.X, expand=True)
        
        right_columns_frame.update_idletasks()
        right_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        right_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 如果有其他列（没有_文件1或_文件2后缀的），显示在底部
        if other_columns:
            other_frame = ttk.LabelFrame(main_container, text="其他列", padding="5")
            other_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(5, 0))
            
            other_buttons = ttk.Frame(other_frame)
            other_buttons.pack(fill=tk.X, pady=(0, 5))
            ttk.Button(other_buttons, text="全选", command=lambda: self._select_file_columns(other_columns, True), width=10).pack(side=tk.LEFT, padx=2)
            ttk.Button(other_buttons, text="全不选", command=lambda: self._select_file_columns(other_columns, False), width=10).pack(side=tk.LEFT, padx=2)
            
            other_canvas = tk.Canvas(other_frame, height=350)
            other_scrollbar = ttk.Scrollbar(other_frame, orient=tk.VERTICAL, command=other_canvas.yview)
            other_canvas.configure(yscrollcommand=other_scrollbar.set)
            
            other_columns_frame = ttk.Frame(other_canvas)
            other_canvas.create_window((0, 0), window=other_columns_frame, anchor='nw')
            other_canvas.bind('<Configure>', lambda e: other_canvas.configure(scrollregion=other_canvas.bbox('all')))
            
            for col in other_columns:
                var = tk.BooleanVar(value=True)
                self.column_vars[col] = var
                display_name = self._format_column_name(col)
                self.column_name_map[col] = display_name
                self.reverse_column_name_map[display_name] = col
                
                checkbutton_frame = ttk.Frame(other_columns_frame)
                checkbutton_frame.pack(fill=tk.X, padx=5, pady=2)
                
                checkbutton = ttk.Checkbutton(checkbutton_frame, text="", variable=var)
                checkbutton.pack(side=tk.LEFT)
                
                # 使用Label显示列名，支持完整显示（不限制宽度）
                label = ttk.Label(
                    checkbutton_frame,
                    text=display_name,
                    anchor='w',
                    font=("Arial", 9)
                )
                label.pack(side=tk.LEFT, padx=(5, 0), fill=tk.X, expand=True)
            
            other_columns_frame.update_idletasks()
            other_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
            other_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 显示已选择列数
        
        # 按钮区域
        button_frame = ttk.Frame(self)
        button_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=20)
        count_label = ttk.Label(self, text=f"已选择 {len([v for v in self.column_vars.values() if v.get()])} 列")
        count_label.pack(side=tk.BOTTOM, pady=5)
        
        ttk.Button(
            button_frame,
            text="上一步",
            command=self._on_back,
            width=15
        ).pack(side=tk.LEFT, padx=5)
        
        ttk.Button(
            button_frame,
            text="下一步：选择路径并导出",
            command=self._on_next,
            width=25
        ).pack(side=tk.LEFT, padx=5)
    
    def _select_file_columns(self, columns, select):
        """选择或取消选择指定文件的列"""
        for col in columns:
            if col in self.column_vars:
                self.column_vars[col].set(select)
    
    def _select_all(self):
        """全选"""
        for var in self.column_vars.values():
            var.set(True)
    
    def _deselect_all(self):
        """全不选"""
        for var in self.column_vars.values():
            var.set(False)
    
    def _on_back(self):
        """上一步按钮"""
        if self.on_back:
            self.on_back()
    
    def _on_next(self):
        """下一步按钮"""
        # 获取选中的列
        selected_columns = [
            col for col, var in self.column_vars.items() if var.get()
        ]
        
        if not selected_columns:
            from tkinter import messagebox
            messagebox.showwarning("警告", "请至少选择一列")
            return
        
        # 调用完成回调
        if self.on_complete:
            self.on_complete(selected_columns)
