"""
完全外部联接引擎
实现Excel Power Query的完全外部联接功能
"""
import pandas as pd
from itertools import permutations
from typing import List, Optional, Tuple, Union
from data_preprocessor import DataPreprocessor
from duplicate_checker import DuplicateChecker

# #region agent log
try:
    from debug_logger import _write as _dbg
except Exception:
    _dbg = lambda **_kw: None
# #endregion


class MergeEngine:
    """合并引擎"""
    
    def __init__(self):
        self.preprocessor = DataPreprocessor()
        self.duplicate_checker = DuplicateChecker()
        self.merged_result = None
    
    def perform_full_outer_join(
        self,
        df1: pd.DataFrame,
        df2: pd.DataFrame,
        match_columns1: Union[str, List[str]],
        match_columns2: Union[str, List[str]],
        data_type1: str = 'auto',
        data_type2: str = 'auto',
        remove_spaces: bool = True,
        case_sensitive: bool = False,
        handle_duplicates: str = 'pivot',  # 'pivot', 'keep_first', 'keep_last'
        original_value_col1: Optional[str] = None,
        original_value_col2: Optional[str] = None,
        depreciation_col1: Optional[str] = None,
        depreciation_col2: Optional[str] = None,
        residual_col2: Optional[str] = None
    ) -> Tuple[bool, str, Optional[pd.DataFrame]]:
        """
        执行完全外部联接（支持多列匹配）
        
        Args:
            df1: 文件1的DataFrame
            df2: 文件2的DataFrame
            match_columns1: 文件1的匹配列名或列名列表
            match_columns2: 文件2的匹配列名或列名列表
            data_type1: 文件1匹配列的数据类型
            data_type2: 文件2匹配列的数据类型
            remove_spaces: 是否去除空格
            case_sensitive: 是否区分大小写
            handle_duplicates: 重复值处理方式
            
        Returns:
            tuple: (成功标志, 错误消息, 合并后的DataFrame)
        """
        # 确保是列表格式（向后兼容）
        if isinstance(match_columns1, str):
            match_columns1 = [match_columns1]
        if isinstance(match_columns2, str):
            match_columns2 = [match_columns2]
        auto_aligned_note = ""
        try:
            match_columns2, order_aligned = self._auto_align_match_columns(df1, df2, match_columns1, match_columns2)
            if order_aligned:
                auto_aligned_note = "\n注意: 已自动对齐文件2匹配列顺序。"
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine.perform_full_outer_join.entry",
                 message="merge entry", data={"data_type1": data_type1, "data_type2": data_type2, "shape1": [len(df1), len(df1.columns)], "shape2": [len(df2), len(df2.columns)]})
            # #endregion
            # 验证匹配列
            is_valid, error_msg = self.preprocessor.validate_match_columns(
                df1, df2, match_columns1, match_columns2
            )
            if not is_valid:
                return False, error_msg, None
            
            # 数据预处理
            df1_processed, df2_processed = self.preprocessor.preprocess_for_merge(
                df1, df2, match_columns1, match_columns2,
                data_type1, data_type2, remove_spaces, case_sensitive
            )
            # 空匹配键按出现顺序逐卡片配对，避免空ID被聚合成单行
            effective_match_columns1 = list(match_columns1)
            effective_match_columns2 = list(match_columns2)
            blank_seq_col = "__blank_seq__"

            def _all_match_blank_mask(df_src: pd.DataFrame, cols: List[str]) -> pd.Series:
                if df_src is None or df_src.empty or not cols:
                    return pd.Series([False] * (0 if df_src is None else len(df_src)), index=(None if df_src is None else df_src.index))
                vals = df_src[cols]
                txt = vals.fillna("").astype(str).apply(lambda s: s.str.strip())
                return txt.eq("").all(axis=1)

            blank_mask1 = _all_match_blank_mask(df1_processed, match_columns1)
            blank_mask2 = _all_match_blank_mask(df2_processed, match_columns2)
            if bool(blank_mask1.any()) or bool(blank_mask2.any()):
                df1_processed[blank_seq_col] = ""
                df2_processed[blank_seq_col] = ""
                if bool(blank_mask1.any()):
                    df1_processed.loc[blank_mask1, blank_seq_col] = [f"B{n}" for n in range(1, int(blank_mask1.sum()) + 1)]
                if bool(blank_mask2.any()):
                    df2_processed.loc[blank_mask2, blank_seq_col] = [f"B{n}" for n in range(1, int(blank_mask2.sum()) + 1)]
                effective_match_columns1.append(blank_seq_col)
                effective_match_columns2.append(blank_seq_col)
            # #region agent log
            # 记录第一列的信息用于日志
            d1 = df1_processed[match_columns1[0]]; d2 = df2_processed[match_columns2[0]]
            nan1 = d1.isna().sum(); nan2 = d2.isna().sum()
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1",
                 location="merge_engine.after_preprocess", message="after preprocess",
                 data={"dtype1": str(d1.dtype), "dtype2": str(d2.dtype), "nan1": int(nan1), "nan2": int(nan2), "len1": len(df1_processed), "len2": len(df2_processed), "match_cols1": match_columns1, "match_cols2": match_columns2})
            # #endregion
            
            # 检测文件1和文件2的重复值（基于多列组合）
            has_duplicates1, duplicate_info1 = self.duplicate_checker.check_duplicates(
                df1_processed, effective_match_columns1
            )
            has_duplicates2, duplicate_info2 = self.duplicate_checker.check_duplicates(
                df2_processed, effective_match_columns2
            )

            # 当文件1匹配列存在重复值时：
            # - 不聚合文件1，保持文件1原始行不变
            # - 仅对“重复匹配值”对应的文件2记录做聚合：原值/累计折旧求和，其它字段取首行
            # - 合并后仅在每个重复匹配值的首行展示文件2字段，避免文件2信息被重复展开导致汇总重复计算
            SEPARATOR = '|||'  # 使用可打印字符作为分隔符，避免null byte问题
            
            # 为文件1和文件2创建组合匹配键
            df1_processed['__match_key__'] = df1_processed[effective_match_columns1].fillna('').astype(str).agg(SEPARATOR.join, axis=1)
            df2_processed['__match_key__'] = df2_processed[effective_match_columns2].fillna('').astype(str).agg(SEPARATOR.join, axis=1)
            
            # 检测文件1的重复键
            dup_keys_file1 = []
            if has_duplicates1:
                dup_mask = df1_processed['__match_key__'].duplicated(keep=False)
                dup_vals = df1_processed.loc[dup_mask, '__match_key__']
                # 保留空匹配键：空ID场景也应进入重复组规则
                dup_vals = dup_vals[dup_vals.notna()]
                dup_keys_file1 = dup_vals.unique().tolist()
            
            # 检测文件2的重复键
            dup_keys_file2 = []
            if has_duplicates2:
                dup_mask = df2_processed['__match_key__'].duplicated(keep=False)
                dup_vals = df2_processed.loc[dup_mask, '__match_key__']
                # 保留空匹配键：空ID场景也应进入重复组规则
                dup_vals = dup_vals[dup_vals.notna()]
                dup_keys_file2 = dup_vals.unique().tolist()
            
            # 合并dup_keys，用于后续处理
            dup_keys = list(set(dup_keys_file1 + dup_keys_file2)) if handle_duplicates == 'pivot' else []
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H6",
                 location="merge_engine.dup_keys_detected",
                 message="duplicate keys detected",
                 data={"df1_rows": len(df1_processed),
                       "df2_rows": len(df2_processed),
                       "df1_unique_keys": df1_processed['__match_key__'].nunique(),
                       "df2_unique_keys": df2_processed['__match_key__'].nunique(),
                       "dup_keys_file1_count": len(dup_keys_file1),
                       "dup_keys_file2_count": len(dup_keys_file2)})
            # #endregion
            
            # 始终聚合文件2（按匹配键），确保每个匹配键只有一行，避免笛卡尔积
            sum_cols = []
            if original_value_col2 and original_value_col2 in df2_processed.columns:
                df2_processed[original_value_col2] = df2_processed[original_value_col2].apply(self._safe_to_numeric)
                sum_cols.append(original_value_col2)
            if depreciation_col2 and depreciation_col2 in df2_processed.columns:
                df2_processed[depreciation_col2] = df2_processed[depreciation_col2].apply(self._safe_to_numeric)
                sum_cols.append(depreciation_col2)
            # 仅在“残值纠偏”触发时（存在>100的值）才对残值列做求和
            if residual_col2 and residual_col2 in df2_processed.columns:
                residual_series = df2_processed[residual_col2].apply(self._safe_to_numeric)
                if bool((residual_series > 100).any()):
                    df2_processed[residual_col2] = residual_series
                    sum_cols.append(residual_col2)
            
            # 构建聚合字典：数值列求和，其他列取首行
            agg_dict = {}
            for c in df2_processed.columns:
                if c == '__match_key__':
                    continue
                if c in sum_cols:
                    agg_dict[c] = 'sum'
                else:
                    agg_dict[c] = 'first'
            
            # 按匹配键聚合文件2
            df2_aggregated = df2_processed.groupby('__match_key__', as_index=False).agg(agg_dict)
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H6",
                 location="merge_engine.df2_aggregated",
                 message="df2 aggregated",
                 data={"df2_original_rows": len(df2_processed),
                       "df2_aggregated_rows": len(df2_aggregated)})
            # #endregion
            
            # 删除临时匹配键列
            if '__match_key__' in df2_aggregated.columns:
                df2_aggregated = df2_aggregated.drop(columns=['__match_key__'])
            
            df2_processed_for_merge = df2_aggregated
            
            # 删除文件1的临时匹配键列（在rename前删除，避免列名冲突）
            if '__match_key__' in df1_processed.columns:
                df1_processed = df1_processed.drop(columns=['__match_key__'])
            
            # 根据重复值处理方式处理文件1
            if has_duplicates1 and handle_duplicates != 'pivot':
                if handle_duplicates == 'keep_first':
                    df1_processed = self.duplicate_checker.handle_duplicates_keep_first(
                        df1_processed, match_columns1
                    )
                elif handle_duplicates == 'keep_last':
                    df1_processed = self.duplicate_checker.handle_duplicates_keep_last(
                        df1_processed, match_columns1
                    )
            
            # 合并前统一列名为「字段名_文件名」，便于预览/导出时区分来源
            # 确保不会产生重复的列名：如果列名已经包含后缀，不再添加
            rename1 = {}
            for c in df1_processed.columns:
                c_str = str(c)
                if c_str.endswith('_文件1'):
                    rename1[c] = c_str  # 已经包含后缀，不重复添加
                else:
                    rename1[c] = f"{c_str}_文件1"
            
            rename2 = {}
            for c in df2_processed_for_merge.columns:
                c_str = str(c)
                if c_str.endswith('_文件2'):
                    rename2[c] = c_str  # 已经包含后缀，不重复添加
                else:
                    rename2[c] = f"{c_str}_文件2"
            
            df1_renamed = df1_processed.rename(columns=rename1)
            df2_renamed = df2_processed_for_merge.rename(columns=rename2)
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="merge_engine.after_rename",
                 message="after rename", data={"df1_cols": list(df1_renamed.columns)[:10], "df2_cols": list(df2_renamed.columns)[:10],
                                              "df1_cols_duplicates": [col for col in df1_renamed.columns if list(df1_renamed.columns).count(col) > 1],
                                              "df2_cols_duplicates": [col for col in df2_renamed.columns if list(df2_renamed.columns).count(col) > 1]})
            # #endregion
            # 构建多列合并键（带后缀）
            left_on = [f"{col}_文件1" for col in effective_match_columns1]
            right_on = [f"{col}_文件2" for col in effective_match_columns2]
            left_on_display = [f"{col}_文件1" for col in match_columns1]
            right_on_display = [f"{col}_文件2" for col in match_columns2]
            
            # 执行完全外部联接（支持多列）
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine.before_merge",
                 message="before pd.merge", data={"left_on": left_on, "right_on": right_on})
            # #endregion
            merged = pd.merge(
                df1_renamed,
                df2_renamed,
                left_on=left_on,
                right_on=right_on,
                how='outer',
                suffixes=('_文件1', '_文件2'),  # 已预先加后缀，冲突时再追加
                indicator=True
            )
            # #region agent log
            merged_cols_list = list(merged.columns)
            merged_cols_duplicates = [col for col in merged_cols_list if merged_cols_list.count(col) > 1]
            _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="merge_engine.after_merge",
                 message="after pd.merge", data={"merged_rows": len(merged), "merged_cols": len(merged.columns),
                                                "merged_cols_duplicates": merged_cols_duplicates,
                                                "merged_index_duplicates": merged.index.duplicated().any() if hasattr(merged.index, 'duplicated') else False})
            # #endregion
            
            # 检查并修复重复的列名
            if merged_cols_duplicates:
                # 如果有重复的列名，重命名它们
                cols_to_rename = {}
                col_counts = {}
                for col in merged.columns:
                    col_str = str(col)
                    if col_str in col_counts:
                        col_counts[col_str] += 1
                        cols_to_rename[col] = f"{col_str}_{col_counts[col_str]}"
                    else:
                        col_counts[col_str] = 1
                if cols_to_rename:
                    merged = merged.rename(columns=cols_to_rename)
                    # #region agent log
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="merge_engine.after_fix_duplicate_cols",
                         message="after fix duplicate cols", data={"renamed_cols": list(cols_to_rename.items())[:5]})
                    # #endregion
            
            # 检查并修复重复的索引
            if merged.index.duplicated().any():
                merged = merged.reset_index(drop=True)
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H5", location="merge_engine.after_fix_duplicate_index",
                     message="after fix duplicate index", data={"new_index_len": len(merged.index)})
                # #endregion
            
            if '_merge' in merged.columns:
                merged = merged.rename(columns={'_merge': '数据来源'})
                merged['数据来源'] = merged['数据来源'].map({
                    'left_only': '仅文件1',
                    'right_only': '仅文件2',
                    'both': '两文件都有'
                }).astype('object')
            
            # 添加统一匹配列（便于查看）：多列组合显示，优先取文件1，缺则取文件2
            # 生成组合显示值
            left_cols = [col for col in left_on_display if col in merged.columns]
            right_cols = [col for col in right_on_display if col in merged.columns]
            
            def _format_match_value(val):
                """格式化匹配值：整数不显示小数点，其他保持原样"""
                if pd.isna(val):
                    return ''
                # 如果是浮点数但实际是整数值，转换为整数显示
                if isinstance(val, float) and val == int(val):
                    return str(int(val))
                return str(val)
            
            if left_cols and right_cols:
                # 优先使用文件1的列，缺失时用文件2填充
                match_series = merged[left_cols[0]].fillna(merged[right_cols[0]])
                # 格式化为字符串，整数不显示小数点
                merged['匹配列'] = match_series.apply(_format_match_value)
                # 如果有多个列，显示组合值
                if len(left_cols) > 1:
                    for i in range(1, len(left_cols)):
                        additional = merged[left_cols[i]].fillna(merged[right_cols[i] if i < len(right_cols) else right_cols[0]])
                        merged['匹配列'] = merged['匹配列'] + ' | ' + additional.apply(_format_match_value)
            elif left_cols:
                merged['匹配列'] = merged[left_cols[0]].apply(_format_match_value)
            elif right_cols:
                merged['匹配列'] = merged[right_cols[0]].apply(_format_match_value)
            else:
                merged['匹配列'] = ''
            
            # 添加计算的辅助列（原值变动、累计折旧变动等）
            # 传递dup_keys和left_on，用于处理重复匹配值的变动计算
            merged = self._add_calculated_columns(
                merged,
                original_value_col1,
                original_value_col2,
                depreciation_col1,
                depreciation_col2,
                dup_keys=dup_keys if (has_duplicates1 or has_duplicates2) and handle_duplicates == 'pivot' else [],
                left_on=left_on
            )

            # 若文件1存在重复匹配值（pivot模式），仅在每个重复匹配值的首行展示文件2字段
            # 这样对文件2原值/累计折旧等做汇总时不会被重复计算，同时保持文件1原始行不变
            if dup_keys and handle_duplicates == 'pivot':
                try:
                    # 仅处理“文件1侧有该匹配值且文件2匹配成功”的行
                    # 生成组合键用于匹配（与dup_keys的格式一致）
                    SEPARATOR_LOCAL = '|||'
                    merged['__left_key__'] = merged[left_on].fillna('').astype(str).agg(SEPARATOR_LOCAL.join, axis=1)
                    merged['__right_key__'] = merged[right_on].fillna('').astype(str).agg(SEPARATOR_LOCAL.join, axis=1)
                    
                    # 以“右侧存在匹配行”为准判定匹配成功；允许空键（如空ID）进入重复组抑制
                    right_matched = merged[right_on].notna().any(axis=1)
                    mask_dup = merged['__left_key__'].isin(dup_keys) & right_matched
                    if mask_dup.any():
                        # 需要置空的文件2字段（保留匹配列本身right_on，便于识别匹配）
                        def _is_file2_col(col):
                            s = str(col)
                            return s.endswith('_文件2') or '_文件2_' in s
                        file2_cols = [c for c in merged.columns if _is_file2_col(c) and c not in right_on]

                        if file2_cols:
                            # 每个匹配值，仅保留第一行的文件2字段，其余置空
                            grp = merged.loc[mask_dup, '__left_key__']
                            cc = merged.loc[mask_dup].groupby(grp).cumcount()
                            mask_blank = pd.Series(False, index=merged.index)
                            mask_blank.loc[mask_dup] = cc > 0
                            merged.loc[mask_blank, file2_cols] = pd.NA
                            
                            # 同时置空"原值变动"和"累计折旧变动"在非首行（确保一致性）
                            calculated_cols = []
                            if '原值变动' in merged.columns:
                                calculated_cols.append('原值变动')
                            if '累计折旧变动' in merged.columns:
                                calculated_cols.append('累计折旧变动')
                            if calculated_cols:
                                merged.loc[mask_blank, calculated_cols] = pd.NA

                            # 空ID组（空匹配键）非首行：匹配列保持首行展示；
                            # 变动类型列与首行保持一致（用户要求）
                            empty_group_mask = mask_dup & (merged['__left_key__'] == '')
                            empty_key_mask = mask_blank & (merged['__left_key__'] == '')
                            if bool(empty_key_mask.any()) and '匹配列' in merged.columns:
                                merged.loc[empty_key_mask, '匹配列'] = pd.NA
                            if bool(empty_group_mask.any()):
                                first_idx = merged.loc[empty_group_mask].index[0]
                                for c in ('原值变动类型', '累计折旧变动类型'):
                                    if c in merged.columns:
                                        merged.loc[empty_group_mask, c] = merged.at[first_idx, c]
                    
                    # 删除临时键列
                    merged = merged.drop(columns=['__left_key__', '__right_key__'], errors='ignore')
                except Exception:
                    # 不影响主流程
                    if '__left_key__' in merged.columns:
                        merged = merged.drop(columns=['__left_key__'], errors='ignore')
                    if '__right_key__' in merged.columns:
                        merged = merged.drop(columns=['__right_key__'], errors='ignore')
                    pass

            # 空ID组展示口径（方案B）：
            # - 文件2卡片逐行保留；
            # - 原值变动/累计折旧变动仅首行展示组汇总；
            # - 原值变动类型/累计折旧变动类型在组内与首行一致。
            try:
                if handle_duplicates == 'pivot':
                    disp_left = [c for c in left_on_display if c in merged.columns]
                    disp_right = [c for c in right_on_display if c in merged.columns]

                    def _all_blank(frame: pd.DataFrame, cols: List[str]) -> pd.Series:
                        if not cols:
                            return pd.Series([True] * len(frame), index=frame.index)
                        vals = frame[cols].fillna('').astype(str).apply(lambda s: s.str.strip())
                        return vals.eq('').all(axis=1)

                    left_blank = _all_blank(merged, disp_left)
                    right_blank = _all_blank(merged, disp_right)
                    empty_group_mask = left_blank & right_blank

                    if bool(empty_group_mask.any()):
                        empty_idx = list(merged.index[empty_group_mask])
                        first_idx = empty_idx[0]
                        rest_idx = empty_idx[1:]

                        if '原值变动' in merged.columns:
                            ov_sum = pd.to_numeric(merged.loc[empty_group_mask, '原值变动'], errors='coerce').fillna(0).sum()
                            merged.loc[first_idx, '原值变动'] = ov_sum
                            if rest_idx:
                                merged.loc[rest_idx, '原值变动'] = pd.NA
                            if '原值变动类型' in merged.columns:
                                ov_type = '原值减少' if ov_sum > 0 else ('原值增加' if ov_sum < 0 else '原值不变')
                                merged.loc[empty_group_mask, '原值变动类型'] = ov_type

                        if '累计折旧变动' in merged.columns:
                            dv_sum = pd.to_numeric(merged.loc[empty_group_mask, '累计折旧变动'], errors='coerce').fillna(0).sum()
                            merged.loc[first_idx, '累计折旧变动'] = dv_sum
                            if rest_idx:
                                merged.loc[rest_idx, '累计折旧变动'] = pd.NA
                            if '累计折旧变动类型' in merged.columns:
                                dv_type = '累计折旧减少' if dv_sum > 0 else ('累计折旧增加' if dv_sum < 0 else '累计折旧不变')
                                merged.loc[empty_group_mask, '累计折旧变动类型'] = dv_type
            except Exception:
                pass

            
            # 修复匹配列的整数显示问题：转为字符串，避免导出为数字时显示 .0
            def _to_display_str(series):
                """将整型浮点数转为无小数点的字符串，导出时按文本写入"""
                def _convert(val):
                    if pd.isna(val):
                        return ''
                    if isinstance(val, float) and val == int(val):
                        return str(int(val))
                    return str(val)
                return series.apply(_convert)
            
            # 匹配列（left_on/right_on）转为字符串，导出显示为 1100000 而非 1100000.0
            for col in left_on + right_on:
                if col in merged.columns:
                    merged[col] = _to_display_str(merged[col])
            
            self.merged_result = merged
            
            # 清理空键顺序匹配临时列，不参与展示与导出
            temp_merge_cols = [f"{blank_seq_col}_文件1", f"{blank_seq_col}_文件2", blank_seq_col]
            merged = merged.drop(columns=[c for c in temp_merge_cols if c in merged.columns], errors='ignore')

            # 生成合并统计信息
            has_any_duplicates = has_duplicates1 or has_duplicates2
            duplicate_info_combined = duplicate_info1 if has_duplicates1 else (duplicate_info2 if has_duplicates2 else {})
            merge_stats = self._generate_merge_stats(merged, has_any_duplicates, duplicate_info_combined)
            if auto_aligned_note:
                merge_stats += auto_aligned_note
            
            return True, merge_stats, merged
            
        except Exception as e:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine.exception",
                 message="merge exception", data={"error": str(e), "type": type(e).__name__})
            # #endregion
            return False, f"合并过程中出错: {str(e)}", None
    
    def _generate_merge_stats(
        self,
        merged: pd.DataFrame,
        has_duplicates: bool,
        duplicate_info: dict
    ) -> str:
        """生成合并统计信息"""
        stats = []
        stats.append("合并完成！")
        stats.append(f"合并后总行数: {len(merged)}")
        
        if '数据来源' in merged.columns:
            source_counts = merged['数据来源'].value_counts()
            stats.append("\n数据来源统计:")
            for source, count in source_counts.items():
                stats.append(f"  {source}: {count} 行")
        
        if has_duplicates:
            stats.append(f"\n注意: 文件1的匹配列存在重复值")
            if duplicate_info:
                stats.append(f"  重复值数量: {duplicate_info.get('total_duplicate_values', 0)}")
                stats.append(f"  重复行数量: {duplicate_info.get('total_duplicate_rows', 0)}")
                stats.append("  已按规则处理：保留文件1原始行；对重复匹配值对应的文件2记录做汇总（原值/累计折旧求和，其它字段取首行），并仅在每个重复匹配值的首行展示文件2字段，避免重复计算")
        
        return "\n".join(stats)
    
    def get_merged_result(self) -> Optional[pd.DataFrame]:
        """获取合并结果"""
        return self.merged_result
    
    def get_duplicate_info(self) -> dict:
        """获取重复值信息"""
        return self.duplicate_checker.duplicate_info
    
    def _safe_to_numeric(self, value):
        """安全转换为数值，失败返回0"""
        # 确保value是标量值，不是Series
        if isinstance(value, pd.Series):
            # 如果传入的是Series，取第一个值（不应该发生，但为了安全）
            value = value.iloc[0] if len(value) > 0 else None
        
        # 检查NaN
        try:
            is_na = pd.isna(value)
            # 如果pd.isna返回Series，取第一个值
            if isinstance(is_na, pd.Series):
                is_na = is_na.iloc[0] if len(is_na) > 0 else False
            if is_na:
                return 0.0
        except:
            pass
        
        try:
            if isinstance(value, str):
                # 去除千分位分隔符和空格
                value = value.replace(',', '').replace(' ', '').strip()
            return float(value)
        except (ValueError, TypeError):
            return 0.0
    
    def _auto_align_match_columns(
        self,
        df1: pd.DataFrame,
        df2: pd.DataFrame,
        match_columns1: List[str],
        match_columns2: List[str],
    ) -> Tuple[List[str], bool]:
        if not match_columns1 or not match_columns2:
            return list(match_columns2), False
        if len(match_columns1) != len(match_columns2):
            return list(match_columns2), False
        if len(match_columns1) <= 1:
            return list(match_columns2), False

        cols2 = list(match_columns2)

        def _norm_col_name(v: str) -> str:
            s = str(v or "").strip().lower()
            for suf in ("_文件1", "_文件2", "_鏂囦欢1", "_鏂囦欢2"):
                s = s.replace(suf.lower(), "")
            for ch in (" ", "_", "-", "(", ")", "[", "]", "【", "】", "（", "）"):
                s = s.replace(ch, "")
            return s

        def _sample_set(frame: pd.DataFrame, col: str, max_n: int = 300):
            if frame is None or col not in frame.columns:
                return set()
            s = frame[col].dropna().astype(str).str.strip()
            s = s[s != ""]
            if len(s) > max_n:
                s = s.head(max_n)
            return set(s.tolist())

        norm1 = [_norm_col_name(c) for c in match_columns1]
        norm2 = [_norm_col_name(c) for c in cols2]
        can_exact_map = (
            all(norm1) and all(norm2)
            and len(set(norm1)) == len(norm1)
            and len(set(norm2)) == len(norm2)
        )
        reliable_name_signal = can_exact_map and len(set(norm1 + norm2)) > 1

        def _score(c1: str, c2: str) -> float:
            n1 = _norm_col_name(c1)
            n2 = _norm_col_name(c2)
            score = 0.0
            if reliable_name_signal:
                if n1 and n2 and n1 == n2:
                    score += 10.0
                elif n1 and n2 and (n1 in n2 or n2 in n1):
                    score += 4.0
            s1 = _sample_set(df1, c1)
            s2 = _sample_set(df2, c2)
            if s1 and s2:
                inter = len(s1 & s2)
                base = min(len(s1), len(s2))
                if base > 0:
                    score += 6.0 * (inter / base)
            return score

        if can_exact_map:
            used = set()
            mapped_idx = []
            for c1 in match_columns1:
                tgt = _norm_col_name(c1)
                hit = None
                for j, c2 in enumerate(cols2):
                    if j in used:
                        continue
                    if tgt and _norm_col_name(c2) == tgt:
                        hit = j
                        break
                if hit is None:
                    mapped_idx = []
                    break
                used.add(hit)
                mapped_idx.append(hit)
            if mapped_idx and len(mapped_idx) == len(cols2):
                reordered = [cols2[j] for j in mapped_idx]
                return reordered, (reordered != cols2)

        n = len(cols2)
        current_score = sum(_score(match_columns1[i], cols2[i]) for i in range(n))
        best_score = current_score
        best_perm = tuple(range(n))
        if n <= 5:
            for perm in permutations(range(n)):
                sc = sum(_score(match_columns1[i], cols2[perm[i]]) for i in range(n))
                if sc > best_score:
                    best_score = sc
                    best_perm = perm
        else:
            remain = set(range(n))
            perm = []
            for i in range(n):
                j = max(remain, key=lambda k: _score(match_columns1[i], cols2[k]))
                perm.append(j)
                remain.remove(j)
            sc = sum(_score(match_columns1[i], cols2[perm[i]]) for i in range(n))
            if sc > best_score:
                best_score = sc
                best_perm = tuple(perm)
        if best_perm != tuple(range(n)):
            return [cols2[j] for j in best_perm], True
        return cols2, False

    def _add_calculated_columns(
        self,
        merged: pd.DataFrame,
        original_value_col1: Optional[str] = None,
        original_value_col2: Optional[str] = None,
        depreciation_col1: Optional[str] = None,
        depreciation_col2: Optional[str] = None,
        dup_keys: list = None,
        left_on: Union[str, List[str], None] = None
    ) -> pd.DataFrame:
        """添加计算的辅助列（原值变动、累计折旧变动等），支持多列匹配"""
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="merge_engine._add_calculated_columns.entry",
             message="entry", data={"original_value_col1_type": type(original_value_col1).__name__, "original_value_col2_type": type(original_value_col2).__name__, 
                                   "depreciation_col1_type": type(depreciation_col1).__name__, "depreciation_col2_type": type(depreciation_col2).__name__,
                                   "original_value_col1": str(original_value_col1)[:50] if original_value_col1 else None,
                                   "original_value_col2": str(original_value_col2)[:50] if original_value_col2 else None})
        # #endregion
        merged = merged.copy()
        
        # 如果用户指定了原值列，使用指定的列；否则自动查找
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="merge_engine._add_calculated_columns.before_check1",
             message="before check original_value_cols", data={"orig1_is_none": original_value_col1 is None, "orig2_is_none": original_value_col2 is None})
        # #endregion
        if original_value_col1 is not None and original_value_col2 is not None:
            # 查找带后缀的列名
            orig_col1_name = f"{original_value_col1}_文件1"
            orig_col2_name = f"{original_value_col2}_文件2"
            if orig_col1_name in merged.columns and orig_col2_name in merged.columns:
                original_value_col1_found = orig_col1_name
                original_value_col2_found = orig_col2_name
            else:
                original_value_col1_found = None
                original_value_col2_found = None
        else:
            # 自动查找原值相关列
            original_value_col1_found = None
            original_value_col2_found = None
            for col in merged.columns:
                col_str = str(col).lower()
                if '_文件1' in str(col) and ('原值' in str(col) or '成本' in str(col)):
                    original_value_col1_found = col
                elif '_文件2' in str(col) and ('原值' in str(col) or '成本' in str(col)):
                    original_value_col2_found = col
        
        # 如果找到原值列，计算变动
        # #region agent log
        try:
            orig1_type = type(original_value_col1_found).__name__ if original_value_col1_found is not None else "None"
            orig2_type = type(original_value_col2_found).__name__ if original_value_col2_found is not None else "None"
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine._add_calculated_columns.before_orig_check",
                 message="before checking original_value_cols_found", data={"orig1_type": orig1_type, "orig2_type": orig2_type,
                                                                          "orig1": str(original_value_col1_found)[:50] if original_value_col1_found is not None else None,
                                                                          "orig2": str(original_value_col2_found)[:50] if original_value_col2_found is not None else None})
            # 安全地检查是否为None
            orig1_bool = original_value_col1_found is not None
            orig2_bool = original_value_col2_found is not None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine._add_calculated_columns.orig_bool_check",
                 message="orig bool check", data={"orig1_bool": orig1_bool, "orig2_bool": orig2_bool})
        except Exception as e:
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine._add_calculated_columns.orig_check_error",
                 message="error checking original_value_cols_found", data={"error": str(e), "error_type": type(e).__name__})
        # #endregion
        if original_value_col1_found is not None and original_value_col2_found is not None:
            # 转换为数值
            val1 = merged[original_value_col1_found].apply(self._safe_to_numeric)
            val2 = merged[original_value_col2_found].apply(self._safe_to_numeric)
            
            # 计算变动
            # 检查并处理重复的列名或索引
            if '原值变动' in merged.columns:
                # 如果列已存在，先删除
                merged = merged.drop(columns=['原值变动'])
            
            # 确保索引唯一（如果有重复索引，重置索引）
            if merged.index.duplicated().any():
                merged = merged.reset_index(drop=True)
                val1 = val1.reset_index(drop=True)
                val2 = val2.reset_index(drop=True)
            
            # 对于重复匹配值，第一行的变动 = 文件1所有重复行的总和 - 文件2的总和
            # 第二行及以后的变动列置空
            if dup_keys and left_on:
                # 初始化变动列为单行差值
                merged['原值变动'] = val1 - val2
                
                # 生成组合键用于匹配（与dup_keys的格式一致）
                SEPARATOR_LOCAL = '|||'
                if isinstance(left_on, list):
                    merged['__left_key__'] = merged[left_on].fillna('').astype(str).agg(SEPARATOR_LOCAL.join, axis=1)
                else:
                    merged['__left_key__'] = merged[left_on].fillna('').astype(str)
                
                # 对每个重复匹配值，计算文件1的总和，然后更新第一行的变动
                for dup_key in dup_keys:
                    # 找到所有匹配到该重复值的行
                    mask_dup = merged['__left_key__'] == dup_key
                    if mask_dup.sum() > 1:  # 确实有重复
                        # 计算文件1所有重复行的原值总和
                        val1_sum = val1[mask_dup].sum()
                        # 文件2已经聚合，取第一行的值（所有重复行都是同一个聚合值）
                        val2_agg = val2[mask_dup].iloc[0] if mask_dup.sum() > 0 else 0.0
                        
                        # 第一行的变动 = 文件1总和 - 文件2总和
                        first_idx = merged[mask_dup].index[0]
                        merged.loc[first_idx, '原值变动'] = val1_sum - val2_agg
                        
                        # 第二行及以后的变动列置空
                        if mask_dup.sum() > 1:
                            other_indices = merged[mask_dup].index[1:]
                            merged.loc[other_indices, '原值变动'] = pd.NA
                
                # 删除临时键列
                if '__left_key__' in merged.columns:
                    merged = merged.drop(columns=['__left_key__'])
            else:
                # 非重复匹配值，使用标准计算
                merged['原值变动'] = val1 - val2
            
            # 计算变动类型
            def get_change_type(diff):
                # 确保diff是标量值，不是Series
                if isinstance(diff, pd.Series):
                    # 如果传入的是Series，取第一个值（不应该发生，但为了安全）
                    diff = diff.iloc[0] if len(diff) > 0 else 0.0
                # 检查NaN
                try:
                    is_na = pd.isna(diff)
                    if isinstance(is_na, pd.Series):
                        is_na = is_na.iloc[0] if len(is_na) > 0 else False
                    if is_na:
                        return '原值不变'
                except:
                    pass
                # 比较操作
                # 原值变动 = 文件1(期初) - 文件2(期末)
                # diff > 0 说明期初 > 期末，即原值减少（处置）
                # diff < 0 说明期初 < 期末，即原值增加（新增）
                try:
                    if float(diff) > 0:
                        return '原值减少'  # 期初 > 期末 = 减少
                    elif float(diff) < 0:
                        return '原值增加'  # 期初 < 期末 = 增加
                    else:
                        return '原值不变'
                except (ValueError, TypeError):
                    return '原值不变'
            
            # 检查并处理重复的列名
            if '原值变动类型' in merged.columns:
                merged = merged.drop(columns=['原值变动类型'])
            
            merged['原值变动类型'] = merged['原值变动'].apply(get_change_type)
        
        # 如果用户指定了累计折旧列，使用指定的列；否则自动查找
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="merge_engine._add_calculated_columns.before_dep_check",
             message="before check depreciation_cols", data={"dep1_is_none": depreciation_col1 is None, "dep2_is_none": depreciation_col2 is None})
        # #endregion
        if depreciation_col1 is not None and depreciation_col2 is not None:
            # 查找带后缀的列名
            dep_col1_name = f"{depreciation_col1}_文件1"
            dep_col2_name = f"{depreciation_col2}_文件2"
            if dep_col1_name in merged.columns and dep_col2_name in merged.columns:
                depreciation_col1_found = dep_col1_name
                depreciation_col2_found = dep_col2_name
            else:
                depreciation_col1_found = None
                depreciation_col2_found = None
        else:
            # 自动查找累计折旧相关列
            depreciation_col1_found = None
            depreciation_col2_found = None
            for col in merged.columns:
                col_str = str(col).lower()
                if '_文件1' in str(col) and ('期末累计折旧' in str(col) or '年末累计折旧' in str(col) or '累计折旧' in str(col)):
                    depreciation_col1_found = col
                elif '_文件2' in str(col) and ('期末累计折旧' in str(col) or '年末累计折旧' in str(col) or '累计折旧' in str(col)):
                    depreciation_col2_found = col
        
        # 如果找到累计折旧列，计算变动
        # #region agent log
        try:
            dep1_type = type(depreciation_col1_found).__name__ if depreciation_col1_found is not None else "None"
            dep2_type = type(depreciation_col2_found).__name__ if depreciation_col2_found is not None else "None"
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine._add_calculated_columns.before_dep_check",
                 message="before checking depreciation_cols_found", data={"dep1_type": dep1_type, "dep2_type": dep2_type,
                                                                        "dep1": str(depreciation_col1_found)[:50] if depreciation_col1_found is not None else None,
                                                                        "dep2": str(depreciation_col2_found)[:50] if depreciation_col2_found is not None else None})
            # 安全地检查是否为None
            dep1_bool = depreciation_col1_found is not None
            dep2_bool = depreciation_col2_found is not None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine._add_calculated_columns.dep_bool_check",
                 message="dep bool check", data={"dep1_bool": dep1_bool, "dep2_bool": dep2_bool})
        except Exception as e:
            _dbg(sessionId="debug", runId="run1", hypothesisId="H1", location="merge_engine._add_calculated_columns.dep_check_error",
                 message="error checking depreciation_cols_found", data={"error": str(e), "error_type": type(e).__name__})
        # #endregion
        if depreciation_col1_found is not None and depreciation_col2_found is not None:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.before_dep_calc",
                 message="before dep calculation", data={"dep1_col": depreciation_col1_found, "dep2_col": depreciation_col2_found})
            # #endregion
            # 转换为数值
            try:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.before_dep1_apply",
                     message="before dep1 apply", data={"col_exists": depreciation_col1_found in merged.columns})
                # #endregion
                dep1 = merged[depreciation_col1_found].apply(self._safe_to_numeric)
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.after_dep1_apply",
                     message="after dep1 apply", data={"dep1_type": type(dep1).__name__})
                # #endregion
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.dep1_apply_error",
                     message="error in dep1 apply", data={"error": str(e), "error_type": type(e).__name__})
                # #endregion
                raise
            
            try:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.before_dep2_apply",
                     message="before dep2 apply", data={"col_exists": depreciation_col2_found in merged.columns})
                # #endregion
                dep2 = merged[depreciation_col2_found].apply(self._safe_to_numeric)
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.after_dep2_apply",
                     message="after dep2 apply", data={"dep2_type": type(dep2).__name__})
                # #endregion
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.dep2_apply_error",
                     message="error in dep2 apply", data={"error": str(e), "error_type": type(e).__name__})
                # #endregion
                raise
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.after_dep_convert",
                 message="after dep convert", data={"dep1_type": type(dep1).__name__, "dep2_type": type(dep2).__name__, 
                                                   "dep1_len": len(dep1) if hasattr(dep1, '__len__') else None,
                                                   "dep2_len": len(dep2) if hasattr(dep2, '__len__') else None,
                                                   "merged_cols": list(merged.columns)[:10],
                                                   "merged_cols_duplicates": [col for col in merged.columns if list(merged.columns).count(col) > 1],
                                                   "merged_index_duplicates": merged.index.duplicated().any() if hasattr(merged.index, 'duplicated') else False})
            # #endregion
            
            # 计算变动
            # 检查并处理重复的列名或索引
            if '累计折旧变动' in merged.columns:
                # 如果列已存在，先删除
                merged = merged.drop(columns=['累计折旧变动'])
            
            # 确保索引唯一（如果有重复索引，重置索引）
            if merged.index.duplicated().any():
                merged = merged.reset_index(drop=True)
                dep1 = dep1.reset_index(drop=True)
                dep2 = dep2.reset_index(drop=True)
            
            # 对于重复匹配值，第一行的变动 = 文件1所有重复行的总和 - 文件2的总和
            # 第二行及以后的变动列置空
            if dup_keys and left_on:
                # 初始化变动列为单行差值
                merged['累计折旧变动'] = dep1 - dep2
                
                # 生成组合键用于匹配（与dup_keys的格式一致）
                SEPARATOR_LOCAL = '|||'
                if isinstance(left_on, list):
                    merged['__left_key__'] = merged[left_on].fillna('').astype(str).agg(SEPARATOR_LOCAL.join, axis=1)
                else:
                    merged['__left_key__'] = merged[left_on].fillna('').astype(str)
                
                # 对每个重复匹配值，计算文件1的总和，然后更新第一行的变动
                for dup_key in dup_keys:
                    # 找到所有匹配到该重复值的行
                    mask_dup = merged['__left_key__'] == dup_key
                    if mask_dup.sum() > 1:  # 确实有重复
                        # 计算文件1所有重复行的累计折旧总和
                        dep1_sum = dep1[mask_dup].sum()
                        # 文件2已经聚合，取第一行的值（所有重复行都是同一个聚合值）
                        dep2_agg = dep2[mask_dup].iloc[0] if mask_dup.sum() > 0 else 0.0
                        
                        # 第一行的变动 = 文件1总和 - 文件2总和
                        first_idx = merged[mask_dup].index[0]
                        merged.loc[first_idx, '累计折旧变动'] = dep1_sum - dep2_agg
                        
                        # 第二行及以后的变动列置空
                        if mask_dup.sum() > 1:
                            other_indices = merged[mask_dup].index[1:]
                            merged.loc[other_indices, '累计折旧变动'] = pd.NA
                
                # 删除临时键列
                if '__left_key__' in merged.columns:
                    merged = merged.drop(columns=['__left_key__'])
            else:
                # 非重复匹配值，使用标准计算
                merged['累计折旧变动'] = dep1 - dep2
            
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="merge_engine._add_calculated_columns.after_dep_diff",
                 message="after dep diff", data={"diff_col_type": type(merged['累计折旧变动']).__name__ if '累计折旧变动' in merged.columns else None})
            # #endregion
            
            # 计算变动类型
            def get_dep_change_type(diff):
                # 确保diff是标量值，不是Series
                if isinstance(diff, pd.Series):
                    # 如果传入的是Series，取第一个值（不应该发生，但为了安全）
                    diff = diff.iloc[0] if len(diff) > 0 else 0.0
                # 检查NaN
                try:
                    is_na = pd.isna(diff)
                    if isinstance(is_na, pd.Series):
                        is_na = is_na.iloc[0] if len(is_na) > 0 else False
                    if is_na:
                        return '累计折旧不变'
                except:
                    pass
                # 比较操作
                # 累计折旧变动 = 文件1(期初) - 文件2(期末)
                # diff > 0 说明期初 > 期末，即累计折旧减少
                # diff < 0 说明期初 < 期末，即累计折旧增加
                try:
                    if float(diff) > 0:
                        return '累计折旧减少'  # 期初 > 期末 = 减少
                    elif float(diff) < 0:
                        return '累计折旧增加'  # 期初 < 期末 = 增加
                    else:
                        return '累计折旧不变'
                except (ValueError, TypeError):
                    return '累计折旧不变'
            
            # 检查并处理重复的列名
            if '累计折旧变动类型' in merged.columns:
                merged = merged.drop(columns=['累计折旧变动类型'])
            
            merged['累计折旧变动类型'] = merged['累计折旧变动'].apply(get_dep_change_type)
        
        return merged
    
    def clear(self):
        """清除合并结果"""
        self.merged_result = None
        self.duplicate_checker.clear()
