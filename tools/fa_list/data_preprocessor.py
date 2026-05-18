"""
数据预处理模块
处理匹配列的格式统一和类型转换
"""
import pandas as pd
import numpy as np
from typing import Optional, Dict, List, Callable, Union
from utils.helpers import (
    normalize_text, normalize_number, normalize_date,
    detect_column_type
)
from config import DEFAULT_TEXT_CLEANUP, DEFAULT_CASE_SENSITIVE


class DataPreprocessor:
    """数据预处理器"""
    
    def __init__(self):
        self.preprocessing_config = {}
    
    def preprocess_column(
        self,
        df: pd.DataFrame,
        column_name: str,
        data_type: str = 'auto',
        remove_spaces: bool = DEFAULT_TEXT_CLEANUP,
        case_sensitive: bool = DEFAULT_CASE_SENSITIVE
    ) -> pd.DataFrame:
        """
        预处理指定列
        
        Args:
            df: 原始DataFrame
            column_name: 列名
            data_type: 数据类型 ('text', 'number', 'date', 'auto')
            remove_spaces: 是否去除空格（文本类型）
            case_sensitive: 是否区分大小写（文本类型）
            
        Returns:
            处理后的DataFrame
        """
        if column_name not in df.columns:
            return df
        
        df = df.copy()
        series = df[column_name]
        
        # 整型浮点数转为无小数点字符串，避免 "1100000.0" 导致匹配失败
        def _to_match_str(x):
            if pd.isna(x):
                return ''
            if isinstance(x, float) and x == int(x):
                return str(int(x))
            return str(x)
        
        # 自动检测类型
        if data_type == 'auto':
            data_type = detect_column_type(series)
        
        # 根据类型进行预处理（保持原始数据格式）
        # 匹配列统一用 _to_match_str，使 1100000.0 -> "1100000"，避免导出和后续匹配带 .0
        if data_type == 'text':
            df[column_name] = series.apply(_to_match_str)
        elif data_type == 'number':
            df[column_name] = series.apply(_to_match_str)
        elif data_type == 'date':
            def safe_normalize_date(x):
                if pd.isna(x):
                    return ''
                original_value = x
                normalized = normalize_date(x)
                if normalized is None or normalized == '1970-01-01':
                    return _to_match_str(original_value)
                return normalized
            df[column_name] = series.apply(safe_normalize_date)
        else:
            df[column_name] = series.apply(_to_match_str)
        
        return df
    
    def _preprocess_text(self, value, remove_spaces: bool, case_sensitive: bool) -> str:
        """预处理文本值（保持原始格式，不进行空格和大小写转换）"""
        # 保持原始值，只转换为字符串
        if pd.isna(value):
            return ''
        return str(value)
    
    def _preprocess_mixed(self, value, remove_spaces: bool, case_sensitive: bool):
        """预处理混合类型值"""
        # 先尝试日期
        date_val = normalize_date(value)
        if date_val is not None:
            return date_val
        
        # 再尝试数字
        num_val = normalize_number(value)
        if num_val is not None:
            return num_val
        
        # 最后作为文本处理
        return self._preprocess_text(value, remove_spaces, case_sensitive)
    
    def preprocess_for_merge(
        self,
        df1: pd.DataFrame,
        df2: pd.DataFrame,
        match_columns1: Union[str, List[str]],
        match_columns2: Union[str, List[str]],
        data_type1: str = 'auto',
        data_type2: str = 'auto',
        remove_spaces: bool = DEFAULT_TEXT_CLEANUP,
        case_sensitive: bool = DEFAULT_CASE_SENSITIVE
    ) -> tuple:
        """
        为合并操作预处理两个DataFrame的匹配列（支持多列）
        
        Args:
            df1: 文件1的DataFrame
            df2: 文件2的DataFrame
            match_columns1: 文件1的匹配列名列表
            match_columns2: 文件2的匹配列名列表
            data_type1: 文件1匹配列的数据类型
            data_type2: 文件2匹配列的数据类型
            remove_spaces: 是否去除空格
            case_sensitive: 是否区分大小写
            
        Returns:
            tuple: (处理后的df1, 处理后的df2)
        """
        # 确保是列表格式（向后兼容）
        if isinstance(match_columns1, str):
            match_columns1 = [match_columns1]
        if isinstance(match_columns2, str):
            match_columns2 = [match_columns2]
        
        df1_processed = df1.copy()
        df2_processed = df2.copy()
        
        # 预处理每个匹配列
        for col1 in match_columns1:
            df1_processed = self.preprocess_column(
                df1_processed, col1, data_type1, remove_spaces, case_sensitive
            )
        
        for col2 in match_columns2:
            df2_processed = self.preprocess_column(
                df2_processed, col2, data_type2, remove_spaces, case_sensitive
            )
        
        # 确保对应位置的匹配列类型一致
        for col1, col2 in zip(match_columns1, match_columns2):
            df1_processed, df2_processed = self._align_column_types(
                df1_processed, df2_processed, col1, col2
            )
        
        return df1_processed, df2_processed
    
    def _align_column_types(
        self,
        df1: pd.DataFrame,
        df2: pd.DataFrame,
        col1: str,
        col2: str
    ) -> tuple:
        """
        对齐两个匹配列的数据类型。
        合并前始终将匹配列转为字符串，避免 float NaN 在 outer join 中产生笛卡尔积导致 OOM。
        """
        df1 = df1.copy()
        df2 = df2.copy()
        
        def to_match_str(s):
            # 处理 NaN、None、空值
            if pd.isna(s):
                return ''
            if s == '' or s is None:
                return ''
            
            # 如果是日期时间对象（Timestamp），检查是否是无效日期
            if isinstance(s, pd.Timestamp):
                # 检查是否是1970-01-01（Unix时间戳0），这通常是误解析的结果
                if s.year == 1970 and s.month == 1 and s.day == 1:
                    # 这可能是误解析，返回空字符串，让用户知道有问题
                    return ''
                # 否则正常转换为字符串
                return str(s).strip()
            
            # 如果是浮点数，检查是否是整数（如 1100003.0），如果是则去掉 ".0"
            if isinstance(s, (int, float)):
                # 如果是整数（浮点数但值为整数），转换为整数再转字符串，避免显示 ".0"
                if isinstance(s, float) and s.is_integer():
                    t = str(int(s))
                else:
                    t = str(s)
            else:
                # 转换为字符串并去除首尾空格
                t = str(s).strip()
            
            # 处理字符串形式的 'nan'、'None' 等
            if t.lower() in ('nan', 'none', 'null', '') or not t:
                return ''
            # 检查是否是"1970-01-01"字符串，这可能是误解析的结果
            if t == '1970-01-01' or t.startswith('1970-01-01'):
                # 如果原始值不是日期格式，这可能是误解析，返回空字符串
                return ''
            return t
        
        df1[col1] = df1[col1].apply(to_match_str)
        df2[col2] = df2[col2].apply(to_match_str)
        
        return df1, df2
    
    def validate_match_columns(
        self,
        df1: pd.DataFrame,
        df2: pd.DataFrame,
        match_columns1: Union[str, List[str]],
        match_columns2: Union[str, List[str]]
    ) -> tuple:
        """
        验证匹配列是否有效（支持多列）
        
        Args:
            df1: 文件1的DataFrame
            df2: 文件2的DataFrame
            match_columns1: 文件1的匹配列名列表
            match_columns2: 文件2的匹配列名列表
            
        Returns:
            tuple: (是否有效, 错误消息)
        """
        # 确保是列表格式（向后兼容）
        if isinstance(match_columns1, str):
            match_columns1 = [match_columns1]
        if isinstance(match_columns2, str):
            match_columns2 = [match_columns2]
        
        # 验证所有列都存在
        for col in match_columns1:
            if col not in df1.columns:
                return False, f"文件1中不存在列: {col}"
        
        for col in match_columns2:
            if col not in df2.columns:
                return False, f"文件2中不存在列: {col}"
        
        # 验证两边列数相同
        if len(match_columns1) != len(match_columns2):
            return False, f"文件1和文件2的匹配列数量必须相同（当前：文件1={len(match_columns1)}列，文件2={len(match_columns2)}列）"
        
        return True, ""
