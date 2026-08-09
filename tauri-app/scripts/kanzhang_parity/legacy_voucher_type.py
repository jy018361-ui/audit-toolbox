# -*- coding: utf-8 -*-
"""为 Rust 的凭证类型回归测试生成期望值。

这是 `tools/kanzhang/kanzhang_app.py::build_voucher_type_pivot`（无方向列分支）的忠实
重写：已验证在给定同一凭证遍历顺序时，输出与直接运行旧版 GUI 代码逐行一致。

和旧版唯一的差别是**凭证遍历顺序**：旧版取自 `polars.group_by()` 的哈希顺序（不可复现），
这里固定成「凭证在底稿里第一次出现的先后」，也就是 Rust `voucher_infos` 用的口径。

用法：

    python legacy_voucher_type.py <旧版导出的_凭证明细.csv> <目标科目.csv> <输出目录>

目标科目 CSV 取第一列（旧版套表的隐藏页 `_targets` 直接导出即可，有无表头都行）。
输出目录会得到 targets.csv / expect_loose.csv / expect_strict.csv，
喂给 `cargo test kanzhang_voucher_type_matches_legacy_sample -- --ignored`。

注意：输入是客户底稿，生成的期望值同样含真实科目与公司名，**不要入库**。
"""
import csv, io, os, re, sys
from collections import OrderedDict


def load_targets(path):
    out = []
    with io.open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if row and row[0].strip() and row[0].strip() != "科目":
                out.append(row[0].strip())
    return out


def num(s):
    s = (s or "").strip().replace(",", "")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def load_rows(path):
    rows = []
    with io.open(path, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        for d in r:
            vid = "-".join([d["公司"], d["记账日期"], d["凭证号"]])
            net = num(d["借方"]) - num(d["贷方"])
            # 记账日期在真实底稿里有 2025-10-31 也有 2025-1-23，月份必须补零，
            # 否则整张凭证的月份分布会被静默丢成 0。
            month = ""
            m = re.match(r"^(\d{4})\D+(\d{1,2})\D", (d["记账日期"] or "").strip())
            if m:
                month = "%s-%02d" % (m.group(1), int(m.group(2)))
            rows.append({
                "vid": vid,
                "acc": d["科目名称"],
                "net": net,
                "zy": (d["ZY"] or "").strip(),
                "month": month,
                "loss": (d["【损益结转】"] or "").strip() == "损益结转",
            })
    return rows


_norm_cache = {}


def norm_acc(s):
    s = str(s)
    if s in _norm_cache:
        return _norm_cache[s]
    v = re.sub(r"\s*-\s*", "-", s).strip()
    _norm_cache[s] = v
    return v


def build(rows, targets, mode):
    target_acc_norm = {norm_acc(v) for v in targets}
    loss_ids = {r["vid"] for r in rows if r["loss"]}
    kept = [r for r in rows if r["vid"] not in loss_ids]

    # v_pivot: (vid, acc) -> net, index sorted like pandas pivot_table / set_index order.
    pivot = OrderedDict()
    for r in kept:
        pivot[(r["vid"], r["acc"])] = pivot.get((r["vid"], r["acc"]), 0.0) + r["net"]
    keys = sorted(pivot.keys())

    # 遍历顺序 = 凭证在底稿里第一次出现的先后（Rust 侧同口径）。
    per_vid = OrderedDict()
    for r in kept:
        per_vid.setdefault(r["vid"], [])
    for vid, acc in keys:
        per_vid[vid].append(acc)

    voucher_info = []
    for vid, accs in per_vid.items():
        acc_set, signs = set(), {}
        for acc in accs:
            net = round(pivot[(vid, acc)], 2)
            if abs(net) > 0:
                acc_set.add(acc)
                signs[acc] = 1 if net > 0 else (-1 if net < 0 else 0)
        target_signs = {a: s for a, s in signs.items() if norm_acc(a) in target_acc_norm}
        info = {
            "vid": vid,
            "acc_set": acc_set,
            "full": frozenset(acc_set),
            "target_signs": target_signs,
            "tset": frozenset(target_signs.keys()),
        }
        voucher_info.append(info)

    voucher_info = [i for i in voucher_info if i["tset"]]
    n = len(voucher_info)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    def order_key(s):
        return (-len(s), tuple(sorted(str(x) for x in s)))

    def compatible(group_map, acc_map):
        for acc, s in acc_map.items():
            if acc in group_map and group_map[acc] != s:
                return False
        return True

    def minimal_sets(set_list):
        uniq, seen = [], set()
        for s in set_list:
            if not s or s in seen:
                continue
            seen.add(s)
            uniq.append(s)
        uniq.sort(key=lambda s: (len(s), tuple(sorted(str(x) for x in s))))
        mins = []
        for s in uniq:
            if any(m.issubset(s) for m in mins):
                continue
            mins.append(s)
        return mins

    if mode == "strict":
        base_target_sets = minimal_sets([i["tset"] for i in voucher_info if i["tset"] and len(i["tset"]) > 1])
        base_target_desc = sorted(base_target_sets, key=order_key)
        base_target_lookup = set(base_target_sets)
        base_full_sets = minimal_sets([i["full"] for i in voucher_info if i["full"] and len(i["tset"]) == 1])
        base_full_desc = sorted(base_full_sets, key=order_key)
        base_full_lookup = set(base_full_sets)

        def pick_t(t):
            for b in base_target_desc:
                if b.issubset(t):
                    return b
            return None

        def pick_f(f):
            for b in base_full_desc:
                if b.issubset(f):
                    return b
            return None

        def has_base(info):
            t = info["tset"]
            if not t:
                return False
            if len(t) > 1:
                return pick_t(t) is not None
            f = info["full"]
            return bool(f) and pick_f(f) is not None

        primary = {i for i, info in enumerate(voucher_info) if has_base(info)}

        bg_t = {}
        if base_target_sets:
            for idx, info in enumerate(voucher_info):
                t = info["tset"]
                if not t or len(t) <= 1 or t not in base_target_lookup:
                    continue
                groups = bg_t.setdefault(t, [])
                if not [g for g in groups if compatible(g["sign_map"], info["target_signs"])]:
                    groups.append({"members": [idx], "sign_map": dict(info["target_signs"])})

        bg_f = {}
        if base_full_sets:
            for idx, info in enumerate(voucher_info):
                t = info["tset"]
                if not t or len(t) != 1:
                    continue
                f = info["full"]
                if not f or f not in base_full_lookup:
                    continue
                groups = bg_f.setdefault(f, [])
                if not [g for g in groups if compatible(g["sign_map"], info["target_signs"])]:
                    groups.append({"members": [idx], "sign_map": dict(info["target_signs"])})

        for idx in primary:
            info = voucher_info[idx]
            t = info["tset"]
            if not t:
                continue
            if len(t) > 1:
                b = pick_t(t)
                if b is None:
                    continue
                groups = bg_t.get(b, [])
            else:
                f = info["full"]
                b = pick_f(f) if f else None
                if b is None:
                    continue
                groups = bg_f.get(b, [])
            comp = [g for g in groups if compatible(g["sign_map"], info["target_signs"])]
            if len(comp) != 1:
                continue
            g = comp[0]
            union(idx, g["members"][0])
            if idx not in g["members"]:
                g["members"].append(idx)
            for acc, s in info["target_signs"].items():
                g["sign_map"].setdefault(acc, s)

        one_t = [i for i, info in enumerate(voucher_info) if len(info["tset"]) == 1]
        if one_t:
            by_full = {}
            for i in one_t:
                by_full.setdefault(voucher_info[i]["full"], []).append(i)
            for f, idxs in by_full.items():
                if len(idxs) <= 1:
                    continue
                base = idxs[0]
                for j in idxs[1:]:
                    if compatible(voucher_info[base]["target_signs"], voucher_info[j]["target_signs"]) and \
                       compatible(voucher_info[j]["target_signs"], voucher_info[base]["target_signs"]):
                        union(base, j)
    else:
        base_target_sets = minimal_sets([i["tset"] for i in voucher_info if i["tset"]])
        base_target_desc = sorted(base_target_sets, key=order_key)

        def pick_t(t):
            for b in base_target_desc:
                if b.issubset(t):
                    return b
            return None

        primary = {i for i, info in enumerate(voucher_info) if info["tset"] and pick_t(info["tset"]) is not None}

        base_full_sets = minimal_sets([voucher_info[i]["full"] for i in primary if voucher_info[i]["full"]])
        base_full_desc = sorted(base_full_sets, key=order_key)

        def pick_f(f):
            for b in base_full_desc:
                if b.issubset(f):
                    return b
            return None

        bg_t = {}
        if base_target_sets:
            for idx, info in enumerate(voucher_info):
                t = info["tset"]
                b = pick_t(t) if t else None
                if not t or b is None:
                    continue
                groups = bg_t.setdefault(b, [])
                if not [g for g in groups if compatible(g["sign_map"], info["target_signs"])]:
                    groups.append({"members": [idx], "sign_map": dict(info["target_signs"])})
            for idx, info in enumerate(voucher_info):
                t = info["tset"]
                b = pick_t(t) if t else None
                if not t or b is None:
                    continue
                groups = bg_t.get(b, [])
                comp = [g for g in groups if compatible(g["sign_map"], info["target_signs"])]
                if len(comp) != 1:
                    continue
                g = comp[0]
                union(idx, g["members"][0])
                if idx not in g["members"]:
                    g["members"].append(idx)
                for acc, s in info["target_signs"].items():
                    g["sign_map"].setdefault(acc, s)

        bg_f = {}
        for idx in primary:
            info = voucher_info[idx]
            f = info["full"]
            b = pick_f(f) if f else None
            if not f or b is None:
                continue
            groups = bg_f.setdefault(b, [])
            if not [g for g in groups if compatible(g["sign_map"], info["target_signs"])]:
                groups.append({"members": [idx], "sign_map": dict(info["target_signs"])})

        for idx in primary:
            info = voucher_info[idx]
            f = info["full"]
            b = pick_f(f) if f else None
            if not f or b is None:
                continue
            groups = bg_f.get(b, [])
            comp = [g for g in groups if compatible(g["sign_map"], info["target_signs"])]
            if len(comp) != 1:
                continue
            g = comp[0]
            union(idx, g["members"][0])
            if idx not in g["members"]:
                g["members"].append(idx)
            for acc, s in info["target_signs"].items():
                g["sign_map"].setdefault(acc, s)

    comp_groups = OrderedDict()
    for idx, info in enumerate(voucher_info):
        comp_groups.setdefault(find(idx), []).append(info["vid"])
    type_groups = list(comp_groups.values())
    rep_map = {vid: g[0] for g in type_groups for vid in g}

    # accs_per_vid: nonzero-net accounts per original voucher
    accs_per_vid = {}
    for (vid, acc) in keys:
        net = round(pivot[(vid, acc)], 2)
        if abs(net) <= 0:
            continue
        accs_per_vid.setdefault(vid, set()).add(acc)

    acc_sig = {}
    for g in type_groups:
        rep = g[0]
        accs = set()
        for oid in g:
            accs |= accs_per_vid.get(oid, set())
        for acc in accs:
            if norm_acc(acc) in target_acc_norm:
                acc_sig.setdefault(acc, set()).add(rep)
    rank = {}
    for acc, reps in acc_sig.items():
        for i, rep in enumerate(sorted(reps), start=1):
            rank[(acc, rep)] = i
    label_map = {}
    for g in type_groups:
        rep = g[0]
        accs = set()
        for oid in g:
            accs |= accs_per_vid.get(oid, set())
        labels = [f"{a}-类型{rank.get((a, rep), 1)}" for a in sorted(a for a in accs if norm_acc(a) in target_acc_norm)]
        if labels:
            label_map[rep] = " | ".join(labels)

    # summaries (per original voucher, in row order, dedup)
    summary_map = {}
    for r in kept:
        if not r["zy"]:
            continue
        b = summary_map.setdefault(r["vid"], [])
        if r["zy"] not in b:
            b.append(r["zy"])
    rep_summaries = {}
    for g in type_groups:
        rep = g[0]
        buf = []
        for oid in g:
            for t in summary_map.get(oid, []):
                if t not in buf:
                    buf.append(t)
                if len(buf) >= 3:
                    break
            if len(buf) >= 3:
                break
        rep_summaries[rep] = " | ".join(buf)

    # grouped: (rep, acc) -> net
    grouped = {}
    for (vid, acc) in keys:
        rep = rep_map.get(vid)
        if rep is None:
            continue
        grouped[(rep, acc)] = grouped.get((rep, acc), 0.0) + pivot[(vid, acc)]

    # months: (rep, acc, month) -> net
    months_set = set()
    mpivot = {}
    for r in kept:
        rep = rep_map.get(r["vid"])
        if rep is None or not r["month"]:
            continue
        months_set.add(r["month"])
        k = (rep, r["acc"], r["month"])
        mpivot[k] = mpivot.get(k, 0.0) + r["net"]
    month_cols = sorted(months_set)

    out = []
    for (rep, acc) in sorted(grouped.keys()):
        label = label_map.get(rep, "")
        net = grouped[(rep, acc)]
        mv = [mpivot.get((rep, acc, m), 0.0) for m in month_cols]
        # 与 Rust 一致：净额和每个月份都四舍五入到分之后再判断是否整行为 0。
        # 旧版直接比未取整的浮点和，5.9e-12 这种累加噪声会让一整行 0 被保留下来；
        # 那点残差取决于求和顺序，换个实现就不一样，没法也不该复现。
        if round(net, 2) == 0 and all(round(x, 2) == 0 for x in mv):
            continue
        out.append([label, rep, rep_summaries.get(rep, ""), acc, net] + mv)

    # 旧版 flat.groupby([type_col, acc_col]) 会先按 (类型标签, 科目名称) 升序落表
    out.sort(key=lambda r: (r[0], r[3]))

    def sort_key(row):
        lab = row[0]
        acc_part = lab.split("-类型")[0] if "-类型" in lab else lab
        try:
            num_part = int(lab.split("-类型")[-1]) if "-类型" in lab else 0
        except ValueError:
            num_part = 0
        return (acc_part, num_part)

    out.sort(key=lambda r: (sort_key(r)[0], sort_key(r)[1]), reverse=True)
    return out, month_cols, type_groups


def fmt(value):
    """按 Rust `format_number` 的口径写数：整数不带小数点，其余取最短表示。"""
    value = round(value, 2)
    if value == 0:
        value = 0.0
    if value == int(value):
        return "%d" % int(value)
    return repr(value)


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2
    detail, targets_csv, out_dir = argv[1], argv[2], argv[3]
    os.makedirs(out_dir, exist_ok=True)
    targets = load_targets(targets_csv)
    rows = load_rows(detail)
    print("明细行 %d，目标科目 %d" % (len(rows), len(targets)))

    with io.open(os.path.join(out_dir, "targets.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["科目"])
        for t in targets:
            w.writerow([t])

    for mode, fn in (("normal", "expect_loose.csv"), ("strict", "expect_strict.csv")):
        out, month_cols, groups = build(rows, targets, mode)
        print("%s: %d 类型 / %d 行 / %d 个月份列" % (mode, len(groups), len(out), len(month_cols)))
        with io.open(os.path.join(out_dir, fn), "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["科目名称-类型", "公司-记账日期-凭证号", "摘要", "科目名称", "#_净额(Net)"] + month_cols)
            for r in out:
                w.writerow(r[:4] + [fmt(x) for x in r[4:]])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
