"""
数据预览界面
"""
import tkinter as tk
from tkinter import ttk
import pandas as pd
from config import PREVIEW_ROWS

# #region agent log
try:
    from debug_logger import _write as _dbg
except Exception:
    _dbg = lambda **kw: None
# #endregion


class DataPreview(ttk.Frame):
    """数据预览组件"""
    
    def __init__(self, parent, df: pd.DataFrame, max_rows: int = PREVIEW_ROWS, on_complete=None, on_back=None):
        super().__init__(parent, padding="10")
        self.df = df
        self.max_rows = max_rows
        self.on_complete = on_complete
        self.on_back = on_back
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="data_preview.__init__",
             message="DataPreview init", data={"df_is_none": df is None, "df_empty": df.empty if df is not None else None, "cols": list(df.columns)[:5] if df is not None else None})
        # #endregion
        self._create_widgets()
        self._load_data()
    
    def _create_widgets(self):
        """创建界面组件"""
        # 标题和统计信息
        info_frame = ttk.Frame(self)
        info_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(
            info_frame,
            text="合并结果预览",
            font=("Arial", 12, "bold")
        ).pack(side=tk.LEFT)
        
        if self.df is not None:
            stats_text = f"总行数: {len(self.df)}, 总列数: {len(self.df.columns)}"
            ttk.Label(
                info_frame,
                text=stats_text,
                foreground="gray"
            ).pack(side=tk.LEFT, padx=20)
        
        # 表格框架
        table_frame = ttk.Frame(self)
        table_frame.pack(fill=tk.BOTH, expand=True)
        
        # 创建表格
        self.tree = ttk.Treeview(table_frame)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        # 滚动条
        v_scrollbar = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        v_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree.configure(yscrollcommand=v_scrollbar.set)
        
        h_scrollbar = ttk.Scrollbar(self, orient=tk.HORIZONTAL, command=self.tree.xview)
        h_scrollbar.pack(fill=tk.X, pady=(5, 0))
        self.tree.configure(xscrollcommand=h_scrollbar.set)
        
        # 按钮区域
        button_frame = ttk.Frame(self)
        button_frame.pack(pady=10)
        
        ttk.Button(
            button_frame,
            text="上一步",
            command=self._on_back,
            width=15
        ).pack(side=tk.LEFT, padx=5)
        
        ttk.Button(
            button_frame,
            text="下一步：选择导出列",
            command=self._on_next,
            width=20
        ).pack(side=tk.LEFT, padx=5)
    
    def _load_data(self):
        """加载数据到表格"""
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="data_preview._load_data.start",
             message="load_data start", data={"df_none": self.df is None, "df_empty": self.df.empty if self.df is not None else None})
        # #endregion
        if self.df is None or self.df.empty:
            return
        
        # 获取预览数据
        preview_df = self.df.head(self.max_rows)
        
        # 使用唯一列 id（c0,c1,...）避免 Treeview 对重复列名报错，表头显示真实列名
        columns = list(preview_df.columns)
        col_ids = [f"c{i}" for i in range(len(columns))]
        self.tree['columns'] = col_ids
        self.tree['show'] = 'headings'
        
        # 配置列
        try:
            for i, col in enumerate(columns):
                cid = col_ids[i]
                self.tree.heading(cid, text=str(col))
                vals = [len(str(val)) for val in preview_df.iloc[:, i].head(10) if pd.notna(val)]
                max_len = max([len(str(col))] + vals) if vals else len(str(col))
                self.tree.column(cid, width=min(max_len * 10 + 20, 200))
        except Exception as e:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="data_preview._load_data.config_cols",
                 message="config cols exception", data={"error": str(e)})
            # #endregion
            raise
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="data_preview._load_data.after_cols",
             message="after config cols", data={"ncols": len(columns), "npreview": len(preview_df)})
        # #endregion
        
        # 插入数据：按行/列位置 iloc 取值，避免重复列名或索引导致错列/空列
        n_inserted = 0
        for j in range(len(preview_df)):
            values = []
            for i in range(len(columns)):
                val = preview_df.iloc[j, i]
                if pd.isna(val):
                    values.append('')
                else:
                    val_str = str(val)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + '...'
                    values.append(val_str)
            self.tree.insert('', tk.END, values=values)
            n_inserted += 1
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="data_preview._load_data.after_insert",
             message="after insert rows", data={"n_inserted": n_inserted})
        # #endregion
    
    def _on_back(self):
        """上一步按钮"""
        if self.on_back:
            self.on_back()
    
    def _on_next(self):
        """下一步按钮：触发 on_complete 回调，由主窗口切换到步骤 3"""
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="data_preview._on_next",
             message="on_next clicked", data={})
        # #endregion
        if self.on_complete:
            self.on_complete()
