"""
字段映射器模块
实现固定资产字段的自动映射和计算
"""
import pandas as pd
import numpy as np
from typing import Optional, Dict, List, Tuple
from datetime import datetime
from dateutil.relativedelta import relativedelta


class FieldMapper:
    """字段映射器 - 根据映射规则自动识别和计算字段"""
    
    def __init__(self):
        self.field_mappings = {}  # 存储字段映射关系
        self.mapped_df = None  # 映射后的DataFrame
    
    def auto_map_fields(
        self,
        df: pd.DataFrame,
        category_col: Optional[str] = None,  # 资产类别列（透视行字段）
        match_col: Optional[str] = None,  # 匹配列（固定资产编号）
        original_value_col1: Optional[str] = None,  # 文件1原值列
        original_value_col2: Optional[str] = None,  # 文件2原值列
        depreciation_col1: Optional[str] = None,  # 文件1累计折旧列
        depreciation_col2: Optional[str] = None,  # 文件2累计折旧列
    ) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        自动映射字段并添加计算列
        
        Args:
            df: 合并后的DataFrame
            category_col: 资产类别列名
            match_col: 匹配列名（固定资产编号）
            original_value_col1: 文件1原值列名
            original_value_col2: 文件2原值列名
            depreciation_col1: 文件1累计折旧列名
            depreciation_col2: 文件2累计折旧列名
            
        Returns:
            tuple: (成功标志, 消息, 映射后的DataFrame)
        """
        try:
            if df is None or df.empty:
                return False, "数据为空，无法进行字段映射", None
            
            mapped_df = df.copy()
            columns = list(df.columns)
            
            # 1. 资产类别 - 直接使用透视行字段
            if category_col and category_col in columns:
                self.field_mappings['资产类别'] = category_col
            
            # 2. 固定资产编号 - 使用匹配列
            if match_col and match_col in columns:
                self.field_mappings['固定资产编号'] = match_col
            elif '匹配列' in columns:
                self.field_mappings['固定资产编号'] = '匹配列'
            
            # 3. 固定资产名称 - 检索包含"名称"或"描述"的字段
            name_col = self._find_column_by_keywords(columns, ['名称', '描述', '资产名'])
            if name_col:
                self.field_mappings['固定资产名称'] = name_col
            
            # 4. 入账开始日期 - 检索包含"日期"的字段
            date_col = self._find_column_by_keywords(columns, ['入账日期', '开始日期', '购置日期', '取得日期', '日期'])
            if date_col:
                self.field_mappings['入账开始日期'] = date_col
            
            # 5. 使用寿命(月) - 检索包含"预计"、"使用寿命"的字段（排除包含"剩余"的列）
            life_candidates = [col for col in columns if '剩余' not in str(col)]
            life_col = self._find_column_by_keywords(life_candidates, ['使用寿命', '预计寿命', '寿命', '年限', '计划使用','预计'])
            if life_col:
                self.field_mappings['使用寿命(月)'] = life_col
            
            # 6. 残值率 - 检索包含"残值率"、"残值"的字段
            residual_col = self._find_column_by_keywords(columns, ['残值率', '残值'])
            if residual_col:
                self.field_mappings['残值率'] = residual_col
            
            # 7. 原值 - 直接使用配置的原值字段
            if original_value_col1:
                orig_col1_name = f"{original_value_col1}_文件1" if not original_value_col1.endswith('_文件1') else original_value_col1
                if orig_col1_name in columns:
                    self.field_mappings['原值_文件1'] = orig_col1_name
            if original_value_col2:
                orig_col2_name = f"{original_value_col2}_文件2" if not original_value_col2.endswith('_文件2') else original_value_col2
                if orig_col2_name in columns:
                    self.field_mappings['原值_文件2'] = orig_col2_name
            
            # 8. 累计折旧 - 直接使用配置的累计折旧字段
            if depreciation_col1:
                dep_col1_name = f"{depreciation_col1}_文件1" if not depreciation_col1.endswith('_文件1') else depreciation_col1
                # 查找可能被重命名的列
                found_dep1 = self._find_exact_or_renamed_column(columns, dep_col1_name)
                if found_dep1:
                    self.field_mappings['累计折旧_文件1'] = found_dep1
            if depreciation_col2:
                dep_col2_name = f"{depreciation_col2}_文件2" if not depreciation_col2.endswith('_文件2') else depreciation_col2
                # 查找可能被重命名的列
                found_dep2 = self._find_exact_or_renamed_column(columns, dep_col2_name)
                if found_dep2:
                    self.field_mappings['累计折旧_文件2'] = found_dep2
            
            # 9. 计算净值 = 原值 - 累计折旧
            if '原值_文件1' in self.field_mappings and '累计折旧_文件1' in self.field_mappings:
                orig1 = self._safe_to_numeric_series(mapped_df[self.field_mappings['原值_文件1']])
                dep1 = self._safe_to_numeric_series(mapped_df[self.field_mappings['累计折旧_文件1']])
                mapped_df['净值_文件1'] = orig1 - dep1.abs()  # 累计折旧通常是负数，取绝对值
                self.field_mappings['净值_文件1'] = '净值_文件1'
            
            if '原值_文件2' in self.field_mappings and '累计折旧_文件2' in self.field_mappings:
                orig2 = self._safe_to_numeric_series(mapped_df[self.field_mappings['原值_文件2']])
                dep2 = self._safe_to_numeric_series(mapped_df[self.field_mappings['累计折旧_文件2']])
                mapped_df['净值_文件2'] = orig2 - dep2.abs()
                self.field_mappings['净值_文件2'] = '净值_文件2'
            
            # 10. 计算是否已提足折旧
            # 已提足折旧判断：净值 - 原值*残值率 > 0 则输出"否"，否则输出"是"
            if '净值_文件1' in mapped_df.columns and '原值_文件1' in self.field_mappings:
                residual_rate = self._get_residual_rate_series(mapped_df)
                orig1 = self._safe_to_numeric_series(mapped_df[self.field_mappings['原值_文件1']])
                net1 = mapped_df['净值_文件1']
                
                # 计算残值 = 原值 * 残值率
                residual_value = orig1 * residual_rate
                # 判断：净值 - 残值 > 0 则未提足（否），否则已提足（是）
                mapped_df['已提足折旧'] = (net1 - residual_value).apply(
                    lambda x: '否' if pd.notna(x) and x > 0 else '是'
                )
                self.field_mappings['已提足折旧'] = '已提足折旧'
            
            # 11. 计算提足折旧时间 = 入账开始日期 + 使用寿命(月)
            if '入账开始日期' in self.field_mappings and '使用寿命(月)' in self.field_mappings:
                mapped_df['提足折旧时间'] = mapped_df.apply(
                    lambda row: self._calculate_depreciation_end_date(
                        row[self.field_mappings['入账开始日期']],
                        row[self.field_mappings['使用寿命(月)']]
                    ),
                    axis=1
                )
                self.field_mappings['提足折旧时间'] = '提足折旧时间'
            
            self.mapped_df = mapped_df
            return True, f"字段映射完成，共映射 {len(self.field_mappings)} 个字段", mapped_df
            
        except Exception as e:
            return False, f"字段映射失败: {str(e)}", None
    
    def _find_column_by_keywords(self, columns: List[str], keywords: List[str]) -> Optional[str]:
        """根据关键字查找列名"""
        for keyword in keywords:
            for col in columns:
                col_str = str(col)
                if keyword in col_str:
                    return col
        return None
    
    def _find_exact_or_renamed_column(self, columns: List[str], base_name: str) -> Optional[str]:
        """查找精确匹配或重命名后的列（如 xxx_文件1_2）"""
        if base_name in columns:
            return base_name
        # 查找重命名后的列
        for col in columns:
            col_str = str(col)
            if col_str.startswith(base_name) and (col_str == base_name or col_str.startswith(base_name + '_')):
                return col
        return None
    
    def _safe_to_numeric_series(self, series: pd.Series) -> pd.Series:
        """安全地将Series转换为数值类型"""
        def convert(val):
            if pd.isna(val):
                return 0.0
            try:
                if isinstance(val, str):
                    val = val.replace(',', '').replace(' ', '').strip()
                return float(val)
            except (ValueError, TypeError):
                return 0.0
        return series.apply(convert)
    
    def _get_residual_rate_series(self, df: pd.DataFrame) -> pd.Series:
        """获取残值率Series，如果没有残值率列，默认使用5%"""
        if '残值率' in self.field_mappings and self.field_mappings['残值率'] in df.columns:
            return self._safe_to_numeric_series(df[self.field_mappings['残值率']]) / 100
        else:
            # 默认残值率5%
            return pd.Series([0.05] * len(df), index=df.index)
    
    def _calculate_depreciation_end_date(self, start_date, life_months) -> str:
        """计算提足折旧时间"""
        try:
            # 处理开始日期
            if pd.isna(start_date):
                return ''
            
            if isinstance(start_date, str):
                # 尝试解析日期字符串
                for fmt in ['%Y-%m-%d', '%Y/%m/%d', '%Y年%m月%d日', '%Y%m%d']:
                    try:
                        start_date = datetime.strptime(start_date, fmt)
                        break
                    except ValueError:
                        continue
                else:
                    return ''
            elif isinstance(start_date, (int, float)):
                # Excel日期序列号
                try:
                    start_date = pd.Timestamp('1899-12-30') + pd.Timedelta(days=int(start_date))
                except:
                    return ''
            
            # 处理使用寿命
            if pd.isna(life_months):
                return ''
            try:
                months = int(float(life_months))
            except (ValueError, TypeError):
                return ''
            
            # 计算到期日
            end_date = start_date + relativedelta(months=months)
            return end_date.strftime('%Y-%m-%d')
            
        except Exception:
            return ''
    
    def get_field_mappings(self) -> Dict[str, str]:
        """获取字段映射关系"""
        return self.field_mappings.copy()
    
    def get_mapped_df(self) -> Optional[pd.DataFrame]:
        """获取映射后的DataFrame"""
        return self.mapped_df
