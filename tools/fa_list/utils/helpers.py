"""
辅助函数
"""
import pandas as pd
import numpy as np
from typing import Optional, List, Tuple


def detect_encoding(file_path: str) -> str:
    """
    检测文件编码
    
    Args:
        file_path: 文件路径
        
    Returns:
        编码名称
    """
    try:
        import chardet
        with open(file_path, 'rb') as f:
            raw_data = f.read(10000)  # 读取前10KB
            result = chardet.detect(raw_data)
            return result.get('encoding', 'utf-8')
    except Exception:
        return 'utf-8'


def normalize_text(value) -> str:
    """
    标准化文本值
    
    Args:
        value: 输入值
        
    Returns:
        标准化后的字符串
    """
    if pd.isna(value):
        return ''
    
    value_str = str(value).strip()
    return value_str


def normalize_number(value) -> Optional[float]:
    """
    标准化数字值
    
    Args:
        value: 输入值
        
    Returns:
        标准化后的数字或None
    """
    if pd.isna(value):
        return None
    
    try:
        # 尝试转换为数字
        if isinstance(value, str):
            # 去除千分位分隔符
            value = value.replace(',', '').replace(' ', '')
        return float(value)
    except (ValueError, TypeError):
        return None


def normalize_date(value) -> Optional[str]:
    """
    标准化日期值
    
    Args:
        value: 输入值
        
    Returns:
        标准化后的日期字符串 (YYYY-MM-DD) 或None
    """
    if pd.isna(value):
        return None
    
    try:
        # 尝试解析为日期
        if isinstance(value, str):
            date_obj = pd.to_datetime(value, errors='coerce')
        else:
            date_obj = pd.to_datetime(value, errors='coerce')
        
        if pd.isna(date_obj):
            return None
        
        # 检查是否是无效日期（如1970-01-01，这通常是时间戳0对应的日期）
        # 如果原始值不是日期格式，但被错误解析为1970-01-01，则返回None
        date_str = date_obj.strftime('%Y-%m-%d')
        if date_str == '1970-01-01':
            # 检查原始值是否看起来像日期
            if isinstance(value, str):
                # 如果原始字符串不包含日期相关的字符（如-、/、年月日等），可能是误解析
                if not any(char in value for char in ['-', '/', '年', '月', '日', ':', ' ']):
                    return None
            elif isinstance(value, (int, float)):
                # 如果是数字且很小（可能是时间戳0），返回None
                if abs(value) < 1:
                    return None
        
        return date_str
    except Exception:
        return None


def detect_column_type(series: pd.Series) -> str:
    """
    自动检测列的数据类型
    
    Args:
        series: pandas Series
        
    Returns:
        类型名称: 'text', 'number', 'date', 'mixed'
    """
    non_null = series.dropna()
    if len(non_null) == 0:
        return 'text'
    
    # 尝试日期
    date_count = 0
    for val in non_null.head(100):  # 检查前100个值
        if normalize_date(val) is not None:
            date_count += 1
    
    if date_count / min(len(non_null), 100) > 0.8:
        return 'date'
    
    # 尝试数字
    number_count = 0
    for val in non_null.head(100):
        if normalize_number(val) is not None:
            number_count += 1
    
    if number_count / min(len(non_null), 100) > 0.8:
        return 'number'
    
    return 'text'


def get_column_matches(columns1: List[str], columns2: List[str]) -> List[Tuple[str, str]]:
    """
    自动匹配两个文件的列名
    
    Args:
        columns1: 文件1的列名列表（可能是字符串或整数）
        columns2: 文件2的列名列表（可能是字符串或整数）
        
    Returns:
        匹配的列对列表 [(col1, col2), ...]
    """
    matches = []
    
    # 精确匹配
    for col1 in columns1:
        if col1 in columns2:
            matches.append((col1, col1))
    
    # 忽略大小写匹配（确保列名是字符串）
    col2_lower = {str(col).lower(): col for col in columns2}
    for col1 in columns1:
        col1_str = str(col1).lower()
        if col1_str in col2_lower and (col1, col2_lower[col1_str]) not in matches:
            matches.append((col1, col2_lower[col1_str]))
    
    return matches
