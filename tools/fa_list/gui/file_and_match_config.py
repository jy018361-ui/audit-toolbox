"""
文件选择和匹配列配置合并界面
"""
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import os
import threading
import webbrowser
from urllib.parse import quote
import pandas as pd
from file_handler import FileHandler
from utils.helpers import get_column_matches, detect_encoding
from config import SUPPORTED_EXCEL_FORMATS, SUPPORTED_CSV_FORMATS, PREVIEW_ROWS


class FileAndMatchConfig(ttk.Frame):
    """文件选择和匹配列配置合并组件"""
    
    def __init__(
        self,
        parent,
        file_handler: FileHandler,
        on_complete=None,
        status_callback=None,
        mode="normal",
        on_back=None,
        on_skip=None
    ):
        super().__init__(parent, padding="10")
        self.file_handler = file_handler
        self.on_complete = on_complete
        self.status_callback = status_callback
        self.mode = mode
        self.on_back = on_back
        self.on_skip = on_skip
        
        # 文件路径变量
        self.file1_path_var = tk.StringVar()
        self.file2_path_var = tk.StringVar()
        self.file1_sheet_var = tk.StringVar()
        self.file2_sheet_var = tk.StringVar()
        
        # 匹配列变量（改为列表支持多选）
        self.match_columns1 = []  # 文件1的匹配列列表
        self.match_columns2 = []  # 文件2的匹配列列表
        self.data_type1_var = tk.StringVar(value="auto")
        self.data_type2_var = tk.StringVar(value="auto")
        
        # 原值列变量
        self.original_value_col1_var = tk.StringVar()
        self.original_value_col2_var = tk.StringVar()
        
        # 累计折旧列变量
        self.depreciation_col1_var = tk.StringVar()
        self.depreciation_col2_var = tk.StringVar()
        
        # 新增字段映射变量
        self.category_col1_var = tk.StringVar()  # 资产类别列（文件1）
        self.category_col2_var = tk.StringVar()  # 资产类别列（文件2）
        self.name_col1_var = tk.StringVar()  # 固定资产名称列（文件1）
        self.name_col2_var = tk.StringVar()  # 固定资产名称列（文件2）
        self.date_col1_var = tk.StringVar()  # 入账开始日期列（文件1）
        self.date_col2_var = tk.StringVar()  # 入账开始日期列（文件2）
        self.life_col1_var = tk.StringVar()  # 使用寿命列（文件1）
        self.life_col2_var = tk.StringVar()  # 使用寿命列（文件2）
        self.residual_col1_var = tk.StringVar()  # 残值率列（文件1）
        self.residual_col2_var = tk.StringVar()  # 残值率列（文件2）
        self.current_year_dep_col1_var = tk.StringVar()  # 本年折旧列（文件1）
        self.current_year_dep_col2_var = tk.StringVar()  # 本年折旧列（文件2）
        self.balance_sheet_date_var = tk.StringVar(value="2025/12/31")  # 折旧测算资产负债表日
        self.addition_method_col1_var = tk.StringVar()  # 新增方式（文件1）
        self.addition_method_col2_var = tk.StringVar()  # 新增方式（文件2）
        self.addition_date_col1_var = tk.StringVar()  # 新增时间（文件1）
        self.addition_date_col2_var = tk.StringVar()  # 新增时间（文件2）
        self.disposal_method_col1_var = tk.StringVar()  # 处置方式（文件1）
        self.disposal_method_col2_var = tk.StringVar()  # 处置方式（文件2）
        self.disposal_date_col1_var = tk.StringVar()  # 处置时间（文件1）
        self.disposal_date_col2_var = tk.StringVar()  # 处置时间（文件2）
        self.disposal_orig_col1_var = tk.StringVar()  # 处置原值（文件1）
        self.disposal_orig_col2_var = tk.StringVar()  # 处置原值（文件2）
        self.disposal_dep_col1_var = tk.StringVar()  # 处置折旧（文件1）
        self.disposal_dep_col2_var = tk.StringVar()  # 处置折旧（文件2）
        
        # 标题行索引（用于处理首行为空的情况）
        self.file1_header_row = 0
        self.file2_header_row = 0
        
        self._create_widgets()
    
    def _get_file_display_name(self, file_num):
        """获取文件显示名称：原始文件 & sheet名称"""
        if file_num == 1:
            path = self.file1_path_var.get()
            sheet = self.file1_sheet_var.get()
        else:
            path = self.file2_path_var.get()
            sheet = self.file2_sheet_var.get()
        
        if not path:
            # 如果没有路径，返回默认名称（但应该避免这种情况）
            return f"原始文件{file_num}"
        
        # 获取文件名（不含路径）
        import os
        file_name = os.path.basename(path)
        
        # 如果有sheet，显示"文件名 & sheet名称"；如果没有sheet（CSV文件），只显示文件名
        if sheet:
            return f"{file_name} & {sheet}"
        else:
            # CSV文件没有sheet，只显示文件名
            return file_name
    
    def _create_widgets(self):
        """创建界面组件"""
        is_supplement_mode = self.mode == "supplement"
        # 说明文字
        info_label = ttk.Label(
            self,
            text="选择新增清单/处置清单并配置映射（右键预览表格任意行可设为标题行）" if is_supplement_mode else "选择文件并配置匹配列（右键预览表格任意行可设为标题行）",
            font=("Arial", 10)
        )
        info_label.pack(pady=(0, 10))
        
        # 【重要】按钮区域必须先pack，使用side=BOTTOM，这样它会固定在底部
        button_frame = ttk.Frame(self)
        button_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=10)
        
        next_btn = ttk.Button(
            button_frame,
            text="下一步：应用补充映射 >>" if self.mode == "supplement" else "下一步：执行合并 >>",
            command=self._on_next,
            width=25
        )
        next_btn.pack(side=tk.LEFT, pady=5)

        if is_supplement_mode:
            if callable(self.on_back):
                ttk.Button(
                    button_frame,
                    text="<< 返回上一步",
                    command=self.on_back,
                    width=12
                ).pack(side=tk.LEFT, padx=(8, 0), pady=5)
            if callable(self.on_skip):
                ttk.Button(
                    button_frame,
                    text="跳过该步骤",
                    command=self.on_skip,
                    width=12
                ).pack(side=tk.LEFT, padx=(8, 0), pady=5)
        
        def _open_mailto(subject: str, body: str):
            to = "John.SX.Yan@cn.ey.com;melody.bt.liu@cn.ey.com;april.yl.wang@cn.ey.com"
            url = f"mailto:{to}?subject={quote(subject, safe='')}&body={quote(body, safe='')}"
            try:
                webbrowser.open(url)
            except Exception:
                pass
        
        links_frame = ttk.Frame(button_frame)
        links_frame.pack(side=tk.RIGHT, padx=(8, 0))
        
        lbl_like = tk.Label(links_frame, text="为你点赞", fg="#0066cc", cursor="hand2", font=("Arial", 9))
        lbl_like.pack(side=tk.LEFT, padx=(0, 14))
        lbl_like.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 点赞反馈", "整体使用体验良好，点赞！"))
        
        lbl_suggest = tk.Label(links_frame, text="用户建议", fg="#0066cc", cursor="hand2", font=("Arial", 9))
        lbl_suggest.pack(side=tk.LEFT)
        lbl_suggest.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 功能建议", "我的建议如下：[]"))
        
        # 主容器：使用grid布局，左右两列
        # 左侧列：文件选择（上） + 文件预览（下）
        # 右侧列：匹配列配置（上） + 字段映射配置（下）
        main_container = ttk.Frame(self)
        main_container.pack(fill=tk.BOTH, expand=True, pady=(0, 5))
        
        # 设置列权重，左右各占一半，固定最小宽度
        main_container.columnconfigure(0, weight=1, minsize=450)  # 左列：文件选择+预览
        main_container.columnconfigure(1, weight=1, minsize=450)  # 右列：匹配列+字段映射
        main_container.rowconfigure(0, weight=0, minsize=100)  # 上行：固定高度
        main_container.rowconfigure(1, weight=1, minsize=300)  # 下行：可扩展
        
        # ==================== 左上：文件选择区域 ====================
        file_frame = ttk.LabelFrame(main_container, text="文件选择", padding="5")
        file_frame.grid(row=0, column=0, sticky="nsew", padx=(5, 2), pady=(0, 2))
        file_frame.grid_propagate(False)  # 锁定区域大小
        
        # 添加提示信息
        tip_label = ttk.Label(
            file_frame,
            text="提示：文件1导入新增清单，文件2导入处置清单；匹配列请选择唯一识别码" if is_supplement_mode else "提示：文件1导入年初清单，文件2导入年末清单，顺序别反了",
            font=("Arial", 8),
            foreground="red"
        )
        tip_label.pack(pady=(0, 3), anchor=tk.W)
        
        # 文件1
        file1_frame = ttk.Frame(file_frame)
        file1_frame.pack(fill=tk.X, pady=2)
        
        self.file1_label = ttk.Label(file1_frame, text="新增清单:" if is_supplement_mode else "文件1:", width=6)
        self.file1_label.pack(side=tk.LEFT, padx=2)
        file1_entry = ttk.Entry(file1_frame, textvariable=self.file1_path_var, width=20)
        file1_entry.pack(side=tk.LEFT, padx=2, fill=tk.X, expand=True)
        ttk.Button(file1_frame, text="浏览...", command=self._select_file1, width=6).pack(side=tk.LEFT, padx=2)
        ttk.Label(file1_frame, text="工作表:", width=6).pack(side=tk.LEFT, padx=(5, 2))
        self.file1_sheet_combo = ttk.Combobox(file1_frame, textvariable=self.file1_sheet_var, state="readonly", width=12)
        self.file1_sheet_combo.pack(side=tk.LEFT, padx=2)
        self.file1_sheet_combo.bind('<<ComboboxSelected>>', lambda e: self._load_file1())
        
        # 文件2
        file2_frame = ttk.Frame(file_frame)
        file2_frame.pack(fill=tk.X, pady=2)
        
        self.file2_label = ttk.Label(file2_frame, text="处置清单:" if is_supplement_mode else "文件2:", width=6)
        self.file2_label.pack(side=tk.LEFT, padx=2)
        file2_entry = ttk.Entry(file2_frame, textvariable=self.file2_path_var, width=20)
        file2_entry.pack(side=tk.LEFT, padx=2, fill=tk.X, expand=True)
        ttk.Button(file2_frame, text="浏览...", command=self._select_file2, width=6).pack(side=tk.LEFT, padx=2)
        ttk.Label(file2_frame, text="工作表:", width=6).pack(side=tk.LEFT, padx=(5, 2))
        self.file2_sheet_combo = ttk.Combobox(file2_frame, textvariable=self.file2_sheet_var, state="readonly", width=12)
        self.file2_sheet_combo.pack(side=tk.LEFT, padx=2)
        self.file2_sheet_combo.bind('<<ComboboxSelected>>', lambda e: self._load_file2())
        
        # ==================== 右上：匹配列配置区域 ====================
        match_frame = ttk.LabelFrame(main_container, text="匹配列配置（按ctrl可多选）", padding="5")
        match_frame.grid(row=0, column=1, sticky="nsew", padx=(2, 5), pady=(0, 2))
        match_frame.grid_propagate(False)  # 锁定区域大小
        
        match_col_frame = ttk.Frame(match_frame)
        match_col_frame.pack(fill=tk.BOTH, expand=True, pady=2)
        
        # 文件1匹配列
        file1_match_frame = ttk.Frame(match_col_frame)
        file1_match_frame.pack(fill=tk.X, pady=1)
        ttk.Label(file1_match_frame, text="文件1:", width=6).pack(side=tk.LEFT, padx=2)
        self.match_col1_button = ttk.Button(file1_match_frame, text="选择匹配列...", command=lambda: self._show_column_picker_dialog('match', 1), width=12)
        self.match_col1_button.pack(side=tk.LEFT, padx=2)
        def update_button1_text():
            if self.match_columns1:
                self.match_col1_button.config(text=f"已选{len(self.match_columns1)}列 ▼")
            else:
                self.match_col1_button.config(text="选择匹配列...")
        self._update_match_col1_button = update_button1_text
        self.match_col1_selected_label = ttk.Label(file1_match_frame, text="已选择: 无", foreground="blue", wraplength=180, justify=tk.LEFT, font=("Arial", 8))
        self.match_col1_selected_label.pack(side=tk.LEFT, padx=2)
        self.match_col1_listbox = tk.Listbox(file1_match_frame, height=0)
        self.match_col1_listbox.pack_forget()
        
        # 文件2匹配列
        file2_match_frame = ttk.Frame(match_col_frame)
        file2_match_frame.pack(fill=tk.X, pady=1)
        ttk.Label(file2_match_frame, text="文件2:", width=6).pack(side=tk.LEFT, padx=2)
        self.match_col2_button = ttk.Button(file2_match_frame, text="选择匹配列...", command=lambda: self._show_column_picker_dialog('match', 2), width=12)
        self.match_col2_button.pack(side=tk.LEFT, padx=2)
        def update_button2_text():
            if self.match_columns2:
                self.match_col2_button.config(text=f"已选{len(self.match_columns2)}列 ▼")
            else:
                self.match_col2_button.config(text="选择匹配列...")
        self._update_match_col2_button = update_button2_text
        self.match_col2_selected_label = ttk.Label(file2_match_frame, text="已选择: 无", foreground="blue", wraplength=180, justify=tk.LEFT, font=("Arial", 8))
        self.match_col2_selected_label.pack(side=tk.LEFT, padx=2)
        self.match_col2_listbox = tk.Listbox(file2_match_frame, height=0)
        self.match_col2_listbox.pack_forget()
        
        # 数据类型
        data_type_frame = ttk.Frame(match_frame)
        data_type_frame.pack(fill=tk.X, pady=2)
        ttk.Label(data_type_frame, text="数据类型:", width=8).pack(side=tk.LEFT, padx=2)
        ttk.Combobox(data_type_frame, textvariable=self.data_type1_var, values=["auto", "text", "number", "date"], state="readonly", width=8).pack(side=tk.LEFT, padx=2)
        ttk.Label(data_type_frame, text="文件2:", width=6).pack(side=tk.LEFT, padx=2)
        ttk.Combobox(data_type_frame, textvariable=self.data_type2_var, values=["auto", "text", "number", "date"], state="readonly", width=8).pack(side=tk.LEFT, padx=2)
        
        # ==================== 左下：文件预览区域 ====================
        preview_frame = ttk.LabelFrame(main_container, text="文件预览（底部滚动条或 Shift+滚轮 可左右滑动）", padding="5")
        preview_frame.grid(row=1, column=0, sticky="nsew", padx=(5, 2), pady=(2, 0))
        preview_frame.grid_propagate(False)  # 锁定区域大小
        
        self.preview_notebook = ttk.Notebook(preview_frame)
        self.preview_notebook.pack(fill=tk.BOTH, expand=True)
        
        # 文件1预览（先 pack 底部横向滚动条，再 pack 表格区，这样横向条才能可见）
        file1_preview_frame = ttk.Frame(self.preview_notebook)
        self.file1_preview_tab_text = "新增清单" if is_supplement_mode else "原始文件1"
        self.preview_notebook.add(file1_preview_frame, text=self.file1_preview_tab_text)
        file1_h_scroll = ttk.Scrollbar(file1_preview_frame, orient=tk.HORIZONTAL)
        file1_h_scroll.pack(side=tk.BOTTOM, fill=tk.X, pady=(2, 0))
        file1_table_frame = ttk.Frame(file1_preview_frame)
        file1_table_frame.pack(fill=tk.BOTH, expand=True)
        self.file1_tree = ttk.Treeview(file1_table_frame, height=15, show='headings')
        self.file1_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.file1_tree.configure(selectmode='extended')
        file1_v_scroll = ttk.Scrollbar(file1_table_frame, orient=tk.VERTICAL, command=self.file1_tree.yview)
        file1_v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.file1_tree.configure(yscrollcommand=file1_v_scroll.set)
        file1_h_scroll.config(command=self.file1_tree.xview)
        self.file1_tree.configure(xscrollcommand=file1_h_scroll.set)
        
        # 文件2预览（同样先 pack 底部横向滚动条）
        file2_preview_frame = ttk.Frame(self.preview_notebook)
        self.file2_preview_tab_text = "处置清单" if is_supplement_mode else "原始文件2"
        self.preview_notebook.add(file2_preview_frame, text=self.file2_preview_tab_text)
        file2_h_scroll = ttk.Scrollbar(file2_preview_frame, orient=tk.HORIZONTAL)
        file2_h_scroll.pack(side=tk.BOTTOM, fill=tk.X, pady=(2, 0))
        file2_table_frame = ttk.Frame(file2_preview_frame)
        file2_table_frame.pack(fill=tk.BOTH, expand=True)
        self.file2_tree = ttk.Treeview(file2_table_frame, height=15, show='headings')
        self.file2_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.file2_tree.configure(selectmode='extended')
        file2_v_scroll = ttk.Scrollbar(file2_table_frame, orient=tk.VERTICAL, command=self.file2_tree.yview)
        file2_v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.file2_tree.configure(yscrollcommand=file2_v_scroll.set)
        file2_h_scroll.config(command=self.file2_tree.xview)
        self.file2_tree.configure(xscrollcommand=file2_h_scroll.set)
        
        # 绑定右键菜单到预览表格
        self.file1_tree.bind('<Button-3>', lambda e: self._show_header_row_menu(e, 1))
        self.file2_tree.bind('<Button-3>', lambda e: self._show_header_row_menu(e, 2))
        
        # 绑定 Shift+滚轮 为横向滚动，便于列多时左右查看
        def _on_shift_wheel_hscroll(tree, event):
            try:
                delta = int(-1 * (event.delta / 120)) if hasattr(event, 'delta') else 0
                if delta != 0:
                    tree.xview_scroll(delta, 'units')
                    return 'break'
            except Exception:
                pass
        self.file1_tree.bind('<Shift-MouseWheel>', lambda e: _on_shift_wheel_hscroll(self.file1_tree, e))
        self.file2_tree.bind('<Shift-MouseWheel>', lambda e: _on_shift_wheel_hscroll(self.file2_tree, e))
        
        # ==================== 右下：字段映射配置区域 ====================
        mapping_frame = ttk.LabelFrame(main_container, text="字段映射配置（自动预映射，可手动调整）", padding="5")
        mapping_frame.grid(row=1, column=1, sticky="nsew", padx=(2, 5), pady=(2, 0))
        mapping_frame.grid_propagate(False)  # 锁定区域大小
        
        # 取 ttk 主题的 Frame 背景色，保证 canvas 与 ttk 控件视觉一致
        # （Toplevel 与 Tk 根窗口共享同一 Tcl 解释器，但 canvas 默认背景在不同宿主下
        #   渲染上下文有差异，显式指定可消除差异并避免 Combobox 退化为按钮外观）
        _style = ttk.Style()
        _canvas_bg = _style.lookup('TFrame', 'background') or 'SystemButtonFace'

        mapping_canvas = tk.Canvas(
            mapping_frame,
            bg=_canvas_bg,
            highlightthickness=0,
            bd=0,
        )
        mapping_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        mapping_scrollbar = ttk.Scrollbar(mapping_frame, orient=tk.VERTICAL, command=mapping_canvas.yview)
        mapping_canvas.configure(yscrollcommand=mapping_scrollbar.set)
        mapping_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        mapping_inner = ttk.Frame(mapping_canvas)
        _mapping_window = mapping_canvas.create_window((0, 0), window=mapping_inner, anchor='nw')

        # 让内部 Frame 宽度随 canvas 宽度自适应，避免右侧留白
        def _on_canvas_resize(event, canvas=mapping_canvas, win_id=_mapping_window):
            canvas.itemconfig(win_id, width=event.width)
        mapping_canvas.bind('<Configure>', _on_canvas_resize)
        self.mapping_row_frames = {}
        self.mapping_row_controls = {}
        
        # 固定宽度的下拉框
        COMBO_WIDTH = 15
        
        def create_mapping_row(parent, label_text, var1, var2, col_type):
            row_frame = ttk.Frame(parent)
            row_frame.pack(fill=tk.X, pady=2, padx=5)
            label_widget = ttk.Label(row_frame, text=label_text, width=14)
            label_widget.pack(side=tk.LEFT, padx=(0, 5))
            combo1 = ttk.Combobox(row_frame, textvariable=var1, state="readonly", width=COMBO_WIDTH)
            combo1.pack(side=tk.LEFT, padx=(0, 10))
            combo1.bind('<Button-3>', lambda e, ct=col_type: self._show_column_selection_menu(e, ct, 1))
            combo2 = ttk.Combobox(row_frame, textvariable=var2, state="readonly", width=COMBO_WIDTH)
            combo2.pack(side=tk.LEFT, padx=(0, 5))
            combo2.bind('<Button-3>', lambda e, ct=col_type: self._show_column_selection_menu(e, ct, 2))
            self.mapping_row_frames[col_type] = row_frame
            self.mapping_row_controls[col_type] = {"label": label_widget, "combo1": combo1, "combo2": combo2}
            return combo1, combo2
        
        # 标题行
        header_frame = ttk.Frame(mapping_inner)
        header_frame.pack(fill=tk.X, pady=2, padx=5)
        ttk.Label(header_frame, text="映射字段", width=14, font=("Arial", 9, "bold")).pack(side=tk.LEFT, padx=(0, 5))
        self.mapping_file1_label = ttk.Label(header_frame, text="新增清单" if is_supplement_mode else "原始文件1", width=COMBO_WIDTH, font=("Arial", 9, "bold"))
        self.mapping_file1_label.pack(side=tk.LEFT, padx=(0, 10))
        self.mapping_file2_label = ttk.Label(header_frame, text="处置清单" if is_supplement_mode else "原始文件2", width=COMBO_WIDTH, font=("Arial", 9, "bold"))
        self.mapping_file2_label.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Separator(mapping_inner, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=3)
        
        self.category_col1_combo, self.category_col2_combo = create_mapping_row(mapping_inner, "资产类别:", self.category_col1_var, self.category_col2_var, 'category')
        self.name_col1_combo, self.name_col2_combo = create_mapping_row(mapping_inner, "固定资产名称:", self.name_col1_var, self.name_col2_var, 'name')
        self.date_col1_combo, self.date_col2_combo = create_mapping_row(mapping_inner, "入账开始日期:", self.date_col1_var, self.date_col2_var, 'date')
        self.life_col1_combo, self.life_col2_combo = create_mapping_row(mapping_inner, "使用寿命(月):", self.life_col1_var, self.life_col2_var, 'life')
        self.residual_col1_combo, self.residual_col2_combo = create_mapping_row(mapping_inner, "残值率:", self.residual_col1_var, self.residual_col2_var, 'residual')
        self.current_year_dep_col1_combo, self.current_year_dep_col2_combo = create_mapping_row(mapping_inner, "本年折旧:", self.current_year_dep_col1_var, self.current_year_dep_col2_var, 'current_year_dep')
        
        ttk.Separator(mapping_inner, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=3)
        
        self.orig_col1_combo, self.orig_col2_combo = create_mapping_row(mapping_inner, "原值:", self.original_value_col1_var, self.original_value_col2_var, 'original_value')
        self.dep_col1_combo, self.dep_col2_combo = create_mapping_row(mapping_inner, "累计折旧:", self.depreciation_col1_var, self.depreciation_col2_var, 'depreciation')
        self.addition_method_col1_combo, self.addition_method_col2_combo = create_mapping_row(mapping_inner, "新增方式:", self.addition_method_col1_var, self.addition_method_col2_var, 'addition_method')
        self.addition_date_col1_combo, self.addition_date_col2_combo = create_mapping_row(mapping_inner, "新增时间:", self.addition_date_col1_var, self.addition_date_col2_var, 'addition_date')
        self.disposal_method_col1_combo, self.disposal_method_col2_combo = create_mapping_row(mapping_inner, "处置方式:", self.disposal_method_col1_var, self.disposal_method_col2_var, 'disposal_method')
        self.disposal_date_col1_combo, self.disposal_date_col2_combo = create_mapping_row(mapping_inner, "处置时间:", self.disposal_date_col1_var, self.disposal_date_col2_var, 'disposal_date')
        self.disposal_orig_col1_combo, self.disposal_orig_col2_combo = create_mapping_row(mapping_inner, "处置原值:", self.disposal_orig_col1_var, self.disposal_orig_col2_var, 'disposal_orig')
        self.disposal_dep_col1_combo, self.disposal_dep_col2_combo = create_mapping_row(mapping_inner, "处置折旧:", self.disposal_dep_col1_var, self.disposal_dep_col2_var, 'disposal_dep')
        
        ttk.Separator(mapping_inner, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=3)
        self.depreciation_param_frame = ttk.Frame(mapping_inner)
        self.depreciation_param_frame.pack(fill=tk.X, pady=2, padx=5)
        ttk.Label(self.depreciation_param_frame, text="资产负债表日:", width=14).pack(side=tk.LEFT, padx=(0, 5))
        self.balance_sheet_date_entry = ttk.Entry(self.depreciation_param_frame, textvariable=self.balance_sheet_date_var, width=15)
        self.balance_sheet_date_entry.pack(side=tk.LEFT, padx=(0, 8))
        ttk.Label(self.depreciation_param_frame, text="用于导出折旧测算公式，格式 YYYY/MM/DD", font=("Arial", 8), foreground="gray").pack(side=tk.LEFT)

        if is_supplement_mode:
            file1_allowed = {'addition_method', 'addition_date'}
            file2_allowed = {'disposal_method', 'disposal_date', 'disposal_orig', 'disposal_dep'}
            visible_rows = file1_allowed | file2_allowed
            for row_type, row_widget in self.mapping_row_frames.items():
                if row_type not in visible_rows:
                    row_widget.pack_forget()
                    continue
                ctrls = self.mapping_row_controls.get(row_type, {})
                combo1 = ctrls.get("combo1")
                combo2 = ctrls.get("combo2")
                if combo1 is not None:
                    if row_type in file1_allowed:
                        combo1.configure(state="readonly")
                    else:
                        combo1.set("")
                        combo1.configure(state="disabled")
                if combo2 is not None:
                    if row_type in file2_allowed:
                        combo2.configure(state="readonly")
                    else:
                        combo2.set("")
                        combo2.configure(state="disabled")
            self.depreciation_param_frame.pack_forget()
        else:
            hide_rows = {'addition_method', 'addition_date', 'disposal_method', 'disposal_date', 'disposal_orig', 'disposal_dep'}
            for row_type in hide_rows:
                row_widget = self.mapping_row_frames.get(row_type)
                if row_widget is not None:
                    row_widget.pack_forget()
            self.current_year_dep_col1_var.set("")
            self.current_year_dep_col1_combo.set("")
            self.current_year_dep_col1_combo.configure(state="disabled")
        
        mapping_inner.update_idletasks()
        mapping_canvas.configure(scrollregion=mapping_canvas.bbox('all'))

        # 当内部 Frame 尺寸变化时更新 scrollregion
        def _update_scrollregion(event, canvas=mapping_canvas):
            canvas.configure(scrollregion=canvas.bbox('all'))
        mapping_inner.bind('<Configure>', _update_scrollregion)
        
        def on_mousewheel(event):
            mapping_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
            return "break"
        mapping_canvas.bind("<MouseWheel>", on_mousewheel)
    
    def _select_file1(self):
        """选择原始文件1"""
        file_path = filedialog.askopenfilename(
            title="选择文件",
            filetypes=[
                ("所有支持格式", "*.xlsx *.xls *.csv"),
                ("Excel文件", "*.xlsx *.xls"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.file1_path_var.set(file_path)
            # 确保变量已更新后再更新标签
            self.update_idletasks()  # 确保Tkinter变量已更新
            self._update_file_labels()
            self._load_file1_sheets(file_path)
            # 不立即加载，等待用户选择sheet
    
    def _select_file2(self):
        """选择原始文件2"""
        file_path = filedialog.askopenfilename(
            title="选择文件",
            filetypes=[
                ("所有支持格式", "*.xlsx *.xls *.csv"),
                ("Excel文件", "*.xlsx *.xls"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.file2_path_var.set(file_path)
            # 确保变量已更新后再更新标签
            self.update_idletasks()  # 确保Tkinter变量已更新
            self._update_file_labels()
            self._load_file2_sheets(file_path)
            # 不立即加载，等待用户选择sheet
    
    def _load_file1_sheets(self, file_path: str):
        """加载文件1的工作表列表"""
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        progress_window.geometry("300x120")
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        file_name = os.path.basename(file_path)
        ttk.Label(progress_window, text=f"正在识别{file_name}格式，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        
        # 在后台线程中获取工作表列表
        def get_sheets_task():
            try:
                if ext in ['.xlsx', '.xls']:
                    if self.status_callback:
                        self.after(0, lambda: self.status_callback(f"正在识别{file_name}格式，请稍候..."))
                    success, error_msg, sheets = self.file_handler.get_excel_sheets(file_path)
                    self.after(0, lambda: self._on_sheets_loaded(1, success, error_msg, sheets, progress_window))
                else:
                    # CSV文件，直接加载
                    self.after(0, lambda: progress_window.destroy())
                    self.after(0, lambda: self._load_file1())
            except Exception as e:
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: messagebox.showerror("错误", f"获取工作表列表失败:\n{str(e)}"))
        
        threading.Thread(target=get_sheets_task, daemon=True).start()
    
    def _on_sheets_loaded(self, file_num, success, error_msg, sheets, progress_window):
        """工作表列表加载完成回调"""
        progress_window.destroy()
        
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._on_sheets_loaded.entry", message="sheets loaded callback", data={"file_num": file_num, "success": success, "sheets_count": len(sheets) if sheets else 0, "sheets": sheets[:5] if sheets else []})
        # #endregion
        
        if file_num == 1:
            if success and sheets:
                self.file1_sheet_combo['values'] = sheets
                # 工作表选择框已经在file1_frame中，不需要单独pack
                # 更新标签显示（即使还没选择sheet，也显示文件名）
                self._update_file_labels()
                # 提示用户选择sheet
                file_display_name = self._get_file_display_name(1)
                if len(sheets) > 1:
                    messagebox.showinfo("提示", f"请为{file_display_name}选择工作表（当前有{len(sheets)}个工作表）")
                else:
                    # 如果只有一个sheet，自动选择并加载
                    self.file1_sheet_var.set(sheets[0])
                    self._load_file1()
            else:
                # CSV文件没有工作表选择框，直接加载
                self._load_file1()
        else:
            if success and sheets:
                self.file2_sheet_combo['values'] = sheets
                # 工作表选择框已经在file2_frame中，不需要单独pack
                # 更新标签显示（即使还没选择sheet，也显示文件名）
                self._update_file_labels()
                # 提示用户选择sheet
                file_display_name = self._get_file_display_name(2)
                if len(sheets) > 1:
                    messagebox.showinfo("提示", f"请为{file_display_name}选择工作表（当前有{len(sheets)}个工作表）")
                else:
                    # 如果只有一个sheet，自动选择并加载
                    self.file2_sheet_var.set(sheets[0])
                    self._load_file2()
            else:
                # CSV文件没有工作表选择框，直接加载
                self._load_file2()
    
    def _load_file2_sheets(self, file_path: str):
        """加载文件2的工作表列表"""
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        progress_window.geometry("300x120")
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        file_name = os.path.basename(file_path)
        ttk.Label(progress_window, text=f"正在识别{file_name}格式，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        
        # 在后台线程中获取工作表列表
        def get_sheets_task():
            try:
                if ext in ['.xlsx', '.xls']:
                    if self.status_callback:
                        self.after(0, lambda: self.status_callback(f"正在识别{file_name}格式，请稍候..."))
                    success, error_msg, sheets = self.file_handler.get_excel_sheets(file_path)
                    self.after(0, lambda: self._on_sheets_loaded(2, success, error_msg, sheets, progress_window))
                else:
                    # CSV文件，直接加载
                    self.after(0, lambda: progress_window.destroy())
                    self.after(0, lambda: self._load_file2())
            except Exception as e:
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: messagebox.showerror("错误", f"获取工作表列表失败:\n{str(e)}"))
        
        threading.Thread(target=get_sheets_task, daemon=True).start()
    
    def _load_file1(self):
        """加载文件1"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        file_path = self.file1_path_var.get()
        if not file_path:
            return
        
        file_display_name = self._get_file_display_name(1)
        
        # 检查Excel文件是否已选择sheet
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        if ext in ['.xlsx', '.xls']:
            sheet_name = self.file1_sheet_var.get()
            if not sheet_name:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._load_file1.no_sheet", message="no sheet selected for excel file", data={"file_path": file_path})
                # #endregion
                messagebox.showwarning("提示", f"请为{file_display_name}选择工作表")
                return
        
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        progress_window.geometry("300x120")
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        ttk.Label(progress_window, text=f"正在读取{file_display_name}，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        if self.status_callback:
            self.status_callback(f"正在读取{file_display_name}，请稍候...")
        
        sheet_name = self.file1_sheet_var.get() if self.file1_sheet_var.get() else None
        # 使用file1_header_row作为header参数
        # file1_header_row初始值为0，表示使用默认第一行作为标题行（header=None）
        # 如果用户通过右键设置了标题行，file1_header_row会是预览中的行索引（0-based数据行）
        # 需要转换为文件的0-based行索引：header_0based = row_index + 1
        header_row = getattr(self, 'file1_header_row', 0)
        # 如果header_row为0，使用None（pandas默认第一行作为标题行）
        # 如果header_row > 0，说明用户设置了标题行，需要转换为文件的0-based索引
        header_0based = None if header_row == 0 else (header_row + 1)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._load_file1.entry", message="loading file1", data={"file_path": file_path, "sheet_name": sheet_name, "header_row": header_row, "header_0based": header_0based})
        # #endregion
        
        # 在后台线程中加载文件
        def load_task():
            try:
                success, error_msg = self.file_handler.set_file1(file_path, sheet_name, header_0based)
                self.after(0, lambda: self._on_file1_loaded(success, error_msg, file_display_name, progress_window))
            except Exception as e:
                self.after(0, lambda: self._on_file1_loaded(False, str(e), file_display_name, progress_window))
        
        threading.Thread(target=load_task, daemon=True).start()
    
    def _on_file1_loaded(self, success, error_msg, file_display_name, progress_window):
        """文件1加载完成回调"""
        progress_window.destroy()
        
        if success:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file1_loaded.success", message="file1 loaded", data={"rows": len(self.file_handler.file1_df) if self.file_handler.file1_df is not None else 0, "cols": len(self.file_handler.file1_df.columns) if self.file_handler.file1_df is not None else 0, "columns": list(self.file_handler.file1_df.columns)[:5] if self.file_handler.file1_df is not None else [], "first_row_sample": list(self.file_handler.file1_df.iloc[0, :5]) if self.file_handler.file1_df is not None and len(self.file_handler.file1_df) > 0 else []})
            # #endregion
            
            # 检查标题行识别是否正确（如果列名看起来像数据值，可能需要调整）
            if self.file_handler.file1_df is not None and len(self.file_handler.file1_df.columns) > 0:
                first_col_name = str(self.file_handler.file1_df.columns[0])
                # 如果列名看起来像数据值（包含逗号、数字、日期格式等），可能是标题行识别错误
                looks_like_data = (
                    ',' in first_col_name or  # 包含逗号（如"固定资产,电子设备"）
                    (len(first_col_name) > 0 and first_col_name[0].isdigit()) or  # 以数字开头
                    len(first_col_name) > 50  # 列名过长
                )
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file1_loaded.header_check", message="checking if header looks like data", data={"first_col_name": first_col_name, "looks_like_data": looks_like_data})
                # #endregion
                if looks_like_data:
                    # 提示用户可能需要设置标题行
                    messagebox.showwarning("提示", f"{file_display_name}的标题行可能识别不正确。\n如果列名显示为数据值，请在预览区域右键点击正确的标题行，选择\"设本行为标题行\"。")
            
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取完成")
            # 立即更新标签，确保sheet变量已设置
            self._update_file_labels()
            self._update_file1_preview()
            self._update_match_columns()
        else:
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取失败")
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._on_file1_loaded.failed", message="file1 load failed", data={"error": error_msg})
            # #endregion
            messagebox.showerror("错误", f"加载{file_display_name}失败:\n{error_msg}")
    
    def _load_file2(self):
        """加载文件2"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        #endregion
        
        file_path = self.file2_path_var.get()
        if not file_path:
            return
        
        file_display_name = self._get_file_display_name(2)
        
        # 检查Excel文件是否已选择sheet
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        if ext in ['.xlsx', '.xls']:
            sheet_name = self.file2_sheet_var.get()
            if not sheet_name:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._load_file2.no_sheet", message="no sheet selected for excel file", data={"file_path": file_path})
                # #endregion
                messagebox.showwarning("提示", f"请为{file_display_name}选择工作表")
                return
        
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        progress_window.geometry("300x120")
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        ttk.Label(progress_window, text=f"正在读取{file_display_name}，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        if self.status_callback:
            self.status_callback(f"正在读取{file_display_name}，请稍候...")
        
        sheet_name = self.file2_sheet_var.get() if self.file2_sheet_var.get() else None
        # 使用file2_header_row作为header参数
        # file2_header_row初始值为0，表示使用默认第一行作为标题行（header=None）
        # 如果用户通过右键设置了标题行，file2_header_row会是预览中的行索引（0-based数据行）
        # 需要转换为文件的0-based行索引：header_0based = row_index + 1
        header_row = getattr(self, 'file2_header_row', 0)
        # 如果header_row为0，使用None（pandas默认第一行作为标题行）
        # 如果header_row > 0，说明用户设置了标题行，需要转换为文件的0-based索引
        header_0based = None if header_row == 0 else (header_row + 1)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._load_file2.entry", message="loading file2", data={"file_path": file_path, "sheet_name": sheet_name, "header_row": header_row, "header_0based": header_0based})
        # #endregion
        
        # 在后台线程中加载文件
        def load_task():
            try:
                success, error_msg = self.file_handler.set_file2(file_path, sheet_name, header_0based)
                self.after(0, lambda: self._on_file2_loaded(success, error_msg, file_display_name, progress_window))
            except Exception as e:
                self.after(0, lambda: self._on_file2_loaded(False, str(e), file_display_name, progress_window))
        
        threading.Thread(target=load_task, daemon=True).start()
    
    def _on_file2_loaded(self, success, error_msg, file_display_name, progress_window):
        """文件2加载完成回调"""
        progress_window.destroy()
        
        if success:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file2_loaded.success", message="file2 loaded", data={"rows": len(self.file_handler.file2_df) if self.file_handler.file2_df is not None else 0, "cols": len(self.file_handler.file2_df.columns) if self.file_handler.file2_df is not None else 0, "columns": list(self.file_handler.file2_df.columns)[:5] if self.file_handler.file2_df is not None else [], "first_row_sample": list(self.file_handler.file2_df.iloc[0, :5]) if self.file_handler.file2_df is not None and len(self.file_handler.file2_df) > 0 else []})
            # #endregion
            
            # 检查标题行识别是否正确（如果列名看起来像数据值，可能需要调整）
            if self.file_handler.file2_df is not None and len(self.file_handler.file2_df.columns) > 0:
                first_col_name = str(self.file_handler.file2_df.columns[0])
                # 如果列名看起来像数据值（包含逗号、数字、日期格式等），可能是标题行识别错误
                looks_like_data = (
                    ',' in first_col_name or  # 包含逗号（如"固定资产,电子设备"）
                    (len(first_col_name) > 0 and first_col_name[0].isdigit()) or  # 以数字开头
                    len(first_col_name) > 50  # 列名过长
                )
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file2_loaded.header_check", message="checking if header looks like data", data={"first_col_name": first_col_name, "looks_like_data": looks_like_data})
                # #endregion
                if looks_like_data:
                    # 提示用户可能需要设置标题行
                    messagebox.showwarning("提示", f"{file_display_name}的标题行可能识别不正确。\n如果列名显示为数据值，请在预览区域右键点击正确的标题行，选择\"设本行为标题行\"。")
            
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取完成")
            # 立即更新标签，确保sheet变量已设置
            self._update_file_labels()
            self._update_file2_preview()
            self._update_match_columns()
        else:
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取失败")
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._on_file2_loaded.failed", message="file2 load failed", data={"error": error_msg})
            # #endregion
            messagebox.showerror("错误", f"加载{file_display_name}失败:\n{error_msg}")
    
    def _update_file1_preview(self):
        """更新文件1预览"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.entry", message="updating file1 preview", data={"file1_df_is_none": self.file_handler.file1_df is None})
        # #endregion
        
        if self.file_handler.file1_df is None:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.no_df", message="file1_df is None, returning")
            # #endregion
            return
        
        # 清除现有数据
        for item in self.file1_tree.get_children():
            self.file1_tree.delete(item)
        
        preview_df = self.file_handler.get_file1_preview(PREVIEW_ROWS)
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.preview_df", message="got preview_df", data={"preview_df_is_none": preview_df is None, "preview_df_empty": preview_df.empty if preview_df is not None else None, "preview_rows": len(preview_df) if preview_df is not None else 0, "preview_cols": len(preview_df.columns) if preview_df is not None else 0})
        # #endregion
        
        if preview_df is None or preview_df.empty:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.empty_df", message="preview_df is None or empty, returning")
            # #endregion
            return
        
        # 配置列
        columns = list(preview_df.columns)
        col_ids = [f"c{i}" for i in range(len(columns))]
        self.file1_tree['columns'] = col_ids
        self.file1_tree['show'] = 'headings'
        
        # 设置固定的小列宽，确保总宽度可控
        # 即使列很多，Treeview的总宽度也不会撑大容器
        # 超出部分通过横向滚动条查看
        num_cols = len(columns)
        if num_cols > 0:
            # 根据列数动态调整列宽，但确保总宽度不超过400px
            # 每列宽度 = min(80, max(50, 400 / 列数))
            col_width = min(80, max(50, 400 // num_cols))
        else:
            col_width = 70
        
        for i, col in enumerate(columns):
            cid = col_ids[i]
            self.file1_tree.heading(cid, text=str(col))
            # 固定列宽，禁用自动调整，防止预览区域突然扩大
            self.file1_tree.column(cid, width=col_width, minwidth=50, stretch=False)
        
        # 插入数据
        for j in range(len(preview_df)):
            values = []
            for i in range(len(columns)):
                val = preview_df.iloc[j, i]
                if pd.isna(val):
                    values.append('')
                else:
                    # 整数形式的浮点数（如 1100000.0）显示为整数，不显示 .0
                    if isinstance(val, float) and val == int(val):
                        val_str = str(int(val))
                    else:
                        val_str = str(val)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + '...'
                    values.append(val_str)
            self.file1_tree.insert('', tk.END, values=values)
    
    def _update_file_labels(self):
        """更新所有文件标签显示为"原始文件 & sheet名称"格式"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        file1_name = self._get_file_display_name(1)
        file2_name = self._get_file_display_name(2)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.entry", message="updating file labels", data={"file1_name": file1_name, "file2_name": file2_name, "file1_path": self.file1_path_var.get(), "file1_sheet": self.file1_sheet_var.get(), "file2_path": self.file2_path_var.get(), "file2_sheet": self.file2_sheet_var.get()})
        # #endregion
        
        # 更新文件选择区域的标签
        if hasattr(self, 'file1_label'):
            self.file1_label.config(text=f"{file1_name}:")
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_label", message="updated file1 label", data={"text": f"{file1_name}:"})
            # #endregion
        if hasattr(self, 'file2_label'):
            self.file2_label.config(text=f"{file2_name}:")
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_label", message="updated file2 label", data={"text": f"{file2_name}:"})
            # #endregion
        
        # 更新匹配列配置区域的标签
        if hasattr(self, 'match_file1_label'):
            self.match_file1_label.config(text=f"{file1_name}:")
        if hasattr(self, 'match_file2_label'):
            self.match_file2_label.config(text=f"{file2_name}:")
        
        # 更新数据类型区域的标签
        if hasattr(self, 'data_type_file2_label'):
            self.data_type_file2_label.config(text=f"{file2_name}:")
        
        # 更新字段映射配置区域的标签
        if hasattr(self, 'mapping_file1_label'):
            self.mapping_file1_label.config(text=file1_name)
        if hasattr(self, 'mapping_file2_label'):
            self.mapping_file2_label.config(text=file2_name)
        
        # 更新预览标签页
        if hasattr(self, 'preview_notebook'):
            try:
                # 更新文件1预览标签页（索引0）
                self.preview_notebook.tab(0, text=file1_name)
                self.file1_preview_tab_text = file1_name
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_tab", message="updated file1 tab", data={"text": file1_name})
                # #endregion
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_tab_error", message="error updating file1 tab", data={"error": str(e)})
                # #endregion
                pass
            try:
                # 更新文件2预览标签页（索引1）
                self.preview_notebook.tab(1, text=file2_name)
                self.file2_preview_tab_text = file2_name
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_tab", message="updated file2 tab", data={"text": file2_name})
                # #endregion
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_tab_error", message="error updating file2 tab", data={"error": str(e)})
                # #endregion
                pass
    
    def _update_file2_preview(self):
        """更新文件2预览"""
        if self.file_handler.file2_df is None:
            return
        
        # 清除现有数据
        for item in self.file2_tree.get_children():
            self.file2_tree.delete(item)
        
        preview_df = self.file_handler.get_file2_preview(PREVIEW_ROWS)
        if preview_df is None or preview_df.empty:
            return
        
        # 配置列
        columns = list(preview_df.columns)
        col_ids = [f"c{i}" for i in range(len(columns))]
        self.file2_tree['columns'] = col_ids
        self.file2_tree['show'] = 'headings'
        
        # 设置固定的小列宽，确保总宽度可控
        # 即使列很多，Treeview的总宽度也不会撑大容器
        # 超出部分通过横向滚动条查看
        num_cols = len(columns)
        if num_cols > 0:
            # 根据列数动态调整列宽，但确保总宽度不超过400px
            # 每列宽度 = min(80, max(50, 400 / 列数))
            col_width = min(80, max(50, 400 // num_cols))
        else:
            col_width = 70
        
        for i, col in enumerate(columns):
            cid = col_ids[i]
            self.file2_tree.heading(cid, text=str(col))
            # 固定列宽，禁用自动调整，防止预览区域突然扩大
            self.file2_tree.column(cid, width=col_width, minwidth=50, stretch=False)
        
        # 插入数据
        for j in range(len(preview_df)):
            values = []
            for i in range(len(columns)):
                val = preview_df.iloc[j, i]
                if pd.isna(val):
                    values.append('')
                else:
                    # 整数形式的浮点数（如 1100000.0）显示为整数，不显示 .0
                    if isinstance(val, float) and val == int(val):
                        val_str = str(int(val))
                    else:
                        val_str = str(val)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + '...'
                    values.append(val_str)
            self.file2_tree.insert('', tk.END, values=values)
    
    def _update_match_columns(self):
        """更新匹配列下拉框并自动预映射"""
        # 分别获取文件1、文件2的列，确保下拉框来源正确
        # 使用 list() 创建独立副本，避免共享引用
        if self.file_handler.file1_df is not None:
            cols1_raw = list(self.file_handler.get_file1_columns())
        else:
            cols1_raw = []
        
        if self.file_handler.file2_df is not None:
            cols2_raw = list(self.file_handler.get_file2_columns())
        else:
            cols2_raw = []
        
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        _dbg(sessionId="debug", runId="run1", hypothesisId="H6", location="file_and_match_config._update_match_columns.raw_cols", message="got raw columns", data={"cols1_count": len(cols1_raw), "cols2_count": len(cols2_raw), "cols1_sample": cols1_raw[:5] if cols1_raw else [], "cols2_sample": cols2_raw[:5] if cols2_raw else []})
        # #endregion
        
        # 移除列名中的"_文件1"和"_文件2"后缀（如果存在），因为这是合并时添加的，不应该在文件选择阶段显示
        # 注意：这里的列名应该来自原始文件，不应该有后缀，但为了安全起见，还是移除
        cols1 = [str(col).replace('_文件1', '').replace('_文件2', '') if '_文件1' in str(col) or '_文件2' in str(col) else str(col) for col in cols1_raw]
        cols2 = [str(col).replace('_文件1', '').replace('_文件2', '') if '_文件1' in str(col) or '_文件2' in str(col) else str(col) for col in cols2_raw]
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H6", location="file_and_match_config._update_match_columns.processed_cols", message="processed columns", data={"cols1_count": len(cols1), "cols2_count": len(cols2), "cols1_sample": cols1[:5] if cols1 else [], "cols2_sample": cols2[:5] if cols2 else []})
        # #endregion
        
        # 清空之前的配置，重新映射
        self.match_columns1 = []
        self.match_columns2 = []
        self.original_value_col1_var.set('')
        self.original_value_col2_var.set('')
        self.depreciation_col1_var.set('')
        self.depreciation_col2_var.set('')
        self.category_col1_var.set('')
        self.category_col2_var.set('')
        self.name_col1_var.set('')
        self.name_col2_var.set('')
        self.date_col1_var.set('')
        self.date_col2_var.set('')
        self.life_col1_var.set('')
        self.life_col2_var.set('')
        self.residual_col1_var.set('')
        self.residual_col2_var.set('')
        self.current_year_dep_col1_var.set('')
        self.current_year_dep_col2_var.set('')
        self.addition_method_col1_var.set('')
        self.addition_method_col2_var.set('')
        self.addition_date_col1_var.set('')
        self.addition_date_col2_var.set('')
        self.disposal_method_col1_var.set('')
        self.disposal_method_col2_var.set('')
        self.disposal_date_col1_var.set('')
        self.disposal_date_col2_var.set('')
        self.disposal_orig_col1_var.set('')
        self.disposal_orig_col2_var.set('')
        self.disposal_dep_col1_var.set('')
        self.disposal_dep_col2_var.set('')
        
        # 匹配列：文件1用cols1，文件2用cols2（更新Listbox）
        self.match_col1_listbox.delete(0, tk.END)
        for col in cols1:
            self.match_col1_listbox.insert(tk.END, col)
        
        self.match_col2_listbox.delete(0, tk.END)
        for col in cols2:
            self.match_col2_listbox.insert(tk.END, col)
        
        # #region agent log
        # 注意：匹配列已改为按钮形式，不再使用combo，所以这里不再记录combo的值
        _dbg(sessionId="debug", runId="run1", hypothesisId="H6", location="file_and_match_config._update_match_columns.set_combo", message="set combo values", data={"cols1_count": len(cols1), "cols2_count": len(cols2)})
        # #endregion
        
        # 更新所有字段映射下拉框的值
        all_combos_1 = [self.orig_col1_combo, self.dep_col1_combo, self.category_col1_combo,
                        self.name_col1_combo, self.date_col1_combo, self.life_col1_combo, self.residual_col1_combo, self.current_year_dep_col1_combo,
                        self.addition_method_col1_combo, self.addition_date_col1_combo, self.disposal_method_col1_combo,
                        self.disposal_date_col1_combo, self.disposal_orig_col1_combo, self.disposal_dep_col1_combo]
        all_combos_2 = [self.orig_col2_combo, self.dep_col2_combo, self.category_col2_combo,
                        self.name_col2_combo, self.date_col2_combo, self.life_col2_combo, self.residual_col2_combo, self.current_year_dep_col2_combo,
                        self.addition_method_col2_combo, self.addition_date_col2_combo, self.disposal_method_col2_combo,
                        self.disposal_date_col2_combo, self.disposal_orig_col2_combo, self.disposal_dep_col2_combo]
        
        # 添加"[不映射]"选项到下拉框。映射列 combo 的索引：0=[不映射]，1..n=cols[0..n-1]
        # 确保cols1和cols2是列表且不为空
        cols1_list = list(cols1) if cols1 else []
        cols2_list = list(cols2) if cols2 else []
        
        for combo in all_combos_1:
            if combo:
                combo['values'] = ['[不映射]'] + cols1_list
        for combo in all_combos_2:
            if combo:
                combo['values'] = ['[不映射]'] + cols2_list
        
        def _mapping_combo_index(col, cols):
            """映射列 combo 中列名对应的索引（含[不映射]在第0位）"""
            if not col or col not in cols:
                return 0  # 默认选[不映射]
            return 1 + cols.index(col)
        
        # 自动预映射匹配列（包含编码/编号）
        code_cols1 = [col for col in cols1 if '编码' in str(col) or '编号' in str(col)]
        code_cols2 = [col for col in cols2 if '编码' in str(col) or '编号' in str(col)]
        
        # 清空之前的选择
        self.match_col1_listbox.selection_clear(0, tk.END)
        self.match_col2_listbox.selection_clear(0, tk.END)
        
        if code_cols1 and code_cols2:
            # 自动选择第一个匹配的编码/编号列
            for col1 in code_cols1:
                for col2 in code_cols2:
                    col1_str = str(col1)
                    col2_str = str(col2)
                    if col1 == col2 or col1_str.lower() == col2_str.lower():
                        if col1 in cols1:
                            idx1 = cols1.index(col1)
                            self.match_col1_listbox.selection_set(idx1)
                            self.match_columns1 = [col1]
                        if col2 in cols2:
                            idx2 = cols2.index(col2)
                            self.match_col2_listbox.selection_set(idx2)
                            self.match_columns2 = [col2]
                        self._update_selected_match_columns(1)
                        self._update_selected_match_columns(2)
                        # 更新按钮文本
                        if hasattr(self, '_update_match_col1_button'):
                            self._update_match_col1_button()
                        if hasattr(self, '_update_match_col2_button'):
                            self._update_match_col2_button()
                        break
                if self.match_columns1:
                    break
            if not self.match_columns1 and code_cols1 and code_cols2:
                if code_cols1[0] in cols1:
                    idx1 = cols1.index(code_cols1[0])
                    self.match_col1_listbox.selection_set(idx1)
                    self.match_columns1 = [code_cols1[0]]
                if code_cols2[0] in cols2:
                    idx2 = cols2.index(code_cols2[0])
                    self.match_col2_listbox.selection_set(idx2)
                    self.match_columns2 = [code_cols2[0]]
                self._update_selected_match_columns(1)
                self._update_selected_match_columns(2)
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
        elif cols1 and cols2:
            # 回退到原有匹配逻辑
            matches = get_column_matches(cols1, cols2)
            if matches:
                col1, col2 = matches[0]
                if col1 in cols1:
                    idx1 = cols1.index(col1)
                    self.match_col1_listbox.selection_set(idx1)
                    self.match_columns1 = [col1]
                if col2 in cols2:
                    idx2 = cols2.index(col2)
                    self.match_col2_listbox.selection_set(idx2)
                    self.match_columns2 = [col2]
                self._update_selected_match_columns(1)
                self._update_selected_match_columns(2)
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
            else:
                if cols1:
                    self.match_col1_listbox.selection_set(0)
                    self.match_columns1 = [cols1[0]]
                if cols2:
                    self.match_col2_listbox.selection_set(0)
                    self.match_columns2 = [cols2[0]]
                self._update_selected_match_columns(1)
                self._update_selected_match_columns(2)
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
        
        # 通用预映射函数：精确匹配优先，包含匹配次之
        def auto_map_column(cols, exact_keywords, contain_keywords=None):
            """
            自动映射列：
            1. 先尝试列名完全等于精确关键词
            2. 再尝试列名包含精确关键词
            3. 最后尝试列名包含模糊关键词
            """
            if contain_keywords is None:
                contain_keywords = []
            
            # 1. 精确匹配：列名完全等于关键词
            for col in cols:
                if str(col) in exact_keywords:
                    return col
            
            # 2. 包含匹配：列名包含精确关键词
            for col in cols:
                for kw in exact_keywords:
                    if kw in str(col):
                        return col
            
            # 3. 包含匹配：列名包含模糊关键词
            for col in cols:
                for kw in contain_keywords:
                    if kw in str(col):
                        return col
            
            return None

        if self.mode == "supplement":
            addition_method_exact = ['新增方式', '增加方式', '取得方式', '资产来源', '新增来源']
            addition_method_contain = ['新增方式', '增加方式', '取得方式', '来源', '方式', '途径']
            addition_date_exact = ['新增时间', '增加时间', '取得日期', '日期', '时间', '时点']
            addition_date_contain = ['新增', '增加', '时间', '日期', '时点']

            disposal_method_exact = ['处置方式', '减少方式', '报废方式', '出售方式']
            disposal_method_contain = ['处置方式', '减少方式', '报废', '出售', '转出', '方式']
            disposal_date_exact = ['处置时间', '减少时间', '处置日期', '日期', '时间', '时点']
            disposal_date_contain = ['处置', '减少', '时间', '日期', '时点']
            disposal_orig_exact = ['处置原值', '减少原值', '原值减少', '处置成本']
            disposal_orig_contain = ['处置原值', '减少原值', '原值减少', '原值']
            disposal_dep_exact = ['处置折旧', '减少折旧', '累计折旧处置', '累计折旧减少']
            disposal_dep_contain = ['处置折旧', '减少折旧', '折旧减少', '累计折旧减少', '累计折旧处置']

            add_method_col1 = auto_map_column(cols1, addition_method_exact, addition_method_contain)
            add_date_col1 = auto_map_column(cols1, addition_date_exact, addition_date_contain)
            disp_method_col2 = auto_map_column(cols2, disposal_method_exact, disposal_method_contain)
            disp_date_col2 = auto_map_column(cols2, disposal_date_exact, disposal_date_contain)
            disp_orig_col2 = auto_map_column(cols2, disposal_orig_exact, disposal_orig_contain)
            disp_dep_col2 = auto_map_column(cols2, disposal_dep_exact, disposal_dep_contain)

            if add_method_col1:
                self.addition_method_col1_var.set(add_method_col1)
                if add_method_col1 in cols1:
                    self.addition_method_col1_combo.current(_mapping_combo_index(add_method_col1, cols1))
            if add_date_col1:
                self.addition_date_col1_var.set(add_date_col1)
                if add_date_col1 in cols1:
                    self.addition_date_col1_combo.current(_mapping_combo_index(add_date_col1, cols1))
            if disp_method_col2:
                self.disposal_method_col2_var.set(disp_method_col2)
                if disp_method_col2 in cols2:
                    self.disposal_method_col2_combo.current(_mapping_combo_index(disp_method_col2, cols2))
            if disp_date_col2:
                self.disposal_date_col2_var.set(disp_date_col2)
                if disp_date_col2 in cols2:
                    self.disposal_date_col2_combo.current(_mapping_combo_index(disp_date_col2, cols2))
            if disp_orig_col2:
                self.disposal_orig_col2_var.set(disp_orig_col2)
                if disp_orig_col2 in cols2:
                    self.disposal_orig_col2_combo.current(_mapping_combo_index(disp_orig_col2, cols2))
            if disp_dep_col2:
                self.disposal_dep_col2_var.set(disp_dep_col2)
                if disp_dep_col2 in cols2:
                    self.disposal_dep_col2_combo.current(_mapping_combo_index(disp_dep_col2, cols2))
            return
        
        # 自动预映射原值列
        orig_exact = ['原值', '资产原值', '固定资产原值']
        orig_contain = ['成本', '入账价值']
        
        orig_col1 = auto_map_column(cols1, orig_exact, orig_contain)
        orig_col2 = auto_map_column(cols2, orig_exact, orig_contain)
        
        if orig_col1:
            self.original_value_col1_var.set(orig_col1)
            if orig_col1 in cols1:
                self.orig_col1_combo.current(_mapping_combo_index(orig_col1, cols1))
        if orig_col2:
            self.original_value_col2_var.set(orig_col2)
            if orig_col2 in cols2:
                self.orig_col2_combo.current(_mapping_combo_index(orig_col2, cols2))
        
        # 自动预映射累计折旧列
        # 精确匹配关键词
        dep_exact = ['累计折旧', '年末累计折旧', '期末累计折旧']
        # 包含匹配关键词（只匹配"累计折旧"，不单独匹配"折旧"）
        dep_contain = ['累计折旧']
        
        dep_col1 = auto_map_column(cols1, dep_exact, dep_contain)
        dep_col2 = auto_map_column(cols2, dep_exact, dep_contain)
        
        if dep_col1:
            self.depreciation_col1_var.set(dep_col1)
            if dep_col1 in cols1:
                self.dep_col1_combo.current(_mapping_combo_index(dep_col1, cols1))
        if dep_col2:
            self.depreciation_col2_var.set(dep_col2)
            if dep_col2 in cols2:
                self.dep_col2_combo.current(_mapping_combo_index(dep_col2, cols2))
        
        # 自动预映射资产类别列
        def is_numeric_field(col_str):
            numeric_keywords = ['原值', '累计折旧', '成本', '净值', '残值', '减值', '折旧', '金额', '价值']
            for keyword in numeric_keywords:
                if keyword in col_str:
                    return True
            return False
        
        category_exact = ['资产类别', '资产大类', '固定资产类别', '类别', '大类']
        category_contain = ['种类', '分类']
        
        # 精确匹配
        category_col1 = None
        category_col2 = None
        for col in cols1:
            if str(col) in category_exact and not is_numeric_field(str(col)):
                category_col1 = col
                break
        for col in cols2:
            if str(col) in category_exact and not is_numeric_field(str(col)):
                category_col2 = col
                break
        
        # 包含匹配
        if not category_col1:
            for col in cols1:
                col_str = str(col)
                if not is_numeric_field(col_str):
                    for kw in category_exact + category_contain:
                        if kw in col_str:
                            category_col1 = col
                            break
                if category_col1:
                    break
        if not category_col2:
            for col in cols2:
                col_str = str(col)
                if not is_numeric_field(col_str):
                    for kw in category_exact + category_contain:
                        if kw in col_str:
                            category_col2 = col
                            break
                if category_col2:
                    break
        
        if category_col1:
            self.category_col1_var.set(category_col1)
            if category_col1 in cols1:
                self.category_col1_combo.current(_mapping_combo_index(category_col1, cols1))
        if category_col2:
            self.category_col2_var.set(category_col2)
            if category_col2 in cols2:
                self.category_col2_combo.current(_mapping_combo_index(category_col2, cols2))
        
        # 自动预映射固定资产名称列
        name_exact = ['资产名称', '固定资产名称', '名称', '资产描述']
        name_contain = ['描述', '资产名']
        
        name_col1 = auto_map_column(cols1, name_exact, name_contain)
        name_col2 = auto_map_column(cols2, name_exact, name_contain)
        
        if name_col1:
            self.name_col1_var.set(name_col1)
            if name_col1 in cols1:
                self.name_col1_combo.current(_mapping_combo_index(name_col1, cols1))
        if name_col2:
            self.name_col2_var.set(name_col2)
            if name_col2 in cols2:
                self.name_col2_combo.current(_mapping_combo_index(name_col2, cols2))
        
        # 自动预映射入账开始日期列
        # 精确匹配关键词（优先）
        date_exact_keywords = ['入账日期', '开始日期', '购置日期', '取得日期', '启用日期', '资本化日期']
        # 包含匹配关键词（次优先）
        date_contain_keywords = ['日期', '时间']
        
        # 先尝试精确匹配
        date_cols1 = [col for col in cols1 if str(col) in date_exact_keywords]
        date_cols2 = [col for col in cols2 if str(col) in date_exact_keywords]
        # 如果精确匹配失败，尝试包含匹配（精确关键词）
        if not date_cols1:
            date_cols1 = [col for col in cols1 if any(kw in str(col) for kw in date_exact_keywords)]
        if not date_cols2:
            date_cols2 = [col for col in cols2 if any(kw in str(col) for kw in date_exact_keywords)]
        # 如果还是没有，尝试包含匹配（模糊关键词）
        if not date_cols1:
            date_cols1 = [col for col in cols1 if any(kw in str(col) for kw in date_contain_keywords)]
        if not date_cols2:
            date_cols2 = [col for col in cols2 if any(kw in str(col) for kw in date_contain_keywords)]
        
        if date_cols1:
            self.date_col1_var.set(date_cols1[0])
            if date_cols1[0] in cols1:
                self.date_col1_combo.current(_mapping_combo_index(date_cols1[0], cols1))
        if date_cols2:
            self.date_col2_var.set(date_cols2[0])
            if date_cols2[0] in cols2:
                self.date_col2_combo.current(_mapping_combo_index(date_cols2[0], cols2))
        
        # 自动预映射使用寿命列（排除包含“剩余”的字段）
        # 精确匹配关键词（优先）
        life_exact_keywords = ['使用寿命', '预计寿命', '使用年限']
        # 包含匹配关键词（次优先）
        life_contain_keywords = ['寿命', '年限','计划']
        def _life_col_allowed(col):
            return '剩余' not in str(col)
        
        # 先尝试精确匹配
        life_cols1 = [col for col in cols1 if str(col) in life_exact_keywords and _life_col_allowed(col)]
        life_cols2 = [col for col in cols2 if str(col) in life_exact_keywords and _life_col_allowed(col)]
        # 如果精确匹配失败，尝试包含匹配（精确关键词）
        if not life_cols1:
            life_cols1 = [col for col in cols1 if _life_col_allowed(col) and any(kw in str(col) for kw in life_exact_keywords)]
        if not life_cols2:
            life_cols2 = [col for col in cols2 if _life_col_allowed(col) and any(kw in str(col) for kw in life_exact_keywords)]
        # 如果还是没有，尝试包含匹配（模糊关键词）
        if not life_cols1:
            life_cols1 = [col for col in cols1 if _life_col_allowed(col) and any(kw in str(col) for kw in life_contain_keywords)]
        if not life_cols2:
            life_cols2 = [col for col in cols2 if _life_col_allowed(col) and any(kw in str(col) for kw in life_contain_keywords)]
        
        if life_cols1:
            self.life_col1_var.set(life_cols1[0])
            if life_cols1[0] in cols1:
                self.life_col1_combo.current(_mapping_combo_index(life_cols1[0], cols1))
        if life_cols2:
            self.life_col2_var.set(life_cols2[0])
            if life_cols2[0] in cols2:
                self.life_col2_combo.current(_mapping_combo_index(life_cols2[0], cols2))
        
        # 自动预映射残值率列
        residual_exact = ['残值率', '预计残值率', '净残值率']
        residual_contain = ['残值']
        
        residual_col1 = auto_map_column(cols1, residual_exact, residual_contain)
        residual_col2 = auto_map_column(cols2, residual_exact, residual_contain)
        
        if residual_col1:
            self.residual_col1_var.set(residual_col1)
            if residual_col1 in cols1:
                self.residual_col1_combo.current(_mapping_combo_index(residual_col1, cols1))
        if residual_col2:
            self.residual_col2_var.set(residual_col2)
            if residual_col2 in cols2:
                self.residual_col2_combo.current(_mapping_combo_index(residual_col2, cols2))

        current_year_dep_exact = ['本年折旧', '年折旧额', '本期折旧']
        current_year_dep_contain = ['本年折旧']

        current_year_dep_col2 = auto_map_column(cols2, current_year_dep_exact, current_year_dep_contain)

        self.current_year_dep_col1_var.set("")
        self.current_year_dep_col1_combo.set("")
        self.current_year_dep_col1_combo.configure(state="disabled")
        if current_year_dep_col2:
            self.current_year_dep_col2_var.set(current_year_dep_col2)
            if current_year_dep_col2 in cols2:
                self.current_year_dep_col2_combo.current(_mapping_combo_index(current_year_dep_col2, cols2))
    
    def _update_selected_match_columns(self, file_num):
        """更新已选匹配列的显示"""
        if file_num == 1:
            # 从Listbox读取选择（即使隐藏了，数据仍然存储在其中）
            selected_indices = self.match_col1_listbox.curselection()
            if selected_indices:
                self.match_columns1 = [self.match_col1_listbox.get(i) for i in selected_indices]
            # 如果match_columns1已设置，优先使用它
            if self.match_columns1:
                display_text = " + ".join(self.match_columns1)
                # 如果文本太长，截断并添加省略号
                if len(display_text) > 50:
                    display_text = display_text[:47] + "..."
                self.match_col1_selected_label.config(text=f"已选择: {display_text}")
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
            else:
                self.match_col1_selected_label.config(text="已选择: 无")
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
        else:
            selected_indices = self.match_col2_listbox.curselection()
            if selected_indices:
                self.match_columns2 = [self.match_col2_listbox.get(i) for i in selected_indices]
            if self.match_columns2:
                display_text = " + ".join(self.match_columns2)
                # 如果文本太长，截断并添加省略号
                if len(display_text) > 50:
                    display_text = display_text[:47] + "..."
                self.match_col2_selected_label.config(text=f"已选择: {display_text}")
                # 更新按钮文本
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
            else:
                self.match_col2_selected_label.config(text="已选择: 无")
                # 更新按钮文本
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
    
    def _show_column_selection_menu(self, event, col_type, file_num):
        """显示列选择右键菜单"""
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="手动选择列", command=lambda: self._show_column_picker_dialog(col_type, file_num))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
    
    def _show_column_picker_dialog(self, col_type, file_num):
        """显示列选择对话框。file_num=1 仅用文件1列，file_num=2 仅用文件2列。"""
        # 字段类型到变量和标题的映射
        field_config = {
            'match': ('匹配列', None),  # match类型不使用var，直接使用match_columns1/2
            'original_value': ('原值列', self.original_value_col1_var if file_num == 1 else self.original_value_col2_var),
            'depreciation': ('累计折旧列', self.depreciation_col1_var if file_num == 1 else self.depreciation_col2_var),
            'category': ('资产类别列', self.category_col1_var if file_num == 1 else self.category_col2_var),
            'name': ('固定资产名称列', self.name_col1_var if file_num == 1 else self.name_col2_var),
            'date': ('入账开始日期列', self.date_col1_var if file_num == 1 else self.date_col2_var),
            'life': ('使用寿命列', self.life_col1_var if file_num == 1 else self.life_col2_var),
            'residual': ('残值率列', self.residual_col1_var if file_num == 1 else self.residual_col2_var),
            'current_year_dep': ('本年折旧列', self.current_year_dep_col1_var if file_num == 1 else self.current_year_dep_col2_var),
            'addition_method': ('新增方式列', self.addition_method_col1_var if file_num == 1 else self.addition_method_col2_var),
            'addition_date': ('新增时间列', self.addition_date_col1_var if file_num == 1 else self.addition_date_col2_var),
            'disposal_method': ('处置方式列', self.disposal_method_col1_var if file_num == 1 else self.disposal_method_col2_var),
            'disposal_date': ('处置时间列', self.disposal_date_col1_var if file_num == 1 else self.disposal_date_col2_var),
            'disposal_orig': ('处置原值列', self.disposal_orig_col1_var if file_num == 1 else self.disposal_orig_col2_var),
            'disposal_dep': ('处置折旧列', self.disposal_dep_col1_var if file_num == 1 else self.disposal_dep_col2_var),
        }
        
        if file_num == 1:
            columns = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
            file_display_name = self._get_file_display_name(1)
        else:
            columns = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
            file_display_name = self._get_file_display_name(2)
        
        field_name, var = field_config.get(col_type, ('列', None))
        if var is None and col_type != 'match':  # match类型允许var为None
            return
        
        # 对于match类型，current_col不需要（使用match_columns1/2）
        # 对于其他类型，从var获取当前值
        current_col = None if col_type == 'match' else (var.get() if var else None)
        title = f"选择{file_display_name}的{field_name}"
        
        if not columns:
            messagebox.showwarning("警告", "没有可用的列")
            return
        
        # 创建对话框
        dialog = tk.Toplevel(self)
        dialog.title(title)
        dialog.geometry("400x300")
        dialog.transient(self.winfo_toplevel())
        dialog.grab_set()
        
        ttk.Label(dialog, text="请选择列:", font=("Arial", 10)).pack(pady=10)
        
        list_frame = ttk.Frame(dialog)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        # 匹配列支持多选，其他列单选
        selectmode = tk.EXTENDED if col_type == 'match' else tk.SINGLE
        listbox = tk.Listbox(list_frame, height=10, selectmode=selectmode)
        listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=listbox.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        listbox.configure(yscrollcommand=scrollbar.set)
        
        for col in columns:
            listbox.insert(tk.END, col)
            if col_type == 'match':
                # 匹配列：选中当前已选的列
                if file_num == 1 and col in self.match_columns1:
                    listbox.selection_set(tk.END)
                elif file_num == 2 and col in self.match_columns2:
                    listbox.selection_set(tk.END)
            else:
                # 其他列：选中当前值
                if col == current_col:
                    listbox.selection_set(tk.END)
        
        button_frame = ttk.Frame(dialog)
        button_frame.pack(pady=10)
        
        def on_ok():
            selection = listbox.curselection()
            if selection:
                if col_type == 'match':
                    # 匹配列支持多选
                    selected_cols = [listbox.get(i) for i in selection]
                    if file_num == 1:
                        # 更新Listbox选择（用于数据存储）
                        self.match_col1_listbox.selection_clear(0, tk.END)
                        for col in selected_cols:
                            if col in columns:
                                idx = columns.index(col)
                                self.match_col1_listbox.selection_set(idx)
                        # 直接更新已选列列表和显示
                        self.match_columns1 = selected_cols
                        self._update_selected_match_columns(1)
                    else:
                        self.match_col2_listbox.selection_clear(0, tk.END)
                        for col in selected_cols:
                            if col in columns:
                                idx = columns.index(col)
                                self.match_col2_listbox.selection_set(idx)
                        # 直接更新已选列列表和显示
                        self.match_columns2 = selected_cols
                        self._update_selected_match_columns(2)
                else:
                    # 其他列单选
                    selected_col = listbox.get(selection[0])
                    var.set(selected_col)
                    
                    # 更新对应的下拉框选中项
                    combo_map_1 = {
                        'original_value': self.orig_col1_combo,
                        'depreciation': self.dep_col1_combo,
                        'category': self.category_col1_combo,
                        'name': self.name_col1_combo,
                        'date': self.date_col1_combo,
                        'life': self.life_col1_combo,
                        'residual': self.residual_col1_combo,
                        'addition_method': self.addition_method_col1_combo,
                        'addition_date': self.addition_date_col1_combo,
                        'disposal_method': self.disposal_method_col1_combo,
                        'disposal_date': self.disposal_date_col1_combo,
                        'disposal_orig': self.disposal_orig_col1_combo,
                        'disposal_dep': self.disposal_dep_col1_combo,
                    }
                    combo_map_2 = {
                        'original_value': self.orig_col2_combo,
                        'depreciation': self.dep_col2_combo,
                        'category': self.category_col2_combo,
                        'name': self.name_col2_combo,
                        'date': self.date_col2_combo,
                        'life': self.life_col2_combo,
                        'residual': self.residual_col2_combo,
                        'addition_method': self.addition_method_col2_combo,
                        'addition_date': self.addition_date_col2_combo,
                        'disposal_method': self.disposal_method_col2_combo,
                        'disposal_date': self.disposal_date_col2_combo,
                        'disposal_orig': self.disposal_orig_col2_combo,
                        'disposal_dep': self.disposal_dep_col2_combo,
                    }
                    
                    combo = combo_map_1.get(col_type) if file_num == 1 else combo_map_2.get(col_type)
                    if combo and selected_col in columns:
                        idx = columns.index(selected_col)
                        combo.current(1 + idx)  # +1 因为索引0是[不映射]
                    elif combo:
                        # 如果selected_col不在columns中，尝试直接设置值
                        combo.set(selected_col)
                
                dialog.destroy()
            else:
                if col_type == 'match':
                    messagebox.showwarning("警告", "请至少选择一个列")
                else:
                    messagebox.showwarning("警告", "请选择一个列")
        
        def on_cancel():
            dialog.destroy()
        
        ttk.Button(button_frame, text="确定", command=on_ok, width=10).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="取消", command=on_cancel, width=10).pack(side=tk.LEFT, padx=5)
        
        listbox.bind('<Double-Button-1>', lambda e: on_ok())
    
    def _show_header_row_menu(self, event, file_num):
        """显示标题行选择菜单。支持在任意数据行右键，将该行设为标题行。"""
        tree = self.file1_tree if file_num == 1 else self.file2_tree
        region = tree.identify_region(event.x, event.y)
        # 允许在数据行（cell、tree）或列头（heading）右键；仅在空白区域不弹出
        if region not in ('cell', 'tree', 'heading'):
            return
        # 若点在列头，无法确定“行”，不弹出设为标题行
        if region == 'heading':
            return
        item = tree.identify_row(event.y)
        if not item:
            return
        children = tree.get_children()
        if item not in children:
            return
        row_index = children.index(item)
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="设本行为标题行", command=lambda: self._set_header_row(file_num, row_index))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
    
    def _set_header_row(self, file_num, row_index):
        """
        将预览中第 row_index 行（0-based 数据行）设为文件的标题行。
        
        预览显示的是已经用某个header读取后的DataFrame数据行。
        预览中第0行对应文件中的第 (当前header + 1) 行（第一个数据行）。
        如果用户右键点击预览中的第row_index行，想把它设为标题行，那么：
        文件中的实际行索引 = 当前header + row_index + 1
        
        优化：如果新的标题行在已加载的DataFrame中，直接从DataFrame提取，避免重新读取文件。
        """
        if file_num == 1:
            file_path = self.file1_path_var.get()
            sheet_name = self.file1_sheet_var.get() if self.file1_sheet_var.get() else None
            # 获取当前使用的header（如果之前设置过）
            current_header = getattr(self, 'file1_header_row', 0)
            current_df = self.file_handler.file1_df  # 获取当前DataFrame
            self.file1_header_row = row_index
        else:
            file_path = self.file2_path_var.get()
            sheet_name = self.file2_sheet_var.get() if self.file2_sheet_var.get() else None
            # 获取当前使用的header（如果之前设置过）
            current_header = getattr(self, 'file2_header_row', 0)
            current_df = self.file_handler.file2_df  # 获取当前DataFrame
            self.file2_header_row = row_index
        
        if not file_path:
            return
        
        # 计算文件中的实际行索引
        # 预览中第row_index行对应文件中的第 (current_header + row_index + 1) 行
        # 但current_header已经是文件中的行索引了，所以需要加上row_index
        # 如果current_header=0（使用第一行作为标题），预览第0行=文件第1行，预览第row_index行=文件第(row_index+1)行
        # 如果current_header=1（使用第二行作为标题），预览第0行=文件第2行，预览第row_index行=文件第(row_index+2)行
        # 所以：文件中的行索引 = current_header + row_index + 1
        # 但pandas的header参数是0-based，所以header_0based = current_header + row_index + 1
        header_0based = current_header + row_index + 1
        
        file_display_name = self._get_file_display_name(file_num)
        
        # 优化：如果新的标题行在已加载的DataFrame中，直接从DataFrame提取，避免重新读取文件
        if current_df is not None and row_index >= 0 and row_index < len(current_df):
            try:
                # 从DataFrame中提取新的标题行
                new_header_row = current_df.iloc[row_index]
                # 将标题行转换为列名（处理NaN值）
                new_columns = []
                for val in new_header_row:
                    if pd.isna(val):
                        new_columns.append('')
                    else:
                        new_columns.append(str(val).strip())
                
                # 创建新的DataFrame，使用新的列名
                new_df = current_df.copy()
                new_df.columns = new_columns
                
                # 删除标题行（因为它是标题，不是数据）
                new_df = new_df.drop(new_df.index[row_index]).reset_index(drop=True)
                
                # 更新DataFrame
                if file_num == 1:
                    self.file_handler.file1_df = new_df
                else:
                    self.file_handler.file2_df = new_df
                
                # 更新预览和预映射（不需要重新读取文件）
                self._on_header_row_set(file_num, file_display_name, header_0based)
                
                if self.status_callback:
                    self.status_callback(f"{file_display_name}标题行已更新")
                
                # 提示已在_on_header_row_set中显示，这里不再重复显示
                return
            except Exception as e:
                # 如果从DataFrame提取失败，回退到重新读取文件
                if self.status_callback:
                    self.status_callback(f"从DataFrame提取标题行失败，将重新读取文件: {str(e)}")
        
        # 如果无法从DataFrame提取，则重新读取文件
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        progress_window.geometry("300x120")
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        ttk.Label(progress_window, text=f"正在重新读取{file_display_name}，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        if self.status_callback:
            self.status_callback(f"正在重新读取{file_display_name}，使用第{header_0based + 1}行作为标题行...")
        
        _, ext = os.path.splitext(file_path)
        # 确保ext是字符串（os.path.splitext应该返回字符串，但为安全起见）
        ext = str(ext).lower() if ext else ''
        
        # 在后台线程中重新读取文件
        def reload_task():
            try:
                if ext in SUPPORTED_EXCEL_FORMATS:
                    if ext == '.xls':
                        df = pd.read_excel(file_path, sheet_name=sheet_name, engine='xlrd', header=header_0based)
                    else:
                        df = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl', header=header_0based)
                elif ext in SUPPORTED_CSV_FORMATS:
                    encoding = detect_encoding(file_path)
                    encodings = [encoding, 'utf-8', 'gbk', 'gb2312', 'latin-1']
                    df = None
                    for enc in encodings:
                        try:
                            df = pd.read_csv(file_path, encoding=enc, header=header_0based, low_memory=False)
                            break
                        except (UnicodeDecodeError, Exception):
                            continue
                    if df is None:
                        raise Exception(f"无法读取CSV文件，尝试的编码: {', '.join(encodings)}")
                else:
                    self.after(0, lambda: progress_window.destroy())
                    self.after(0, lambda: messagebox.showerror("错误", "不支持的文件格式"))
                    return
                
                if file_num == 1:
                    self.file_handler.file1_df = df
                else:
                    self.file_handler.file2_df = df
                
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: self._on_header_row_set(file_num, file_display_name, header_0based))
            except Exception as e:
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: messagebox.showerror("错误", f"重新读取文件失败:\n{str(e)}"))
        
        threading.Thread(target=reload_task, daemon=True).start()
    
    def _on_header_row_set(self, file_num, file_display_name, header_0based):
        """标题行设置完成回调"""
        if file_num == 1:
            self._update_file1_preview()
        else:
            self._update_file2_preview()
        
        # 更新文件标签
        self._update_file_labels()
        
        # 确保UI更新完成后再执行预映射
        self.update_idletasks()
        
        # 更新匹配列并执行预映射
        self._update_match_columns()
        
        # 再次确保UI更新
        self.update_idletasks()
        
        if self.status_callback:
            self.status_callback(f"{file_display_name}已重新读取")
        
        messagebox.showinfo("成功", f"已将第{header_0based + 1}行设置为标题行")
    
    def _find_actual_column_name(self, col_name, cols_raw, suffix):
        """查找实际的列名（可能带后缀）"""
        if not col_name or not cols_raw:
            return col_name
        # 如果列名在原始列名中，直接返回
        if col_name in cols_raw:
            return col_name
        # 尝试添加后缀查找
        col_name_with_suffix = f"{col_name}{suffix}"
        if col_name_with_suffix in cols_raw:
            return col_name_with_suffix
        # 尝试移除后缀后匹配
        for col in cols_raw:
            if str(col).replace(suffix, '') == col_name:
                return col
        # 如果都找不到，返回原始列名
        return col_name
    
    def _get_mapped_col(self, var_value, cols_raw, suffix):
        """获取映射的列名，如果选择"[不映射]"则返回None"""
        if not var_value or var_value == '[不映射]':
            return None
        return self._find_actual_column_name(var_value, cols_raw, suffix)
    
    def _on_next(self):
        """下一步按钮"""
        # 注意：这里不要无条件重载文件。
        # _load_file1/_load_file2 会触发 _update_match_columns，从而重置手工映射和多选匹配列。
        # 文件在“选择文件/切换工作表/设标题行”时已经加载，下一步只做校验与提交。
        
        # 验证文件是否已选择
        file1_display_name = self._get_file_display_name(1)
        file2_display_name = self._get_file_display_name(2)
        
        # 检查是否选择了文件路径
        file1_display_name = self._get_file_display_name(1)
        file2_display_name = self._get_file_display_name(2)
        
        if not self.file1_path_var.get():
            messagebox.showwarning("警告", f"请选择{file1_display_name}")
            return
        
        is_supplement_mode = (self.mode == "supplement")
        file2_path = (self.file2_path_var.get() or "").strip()
        require_file2 = (not is_supplement_mode) or bool(file2_path)
        if require_file2 and not file2_path:
            messagebox.showwarning("警告", f"请选择{file2_display_name}")
            return
        
        # 检查Excel文件是否选择了sheet
        _, ext1 = os.path.splitext(self.file1_path_var.get())
        ext1 = str(ext1).lower() if ext1 else ''
        if ext1 in ['.xlsx', '.xls'] and not self.file1_sheet_var.get():
            messagebox.showwarning("警告", f"请为{file1_display_name}选择工作表")
            return
        
        if require_file2:
            _, ext2 = os.path.splitext(file2_path)
            ext2 = str(ext2).lower() if ext2 else ''
            if ext2 in ['.xlsx', '.xls'] and not self.file2_sheet_var.get():
                messagebox.showwarning("警告", f"请为{file2_display_name}选择工作表")
                return
        
        if self.file_handler.file1_df is None:
            messagebox.showwarning("警告", f"请先加载{file1_display_name}")
            return
        
        if require_file2 and self.file_handler.file2_df is None:
            messagebox.showwarning("警告", f"请先加载{file2_display_name}")
            return
        
        # 获取选中的匹配列（列表格式）
        match_cols1 = self.match_columns1.copy() if self.match_columns1 else []
        match_cols2 = self.match_columns2.copy() if self.match_columns2 else []
        
        if not match_cols1:
            messagebox.showwarning("警告", f"请至少选择{file1_display_name}的一个匹配列")
            return
        
        if require_file2:
            if not match_cols2:
                messagebox.showwarning("警告", f"请至少选择{file2_display_name}的一个匹配列")
                return
            if len(match_cols1) != len(match_cols2):
                messagebox.showwarning("警告", f"文件1和文件2的匹配列数量必须相同（当前：文件1={len(match_cols1)}列，文件2={len(match_cols2)}列）")
                return
        
        # 如果列名中有"_文件1"或"_文件2"后缀，需要移除（因为这是合并时添加的，不应该在文件选择阶段存在）
        # 但如果DataFrame的列名确实有后缀，需要找到对应的原始列名
        cols1_raw = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
        cols2_raw = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
        
        # 查找原始列名（可能带后缀）- 支持多列
        match_cols1_actual = []
        match_cols2_actual = []
        
        for match_col1 in match_cols1:
            match_col1_actual = match_col1
            if match_col1 not in cols1_raw:
                match_col1_with_suffix = f"{match_col1}_文件1"
                if match_col1_with_suffix in cols1_raw:
                    match_col1_actual = match_col1_with_suffix
                else:
                    # 尝试直接查找（可能列名本身就有后缀）
                    for col in cols1_raw:
                        if str(col).replace('_文件1', '') == match_col1:
                            match_col1_actual = col
                            break
            match_cols1_actual.append(match_col1_actual)
        
        for match_col2 in match_cols2:
            match_col2_actual = match_col2
            if match_col2 not in cols2_raw:
                match_col2_with_suffix = f"{match_col2}_文件2"
                if match_col2_with_suffix in cols2_raw:
                    match_col2_actual = match_col2_with_suffix
                else:
                    # 尝试直接查找（可能列名本身就有后缀）
                    for col in cols2_raw:
                        if str(col).replace('_文件2', '') == match_col2:
                            match_col2_actual = col
                            break
            match_cols2_actual.append(match_col2_actual)
        
        # 准备配置（使用实际的列名，列表格式）
        config = {
            'match_column1': match_cols1_actual,  # 改为列表
            'match_column2': match_cols2_actual,  # 改为列表
            'data_type1': self.data_type1_var.get(),
            'data_type2': self.data_type2_var.get(),
            'remove_spaces': False,
            'case_sensitive': True,
            'handle_duplicates': 'pivot',
            'original_value_col1': self._find_actual_column_name(self.original_value_col1_var.get(), cols1_raw, '_文件1') if self.original_value_col1_var.get() else None,
            'original_value_col2': self._find_actual_column_name(self.original_value_col2_var.get(), cols2_raw, '_文件2') if self.original_value_col2_var.get() else None,
            'depreciation_col1': self._find_actual_column_name(self.depreciation_col1_var.get(), cols1_raw, '_文件1') if self.depreciation_col1_var.get() else None,
            'depreciation_col2': self._find_actual_column_name(self.depreciation_col2_var.get(), cols2_raw, '_文件2') if self.depreciation_col2_var.get() else None,
            'file1_display_name': file1_display_name,
            'file2_display_name': file2_display_name,
            # 新增字段映射配置（处理"[不映射]"选项）
            'category_col1': self._get_mapped_col(self.category_col1_var.get(), cols1_raw, '_文件1'),
            'category_col2': self._get_mapped_col(self.category_col2_var.get(), cols2_raw, '_文件2'),
            'name_col1': self._get_mapped_col(self.name_col1_var.get(), cols1_raw, '_文件1'),
            'name_col2': self._get_mapped_col(self.name_col2_var.get(), cols2_raw, '_文件2'),
            'date_col1': self._get_mapped_col(self.date_col1_var.get(), cols1_raw, '_文件1'),
            'date_col2': self._get_mapped_col(self.date_col2_var.get(), cols2_raw, '_文件2'),
            'life_col1': self._get_mapped_col(self.life_col1_var.get(), cols1_raw, '_文件1'),
            'life_col2': self._get_mapped_col(self.life_col2_var.get(), cols2_raw, '_文件2'),
            'residual_col1': self._get_mapped_col(self.residual_col1_var.get(), cols1_raw, '_文件1'),
            'residual_col2': self._get_mapped_col(self.residual_col2_var.get(), cols2_raw, '_文件2'),
            'current_year_dep_col1': None,
            'current_year_dep_col2': self._get_mapped_col(self.current_year_dep_col2_var.get(), cols2_raw, '_文件2'),
            'balance_sheet_date': self.balance_sheet_date_var.get().strip() or "2025/12/31",
            'addition_method_col1': self._get_mapped_col(self.addition_method_col1_var.get(), cols1_raw, '_文件1'),
            'addition_method_col2': self._get_mapped_col(self.addition_method_col2_var.get(), cols2_raw, '_文件2'),
            'addition_date_col1': self._get_mapped_col(self.addition_date_col1_var.get(), cols1_raw, '_文件1'),
            'addition_date_col2': self._get_mapped_col(self.addition_date_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_method_col1': self._get_mapped_col(self.disposal_method_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_method_col2': self._get_mapped_col(self.disposal_method_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_date_col1': self._get_mapped_col(self.disposal_date_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_date_col2': self._get_mapped_col(self.disposal_date_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_orig_col1': self._get_mapped_col(self.disposal_orig_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_orig_col2': self._get_mapped_col(self.disposal_orig_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_dep_col1': self._get_mapped_col(self.disposal_dep_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_dep_col2': self._get_mapped_col(self.disposal_dep_col2_var.get(), cols2_raw, '_文件2'),
        }
        
        # 调用完成回调
        if self.on_complete:
            self.on_complete(config)
