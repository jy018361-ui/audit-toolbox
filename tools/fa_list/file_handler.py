"""
文件处理模块
支持Excel和CSV文件的读取
"""
import pandas as pd
import os
import hashlib
import tempfile
from typing import Optional, Tuple
from utils.validators import validate_file_path, validate_dataframe
from utils.helpers import detect_encoding
from config import SUPPORTED_EXCEL_FORMATS, SUPPORTED_CSV_FORMATS, PREVIEW_ROWS


class FileHandler:
    """文件处理器"""
    
    def __init__(self):
        self.file1_path = None
        self.file2_path = None
        self.file1_df = None
        self.file2_df = None
        self.file1_sheet = None
        self.file2_sheet = None

    def _resolve_sheet_name(self, file_path: str, sheet_name: Optional[str]) -> Optional[str]:
        """Resolve sheet name to an existing sheet; fallback to first sheet when missing."""
        if not sheet_name:
            return None
        try:
            success, _, sheets = self.get_excel_sheets(file_path)
            if success and sheets and sheet_name not in sheets:
                return sheets[0]
        except Exception:
            pass
        return sheet_name
    
    def _detect_header_row(self, df_raw: pd.DataFrame, max_rows: int = 3) -> int:
        """
        检测有效的标题行索引（0-based）
        
        Args:
            df_raw: 原始DataFrame（header=None读取的前几行）
            max_rows: 最多检查的行数
            
        Returns:
            int: 有效的标题行索引（0-based）
        """
        if df_raw is None or df_raw.empty:
            return 0
        
        for i in range(min(max_rows, len(df_raw))):
            row = df_raw.iloc[i]
            # 检查行是否有效（非空、非全NaN、至少有一半的列有值）
            non_null_count = row.notna().sum()
            total_cols = len(row)
            if total_cols > 0 and non_null_count > total_cols * 0.5:  # 至少一半的列有值
                # 进一步检查：如果所有值都是字符串且长度合理，更可能是标题行
                non_null_values = [str(val) for val in row if pd.notna(val)]
                if non_null_values:
                    # 检查是否有至少一个非空字符串（不是纯空格）
                    meaningful_values = [v for v in non_null_values if v.strip()]
                    if len(meaningful_values) >= non_null_count * 0.7:  # 至少70%的非空值是有效的
                        return i
        
        # 如果所有行都无效，默认使用第一行
        return 0
    
    def _convert_excel_to_csv(self, file_path: str, sheet_name: Optional[str] = None) -> str:
        """
        将Excel文件转换为CSV，返回CSV文件路径
        
        Args:
            file_path: Excel文件路径
            sheet_name: 工作表名称（可选）
            
        Returns:
            str: CSV文件路径
        """
        # 生成缓存文件名
        sheet_name = self._resolve_sheet_name(file_path, sheet_name)
        cache_key = f"{file_path}_{sheet_name or 'default'}"
        cache_hash = hashlib.md5(cache_key.encode('utf-8')).hexdigest()
        cache_dir = os.path.join(tempfile.gettempdir(), 'excel_merge_cache')
        os.makedirs(cache_dir, exist_ok=True)
        csv_path = os.path.join(cache_dir, f"{cache_hash}.csv")
        
        # 检查缓存：如果CSV已存在且比Excel新，直接使用
        if os.path.exists(csv_path):
            try:
                csv_mtime = os.path.getmtime(csv_path)
                excel_mtime = os.path.getmtime(file_path)
                if csv_mtime >= excel_mtime:
                    return csv_path
            except Exception:
                # 如果时间比较失败，重新转换
                pass
        
        # 读取Excel并转换为CSV
        _, ext = os.path.splitext(file_path)
        if ext.lower() == '.xls':
            df = pd.read_excel(file_path, sheet_name=sheet_name, engine='xlrd')
        else:
            if sheet_name:
                df = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl')
            else:
                df = pd.read_excel(file_path, sheet_name=0, engine='openpyxl')
        
        # 保存为CSV，使用utf-8-sig编码以确保Excel兼容性
        df.to_csv(csv_path, index=False, encoding='utf-8-sig')
        
        return csv_path
    
    def load_file(self, file_path: str, sheet_name: Optional[str] = None, header: Optional[int] = None) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        加载文件
        
        Args:
            file_path: 文件路径
            sheet_name: Excel工作表名称（可选）
            header: 标题行索引（0-based，可选，None表示使用第一行）
            
        Returns:
            tuple: (成功标志, 错误消息, DataFrame)
        """
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler.load_file.entry", message="loading file", data={"file_path": file_path, "sheet_name": sheet_name, "header": header})
        # #endregion
        
        # 验证文件
        is_valid, error_msg = validate_file_path(file_path)
        if not is_valid:
            return False, error_msg, None
        
        try:
            _, ext = os.path.splitext(file_path)
            ext = ext.lower()
            
            # 读取Excel文件
            if ext in SUPPORTED_EXCEL_FORMATS:
                return self._load_excel(file_path, sheet_name, header)
            
            # 读取CSV文件
            elif ext in SUPPORTED_CSV_FORMATS:
                return self._load_csv(file_path, header)
            
            else:
                return False, f"不支持的文件格式: {ext}", None
                
        except Exception as e:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler.load_file.error", message="error loading file", data={"error": str(e)})
            # #endregion
            return False, f"读取文件时出错: {str(e)}", None
    
    def _load_excel(self, file_path: str, sheet_name: Optional[str] = None, header: Optional[int] = None) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """加载Excel文件"""
        try:
            sheet_name = self._resolve_sheet_name(file_path, sheet_name)
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            # #endregion
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_handler._load_excel.entry", message="loading excel", data={"file_path": file_path, "sheet_name": sheet_name, "header": header})
            # #endregion
            
            _, ext = os.path.splitext(file_path)
            ext_lower = ext.lower()
            
            # 将Excel转换为CSV以提高处理速度
            csv_path = self._convert_excel_to_csv(file_path, sheet_name)
            
            # 使用CSV文件进行后续处理（更快的读取速度）
            # 如果header为None，先检测有效的标题行
            if header is None:
                try:
                    # 读取前3行原始数据用于检测标题行
                    df_raw = pd.read_csv(csv_path, encoding='utf-8-sig', header=None, nrows=3, low_memory=False)
                    
                    # 检测有效的标题行
                    detected_header = self._detect_header_row(df_raw, max_rows=3)
                    header = detected_header
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_handler._load_excel.header_detected", message="header detected", data={"detected_header": detected_header})
                    # #endregion
                except Exception as e:
                    # 如果检测失败，使用默认值0
                    header = 0
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_handler._load_excel.header_detect_failed", message="header detection failed", data={"error": str(e), "using_default": 0})
                    # #endregion
            
            # 使用CSV文件读取（比Excel快得多）
            actual_header = 0 if header is None else header
            df = pd.read_csv(csv_path, encoding='utf-8-sig', header=actual_header, low_memory=False)
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_handler._load_excel.success", message="excel loaded", data={"rows": len(df), "cols": len(df.columns), "columns": list(df.columns)[:5], "column_types": [type(c).__name__ for c in df.columns[:5]], "first_row_sample": list(df.iloc[0, :5]) if len(df) > 0 else []})
            # #endregion
            
            # 检查第一行是否可能是标题行（如果列名看起来像数据值，可能需要调整header）
            if len(df) > 0 and len(df.columns) > 0:
                # 检查列名是否看起来像数据值（包含数字、日期格式等）
                col_sample = str(df.columns[0])
                first_row_sample = str(df.iloc[0, 0]) if len(df) > 0 else ''
                # 尝试读取前几行原始数据（不使用header）来检查
                try:
                    if ext.lower() == '.xls':
                        df_raw = pd.read_excel(file_path, sheet_name=sheet_name, engine='xlrd', header=None, nrows=3)
                    else:
                        if sheet_name:
                            df_raw = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl', header=None, nrows=3)
                        else:
                            df_raw = pd.read_excel(file_path, sheet_name=0, engine='openpyxl', header=None, nrows=3)
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_handler._load_excel.header_check", message="checking header", data={"header_param": header, "first_col_name": col_sample, "first_row_first_col": first_row_sample, "raw_first_row": list(df_raw.iloc[0, :5]) if len(df_raw) > 0 else [], "raw_second_row": list(df_raw.iloc[1, :5]) if len(df_raw) > 1 else []})
                    # #endregion
                except Exception as e:
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_handler._load_excel.header_check_error", message="error checking raw rows", data={"error": str(e)})
                    # #endregion
                    pass
            
            # 验证数据
            is_valid, error_msg = validate_dataframe(df)
            if not is_valid:
                return False, error_msg, None
            
            return True, "", df
            
        except Exception as e:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_handler._load_excel.error", message="error loading excel", data={"error": str(e)})
            # #endregion
            return False, f"读取Excel文件时出错: {str(e)}", None
    
    def _load_csv(self, file_path: str, header: Optional[int] = None) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """加载CSV文件"""
        try:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            # #endregion
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.entry", message="loading csv", data={"file_path": file_path, "header": header})
            # #endregion
            
            # 如果header为None，先检测有效的标题行
            if header is None:
                try:
                    # 检测编码
                    encoding = detect_encoding(file_path)
                    encodings = [encoding, 'utf-8', 'gbk', 'gb2312', 'latin-1']
                    
                    # 读取前3行原始数据用于检测标题行
                    df_raw = None
                    for enc in encodings:
                        try:
                            df_raw = pd.read_csv(file_path, encoding=enc, header=None, nrows=3, low_memory=False)
                            break
                        except (UnicodeDecodeError, Exception):
                            continue
                    
                    if df_raw is not None and not df_raw.empty:
                        # 检测有效的标题行
                        detected_header = self._detect_header_row(df_raw, max_rows=3)
                        header = detected_header
                        # #region agent log
                        _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.header_detected", message="header detected", data={"detected_header": detected_header})
                        # #endregion
                    else:
                        header = 0
                except Exception as e:
                    # 如果检测失败，使用默认值0
                    header = 0
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.header_detect_failed", message="header detection failed", data={"error": str(e), "using_default": 0})
                    # #endregion
            
            # 如果header为None，使用0（pandas默认使用第一行作为标题行）
            # 如果header为0，也表示使用第一行作为标题行
            # 如果header > 0，使用指定的行作为标题行
            actual_header = 0 if header is None else header
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.header_conversion", message="header conversion", data={"header": header, "actual_header": actual_header})
            # #endregion
            
            # 检测编码
            encoding = detect_encoding(file_path)
            
            # 尝试不同的编码
            encodings = [encoding, 'utf-8', 'gbk', 'gb2312', 'latin-1']
            df = None
            last_error = None
            
            for enc in encodings:
                try:
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.trying_encoding", message="trying encoding", data={"encoding": enc, "header": header, "actual_header": actual_header})
                    # #endregion
                    # 优化CSV读取参数以提高速度
                    # 使用engine='c'（默认，但明确指定以确保使用C引擎）
                    # low_memory=False已经设置，避免分块读取以提高速度
                    # 对于大文件，可以考虑使用chunksize，但这里为了简化，先不使用
                    df = pd.read_csv(
                        file_path, 
                        encoding=enc, 
                        low_memory=False, 
                        header=actual_header,
                        engine='c'  # 明确使用C引擎（更快，pandas默认也是'c'）
                    )
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.success", message="csv loaded", data={"encoding": enc, "rows": len(df), "cols": len(df.columns), "columns": list(df.columns)[:5], "column_types": [type(c).__name__ for c in df.columns[:5]]})
                    # #endregion
                    break
                except UnicodeDecodeError as e:
                    last_error = e
                    continue
                except Exception as e:
                    last_error = e
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.encoding_error", message="encoding error", data={"encoding": enc, "error": str(e)})
                    # #endregion
                    continue
            
            if df is None:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.failed", message="csv load failed", data={"encodings": encodings, "last_error": str(last_error)})
                # #endregion
                return False, f"无法读取CSV文件，尝试的编码: {', '.join(encodings)}。错误: {str(last_error)}", None
            
            # 验证数据
            is_valid, error_msg = validate_dataframe(df)
            if not is_valid:
                return False, error_msg, None
            
            return True, "", df
            
        except Exception as e:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="file_handler._load_csv.error", message="error loading csv", data={"error": str(e)})
            # #endregion
            return False, f"读取CSV文件时出错: {str(e)}", None
    
    def get_excel_sheets(self, file_path: str) -> Tuple[bool, str, list]:
        """
        获取Excel文件的所有工作表名称
        
        Args:
            file_path: Excel文件路径
            
        Returns:
            tuple: (成功标志, 错误消息, 工作表名称列表)
        """
        try:
            _, ext = os.path.splitext(file_path)
            if ext.lower() == '.xls':
                xl_file = pd.ExcelFile(file_path, engine='xlrd')
            else:
                xl_file = pd.ExcelFile(file_path, engine='openpyxl')
            
            sheet_names = xl_file.sheet_names
            return True, "", sheet_names
            
        except Exception as e:
            return False, f"获取工作表列表时出错: {str(e)}", []
    
    def set_file1(self, file_path: str, sheet_name: Optional[str] = None, header: Optional[int] = None) -> Tuple[bool, str]:
        """
        设置文件1
        
        Returns:
            tuple: (成功标志, 错误消息)
        """
        resolved_sheet = self._resolve_sheet_name(file_path, sheet_name)
        success, error_msg, df = self.load_file(file_path, resolved_sheet, header)
        if success:
            # 移除列名中的"_文件1"和"_文件2"后缀（如果存在），因为文件可能来自之前的合并结果
            if df is not None and len(df.columns) > 0:
                rename_dict = {}
                for col in df.columns:
                    col_str = str(col)
                    # 移除所有可能的文件后缀
                    new_col = col_str.replace('_文件1', '').replace('_文件2', '')
                    if new_col != col_str:
                        rename_dict[col] = new_col
                if rename_dict:
                    df = df.rename(columns=rename_dict)
            
            self.file1_path = file_path
            self.file1_df = df
            self.file1_sheet = resolved_sheet
        return success, error_msg
    
    def set_file2(self, file_path: str, sheet_name: Optional[str] = None, header: Optional[int] = None) -> Tuple[bool, str]:
        """
        设置文件2
        
        Returns:
            tuple: (成功标志, 错误消息)
        """
        resolved_sheet = self._resolve_sheet_name(file_path, sheet_name)
        success, error_msg, df = self.load_file(file_path, resolved_sheet, header)
        if success:
            # 移除列名中的"_文件1"和"_文件2"后缀（如果存在），因为文件可能来自之前的合并结果
            if df is not None and len(df.columns) > 0:
                rename_dict = {}
                for col in df.columns:
                    col_str = str(col)
                    # 移除所有可能的文件后缀
                    new_col = col_str.replace('_文件1', '').replace('_文件2', '')
                    if new_col != col_str:
                        rename_dict[col] = new_col
                if rename_dict:
                    df = df.rename(columns=rename_dict)
            
            self.file2_path = file_path
            self.file2_df = df
            self.file2_sheet = resolved_sheet
        return success, error_msg
    
    def get_file1_preview(self, n_rows: int = PREVIEW_ROWS) -> Optional[pd.DataFrame]:
        """获取文件1的预览"""
        if self.file1_df is None:
            return None
        return self.file1_df.head(n_rows)
    
    def get_file2_preview(self, n_rows: int = PREVIEW_ROWS) -> Optional[pd.DataFrame]:
        """获取文件2的预览"""
        if self.file2_df is None:
            return None
        return self.file2_df.head(n_rows)
    
    def get_file1_columns(self) -> list:
        """获取文件1的列名列表"""
        if self.file1_df is None:
            return []
        return list(self.file1_df.columns)
    
    def get_file2_columns(self) -> list:
        """获取文件2的列名列表"""
        if self.file2_df is None:
            return []
        return list(self.file2_df.columns)
    
    def clear(self):
        """清除所有加载的文件"""
        self.file1_path = None
        self.file2_path = None
        self.file1_df = None
        self.file2_df = None
        self.file1_sheet = None
        self.file2_sheet = None
