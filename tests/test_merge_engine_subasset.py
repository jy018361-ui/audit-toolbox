"""
测试 MergeEngine.perform_full_outer_join 针对文件2副卡（right-only dup）场景的修复。

bug 描述：当文件2同一匹配键对应多行（SAP 副卡场景），原实现把整组都标记为
"两文件都有"，并在 pivot 去重时错误地把副卡 #2/#3 的文件2数据置空。

修复后：文件1侧无重复但文件2侧重复时，应当：
- 保留所有副卡行（不聚合）
- 首行展示文件1+文件2字段，数据来源="两文件都有"
- 其余副卡行的文件1字段置空，数据来源改为"仅文件2"
"""
import unittest
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

import pandas as pd  # noqa: E402

from merge_engine import MergeEngine  # noqa: E402


class MergeEngineSubAssetTests(unittest.TestCase):
    """文件2副卡（right-only dup）场景的回归测试。"""

    def _find_col(self, df: pd.DataFrame, base_name: str, suffix: str) -> str:
        """在合并结果中按 '基础列名_文件1' / '基础列名_文件2' 找列名。"""
        target = f"{base_name}_{suffix}"
        if target in df.columns:
            return target
        # 兼容冲突后追加序号的情况，例如 资产描述_文件2_1
        for col in df.columns:
            if str(col).startswith(target):
                return col
        raise AssertionError(f"列 {target} 不存在于合并结果，实际列: {list(df.columns)}")

    def test_file2_subassets_preserved_after_pivot_dedup(self):
        """文件2有副卡（多行同键）时，副卡应作为独立 '仅文件2' 行保留。"""
        df1 = pd.DataFrame({
            '资产编码': ['K1'],
            '资产描述': ['主卡描述'],
            '原值': [1000.0],
        })
        df2 = pd.DataFrame({
            '资产编码': ['K1', 'K1', 'K1'],
            '资产描述': ['副卡A', '副卡B', '副卡C'],
            '原值': [100.0, 200.0, 300.0],
            '次级编号': [1, 2, 3],
        })

        eng = MergeEngine()
        ok, _msg, merged = eng.perform_full_outer_join(
            df1, df2,
            match_columns1=['资产编码'],
            match_columns2=['资产编码'],
            handle_duplicates='pivot',
            original_value_col1='原值',
            original_value_col2='原值',
        )

        self.assertTrue(ok)
        self.assertIsNotNone(merged)

        # 1) 合并输出有 3 行
        k1_rows = merged[merged['匹配列'] == 'K1'].reset_index(drop=True)
        self.assertEqual(len(k1_rows), 3,
                         f"预期 K1 对应 3 行，实际 {len(k1_rows)} 行；列：{list(merged.columns)}")

        # 文件2字段（资产描述_文件2, 原值_文件2, 次级编号_文件2）
        desc2_col = self._find_col(k1_rows, '资产描述', '文件2')
        orig2_col = self._find_col(k1_rows, '原值', '文件2')
        sub_no_col = self._find_col(k1_rows, '次级编号', '文件2')

        # 2) 每一行都保留了不同的文件2数据
        f2_descs = k1_rows[desc2_col].tolist()
        self.assertEqual(sorted(map(str, f2_descs)), ['副卡A', '副卡B', '副卡C'],
                         f"副卡描述未全部保留: {f2_descs}")
        f2_origs = sorted(pd.to_numeric(k1_rows[orig2_col], errors='coerce').dropna().tolist())
        self.assertEqual(f2_origs, [100.0, 200.0, 300.0],
                         f"副卡原值未全部保留: {f2_origs}")
        # 副卡 #2 / #3 的次级编号也都不应缺失
        for i, row in k1_rows.iterrows():
            self.assertFalse(pd.isna(row[sub_no_col]),
                             f"第 {i} 行次级编号被错误置空")

        # 3) 数据来源：首行 '两文件都有'，其余 '仅文件2'
        sources = k1_rows['数据来源'].tolist()
        self.assertEqual(sources[0], '两文件都有',
                         f"首行数据来源应为 '两文件都有'，实际 {sources[0]}")
        for i in range(1, 3):
            self.assertEqual(sources[i], '仅文件2',
                             f"第 {i} 行数据来源应为 '仅文件2'，实际 {sources[i]}")

        # 4) 文件1字段（资产描述_文件1）在 rows 1 和 2 上为 NA
        desc1_col = self._find_col(k1_rows, '资产描述', '文件1')
        self.assertFalse(pd.isna(k1_rows.iloc[0][desc1_col]),
                         f"首行文件1描述不应为 NA，实际 {k1_rows.iloc[0][desc1_col]}")
        self.assertTrue(pd.isna(k1_rows.iloc[1][desc1_col]),
                        f"第 1 行文件1描述应为 NA，实际 {k1_rows.iloc[1][desc1_col]}")
        self.assertTrue(pd.isna(k1_rows.iloc[2][desc1_col]),
                        f"第 2 行文件1描述应为 NA，实际 {k1_rows.iloc[2][desc1_col]}")

    def test_file1_duplicates_paired_by_position(self):
        """回归：文件1有重复但文件2仅 1 行时，cumcount 配对后只有首行配对成功，
        其余文件1行变成 '仅文件1' 行（按位置配对的自然结果）。"""
        df1 = pd.DataFrame({
            '资产编码': ['K1', 'K1', 'K1'],
            '资产描述': ['主卡片1', '主卡片2', '主卡片3'],
            '原值': [100.0, 200.0, 300.0],
        })
        df2 = pd.DataFrame({
            '资产编码': ['K1'],
            '资产描述': ['期末汇总'],
            '原值': [600.0],
        })

        eng = MergeEngine()
        ok, _msg, merged = eng.perform_full_outer_join(
            df1, df2,
            match_columns1=['资产编码'],
            match_columns2=['资产编码'],
            handle_duplicates='pivot',
            original_value_col1='原值',
            original_value_col2='原值',
        )

        self.assertTrue(ok)
        self.assertIsNotNone(merged)

        k1_rows = merged[merged['匹配列'] == 'K1'].reset_index(drop=True)
        self.assertEqual(len(k1_rows), 3, f"预期 3 行，实际 {len(k1_rows)} 行")

        # 首行 '两文件都有'，其余 '仅文件1'（cumcount 配对的自然结果）
        sources = k1_rows['数据来源'].tolist()
        self.assertEqual(sources[0], '两文件都有',
                         f"首行应 '两文件都有'，实际 {sources[0]}")
        for i in range(1, 3):
            self.assertEqual(sources[i], '仅文件1',
                             f"第 {i} 行应 '仅文件1'，实际 {sources[i]}")

        # 文件1字段：所有 3 行都应有值且各不相同（不被聚合也不被置空）
        desc1_col = self._find_col(k1_rows, '资产描述', '文件1')
        orig1_col = self._find_col(k1_rows, '原值', '文件1')
        f1_descs = k1_rows[desc1_col].tolist()
        self.assertEqual(sorted(map(str, f1_descs)), ['主卡片1', '主卡片2', '主卡片3'],
                         f"文件1描述未全部保留: {f1_descs}")
        f1_origs = sorted(pd.to_numeric(k1_rows[orig1_col], errors='coerce').dropna().tolist())
        self.assertEqual(f1_origs, [100.0, 200.0, 300.0],
                         f"文件1原值未全部保留: {f1_origs}")

        # 文件2字段：仅首行有值，其余行因没有配对到右侧而为 NA
        desc2_col = self._find_col(k1_rows, '资产描述', '文件2')
        orig2_col = self._find_col(k1_rows, '原值', '文件2')

        self.assertFalse(pd.isna(k1_rows.iloc[0][desc2_col]),
                         f"首行文件2描述不应为 NA，实际 {k1_rows.iloc[0][desc2_col]}")
        for i in range(1, 3):
            self.assertTrue(pd.isna(k1_rows.iloc[i][desc2_col]),
                            f"第 {i} 行文件2描述应为 NA，实际 {k1_rows.iloc[i][desc2_col]}")
            self.assertTrue(pd.isna(k1_rows.iloc[i][orig2_col]),
                            f"第 {i} 行文件2原值应为 NA，实际 {k1_rows.iloc[i][orig2_col]}")

    def test_both_side_duplicates_paired_by_position(self):
        """两侧都有重复时按位置配对：N 行 file1 + M 行 file2 → max(N,M) 行输出。
        前 min(N,M) 行 '两文件都有'，多出的部分为 '仅文件1' 或 '仅文件2'。"""
        df1 = pd.DataFrame({
            '资产编码': ['K1', 'K1', 'K1'],
            '资产描述': ['主卡1', '主卡2', '主卡3'],
            '原值': [10.0, 20.0, 30.0],
        })
        df2 = pd.DataFrame({
            '资产编码': ['K1', 'K1', 'K1', 'K1', 'K1'],
            '资产描述': ['期末A', '期末B', '期末C', '期末D', '期末E'],
            '原值': [11.0, 22.0, 33.0, 44.0, 55.0],
            '资产类型描述': ['机器设备', '电子设备', '运输工具', '其他设备', '办公家具'],
        })

        eng = MergeEngine()
        ok, _msg, merged = eng.perform_full_outer_join(
            df1, df2,
            match_columns1=['资产编码'],
            match_columns2=['资产编码'],
            handle_duplicates='pivot',
            original_value_col1='原值',
            original_value_col2='原值',
        )

        self.assertTrue(ok)
        self.assertIsNotNone(merged)

        k1_rows = merged[merged['匹配列'] == 'K1'].reset_index(drop=True)
        # 5 行：3 行 '两文件都有' + 2 行 '仅文件2'
        self.assertEqual(len(k1_rows), 5,
                         f"预期 5 行（max(3,5)），实际 {len(k1_rows)} 行")

        sources = k1_rows['数据来源'].tolist()
        sources_sorted = sorted(sources)
        self.assertEqual(sources_sorted, ['两文件都有', '两文件都有', '两文件都有',
                                          '仅文件2', '仅文件2'],
                         f"数据来源分布异常: {sources}")

        # 关键：文件2 5 行的 资产类型描述 应当全部保留（不能被聚合 first() 掉）
        cat2_col = self._find_col(k1_rows, '资产类型描述', '文件2')
        cats = k1_rows[cat2_col].tolist()
        self.assertEqual(sorted(map(str, cats)),
                         sorted(['机器设备', '电子设备', '运输工具', '其他设备', '办公家具']),
                         f"文件2 资产类型描述未全部保留: {cats}")

        # 文件2 原值 5 行各不相同
        orig2_col = self._find_col(k1_rows, '原值', '文件2')
        f2_origs = sorted(pd.to_numeric(k1_rows[orig2_col], errors='coerce').dropna().tolist())
        self.assertEqual(f2_origs, [11.0, 22.0, 33.0, 44.0, 55.0],
                         f"文件2 原值未全部保留: {f2_origs}")

        # 文件1 字段在前 3 行有值，后 2 行 NA
        desc1_col = self._find_col(k1_rows, '资产描述', '文件1')
        f1_present = [(i, k1_rows.iloc[i][desc1_col]) for i in range(5)]
        not_na_count = sum(1 for _, v in f1_present if not pd.isna(v))
        self.assertEqual(not_na_count, 3,
                         f"文件1描述应在 3 行有值，实际 {not_na_count} 行；详细 {f1_present}")

    def test_no_duplicates_baseline(self):
        """基线：两侧无重复时 1:1 合并，数据来源标记正确，所有字段都不被置空。"""
        df1 = pd.DataFrame({
            '资产编码': ['A1', 'A2'],
            '资产描述': ['主卡A1', '主卡A2'],
            '原值': [100.0, 200.0],
        })
        df2 = pd.DataFrame({
            '资产编码': ['A1', 'A3'],
            '资产描述': ['期末A1', '期末A3'],
            '原值': [100.0, 300.0],
        })

        eng = MergeEngine()
        ok, _msg, merged = eng.perform_full_outer_join(
            df1, df2,
            match_columns1=['资产编码'],
            match_columns2=['资产编码'],
            handle_duplicates='pivot',
            original_value_col1='原值',
            original_value_col2='原值',
        )

        self.assertTrue(ok)
        self.assertIsNotNone(merged)

        # 应当只有 3 行（A1 两文件都有, A2 仅文件1, A3 仅文件2）
        self.assertEqual(len(merged), 3, f"预期 3 行，实际 {len(merged)} 行")

        # 数据来源只能是 '两文件都有' / '仅文件1' / '仅文件2'
        sources = set(merged['数据来源'].dropna().tolist())
        self.assertTrue(sources.issubset({'两文件都有', '仅文件1', '仅文件2'}),
                        f"出现未预期的数据来源：{sources}")

        desc1_col = self._find_col(merged, '资产描述', '文件1')
        desc2_col = self._find_col(merged, '资产描述', '文件2')

        # A1 行: 两文件都有，两侧字段都不为 NA
        a1_rows = merged[merged['匹配列'] == 'A1']
        self.assertEqual(len(a1_rows), 1)
        self.assertEqual(a1_rows.iloc[0]['数据来源'], '两文件都有')
        self.assertFalse(pd.isna(a1_rows.iloc[0][desc1_col]))
        self.assertFalse(pd.isna(a1_rows.iloc[0][desc2_col]))

        # A2 行: 仅文件1，文件1字段不为 NA，文件2字段应为 NA
        a2_rows = merged[merged['匹配列'] == 'A2']
        self.assertEqual(len(a2_rows), 1)
        self.assertEqual(a2_rows.iloc[0]['数据来源'], '仅文件1')
        self.assertFalse(pd.isna(a2_rows.iloc[0][desc1_col]))
        self.assertTrue(pd.isna(a2_rows.iloc[0][desc2_col]))

        # A3 行: 仅文件2，文件2字段不为 NA，文件1字段应为 NA
        a3_rows = merged[merged['匹配列'] == 'A3']
        self.assertEqual(len(a3_rows), 1)
        self.assertEqual(a3_rows.iloc[0]['数据来源'], '仅文件2')
        self.assertTrue(pd.isna(a3_rows.iloc[0][desc1_col]))
        self.assertFalse(pd.isna(a3_rows.iloc[0][desc2_col]))


if __name__ == '__main__':
    unittest.main()
