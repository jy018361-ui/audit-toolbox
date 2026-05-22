"""
Sheet生成器模块
生成FA List、新增清单_BKD、处置清单_BKD
"""
import pandas as pd
import numpy as np
import re
from typing import Dict, List, Optional, Tuple, Union
from datetime import datetime
from dateutil.relativedelta import relativedelta


class SheetGenerator:
    """Sheet生成器 - 生成FA List和BKD清单"""
    
    def __init__(self):
        self.field_mapping = None
        self.match_col = None  # 向后兼容：单列格式
        self.match_col2 = None  # 向后兼容：单列格式
        self.match_cols = []  # 多列格式（文件1）
        self.match_cols2 = []  # 多列格式（文件2）
        self.category_col = None
    
    def set_config(
        self,
        field_mapping: Dict,
        match_col: Union[str, List[str], None] = None,
        category_col: str = None,
        original_value_col1: str = None,
        original_value_col2: str = None,
        depreciation_col1: str = None,
        depreciation_col2: str = None,
        match_col2: Union[str, List[str], None] = None,
        match_cols: List[str] = None,
        match_cols2: List[str] = None,
        use_supplement_lists: bool = False,
    ):
        """
        设置配置（支持多列匹配）
        
        Args:
            field_mapping: 字段映射（已含显示名后缀的完整列名）
            match_col: 文件1匹配列（向后兼容：单列格式）
            match_col2: 文件2匹配列（向后兼容：单列格式）
            match_cols: 文件1匹配列列表（多列格式）
            match_cols2: 文件2匹配列列表（多列格式）
            category_col: 资产类别列
            original_value_col1/2: 原值列
            depreciation_col1/2: 累计折旧列
        """
        self.field_mapping = field_mapping or {}
        
        # 优先使用多列格式，否则使用单列格式（向后兼容）
        if match_cols is not None:
            self.match_cols = match_cols if isinstance(match_cols, list) else [match_cols] if match_cols else []
            self.match_col = self.match_cols[0] if self.match_cols else None
        elif match_col is not None:
            if isinstance(match_col, list):
                self.match_cols = match_col
                self.match_col = match_col[0] if match_col else None
            else:
                self.match_col = match_col
                self.match_cols = [match_col] if match_col else []
        else:
            self.match_col = None
            self.match_cols = []
        
        if match_cols2 is not None:
            self.match_cols2 = match_cols2 if isinstance(match_cols2, list) else [match_cols2] if match_cols2 else []
            self.match_col2 = self.match_cols2[0] if self.match_cols2 else None
        elif match_col2 is not None:
            if isinstance(match_col2, list):
                self.match_cols2 = match_col2
                self.match_col2 = match_col2[0] if match_col2 else None
            else:
                self.match_col2 = match_col2
                self.match_cols2 = [match_col2] if match_col2 else []
        else:
            self.match_col2 = None
            self.match_cols2 = []
        
        self.category_col = category_col
        self.original_value_col1 = original_value_col1
        self.original_value_col2 = original_value_col2
        self.depreciation_col1 = depreciation_col1
        self.depreciation_col2 = depreciation_col2
        self.use_supplement_lists = bool(use_supplement_lists)
    
    def _find_column_in_df(self, df: pd.DataFrame, col_name: str) -> Optional[str]:
        """
        在DataFrame中查找列名（处理后缀问题）
        
        Args:
            df: DataFrame
            col_name: 要查找的列名
            
        Returns:
            找到的列名，未找到返回None
        """
        if not col_name:
            return None
            
        columns = list(df.columns)
        col_name_str = str(col_name)
        
        # 1. 直接匹配
        if col_name in columns:
            return col_name
        
        # 2. 尝试添加后缀匹配
        for suffix in ['_文件1', '_文件2']:
            if col_name_str + suffix in columns:
                return col_name_str + suffix
        
        # 3. 检查是否列名本身已经带后缀，但实际列名是不带后缀的
        for suffix in ['_文件1', '_文件2']:
            if col_name_str.endswith(suffix):
                base_name = col_name_str[:-len(suffix)]
                if base_name in columns:
                    return base_name
        
        return None
    
    def _find_column(self, df: pd.DataFrame, keywords: List[str], exact_keywords: List[str] = None) -> Optional[str]:
        """
        根据关键词查找列名（在所有列中搜索）
        
        Args:
            df: DataFrame
            keywords: 包含匹配关键词
            exact_keywords: 精确匹配关键词（优先）
            
        Returns:
            找到的列名，未找到返回None
        """
        columns = list(df.columns)
        
        # 1. 精确匹配（检查列名或去掉后缀后的列名）
        if exact_keywords:
            for col in columns:
                col_str = str(col)
                # 去掉后缀检查
                base_name = col_str.replace('_文件1', '').replace('_文件2', '')
                if col_str in exact_keywords or base_name in exact_keywords:
                    return col
        
        # 2. 包含匹配
        for col in columns:
            col_str = str(col)
            for kw in keywords:
                if kw in col_str:
                    return col
        
        return None
    
    def _find_column_pair(self, df: pd.DataFrame, keywords: List[str], exact_keywords: List[str] = None) -> Tuple[Optional[str], Optional[str]]:
        """
        根据关键词查找文件1和文件2的列名对
        
        Args:
            df: DataFrame
            keywords: 包含匹配关键词
            exact_keywords: 精确匹配关键词（优先）
            
        Returns:
            (文件1列名, 文件2列名) 的元组，未找到的为None
        """
        col1 = None
        col2 = None
        columns = list(df.columns)
        
        # 查找文件1的列
        for col in columns:
            col_str = str(col)
            if '_文件1' not in col_str:
                continue
            base_name = col_str.replace('_文件1', '')
            # 精确匹配
            if exact_keywords and base_name in exact_keywords:
                col1 = col
                break
            # 包含匹配
            for kw in keywords:
                if kw in base_name or kw in col_str:
                    col1 = col
                    break
            if col1:
                break
        
        # 查找文件2的列
        for col in columns:
            col_str = str(col)
            if '_文件2' not in col_str:
                continue
            base_name = col_str.replace('_文件2', '')
            # 精确匹配
            if exact_keywords and base_name in exact_keywords:
                col2 = col
                break
            # 包含匹配
            for kw in keywords:
                if kw in base_name or kw in col_str:
                    col2 = col
                    break
            if col2:
                break
        
        return col1, col2
    
    def _get_value_with_fallback(self, row, col1: Optional[str], col2: Optional[str], default=''):
        """
        获取值，如果文件1的值为空则使用文件2的值
        
        Args:
            row: DataFrame行
            col1: 文件1的列名
            col2: 文件2的列名（备选）
            default: 默认值
            
        Returns:
            获取到的值
        """
        row_index = row.index if hasattr(row, "index") else row.keys()

        # 尝试从文件1获取
        if col1 and col1 in row_index:
            val1 = row.get(col1, None)
            if val1 is not None and not pd.isna(val1) and str(val1).strip() != '':
                return val1
        
        # 文件1为空，尝试从文件2获取
        if col2 and col2 in row_index:
            val2 = row.get(col2, None)
            if val2 is not None and not pd.isna(val2) and str(val2).strip() != '':
                return val2
        
        return default
    
    def _safe_numeric(self, value):
        """安全转换为数值"""
        if pd.isna(value):
            return 0.0
        try:
            if isinstance(value, str):
                value = value.replace(',', '').replace(' ', '').strip()
            return float(value)
        except (ValueError, TypeError):
            return 0.0

    @staticmethod
    def _build_composite_key_series(df: pd.DataFrame, cols: List[str]) -> pd.Series:
        """按匹配列构造组键；用于同一ID多卡片的组级分摊。"""
        valid_cols = [c for c in (cols or []) if c in df.columns]
        if not valid_cols:
            return pd.Series([""] * len(df), index=df.index)
        parts = []
        for col in valid_cols:
            parts.append(
                df[col]
                .fillna("")
                .astype(str)
                .str.strip()
            )
        if len(parts) == 1:
            return parts[0]
        return pd.concat(parts, axis=1).agg("|||".join, axis=1)

    def _format_date_only(self, value) -> str:
        """统一日期展示为 YYYY-MM-DD，去掉时间部分。"""
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return ""
        if isinstance(value, datetime):
            return value.strftime("%Y-%m-%d")
        if hasattr(value, "to_pydatetime"):
            try:
                return value.to_pydatetime().strftime("%Y-%m-%d")
            except Exception:
                pass
        text = str(value).strip()
        if not text:
            return ""
        normalized = text.replace("/", "-").replace(".", "-")
        if " " in normalized:
            normalized = normalized.split(" ")[0]
        for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y年%m月%d日"):
            try:
                return datetime.strptime(normalized, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        ts = pd.to_datetime(text, errors="coerce")
        if pd.notna(ts):
            try:
                return ts.to_pydatetime().strftime("%Y-%m-%d")
            except Exception:
                pass
        return text
    
    def _calculate_depreciation_end_date(self, start_date, months) -> str:
        """
        计算提足折旧时间
        
        Args:
            start_date: 入账开始日期
            months: 使用寿命（月）
            
        Returns:
            提足折旧时间（YYYY-MM-DD格式）
        """
        if pd.isna(start_date) or pd.isna(months):
            return ""
        
        try:
            # 转换月数
            months_int = int(self._safe_numeric(months))
            if months_int <= 0:
                return ""
            
            # 转换日期
            if isinstance(start_date, str):
                # 尝试多种日期格式
                for fmt in ['%Y-%m-%d', '%Y/%m/%d', '%Y%m%d', '%d/%m/%Y', '%m/%d/%Y']:
                    try:
                        start_dt = datetime.strptime(start_date.strip(), fmt)
                        break
                    except ValueError:
                        continue
                else:
                    return ""
            elif isinstance(start_date, datetime):
                start_dt = start_date
            elif hasattr(start_date, 'to_pydatetime'):
                start_dt = start_date.to_pydatetime()
            else:
                return ""
            
            # 计算到期日
            end_dt = start_dt + relativedelta(months=months_int)
            return end_dt.strftime('%Y-%m-%d')
            
        except Exception:
            return ""
    
    def _calculate_depreciation_end_date(self, start_date, months) -> str:
        """
        计算提足折旧时间（增强版）：
        - 支持 datetime / Timestamp / Excel 序列号
        - 支持纯数字字符串日期（如 45291、45291.0）
        - 支持常见中文日期与标准日期字符串
        """
        if pd.isna(start_date) or pd.isna(months):
            return ""

        try:
            months_int = int(self._safe_numeric(months))
            if months_int <= 0:
                return ""

            start_dt = None
            if isinstance(start_date, str):
                raw = start_date.strip()
                if not raw:
                    return ""

                num_text = raw.replace(",", "")
                if re.fullmatch(r"[+-]?\d+(\.\d+)?", num_text):
                    serial = float(num_text)
                    # 8位纯数字通常是 YYYYMMDD，不按 Excel 序列处理
                    if re.fullmatch(r"\d{8}", num_text.split(".", 1)[0]):
                        serial = -1
                    # Excel 日期序列合理范围，避免把 20240115 误当序列号
                    if 0 < serial <= 100000:
                        start_dt = datetime(1899, 12, 30) + relativedelta(days=int(serial))

                if start_dt is None:
                    normalized = (
                        raw.replace("年", "-")
                        .replace("月", "-")
                        .replace("日", "")
                        .replace(".", "-")
                        .replace("/", "-")
                    )
                    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%d/%m/%Y", "%m/%d/%Y", "%Y-%m"):
                        try:
                            start_dt = datetime.strptime(normalized, fmt)
                            break
                        except ValueError:
                            continue
                    if start_dt is None:
                        ts = pd.to_datetime(raw, errors="coerce")
                        if pd.notna(ts):
                            start_dt = ts.to_pydatetime()
            elif isinstance(start_date, datetime):
                start_dt = start_date
            elif hasattr(start_date, "to_pydatetime"):
                start_dt = start_date.to_pydatetime()
            elif isinstance(start_date, (int, float)) and start_date > 0:
                start_dt = datetime(1899, 12, 30) + relativedelta(days=int(start_date))

            if start_dt is None:
                return ""

            end_dt = start_dt + relativedelta(months=months_int)
            return end_dt.strftime("%Y-%m-%d")
        except Exception:
            return ""

    def _is_fully_depreciated(self, net_value, original_value, residual_rate) -> str:
        """
        判断是否已提足折旧
        
        逻辑：if 净值 - 原值 × 残值率 > 0.1 则输出"否"，否则输出"是"
        
        Args:
            net_value: 净值
            original_value: 原值
            residual_rate: 残值率
            
        Returns:
            "是" 或 "否"
        """
        try:
            nv = self._safe_numeric(net_value)
            ov = self._safe_numeric(original_value)
            
            # 处理残值率（支持 "10.00%" / "10" / 0.1）
            rr = 0.0
            if isinstance(residual_rate, str):
                s = residual_rate.replace(",", "").replace(" ", "").strip()
                if s.endswith("%"):
                    try:
                        rr = float(s[:-1]) / 100.0
                    except Exception:
                        rr = 0.0
                else:
                    rr = self._safe_numeric(s)
            else:
                rr = self._safe_numeric(residual_rate)
            if rr > 1:  # 兼容百分数（如10表示10%）
                rr = rr / 100.0
            
            residual_value = ov * rr
            
            if nv - residual_value > 0.1:
                return "否"
            else:
                return "是"
        except Exception:
            return ""
    
    def _find_file2_column(self, df: pd.DataFrame, keywords: List[str], exact_keywords: List[str] = None) -> Optional[str]:
        """
        专门查找文件2的列
        增强版：支持更灵活的匹配，包括列名后缀已被替换为文件显示名的情况
        """
        columns = list(df.columns)
        
        # 将列按照"基础名称"分组，同一基础名称的列会有多个（来自不同文件）
        # 对于文件2的列，我们选择列表中靠后的那个（因为文件2的列通常在文件1之后合并）
        
        # 第一轮：精确匹配
        if exact_keywords:
            # 收集所有匹配的列
            matches = []
            for idx, col in enumerate(columns):
                col_str = str(col)
                # 提取基础名称（第一个下划线之前的部分）
                base_name = col_str.split('_')[0] if '_' in col_str else col_str
                if base_name in exact_keywords:
                    matches.append((idx, col))
            
            # 如果找到匹配，返回索引最大的（通常是文件2的列）
            if matches:
                return max(matches, key=lambda x: x[0])[1]
        
        # 第二轮：包含匹配
        matches = []
        for idx, col in enumerate(columns):
            col_str = str(col)
            # 提取基础名称
            base_name = col_str.split('_')[0] if '_' in col_str else col_str
            for kw in keywords:
                if kw in base_name or kw in col_str:
                    matches.append((idx, col))
                    break
        
        # 返回索引最大的匹配（文件2的列通常在后面）
        if matches:
            return max(matches, key=lambda x: x[0])[1]
        
        return None
    
    def _get_mapped_col(self, base_col: str, suffix: str, df: pd.DataFrame) -> Optional[str]:
        """
        获取用户映射的列名（加上后缀）
        
        Args:
            base_col: 基础列名（可能是UI显示名或实际列名）
            suffix: 后缀 (_文件1 或 _文件2)，注意：实际DataFrame列名可能已被替换为文件显示名
            df: DataFrame
            
        Returns:
            找到的列名，未找到返回None
        """
        if not base_col:
            return None
        
        columns = list(df.columns)
        base_col_str = str(base_col).strip()
        
        # 1. 直接匹配（精确）
        if base_col_str in columns:
            return base_col_str
        
        # 2. 尝试加后缀（如 "资产名称" -> "资产名称_文件2"）
        col_with_suffix = f"{base_col_str}{suffix}"
        if col_with_suffix in columns:
            return col_with_suffix
        
        # 3. 如果base_col已经带有后缀，尝试替换后缀
        for old_suffix in ['_文件1', '_文件2']:
            if base_col_str.endswith(old_suffix):
                real_base = base_col_str[:-len(old_suffix)]
                new_col = f"{real_base}{suffix}"
                if new_col in columns:
                    return new_col
                if real_base in columns:
                    return real_base
        
        # 4. 核心匹配：提取base_col的核心名称，在所有列中查找包含该核心名称的列
        # 去除所有可能的后缀，提取核心列名
        core_name = base_col_str
        for s in ['_文件1', '_文件2']:
            core_name = core_name.replace(s, '')
        core_name = core_name.strip()
        
        if core_name:
            # 确定目标后缀
            target_suffix = suffix  # '_文件1' 或 '_文件2'
            other_suffix = '_文件1' if suffix == '_文件2' else '_文件2'
            
            # 查找包含核心名称的列，优先选择带有正确后缀的列
            exact_match = None  # 精确匹配（核心名称 + 目标后缀）
            fallback_match = None  # 备选匹配（包含核心名称但不带目标后缀）
            
            for col in columns:
                col_str = str(col)
                # 提取列的核心名称（去掉下划线后的所有内容）
                col_core = col_str.split('_')[0] if '_' in col_str else col_str
                
                # 检查核心名称是否匹配
                if core_name == col_core or core_name in col_str:
                    # 检查列名是否包含目标后缀
                    if target_suffix in col_str:
                        # 优先选择带有目标后缀的列
                        if exact_match is None or col_core == core_name:
                            exact_match = col
                    elif other_suffix not in col_str:
                        # 不包含任何后缀的列作为备选
                        if fallback_match is None:
                            fallback_match = col
            
            # 优先返回精确匹配，否则返回备选匹配
            if exact_match:
                return exact_match
            if fallback_match:
                return fallback_match
        
        return None
    
    def generate_fa_list(self, df: pd.DataFrame) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        生成FA List（固定资产清单）
        
        字段：资产类别、固定资产编号、固定资产名称、入账开始日期、使用寿命(月)、
              残值率、原值、累计折旧、净值、已提足折旧、提足折旧时间
        
        所有字段都从文件2获取，直接使用用户映射的字段
        
        纠偏机制：
        - 使用寿命：若检测到使用寿命列（转为数值后）全部小于30，判断为年数而非月数，整列输出 使用寿命×12。
        - 残值率：若检测到残值率列中存在大于100的值，判断为残值而非残值率，整列输出 残值率=残值/原值。
        """
        try:
            if df is None or df.empty:
                return False, "数据为空", None
            
            result_rows = []
            fm = self.field_mapping or {}
            cols = set(df.columns)
            
            # 直接使用已格式化的列名（field_mapping 与 match_col2 含显示名后缀，与 df 列一致）
            def _use(c):
                return c if c and c in cols else None
            category_col = _use(fm.get('category_col2'))
            match_col = _use(self.match_col2)
            name_col = _use(fm.get('name_col2'))
            date_col = _use(fm.get('date_col2'))
            life_col = _use(fm.get('life_col2'))
            residual_col = _use(fm.get('residual_col2'))
            original_col = _use(self.original_value_col2)
            depreciation_col = _use(self.depreciation_col2)
            
            # 纠偏：若使用寿命（转为数值后）全部 < 30，视为年数，输出时整列 ×12
            life_correct_years_to_months = False
            life_warning = ""
            if life_col and life_col in df.columns:
                life_vals = pd.to_numeric(df[life_col], errors='coerce').dropna()
                if len(life_vals) > 0 and (life_vals < 30).all():
                    life_correct_years_to_months = True
                    life_warning = "【使用寿命纠偏】系统检测到使用寿命列中全部小于30，判断该列可能是年数而非月数。已自动修正为：使用寿命(月) = 使用寿命 × 12。"
            
            # 纠偏：若残值率列中有大于100的值，判断为残值而非残值率，输出 残值率=残值/原值
            need_residual_correction = False
            residual_warning = ""
            if residual_col and original_col and residual_col in df.columns:
                def _safe_float(v):
                    if pd.isna(v):
                        return None
                    try:
                        if isinstance(v, str):
                            v = v.replace(',', '').replace(' ', '').strip()
                        return float(v) if v != '' else None
                    except (ValueError, TypeError):
                        return None
                res_vals = df[residual_col].apply(_safe_float)
                has_valid = bool(res_vals.notna().any())
                if has_valid:
                    max_r = res_vals.max()
                    if isinstance(max_r, pd.Series):
                        max_r = max_r.iloc[0] if len(max_r) > 0 else None
                    if max_r is not None and not pd.isna(max_r) and max_r > 100:
                        need_residual_correction = True
                        residual_warning = "【残值率纠偏】系统检测到残值率列中存在大于100的值（最大值为{}），判断该列可能是残值而非残值率。已自动修正为：残值率 = 残值 / 原值。".format(max_r)
            
            # 遍历数据生成FA List
            for row in df.to_dict("records"):
                category = row.get(category_col, '') if category_col else ''
                asset_no = row.get(match_col, '') if match_col else ''
                asset_name = row.get(name_col, '') if name_col else ''
                start_date = self._format_date_only(row.get(date_col, '')) if date_col else ''
                raw_life = row.get(life_col, '') if life_col else ''
                if life_correct_years_to_months:
                    if pd.isna(raw_life) or raw_life is None or (isinstance(raw_life, str) and raw_life.strip() == ''):
                        service_life = ''
                    else:
                        try:
                            x = self._safe_numeric(raw_life)
                            y = x * 12
                            service_life = int(y) if y == int(y) else y
                        except Exception:
                            service_life = raw_life
                else:
                    service_life = raw_life
                original_value = row.get(original_col, 0) if original_col else 0
                depreciation = row.get(depreciation_col, 0) if depreciation_col else 0
                ov = self._safe_numeric(original_value)
                dep = self._safe_numeric(depreciation)
                # 残值率：若需纠偏则 残值率=残值/原值
                if need_residual_correction and residual_col and original_col and ov != 0:
                    residual_val = self._safe_numeric(row.get(residual_col, 0))
                    residual_rate = residual_val / ov
                else:
                    residual_rate = row.get(residual_col, '') if residual_col else ''
                
                # 计算字段
                net_value = ov - abs(dep)  # 净值 = 原值 - |累计折旧|
                
                # 已提足折旧
                fully_depreciated = self._is_fully_depreciated(net_value, original_value, residual_rate)
                
                # 提足折旧时间
                depreciation_end = self._calculate_depreciation_end_date(start_date, service_life)
                
                result_rows.append({
                    '资产类别': category,
                    '固定资产编号': asset_no,
                    '固定资产名称': asset_name,
                    '入账开始日期': start_date,
                    '使用寿命(月)': service_life,
                    '残值率': residual_rate,
                    '原值': ov,
                    '累计折旧': dep,
                    '净值': net_value,
                    '已提足折旧': fully_depreciated,
                    '提足折旧时间': depreciation_end,
                })
            
            result_df = pd.DataFrame(result_rows)
            msg = f"FA List生成成功，共{len(result_df)}条记录"
            if life_warning:
                msg += "\n" + life_warning
            if residual_warning:
                msg += "\n" + residual_warning
            return True, msg, result_df
            
        except Exception as e:
            return False, f"生成FA List失败: {str(e)}", None
    
    def generate_addition_list(self, df: pd.DataFrame) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        生成新增清单_BKD
        
        字段：资产类别、固定资产编号、固定资产名称、入账开始日期、使用寿命(月)、残值率、
              新增方式、新增时间、原值增加
        
        数据来源：原值变动类型 == '原值增加' 的记录
        
        所有字段从文件2获取（直接使用用户映射的字段），原值增加取自原值变动列
        
        纠偏机制：
        - 残值率：若检测到残值率列中有大于100的值，判断为残值而非残值率，自动修正为 残值率=残值/原值。
        - 使用寿命：若检测到使用寿命列（转为数值后）全部小于30，判断为年数而非月数，整列输出为 使用寿命×12。
        """
        try:
            if df is None or df.empty:
                return False, "数据为空", None
            
            # 筛选原值增加的记录
            # 尝试查找"原值变动类型"列（可能列名被格式化，需要灵活匹配）
            change_type_col = None
            for col in df.columns:
                col_str = str(col).strip()
                if col_str == '原值变动类型' or '原值变动类型' in col_str:
                    change_type_col = col
                    break
            
            if change_type_col is None:
                # 调试：输出所有列名，帮助定位问题
                available_cols = list(df.columns)[:20]  # 只输出前20个列名
                return False, f"未找到'原值变动类型'列。可用列名（前20个）: {available_cols}", None
            
            # 安全地筛选：确保change_type_col在df.columns中
            if change_type_col not in df.columns:
                return False, f"列'{change_type_col}'不在DataFrame中", None
            
            # 使用.loc避免Series布尔判断错误
            try:
                # 直接使用布尔索引，pandas会自动处理
                mask = df[change_type_col] == '原值增加'
                # 使用.loc进行筛选，避免Series布尔判断错误
                addition_df = df.loc[mask].copy()
            except Exception as e:
                # 如果出错，尝试其他方式
                try:
                    addition_df = df[df[change_type_col].astype(str) == '原值增加'].copy()
                except Exception:
                    return False, f"筛选原值增加记录时出错: {str(e)}", None
            
            if addition_df.empty:
                # 调试：检查是否有其他类型的记录
                try:
                    unique_types = df[change_type_col].dropna().unique().tolist()[:10]  # 只取前10个
                except Exception:
                    unique_types = []
                # #region agent log
                import json
                try:
                    with open(r'c:\Users\Administrator\Downloads\FA\.cursor\debug.log', 'a', encoding='utf-8') as f:
                        f.write(json.dumps({
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "A",
                            "location": "sheet_generator.py:527",
                            "message": "addition_df为空，没有原值增加的记录",
                            "data": {
                                "df_total_rows": len(df),
                                "change_type_col": change_type_col,
                                "unique_types": unique_types,
                                "all_change_types_count": df[change_type_col].value_counts().to_dict() if change_type_col in df.columns else {}
                            },
                            "timestamp": int(__import__('time').time() * 1000)
                        }, ensure_ascii=False) + '\n')
                except Exception:
                    pass
                # #endregion
                # 返回带表头的空DataFrame，确保导出时至少包含列名
                empty_df = pd.DataFrame(columns=['资产类别', '固定资产编号', '固定资产名称', '入账开始日期', '使用寿命(月)', '残值率', '新增方式', '新增时间', '增加类型', '原值增加'])
                return True, f"没有原值增加的记录。原值变动类型列中的值（前10个）: {unique_types}", empty_df
            
            result_rows = []
            fm = self.field_mapping or {}
            cols = set(addition_df.columns)
            
            # #region agent log
            import json
            try:
                with open(r'c:\Users\Administrator\Downloads\FA\.cursor\debug.log', 'a', encoding='utf-8') as f:
                    f.write(json.dumps({
                        "sessionId": "debug-session",
                        "runId": "run1",
                        "hypothesisId": "A",
                        "location": "sheet_generator.py:537",
                        "message": "开始处理addition_df数据",
                        "data": {
                            "addition_df_rows": len(addition_df),
                            "field_mapping_keys": list(fm.keys()),
                            "match_col2": self.match_col2,
                            "category_col2": fm.get('category_col2'),
                            "name_col2": fm.get('name_col2'),
                            "date_col2": fm.get('date_col2'),
                            "life_col2": fm.get('life_col2'),
                            "residual_col2": fm.get('residual_col2')
                        },
                        "timestamp": int(__import__('time').time() * 1000)
                    }, ensure_ascii=False) + '\n')
            except Exception:
                pass
            # #endregion
            
            def _use(c):
                return c if c and c in cols else None
            
            # 获取映射的列，如果不存在则尝试自动查找
            category_col = _use(fm.get('category_col2'))
            match_col = _use(self.match_col2)
            name_col = _use(fm.get('name_col2'))
            date_col = _use(fm.get('date_col2'))
            
            # 使用寿命(月)列：优先使用映射，如果不存在则自动查找
            life_col = _use(fm.get('life_col2'))
            
            # 如果映射的列不存在，尝试自动查找
            if not life_col:
                # 尝试自动查找使用寿命列（包含"使用寿命"、"折旧年限"等关键词）
                # 优先查找"使用寿命(月)"相关的列，不限制文件来源
                # 先尝试精确匹配"使用寿命(月)"
                for col in addition_df.columns:
                    col_str = str(col)
                    if '使用寿命(月)' in col_str or '使用寿命（月）' in col_str:
                        # 检查该列是否有非空值
                        if addition_df[col].notna().sum() > 0:
                            life_col = col
                            break
                
                # 如果没找到，使用通用查找方法
                if not life_col:
                    life_col = self._find_file2_column(addition_df, ['使用寿命', '折旧年限', '使用年限', '预计寿命', '寿命', '年限'], ['使用寿命', '折旧年限', '使用年限'])
                    
                    # 如果找到了，再次检查是否有有效值
                    if life_col and life_col in addition_df.columns:
                        if addition_df[life_col].notna().sum() == 0:
                            # 找到的列也是空的，继续查找其他列
                            life_col = None
                            # 在所有列中查找包含关键词且有值的列
                            for col in addition_df.columns:
                                col_str = str(col)
                                for kw in ['使用寿命', '折旧年限', '使用年限', '预计寿命']:
                                    if kw in col_str:
                                        if addition_df[col].notna().sum() > 0:
                                            life_col = col
                                            break
                                if life_col:
                                    break
            
            residual_col = _use(fm.get('residual_col2'))
            original_value_col = _use(self.original_value_col2)  # 文件2的原值列，用于纠偏计算
            original_value_col1 = _use(self.original_value_col1)  # 文件1原值列，用于判断增加类型
            change_col = '原值变动' if '原值变动' in addition_df.columns else None
            addition_method_col = _use(fm.get('addition_method_col2'))
            addition_time_col = _use(fm.get('addition_date_col2')) or date_col
            if not addition_method_col:
                addition_method_col = self._find_file2_column(
                    addition_df,
                    ['新增方式', '增加方式', '取得方式', '来源'],
                    ['新增方式', '增加方式', '取得方式', '资产来源']
                )
            if not addition_time_col:
                addition_time_col = self._find_file2_column(
                    addition_df,
                    ['新增日期', '新增时间', '增加日期', '取得日期'],
                    ['新增日期', '新增时间', '增加日期', '取得日期']
                )
            
            # 纠偏机制：若使用寿命（转为数值后）全部 < 30，视为年数，输出时整列 ×12
            life_correct_years_to_months = False
            life_warning = ""
            if life_col and life_col in addition_df.columns:
                life_vals = pd.to_numeric(addition_df[life_col], errors='coerce').dropna()
                if len(life_vals) > 0 and (life_vals < 30).all():
                    life_correct_years_to_months = True
                    life_warning = "【使用寿命纠偏】系统检测到使用寿命列中全部小于30，判断该列可能是年数而非月数。已自动修正为：使用寿命(月) = 使用寿命 × 12。"
            
            # 纠偏机制：检测残值率列是否有大于100的值
            need_correction = False
            correction_warning = ""
            if residual_col:
                # 将残值率列转换为数值类型（忽略非数值）
                def safe_to_float(val):
                    if pd.isna(val):
                        return None
                    try:
                        if isinstance(val, str):
                            val = val.replace(',', '').replace(' ', '').strip()
                        fval = float(val)
                        return fval if not pd.isna(fval) else None
                    except (ValueError, TypeError):
                        return None
                
                residual_values = addition_df[residual_col].apply(safe_to_float)
                # 检查是否有大于100的值（说明可能是残值而非残值率）
                # 使用any()返回标量值，避免Series布尔判断错误
                has_valid_values = bool(residual_values.notna().any())
                if has_valid_values:
                    max_residual = residual_values.max()
                    # 确保max_residual是标量值
                    if isinstance(max_residual, pd.Series):
                        max_residual = max_residual.iloc[0] if len(max_residual) > 0 else None
                    if max_residual is not None and not pd.isna(max_residual) and max_residual > 100:
                        need_correction = True
                        correction_warning = f"系统检测到残值率列中存在大于100的值（最大值为{max_residual}），判断该列可能是残值而非残值率。已自动修正为：残值率 = 残值 / 原值。"
            
            for row in addition_df.to_dict("records"):
                category = row.get(category_col, '') if category_col else ''
                asset_no = row.get(match_col, '') if match_col else ''
                asset_name = row.get(name_col, '') if name_col else ''
                start_date = row.get(date_col, '') if date_col else ''
                
                # 获取使用寿命(月)值，处理NaN情况；纠偏：若全部<30则按年转月×12
                if life_col:
                    service_life_raw = row.get(life_col, '')
                    if pd.isna(service_life_raw) or service_life_raw is None or (isinstance(service_life_raw, str) and service_life_raw.strip() == ''):
                        service_life = ''
                    elif life_correct_years_to_months:
                        try:
                            x = self._safe_numeric(service_life_raw)
                            y = x * 12
                            service_life = int(y) if y == int(y) else y
                        except Exception:
                            service_life = service_life_raw
                    else:
                        service_life = service_life_raw
                else:
                    service_life = ''
                
                # 残值率处理：如果需要纠偏，计算正确的残值率
                if need_correction and residual_col and original_value_col:
                    # 获取残值（用户映射的列，实际是残值）
                    residual_value = self._safe_numeric(row.get(residual_col, 0))
                    # 获取原值（文件2的原值）
                    original_value = self._safe_numeric(row.get(original_value_col, 0))
                    # 计算残值率 = 残值 / 原值
                    if original_value != 0:
                        residual_rate = residual_value / original_value
                    else:
                        residual_rate = 0.0
                else:
                    # 正常情况：直接使用映射的残值率
                    residual_rate = row.get(residual_col, '') if residual_col else ''
                
                # 原值增加：取原值变动的绝对值
                orig_increase = abs(self._safe_numeric(row.get(change_col, 0))) if change_col else 0
                opening_orig1 = self._safe_numeric(row.get(original_value_col1, 0)) if original_value_col1 else 0
                increase_type = '原值修改' if opening_orig1 != 0 else '非原值修改'
                
                result_rows.append({
                    '资产类别': category,
                    '固定资产编号': asset_no,
                    '固定资产名称': asset_name,
                    '入账开始日期': start_date,
                    '使用寿命(月)': service_life,
                    '残值率': residual_rate,
                    '新增方式': row.get(addition_method_col, '') if addition_method_col else '',
                    '新增时间': row.get(addition_time_col, '') if addition_time_col else '',
                    '增加类型': increase_type,
                    '原值增加': orig_increase,
                })
            
            # 确保即使没有数据，也返回包含所有列名的DataFrame
            if result_rows:
                result_df = pd.DataFrame(result_rows)
            else:
                # 如果没有数据，返回带表头的空DataFrame
                result_df = pd.DataFrame(columns=['资产类别', '固定资产编号', '固定资产名称', '入账开始日期', '使用寿命(月)', '残值率', '新增方式', '新增时间', '增加类型', '原值增加'])
            
            success_msg = f"新增清单_BKD生成成功，共{len(result_df)}条记录"
            if correction_warning:
                success_msg += f"\n{correction_warning}"
            if life_warning:
                success_msg += f"\n{life_warning}"
            return True, success_msg, result_df
            
        except Exception as e:
            return False, f"生成新增清单_BKD失败: {str(e)}", None
    
    def _find_file1_column(self, df: pd.DataFrame, keywords: List[str], exact_keywords: List[str] = None) -> Optional[str]:
        """
        专门查找文件1的列
        增强版：支持更灵活的匹配，包括列名后缀已被替换为文件显示名的情况
        """
        columns = list(df.columns)
        
        # 将列按照"基础名称"分组，同一基础名称的列会有多个（来自不同文件）
        # 对于文件1的列，我们选择列表中靠前的那个（因为文件1的列通常在文件2之前）
        
        # 第一轮：精确匹配
        if exact_keywords:
            # 收集所有匹配的列
            matches = []
            for idx, col in enumerate(columns):
                col_str = str(col)
                # 提取基础名称（第一个下划线之前的部分）
                base_name = col_str.split('_')[0] if '_' in col_str else col_str
                if base_name in exact_keywords:
                    matches.append((idx, col))
            
            # 如果找到匹配，返回索引最小的（通常是文件1的列）
            if matches:
                return min(matches, key=lambda x: x[0])[1]
        
        # 第二轮：包含匹配
        matches = []
        for idx, col in enumerate(columns):
            col_str = str(col)
            # 提取基础名称
            base_name = col_str.split('_')[0] if '_' in col_str else col_str
            for kw in keywords:
                if kw in base_name or kw in col_str:
                    matches.append((idx, col))
                    break
        
        # 返回索引最小的匹配（文件1的列通常在前面）
        if matches:
            return min(matches, key=lambda x: x[0])[1]
        
        return None
    
    def generate_disposal_list(self, df: pd.DataFrame) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        生成处置清单_BKD
        
        字段：资产类别、固定资产编号、固定资产名称、入账开始日期、使用寿命(月)、残值率、
              原值减少、年初累计折旧、本年折旧、净值、处置方式、处置时间、处置原值、处置折旧
        
        数据来源：原值变动类型 == '原值减少' 的记录
        
        处置的资产在期末（文件2）已不存在，所以从文件1获取字段（直接使用用户映射的字段）
        """
        try:
            if df is None or df.empty:
                return False, "数据为空", None
            
            # 筛选原值减少的记录
            if '原值变动类型' not in df.columns:
                return False, "未找到'原值变动类型'列", None
            
            disposal_df = df[df['原值变动类型'] == '原值减少'].copy()
            
            if disposal_df.empty:
                empty_df = pd.DataFrame(columns=['资产类别', '固定资产编号', '固定资产名称', '入账开始日期', '使用寿命(月)', '残值率', '原值减少', '年初累计折旧', '本年折旧', '净值', '减少类型', '处置方式', '处置时间', '处置原值', '处置折旧'])
                return True, "没有原值减少（处置）的记录", empty_df
            
            result_rows = []
            fm = self.field_mapping or {}
            cols = set(disposal_df.columns)
            
            def _use(c):
                return c if c and c in cols else None
            category_col = _use(fm.get('category_col1'))
            match_col = _use(self.match_col)
            name_col = _use(fm.get('name_col1'))
            date_col = _use(fm.get('date_col1'))
            life_col = _use(fm.get('life_col1'))
            residual_col = _use(fm.get('residual_col1'))
            change_col = '原值变动' if '原值变动' in disposal_df.columns else None
            original_value_col1 = _use(self.original_value_col1)
            original_value_col2 = _use(self.original_value_col2)
            dep_col1 = _use(self.depreciation_col1)
            dep_col2 = _use(self.depreciation_col2)
            disposal_method_col1 = _use(fm.get('disposal_method_col1'))
            disposal_method_col2 = _use(fm.get('disposal_method_col2'))
            disposal_date_col1 = _use(fm.get('disposal_date_col1'))
            disposal_date_col2 = _use(fm.get('disposal_date_col2'))
            disposal_orig_col1 = _use(fm.get('disposal_orig_col1'))
            disposal_orig_col2 = _use(fm.get('disposal_orig_col2'))
            disposal_dep_col1 = _use(fm.get('disposal_dep_col1'))
            disposal_dep_col2 = _use(fm.get('disposal_dep_col2'))
            # 未上传补充清单（用户选择否）时，不推算处置折旧/本年折旧，留给客户补充。
            no_disposal_dep_mapping = not self.use_supplement_lists

            if not disposal_method_col1 and not disposal_method_col2:
                disposal_method_col1 = self._find_file1_column(
                    disposal_df,
                    ['处置方式', '减少方式', '报废方式', '出售方式', '转出方式'],
                    ['处置方式', '减少方式', '报废方式', '出售方式']
                )
                disposal_method_col2 = self._find_file2_column(
                    disposal_df,
                    ['处置方式', '减少方式', '报废方式', '出售方式', '转出方式'],
                    ['处置方式', '减少方式', '报废方式', '出售方式']
                )
            if not disposal_date_col1 and not disposal_date_col2:
                disposal_date_col1 = self._find_file1_column(
                    disposal_df,
                    ['处置日期', '处置时间', '减少日期', '报废日期'],
                    ['处置日期', '处置时间', '减少日期', '报废日期']
                )
                disposal_date_col2 = self._find_file2_column(
                    disposal_df,
                    ['处置日期', '处置时间', '减少日期', '报废日期'],
                    ['处置日期', '处置时间', '减少日期', '报废日期']
                )
            if not disposal_orig_col1 and not disposal_orig_col2:
                disposal_orig_col1 = self._find_file1_column(
                    disposal_df,
                    ['处置原值', '减少原值', '原值减少', '处置成本'],
                    ['处置原值', '减少原值', '原值减少']
                )
                disposal_orig_col2 = self._find_file2_column(
                    disposal_df,
                    ['处置原值', '减少原值', '原值减少', '处置成本'],
                    ['处置原值', '减少原值', '原值减少']
                )
            if self.use_supplement_lists and not disposal_dep_col1 and not disposal_dep_col2:
                disposal_dep_col1 = self._find_file1_column(
                    disposal_df,
                    ['处置折旧', '减少折旧', '累计折旧减少'],
                    ['处置折旧', '减少折旧', '累计折旧减少']
                )
                disposal_dep_col2 = self._find_file2_column(
                    disposal_df,
                    ['处置折旧', '减少折旧', '累计折旧减少'],
                    ['处置折旧', '减少折旧', '累计折旧减少']
                )
                if disposal_dep_col1 or disposal_dep_col2:
                    no_disposal_dep_mapping = False

            group_dep_base_abs = None
            if original_value_col1 in df.columns and dep_col1 in df.columns:
                group_key_cols = [c for c in (self.match_cols or ([self.match_col] if self.match_col else [])) if c in df.columns]
                if group_key_cols:
                    group_key = self._build_composite_key_series(df, group_key_cols)
                    valid_group = group_key != ""
                    if valid_group.any():
                        orig1_abs = df[original_value_col1].apply(self._safe_numeric).abs()
                        dep1_abs = df[dep_col1].apply(self._safe_numeric).abs()
                        group_size = group_key[valid_group].groupby(group_key[valid_group]).transform("size")
                        group_orig1_abs = orig1_abs.loc[valid_group].groupby(group_key[valid_group]).transform("sum")
                        group_dep1_abs = dep1_abs.loc[valid_group].groupby(group_key[valid_group]).transform("sum")
                        group_dep_base_abs = pd.DataFrame(
                            {
                                "size": group_size,
                                "orig1_abs": group_orig1_abs,
                                "dep1_abs": group_dep1_abs,
                            },
                            index=group_size.index,
                        )
            
            for idx, row in disposal_df.iterrows():
                category = row.get(category_col, '') if category_col else ''
                asset_no = row.get(match_col, '') if match_col else ''
                asset_name = row.get(name_col, '') if name_col else ''
                start_date = row.get(date_col, '') if date_col else ''
                service_life = row.get(life_col, '') if life_col else ''
                residual_rate = row.get(residual_col, '') if residual_col else ''
                
                # 原值：取自原值变动的绝对值
                orig_change = row.get(change_col, 0) if change_col else 0
                original_value = abs(self._safe_numeric(orig_change))
                ending_orig2 = self._safe_numeric(row.get(original_value_col2, 0)) if original_value_col2 else 0
                decrease_type = '原值修改' if ending_orig2 != 0 else '非原值修改'
                disposal_method = self._get_value_with_fallback(row, disposal_method_col1, disposal_method_col2, '')
                disposal_time = self._get_value_with_fallback(row, disposal_date_col1, disposal_date_col2, '')

                # 严格口径：处置原值仅来自处置清单映射列；未映射或空值不再回退主数据
                disposal_orig_raw = self._get_value_with_fallback(row, disposal_orig_col1, disposal_orig_col2, '')
                if disposal_orig_raw == '' or pd.isna(disposal_orig_raw):
                    disposal_original_value = ''
                else:
                    disposal_original_value = abs(self._safe_numeric(disposal_orig_raw))

                # 处置折旧列仅来自补充清单映射；未上传补充清单时不再用主表累计折旧回填。
                if no_disposal_dep_mapping:
                    disposal_dep_raw = ''
                else:
                    disposal_dep_raw = self._get_value_with_fallback(row, disposal_dep_col1, disposal_dep_col2, '')
                if disposal_dep_raw == '' or pd.isna(disposal_dep_raw):
                    disposal_dep_value = ''
                else:
                    disposal_dep_value = abs(self._safe_numeric(disposal_dep_raw))

                # “累计折旧/净值”固定走主数据，不受二次上传处置清单映射影响
                main_dep_raw = self._get_value_with_fallback(row, dep_col1, dep_col2, '')
                if main_dep_raw == '' or pd.isna(main_dep_raw):
                    depreciation_value = '[需客户提供]'
                    current_year_dep_value = ''
                    net_value = '[需客户提供]'
                else:
                    depreciation_value = self._safe_numeric(main_dep_raw)
                    # 原值修改属于部分处置：按"原值减少 / 年初原值"比例分摊年初累计折旧
                    # 取不到年初原值或为 0 时退回全额，避免因数据缺失误算
                    if decrease_type == '原值修改' and original_value_col1:
                        opening_orig1 = self._safe_numeric(row.get(original_value_col1, 0))
                        try:
                            opening_orig1_num = abs(float(opening_orig1))
                        except Exception:
                            opening_orig1_num = 0.0
                        if opening_orig1_num > 0:
                            ratio = abs(self._safe_numeric(original_value)) / opening_orig1_num
                            depreciation_value = depreciation_value * ratio
                    if (
                        group_dep_base_abs is not None
                        and idx in group_dep_base_abs.index
                        and group_dep_base_abs.at[idx, "size"] > 1
                        and group_dep_base_abs.at[idx, "orig1_abs"] > 0
                    ):
                        ratio = min(
                            abs(self._safe_numeric(original_value)) / group_dep_base_abs.at[idx, "orig1_abs"],
                            1.0,
                        )
                        depreciation_value = group_dep_base_abs.at[idx, "dep1_abs"] * ratio
                    if disposal_dep_value == '':
                        current_year_dep_value = ''
                    else:
                        current_year_dep_value = abs(disposal_dep_value) - abs(depreciation_value)
                    net_value = original_value - abs(depreciation_value)
                
                result_rows.append({
                    '资产类别': category,
                    '固定资产编号': asset_no,
                    '固定资产名称': asset_name,
                    '入账开始日期': start_date,
                    '使用寿命(月)': service_life,
                    '残值率': residual_rate,
                    '原值减少': original_value,
                    '年初累计折旧': depreciation_value,
                    '本年折旧': current_year_dep_value,
                    '净值': net_value,
                    '减少类型': decrease_type,
                    '处置方式': disposal_method,
                    '处置时间': disposal_time,
                    '处置原值': disposal_original_value,
                    '处置折旧': disposal_dep_value if disposal_dep_value != '' else '',
                })
            
            result_df = pd.DataFrame(result_rows)
            return True, f"处置清单_BKD生成成功，共{len(result_df)}条记录", result_df
            
        except Exception as e:
            return False, f"生成处置清单_BKD失败: {str(e)}", None
