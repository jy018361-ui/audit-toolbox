"""
数据透视表引擎
实现类似Excel数据透视表的功能
"""
import pandas as pd
import numpy as np
from typing import List, Optional, Dict, Tuple


class PivotEngine:
    """数据透视表引擎"""
    
    def __init__(self):
        self.pivot_result = None
        self.pivot_config = {}
    
    def create_pivot_table(
        self,
        df: pd.DataFrame,
        index: List[str],
        columns: Optional[List[str]] = None,
        values: Optional[List[str]] = None,
        aggfunc: str = 'sum'
    ) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        创建数据透视表
        
        Args:
            df: 源DataFrame
            index: 行字段列表
            columns: 列字段列表（可选）
            values: 值字段列表（可选）
            aggfunc: 聚合函数 ('sum', 'mean', 'count', 'max', 'min')
            
        Returns:
            tuple: (成功标志, 错误消息, 透视表DataFrame)
        """
        try:
            if df is None or df.empty:
                return False, "数据为空，无法创建透视表", None
            
            if not index:
                return False, "至少需要指定一个行字段", None
            
            # 验证字段是否存在
            all_fields = index.copy()
            if columns:
                all_fields.extend(columns)
            if values:
                all_fields.extend(values)
            
            missing_fields = [f for f in all_fields if f not in df.columns]
            if missing_fields:
                return False, f"以下字段不存在: {', '.join(missing_fields)}", None
            
            # 如果没有指定值字段，使用 count 统计行数（创建一个临时计数列）
            if not values:
                # 创建一个临时计数列用于统计
                temp_count_col = '__count__'
                df = df.copy()
                df[temp_count_col] = 1
                values = [temp_count_col]
                # 如果 aggfunc 不是 count，改为 count
                if aggfunc.lower() not in ('count', 'sum'):
                    aggfunc = 'count'
            else:
                # 有值字段时，确保值字段是数值类型
                df = df.copy()
                for val_col in values:
                    if val_col in df.columns:
                        # 将值字段转换为数值类型
                        df[val_col] = pd.to_numeric(
                            df[val_col].astype(str).str.replace(',', '').str.replace(' ', '').str.strip(),
                            errors='coerce'
                        ).fillna(0)
            
            # 转换聚合函数
            aggfunc_map = {
                'sum': 'sum',
                'mean': 'mean',
                'average': 'mean',
                'count': 'count',
                'max': 'max',
                'min': 'min'
            }
            agg_func = aggfunc_map.get(aggfunc.lower(), 'sum')
            
            # 将index字段中的空值填充为"未分类"，避免这些记录被忽略
            for idx_col in index:
                if idx_col in df.columns:
                    df[idx_col] = df[idx_col].fillna('未分类')
                    # 同时处理空字符串
                    df[idx_col] = df[idx_col].replace('', '未分类')
                    df[idx_col] = df[idx_col].replace(' ', '未分类')
            
            # 创建透视表
            pivot = pd.pivot_table(
                df,
                index=index,
                columns=columns if columns else None,
                values=values,
                aggfunc=agg_func,
                fill_value=0,
                margins=False
            )
            
            # 如果使用了临时计数列，先重命名
            used_temp_count = '__count__' in values
            if used_temp_count:
                # 重命名临时计数列
                if isinstance(pivot.columns, pd.MultiIndex):
                    # 多级列：替换最后一层的 '__count__' 为 '计数'
                    new_columns = []
                    for col in pivot.columns:
                        if isinstance(col, tuple):
                            if col[-1] == '__count__':
                                new_columns.append(col[:-1] + ('计数',))
                            else:
                                new_columns.append(col)
                        else:
                            new_columns.append(col)
                    pivot.columns = pd.MultiIndex.from_tuples(new_columns)
                else:
                    # 单级列：直接重命名
                    pivot = pivot.rename(columns={'__count__': '计数'}, errors='ignore')
            
            # 如果只有一个值字段且有列字段，简化列名（去掉值字段层级）
            if len(values) == 1 and columns:
                try:
                    pivot.columns = pivot.columns.droplevel(0)
                except (AttributeError, KeyError):
                    # 如果已经是单级列，不需要处理
                    pass
            
            self.pivot_result = pivot
            self.pivot_config = {
                'index': index,
                'columns': columns,
                'values': values,
                'aggfunc': aggfunc
            }
            
            return True, "透视表创建成功", pivot
            
        except Exception as e:
            return False, f"创建透视表时出错: {str(e)}", None
    
    def get_pivot_result(self) -> Optional[pd.DataFrame]:
        """获取透视表结果"""
        return self.pivot_result
    
    def get_pivot_config(self) -> Dict:
        """获取透视表配置"""
        return self.pivot_config.copy()
    
    def get_available_fields(self, df: pd.DataFrame) -> Dict[str, List[str]]:
        """
        获取可用于透视表的字段列表
        
        Args:
            df: DataFrame
            
        Returns:
            dict: {'all': 所有字段, 'numeric': 数值字段, 'text': 文本字段, 'date': 日期字段}
        """
        if df is None or df.empty:
            return {
                'all': [],
                'numeric': [],
                'text': [],
                'date': []
            }
        
        all_fields = list(df.columns)
        numeric_fields = df.select_dtypes(include=[np.number]).columns.tolist()
        text_fields = df.select_dtypes(include=['object']).columns.tolist()
        date_fields = df.select_dtypes(include=['datetime64']).columns.tolist()
        
        return {
            'all': all_fields,
            'numeric': numeric_fields,
            'text': text_fields,
            'date': date_fields
        }
    
    def clear(self):
        """清除透视表结果"""
        self.pivot_result = None
        self.pivot_config = {}
