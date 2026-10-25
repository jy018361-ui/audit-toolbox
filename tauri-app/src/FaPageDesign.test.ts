import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");

describe("固定资产与凭证页视觉契约", () => {
  it.each(["FaListPage", "FaDepCalcPage", "FaPolicyComparePage", "FaTbJePage", "JeSignMarkPage"])(
    "%s 使用共享输入框",
    (name) => {
      expect(source(name)).toMatch(/<(?:Input|SourceTableControls)\b/);
      expect(source(name)).not.toMatch(/<input\b/);
    },
  );
  it("共用读取设置沿用共享输入框", () => {
    expect(source("components/SourceTableControls")).toContain("<Input");
    expect(source("components/SourceTableControls")).not.toMatch(/<input\b/);
  });
  it.each(["FaListPage", "FaPolicyComparePage"])(
    "%s 提供结果空状态",
    (name) => expect(source(name)).toContain("<EmptyState"),
  );
  it.each(["KanzhangParityPage", "JeSignMarkPage"])(
    "%s 无有效结果时隐藏结果卡，保留任务与输出展示",
    (name) => {
      const page = source(name);
      expect(page).not.toContain("<EmptyState");
      expect(page).toContain("return null;");
      expect(page).toContain("showProgress");
      expect(page).toContain("paths.length");
    },
  );
  it("FA TB+JE 工作区不重复展示静态灰色操作说明", () => {
    const page = source("FaTbJePage");
    expect(page).toContain("showDescription={false}");
    expect(page).not.toContain("系统按「上级科目 → 一级编码 → 名称」自动分类");
    expect(page).not.toContain("和序时账使用同一入口，可一次拖入两个文件");
  });

  it("FA 两期清单人工修改后可继续，导出复用上次匹配快照", () => {
    const page = source("FaListPage");
    expect(page).toContain('"开始匹配"');
    expect(page).toContain('"2. 匹配与导出"');
    expect(page).toContain("<h3>补充清单（可选）</h3>");
    expect(page).toContain("<h3>输出</h3>");
    expect(page).not.toContain('<h3>3. 输出</h3>');
    expect(page).not.toContain('disabled={!inspection || resultStale}');
    expect(page).not.toContain('disabled: !faStats || resultStale');
    expect(page).not.toContain('method === "fa.export" && resultStale');
    expect(page).toContain('导出也将基于该次匹配生成套表');
    expect(page).not.toContain('["companyName", "公司名称"]');
    expect(page).not.toContain('autoApply: false');
    expect(page).toContain('__restoreSnapshot');
    expect(page).toContain('期初 ${displayFileName(bPath)} ＋ 期末 ${displayFileName(ePath)}');
    expect(page).toContain('已从历史快照恢复两期清单，请复核文件、匹配 ID 与字段映射后继续。');
    // 2026-10 两步式改版：读取一律回到系统建议映射（用户拍板不保留人工
    // 调整），preserveMappings 通道整体移除，确认弹窗文案同步说明。
    expect(page).not.toContain("preserveMappings");
    expect(page).toContain("字段映射与匹配列将恢复为系统建议值");
  });

  it("FA TB+JE 显示逐文件识别进度并阻止导出旧结果", () => {
    const page = source("FaTbJePage");
    expect(page).toContain("onWorkbookStart:");
    expect(page).toContain("正在识别第 ${index + 1}/${total} 份");
    expect(page).toContain("const inspectedResults = await Promise.all(");
    expect(page).toContain("正在读取第 ${index + 1}/${selected.length} 份");
    expect(page).toContain('`${kind.toUpperCase()} ${fileName(item.path)}`');
    expect(page).toContain('method === "fa.tbje_export" && resultStale');
    expect(page).toContain("只看有差异");
  });

  it("FA 两步式与折旧政策页同构，匹配动作收进第 2 步", () => {
    const page = source("FaListPage");
    const policy = source("FaPolicyComparePage");
    expect(page).not.toContain("shouldAutoPrefillFaAddition");
    expect(page).not.toContain("supplementAutoHandled");
    expect(page).not.toContain("prefilledAddition");
    // 第 1 步三按钮与折旧政策页完全同文案：一条龙重读 / 只重跑复核 / 下一步。
    for (const label of ["读取表格 + LLM 复核", "LLM 重新复核", "下一步"]) {
      expect(page).toContain(label);
      expect(policy).toContain(label);
    }
    // 匹配不再出现在第 1 步；页面底部「有/没有」二选一推进随之移除。
    expect(page).not.toContain("有，进入补充清单");
    expect(page).not.toContain("没有，直接导出");
    expect(page).toContain('onClick={() => setStep(2)}');
    expect(page).not.toContain("setStep(3)");
    // 第 2 步集中匹配、补充清单与输出，顶部提供「上一步」返回配置。
    expect(page).toContain('{resultStale ? "重新开始匹配" : "开始匹配"}');
    expect(page).toContain("生成 FA List 底稿");
  });

  it("FA TB+JE 只在确认第一步时验证辅助字段，且科目清单只重读 TB", () => {
    const page = source("FaTbJePage");
    expect(page).not.toContain("useAuxiliaryLink");
    expect(page).toContain("const verified = await verifyAuxiliaryLink");
    expect(page).not.toContain("selectedAccounts:");
    expect(page).toContain('engineCall("deposit.inspect_tb"');
    expect(page).not.toContain('engineCall("deposit.inspect_je"');
    expect(page).toContain("auxiliaryPlan:");
  });

  it("FA 建议卡按实际状态措辞、文件槽回显文件名、回退按钮统一上一步", () => {
    const page = source("FaListPage");
    const policy = source("FaPolicyComparePage");
    // UI 审计 P3-8：待采纳建议的理由不得残留「已自动补上映射」式旧口径，
    // 与同卡「尚未改动，请逐条核对」的结论自相矛盾。
    expect(page).toContain("pendingReasonText(item.reason)");
    expect(page).toContain("已自动(?=补上|调整|修正)");
    // UI 审计 P2-6：选中文件后文件名以灰色胶囊回显（样式收在 fa-list.css）。
    expect(page).toContain('import "./fa-list.css"');
    expect(policy).toContain('import "./fa-list.css"');
    expect(policy).toContain('className="fa-file-slot"');
    // UI 审计 P3-1：与函证页一致，回退按钮统一叫「上一步」。
    expect(page).not.toContain("返回上一步");
    expect(policy).not.toContain("返回上一步");
  });

  it("FA 去掉选填未映射提示，资产ID键位显示两期命中徽章", () => {
    const page = source("FaListPage");
    // 黄色「选填未映射」提示整体移除：不再计算、不再渲染；
    // 必填缺失的红色「尚未映射」提示保留。
    expect(page).not.toContain("选填未映射");
    expect(page).not.toContain("fa-caption-optional");
    expect(page).not.toContain("faMissingOptionalRoles");
    expect(page).toContain("尚未映射");
    // 组合键逐位命中徽章：已命中走成功色、未命中走警示色，
    // 键位过期（刚增删键）时不出徽章。
    expect(page).toContain('"已命中"');
    expect(page).toContain('"未命中"');
    expect(page).toContain("faKeyPairingAt(");
    // 读取文件时存下 fa.inspect 附带的 keyPairing；手工调整键后防抖调
    // fa.key_check 只刷新显示，绝不反向改写用户选的键。
    expect(page).toContain("normalizeFaKeyPairing(value.keyPairing)");
    expect(page).toContain('"fa.key_check"');
    expect(page).toContain("keyPairingGeneration");
  });

  it("FA 多 Sheet 工作簿不自动复核，等用户确认 Sheet 后手动发起", () => {
    const page = source("FaListPage");
    // 复核按钮统一叫「LLM 重新复核」（与折旧政策页同文案）；多 Sheet
    // 暂停时靠提示语引导，不再切换按钮文案。
    expect(page).not.toContain("读表并复核");
    expect(page).toContain('"LLM 重新复核"');
    // 多 Sheet 暂停提示出现在复核按钮/复核面板附近，含两侧具体张数。
    expect(page).toContain("multiSheetReviewPending");
    expect(page).toContain("期初 {beginSheetTotal} 张、期末 {endSheetTotal} 张");
    expect(page).toContain("确认两侧 Sheet");
    // 自动复核两重门槛：非历史草稿恢复、两侧可见 Sheet 均 ≤1 张
    // （判定收在 faListUi 的纯函数里单测覆盖）。
    expect(page).toContain("!match &&");
    expect(page).toContain("shouldAutoReviewFaInspection(");
    // Sheet/标题行变更后旧复核作废：reinspectMain 先清空复核状态再重读，
    // 不拿 A 表的复核结论误导 B 表。
    expect(page).toContain("A 表的复核结论不能拿来背书 B 表");
  });
});
