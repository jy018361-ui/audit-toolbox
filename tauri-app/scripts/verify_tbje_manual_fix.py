"""两套用户原件的人工辅助、完整性及公式验收；只写指定的新输出目录。"""
from __future__ import annotations
import argparse, copy, hashlib, json, subprocess, uuid
from pathlib import Path

def worker(exe: Path, out: Path, name: str, method: str, params: dict) -> dict:
    request = {"jobId": "tbje-review-" + uuid.uuid4().hex, "method": method, "params": params,
               "cancelPath": str(out / (name + ".cancel")), "pausePath": str(out / (name + ".pause"))}
    (out / (name + "-request.json")).write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
    child = subprocess.run([str(exe), "--rust-table-worker"], input=json.dumps(request, ensure_ascii=False)+"\n",
                           text=True, encoding="utf-8", capture_output=True, timeout=600,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    (out / (name + "-events.jsonl")).write_text(child.stdout, encoding="utf-8")
    events = [json.loads(line) for line in child.stdout.splitlines() if line.strip()]
    completed = [e for e in events if e.get("phase") == "completed"]
    assert child.returncode == 0 and completed, (name, child.stderr[-1000:], events[-1:])
    return completed[-1]["result"]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--params", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(); out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    params = json.loads(args.params.read_text(encoding="utf-8")); params.pop("outputDirectory", None)
    groups = params["groups"]
    groups[0]["tbMapping"]["auxiliary"] = ["核算维度编码"]
    groups[0]["tbMapping"]["__manualAuxiliary"] = json.dumps({"auxiliary":["核算维度编码"]}, ensure_ascii=False, separators=(",", ":"))
    sources = {Path(g[side]["inputPath"]) for g in groups for side in ("tbSource", "jeSource")}
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    summaries = []
    for name, force_disk in [("normal", False), ("disk", True)]:
        current = copy.deepcopy(params)
        if force_disk:
            for group in current["groups"]: group["__largeJeDiskMode"] = True
        result = worker(args.exe.resolve(), out, name, "tbje_check.run_batch", current)
        (out / (name + "-result.json")).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        assert all(g.get("ok") for g in result["groups"]), result
        checks = [g["result"] for g in result["groups"]]
        assert checks[0]["tbVsJe"]["mismatched"] == 0, checks[0]["tbVsJe"]
        assert checks[0]["equation"]["balancePassed"] is True, checks[0]["equation"]
        assert checks[1]["tbVsJe"]["netMismatched"] == 3, checks[1]["tbVsJe"]
        actual = {(row["entity"], row["code"]): row["netDifference"] for row in checks[1]["tbVsJe"]["items"] if not row["netPassed"]}
        expected = {("合肥观安", "12310201"):-4356., ("合肥观安", "181102"):-160., ("合肥观安", "410401"):4516.}
        assert actual.keys() == expected.keys() and all(abs(actual[k] - v) < .01 for k,v in expected.items()), actual
        assert checks[1]["equation"]["balancePassed"] is True
        for check in checks: assert check["rollforward"]["passed"] is True
        summaries.append({"mode":name,"checks":[{"sideDifferences":c["tbVsJe"]["mismatched"],"netDifferences":c["tbVsJe"]["netMismatched"],"equationPassed":c["equation"]["balancePassed"]} for c in checks]})
        current["outputDirectory"] = str(out / name); Path(current["outputDirectory"]).mkdir(exist_ok=True)
        worker(args.exe.resolve(), out, name + "-export", "tbje_check.export_batch", current)
    assert hashes == {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    (out / "验收结果.json").write_text(json.dumps({"exe":str(args.exe.resolve()),"sources":hashes,"results":summaries}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summaries, ensure_ascii=False), flush=True)

if __name__ == "__main__": main()
