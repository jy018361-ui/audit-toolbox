"""
文件选择界面
"""
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import os
import pandas as pd
from file_handler import FileHandler


class FileSelector(ttk.Frame):
    """文件选择组件"""
    
    def __init__(self, parent, file_handler: FileHandler, on_complete=None, status_callback=None):
        super().__init__(parent, padding="10")
        self.file_handler = file_handler
        self.on_complete = on_complete
        self.status_callback = status_callback  # 状态更新回调
        
        self.file1_path_var = tk.StringVar()
        self.file2_path_var = tk.StringVar()
        self.file1_sheet_var = tk.StringVar()
        self.file2_sheet_var = tk.StringVar()
        
        self._create_widgets()
    
    def _create_widgets(self):
        """创建界面组件"""
        # 说明文字
        info_label = ttk.Label(
            self,
            text="请选择要合并的两个文件（支持Excel和CSV格式）",
            font=("Arial", 10)
        )
        info_label.pack(pady=(0, 20))
        
        # 文件1选择区域
        file1_frame = ttk.LabelFrame(self, text="文件1", padding="10")
        file1_frame.pack(fill=tk.X, pady=5)
        
        file1_path_frame = ttk.Frame(file1_frame)
        file1_path_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(file1_path_frame, text="文件路径:").pack(side=tk.LEFT, padx=5)
        file1_entry = ttk.Entry(file1_path_frame, textvariable=self.file1_path_var, width=50)
        file1_entry.pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        
        ttk.Button(
            file1_path_frame,
            text="浏览...",
            command=self._select_file1
        ).pack(side=tk.LEFT, padx=5)
        
        # 文件1工作表选择（仅Excel）
        self.file1_sheet_frame = ttk.Frame(file1_frame)
        self.file1_sheet_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(self.file1_sheet_frame, text="工作表:").pack(side=tk.LEFT, padx=5)
        self.file1_sheet_combo = ttk.Combobox(
            self.file1_sheet_frame,
            textvariable=self.file1_sheet_var,
            state="readonly",
            width=30
        )
        self.file1_sheet_combo.pack(side=tk.LEFT, padx=5)
        
        # 文件1预览按钮
        ttk.Button(
            file1_frame,
            text="预览文件1",
            command=self._preview_file1
        ).pack(pady=5)
        
        # 文件2选择区域
        file2_frame = ttk.LabelFrame(self, text="文件2", padding="10")
        file2_frame.pack(fill=tk.X, pady=5)
        
        file2_path_frame = ttk.Frame(file2_frame)
        file2_path_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(file2_path_frame, text="文件路径:").pack(side=tk.LEFT, padx=5)
        file2_entry = ttk.Entry(file2_path_frame, textvariable=self.file2_path_var, width=50)
        file2_entry.pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        
        ttk.Button(
            file2_path_frame,
            text="浏览...",
            command=self._select_file2
        ).pack(side=tk.LEFT, padx=5)
        
        # 文件2工作表选择（仅Excel）
        self.file2_sheet_frame = ttk.Frame(file2_frame)
        self.file2_sheet_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(self.file2_sheet_frame, text="工作表:").pack(side=tk.LEFT, padx=5)
        self.file2_sheet_combo = ttk.Combobox(
            self.file2_sheet_frame,
            textvariable=self.file2_sheet_var,
            state="readonly",
            width=30
        )
        self.file2_sheet_combo.pack(side=tk.LEFT, padx=5)
        
        # 文件2预览按钮
        ttk.Button(
            file2_frame,
            text="预览文件2",
            command=self._preview_file2
        ).pack(pady=5)
        
        # 下一步按钮
        button_frame = ttk.Frame(self)
        button_frame.pack(pady=20)
        
        ttk.Button(
            button_frame,
            text="下一步：配置匹配列",
            command=self._on_next,
            width=20
        ).pack(side=tk.LEFT, padx=5)
    
    def _select_file1(self):
        """选择文件1"""
        file_path = filedialog.askopenfilename(
            title="选择文件1",
            filetypes=[
                ("Excel文件", "*.xlsx *.xls"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.file1_path_var.set(file_path)
            self._load_file1_sheets(file_path)
            self._load_file1()
    
    def _select_file2(self):
        """选择文件2"""
        file_path = filedialog.askopenfilename(
            title="选择文件2",
            filetypes=[
                ("Excel文件", "*.xlsx *.xls"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.file2_path_var.set(file_path)
            self._load_file2_sheets(file_path)
            self._load_file2()
    
    def _load_file1_sheets(self, file_path: str):
        """加载文件1的工作表列表"""
        _, ext = os.path.splitext(file_path)
        if ext.lower() in ['.xlsx', '.xls']:
            if self.status_callback:
                self.status_callback("正在识别文件1格式，请稍候...")
            success, error_msg, sheets = self.file_handler.get_excel_sheets(file_path)
            if success and sheets:
                self.file1_sheet_combo['values'] = sheets
                self.file1_sheet_combo.current(0)
                self.file1_sheet_frame.pack(fill=tk.X, pady=5)
            else:
                self.file1_sheet_frame.pack_forget()
        else:
            self.file1_sheet_frame.pack_forget()
    
    def _load_file2_sheets(self, file_path: str):
        """加载文件2的工作表列表"""
        _, ext = os.path.splitext(file_path)
        if ext.lower() in ['.xlsx', '.xls']:
            if self.status_callback:
                self.status_callback("正在识别文件2格式，请稍候...")
            success, error_msg, sheets = self.file_handler.get_excel_sheets(file_path)
            if success and sheets:
                self.file2_sheet_combo['values'] = sheets
                self.file2_sheet_combo.current(0)
                self.file2_sheet_frame.pack(fill=tk.X, pady=5)
            else:
                self.file2_sheet_frame.pack_forget()
        else:
            self.file2_sheet_frame.pack_forget()
    
    def _load_file1(self):
        """加载文件1"""
        file_path = self.file1_path_var.get()
        if not file_path:
            return
        
        # 显示进度提示
        if self.status_callback:
            self.status_callback("正在读取文件1，请稍候...")
        
        sheet_name = self.file1_sheet_var.get() if self.file1_sheet_var.get() else None
        success, error_msg = self.file_handler.set_file1(file_path, sheet_name)
        
        if success:
            if self.status_callback:
                self.status_callback("文件1读取完成")
        else:
            if self.status_callback:
                self.status_callback("文件1读取失败")
            messagebox.showerror("错误", f"加载文件1失败:\n{error_msg}")
    
    def _load_file2(self):
        """加载文件2"""
        file_path = self.file2_path_var.get()
        if not file_path:
            return
        
        # 显示进度提示
        if self.status_callback:
            self.status_callback("正在读取文件2，请稍候...")
        
        sheet_name = self.file2_sheet_var.get() if self.file2_sheet_var.get() else None
        success, error_msg = self.file_handler.set_file2(file_path, sheet_name)
        
        if success:
            if self.status_callback:
                self.status_callback("文件2读取完成")
        else:
            if self.status_callback:
                self.status_callback("文件2读取失败")
            messagebox.showerror("错误", f"加载文件2失败:\n{error_msg}")
    
    def _preview_file1(self):
        """预览文件1"""
        if self.file_handler.file1_df is None:
            messagebox.showwarning("警告", "请先选择文件1")
            return
        
        preview_df = self.file_handler.get_file1_preview()
        self._show_preview("文件1预览", preview_df)
    
    def _preview_file2(self):
        """预览文件2"""
        if self.file_handler.file2_df is None:
            messagebox.showwarning("警告", "请先选择文件2")
            return
        
        preview_df = self.file_handler.get_file2_preview()
        self._show_preview("文件2预览", preview_df)
    
    def _show_preview(self, title: str, df):
        """显示预览窗口"""
        if df is None or df.empty:
            messagebox.showinfo("提示", "没有可预览的数据")
            return
        
        preview_window = tk.Toplevel(self)
        preview_window.title(title)
        preview_window.geometry("800x400")
        
        # 创建表格框架
        table_frame = ttk.Frame(preview_window)
        table_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # 创建表格
        tree = ttk.Treeview(table_frame)
        tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        # 添加列
        tree['columns'] = list(df.columns)
        tree['show'] = 'headings'
        
        for col in df.columns:
            tree.heading(col, text=str(col))
            # 根据内容调整列宽
            max_len = max(len(str(col)), *[len(str(val)) for val in df[col].head(10) if pd.notna(val)])
            tree.column(col, width=min(max_len * 10 + 20, 200))
        
        # 添加数据
        for idx, row in df.iterrows():
            values = [str(val) if pd.notna(val) else '' for val in row]
            tree.insert('', tk.END, values=values)
        
        # 垂直滚动条
        v_scrollbar = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=tree.yview)
        v_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        tree.configure(yscrollcommand=v_scrollbar.set)
        
        # 水平滚动条
        h_scrollbar = ttk.Scrollbar(preview_window, orient=tk.HORIZONTAL, command=tree.xview)
        h_scrollbar.pack(fill=tk.X, padx=10)
        tree.configure(xscrollcommand=h_scrollbar.set)
    
    def _on_next(self):
        """下一步按钮点击事件"""
        # 重新加载文件（确保使用最新的工作表选择）
        if self.file1_path_var.get():
            self._load_file1()
        if self.file2_path_var.get():
            self._load_file2()
        
        # 验证文件是否已选择
        if self.file_handler.file1_df is None:
            messagebox.showwarning("警告", "请选择文件1")
            return
        
        if self.file_handler.file2_df is None:
            messagebox.showwarning("警告", "请选择文件2")
            return
        
        # 调用完成回调
        if self.on_complete:
            self.on_complete()
