"""
导出设置界面
"""
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import os
import threading
import pandas as pd
from exporter import Exporter


class ExportSettings(ttk.Frame):
    """导出设置组件"""
    
    def __init__(self, parent, df: pd.DataFrame, selected_columns: list, exporter: Exporter, pivot_df: pd.DataFrame = None, 
                 full_df: pd.DataFrame = None, on_complete=None, on_back=None, file1_display_name=None, file2_display_name=None,
                 summary_config=None):
        super().__init__(parent, padding="10")
        self.df = df  # 用于导出的数据（可能已筛选列）
        self.full_df = full_df if full_df is not None else df  # 完整数据（用于原值增加/减少清单，包含所有列）
        self.selected_columns = selected_columns
        self.exporter = exporter
        self.pivot_df = pivot_df  # 数据透视表（可选）
        self.on_complete = on_complete
        self.on_back = on_back
        # 保存文件显示名称（用于替换列名中的_文件1/_文件2）
        self.file1_display_name = file1_display_name or "原始文件1"
        self.file2_display_name = file2_display_name or "原始文件2"
        # 汇总表配置
        self.summary_config = summary_config
        
        self.export_path_var = tk.StringVar()
        self.export_format_var = tk.StringVar(value="xlsx")
        
        self._create_widgets()
    
    def _create_widgets(self):
        """创建界面组件"""
        # 说明文字
        info_label = ttk.Label(
            self,
            text="配置导出选项",
            font=("Arial", 10)
        )
        info_label.pack(pady=(0, 20))
        
        # 导出路径选择
        path_frame = ttk.LabelFrame(self, text="导出路径", padding="10")
        path_frame.pack(fill=tk.X, pady=5)
        
        path_input_frame = ttk.Frame(path_frame)
        path_input_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(path_input_frame, text="文件路径:").pack(side=tk.LEFT, padx=5)
        path_entry = ttk.Entry(path_input_frame, textvariable=self.export_path_var, width=50)
        path_entry.pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        # 绑定回车键，输入路径后按回车自动导出
        path_entry.bind('<Return>', lambda e: self._start_export())
        
        ttk.Button(
            path_input_frame,
            text="浏览...",
            command=self._select_export_path
        ).pack(side=tk.LEFT, padx=5)
        
        # 导出格式选择
        format_frame = ttk.LabelFrame(self, text="导出格式", padding="10")
        format_frame.pack(fill=tk.X, pady=5)
        
        ttk.Radiobutton(
            format_frame,
            text="Excel (.xlsx)",
            variable=self.export_format_var,
            value="xlsx"
        ).pack(anchor=tk.W, pady=2)
        
        ttk.Radiobutton(
            format_frame,
            text="CSV (.csv)",
            variable=self.export_format_var,
            value="csv"
        ).pack(anchor=tk.W, pady=2)
        
        # 导出信息
        info_frame = ttk.LabelFrame(self, text="导出信息", padding="10")
        info_frame.pack(fill=tk.X, pady=5)
        
        if self.df is not None:
            total_rows = len(self.df)
            total_cols = len(self.df.columns) if not self.selected_columns else len(self.selected_columns)
            
            info_text = f"总行数: {total_rows}\n"
            info_text += f"导出列数: {total_cols}"
            
            if self.selected_columns:
                info_text += f"\n已选择的列: {', '.join(self.selected_columns[:5])}"
                if len(self.selected_columns) > 5:
                    info_text += f" ... (共{len(self.selected_columns)}列)"
            
            # 如果有数据透视表，显示提示信息
            if self.pivot_df is not None and not self.pivot_df.empty:
                info_text += f"\n\n数据透视表: {len(self.pivot_df)} 行"
                info_text += "\n(Excel格式将创建单独sheet，CSV格式将创建单独文件)"
            
            ttk.Label(info_frame, text=info_text, justify=tk.LEFT).pack(anchor=tk.W)
        
        # 进度条
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(
            self,
            variable=self.progress_var,
            maximum=100,
            length=400
        )
        self.progress_bar.pack(pady=10)
        
        self.status_label = ttk.Label(self, text="", foreground="gray")
        self.status_label.pack()
        
        # 按钮区域（只保留上一步按钮，选择路径后自动导出）
        button_frame = ttk.Frame(self)
        button_frame.pack(pady=20)
        
        ttk.Button(
            button_frame,
            text="上一步",
            command=self._on_back,
            width=15
        ).pack(side=tk.LEFT, padx=5)
    
    def _select_export_path(self):
        """选择导出路径，选择后自动导出"""
        format_ext = ".xlsx" if self.export_format_var.get() == "xlsx" else ".csv"
        
        file_path = filedialog.asksaveasfilename(
            title="选择导出路径",
            defaultextension=format_ext,
            filetypes=[
                ("Excel文件", "*.xlsx"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.export_path_var.set(file_path)
            # 选择路径后自动触发导出
            self.after(100, self._start_export)  # 延迟100ms确保路径已设置
    
    def _start_export(self):
        """开始导出"""
        export_path = self.export_path_var.get()
        if not export_path:
            messagebox.showwarning("警告", "请选择导出路径")
            return
        
        export_format = self.export_format_var.get()
        
        # 更新格式
        if export_format == "xlsx" and not export_path.endswith('.xlsx'):
            export_path = os.path.splitext(export_path)[0] + '.xlsx'
            self.export_path_var.set(export_path)
        elif export_format == "csv" and not export_path.endswith('.csv'):
            export_path = os.path.splitext(export_path)[0] + '.csv'
            self.export_path_var.set(export_path)
        
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("导出中")
        progress_window.geometry("350x150")
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        
        # 居中显示
        progress_window.update_idletasks()
        x = (progress_window.winfo_screenwidth() // 2) - (progress_window.winfo_width() // 2)
        y = (progress_window.winfo_screenheight() // 2) - (progress_window.winfo_height() // 2)
        progress_window.geometry(f"+{x}+{y}")
        
        progress_label = ttk.Label(progress_window, text="正在导出数据，请稍候...", font=("Arial", 10))
        progress_label.pack(pady=20)
        
        progress_var_window = tk.DoubleVar()
        progress_bar_window = ttk.Progressbar(progress_window, variable=progress_var_window, maximum=100, length=300, mode='determinate')
        progress_bar_window.pack(pady=10)
        
        status_label_window = ttk.Label(progress_window, text="", font=("Arial", 9), foreground="gray")
        status_label_window.pack(pady=5)
        
        # 在后台线程中执行导出
        def export_task():
            try:
                # 安全地更新GUI组件（检查组件是否还存在）
                def safe_update_progress(text="", progress=10, status=""):
                    try:
                        if progress_window.winfo_exists():
                            if text:
                                progress_label.config(text=text)
                            if status:
                                status_label_window.config(text=status)
                            progress_var_window.set(progress)
                    except Exception:
                        pass  # 如果组件已销毁，忽略错误
                
                self.root.after(0, lambda: safe_update_progress("正在准备数据...", 10, "正在准备数据..."))
                self.status_label.config(text="正在导出，请稍候...")
                self.progress_var.set(50)
                
                # 复制DataFrame并替换列名
                df_to_export = self.df.copy()
                full_df_to_export = self.full_df.copy() if self.full_df is not None else None
                pivot_df_to_export = self.pivot_df.copy() if self.pivot_df is not None else None
                
                # 替换列名中的_文件1/_文件2为显示名称
                df_to_export.columns = [self._format_column_name(col) for col in df_to_export.columns]
                if full_df_to_export is not None:
                    full_df_to_export.columns = [self._format_column_name(col) for col in full_df_to_export.columns]
                if pivot_df_to_export is not None:
                    # 处理pivot_df的列名（可能是MultiIndex）
                    if isinstance(pivot_df_to_export.columns, pd.MultiIndex):
                        new_cols = pd.MultiIndex.from_tuples([
                            tuple(self._format_column_name(str(c)) for c in col) for col in pivot_df_to_export.columns
                        ])
                        pivot_df_to_export.columns = new_cols
                    else:
                        pivot_df_to_export.columns = [self._format_column_name(col) for col in pivot_df_to_export.columns]
                    # 处理索引名
                    if isinstance(pivot_df_to_export.index, pd.MultiIndex):
                        new_index_names = [self._format_column_name(str(name)) if name else name for name in pivot_df_to_export.index.names]
                        pivot_df_to_export.index.names = new_index_names
                    elif pivot_df_to_export.index.name:
                        pivot_df_to_export.index.name = self._format_column_name(pivot_df_to_export.index.name)
                
                # 处理汇总表配置中的列名（也需要格式化，与 full_df 列名一致）
                summary_config_to_export = None
                if self.summary_config:
                    summary_config_to_export = self.summary_config.copy()
                    # 格式化汇总表配置中的列名
                    if summary_config_to_export.get('category_col'):
                        summary_config_to_export['category_col'] = self._format_column_name(summary_config_to_export['category_col'])
                # 格式化单列匹配（向后兼容）
                if summary_config_to_export.get('match_col'):
                    summary_config_to_export['match_col'] = self._format_column_name(summary_config_to_export['match_col'])
                if summary_config_to_export.get('match_col2'):
                    summary_config_to_export['match_col2'] = self._format_column_name(summary_config_to_export['match_col2'])
                # 格式化多列匹配
                if summary_config_to_export.get('match_cols'):
                    summary_config_to_export['match_cols'] = [self._format_column_name(col) for col in summary_config_to_export['match_cols']]
                if summary_config_to_export.get('match_cols2'):
                    summary_config_to_export['match_cols2'] = [self._format_column_name(col) for col in summary_config_to_export['match_cols2']]
                    if summary_config_to_export.get('original_value_col1'):
                        summary_config_to_export['original_value_col1'] = self._format_column_name(summary_config_to_export['original_value_col1'])
                    if summary_config_to_export.get('original_value_col2'):
                        summary_config_to_export['original_value_col2'] = self._format_column_name(summary_config_to_export['original_value_col2'])
                    if summary_config_to_export.get('depreciation_col1'):
                        summary_config_to_export['depreciation_col1'] = self._format_column_name(summary_config_to_export['depreciation_col1'])
                    if summary_config_to_export.get('depreciation_col2'):
                        summary_config_to_export['depreciation_col2'] = self._format_column_name(summary_config_to_export['depreciation_col2'])
                    # 构建 field_mapping 带显示名后缀，供 FA List / 新增清单 / 处置清单 直接按列名取数
                    fm_raw = summary_config_to_export.get('field_mapping') or {}
                    fm_fmt = {}
                    for k, v in fm_raw.items():
                        if not v:
                            fm_fmt[k] = None
                            continue
                        if k.endswith('_col1'):
                            fm_fmt[k] = self._format_column_name(f"{v}_文件1")
                        elif k.endswith('_col2'):
                            fm_fmt[k] = self._format_column_name(f"{v}_文件2")
                        else:
                            fm_fmt[k] = v
                    summary_config_to_export['field_mapping'] = fm_fmt
                    # 汇总表 fill_category：显式传入带显示名后缀的 category_col1/2
                    summary_config_to_export['category_col1'] = fm_fmt.get('category_col1')
                    summary_config_to_export['category_col2'] = fm_fmt.get('category_col2')
                    # 与透视表完全一致：格式化透视表行字段并传入
                    pf = summary_config_to_export.get('pivot_row_fields') or []
                    if pf:
                        summary_config_to_export['pivot_row_fields'] = [self._format_column_name(c) for c in pf]
                
                # 更新进度
                def safe_update_progress(text="", progress=30, status=""):
                    try:
                        if progress_window.winfo_exists():
                            if text:
                                progress_label.config(text=text)
                            if status:
                                status_label_window.config(text=status)
                            progress_var_window.set(progress)
                    except Exception:
                        pass
                
                self.root.after(0, lambda: safe_update_progress("正在导出主数据...", 30, "正在导出主数据..."))
                
                # 导出主数据
                success, error_msg = self.exporter.export_dataframe(
                    df_to_export,
                    export_path,
                    [self._format_column_name(col) for col in self.selected_columns] if self.selected_columns else None,
                    export_format,
                    pivot_df=pivot_df_to_export,  # 传递数据透视表
                    full_df=full_df_to_export,  # 传递完整数据（用于原值增加/减少清单）
                    summary_config=summary_config_to_export  # 传递汇总表配置
                )

                # 更新进度并关闭窗口
                def safe_close_progress():
                    try:
                        if progress_window.winfo_exists():
                            progress_var_window.set(100)
                            progress_window.destroy()
                    except Exception:
                        pass
                
                self.root.after(0, safe_close_progress)
                self.root.after(0, lambda: self._on_export_complete(success, error_msg))
            except Exception as e:
                # 安全地关闭进度窗口
                def safe_close_on_error():
                    try:
                        if progress_window.winfo_exists():
                            progress_window.destroy()
                    except Exception:
                        pass
                self.root.after(0, safe_close_on_error)
                self.root.after(0, lambda: self._on_export_complete(False, f"导出过程中发生错误: {str(e)}"))
        
        threading.Thread(target=export_task, daemon=True).start()
    
    def _on_export_complete(self, success: bool, error_msg: str):
        """导出完成回调"""
        self.progress_var.set(100)
        
        if success:
            self.status_label.config(text="导出完成！", foreground="green")
            correction_warnings = []
            if "===CORRECTION_WARNINGS===" in error_msg:
                parts = error_msg.split("===CORRECTION_WARNINGS===")
                error_msg = parts[0].strip()
                if len(parts) > 1:
                    correction_warnings = [line.strip() for line in parts[1].split("\n") if line.strip()]
            for warning in correction_warnings:
                if "【导出提速】" in warning:
                    messagebox.showwarning("折旧测算公式填充提示", warning)
                else:
                    messagebox.showwarning("导出提示", warning)
            if self.on_complete:
                self.on_complete()
        else:
            self.status_label.config(text="导出失败", foreground="red")
            messagebox.showerror("导出失败", error_msg)
    
    def _format_column_name(self, col_name):
        """将列名中的_文件1/_文件2替换为显示名称"""
        if col_name is None:
            return col_name
        col_str = str(col_name)
        if '_文件1' in col_str:
            return col_str.replace('_文件1', f'_{self.file1_display_name}')
        elif '_文件2' in col_str:
            return col_str.replace('_文件2', f'_{self.file2_display_name}')
        return col_str
    
    def _on_back(self):
        """上一步按钮"""
        if self.on_back:
            self.on_back()
    
    @property
    def root(self):
        """获取根窗口"""
        widget = self
        while widget.master:
            widget = widget.master
        return widget
