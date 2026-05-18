"""
匹配列配置界面
"""
import tkinter as tk
from tkinter import ttk, messagebox, simpledialog
from file_handler import FileHandler
from utils.helpers import get_column_matches


class MatchConfig(ttk.Frame):
    """匹配列配置组件"""
    
    def __init__(self, parent, file_handler: FileHandler, on_complete=None, on_back=None):
        super().__init__(parent, padding="10")
        self.file_handler = file_handler
        self.on_complete = on_complete
        self.on_back = on_back
        
        self.match_column1_var = tk.StringVar()
        self.match_column2_var = tk.StringVar()
        self.data_type1_var = tk.StringVar(value="auto")
        self.data_type2_var = tk.StringVar(value="auto")
        
        self._create_widgets()
        self._auto_match_columns()
    
    def _create_widgets(self):
        """创建界面组件"""
        # 说明文字
        info_label = ttk.Label(
            self,
            text="请选择用于匹配的列，并配置数据类型和预处理选项",
            font=("Arial", 10)
        )
        info_label.pack(pady=(0, 20))
        
        # 匹配列选择区域
        match_frame = ttk.LabelFrame(self, text="匹配列配置", padding="10")
        match_frame.pack(fill=tk.X, pady=5)
        
        # 文件1匹配列
        file1_col_frame = ttk.Frame(match_frame)
        file1_col_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(file1_col_frame, text="文件1匹配列:", width=15).pack(side=tk.LEFT, padx=5)
        self.file1_col_combo = ttk.Combobox(
            file1_col_frame,
            textvariable=self.match_column1_var,
            state="readonly",
            width=30
        )
        self.file1_col_combo.pack(side=tk.LEFT, padx=5)
        self.file1_col_combo['values'] = self.file_handler.get_file1_columns()
        if self.file_handler.get_file1_columns():
            self.file1_col_combo.current(0)
        # 绑定右键菜单
        self.file1_col_combo.bind('<Button-3>', lambda e: self._show_column_selection_menu(e, 1))
        
        # 文件1数据类型
        ttk.Label(file1_col_frame, text="数据类型:", width=10).pack(side=tk.LEFT, padx=5)
        data_type1_combo = ttk.Combobox(
            file1_col_frame,
            textvariable=self.data_type1_var,
            values=["auto", "text", "number", "date"],
            state="readonly",
            width=10
        )
        data_type1_combo.pack(side=tk.LEFT, padx=5)
        
        # 文件2匹配列
        file2_col_frame = ttk.Frame(match_frame)
        file2_col_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(file2_col_frame, text="文件2匹配列:", width=15).pack(side=tk.LEFT, padx=5)
        self.file2_col_combo = ttk.Combobox(
            file2_col_frame,
            textvariable=self.match_column2_var,
            state="readonly",
            width=30
        )
        self.file2_col_combo.pack(side=tk.LEFT, padx=5)
        self.file2_col_combo['values'] = self.file_handler.get_file2_columns()
        if self.file_handler.get_file2_columns():
            self.file2_col_combo.current(0)
        # 绑定右键菜单
        self.file2_col_combo.bind('<Button-3>', lambda e: self._show_column_selection_menu(e, 2))
        
        # 文件2数据类型
        ttk.Label(file2_col_frame, text="数据类型:", width=10).pack(side=tk.LEFT, padx=5)
        data_type2_combo = ttk.Combobox(
            file2_col_frame,
            textvariable=self.data_type2_var,
            values=["auto", "text", "number", "date"],
            state="readonly",
            width=10
        )
        data_type2_combo.pack(side=tk.LEFT, padx=5)
        
        # 自动匹配按钮
        ttk.Button(
            match_frame,
            text="自动匹配列名",
            command=self._auto_match_columns
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
            text="下一步：执行合并",
            command=self._on_next,
            width=20
        ).pack(side=tk.LEFT, padx=5)
    
    def _auto_match_columns(self):
        """自动匹配列名，优先查找包含编码/编号的列"""
        cols1 = self.file_handler.get_file1_columns()
        cols2 = self.file_handler.get_file2_columns()
        
        # 优先查找包含"编码"或"编号"的列
        code_cols1 = [col for col in cols1 if '编码' in str(col) or '编号' in str(col)]
        code_cols2 = [col for col in cols2 if '编码' in str(col) or '编号' in str(col)]
        
        if code_cols1 and code_cols2:
            # 如果两个文件都有包含编码/编号的列，尝试匹配
            for col1 in code_cols1:
                for col2 in code_cols2:
                    # 检查是否匹配（名称相似或完全相同）
                    if col1 == col2 or col1.lower() == col2.lower():
                        self.match_column1_var.set(col1)
                        self.match_column2_var.set(col2)
                        if col1 in cols1:
                            self.file1_col_combo.current(cols1.index(col1))
                        if col2 in cols2:
                            self.file2_col_combo.current(cols2.index(col2))
                        return
            # 如果没有完全匹配，使用第一个
            self.match_column1_var.set(code_cols1[0])
            self.match_column2_var.set(code_cols2[0])
            if code_cols1[0] in cols1:
                self.file1_col_combo.current(cols1.index(code_cols1[0]))
            if code_cols2[0] in cols2:
                self.file2_col_combo.current(cols2.index(code_cols2[0]))
            return
        
        # 回退到原有的匹配逻辑
        matches = get_column_matches(cols1, cols2)
        
        if matches:
            # 使用第一个匹配
            col1, col2 = matches[0]
            self.match_column1_var.set(col1)
            self.match_column2_var.set(col2)
            
            # 更新下拉框选择
            if col1 in cols1:
                self.file1_col_combo.current(cols1.index(col1))
            if col2 in cols2:
                self.file2_col_combo.current(cols2.index(col2))
        else:
            # 如果没有匹配，使用第一列
            if cols1:
                self.match_column1_var.set(cols1[0])
                self.file1_col_combo.current(0)
            if cols2:
                self.match_column2_var.set(cols2[0])
                self.file2_col_combo.current(0)
    
    def _show_column_selection_menu(self, event, file_num):
        """显示右键菜单"""
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="手动选择列", command=lambda: self._show_column_picker_dialog(file_num))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
    
    def _show_column_picker_dialog(self, file_num):
        """显示列选择对话框"""
        if file_num == 1:
            columns = self.file_handler.get_file1_columns()
            current_col = self.match_column1_var.get()
            title = "选择文件1的匹配列"
        else:
            columns = self.file_handler.get_file2_columns()
            current_col = self.match_column2_var.get()
            title = "选择文件2的匹配列"
        
        if not columns:
            messagebox.showwarning("警告", "没有可用的列")
            return
        
        # 创建对话框
        dialog = tk.Toplevel(self)
        dialog.title(title)
        dialog.geometry("400x300")
        dialog.transient(self.winfo_toplevel())
        dialog.grab_set()
        
        # 说明文字
        ttk.Label(dialog, text="请选择匹配列:", font=("Arial", 10)).pack(pady=10)
        
        # 列列表
        list_frame = ttk.Frame(dialog)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        listbox = tk.Listbox(list_frame, height=10)
        listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=listbox.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        listbox.configure(yscrollcommand=scrollbar.set)
        
        # 填充列表
        for col in columns:
            listbox.insert(tk.END, col)
            if col == current_col:
                listbox.selection_set(tk.END)
        
        # 按钮
        button_frame = ttk.Frame(dialog)
        button_frame.pack(pady=10)
        
        def on_ok():
            selection = listbox.curselection()
            if selection:
                selected_col = listbox.get(selection[0])
                if file_num == 1:
                    self.match_column1_var.set(selected_col)
                    if selected_col in columns:
                        self.file1_col_combo.current(columns.index(selected_col))
                else:
                    self.match_column2_var.set(selected_col)
                    if selected_col in columns:
                        self.file2_col_combo.current(columns.index(selected_col))
                dialog.destroy()
            else:
                messagebox.showwarning("警告", "请选择一个列")
        
        def on_cancel():
            dialog.destroy()
        
        ttk.Button(button_frame, text="确定", command=on_ok, width=10).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="取消", command=on_cancel, width=10).pack(side=tk.LEFT, padx=5)
        
        # 双击选择
        listbox.bind('<Double-Button-1>', lambda e: on_ok())
    
    def _on_back(self):
        """上一步按钮"""
        if self.on_back:
            self.on_back()
    
    def _on_next(self):
        """下一步按钮"""
        match_col1 = self.match_column1_var.get()
        match_col2 = self.match_column2_var.get()
        
        if not match_col1:
            messagebox.showwarning("警告", "请选择文件1的匹配列")
            return
        
        if not match_col2:
            messagebox.showwarning("警告", "请选择文件2的匹配列")
            return
        
        # 准备配置（保持原始数据，不进行预处理）
        config = {
            'match_column1': match_col1,
            'match_column2': match_col2,
            'data_type1': self.data_type1_var.get(),
            'data_type2': self.data_type2_var.get(),
            'remove_spaces': False,  # 不再去除空格，保持原始数据
            'case_sensitive': True,  # 区分大小写，保持原始数据
            'handle_duplicates': 'pivot'  # 默认使用数据透视逻辑
        }
        
        # 调用完成回调
        if self.on_complete:
            self.on_complete(config)
