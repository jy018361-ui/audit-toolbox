"""看账磁盘路径受限验收（标准库、仅合成数据、不会执行编译或发布）。

python scripts/verify_kanzhang_disk.py --self-test
python scripts/verify_kanzhang_disk.py --exe <worker.exe> --out <新目录>
默认生成四组小文件/272 MiB 大文件，逐组串行运行；--cases b_positive 可先跑一组。
报告中的采样峰值不等于操作系统硬峰值；worker 直接入口由本脚本额外安装 Job Object。
"""
import argparse
import csv
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal, InvalidOperation

MIB = 1024 ** 2
CASES = ("b_positive", "b_signed", "a_direction", "a_signed")
HEADERS = ["公司", "期间", "凭证号", "科目名称", "借方金额", "贷方金额", "金额", "方向", "日期", "摘要", "验收填充"]
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def fixture_rows(case, fillers=20000):
    def row(entity, period, voucher, account, debit, credit, summary):
        signed = -credit if case == "b_signed" else credit
        amount = debit if debit else (credit if case == "a_direction" else -credit)
        direction = "借" if debit else "贷"
        return [entity, period, voucher, account, str(debit), str(signed), str(amount), direction,
                "2026-01-03" if period != "02" else "2026-02-03", summary, ""]
    # 第一张凭证的贷方在所有填充凭证之后，锁住跨读取批次完整凭证扩展。
    yield row("合成甲", "01", "0001", "收入", 100, 0, '跨批次,"引号"\n第二行')
    yield row("合成乙", "01", "0001", "费用", 25, 0, "同号不同公司")
    yield row("合成乙", "01", "0001", "银行", 0, 25, "同号不同公司")
    yield row("合成甲", "02", "0001", "费用", 35, 0, "同号不同期间")
    yield row("合成甲", "02", "0001", "银行", 0, 35, "同号不同期间")
    yield row("合成甲", "01", "0002", "收入", -20, 0, "红字")
    yield row("合成甲", "01", "0002", "银行", 0, -20, "红字")
    yield row("合成甲", "01", "0003", "收入", 0, 50, "损益结转")
    yield row("合成甲", "01", "0003", "本年利润", 50, 0, "损益结转")
    yield row("合成甲", "01", "0004", "收入", 30, 0, "前向填充")
    forward = row("", "", "", "银行", 0, 30, "前向填充")
    yield forward
    for index in range(fillers):
        yield row("合成填充", "01", f"F{index:07}", "无关", 1, 0, "不命中目标")
    yield row("合成甲", "01", "0001", "银行", 0, 100, "跨批次尾行")


def generate(path, case, large_mib, fillers=20000):
    # 仅无关行有填充。命中输出在两条路径下完全一致，无需隐藏业务差异。
    padding = "x" * math.ceil(large_mib * MIB / fillers) if large_mib else ""
    with path.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.writer(stream)
        writer.writerow(HEADERS)
        for row in fixture_rows(case, fillers):
            if row[3] == "无关":
                row[-1] = padding
            writer.writerow(row)
    return path.stat().st_size


def mapping(case):
    result = dict(id=["期间", "凭证号"], entity="公司", accountName=["科目名称"], date="日期", summary="摘要")
    if case.startswith("b_"):
        result.update(functionalDebit="借方金额", functionalCredit="贷方金额")
    else:
        result["functionalAmount"] = "金额"
        if case == "a_direction":
            result["direction"] = "方向"
    return result


def run_worker(exe, directory, method, params, timeout):
    import ctypes as c
    import diagnose_kanzhang_import as guard
    directory.mkdir()
    initial = guard.memory()
    reserve = max(1 * guard.GIB, min(initial.total // 5, 8 * guard.GIB))
    # 与生产 resource_budget::plan 的 worker 公式一致；此处只负责给绕过 Tauri
    # 父进程的直接验收入口安装同口径硬限制，不复制批次/SQLite 策略。
    hard = min(initial.total // 4, max(0, initial.available - reserve) * 3 // 4,
               max(0, initial.commit_available - reserve) * 3 // 4)
    if hard < 256 * MIB:
        raise RuntimeError("可用内存/提交余量不足，验收未启动；关闭其他大程序后再运行。")
    handle = guard.checked(guard.create_job(None, None))
    child = None
    samples = []
    started = time.monotonic()
    try:
        limits = guard.Limits()
        limits.basic.flags = 0x100 | 0x200 | 0x2000
        limits.process_memory = limits.job_memory = int(hard)
        guard.checked(guard.set_job(handle, 9, c.byref(limits), c.sizeof(limits)))
        with (directory / "events.jsonl").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
            child = subprocess.Popen([str(exe), "--rust-table-worker"], stdin=subprocess.PIPE,
                                     stdout=stdout, stderr=stderr, creationflags=0x08000000 | 0x4000)
            guard.checked(guard.assign(handle, int(child._handle)))
            request = dict(jobId=directory.name, method=method, params=params,
                           cancelPath=str(directory / "cancel"), pausePath=str(directory / "pause"))
            child.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode())
            child.stdin.close()
            while child.poll() is None:
                try:
                    sample = guard.sample(int(child._handle), started)
                except OSError:
                    if child.poll() is not None:
                        break
                    raise
                samples.append(sample)
                if sample["available_bytes"] < reserve or sample["commit_available_bytes"] < reserve:
                    raise RuntimeError("系统余量低于验收预留线，已保护性终止。")
                if sample["seconds"] > timeout:
                    raise RuntimeError("验收超时，已保护性终止。")
                time.sleep(0.2)
        if child.returncode:
            raise RuntimeError(f"worker 异常退出 {child.returncode}；请查看 {directory}")
        events = [json.loads(line) for line in (directory / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        terminal = next((e for e in reversed(events) if e.get("phase") in ("completed", "failed", "cancelled")), {})
        if terminal.get("phase") != "completed":
            raise RuntimeError(f"worker 未完成：{terminal}")
        return terminal.get("result", {})
    finally:
        if child is not None and child.poll() is None:
            guard.terminate(handle, 124)
            child.wait(timeout=10)
        guard.close(handle)
        (directory / "resources.json").write_text(json.dumps(dict(
            total_bytes=initial.total, available_bytes=initial.available, hard_bytes=hard,
            reserve_bytes=reserve, elapsed_seconds=time.monotonic() - started,
            sampled_peak_private_bytes=max((r["private_bytes"] for r in samples), default=0),
            samples=samples), ensure_ascii=False, indent=2), encoding="utf-8")


def xlsx_values(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = ["".join(si.itertext()) for si in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        result = {}
        for sheet in ET.fromstring(archive.read("xl/workbook.xml")).findall("m:sheets/m:sheet", NS):
            name = sheet.attrib["name"]
            target = rels[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
            target = target.lstrip("/") if target.startswith("/") else "xl/" + target
            values = {}
            for cell in ET.fromstring(archive.read(target)).findall(".//m:sheetData/m:row/m:c", NS):
                text = cell.findtext("m:v", default="", namespaces=NS)
                if cell.attrib.get("t") == "s":
                    text = shared[int(text)]
                elif cell.attrib.get("t") == "inlineStr":
                    text = "".join(cell.find("m:is", NS).itertext())
                elif text:
                    try:
                        text = Decimal(text).quantize(Decimal("0.000001"))
                    except InvalidOperation:
                        pass
                if text != "":
                    values[cell.attrib["r"]] = text
            result[name] = values
        return result


def compare_outputs(small, large):
    left = {p.name: p for p in small.iterdir() if p.suffix in (".csv", ".xlsx")}
    right = {p.name: p for p in large.iterdir() if p.suffix in (".csv", ".xlsx")}
    assert left.keys() == right.keys(), (list(left), list(right))
    assert any("套表" in name for name in left), "缺少套表"
    assert any("Part" in name for name in left), "未覆盖明细分片"
    details = []
    for name, path in left.items():
        if path.suffix == ".xlsx":
            a, b = xlsx_values(path), xlsx_values(right[name])
            assert {"凭证", "凭证类型-宽松", "凭证类型-严格", "科目汇总"} <= a.keys(), name
            assert a.keys() == b.keys(), f"套表页签不同：{name}"
            # 普通路径的隐藏 _targets 还带一列归一化值，磁盘路径只保存目标原值；
            # 对用户可见业务页逐格比较，对隐藏页单独核对目标存在。
            # 普通路径会把同一凭证类型连续行的识别码单元格纵向合并；磁盘
            # 恒定内存写法保留重复文本。比较前把后者归一化成合并后的 XML 值。
            for sheet_name, values in b.items():
                if not sheet_name.startswith("凭证类型-"):
                    continue
                previous_label = previous_id = None
                rows = sorted({int("".join(filter(str.isdigit, cell))) for cell in values})
                for row in rows:
                    label = values.get(f"A{row}")
                    voucher_id = values.get(f"B{row}")
                    if label == previous_label and voucher_id == previous_id:
                        values.pop(f"B{row}", None)
                    if voucher_id is not None:
                        previous_id = voucher_id
                    previous_label = label
            # 同一类型只展示前三个去重摘要；两条实现的并查集成员遍历顺序可不同，
            # 摘要集合相同即可，不能把展示顺序差异当作金额或归类差异。
            for book in (a, b):
                for sheet_name, values in book.items():
                    if not sheet_name.startswith("凭证类型-"):
                        continue
                    for cell, value in list(values.items()):
                        if cell.startswith("C") and isinstance(value, str) and " | " in value:
                            values[cell] = " | ".join(sorted(value.split(" | ")))
            assert {k: v for k, v in a.items() if k != "_targets"} == {
                k: v for k, v in b.items() if k != "_targets"
            }, f"套表业务页单元格不同：{name}"
            expected_target = "费用" if "费用_02" in name else "收入"
            assert expected_target in set(b["_targets"].values()), f"磁盘套表目标清单缺失：{name}"
        else:
            with path.open(encoding="utf-8-sig", newline="") as stream:
                a = list(csv.DictReader(stream))
            with right[name].open(encoding="utf-8-sig", newline="") as stream:
                b = list(csv.DictReader(stream))
            assert a == b, f"明细内容/顺序不同：{name}"
            if "凭证明细" in name:
                details.extend(a)
    # 独立业务断言：两批共12行；非目标的对方分录保留，填充凭证不应进入结果。
    assert len(details) == 12, f"完整凭证行数应为12，实为{len(details)}"
    assert sum(r["科目名称"] == "银行" for r in details) == 5
    assert sum(r["科目名称"] == "本年利润" for r in details) == 1
    assert sum(r.get("【损益结转】") == "损益结转" for r in details) == 2
    assert any(r["科目名称"] == "收入" and r["借方金额"] == "-20" for r in details), "红字行丢失或符号改变"
    assert all(r["公司"] and r["期间"] and r["凭证号"] for r in details), "前向填充失败"
    return dict(files=sorted(left), detail_rows=len(details))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exe", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    ap.add_argument("--large-mib", type=int, default=272)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--fixtures-only", action="store_true")
    ap.add_argument("--keep-cache", action="store_true", help="保留本次合成输入生成的应用缓存")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        with tempfile.TemporaryDirectory() as tmp:
            for case in CASES:
                p = Path(tmp) / (case + ".csv")
                generate(p, case, 0, fillers=20)
                with p.open(encoding="utf-8-sig", newline="") as f:
                    rows = list(csv.DictReader(f))
                assert len(rows) == 32 and "\n" in rows[0]["摘要"]
                assert rows[-1]["凭证号"] == rows[0]["凭证号"]
        print("合成夹具自检通过；未运行 worker，未验证业务实现。")
        return
    if not args.out or (not args.exe and not args.fixtures_only):
        ap.error("需要 --out；执行 worker 时还需要 --exe")
    if not 256 <= args.large_mib <= 1024 or not 1 <= args.timeout <= 1800:
        ap.error("large-mib 要求 256..1024，timeout 要求 1..1800")
    if os.name != "nt" and not args.fixtures_only:
        ap.error("受限 worker 验收仅支持 Windows")
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(root).free < (args.large_mib * len(args.cases) * 3 + 512) * MIB:
        raise RuntimeError("磁盘空间不足以保留夹具、磁盘缓存和输出。")
    exe = args.exe.resolve(strict=True) if args.exe else None
    report = dict(status="running", executable=str(exe), cases={}, limitations=[
        "合成数据路径等价验收不等于真实6GB完整验收", "内存模拟需另跑resource_budget::tests::adaptive_，脚本不复制生产预算算法",
        "直接worker入口不经过Tauri父进程保护；脚本安装的是独立验收保护"])
    try:
        for case in args.cases:
            directory = root / case
            directory.mkdir()
            generated_caches = []
            for mode, size in (("small", 0), ("large", args.large_mib)):
                source = directory / (mode + ".csv")
                generate(source, case, size)
                if args.fixtures_only:
                    continue
                common = dict(inputPath=str(source), headerRow=1, mapping=mapping(case))
                inspect = run_worker(exe, directory / (mode + "-inspect"), "kanzhang.inspect", common, args.timeout)
                assert bool(inspect.get("lowMemory")) == (mode == "large"), f"未走预期{mode}路径：{inspect.keys()}"
                if inspect.get("cachePath"):
                    generated_caches.append(Path(inspect["cachePath"]))
                output = directory / mode
                output.mkdir()
                params = dict(common, outputPath=str(output / "result.csv"),
                              targetBatches=[dict(name="收入", accounts=["收入"]), dict(name="费用", accounts=["费用"])],
                              includePivot=True, includeVoucherTypes=True, markLossTransfer=True,
                              llmAnalysis=False, rowsPerSheet=3, pivotRows=["科目名称"], pivotColumns=["日期"])
                run_worker(exe, directory / (mode + "-export"), "kanzhang.export", params, args.timeout)
            if not args.fixtures_only:
                report["cases"][case] = compare_outputs(directory / "small", directory / "large")
                if not args.keep_cache:
                    for cache in generated_caches:
                        # 输入路径来自刚创建的唯一验收目录，缓存键因此不可能复用客户输入。
                        # 只删除 worker 明确返回的文件，不递归删除缓存目录。
                        if cache.is_file():
                            cache.unlink()
                    report["cases"][case]["generatedCachesRemoved"] = True
        report["status"] = "fixtures_only" if args.fixtures_only else "passed"
    except BaseException as exc:
        report.update(status="failed", error=str(exc))
        raise
    finally:
        (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"验收状态：{report['status']}；报告：{root / 'report.json'}")


if __name__ == "__main__":
    main()
