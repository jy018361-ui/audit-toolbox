"""LLM-assisted analysis for exported audit workbooks."""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any

import pandas as pd

from launcher.llm_client import LLMClientError, generate_suite_analysis
from launcher.llm_settings import is_llm_enabled, load_llm_settings


MAX_ROWS_PER_TABLE = 8
MAX_TEXT_LEN = 120


def append_fa_list_analysis_sheet(
    writer,
    used_sheet_names: set[str],
    *,
    summary_config: dict[str, Any] | None,
    tables: dict[str, pd.DataFrame | None],
) -> tuple[bool, str]:
    if not is_llm_enabled():
        return False, "LLM 未启用，未生成 LLM分析。"
    try:
        payload = _build_fa_payload(summary_config or {}, tables)
        try:
            generated = generate_suite_analysis(load_llm_settings(), tool_name="FA List", payload=payload)
        except Exception:
            generated = {}
        analysis = _build_fa_rule_based_analysis(payload, generated)
        sheet_name = _reserve_sheet_name("LLM分析", used_sheet_names)
        _write_analysis_sheet(writer, sheet_name, analysis)
        return True, f"已生成 {sheet_name}。"
    except Exception as exc:
        return False, f"LLM分析生成失败：{exc}"


def build_fa_list_analysis(
    *,
    summary_config: dict[str, Any] | None,
    tables: dict[str, pd.DataFrame | None],
) -> tuple[bool, str, dict[str, Any] | None]:
    if not is_llm_enabled():
        return False, "LLM 未启用，未生成 LLM分析。", None
    try:
        payload = _build_fa_payload(summary_config or {}, tables)
        try:
            generated = generate_suite_analysis(load_llm_settings(), tool_name="FA List", payload=payload)
        except Exception:
            generated = {}
        return True, "已提前生成 LLM分析。", _build_fa_rule_based_analysis(payload, generated)
    except Exception as exc:
        return False, f"LLM分析生成失败：{exc}", None


def write_fa_list_analysis_sheet(
    writer,
    used_sheet_names: set[str],
    analysis: dict[str, Any] | None,
) -> tuple[bool, str]:
    if not analysis:
        return False, "LLM分析为空，未生成 LLM分析。"
    try:
        sheet_name = _reserve_sheet_name("LLM分析", used_sheet_names)
        _write_analysis_sheet(writer, sheet_name, analysis)
        return True, f"已生成 {sheet_name}。"
    except Exception as exc:
        return False, f"LLM分析写入失败：{exc}"


def append_kanzhang_analysis_sheet(
    writer,
    *,
    voucher_pivot: pd.DataFrame | None = None,
    voucher_type_df: pd.DataFrame | None = None,
    voucher_type_strict_df: pd.DataFrame | None = None,
    pivot_res: pd.DataFrame | None = None,
    target_accounts: list[str] | None = None,
) -> tuple[bool, str]:
    if not is_llm_enabled():
        return False, "LLM 未启用，未生成 LLM分析。"
    try:
        accounts = _normalize_sequence(target_accounts)
        payload = _build_kanzhang_payload(
            voucher_pivot=voucher_pivot,
            voucher_type_df=voucher_type_df,
            voucher_type_strict_df=voucher_type_strict_df,
            pivot_res=pivot_res,
            target_accounts=accounts,
        )
        analysis = generate_suite_analysis(load_llm_settings(), tool_name="看账工具", payload=payload)
        _write_analysis_sheet(writer, "LLM分析", analysis)
        return True, "已生成 LLM分析。"
    except Exception as exc:
        return False, f"LLM分析生成失败：{exc}"


def _build_fa_payload(summary_config: dict[str, Any], tables: dict[str, pd.DataFrame | None]) -> dict[str, Any]:
    balance_date = _parse_date(summary_config.get("balance_sheet_date"))
    if balance_date is None:
        balance_date = datetime(datetime.now().year, 12, 31)
    period_start = datetime(balance_date.year, 1, 1)
    period_end = balance_date

    fa_df = _safe_df(tables.get("FA List"))
    add_df = _safe_df(tables.get("新增清单_BKD"))
    disp_df = _safe_df(tables.get("处置清单_BKD"))
    dep_df = _safe_df(tables.get("折旧期间"))
    summary_df = _safe_df(tables.get("固定资产变动汇总表"))

    return {
        "requested_scope": [
            "总体性概述",
            "资产增加减少大额示例",
            "异常资产及新增/处置清单复核",
        ],
        "excluded_scope": [
            "不要输出折旧测算解释",
            "不要输出原值变动、累计折旧变动、提足仍折旧三个独立分析段",
            "不要输出抽凭、查验合同、查看验收单等审计程序建议",
            "不要做其他泛化资产分析",
        ],
        "period": {
            "basis": "balance_sheet_date_year",
            "start": period_start.strftime("%Y-%m-%d"),
            "end": period_end.strftime("%Y-%m-%d"),
        },
        "tables": {
            name: _table_profile(df)
            for name, df in {
                "固定资产变动汇总表": summary_df,
                "FA List": fa_df,
                "新增清单_BKD": add_df,
                "处置清单_BKD": disp_df,
                "折旧期间": dep_df,
            }.items()
            if df is not None
        },
        "candidates": {
            "入账日期不属于当期": _entry_date_outside_period(add_df, fa_df, period_start, period_end),
            "净值为负": _negative_net_value(fa_df, add_df, disp_df),
            "处置日期早于预计使用年限50%": _early_disposal(disp_df),
            "已提足折旧但仍计提折旧": _fully_depreciated_with_current_dep(fa_df),
            "资产名称疑似应费用化": _expense_like_assets(fa_df),
            "大额新增资产": _large_amount_assets(add_df, ("原值增加", "增加金额", "原值"), amount_label="原值增加"),
            "大额减少资产": _large_amount_assets(disp_df, ("原值减少", "减少金额", "原值"), amount_label="原值减少"),
        },
        "overall_movement": _fa_overall_movement(summary_df),
        "analysis_rules": [
            "总体性概述必须先描述原值和累计折旧的总体变化金额及比例。",
            "随后用大额新增资产和大额减少资产举例说明由哪类资产、哪些资产导致。",
            "新增日期异常和疑似费用化必须明确写存在或未发现，不要只提示用户防范。",
            "不要输出折旧测算解释、原值变动、累计折旧变动、提足仍折旧独立段落。",
        ],
    }


def _build_fa_rule_based_analysis(payload: dict[str, Any], generated: dict[str, Any] | None = None) -> dict[str, Any]:
    movement = payload.get("overall_movement") or {}
    candidates = payload.get("candidates") or {}
    overall = _format_overall_movement(movement)
    add_examples = _format_asset_examples(candidates.get("大额新增资产") or [], amount_label="原值增加")
    disp_examples = _format_asset_examples(candidates.get("大额减少资产") or [], amount_label="原值减少")

    date_items = candidates.get("入账日期不属于当期") or []
    expense_items = candidates.get("资产名称疑似应费用化") or []
    date_text = (
        f"存在新增日期异常：发现{len(date_items)}项示例资产入账日期不属于当期，示例包括：{_format_asset_examples(date_items, amount_label='金额')}。"
        if date_items
        else "未发现新增清单或 FA List 中存在入账日期不属于当期的示例资产。"
    )
    expense_text = (
        f"存在疑似费用化项目：发现{len(expense_items)}项示例资产名称含维修、更换、配件、低值、耗材等关键词，示例包括：{_format_asset_examples(expense_items, amount_label='金额')}。"
        if expense_items
        else "未发现资产名称明显含维修、更换、配件、低值、耗材等疑似费用化关键词的示例项目。"
    )

    return {
        "title": (generated or {}).get("title") or "固定资产套表分析辅助说明",
        "sections": [
            {"heading": "总体概述", "points": [{"label": "总体概述", "text": overall}]},
            {"heading": "大额变动示例", "points": [
                {"label": "大额变动示例", "text": f"资产增加的大额示例：{add_examples}。"},
                {"label": "大额变动示例", "text": f"资产减少的大额示例：{disp_examples}。"},
            ]},
            {"heading": "新增日期异常", "points": [{"label": "新增日期异常", "text": date_text}]},
            {"heading": "疑似费用化", "points": [{"label": "疑似费用化", "text": expense_text}]},
        ],
        "review_notes": ["LLM 输出为辅助说明，需结合原始卡片、台账、凭证和管理层解释人工复核。"],
    }


def _format_overall_movement(movement: dict[str, Any]) -> str:
    if not movement:
        return "未取得固定资产变动汇总表的结构化金额，无法生成总体金额及比例概述。"
    parts = []
    if "original_begin" in movement:
        parts.append(
            f"原值由期初{_fmt_amount(movement.get('original_begin'))}变为期末{_fmt_amount(movement.get('original_end'))}，"
            f"净变动{_fmt_amount(movement.get('original_delta'))}，变动比例{_fmt_percent(movement.get('original_ratio'))}"
        )
    if "depreciation_begin" in movement:
        parts.append(
            f"累计折旧由期初{_fmt_amount(movement.get('depreciation_begin'))}变为期末{_fmt_amount(movement.get('depreciation_end'))}，"
            f"净变动{_fmt_amount(movement.get('depreciation_delta'))}，变动比例{_fmt_percent(movement.get('depreciation_ratio'))}"
        )
    text = "；".join(parts) + "。"
    major = movement.get("major_categories") or []
    if major:
        text += "其中主要类别变动包括：" + "；".join(
            f"{item.get('category')} {item.get('metric')} {_fmt_amount(item.get('amount'))}"
            for item in major[:3]
        ) + "。"
    return text


def _fmt_amount(value: Any) -> str:
    try:
        return f"{float(value):,.2f}元"
    except Exception:
        return "无法取得"


def _fmt_percent(value: Any) -> str:
    try:
        return f"{float(value) * 100:.2f}%"
    except Exception:
        return "不适用"


def _format_asset_examples(items: list[dict[str, Any]], *, amount_label: str) -> str:
    if not items:
        return "未见可列示的大额明细"
    parts = []
    for item in items[:3]:
        category = item.get("资产类别") or item.get("类别") or item.get("source_sheet") or "未分类"
        code = item.get("固定资产编号") or item.get("资产编码") or item.get("编号") or "无编号"
        name = item.get("固定资产名称") or item.get("资产名称") or item.get("名称") or "未命名资产"
        amount = item.get("amount") or item.get("原值增加") or item.get("原值减少") or item.get("原值") or item.get("金额")
        amount_text = _fmt_amount(amount) if amount is not None else "金额未列示"
        parts.append(f"{category}：{name}（{code}，{amount_label}{amount_text}）")
    return "；".join(parts)


def _fa_overall_movement(summary_df: pd.DataFrame | None) -> dict[str, Any]:
    df = _safe_df(summary_df)
    if df is None or df.empty:
        return {}
    category_cols = [c for c in df.columns if str(c) not in {"大类", "项目"}]
    if not category_cols:
        return {}
    section_col = "大类" if "大类" in df.columns else None
    if section_col:
        sections = df[section_col].replace("", pd.NA).ffill().astype(str)
    else:
        sections = pd.Series([""] * len(df), index=df.index)
    original_idx = [i for i, s in sections.items() if "原值" in s]
    dep_idx = [i for i, s in sections.items() if "累计折旧" in s]

    def row_total(idx: int) -> float:
        return float(_to_number(df.loc[idx, category_cols]).fillna(0).sum())

    result: dict[str, Any] = {}
    if original_idx:
        begin_idx, end_idx = original_idx[0], original_idx[-1]
        begin, end = row_total(begin_idx), row_total(end_idx)
        result.update({
            "original_begin": round(begin, 2),
            "original_end": round(end, 2),
            "original_delta": round(end - begin, 2),
            "original_ratio": None if abs(begin) < 0.01 else round((end - begin) / begin, 6),
        })
    if dep_idx:
        begin_idx, end_idx = dep_idx[0], dep_idx[-1]
        begin, end = row_total(begin_idx), row_total(end_idx)
        result.update({
            "depreciation_begin": round(begin, 2),
            "depreciation_end": round(end, 2),
            "depreciation_delta": round(end - begin, 2),
            "depreciation_ratio": None if abs(begin) < 0.01 else round((end - begin) / begin, 6),
        })
    result["major_categories"] = _fa_major_category_movements(df, category_cols, sections)
    return result


def _fa_major_category_movements(df: pd.DataFrame, category_cols: list[Any], sections: pd.Series) -> list[dict[str, Any]]:
    items = []
    for label, metric in (("原值", "原值净变化"), ("累计折旧", "累计折旧净变化")):
        idx = [i for i, s in sections.items() if label in s]
        if not idx:
            continue
        begin = _to_number(df.loc[idx[0], category_cols]).fillna(0)
        end = _to_number(df.loc[idx[-1], category_cols]).fillna(0)
        delta = end - begin
        for category, amount in delta.items():
            amount = float(amount)
            if abs(amount) > 0.01:
                items.append({"metric": metric, "category": str(category), "amount": round(amount, 2), "abs_amount": abs(amount)})
    items.sort(key=lambda x: x["abs_amount"], reverse=True)
    return items[:6]


def _large_amount_assets(df: pd.DataFrame | None, amount_keywords: tuple[str, ...], *, amount_label: str) -> list[dict[str, Any]]:
    df = _safe_df(df)
    if df is None or df.empty:
        return []
    amount_col = _find_col(df, amount_keywords)
    if not amount_col:
        return []
    work = df.copy()
    work["_amount__"] = _to_number(work[amount_col]).fillna(0).abs()
    work = work.sort_values("_amount__", ascending=False).head(MAX_ROWS_PER_TABLE)
    rows = _records(work, extra_cols=[amount_col])
    for row in rows:
        row["amount"] = row.get(amount_col)
        row["amount_label"] = amount_label
    return rows


def _build_kanzhang_payload(
    *,
    voucher_pivot: pd.DataFrame | None,
    voucher_type_df: pd.DataFrame | None,
    voucher_type_strict_df: pd.DataFrame | None,
    pivot_res: pd.DataFrame | None,
    target_accounts: list[str],
) -> dict[str, Any]:
    voucher_df = _safe_df(voucher_pivot)
    type_loose_df = _safe_df(voucher_type_df)
    type_strict_df = _safe_df(voucher_type_strict_df)
    pivot_df = _safe_df(_flatten_df(pivot_res) if pivot_res is not None else None)
    target_resolution = _resolve_kanzhang_target_accounts(
        type_loose_df,
        type_strict_df,
        target_accounts,
    )
    resolved_target_accounts = target_resolution.get("accounts") or []
    return {
        "requested_scope": [
            "科目发生额概览",
            "对方科目与凭证类型合并分析",
            "透视分析月度波动趋势分析",
        ],
        "excluded_scope": [
            "不要做凭证摘要语义归类",
            "不要做借贷逻辑或方案复核",
            "不要生成额外抽样建议或审计程序建议",
        ],
        "target_accounts": resolved_target_accounts[:30],
        "target_account_resolution": target_resolution,
        "tables": {
            name: _table_profile(df, include_samples=name not in {"凭证类型-宽松", "凭证类型-严格"})
            for name, df in {
                "凭证": voucher_df,
                "凭证类型-宽松": type_loose_df,
                "凭证类型-严格": type_strict_df,
                "透视分析": pivot_df,
            }.items()
            if df is not None
        },
        "candidates": {
            "科目发生额概览": _kanzhang_occurrence_overview(
                type_loose_df,
                type_strict_df,
                resolved_target_accounts,
            ),
            "对方科目与凭证类型合并分析": _kanzhang_counterparty_candidates(
                type_loose_df,
                type_strict_df,
                resolved_target_accounts,
            ),
            "透视分析月度波动趋势分析": _kanzhang_monthly_trends(pivot_df),
        },
        "analysis_rules": [
            "科目发生额概览中的借方发生额、贷方发生额、净额必须引用 candidates.科目发生额概览 的全量目标科目金额，不得用Top 80%分析范围金额替代。",
            "对方科目与凭证类型合并分析输入为结构化 JSON，LLM 只能解释 candidates 中已列出的借方/贷方主要对方科目。",
            "目标科目默认只分析按金额绝对值累计覆盖前80%的科目，以减少小额混合凭证误判。",
            "优先使用凭证类型-严格；仅当严格口径无高可信数据时，才参考凭证类型-宽松。",
            "只说明目标科目借方发生额的主要对方科目及金额、目标科目贷方发生额的主要对方科目及金额；累计覆盖80%即可。",
            "不要输出单独的对方科目组合章节，不要逐条列编号。",
            "如引用凭证号或唯一识别码，必须完整复制结构化数据中的完整文本，不得省略或简写。",
            "月度波动趋势仅基于透视分析中累计覆盖金额80%的TOP项目；未进入items的其他项目不分析。",
        ],
    }


def _resolve_kanzhang_target_accounts(
    loose_df: pd.DataFrame | None,
    strict_df: pd.DataFrame | None,
    target_accounts: list[str],
) -> dict[str, Any]:
    explicit = _unique_clean_texts(target_accounts)
    diagnostics: dict[str, Any] = {
        "input_target_count": len(explicit),
        "voucher_type_sources": [],
    }
    if explicit:
        return {
            "source": "provided_target_accounts",
            "accounts": explicit,
            "diagnostics": diagnostics,
        }

    inferred: list[str] = []
    for source_name, df in (("凭证类型-严格", strict_df), ("凭证类型-宽松", loose_df)):
        df = _safe_df(df)
        if df is None or df.empty:
            diagnostics["voucher_type_sources"].append({
                "source": source_name,
                "rows": 0,
                "columns": [],
                "target_column": "",
                "inferred_count": 0,
            })
            continue
        accounts, source_diag = _infer_targets_from_voucher_type_df(df)
        source_diag["source"] = source_name
        diagnostics["voucher_type_sources"].append(source_diag)
        inferred.extend(accounts)
        if accounts:
            break

    accounts = _unique_clean_texts(inferred)
    return {
        "source": "inferred_from_voucher_type_table" if accounts else "unresolved",
        "accounts": accounts,
        "diagnostics": diagnostics,
        "warning": "" if accounts else "未传入目标科目，且未能从凭证类型表列名或数据中推断目标科目范围。",
    }


def _infer_targets_from_voucher_type_df(df: pd.DataFrame) -> tuple[list[str], dict[str, Any]]:
    target_col = _find_target_label_col(df)
    accounts: list[str] = []
    if target_col:
        for value in df[target_col].dropna().astype(str).drop_duplicates().tolist():
            accounts.extend(_extract_accounts_from_target_label(value))
    diag = {
        "rows": int(len(df)),
        "columns": [str(c) for c in df.columns[:20]],
        "target_column": str(target_col or ""),
        "inferred_count": len(_unique_clean_texts(accounts)),
        "sample_inferred_accounts": _unique_clean_texts(accounts)[:10],
    }
    return accounts, diag


def _find_target_label_col(df: pd.DataFrame) -> str | None:
    for keywords in (("目标科目",), ("目标",), ("科目名称-类型",), ("科目名称",)):
        col = _find_col(df, keywords)
        if col:
            return col
    return None


def _extract_accounts_from_target_label(value: Any) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return []
    parts = re.split(r"\s*\|\s*", text)
    accounts = []
    for part in parts:
        item = re.sub(r"-?类型\s*\d+\s*$", "", part.strip())
        item = re.sub(r"\s+", " ", item).strip(" -")
        if item:
            accounts.append(item)
    return accounts


def _unique_clean_texts(values: Any) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in _normalize_sequence(values):
        text = str(value or "").strip()
        if not text:
            continue
        norm = _norm_text(text)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        out.append(text)
    return out


def _kanzhang_occurrence_overview(
    loose_df: pd.DataFrame | None,
    strict_df: pd.DataFrame | None,
    target_accounts: list[str],
) -> dict[str, Any]:
    target_norm = {_norm_text(x) for x in target_accounts if str(x).strip()}
    if not target_norm:
        return {
            "source": "",
            "accounts": [],
            "diagnostics": {
                "reason": "target_accounts_empty",
                "message": "未取得目标科目范围，无法计算科目发生额概览。",
            },
        }
    diagnostics = []
    for source_name, df in (("凭证类型-严格", strict_df), ("凭证类型-宽松", loose_df)):
        df = _safe_df(df)
        if df is None or df.empty:
            diagnostics.append({"source": source_name, "reason": "empty_table"})
            continue
        acc_col = _find_account_col(df)
        amount_col = _find_col(df, ("#_净额(Net)", "净额", "金额", "发生额"))
        if not acc_col or not amount_col:
            diagnostics.append({
                "source": source_name,
                "reason": "missing_columns",
                "account_column": str(acc_col or ""),
                "amount_column": str(amount_col or ""),
                "columns": [str(c) for c in df.columns[:20]],
            })
            continue
        signed_amount = _to_number(df[amount_col]).fillna(0)
        acc_norm = df[acc_col].map(_norm_text)
        target_mask = acc_norm.isin(target_norm)
        if not target_mask.any():
            diagnostics.append({
                "source": source_name,
                "reason": "no_target_rows_matched",
                "account_column": str(acc_col),
                "amount_column": str(amount_col),
                "target_count": len(target_norm),
                "sample_accounts": _unique_clean_texts(df[acc_col].dropna().astype(str).head(20).tolist())[:10],
            })
            continue
        work = df.loc[target_mask, [acc_col]].copy()
        work["_amount__"] = signed_amount.loc[target_mask]
        rows = []
        for acc, sub in work.groupby(acc_col, dropna=False, sort=False):
            amt = sub["_amount__"]
            debit = float(amt[amt > 0].sum())
            credit = float((-amt[amt < 0]).sum())
            net = float(amt.sum())
            rows.append({
                "account": _clean_value(acc),
                "debit_amount": round(debit, 2),
                "credit_amount": round(credit, 2),
                "net_amount": round(net, 2),
                "abs_amount": round(abs(debit) + abs(credit), 2),
            })
        rows.sort(key=lambda x: float(x.get("abs_amount") or 0), reverse=True)
        return {
            "source": source_name,
            "scope": "全部已筛选目标科目，不限Top 80%",
            "total_debit_amount": round(sum(float(x["debit_amount"]) for x in rows), 2),
            "total_credit_amount": round(sum(float(x["credit_amount"]) for x in rows), 2),
            "total_net_amount": round(sum(float(x["net_amount"]) for x in rows), 2),
            "accounts": rows[:30],
        }
    return {
        "source": "",
        "accounts": [],
        "diagnostics": {
            "reason": "no_occurrence_overview_built",
            "checks": diagnostics,
        },
    }



def _normalize_sequence(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (set, tuple, list)):
        return list(value)
    try:
        return list(value)
    except TypeError:
        return [value]


def _write_analysis_sheet(writer, sheet_name: str, analysis: dict[str, Any]) -> None:
    wb = writer.book
    ws = wb.add_worksheet(sheet_name)
    writer.sheets[sheet_name] = ws
    title_fmt = wb.add_format({"bold": True, "font_size": 14, "font_color": "#205860"})
    heading_fmt = wb.add_format({"bold": True, "font_color": "#205860", "bg_color": "#E6DDCF"})
    text_fmt = wb.add_format({"text_wrap": True, "valign": "top"})
    note_fmt = wb.add_format({"text_wrap": True, "valign": "top", "font_color": "#9B5D33"})
    ws.set_column(0, 0, 24)
    ws.set_column(1, 1, 64)
    row = 0
    ws.write(row, 0, analysis.get("title") or "LLM分析", title_fmt)
    row += 2
    for section in analysis.get("sections", []):
        ws.write(row, 0, section.get("heading") or "", heading_fmt)
        row += 1
        for point in section.get("points", []):
            if isinstance(point, dict):
                label = point.get("label") or section.get("heading") or "分析"
                text = point.get("text") or ""
            else:
                label = section.get("row_label") or section.get("heading") or "分析"
                text = point
            ws.write(row, 0, label, text_fmt)
            ws.write(row, 1, text, text_fmt)
            row += 1
        row += 1
    notes = analysis.get("review_notes") or ["LLM 输出为辅助说明，需结合原始数据人工复核。"]
    ws.write(row, 0, "人工复核提示", heading_fmt)
    row += 1
    for note in notes:
        ws.write(row, 1, note, note_fmt)
        row += 1


def _table_profile(df: pd.DataFrame, *, include_samples: bool = True) -> dict[str, Any]:
    df = _safe_df(df)
    if df is None:
        return {}
    profile = {
        "rows": int(len(df)),
        "columns": [str(c) for c in df.columns[:40]],
        "numeric_totals": _numeric_totals(df),
        "sample_rows": _records(df.head(MAX_ROWS_PER_TABLE)) if include_samples else [],
    }
    return profile


def _numeric_totals(df: pd.DataFrame) -> dict[str, float]:
    totals: dict[str, float] = {}
    keywords = ("原值", "累计折旧", "净值", "折旧", "金额", "影响", "借方", "贷方", "净额", "发生额")
    for col in df.columns:
        name = str(col)
        if not any(kw in name for kw in keywords):
            continue
        series = _to_number(df[col])
        if series.notna().any():
            total = float(series.fillna(0).sum())
            if math.isfinite(total):
                totals[name[:60]] = round(total, 2)
    return dict(list(totals.items())[:20])


def _entry_date_outside_period(add_df: pd.DataFrame | None, fa_df: pd.DataFrame | None, start: datetime, end: datetime) -> list[dict[str, Any]]:
    rows = []
    for sheet_name, df in (("新增清单_BKD", add_df), ("FA List", fa_df)):
        if df is None or df.empty:
            continue
        date_col = _find_col(df, ("入账开始日期", "入账日期", "新增时间", "增加日期"))
        if not date_col:
            continue
        dates = _to_datetime(df[date_col])
        mask = dates.notna() & ((dates < start) | (dates > end))
        rows.extend(_records(df.loc[mask].head(MAX_ROWS_PER_TABLE), source_sheet=sheet_name, extra_cols=[date_col]))
    return rows[:MAX_ROWS_PER_TABLE]


def _negative_net_value(*dfs: pd.DataFrame | None) -> list[dict[str, Any]]:
    rows = []
    for df in dfs:
        if df is None or df.empty:
            continue
        net_col = _find_col(df, ("净值", "账面价值"))
        if not net_col:
            continue
        mask = _to_number(df[net_col]) < 0
        rows.extend(_records(df.loc[mask].head(MAX_ROWS_PER_TABLE), extra_cols=[net_col]))
    return rows[:MAX_ROWS_PER_TABLE]


def _early_disposal(df: pd.DataFrame | None) -> list[dict[str, Any]]:
    if df is None or df.empty:
        return []
    entry_col = _find_col(df, ("入账开始日期", "入账日期"))
    disposal_col = _find_col(df, ("处置时间", "处置日期", "减少日期"))
    life_col = _find_col(df, ("使用寿命(月)", "使用寿命", "预计使用年限"))
    if not entry_col or not disposal_col or not life_col:
        return []
    entry = _to_datetime(df[entry_col])
    disposal = _to_datetime(df[disposal_col])
    life_months = _to_life_months(df[life_col])
    age_days = (disposal - entry).dt.days
    threshold_days = life_months * 30.4375 * 0.5
    mask = entry.notna() & disposal.notna() & life_months.notna() & (age_days >= 0) & (age_days < threshold_days)
    return _records(df.loc[mask].head(MAX_ROWS_PER_TABLE), source_sheet="处置清单_BKD", extra_cols=[entry_col, disposal_col, life_col])


def _fully_depreciated_with_current_dep(df: pd.DataFrame | None) -> list[dict[str, Any]]:
    if df is None or df.empty:
        return []
    full_col = _find_col(df, ("已提足折旧",))
    current_dep_col = _find_col(df, ("本年折旧", "本期折旧", "年折旧额"))
    if not full_col or not current_dep_col:
        return []
    full = df[full_col].astype(str).str.contains("是|已提足|true|TRUE", regex=True, na=False)
    current = _to_number(df[current_dep_col]).fillna(0).abs()
    mask = full & (current > 0.01)
    return _records(df.loc[mask].head(MAX_ROWS_PER_TABLE), source_sheet="FA List", extra_cols=[full_col, current_dep_col])


def _expense_like_assets(df: pd.DataFrame | None) -> list[dict[str, Any]]:
    if df is None or df.empty:
        return []
    name_col = _find_col(df, ("固定资产名称", "资产名称", "名称"))
    if not name_col:
        return []
    pattern = r"办公用品|耗材|硒鼓|墨盒|键盘|鼠标|U盘|移动硬盘|配件|维修|维护|低值|低耗|工装|电话卡|礼品|清洁|安装费|服务费|软件许可"
    mask = df[name_col].astype(str).str.contains(pattern, regex=True, na=False)
    return _records(df.loc[mask].head(MAX_ROWS_PER_TABLE), source_sheet="FA List", extra_cols=[name_col])


def _kanzhang_counterparty_candidates(
    loose_df: pd.DataFrame | None,
    strict_df: pd.DataFrame | None,
    target_accounts: list[str],
) -> dict[str, Any]:
    target_norm = {_norm_text(x) for x in target_accounts if str(x).strip()}
    if not target_norm:
        return {
            "input_contract": _counterparty_input_contract(),
            "target_account_scope": {"selection_basis": "target_accounts", "selected_accounts": [], "coverage": 0},
            "target_debit_occurrence": {},
            "target_credit_occurrence": {},
            "diagnostics": {
                "reason": "target_accounts_empty",
                "message": "未取得目标科目范围，无法生成对方科目方向分析。",
            },
        }
    top_scope = _kanzhang_top_target_scope(strict_df, loose_df, target_norm)
    scoped_target_norm = set(top_scope.get("selected_norm") or target_norm)
    result: dict[str, Any] | None = None
    diagnostics = []
    for source_name, df in (("凭证类型-严格", strict_df), ("凭证类型-宽松", loose_df)):
        df = _safe_df(df)
        if df is None or df.empty:
            diagnostics.append({"source": source_name, "reason": "empty_table"})
            continue
        type_col = _find_col(df, ("科目名称-类型", "凭证类型", "类型"))
        acc_col = _find_account_col(df)
        amount_col = _find_col(df, ("#_净额(Net)", "净额", "金额", "发生额"))
        id_col = _find_identifier_col(df, type_col, acc_col, amount_col)
        if not acc_col or not amount_col:
            diagnostics.append({
                "source": source_name,
                "reason": "missing_columns",
                "type_column": str(type_col or ""),
                "account_column": str(acc_col or ""),
                "amount_column": str(amount_col or ""),
                "columns": [str(c) for c in df.columns[:20]],
            })
            continue
        side_totals: dict[str, dict[str, Any]] = {
            "target_debit_occurrence": {"target_amount": 0.0, "counterparties": {}, "voucher_ids": []},
            "target_credit_occurrence": {"target_amount": 0.0, "counterparties": {}, "voucher_ids": []},
        }
        matched_group_count = 0
        group_cols = [type_col] if type_col else []
        grouped = df.groupby(group_cols, dropna=False, sort=False) if group_cols else [(source_name, df)]
        for group_key, group in grouped:
            signed_amount = _to_number(group[amount_col]).fillna(0)
            acc_norm = group[acc_col].map(_norm_text)
            target_mask = acc_norm.isin(scoped_target_norm)
            if not target_mask.any():
                continue
            matched_group_count += 1
            target_debit_amount = float(signed_amount[target_mask & (signed_amount > 0)].sum())
            target_credit_amount = float((-signed_amount[target_mask & (signed_amount < 0)]).sum())
            counterpart_mask = ~target_mask
            voucher_ids = []
            if id_col and id_col in group.columns:
                voucher_ids = [str(x) for x in group[id_col].dropna().astype(str).drop_duplicates().head(6).tolist()]

            if target_debit_amount > 0:
                bucket = side_totals["target_debit_occurrence"]
                bucket["target_amount"] += target_debit_amount
                bucket["voucher_ids"].extend([x for x in voucher_ids if x not in bucket["voucher_ids"]])
                cp = group.loc[counterpart_mask & (signed_amount < 0)].copy()
                cp["_abs_amount__"] = (-signed_amount.loc[cp.index]).abs()
                for acc, sub in cp.groupby(acc_col, dropna=False, sort=False):
                    name = _clean_value(acc)
                    bucket["counterparties"][name] = bucket["counterparties"].get(name, 0.0) + float(sub["_abs_amount__"].sum())

            if target_credit_amount > 0:
                bucket = side_totals["target_credit_occurrence"]
                bucket["target_amount"] += target_credit_amount
                bucket["voucher_ids"].extend([x for x in voucher_ids if x not in bucket["voucher_ids"]])
                cp = group.loc[counterpart_mask & (signed_amount > 0)].copy()
                cp["_abs_amount__"] = signed_amount.loc[cp.index].abs()
                for acc, sub in cp.groupby(acc_col, dropna=False, sort=False):
                    name = _clean_value(acc)
                    bucket["counterparties"][name] = bucket["counterparties"].get(name, 0.0) + float(sub["_abs_amount__"].sum())

        debit = _summarize_side_counterparties(side_totals["target_debit_occurrence"])
        credit = _summarize_side_counterparties(side_totals["target_credit_occurrence"])
        if debit.get("target_amount") or credit.get("target_amount"):
            result = {
                "source": source_name,
                "target_debit_occurrence": debit,
                "target_credit_occurrence": credit,
            }
            if source_name == "凭证类型-严格":
                break
        else:
            diagnostics.append({
                "source": source_name,
                "reason": "no_direction_amount_built" if matched_group_count else "no_target_rows_matched",
                "type_column": str(type_col or ""),
                "account_column": str(acc_col),
                "amount_column": str(amount_col),
                "matched_group_count": matched_group_count,
                "target_scope_count": len(scoped_target_norm),
                "sample_accounts": _unique_clean_texts(df[acc_col].dropna().astype(str).head(20).tolist())[:10],
            })
    top_scope.pop("selected_norm", None)
    return {
        "input_contract": _counterparty_input_contract(),
        "target_account_scope": top_scope,
        **(result or {
            "source": "",
            "target_debit_occurrence": {},
            "target_credit_occurrence": {},
            "diagnostics": {
                "reason": "no_counterparty_analysis_built",
                "checks": diagnostics,
            },
        }),
    }


def _summarize_side_counterparties(bucket: dict[str, Any]) -> dict[str, Any]:
    target_amount = float(bucket.get("target_amount") or 0)
    counterparties = bucket.get("counterparties") or {}
    rows = [
        {"account": acc, "amount": float(amount)}
        for acc, amount in counterparties.items()
        if float(amount or 0) > 0
    ]
    rows.sort(key=lambda x: x["amount"], reverse=True)
    selected = []
    covered = 0.0
    for row in rows:
        if selected and target_amount > 0 and covered / target_amount >= 0.8:
            break
        covered += row["amount"]
        selected.append({
            "account": row["account"],
            "amount": round(row["amount"], 2),
            "coverage": round(row["amount"] / target_amount, 4) if target_amount else 0,
            "cumulative_coverage": round(min(covered / target_amount, 1), 4) if target_amount else 0,
        })
    return {
        "target_amount": round(target_amount, 2),
        "coverage_target_range": "80%-120%",
        "covered_amount": round(covered, 2),
        "covered_rate": round(min(covered / target_amount, 1), 4) if target_amount else 0,
        "raw_covered_rate": round(covered / target_amount, 4) if target_amount else 0,
        "coverage_warning": "主要对方科目金额超过目标方向发生额120%，可能包含同凭证其他业务。" if target_amount and covered / target_amount > 1.2 else "",
        "main_counterparties": selected,
        "voucher_ids": list(bucket.get("voucher_ids") or [])[:8],
    }


def _counterparty_input_contract() -> dict[str, Any]:
    return {
        "analysis_scope": "对方科目与凭证类型合并分析",
        "source_priority": ["凭证类型-严格", "凭证类型-宽松"],
        "target_scope_rule": "目标科目按金额绝对值从大到小累计，仅分析累计覆盖前80%的目标科目。",
        "counterparty_coverage_target_range": "80%-120%",
        "direction_rule": "目标科目借方发生额取净额为负的主要对方科目；目标科目贷方发生额取净额为正的主要对方科目。",
        "llm_rule": "LLM只能用自然语言解释借方/贷方发生额的前几大主要对方科目和金额，累计覆盖80%-120%，不输出编号或单独的对方科目组合章节。",
    }


def _kanzhang_top_target_scope(
    strict_df: pd.DataFrame | None,
    loose_df: pd.DataFrame | None,
    target_norm: set[str],
) -> dict[str, Any]:
    for source_name, df in (("凭证类型-严格", strict_df), ("凭证类型-宽松", loose_df)):
        df = _safe_df(df)
        if df is None or df.empty:
            continue
        acc_col = _find_account_col(df)
        amount_col = _find_col(df, ("#_净额(Net)", "净额", "金额", "发生额"))
        if not acc_col or not amount_col:
            continue
        work = df.copy()
        work["_norm__"] = work[acc_col].map(_norm_text)
        work = work[work["_norm__"].isin(target_norm)]
        if work.empty:
            continue
        work["_abs__"] = _to_number(work[amount_col]).fillna(0).abs()
        totals = work.groupby([acc_col, "_norm__"], dropna=False)["_abs__"].sum().reset_index()
        totals = totals[totals["_abs__"] > 0].sort_values("_abs__", ascending=False)
        total_abs = float(totals["_abs__"].sum())
        if total_abs <= 0:
            continue
        selected = []
        selected_norm = []
        covered = 0.0
        for _, row in totals.iterrows():
            if selected and covered / total_abs >= 0.8:
                break
            covered += float(row["_abs__"])
            selected.append({
                "account": _clean_value(row[acc_col]),
                "amount_abs": round(float(row["_abs__"]), 2),
                "cumulative_coverage": round(min(covered / total_abs, 1), 4),
            })
            selected_norm.append(str(row["_norm__"]))
        return {
            "selection_basis": source_name,
            "total_target_amount_abs": round(total_abs, 2),
            "target_coverage": round(min(covered / total_abs, 1), 4),
            "selected_accounts": selected,
            "selected_norm": selected_norm,
            "excluded_small_account_count": max(0, int(len(totals) - len(selected))),
        }
    return {
        "selection_basis": "target_accounts",
        "target_coverage": 0,
        "selected_accounts": [],
        "selected_norm": list(target_norm),
        "excluded_small_account_count": 0,
    }


def _counterparty_single_and_combo_items(
    *,
    source_name: str,
    voucher_type: str,
    group: pd.DataFrame,
    acc_col: str,
    id_col: str | None,
    target_norm: set[str],
    target_abs_amount: float,
    target_net_amount: float,
    cp_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    target_accounts = [
        _clean_value(x)
        for x in group.loc[group[acc_col].map(_norm_text).isin(target_norm), acc_col].dropna().astype(str).drop_duplicates().head(8).tolist()
    ]
    voucher_ids = []
    if id_col and id_col in group.columns:
        voucher_ids = [str(x) for x in group[id_col].dropna().astype(str).drop_duplicates().head(8).tolist()]

    def make_item(kind: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
        cp_abs = sum(float(r.get("abs_amount") or 0) for r in rows)
        if target_abs_amount <= 0:
            return None
        coverage = cp_abs / target_abs_amount
        if coverage < 0.8 or coverage > 1.25:
            return None
        cp_net = sum(float(r.get("amount") or 0) for r in rows)
        direction_matched: bool | str
        direction_matched = "unknown" if abs(target_net_amount) < 0.01 or abs(cp_net) < 0.01 else (target_net_amount * cp_net < 0)
        return {
            "source": source_name,
            "voucher_type": voucher_type,
            "candidate_type": kind,
            "target_accounts": target_accounts,
            "target_amount_abs": round(target_abs_amount, 2),
            "target_amount_net": round(target_net_amount, 2),
            "counterparty_accounts": [
                {
                    "account": r["account"],
                    "amount": round(float(r["amount"]), 2),
                    "coverage": round(float(r["coverage"]), 4),
                }
                for r in rows
            ],
            "combined_counterparty_amount": round(cp_net, 2),
            "combined_coverage": round(coverage, 4),
            "direction_matched": direction_matched,
            "voucher_ids": voucher_ids,
            "decision_rule": "候选来自Top 80%目标科目；对方科目单项或组合金额覆盖目标科目80%-125%。",
            "confidence_rank": (2 if kind == "single" else 1) + min(coverage, 1.25),
        }

    for row in cp_rows:
        item = make_item("single", [row])
        if item:
            items.append(item)

    combo_rows = []
    for row in cp_rows[:5]:
        combo_rows.append(row)
        item = make_item("combination", combo_rows)
        if item:
            items.append(item)
            break
    return items


def _kanzhang_monthly_trends(pivot_df: pd.DataFrame | None) -> dict[str, Any]:
    df = _safe_df(pivot_df)
    if df is None or df.empty:
        return {}
    month_cols = [c for c in df.columns if re.fullmatch(r"\d{4}-\d{2}", str(c))]
    if not month_cols:
        month_cols = [c for c in df.columns if re.search(r"20\d{2}[-/年.]?\d{1,2}", str(c))]
    if not month_cols:
        return {}
    numeric = df[month_cols].apply(_to_number).fillna(0)
    totals = numeric.abs().sum(axis=1)
    total_abs = float(totals.sum())
    if total_abs <= 0:
        return {}
    work = df.copy()
    work["_trend_abs__"] = totals
    work = work.sort_values("_trend_abs__", ascending=False)
    rows = []
    covered = 0.0
    max_trend_rows = 30
    descriptor_cols = [c for c in df.columns if c not in month_cols][:4]
    for _, row in work.iterrows():
        if covered / total_abs >= 0.8 and rows:
            break
        if len(rows) >= max_trend_rows:
            break
        series = pd.to_numeric(pd.Series({c: row[c] for c in month_cols}), errors="coerce").fillna(0)
        abs_sum = float(series.abs().sum())
        if abs_sum <= 0:
            continue
        covered += abs_sum
        max_month = str(series.abs().idxmax())
        min_month = str(series.abs().idxmin())
        rows.append({
            "项目": " / ".join(str(row[c]) for c in descriptor_cols if str(row.get(c, "")).strip())[:MAX_TEXT_LEN],
            "覆盖金额": round(abs_sum, 2),
            "累计覆盖率": round(min(covered / total_abs, 1), 4),
            "峰值月份": max_month,
            "峰值金额": round(float(series[max_month]), 2),
            "低值月份": min_month,
            "低值金额": round(float(series[min_month]), 2),
            "月度序列": {str(c): round(float(series[c]), 2) for c in month_cols[:12]},
        })
    return {
        "scope": "仅分析按月度发生额绝对值累计覆盖前80%的TOP项目，其他项目不分析。",
        "coverage_target": 0.8,
        "total_amount_abs": round(total_abs, 2),
        "covered_amount_abs": round(covered, 2),
        "covered_rate": round(min(covered / total_abs, 1), 4),
        "truncated_by_row_limit": bool(covered / total_abs < 0.8 and len(rows) >= max_trend_rows),
        "items": rows,
    }


def _find_account_col(df: pd.DataFrame) -> str | None:
    keyword_groups = (("科目名称",), ("科目描述",), ("科目",), ("Account", "account"))
    for keywords in keyword_groups:
        for col in df.columns:
            name = str(col)
            if "类型" in name:
                continue
            if any(kw == name for kw in keywords):
                return col
        for col in df.columns:
            name = str(col)
            if "类型" in name:
                continue
            if any(kw in name for kw in keywords):
                return col
    return None


def _find_identifier_col(df: pd.DataFrame, *exclude_cols: str | None) -> str | None:
    excluded = {c for c in exclude_cols if c}
    for col in df.columns:
        name = str(col)
        if col in excluded:
            continue
        if any(kw in name for kw in ("唯一识别码", "凭证号", "凭证", "ID", "id")):
            return col
    for col in df.columns:
        if col not in excluded:
            return col
    return None


def _norm_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().lower())


def _records(df: pd.DataFrame, *, source_sheet: str | None = None, extra_cols: list[str] | None = None) -> list[dict[str, Any]]:
    if df is None or df.empty:
        return []
    preferred = ["资产类别", "固定资产编号", "固定资产名称", "入账开始日期", "使用寿命(月)", "残值率", "原值", "净值", "累计折旧", "本年折旧"]
    cols = [c for c in preferred if c in df.columns]
    for col in extra_cols or []:
        if col in df.columns and col not in cols:
            cols.append(col)
    if not cols:
        cols = list(df.columns[:8])
    out = []
    for _, row in df[cols[:12]].head(MAX_ROWS_PER_TABLE).iterrows():
        item = {str(k): _clean_value(v) for k, v in row.items()}
        if source_sheet:
            item["来源Sheet"] = source_sheet
        out.append(item)
    return out


def _safe_df(df: pd.DataFrame | None) -> pd.DataFrame | None:
    if isinstance(df, pd.DataFrame):
        return df.copy()
    return None


def _flatten_df(df: pd.DataFrame | None) -> pd.DataFrame | None:
    if df is None:
        return None
    out = df.reset_index() if not isinstance(df.index, pd.RangeIndex) else df.copy()
    out.columns = [" / ".join(map(str, c)) if isinstance(c, tuple) else str(c) for c in out.columns]
    return out


def _find_col(df: pd.DataFrame, keywords: tuple[str, ...]) -> str | None:
    for col in df.columns:
        name = str(col)
        if any(kw == name for kw in keywords):
            return col
    for col in df.columns:
        name = str(col)
        if any(kw in name for kw in keywords):
            return col
    return None


def _to_number(series: pd.Series) -> pd.Series:
    text = series.astype(str).str.replace(",", "", regex=False).str.replace("%", "", regex=False)
    return pd.to_numeric(text, errors="coerce")


def _to_datetime(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, errors="coerce")


def _to_life_months(series: pd.Series) -> pd.Series:
    text = series.astype(str)
    nums = pd.to_numeric(text.str.extract(r"(\d+(?:\.\d+)?)", expand=False), errors="coerce")
    year_mask = text.str.contains("年", na=False) & ~text.str.contains("月", na=False)
    nums.loc[year_mask] = nums.loc[year_mask] * 12
    return nums


def _parse_date(value: Any) -> datetime | None:
    if value is None:
        return None
    dt = pd.to_datetime(str(value), errors="coerce")
    if pd.isna(dt):
        return None
    return datetime(dt.year, dt.month, dt.day)


def _clean_value(value: Any) -> Any:
    if pd.isna(value):
        return ""
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return ""
        return round(float(value), 2)
    text = str(value).strip()
    return re.sub(r"\s+", " ", text)[:MAX_TEXT_LEN]


def _reserve_sheet_name(preferred: str, used: set[str]) -> str:
    name = preferred[:31]
    if name not in used:
        used.add(name)
        return name
    base = preferred[:28]
    idx = 2
    while True:
        candidate = f"{base}_{idx}"[:31]
        if candidate not in used:
            used.add(candidate)
            return candidate
        idx += 1
