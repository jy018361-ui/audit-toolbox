"""
数据验证工具
"""
import os
from config import SUPPORTED_FORMATS


def validate_file_path(file_path):
    """
    验证文件路径是否有效
    
    Args:
        file_path: 文件路径
        
    Returns:
        tuple: (is_valid, error_message)
    """
    if not file_path:
        return False, "文件路径为空"
    
    if not os.path.exists(file_path):
        return False, "文件不存在"
    
    if not os.path.isfile(file_path):
        return False, "路径不是文件"
    
    _, ext = os.path.splitext(file_path)
    if ext.lower() not in SUPPORTED_FORMATS:
        return False, f"不支持的文件格式: {ext}。支持的格式: {', '.join(SUPPORTED_FORMATS)}"
    
    return True, ""


def validate_dataframe(df, min_rows=0):
    """
    验证DataFrame是否有效
    
    Args:
        df: pandas DataFrame
        min_rows: 最小行数要求
        
    Returns:
        tuple: (is_valid, error_message)
    """
    if df is None:
        return False, "数据为空"
    
    if df.empty:
        return False, "数据文件为空"
    
    if len(df) < min_rows:
        return False, f"数据行数不足，至少需要 {min_rows} 行"
    
    if df.columns.empty:
        return False, "数据文件没有列"
    
    return True, ""
