import { describe, expect, it } from "vitest";
import {
  fxAccountCurrencyDetail,
  fxAccountCurrencyOverrides,
  fxAllowedModes,
  fxApplyJobResult,
  fxAttachRole,
  fxDefaultMode,
  fxDetachRole,
  fxDropTargetAt,
  fxMergeJobResult,
  fxMissingRequired,
  fxPreviewTokenFor,
  fxReportStart,
  fxResolveAccountRoles,
  fxRunMappingReviews,
  granularityLabel,
  splitClassificationGroups,
  summarizeQuality,
  validationDetail,
  uncoveredDetail,
} from "./FxAuditPage";
describe("fx audit mode selection",()=>{
  it("uses two-point unrealized mode for TB only",()=>{expect(fxDefaultMode(false,true)).toBe("unrealized");expect(fxAllowedModes(false,true)).toEqual(["unrealized"])});
  it("uses realized mode for JE only",()=>expect(fxDefaultMode(true,false)).toBe("realized"));
  it("defaults to combined when both sources exist",()=>{expect(fxDefaultMode(true,true)).toBe("combined");expect(fxAllowedModes(true,true)).toEqual(["realized","unrealized","combined"])});
});
describe("fx audit upload and mapping parity",()=>{
  it("routes native drops by actual drop coordinates",()=>{const je={left:0,right:400,top:100,bottom:200};const tb={left:500,right:900,top:100,bottom:200};expect(fxDropTargetAt(200,150,je,tb)).toBe("je");expect(fxDropTargetAt(700,150,je,tb)).toBe("tb");expect(fxDropTargetAt(450,150,je,tb)).toBeUndefined()});
  it("shows missing required mappings like kanzhang",()=>{expect(fxMissingRequired("je",{},false,"默认主体")).toEqual(["记账日期","凭证识别字段","科目编码","科目名称","摘要","原币币种","原币金额方案","本位币金额方案"])});
  it("limits TB missing prompts to the fixed required field set",()=>{expect(fxMissingRequired("tb",{},true,"默认主体")).toEqual(["科目编码","科目名称","币种列或币种线索文本","期初原币或本位币余额","期末原币或本位币余额","本年累计（或本期）借/贷方发生额"])});
  it("accepts either original or functional TB balances at each endpoint",()=>{expect(fxMissingRequired("tb",{accountCode:"科目编码",accountName:"科目名称",currency:"币种",openingFunctionalAmount:"期初本币",closingForeignAmount:"期末原币",ytdFunctionalDebit:"借方",ytdFunctionalCredit:"贷方"},true,"默认主体")).toEqual([])});
  it("accepts a currency clue column when the TB has no currency column",()=>{expect(fxMissingRequired("tb",{accountCode:"科目编码",accountName:"科目名称",currencyText:"文本",openingFunctionalAmount:"期初本币",closingFunctionalAmount:"期末本币",ytdFunctionalDebit:"借方",ytdFunctionalCredit:"贷方"},true,"默认主体")).toEqual([])});
  it("still accepts the legacy combined account mapping",()=>{expect(fxMissingRequired("tb",{account:["科目代码","科目名称"],currency:"币种",openingFunctionalAmount:"期初本币",closingFunctionalAmount:"期末本币",ytdFunctionalDebit:"借方",ytdFunctionalCredit:"贷方"},true,"默认主体")).toEqual([])});
  it("prompts when neither ytd nor period debit/credit pairs are complete",()=>{const ytdOnlyDebit={accountCode:"科目编码",accountName:"科目名称",currency:"币种",openingFunctionalAmount:"期初本币",closingFunctionalAmount:"期末本币",ytdFunctionalDebit:"借方"};expect(fxMissingRequired("tb",ytdOnlyDebit,true,"默认主体")).toEqual(["本年累计（或本期）借/贷方发生额"]);const periodOk={...ytdOnlyDebit,periodFunctionalDebit:"本期借方",periodFunctionalCredit:"本期贷方"};expect(fxMissingRequired("tb",periodOk,true,"默认主体")).toEqual([])});
  it("未覆盖凭证把待确认与无法测算分开说", () => {
    // 用户实测的困惑：界面说「359 张待确认或无法测算」，可下面列出的凭证
    // 全都已经分好类了。两类的处理方式完全不同，合成一句会自相矛盾。
    expect(uncoveredDetail({pendingReviewCount:359,pendingUnclassifiedCount:0,pendingUnmeasurableCount:359}))
      .toBe("359 张已分类但缺重算证据");
    expect(uncoveredDetail({pendingReviewCount:10,pendingUnclassifiedCount:4,pendingUnmeasurableCount:6}))
      .toBe("4 张待确认分类；6 张已分类但缺重算证据");
    expect(uncoveredDetail({pendingReviewCount:0})).toBe("全部凭证均已纳入测算");
    // 旧结果没有拆分字段时退回总数，不假装知道构成。
    expect(uncoveredDetail({pendingReviewCount:7})).toBe("7 张未纳入测算");
  });

  it("derives the audit year start from the balance sheet date",()=>expect(fxReportStart("2024-12-31")).toBe("2024-01-01"));
  it("starts JE and TB mapping reviews from one action",async()=>{const started:string[]=[];const pending:Record<string,()=>void>={};const task=fxRunMappingReviews(kind=>new Promise<void>(resolve=>{started.push(kind);pending[kind]=resolve}));expect(started).toEqual(["je","tb"]);pending.je();pending.tb();await task});
  it("keeps preview data when export adds an output path",()=>{const preview={summary:{difference:12},voucherDetail:[{voucherId:"1"}]};const exported={summary:{difference:12},outputPaths:["workpaper.xlsx"]};expect(fxMergeJobResult(preview,exported)).toEqual({...preview,...exported})});
  it("keeps the last preview when a completion event has no result payload",()=>{const preview={summary:{difference:12}};expect(fxApplyJobResult(preview,undefined,"fx.preview")).toBe(preview)});
  it("accepts a preview result before the completed event",()=>{const preview={summary:{difference:12}};expect(fxApplyJobResult(undefined,preview,"fx.preview")).toEqual(preview)});
  it("merges export output into the visible preview instead of replacing it",()=>{const preview={summary:{difference:12},voucherDetail:[{voucherId:"1"}]};expect(fxApplyJobResult(preview,{outputPaths:["workpaper.xlsx"]},"fx.export")).toEqual({...preview,outputPaths:["workpaper.xlsx"]})});
  it("passes a real preview token only to export",()=>{const result={previewToken:"preview-123"};expect(fxPreviewTokenFor("fx.export",result)).toBe("preview-123");expect(fxPreviewTokenFor("fx.preview",result)).toBeUndefined();expect(fxPreviewTokenFor("fx.export",{})).toBeUndefined()});
  it("uses backend TB classification by code and preserves only manual overrides",()=>{
    const accounts=["1003 其他货币资金","6703 信用减值损失-应收账款","2602 租赁负债"];
    const resolved=fxResolveAccountRoles(
      accounts,
      {"1003 Other cash":"monetary_asset","6703 Credit impairment":"other_pnl"},
      {"2602 租赁负债":"monetary_liability"},
      {"2602 租赁负债":"non_monetary"},
      {"2602 租赁负债":true},
    );
    expect(resolved).toEqual({
      "1003 其他货币资金":"monetary_asset",
      "6703 信用减值损失-应收账款":"other_pnl",
      "2602 租赁负债":"non_monetary",
    });
  });
  it("replaces a stale automatic FX role with the latest backend cost-account role",()=>{
    const account="6401011101 营业成本-芯片-发票校验与收货差异";
    expect(fxResolveAccountRoles(
      [account],
      {[account]:"other_pnl"},
      {},
      {[account]:"fx_gain_loss"},
      {},
    )).toEqual({[account]:"other_pnl"});
  });
});

describe("同一列的多重映射", () => {
  it("币种线索文本可以叠加在科目名称上", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目名称", "accountName");
    m = fxAttachRole(m, "科目名称", "currencyText");
    expect(m.accountName).toEqual(["科目名称"]);
    expect(m.currencyText).toBe("科目名称");
  });

  it("换成别的字段时挤掉原有的正经角色，但留住币种线索", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目全称", "accountName");
    m = fxAttachRole(m, "科目全称", "currencyText");
    m = fxAttachRole(m, "科目全称", "accountCode");
    expect(m.accountName).toEqual([]);
    expect(m.accountCode).toBe("科目全称");
    expect(m.currencyText).toBe("科目全称");
  });

  it("两个正经角色不能共用一列", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "期初余额", "openingFunctionalAmount");
    m = fxAttachRole(m, "期初余额", "closingFunctionalAmount");
    expect(m.openingFunctionalAmount).toBe("");
    expect(m.closingFunctionalAmount).toBe("期初余额");
  });

  it("摘掉标记只影响指定的那一个", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目名称", "accountName");
    m = fxAttachRole(m, "科目名称", "currencyText");
    m = fxDetachRole(m, "科目名称", "currencyText");
    expect(m.accountName).toEqual(["科目名称"]);
    expect(m.currencyText).toBe("");
  });
});

describe("跨表对齐后的币种线索", () => {
  /**
   * 4800 的 TB 有独立「文本」列（`银行存款-建行USD4150-4800`），初次识别会把它
   * 当币种线索；跨表对齐发现它才是与 JE 同口径的科目名称，于是建议改映射。
   * 两个角色共用这一列即可——科目名称里写着账户币种正是线索的来源。
   */
  it("对齐把科目名称改到币种线索那一列时，线索角色要留住", () => {
    const before: Record<string, string | string[]> = {
      accountCode: "科目代码",
      accountName: ["科目名称一级", "科目名称二级"],
      currencyText: "文本",
    };
    const fix = {accountName: "文本"};
    // 展开带索引签名的对象时 TS 会丢掉索引签名，不标注的话 after 只剩 fix 里那一个键。
    const after: Record<string, string | string[]> = {...before, ...fix};
    expect(after.accountName).toBe("文本");
    expect(after.currencyText).toBe("文本");
    // 币种线索还在，就不会冒出「尚未映射：币种列或币种线索文本」。
    expect(fxMissingRequired("tb", {
      ...after,
      openingFunctionalAmount: "期初金额-本位币",
      closingFunctionalAmount: "期末金额-本位币",
    }, false, "3300")).not.toContain("币种列或币种线索文本");
  });
});

describe("TB 粒度不足提示", () => {
  it("按隔离类型给出用户看得懂的原因", () => {
    expect(granularityLabel("科目余额混合本位币与外币"))
      .toBe("科目余额里既有本位币又有外币，拆不开");
    expect(granularityLabel("同一科目存在多种外币敞口"))
      .toBe("同一科目持有多种外币，TB 只有合计数");
    expect(granularityLabel("无外币敞口的评估调整科目"))
      .toBe("评估调整科目，本身不持有外币");
    // 历史结果里的旧类型名也要有兜底，不能显示成空白。
    expect(granularityLabel("同一余额键存在多个外币"))
      .toBe("TB 未提供可唯一对应的原币币种");
    expect(granularityLabel(undefined)).toBe("TB 未提供可唯一对应的原币币种");
  });
});

describe("逐行数据质量归并", () => {
  it("按严重度排序并合并同类，隔离排在提示前面", () => {
    const groups = summarizeQuality([
      {type: "汇率缺失", severity: "提示", row: 5},
      {type: "同一科目存在多种外币敞口", severity: "隔离", row: 10, detail: "拆不出来"},
      {type: "同一科目存在多种外币敞口", severity: "隔离", row: 11},
      {type: "汇率缺失", severity: "提示", row: 6},
      {type: "汇率缺失", severity: "提示", row: 7},
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      severity: "隔离", type: "同一科目存在多种外币敞口", count: 2, detail: "拆不出来",
    });
    expect(groups[0].rows).toEqual([10, 11]);
    expect(groups[1]).toMatchObject({severity: "提示", type: "汇率缺失", count: 3});
  });
  it("示例行号最多留 5 个，不把几百行铺开", () => {
    const many = Array.from({length: 200}, (_, i) => ({type: "汇率缺失", severity: "隔离", row: i}));
    const [group] = summarizeQuality(many);
    expect(group.count).toBe(200);
    expect(group.rows).toHaveLength(5);
  });
  it("没有严重度或行号时不崩", () => {
    const [group] = summarizeQuality([{type: "未知"}]);
    expect(group).toMatchObject({severity: "提示", count: 1});
    expect(group.rows).toEqual([]);
  });
});

describe("凭证分类分两段", () => {
  const group = (key: string, items: Array<{voucherId: string; classification: string; measurementStatus?: string}>) =>
    ({key, label: key, items});
  it("组内还有待确认的归入『等你确认』，其余归入『算不出金额』", () => {
    const {undecided, unmeasurable} = splitClassificationGroups([
      group("A", [{voucherId: "1", classification: "待确认"}]),
      group("B", [{voucherId: "2", classification: "未实现汇兑损益", measurementStatus: "无法测算，未纳入结果"}]),
    ], {});
    expect(undecided.map(g => g.key)).toEqual(["A"]);
    expect(unmeasurable.map(g => g.key)).toEqual(["B"]);
  });
  it("用户改过的分类立刻生效——草稿优先于后端给的分类", () => {
    const groups = [group("A", [{voucherId: "1", classification: "待确认"}])];
    expect(splitClassificationGroups(groups, {"1": "已实现汇兑损益"}).undecided).toHaveLength(0);
    expect(splitClassificationGroups(groups, {"1": "已实现汇兑损益"}).unmeasurable).toHaveLength(1);
    // 反过来：后端判好了，用户手动改回待确认，就该重新进入待办
    const decided = [group("B", [{voucherId: "2", classification: "未实现汇兑损益"}])];
    expect(splitClassificationGroups(decided, {"2": "待确认"}).undecided).toHaveLength(1);
  });
  it("4800 的形态：360 张全部已分类，待确认段为空", () => {
    const many = Array.from({length: 12}, (_, i) =>
      group(`P${i}`, [{voucherId: `v${i}`, classification: "未实现汇兑损益", measurementStatus: "无法测算，未纳入结果"}]));
    const {undecided, unmeasurable} = splitClassificationGroups(many, {});
    expect(undecided).toHaveLength(0);
    expect(unmeasurable).toHaveLength(12);
  });
});

describe("校验未通过时展开具体原因", () => {
  it("把 detail 里的 errors 列成编号句子", () => {
    const detail = JSON.stringify({
      valid: false,
      errors: ["TB 缺少期初余额：原币或本位币余额至少映射一组", "JE 缺少主体列时必须指定固定主体"],
      warnings: ["无关紧要"],
    });
    expect(validationDetail(detail)).toBe(
      "具体是：1. TB 缺少期初余额：原币或本位币余额至少映射一组；2. JE 缺少主体列时必须指定固定主体",
    );
  });
  it("不是校验错误、解析失败或 errors 为空时不硬凑", () => {
    expect(validationDetail(undefined)).toBe("");
    expect(validationDetail("普通的错误描述")).toBe("");
    expect(validationDetail('{"errors":[]}')).toBe("");
    expect(validationDetail('{"errors": 这不是JSON')).toBe("");
  });
});

describe("科目币种覆盖", () => {
  const je = {
    "1002990001 过渡银行": { detected: "HKD", source: "币种列", seen: ["HKD", "JPY"], needsConfirmation: false },
  };
  const tb = {
    "1002990001 过渡银行": { detected: "USD", source: "本位币列", seen: ["USD"], needsConfirmation: true },
    "1122010001 应收账款": { detected: "USD", source: "本位币列", seen: ["USD"], needsConfirmation: true },
  };

  it("JE 的逐行币种优先于 TB 的单行结论，seen 取两边并集", () => {
    const detail = fxAccountCurrencyDetail("1002990001 过渡银行", je, tb);
    expect(detail.detected).toBe("HKD");
    expect(detail.source).toBe("币种列");
    expect(detail.seen).toEqual(["HKD", "JPY", "USD"]);
    expect(detail.fellBack).toBe(false);
  });

  it("只有 TB 且依据是本位币列时标记为未识别", () => {
    const detail = fxAccountCurrencyDetail("1122010001 应收账款", je, tb);
    expect(detail.detected).toBe("USD");
    expect(detail.fellBack).toBe(true);
  });

  it("两侧都没有该科目时视为未识别，不假装有结论", () => {
    const detail = fxAccountCurrencyDetail("9999 未知", je, tb);
    expect(detail.detected).toBe("");
    expect(detail.seen).toEqual([]);
    expect(detail.fellBack).toBe(true);
  });

  it("科目在数据里出现过多种币种时标记出来，防止被当成单币种指定", () => {
    expect(fxAccountCurrencyDetail("1002990001 过渡银行", je, tb).multiCurrency).toBe(true);
    expect(fxAccountCurrencyDetail("1122010001 应收账款", je, tb).multiCurrency).toBe(false);
    expect(fxAccountCurrencyDetail("9999 未知", je, tb).multiCurrency).toBe(false);
  });

  it("TB 与 JE 科目名拼法不同时按科目编码对上，JE 的真实币种传得到 TB 那一行", () => {
    // 4800 的实况：TB「1002990001 货币资金 货币资金-银行存款-过渡银行」，
    // JE「1002990001 过渡银行」，两边全名不同、编码相同。
    const detail = fxAccountCurrencyDetail(
      "1002990001 货币资金 货币资金-银行存款-过渡银行",
      je,
      tb,
    );
    expect(detail.detected).toBe("HKD");
    expect(detail.source).toBe("币种列");
    expect(detail.seen).toEqual(["HKD", "JPY", "USD"]);
  });

  it("留空的选择不进 payload，只传用户真正改过的", () => {
    expect(
      fxAccountCurrencyOverrides({ A: "", B: "hkd", C: "  ", D: " usd " }),
    ).toEqual({ B: "HKD", D: "USD" });
  });

  it("没有任何选择时传空对象，不影响后端自动识别", () => {
    expect(fxAccountCurrencyOverrides({})).toEqual({});
  });
});
