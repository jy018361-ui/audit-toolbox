// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelDemoJob,
  DEMO_FLAG_KEY,
  demoJobLookup,
  demoLookup,
  demoReplayJobs,
  injectDemoJobEvent,
  registerDemoReplayJob,
  resumeDemoReplayJob,
  setDemoAutoPlayback,
  subscribeDemoJobs,
  type DemoJobEvent,
} from "./demoRegistry";

let sequence = 0;
const id = () => `demo-job-test-${++sequence}`;
const events: DemoJobEvent[] = [
  { phase: "queued", current: 0, total: 2, message: "排队", severity: "info", outputPaths: [] },
  { phase: "running", current: 1, total: 2, message: "处理", severity: "info", outputPaths: [] },
  { phase: "completed", current: 2, total: 2, message: "完成", severity: "success", outputPaths: ["C:\\结果.xlsx"], result: { rows: 2 } },
];

afterEach(() => {
  window.history.replaceState({}, "", "/");
  setDemoAutoPlayback(true);
  localStorage.removeItem(DEMO_FLAG_KEY);
  vi.useRealTimers();
});

describe("browser preview task replay", () => {
  it("缺币种开关只改变显式启用的浏览器 demo 验证返回", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    window.history.replaceState({}, "", "/?demo=1&demoCurrencyMissing=1");
    expect(demoLookup("ledger.currency_link")?.({})).toMatchObject({
      required: true, verified: false, missingCurrencies: ["USD", "HKD"], affectedGroupCount: 2,
      groups: [{ verified: false }, { verified: false }],
    });
    window.history.replaceState({}, "", "/?demo=1");
    expect(demoLookup("ledger.currency_link")?.({})).toMatchObject({ required: false, verified: true });
    localStorage.removeItem(DEMO_FLAG_KEY);
    window.history.replaceState({}, "", "/?demoCurrencyMissing=1");
    expect(demoLookup("ledger.currency_link")).toBeUndefined();
  });
  it("汇兑演示 TB 提供独立原币列与公共联动返回，能走到测算任务", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    const inspect = demoLookup("fx.inspect_tb")?.({ source: { sheet: "TB" } }) as {
      headers: string[];
      preview: string[][];
      suggestedMapping: Record<string, string>;
    };
    expect(inspect.suggestedMapping.openingForeignAmount).toBe("期初原币余额");
    expect(inspect.suggestedMapping.closingForeignAmount).toBe("期末原币余额");
    expect(inspect.preview.every((row) => row.length === inspect.headers.length)).toBe(true);
    expect(demoLookup("ledger.auxiliary_link")?.({ tbMapping: { auxiliary: "辅助核算" } })).toMatchObject({ status: "verified" });
    expect(demoLookup("ledger.currency_link")?.({})).toMatchObject({ required: false, verified: true });
  });

  it("holds automatic playback and injects terminal events through the normal listeners", () => {
    vi.useFakeTimers();
    setDemoAutoPlayback(false);
    const jobId = id();
    const seen: string[] = [];
    const unsubscribe = subscribeDemoJobs((event) => {
      if (event.jobId === jobId) seen.push(event.phase);
    });
    registerDemoReplayJob(jobId, "tbje_check.run_batch", "tbje_check", events);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual([]);
    expect(demoReplayJobs().find((job) => job.jobId === jobId)).toMatchObject({
      method: "tbje_check.run_batch", toolId: "tbje_check", plannedPhases: ["queued", "running", "completed"],
    });
    injectDemoJobEvent(jobId, "running", { message: "审计长文件名与错误排版" });
    const finished = injectDemoJobEvent(jobId, "completed");
    expect(seen).toEqual(["running", "completed"]);
    expect(finished?.result).toEqual({ rows: 2 });
    expect(finished?.outputPaths).toEqual(["C:\\结果.xlsx"]);
    expect(resumeDemoReplayJob(jobId)).toBe(false);
    unsubscribe();
  });

  it("can stop scheduled playback and later resume from the next event", () => {
    vi.useFakeTimers();
    setDemoAutoPlayback(true);
    const jobId = id();
    const seen: string[] = [];
    const unsubscribe = subscribeDemoJobs((event) => {
      if (event.jobId === jobId) seen.push(event.phase);
    });
    registerDemoReplayJob(jobId, "file_list.scan", "file_list_directory", events);
    vi.advanceTimersByTime(270);
    expect(seen).toEqual(["queued"]);
    setDemoAutoPlayback(false);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual(["queued"]);
    expect(resumeDemoReplayJob(jobId)).toBe(true);
    vi.advanceTimersByTime(600);
    expect(seen).toEqual(["queued", "running", "completed"]);
    unsubscribe();
  });

  it("emits a cancelled event when a preview job is stopped", () => {
    vi.useFakeTimers();
    setDemoAutoPlayback(false);
    const jobId = id();
    const seen: string[] = [];
    const unsubscribe = subscribeDemoJobs((event) => {
      if (event.jobId === jobId) seen.push(event.phase);
    });
    registerDemoReplayJob(jobId, "fx.run", "fx_audit", events);
    expect(cancelDemoJob(jobId)).toBe(true);
    expect(seen).toEqual(["cancelled"]);
    expect(injectDemoJobEvent(jobId, "completed")).toBeUndefined();
    unsubscribe();
  });

  it("按工具给注入的失败状态说明原因，不沿用之前的成功文案", () => {
    setDemoAutoPlayback(false);
    const jobId = id();
    registerDemoReplayJob(jobId, "pdf2excel.convert", "pdf_to_excel", events);
    injectDemoJobEvent(jobId, "running");
    const failed = injectDemoJobEvent(jobId, "failed");
    expect(failed?.phase).toBe("failed");
    expect(failed?.message).toMatch(/PDF 转换中断/);
    expect(failed?.outputPaths).toEqual([]);
  });

  it("补发终态缺省事件时沿用最近一次 running 的中断进度，不再落在完成的 100%", () => {
    vi.useFakeTimers();
    // 场景一（P3-2）：任务已播完（completed 2/2）再注入失败/取消，进度应为中断点而非 100%
    const finishedId = id();
    registerDemoReplayJob(finishedId, "fx.run", "fx_audit", events);
    vi.advanceTimersByTime(2_000);
    const failed = injectDemoJobEvent(finishedId, "failed");
    expect(failed?.current).toBe(1);
    expect(failed?.total).toBe(2);
    const cancelled = injectDemoJobEvent(finishedId, "cancelled");
    expect(cancelled?.current).toBe(1);
    expect(cancelled?.total).toBe(2);

    // 场景二：排队尚未开始就被取消，无 running 进度可沿用，停在 0 而不是虚构进度
    setDemoAutoPlayback(false);
    const queuedId = id();
    registerDemoReplayJob(queuedId, "fx.run", "fx_audit", events);
    const queuedCancel = injectDemoJobEvent(queuedId, "cancelled");
    expect(queuedCancel?.current).toBe(0);
  });
});

describe("browser preview shared engine handlers", () => {
  it("Excel 默认智能匹配演示返回可提交的模板、逐 Sheet 匹配和真实预览行", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    const path = "C:\\演示数据\\样例文件.xlsx";
    const preview = demoLookup("excel_merger.match_preview")?.({
      inputPaths: [path], templatePath: path, sheetAction: "merge_all", targetSheets: [],
    }) as {
      template: { path: string; headers: string[]; rawRows: string[][]; detection: { headerRow: number } };
      rows: Array<{ path: string; sheet: string; headers: string[]; matches: Array<{ target: number | null }>; preview: string[][]; rawRows: string[][] }>;
    };
    expect(preview.template.path).toBe(path);
    expect(preview.template.detection.headerRow).toBe(0);
    expect(preview.rows.map((row) => row.sheet)).toEqual(["销售出库单", "回款登记"]);
    for (const row of preview.rows) {
      expect(row.path).toBe(path);
      expect(row.matches).toHaveLength(row.headers.length);
      expect(row.rawRows[0]).toEqual(row.headers);
      expect(row.preview).toEqual(row.rawRows.slice(1));
    }
    expect(preview.rows[1].matches.at(-1)?.target).toBeNull();
    expect(demoLookup("excel_merger.match_preview")?.({
      inputPaths: [path], sheetAction: "match_selected", targetSheets: ["回款登记"],
    })).toMatchObject({ rows: [{ sheet: "回款登记" }] });
    expect(demoJobLookup("excel_merger.merge")).toBeTypeOf("function");
  });

  it("Excel 多 Sheet 演示成功态的处理数量与输出、警告一致", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    const events = demoJobLookup("excel_merger.merge")?.({
      inputPaths: ["C:\\演示数据\\样例文件.xlsx"],
      outputMode: "one_workbook",
    });
    expect(events?.find((event) => event.phase === "running")?.message).not.toContain("跳过");
    const completed = events?.find((event) => event.phase === "completed");
    expect(completed?.message).toContain("1 / 1 个文件");
    expect(completed?.outputPaths).toHaveLength(1);
    expect(completed?.result).toMatchObject({
      inputFiles: 1, fileCount: 1, rows: 3842, warnings: [],
      outputPaths: completed?.outputPaths,
    });
  });

  it("FA List 默认匹配结果与两侧导入预览一致，不把重复键异常混入正常导出链", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    const inspected = demoLookup("fa.inspect")?.({}) as {
      begin: { preview: unknown[][] };
      end: { preview: unknown[][] };
    };
    const completed = demoJobLookup("fa.match")?.({}).find((event) => event.phase === "completed");
    const result = completed?.result as {
      stats: { rows: number; both: number; beginOnly: number; endOnly: number; duplicates: { hasDuplicates: boolean } };
    };
    expect(result.stats).toMatchObject({
      rows: 18, both: 14, beginOnly: 2, endOnly: 2,
      duplicates: { hasDuplicates: false },
    });
    expect(result.stats.rows).toBe(result.stats.both + result.stats.beginOnly + result.stats.endOnly);
    expect(inspected.begin.preview).toHaveLength(result.stats.both + result.stats.beginOnly);
    expect(inspected.end.preview).toHaveLength(result.stats.both + result.stats.endOnly);
  });

  it("keeps FX currency mappings while preserving the TBJE sheet fixture", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    const inspectTb = demoLookup("fx.inspect_tb");

    const fx = inspectTb?.({ source: { sheet: "TB" } }) as {
      suggestedMapping?: Record<string, unknown>;
    };
    const tbje = inspectTb?.({ source: { sheet: "科目余额表" } }) as {
      suggestedMapping?: Record<string, unknown>;
    };

    expect(fx.suggestedMapping).toMatchObject({
      currency: "币种",
      openingFunctionalAmount: "期初余额",
      closingFunctionalAmount: "期末余额",
    });
    expect(tbje.suggestedMapping).toMatchObject({
      accountCode: "科目编码",
      closingFunctionalAmount: "期末余额",
    });
    expect(tbje.suggestedMapping).not.toHaveProperty("currency");
  });
});
