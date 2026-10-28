"""供 verify_large_file_workers.py 使用的合成小样本，不进入应用运行环境。"""
from pathlib import Path
import copy
import uuid


def build_cases(root: Path) -> dict[str, dict]:
    root.mkdir(parents=True, exist_ok=True)

    def text(name: str, body: str) -> str:
        path = root / name
        path.write_text(body, encoding="utf-8-sig")
        return str(path.resolve())

    def request(label: str, method: str, params: dict) -> dict:
        params.setdefault("__settings", {"llm": {"enabled": False}})
        return {"jobId": f"smoke-{label}-{uuid.uuid4().hex}", "method": method, "params": params,
                "cancelPath": str((root / f"{label}-cancel.flag").resolve()),
                "pausePath": str((root / f"{label}-pause.flag").resolve())}

    header = "卡片编号,资产类别,资产名称,原值,累计折旧,开始使用日期,使用寿命,残值率,本年折旧\n"
    begin = text("FA期初.csv", header + "A1,机器设备,设备甲,1000,200,2024-01-01,60,5%,100\n")
    end = text("FA期末.csv", header + "A1,机器设备,设备甲,1000,300,2024-01-01,72,5%,100\n")
    mapping = {"category": "资产类别", "name": "资产名称", "originalValue": "原值", "depreciation": "累计折旧",
               "startDate": "开始使用日期", "life": "使用寿命", "residualRate": "残值率", "currentYearDep": "本年折旧"}
    fa = {"beginPath": begin, "endPath": end, "beginKeys": ["卡片编号"], "endKeys": ["卡片编号"],
          "beginMapping": mapping, "endMapping": mapping, "beginOriginalValue": "原值", "endOriginalValue": "原值",
          "beginDepreciation": "累计折旧", "endDepreciation": "累计折旧", "endResidualRate": "残值率",
          "balanceSheetDate": "2025-12-31", "__forceDisk": True}
    cases = {}
    for label, method, filename in [("fa", "fa.export", "FA匹配.xlsx"), ("policy", "fa.policy_export", "政策对比.xlsx")]:
        params = copy.deepcopy(fa)
        params["outputPath"] = str((root / filename).resolve())
        cases[label] = request(label, method, params)
    cases["depreciation"] = request("depreciation", "fa.dep_export", {
        "path": end, "headerRow": 1, "mapping": mapping, "balanceSheetDate": "2025-12-31", "__forceDisk": True,
        "outputPath": str((root / "折旧测算.xlsx").resolve())})
    a = text("匹配A.csv", "名称\n华为技术有限公司\n北京华辰科技\n")
    b = text("匹配B.csv", "名称\n华为\n上海华辰科技\n")
    cases["fuzzy"] = request("fuzzy", "fuzzy.match", {"sourceA": {"path": a, "column": "名称", "headerRow": 1},
        "sourceB": {"path": b, "column": "名称", "headerRow": 1}, "matchType": "company", "__forceDisk": True,
        "__dbPath": str((root / "fuzzy-results.sqlite").resolve())})
    loan = text("借款台账.csv", "贷款方,本金,执行利率,开始日,到期日\n甲银行,1000000,4,2024-01-01,2026-12-31\n")
    cases["loan"] = request("loan", "loan.preview", {"mode": "ledger", "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
        "ledgerSource": {"source": {"inputPath": loan, "headerRow": 1, "headerDepth": 1},
            "mapping": {"lender": "贷款方", "principal": "本金", "rate": "执行利率", "startDate": "开始日", "endDate": "到期日"}}})
    deposit = text("存款TB.csv", "科目编码,科目名称,期初余额,期末余额,本年借方,本年贷方,方向\n100201,银行存款,1000000,1000000,0,0,借\n")
    source = {"inputPath": deposit, "headerRow": 1, "headerDepth": 1}
    tb_mapping = {"accountCode": "科目编码", "accountName": "科目名称", "openingFunctionalAmount": "期初余额",
                  "closingFunctionalAmount": "期末余额", "ytdFunctionalDebit": "本年借方", "ytdFunctionalCredit": "本年贷方", "direction": "方向"}
    cases["deposit"] = request("deposit", "deposit.preview", {"tbSource": source, "tbMapping": tb_mapping,
        "reportStart": "2025-01-01", "reportEnd": "2025-12-31", "dayBasis": "month12"})
    check_tb = text("核对TB.csv", "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n1001,库存现金,100,500,300,300\n2202,应付账款,-100,300,500,-300\n")
    je = text("核对JE.csv", "日期,凭证号,科目编码,科目名称,借方,贷方\n2025-03-01,V1,1001,库存现金,500,0\n2025-03-01,V1,2202,应付账款,0,500\n2025-06-01,V2,2202,应付账款,300,0\n2025-06-01,V2,1001,库存现金,0,300\n")
    check_mapping = {key: value for key, value in tb_mapping.items() if key != "direction"}
    cases["tbje"] = request("tbje", "tbje_check.run", {"tbSource": {**source, "inputPath": check_tb}, "tbMapping": check_mapping,
        "jeSource": {"inputPath": je, "headerRow": 1, "headerDepth": 1},
        "jeMapping": {"date": "日期", "id": "凭证号", "accountCode": "科目编码", "accountName": "科目名称", "functionalDebit": "借方", "functionalCredit": "贷方"}})
    return cases


def assert_case(label: str, result: dict, request: dict) -> None:
    if label in {"fa", "policy", "depreciation"}:
        output = Path(request["params"]["outputPath"])
        assert output.is_file() and output.stat().st_size > 1000, (label, result)
        assert result.get("outputPaths"), (label, result)
    elif label in {"loan", "deposit", "fuzzy"}:
        assert result.get("rows"), (label, result)
        if label == "fuzzy":
            assert result.get("processingMode") == "disk", result
            assert result["rows"][0]["matches"][0]["bValue"] == "华为", result
        else:
            expected = 40000.0 if label == "loan" else 500.0
            assert abs(result["rows"][0]["calculatedInterest"] - expected) < 0.01, (label, result)
    elif label == "tbje":
        for check in ["rollforward", "equation", "tbVsJe"]:
            assert result[check]["passed"] is True, (check, result)
