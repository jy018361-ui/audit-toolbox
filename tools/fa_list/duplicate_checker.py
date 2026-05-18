"""
重复值检测模块
检测文件1匹配列的重复值并提供处理选项
"""
import pandas as pd
from typing import Dict, List, Tuple, Optional, Union


class DuplicateChecker:
    """重复值检测器"""
    
    def __init__(self):
        self.duplicate_info = {}
    
    def check_duplicates(
        self,
        df: pd.DataFrame,
        match_columns: Union[str, List[str]]
    ) -> Tuple[bool, Dict]:
        """
        检测匹配列的重复值（支持多列）
        
        Args:
            df: 要检查的DataFrame
            match_columns: 匹配列名或列名列表
            
        Returns:
            tuple: (是否有重复, 重复值信息字典)
        """
        # 确保是列表格式（向后兼容）
        if isinstance(match_columns, str):
            match_columns = [match_columns]
        
        # 验证所有列都存在
        for col in match_columns:
            if col not in df.columns:
                return False, {}
        
        # 多列组合检测重复
        duplicates_mask = df.duplicated(subset=match_columns, keep=False)
        duplicates_df = df[duplicates_mask]
        
        if len(duplicates_df) == 0:
            return False, {}
        
        # 统计重复值信息（基于多列组合）
        duplicate_groups = duplicates_df.groupby(match_columns)
        duplicate_counts = duplicate_groups.size()
        duplicate_indices = {}
        
        for group_key, group_df in duplicate_groups:
            # group_key 可能是单个值（单列）或元组（多列）
            if isinstance(group_key, tuple):
                key_str = ' | '.join(str(k) for k in group_key)
            else:
                key_str = str(group_key)
            
            if pd.notna(group_key) and (isinstance(group_key, tuple) or group_key != ''):
                indices = group_df.index.tolist()
                duplicate_indices[key_str] = {
                    'count': len(indices),
                    'indices': indices,
                    'rows': group_df.to_dict('records')
                }
        
        self.duplicate_info = {
            'has_duplicates': True,
            'total_duplicate_values': len(duplicate_counts),
            'total_duplicate_rows': len(duplicates_df),
            'duplicate_details': duplicate_indices,
            'summary': self._generate_summary(duplicate_counts)
        }
        
        return True, self.duplicate_info
    
    def _generate_summary(self, duplicate_counts: pd.Series) -> str:
        """生成重复值摘要信息"""
        total_duplicates = len(duplicate_counts)
        total_rows = duplicate_counts.sum()
        
        summary = f"发现 {total_duplicates} 个重复值，涉及 {total_rows} 行数据。\n\n"
        summary += "重复值统计（前10个）：\n"
        
        for i, (value, count) in enumerate(duplicate_counts.head(10).items(), 1):
            summary += f"{i}. 值 '{value}': 出现 {count} 次\n"
        
        if len(duplicate_counts) > 10:
            summary += f"... 还有 {len(duplicate_counts) - 10} 个重复值\n"
        
        return summary
    
    def get_duplicate_summary(self) -> str:
        """获取重复值摘要文本"""
        if not self.duplicate_info:
            return "未检测到重复值"
        
        return self.duplicate_info.get('summary', '')
    
    def get_duplicate_details(self) -> Dict:
        """获取详细的重复值信息"""
        return self.duplicate_info.get('duplicate_details', {})
    
    def handle_duplicates_pivot_logic(
        self,
        df1: pd.DataFrame,
        df2: pd.DataFrame,
        match_column1: str,
        match_column2: str
    ) -> pd.DataFrame:
        """
        按数据透视逻辑处理重复值
        保留所有匹配记录，形成多对多关系
        
        Args:
            df1: 文件1的DataFrame
            df2: 文件2的DataFrame
            match_column1: 文件1的匹配列
            match_column2: 文件2的匹配列
            
        Returns:
            合并后的DataFrame（包含所有匹配关系）
        """
        # 使用pandas的merge，how='outer'会自动处理重复值
        # 如果文件1的匹配列有重复，会与文件2的每个匹配记录都形成一行
        merged = pd.merge(
            df1,
            df2,
            left_on=match_column1,
            right_on=match_column2,
            how='outer',
            suffixes=('_文件1', '_文件2')
        )
        
        return merged
    
    def handle_duplicates_keep_first(
        self,
        df: pd.DataFrame,
        match_columns: Union[str, List[str]]
    ) -> pd.DataFrame:
        """
        处理重复值：仅保留第一个（支持多列）
        
        Args:
            df: 原始DataFrame
            match_columns: 匹配列名或列名列表
            
        Returns:
            处理后的DataFrame
        """
        if isinstance(match_columns, str):
            match_columns = [match_columns]
        return df.drop_duplicates(subset=match_columns, keep='first')
    
    def handle_duplicates_keep_last(
        self,
        df: pd.DataFrame,
        match_columns: Union[str, List[str]]
    ) -> pd.DataFrame:
        """
        处理重复值：仅保留最后一个（支持多列）
        
        Args:
            df: 原始DataFrame
            match_columns: 匹配列名或列名列表
            
        Returns:
            处理后的DataFrame
        """
        if isinstance(match_columns, str):
            match_columns = [match_columns]
        return df.drop_duplicates(subset=match_columns, keep='last')
    
    def clear(self):
        """清除重复值信息"""
        self.duplicate_info = {}
