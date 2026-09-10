import { useEffect, useRef, useState } from "react";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  listenPositionedFileDrops,
  openOutput,
  pickPath,
} from "./api";
import { depositDropTargetInside } from "./DepositInterestPage";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { StepIndicator } from "@/components/StepIndicator";
import { EmptyState } from "@/components/EmptyState";
import { displayFileName } from "@/fileDisplay";
import {
  applyLedgerReviewToDict,
  correctLedgerSourceKinds,
  missingGoldIdentity,
  resolveRoleLabels,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  type LedgerWorkbookSheetClassification,
} from "@/ledgerMapping";
import {
  describeLoanForm,
  loanRoleRequirement,
  resolveLoanForm,
  type LoanForm,
  type LoanRole,
} from "@/loanForms";
import { formGroups, useLedgerForms, type LedgerFormKind } from "@/ledgerForms";
import {
  loanBps,
  loanRateDefaults,
  loanRateOverrides,
  loanRateValue,
  loanReportStart,
  resolveLoanRates,
  type LoanRateSetting,
} from "@/loanRateTypes";
import { MappingPanel } from "@/components/MappingPanel";
import { JargonTip } from "@/components/JargonTip";
import { NumberInput } from "@/components/NumberInput";
import { errorText } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./loan-interest.css";
// 来源卡与统一上传框的样式（fx-source-grid／fx-source-card／fx-detected-file）
// 与其他账表工具共用，定义在 fx-audit.css。
import "./fx-audit.css";

type Mode = "ledger" | "tb";
type Kind = "ledger" | "tb" | "je" | "rateLedger";
type Inspection = {
  headers: string[];
  preview: string[][];
  rowCount: number;
  sheet: string;
  sheets: string[];
  headerRow: number;
  headerDepth: number;
  suggestedMapping: Record<string, string>;
  // 台账专有：角色清单与四型定义由引擎随识别结果下发（唯一定义在 Rust）。
  roles?: LoanRole[];
  forms?: LoanForm[];
};
type Source = {
  path: string;
  inspection?: Inspection;
  mapping: Record<string, string>;
};
type LoanRow = {
  loanId: string;
  openingPrincipal: number;
  additions: number;
  reductions: number;
  closingPrincipal: number;
  /** 台账期末余额原值；无期末列或期外借款为 null，此时推算期末即全部信息。 */
  ledgerClosing?: number | null;
  rateType: "fixed" | "floating";
  fixedRate?: number;
  benchmarkRate?: number;
  spreadBps?: number;
  calculatedInterest?: number;
  matchStatus?: string;
  matchBasis?: string;
};
type ResultRateEdit = Partial<
  Pick<LoanRow, "rateType" | "fixedRate" | "benchmarkRate" | "spreadBps">
>;
/** TB 模式「利率确认」：粘贴的利率区域与 TB 借款明细匹配后的逐笔利率。 */
type PasteRateRow = {
  loanId: string;
  rateType: "fixed" | "floating";
  fixedRate?: number;
  benchmarkRate?: number;
  spreadBps?: number;
  matchStatus?: string;
  matchBasis?: string;
};
/** 与 Rust `ledger_mapping::loan_roles()` 同名同序的兜底清单（浏览器预览模式用）。 */
const LOAN_ROLE_FALLBACK: Record<string, string> = {
  principal: "本金",
  openingPrincipal: "期初余额",
  closingPrincipal: "期末余额",
  startDate: "起始日",
  endDate: "到期日",
  term: "期限",
  rate: "利率",
  rateType: "利率类型",
  drawdownAmount: "本期新增",
  repaymentAmount: "本期归还",
  loanId: "借款标识",
  lender: "贷款方",
  currency: "币种",
  drawdownDate: "新增借款日期",
  repaymentDate: "还款日期",
  repaymentMethod: "还本方式",
  loanStatus: "借款状态",
  benchmarkRate: "基准利率",
  spreadBps: "加/减点（BP）",
  remark: "备注",
};
const LABELS: Record<Kind, Record<string, string>> = {
  // 台账角色以引擎下发的 `inspection.roles` 为准；这里这份是浏览器预览模式的兜底，
  // 必须与 Rust `ledger_mapping::loan_roles()` 同名同序。
  ledger: LOAN_ROLE_FALLBACK,
  tb: {
    entity: "核算主体",
    accountCode: "借款科目编码",
    accountName: "借款科目名称",
    loanId: "借款明细/辅助核算",
    currency: "币种",
    openingDirection: "期初方向",
    closingDirection: "期末方向",
    openingFunctionalAmount: "期初余额（净额）",
    openingFunctionalDebit: "期初借方余额",
    openingFunctionalCredit: "期初贷方本金",
    closingFunctionalAmount: "期末余额（净额）",
    closingFunctionalDebit: "期末借方余额",
    closingFunctionalCredit: "期末贷方本金",
    ytdFunctionalDebit: "本年累计借方（还款）",
    ytdFunctionalCredit: "本年累计贷方（新增）",
  },
  je: {
    date: "记账日期",
    id: "凭证号",
    accountCode: "借款科目编码",
    accountName: "借款科目名称",
    loanId: "借款明细/辅助核算",
    summary: "摘要",
    functionalDebit: "借方金额",
    functionalCredit: "贷方金额",
    functionalAmount: "有符号金额",
    direction: "借贷方向",
  },
  rateLedger: LOAN_ROLE_FALLBACK,
};
/**
 * 借款页当前的映射状态与 MappingPanel 交互是“一角色一列”。
 *
 * 公共复核默认会把 accountName / id 等角色保存成数组；若直接写回
 * 本页的纯字符串状态，下一次渲染会在 loanMissing 中对数组调用
 * `.trim()` 并导致 WebView 白屏。在借款页边界显式关闭多列角色，与页面的
 * MappingPanel（未开启 multi）保持一致。Rust 引擎本身可接受数组，
 * 但页面尚未提供多列角色的手工编辑语义。
 */
const LOAN_SINGLE_COLUMN_ROLES = new Set<string>();
/** 底稿反馈里只展示文件名，完整路径放 title 悬浮提示。 */
function fileNameOf(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
export function loanEffectiveRate(
  type: string,
  fixed?: number,
  benchmark?: number,
  bps = 0,
) {
  return type === "floating" && benchmark != null
    ? Number(benchmark) + Number(bps) / 10000
    : Number(fixed ?? Number(benchmark ?? 0) + Number(bps) / 10000);
}
export function loanEquation(
  r: Pick<
    LoanRow,
    | "openingPrincipal"
    | "additions"
    | "reductions"
    | "closingPrincipal"
    | "ledgerClosing"
  >,
): number | null {
  // 差异＝推算期末（期初＋增加－减少）－台账期末；台账无期末列时无从对照，
  // 不出假 0，返回 null 让界面显示为空。有账面数的行差异是真实的独立勾稽。
  if (r.ledgerClosing == null) return null;
  return (
    r.openingPrincipal +
    r.additions -
    r.reductions -
    r.ledgerClosing
  );
}
/** TB/JE 的余额与科目走统一角色名，同一语义有几种写法时任一到位即可。 */
const ANY_OF: Record<string, string[][]> = {
  tb: [
    ["accountCode", "accountName", "account"],
    [
      "openingFunctionalAmount",
      "openingFunctionalDebit",
      "openingFunctionalCredit",
      "openingPrincipal",
    ],
    [
      "closingFunctionalAmount",
      "closingFunctionalDebit",
      "closingFunctionalCredit",
      "closingPrincipal",
    ],
  ],
  je: [["date"], ["accountCode", "accountName", "account"]],
};
const ANY_OF_LABEL: Record<string, string[]> = {
  tb: ["借款科目", "期初余额", "期末余额"],
  je: ["记账日期", "借款科目"],
};
/**
 * 尚未映射的必填项。
 *
 * TB／JE 走金标身份槽 ∪ 本工具必填；**借款台账与利率台账按形态判定**——
 * 必填项随命中的型号变（类型1 要到期日、类型2 要期限、类型3／5 要期间发生额），
 * 不是一张固定清单。此前这里写死「期初本金＋期末本金＋利率类型」四项，
 * 是类型3／5 的口径，套在最常见的类型1 台账上必然误报（那种表根本没有期初列，
 * 利率直接给数值也没有利率类型列），台账模式因此一直点不动测算。
 */
export function loanMissing(
  kind: Kind,
  m: Record<string, string>,
  forms?: LoanForm[],
) {
  const filled = (role: string) => Boolean(m[role]?.trim());
  const groups = ANY_OF[kind];
  if (groups) {
    const gold = missingGoldIdentity(kind === "tb" ? "tb" : "je", (role) =>
      role === "accountCode" || role === "accountName"
        ? filled(role) || filled("account")
        : filled(role),
    );
    const own = groups
      .map((g, i) => (g.some(filled) ? "" : ANY_OF_LABEL[kind][i]))
      .filter(Boolean);
    // 借款科目在金标身份槽里已经报过，本工具的「借款科目」组不再重复报。
    return [...new Set([...gold, ...own])];
  }
  // 利率台账是选填资料，映射不全不拦（用户可在变动表里逐笔手填利率）。
  if (kind === "rateLedger") return [];
  // 引擎没下发形态表（浏览器预览模式）时不拦，让后端去报。
  if (!forms?.length) return [];
  const hit = resolveLoanForm(forms, m);
  if (!hit || hit.complete) return [];
  const label = (role: string) => LOAN_ROLE_FALLBACK[role] ?? role;
  return [
    ...hit.missing.map(label),
    ...hit.missingAny.map((slot) => `${slot.map(label).join("／")}（任一）`),
    ...hit.partialOptional.map(label),
  ];
}

export function LoanInterestPage({ tool }: { tool: ToolManifest }) {
  const empty = (): Source => ({ path: "", mapping: {} });
  const [mode, setMode] = useState<Mode>("ledger");
  const [sources, setSources] = useState<Record<Kind, Source>>({
    ledger: empty(),
    tb: empty(),
    je: empty(),
    rateLedger: empty(),
  });
  const [reportEnd, setReportEnd] = useState("");
  const [rateEdits, setRateEdits] = useState<
    Record<number, Partial<LoanRateSetting>>
  >({});
  const [outputPath, setOutputPath] = useState("");
  const [rows, setRows] = useState<LoanRow[]>([]);
  // 利率确认（TB 模式）：用户从 Excel 复制粘贴的利率区域原文，与匹配出的逐笔利率。
  // 粘贴原文保留（方便换映射后一键重匹配），匹配结果随 TB 来源/映射变化作废。
  /** 「确认科目与利率」步骤：TB 末级科目清单（loan.tb_accounts 下发）。 */
  const [tbAccounts, setTbAccounts] = useState<
    { key: string; code: string; name: string; account: string; opening: number; closing: number }[]
  >([]);
  const [accountsBusy, setAccountsBusy] = useState(false);
  /** 科目角色确认：行键 → 借款科目/排除；预选规则为名称含「借款/贷款」。 */
  const [loanAccountRoles, setLoanAccountRoles] = useState<Record<string, "loan" | "skip">>({});
  /** 利率手填：行标识 → 利率口径（叠加在 preview 借款行之上）。 */
  const [tbRateEdits, setTbRateEdits] = useState<Record<string, PasteRateRow>>({});
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [pairStatus, setPairStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [job, setJob] = useState<JobEvent>();
  const activeJob = useRef("");
  // TB＋JE 统一上传框：拖放命中以这个框的坐标为准（台账模式不渲染，自然不响应）。
  const uploadDropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = listenJobEvents((e) => {
      if (e.jobId !== activeJob.current) return;
      setJob(e);
      if (e.phase === "completed") {
        setBusy(false);
        const next = e.result as Record<string, unknown>;
        setResult(next);
        setRows((next.rows ?? []) as LoanRow[]);
      } else if (e.phase === "failed" || e.phase === "cancelled") {
        setBusy(false);
        const p = e.result as { error?: { userMessage?: string } } | undefined;
        setError(p?.error ? errorText(p.error) : e.message);
      }
    });
    return () => {
      void stop.then((x) => x());
    };
  }, []);
  // TB＋JE 模式支持把两个文件整组拖进上传框，与存款利息／FA 一致。
  useEffect(() => {
    const drops = listenPositionedFileDrops(({ paths, x, y }) => {
      if (
        !depositDropTargetInside(
          x,
          y,
          uploadDropRef.current?.getBoundingClientRect(),
        )
      )
        return;
      void classifyAndInspect(paths);
    });
    return () => {
      void drops.then((unlisten) => unlisten());
    };
  }, []);
  const [resultRateEdits, setResultRateEdits] = useState<
    Record<string, ResultRateEdit>
  >({});
  const invalidateResults = () => {
    activeJob.current = "";
    setRows([]);
    setResult(undefined);
    setResultRateEdits({});
    setJob(undefined);
  };
  const setSource = (kind: Kind, next: Partial<Source>) => {
    invalidateResults();
    if (kind === "ledger") setRateEdits({});
    // TB 的文件/Sheet/映射一变，借款行清单就可能变：科目确认与手填利率作废，
    // 回到第二步重新确认。
    if (kind === "tb") {
      setTbAccounts([]);
      setLoanAccountRoles({});
      setTbRateEdits({});
    }
    setSources((v) => ({ ...v, [kind]: { ...v[kind], ...next } }));
  };
  const activeKinds: Kind[] = mode === "ledger" ? ["ledger"] : ["tb", "je"];
  const sourcesReady = activeKinds.every((kind) => sources[kind].inspection);
  const mappingsReady =
    sourcesReady &&
    activeKinds.every(
      (kind) =>
        loanMissing(
          kind,
          sources[kind].mapping,
          sources[kind].inspection?.forms,
        ).length === 0,
    );
  // 逐行利率口径：默认值由台账的「利率」「利率类型」两列现算（改映射立刻跟着变），
  // 用户的手工改动单独存在 rateEdits 里叠上去，两者互不覆盖。
  const ledgerInspection = sources.ledger.inspection;
  const rateDefaults = ledgerInspection
    ? loanRateDefaults(
        ledgerInspection.preview,
        ledgerInspection.headers,
        sources.ledger.mapping,
      )
    : [];
  const rateRows = resolveLoanRates(rateDefaults, rateEdits);
  const editRate = (index: number, patch: Partial<LoanRateSetting>) => {
    invalidateResults();
    setRateEdits((v) => ({ ...v, [index]: { ...v[index], ...patch } }));
  };
  const editResultRate = (index: number, patch: ResultRateEdit) => {
    const id = rows[index].loanId;
    setRows((v) =>
      v.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setResultRateEdits((v) => ({ ...v, [id]: { ...v[id], ...patch } }));
  };
  // 步骤 2 停在"可选的利率确认"上时，禁用的下一步其实卡的是步骤 1 的映射——
  // 把缺什么明说并给一键返回，不让用户在可选步骤上猜哪里没完成。
  const mappingGaps = activeKinds.flatMap((kind) =>
    loanMissing(
      kind,
      sources[kind].mapping,
      sources[kind].inspection?.forms,
    ).map((item) => `${kind.toUpperCase()}：${item}`),
  );
  /** 进入「确认科目与利率」步骤时拉取 TB 末级科目清单并按名称预选。 */
  async function loadTbAccounts() {
    if (!sources.tb.inspection || accountsBusy) return;
    setAccountsBusy(true);
    setError("");
    try {
      const res = (await engineCall("loan.tb_accounts", {
        tbSource: source("tb"),
      })) as {
        accounts: { key: string; code: string; name: string; account: string; opening: number; closing: number }[];
      };
      setTbAccounts(res.accounts ?? []);
      setLoanAccountRoles(
        Object.fromEntries(
          (res.accounts ?? []).map((a) => [
            a.key,
            /借款|贷款/.test(a.name || a.account) ? "loan" : "skip",
          ]),
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAccountsBusy(false);
    }
  }
  useEffect(() => {
    if (step === 1 && mode === "tb" && sources.tb.inspection && !tbAccounts.length) {
      void loadTbAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mode, sources.tb.inspection]);
  const selectedLoanAccounts = () =>
    tbAccounts
      .filter((a) => loanAccountRoles[a.key] === "loan")
      .map((a) => a.key);
  /** 导出利率确认表模板（带入已填值），用户在 Excel 补填后经 importRates 回读。 */
  async function exportRateTemplate() {
    const target = await pickPath("save", "保存利率确认表", ["xlsx"], "借款利率确认表.xlsx");
    if (typeof target !== "string") return;
    setBusy(true);
    setError("");
    try {
      await engineCall("loan.rate_template", {
        tbSource: source("tb"),
        jeSource: source("je"),
        loanAccounts: selectedLoanAccounts(),
        rateRows: Object.entries(tbRateEdits).map(([id, r]) => ({ ...r, loanId: id })),
        outputPath: target,
      });
      setRateNoteText(`利率确认表已导出：${target}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function importRates() {
    const picked = await pickPath("file", "选择已填写的利率确认表", ["xlsx"]);
    if (typeof picked !== "string") return;
    setBusy(true);
    setError("");
    try {
      const res = (await engineCall("loan.import_rates", {
        inputPath: picked,
      })) as { rateRows: PasteRateRow[] };
      const incoming = res.rateRows ?? [];
      setTbRateEdits((current) => {
        const next = { ...current };
        for (const row of incoming) {
          const hit = Object.keys(next).find(
            (k) => k.trim() === row.loanId.trim(),
          );
          next[hit ?? row.loanId] = row;
        }
        return next;
      });
      setRateNoteText(`已回读 ${incoming.length} 行利率。`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const editTbRate = (loanId: string, patch: Partial<PasteRateRow>) => {
    setTbRateEdits((v) => {
      const prev = v[loanId] ?? { rateType: "fixed" as const };
      const base: PasteRateRow = { ...prev, ...patch };
      return { ...v, [loanId]: { ...base, loanId } };
    });
  };
  const [rateNoteText, setRateNoteText] = useState("");
  async function browse(kind: Kind) {
    const picked = await pickPath("file", "选择表格文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
    ]);
    if (typeof picked !== "string") return;
    setSource(kind, { path: picked, inspection: undefined, mapping: {} });
    await inspect(kind, picked);
  }
  async function browsePair() {
    const picked = await pickPath("files", "选择 TB 或序时账文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
    ]);
    if (!picked) return;
    void classifyAndInspect(Array.isArray(picked) ? picked : [picked]);
  }
  /** TB＋JE 统一上传入口：与其他账表工具一致，先公共引擎自动分类再逐侧识别。 */
  async function classifyAndInspect(selected: string[]) {
    const files = selected.filter((p) =>
      /\.(xlsx?|xlsm|csv|txt|tsv)$/i.test(p),
    );
    if (!files.length) return;
    // 重新选择一组 TB/JE 时旧识别与映射整体失效，避免只换一侧时另一侧
    // 仍沿用旧账套；利率台账是独立补充资料，保留。
    setSources((v) => ({ ...v, tb: empty(), je: empty() }));
    invalidateResults();
    setBusy(true);
    setError("");
    setPairStatus("正在通过公共账表引擎逐 Sheet 识别…");
    const failures: string[] = [];
    try {
      const scan =
        await scanLedgerUploadSources<LedgerWorkbookSheetClassification>(
          engineCall,
          files,
        );
      failures.push(
        ...scan.failures.map(
          (failure) => `${fileNameOf(failure.path)}：${errorText(failure.error)}`,
        ),
      );
      const picked = selectLedgerSourcePair(scan.sources);
      // inspect 内部自带错误提示，这里只汇总分类阶段的失败。
      for (const item of picked) {
        await inspect(item.kind, item.path, {
          sheet: item.classification.sheet,
          headerRow: 0,
          headerDepth: 0,
        });
      }
      setPairStatus(
        `${picked.length} 个账表来源已识别${scan.hiddenSheets ? `；${scan.hiddenSheets} 张低置信度 Sheet 已忽略` : ""}。`,
      );
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }
  /** 来源卡上的单侧更换：按该侧既定类型直接读取新文件（Sheet 重新自动识别）。 */
  async function replaceSource(kind: "tb" | "je") {
    const picked = await pickPath(
      "file",
      kind === "tb" ? "更换 TB 科目余额表" : "更换 JE 序时账",
      ["xlsx", "xls", "xlsm", "csv", "txt", "tsv"],
    );
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    setPairStatus(`正在按 ${kind.toUpperCase()} 读取 ${fileNameOf(path)}…`);
    const x = await inspect(kind, path, {
      sheet: "",
      headerRow: 0,
      headerDepth: 0,
    });
    setPairStatus(
      x ? `${kind.toUpperCase()} 已更换为 ${fileNameOf(path)}。` : "",
    );
  }
  /** 来源卡上的「更正为 TB/JE」：目标槽被占时交换两侧，全部按新类型重新识别。 */
  async function changeSourceKind(from: "tb" | "je", to: "tb" | "je") {
    const current = sources[from];
    const occupied = sources[to];
    if (!current.path || !current.inspection) return;
    setBusy(true);
    setError("");
    setPairStatus(`正在更正为 ${to.toUpperCase()}，并按新类型重新识别…`);
    try {
      const changed = await correctLedgerSourceKinds<Inspection>(
        from,
        to,
        { path: current.path, inspection: current.inspection },
        occupied.path && occupied.inspection
          ? { path: occupied.path, inspection: occupied.inspection }
          : undefined,
        async (kind, src) =>
          (await engineCall("loan.inspect", {
            kind,
            source: {
              inputPath: src.path,
              sheet: src.inspection.sheet,
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Inspection,
      );
      setSources((v) => ({ ...v, tb: empty(), je: empty() }));
      for (const item of changed)
        applyInspection(item.kind, item.path, item.inspection);
      setPairStatus(
        changed.length > 1
          ? "TB 与 JE 来源已交换，并按新类型重新识别。"
          : `${fileNameOf(current.path)} 已更正为 ${to.toUpperCase()}。`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(
    kind: Kind,
    path = sources[kind].path,
    over?: Partial<Inspection>,
  ): Promise<Inspection | undefined> {
    setBusy(true);
    setError("");
    try {
      const old = sources[kind].inspection;
      const x = (await engineCall("loan.inspect", {
        kind,
        source: {
          inputPath: path,
          sheet: over?.sheet ?? old?.sheet ?? "",
          headerRow: over?.headerRow ?? old?.headerRow ?? 0,
          // 0 = 让引擎自动判定层数（TB/JE 走 fx 内核推断；台账固定单层）。
          headerDepth: over?.headerDepth ?? old?.headerDepth ?? 0,
        },
      })) as Inspection;
      applyInspection(kind, path, x);
      return x;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  /** 把识别结果落到对应来源：存档映射顶回建议映射（一次性消费），其余用建议值。 */
  function applyInspection(kind: Kind, path: string, x: Inspection) {
    // 历史恢复后重新识别同一文件：存档映射顶回建议映射，一次性消费；
    // 换文件照旧用建议值。
    const stash = restoredLoanMappings.current[kind];
    const samePath = (a: string, b: string) =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const mapping =
      stash && samePath(stash.path, path)
        ? stash.mapping
        : (x.suggestedMapping ?? {});
    if (stash && samePath(stash.path, path))
      restoredLoanMappings.current[kind] = undefined;
    setSource(kind, { path, inspection: x, mapping });
    if (kind === "ledger") setRateEdits({});
  }
  function source(kind: Kind) {
    const x = sources[kind];
    return x.path
      ? {
          source: {
            inputPath: x.path,
            sheet: x.inspection?.sheet ?? "",
            headerRow: x.inspection?.headerRow ?? 1,
            headerDepth: x.inspection?.headerDepth ?? 1,
          },
          mapping: x.mapping,
        }
      : undefined;
  }
  function payload() {
    return {
      mode,
      reportStart: loanReportStart(reportEnd),
      reportEnd,
      ledgerRateOverrides:
        mode === "ledger"
          ? loanRateOverrides(rateDefaults, rateEdits)
          : undefined,
      ledgerSource: source("ledger"),
      tbSource: source("tb"),
      jeSource: source("je"),
      // TB 模式：确认的借款科目清单 + 「确认科目与利率」步骤手填/回读的利率。
      // 引擎按借款行标识归一化对应，优先于利率台账文件（后者仅历史任务恢复用）。
      loanAccounts: mode === "tb" ? selectedLoanAccounts() : undefined,
      rateRows:
        mode === "tb" && Object.keys(tbRateEdits).length
          ? Object.values(tbRateEdits).map((r) => ({
              loanId: r.loanId,
              rateType: r.rateType,
              fixedRate: r.fixedRate,
              benchmarkRate: r.benchmarkRate,
              spreadBps: r.spreadBps,
            }))
          : undefined,
      rateLedgerSource: source("rateLedger"),
      rateOverrides: resultRateEdits,
      ...(outputPath ? { outputPath } : {}),
    };
  }

  // 历史记录「继续任务」：回填台账/TB/JE/利率台账路径、模式与映射；Sheet 等
  // 识别信息以存档参数重建最小 Inspection，不点「重新识别」也能直接测算。
  // 逐行利率的手工改动依赖台账预览现算默认值，恢复后需在识别后重设。
  // restoredLoanMappings：用户重新识别同一文件时，inspect 完成会把映射重设
  // 为建议值——这里把存档映射顶回，逐来源一次性消费。
  const restoredLoanMappings = useRef<
    Partial<Record<Kind, { path: string; mapping: Record<string, string> }>>
  >({});
  useTaskRestore(tool.id, (restore) => {
    type LoanSourceParams = {
      source?: {
        inputPath?: string;
        sheet?: string;
        headerRow?: number;
        headerDepth?: number;
      };
      mapping?: Record<string, string>;
    };
    const p = restore.params as {
      mode?: string;
      reportEnd?: string;
      ledgerSource?: LoanSourceParams;
      tbSource?: LoanSourceParams;
      jeSource?: LoanSourceParams;
      rateLedgerSource?: LoanSourceParams;
      rateRows?: PasteRateRow[];
      loanAccounts?: string[];
      outputPath?: string;
    };
    const paramsKey: Record<Kind, keyof typeof p> = {
      ledger: "ledgerSource",
      tb: "tbSource",
      je: "jeSource",
      rateLedger: "rateLedgerSource",
    };
    const next: Record<Kind, Source> = {
      ledger: empty(),
      tb: empty(),
      je: empty(),
      rateLedger: empty(),
    };
    let restoredAny = false;
    for (const kind of ["ledger", "tb", "je", "rateLedger"] as Kind[]) {
      const src = p[paramsKey[kind]] as LoanSourceParams | undefined;
      if (!src?.source) continue;
      const path =
        typeof src.source.inputPath === "string" ? src.source.inputPath : "";
      if (!path) continue;
      restoredAny = true;
      next[kind] = {
        path,
        mapping:
          src.mapping && typeof src.mapping === "object" ? src.mapping : {},
        inspection: {
          sheet: src.source.sheet ?? "",
          headerRow: src.source.headerRow ?? 1,
          headerDepth: src.source.headerDepth ?? 1,
        } as Inspection,
      };
    }
    if (!restoredAny) return;
    for (const kind of ["ledger", "tb", "je", "rateLedger"] as Kind[]) {
      const mapping = next[kind].mapping;
      restoredLoanMappings.current[kind] =
        next[kind].path && Object.keys(mapping).length
          ? { path: next[kind].path, mapping }
          : undefined;
    }
    invalidateResults();
    setSources(next);
    setRateEdits({});
    // 「确认科目与利率」的选择一并回填：确认清单按行键恢复，利率按行标识恢复。
    if (Array.isArray(p.loanAccounts))
      setLoanAccountRoles(
        Object.fromEntries(
          (p.loanAccounts as string[]).map((key) => [key, "loan" as const]),
        ),
      );
    if (Array.isArray(p.rateRows))
      setTbRateEdits(
        Object.fromEntries(
          (p.rateRows as PasteRateRow[]).map((r) => [String(r.loanId), r]),
        ),
      );
    if (p.mode === "ledger" || p.mode === "tb") setMode(p.mode);
    if (typeof p.reportEnd === "string" && p.reportEnd)
      setReportEnd(p.reportEnd);
    setOutputPath(typeof p.outputPath === "string" ? p.outputPath : "");
    setStep(2);
    setBusy(false);
    setError("");
  });
  async function run(method: "loan.preview" | "loan.export") {
    setError("");
    if (!reportEnd) return setError("请选择资产负债表日。");
    for (const kind of activeKinds) {
      if (!sources[kind].inspection)
        return setError(`请先上传并识别${kind.toUpperCase()}。`);
      const missing = loanMissing(
        kind,
        sources[kind].mapping,
        sources[kind].inspection?.forms,
      );
      if (missing.length)
        return setError(
          `${kind.toUpperCase()}尚未映射：${missing.join("、")}。`,
        );
    }
    setBusy(true);
    try {
      activeJob.current = await jobStart(method, payload());
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }
  // 导出完成后除结果区的打开按钮外，测算卡里也要有明确的「已生成＋文件名＋打开」
  // 反馈——此前唯一反馈是结果区标题旁悄悄出现的小按钮，用户感知不到已导出。
  const exported = ((result?.outputPaths ?? []) as string[]).filter(Boolean);
  return (
    <main className="tool-page fx-page loan-page">
      <PageHeader
        eyebrow="借款审计"
        title={tool.name}
        detail="从完整借款台账直接重算，或以 TB＋JE 模糊还原逐笔本金变动后测算利息。"
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />
      <StepIndicator
        steps={[
          { key: "source", label: "上传与识别" },
          { key: "rates", label: mode === "tb" ? "确认科目与利率" : "利率确认", disabled: !sourcesReady },
          { key: "run", label: "测算与底稿", disabled: !mappingsReady },
        ]}
        current={step}
        onStepClick={setStep}
      />

      {step === 0 && (
        <>
          <section className="fx-mode-bar" data-tour="tool-mode">
            <Button
              type="button"
              variant={mode === "ledger" ? "default" : "ghost"}
              className={mode === "ledger" ? "active" : ""}
              aria-pressed={mode === "ledger"}
              onClick={() => {
                invalidateResults();
                setMode("ledger");
              }}
            >
              完整借款台账
            </Button>
            <Button
              type="button"
              variant={mode === "tb" ? "default" : "ghost"}
              className={mode === "tb" ? "active" : ""}
              aria-pressed={mode === "tb"}
              onClick={() => {
                invalidateResults();
                setMode("tb");
              }}
            >
              TB＋JE
            </Button>
          </section>
          {mode === "tb" && (
            <section className="loan-warning">
              <strong>TB＋JE 将生成待复核的推算台账</strong>
              <span>请重点核对本金变动、匹配依据和勾稽差异。</span>
            </section>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                {mode === "ledger" ? "上传完整借款台账" : "上传 TB 与 JE"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {mode === "tb" ? (
                <>
                  <FileDropInput
                    containerRef={uploadDropRef}
                    value=""
                    disabled={busy}
                    placeholder="拖放或选择 TB、序时账文件（可同时选择）"
                    onBrowse={() => void browsePair()}
                    onDragStateChange={() => {}}
                  />
                  <div className="fx-source-grid">
                    <div className="fx-source-slot fx-source-slot-tb">
                      {sources.tb.path ? (
                        <LoanSourceCard
                          kind="tb"
                          source={sources.tb}
                          disabled={busy}
                          onReplace={() => void replaceSource("tb")}
                          onClear={() =>
                            setSource("tb", {
                              path: "",
                              inspection: undefined,
                              mapping: {},
                            })
                          }
                          onInspect={() => void inspect("tb")}
                          onKindChange={() => void changeSourceKind("tb", "je")}
                        />
                      ) : sources.je.path ? (
                        <Card className="fx-source-empty">
                          <CardHeader>
                            <CardTitle>TB 科目余额表</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <EmptyState
                              compact
                              title="还需要 TB"
                              description="TB 提供期初、期末本金，是推算借款变动的必需资料；请补充上传或检查文件表头。"
                            />
                          </CardContent>
                        </Card>
                      ) : null}
                    </div>
                    <div className="fx-source-slot fx-source-slot-je">
                      {sources.je.path ? (
                        <LoanSourceCard
                          kind="je"
                          source={sources.je}
                          disabled={busy}
                          onReplace={() => void replaceSource("je")}
                          onClear={() =>
                            setSource("je", {
                              path: "",
                              inspection: undefined,
                              mapping: {},
                            })
                          }
                          onInspect={() => void inspect("je")}
                          onKindChange={() => void changeSourceKind("je", "tb")}
                        />
                      ) : sources.tb.path ? (
                        <Card className="fx-source-empty">
                          <CardHeader>
                            <CardTitle>JE 序时账</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <EmptyState
                              compact
                              title="还需要 JE"
                              description="JE 用于逐笔还原新增借款与还款；请补充上传或检查文件表头。"
                            />
                          </CardContent>
                        </Card>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : (
                <div className="loan-upload-grid">
                  <Upload
                    kind="ledger"
                    source={sources.ledger}
                    busy={busy}
                    browse={() => void browse("ledger")}
                    clear={() => setSource("ledger", empty())}
                  />
                </div>
              )}
              {mode === "tb" && pairStatus && (
                <p className="fx-source-status" aria-live="polite">
                  <i aria-hidden="true" />
                  {pairStatus}
                </p>
              )}
              {!activeKinds.some((kind) => sources[kind].path) && (
                <EmptyState
                  compact
                  title={
                    mode === "ledger" ? "准备完整借款台账" : "准备 TB 与 JE"
                  }
                  description={
                    mode === "ledger"
                      ? "加入包含借款标识、本金或余额、起止日期及利率信息的台账。"
                      : "同时加入科目余额表（TB）与序时账（JE），用于还原并核对本金变动。"
                  }
                />
              )}
            </CardContent>
          </Card>
          {activeKinds.map(
            (kind) =>
              sources[kind].inspection && (
                <Mapping
                  key={kind}
                  kind={kind}
                  source={sources[kind]}
                  busy={busy}
                  change={(mapping) => setSource(kind, { mapping })}
                  header={(sheet, row, depth) =>
                    void inspect(kind, undefined, {
                      sheet,
                      headerRow: row,
                      headerDepth: depth,
                    })
                  }
                />
              ),
          )}
          <div className="fx-step-actions">
            <Button disabled={!sourcesReady} onClick={() => setStep(1)}>
              {mode === "tb" ? "下一步：确认科目与利率" : "下一步：利率确认"}
            </Button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          {mode === "ledger" ? (
            <LedgerRateConfirmation
              inspection={ledgerInspection!}
              mapping={sources.ledger.mapping}
              rates={rateRows}
              busy={busy}
              onEdit={editRate}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>确认借款科目</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="fx-hint">
                  名称含「借款/贷款」的科目已预选为借款科目，请逐行确认；确认后点下方按钮生成借款利率表。
                  借款明细/辅助核算不是必选项——映射了仅用于同科目多笔时区分到笔。
                </p>
                {accountsBusy ? (
                  <p className="fx-hint">正在读取科目清单…</p>
                ) : (
                  <div className="loan-account-confirm">
                    <table>
                      <thead>
                        <tr>
                          <th>科目编码</th>
                          <th>科目名称</th>
                          <th>期初余额</th>
                          <th>期末余额</th>
                          <th>科目类型</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tbAccounts.map((a) => (
                          <tr key={a.key}>
                            <td>{a.code}</td>
                            <td title={a.account}>{a.name || a.account}</td>
                            <td className="loan-num">{a.opening.toLocaleString()}</td>
                            <td className="loan-num">{a.closing.toLocaleString()}</td>
                            <td>
                              <select
                                aria-label={`${a.account}的科目类型`}
                                value={loanAccountRoles[a.key] ?? "skip"}
                                onChange={(e) =>
                                  setLoanAccountRoles((v) => ({
                                    ...v,
                                    [a.key]: e.target.value as "loan" | "skip",
                                  }))
                                }
                              >
                                <option value="loan">借款科目</option>
                                <option value="skip">排除</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="loan-run-grid">
                  <label>
                    资产负债表日
                    <Input
                      type="date"
                      value={reportEnd}
                      onChange={(e) => setReportEnd(e.target.value)}
                    />
                  </label>
                </div>
                <div className="loan-paste-actions">
                  <Button
                    variant="secondary"
                    disabled={accountsBusy || !selectedLoanAccounts().length}
                    onClick={() => {
                      setLoanAccountRoles((v) =>
                        Object.fromEntries(
                          tbAccounts.map((a) => [
                            a.key,
                            /借款|贷款/.test(a.name || a.account) ? "loan" : "skip",
                          ]),
                        ),
                      );
                      void loadTbAccounts();
                    }}
                  >
                    按名称建议重选
                  </Button>
                  <Button
                    variant="default"
                    disabled={
                      busy || accountsBusy || !selectedLoanAccounts().length || !mappingsReady
                    }
                    onClick={() => void run("loan.preview")}
                    title={mappingsReady ? undefined : "请先补齐字段映射"}
                  >
                    生成借款利率表
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !selectedLoanAccounts().length}
                    onClick={() => void exportRateTemplate()}
                  >
                    导出利率确认表
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !rows.length}
                    onClick={() => void importRates()}
                    title={rows.length ? undefined : "先生成借款利率表再回读"}
                  >
                    回读已填利率表
                  </Button>
                  {rateNoteText && (
                    <span className="loan-paste-note">{rateNoteText}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
          {mode === "tb" && rows.length > 0 && (
            <TbRateTable rows={rows} edits={tbRateEdits} onEdit={editTbRate} />
          )}
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(0)}>
              返回上传与识别
            </Button>
            <Button disabled={!mappingsReady} onClick={() => setStep(2)}>
              下一步：测算与底稿
            </Button>
          </div>
          {!mappingsReady && (
            <p className="fx-hint loan-step-gate">
              {sourcesReady ? (
                <>
                  下一步前需先补齐字段映射：{mappingGaps.join("、")}。
                  <Button variant="link" onClick={() => setStep(0)}>
                    返回补齐映射
                  </Button>
                </>
              ) : (
                "请先回到「上传与识别」完成文件识别。"
              )}
            </p>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>测算与底稿</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="loan-run-grid">
                <label>
                  资产负债表日
                  <Input
                    type="date"
                    value={reportEnd}
                    onChange={(e) => setReportEnd(e.target.value)}
                  />
                </label>
                <label>
                  输出文件
                  <span className="loan-output-row">
                    <Input
                      value={displayFileName(outputPath)}
                      readOnly
                      title={outputPath || undefined}
                      placeholder="默认保存到源文件目录"
                    />
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        const path = await pickPath(
                          "save",
                          "保存底稿",
                          ["xlsx"],
                          "借款利息测算.xlsx",
                        );
                        if (typeof path === "string") setOutputPath(path);
                      }}
                    >
                      选择位置
                    </Button>
                  </span>
                </label>
              </div>
              <p className="fx-rate-note">
                浮动利率按“基准利率＋加减点（BP÷10,000）”换算有效年利率。
              </p>
              <div className="fx-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run("loan.preview")}
                >
                  {mode === "tb" ? "生成并复核借款变动表" : "测算预览"}
                </Button>
                <Button disabled={busy} onClick={() => void run("loan.export")}>
                  生成 Excel 底稿
                </Button>
              </div>
              {!busy && exported.length > 0 && (
                <div className="loan-export-done" role="status">
                  <strong>Excel 底稿已生成</strong>
                  {exported.map((p) => (
                    <span key={p} className="loan-export-path">
                      <span className="loan-export-file" title={p}>
                        {fileNameOf(p)}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void openOutput(p)}
                      >
                        打开底稿
                      </Button>
                    </span>
                  ))}
                </div>
              )}
              {job && (
                <JobProgress
                  job={job}
                  onCancel={busy ? (id) => void jobCancel(id) : undefined}
                />
              )}
            </CardContent>
          </Card>
          {rows.length > 0 && (
            <Results rows={rows} editRate={editResultRate} result={result} />
          )}
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              返回利率确认
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
function Upload({
  kind,
  source,
  busy,
  browse,
  clear,
}: {
  kind: Kind;
  source: Source;
  busy: boolean;
  browse: () => void;
  clear: () => void;
}) {
  const name = kind === "ledger" ? "完整借款台账" : kind.toUpperCase();
  return (
    <div className="loan-upload">
      <b>{name}</b>
      <FileDropInput
        value={source.path}
        disabled={busy}
        placeholder={`选择${name}文件`}
        onBrowse={browse}
        onClear={clear}
        onDragStateChange={() => {}}
      />
      {source.inspection && (
        <small>
          已识别 {source.inspection.rowCount.toLocaleString()} 行 ×{" "}
          {source.inspection.headers.length} 列
        </small>
      )}
    </div>
  );
}
/** TB＋JE 模式的来源卡：与其他账表工具一致，在这里更换、移除或一键更正类型。 */
function LoanSourceCard(props: {
  kind: "tb" | "je";
  source: Source;
  disabled: boolean;
  onReplace: () => void;
  onClear: () => void;
  onInspect: () => void;
  onKindChange: () => void;
}) {
  const name = props.kind === "tb" ? "TB 科目余额表" : "JE 序时账";
  const x = props.source.inspection;
  return (
    <Card className="fx-source-card">
      <CardHeader>
        <CardTitle>已识别：{name}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="fx-detected-file">
          <button
            className="fx-file-name-button"
            type="button"
            title={`${props.source.path}（点击更换）`}
            disabled={props.disabled}
            onClick={props.onReplace}
          >
            {fileNameOf(props.source.path)}
          </button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={props.disabled}
            onClick={props.onClear}
          >
            移除
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={props.disabled}
            onClick={props.onKindChange}
          >
            更正为 {props.kind === "tb" ? "JE" : "TB"}
          </Button>
        </div>
        {props.source.path && !x && (
          <Button
            variant="secondary"
            disabled={props.disabled}
            onClick={props.onInspect}
          >
            自动识别表头和字段
          </Button>
        )}
        {x && (
          <div className="fx-source-meta">
            <span>
              {x.rowCount.toLocaleString()} 行 × {x.headers.length} 列
            </span>
            <span>Sheet：{x.sheet}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Mapping({
  kind,
  source,
  busy,
  change,
  header,
}: {
  kind: Kind;
  source: Source;
  busy: boolean;
  change: (m: Record<string, string>) => void;
  header: (s: string, r: number, d: number) => void;
}) {
  const x = source.inspection!;
  // 角色标签统一走共享解析：引擎下发的 roles（台账）优先，TB/JE 与浏览器预览
  // 模式没有 roles，回落本页标签表——清单与顺序仍由本页兜底表定。
  const labels = resolveRoleLabels(x.roles, LABELS[kind]);
  // TB/JE 走共用的映射复核；借款台账与利率台账不是账表，没有对应的复核规则。
  const [review, setReview] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const reviewable = kind === "tb" || kind === "je";
  async function runReview() {
    setReviewing(true);
    setReview("正在复核字段映射…");
    try {
      const { mapping, applied } = await applyLedgerReviewToDict(
        engineCall,
        kind as "je" | "tb",
        x.headers,
        x.preview,
        source.mapping,
        labels,
        undefined,
        LOAN_SINGLE_COLUMN_ROLES,
      );
      change(mapping as Record<string, string>);
      setReview(
        applied.length
          ? `复核完成，已应用 ${applied.length} 项建议。`
          : "复核完成，当前映射无需调整。",
      );
    } catch (e) {
      setReview(`${errorText(e)} 可继续手工映射。`);
    } finally {
      setReviewing(false);
    }
  }
  const name =
    kind === "ledger"
      ? "借款台账"
      : kind === "rateLedger"
        ? "利率台账"
        : kind.toUpperCase();
  // 角色清单与标签：台账兜底表与引擎的 loan_roles 同名同序，合并后下拉顺序不变；
  // 引擎标签与本地不一致时以引擎为准（唯一定义在 Rust）。
  const roleList: [string, string][] = Object.entries(labels);
  // 下拉分组与其他账表工具一致：借款/利率台账用引擎随识别下发的形态表，
  // TB/JE 用共享内核的形态表（formGroups 已支持 loan）。
  const groupKind: LedgerFormKind =
    kind === "tb" || kind === "je" ? kind : "loan";
  const fetchedForms = useLedgerForms(groupKind);
  const forms =
    groupKind === "loan" && x.forms?.length ? x.forms : fetchedForms;
  // 借款台账按四型判定：命中哪一型决定哪些字段必填。利率台账不判型。
  const hit =
    kind === "ledger" && x.forms?.length
      ? resolveLoanForm(x.forms, source.mapping)
      : undefined;
  const formNote = hit
    ? describeLoanForm(hit, (role) => labels[role] ?? role)
    : undefined;
  return (
    <>
      <MappingPanel
        title={`${name}字段映射`}
        headers={x.headers}
        rows={x.preview}
        mapping={source.mapping}
        roles={roleList}
        groups={formGroups(
          groupKind,
          roleList,
          forms,
          source.mapping,
          // 「借款明细/辅助核算」按业务口径是选填：走借款台账时根本用不到它；
          // 走 TB＋JE 重建时缺了它，引擎在测算入口报「未从 TB 识别到借款明细」
          // 明确提示，不靠映射阶段的必填标记拦人。
        )}
        requirementOf={
          hit ? (role) => loanRoleRequirement(hit, role) : undefined
        }
        formNote={formNote}
        missing={loanMissing(kind, source.mapping, x.forms)}
        busy={busy || reviewing}
        maxHeight={360}
        toolbar={
          <>
            <label>
              Sheet
              <select
                value={x.sheet}
                onChange={(e) => header(e.target.value, 0, 0)}
              >
                {x.sheets.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              标题行
              <Input
                controlSize="sm"
                type="number"
                min={1}
                value={x.headerRow}
                onChange={(e) =>
                  header(x.sheet, Number(e.target.value), x.headerDepth)
                }
              />
            </label>
            {/* 表头层数只有 TB/JE 需要（「金额」下再分借方/贷方的两层表头）； */}
            {/* 台账固定单层，引擎也不支持多级表头，不给这个控件。 */}
            {reviewable && (
              <label>
                表头层数
                <select
                  value={x.headerDepth}
                  onChange={(e) =>
                    header(x.sheet, x.headerRow, Number(e.target.value))
                  }
                >
                  <option value={1}>1层</option>
                  <option value={2}>2层</option>
                </select>
              </label>
            )}
            {reviewable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || reviewing}
                onClick={() => void runReview()}
              >
                {reviewing ? "复核中…" : "LLM 复核映射"}
              </Button>
            )}
          </>
        }
        onChange={(next) => change(next as Record<string, string>)}
      />
      {review && <p className="fx-hint">{review}</p>}
    </>
  );
}

/** TB 模式「利率确认」：粘贴匹配出的逐笔利率，可改类型/利率/加点，未匹配的可补填。 */
function TbRateTable({
  rows,
  edits,
  onEdit,
}: {
  rows: LoanRow[];
  edits: Record<string, PasteRateRow>;
  onEdit: (loanId: string, patch: Partial<PasteRateRow>) => void;
}) {
  const filled = rows.filter((r) => {
    const e = edits[r.loanId];
    return e && (e.fixedRate != null || e.benchmarkRate != null);
  }).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>借款利率确认表</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="fx-hint">
          共 {rows.length} 笔借款，已填利率 {filled} 笔。可直接在下表逐笔填写；
          也可「导出利率确认表」在 Excel 里补填后「回读已填利率表」。
          留空的按无利率进入测算（状态列会提示补利率），不影响其他笔。
        </p>
        <div className="loan-rate-confirmation loan-rate-match">
          <table>
            <thead>
              <tr>
                <th>借款行</th>
                <th>期初余额</th>
                <th>期末余额</th>
                <th>利率类型</th>
                <th>执行利率（固定）</th>
                <th>
                  基准利率（浮动）
                </th>
                <th>
                  加减点（BP）
                  <JargonTip
                    term="加减点（BP）"
                    text="BP＝万分之一。浮动利率＝基准利率＋加减点BP÷10000。"
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const e = edits[row.loanId] ?? { rateType: "fixed" as const };
                const rateType = e.rateType ?? "fixed";
                return (
                  <tr key={row.loanId}>
                    <td title={row.loanId}>{row.loanId}</td>
                    <td className="loan-num">{row.openingPrincipal.toLocaleString()}</td>
                    <td className="loan-num">{row.closingPrincipal.toLocaleString()}</td>
                    <td>
                      <select
                        aria-label={`${row.loanId}的利率类型`}
                        value={rateType}
                        onChange={(ev) =>
                          onEdit(row.loanId, {
                            rateType: ev.target.value as "fixed" | "floating",
                          })
                        }
                      >
                        <option value="fixed">固定</option>
                        <option value="floating">浮动</option>
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`${row.loanId}的执行利率`}
                        type="number"
                        step="0.0001"
                        placeholder="如 3.85"
                        value={e.fixedRate ?? ""}
                        disabled={rateType === "floating"}
                        onChange={(ev) =>
                          onEdit(row.loanId, {
                            fixedRate: ev.target.value === "" ? undefined : Number(ev.target.value) / 100,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${row.loanId}的基准利率`}
                        type="number"
                        step="0.0001"
                        placeholder="如 3.1"
                        value={e.benchmarkRate ?? ""}
                        disabled={rateType === "fixed"}
                        onChange={(ev) =>
                          onEdit(row.loanId, {
                            benchmarkRate: ev.target.value === "" ? undefined : Number(ev.target.value) / 100,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${row.loanId}的加减点`}
                        type="number"
                        step="1"
                        placeholder="如 90"
                        value={e.spreadBps ?? ""}
                        disabled={rateType === "fixed"}
                        onChange={(ev) =>
                          onEdit(row.loanId, {
                            spreadBps: ev.target.value === "" ? undefined : Number(ev.target.value),
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fx-rate-note">
          利率填百分比数值（3.85 即 3.85%）；浮动利率按“基准利率＋加减点（BP÷10,000）”换算有效年利率。
        </p>
      </CardContent>
    </Card>
  );
}

function LedgerRateConfirmation({
  inspection,
  mapping,
  rates,
  busy,
  onEdit,
}: {
  inspection: Inspection;
  mapping: Record<string, string>;
  rates: LoanRateSetting[];
  busy: boolean;
  onEdit: (index: number, patch: Partial<LoanRateSetting>) => void;
}) {
  const valueAt = (row: string[], role: string) => {
    const index = inspection.headers.indexOf(mapping[role] ?? "");
    return index >= 0 ? (row[index] ?? "") : "";
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>借款利率确认</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="loan-rate-confirmation">
          <table>
            <thead>
              <tr>
                <th>借款标识</th>
                <th>台账利率</th>
                <th>利率类型</th>
                <th>
                  加减点（BP）
                  <JargonTip
                    term="加减点（BP）"
                    text="BP＝万分之一。浮动利率＝基准利率＋加减点BP÷10000。"
                  />
                </th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {inspection.preview.map((row, index) => {
                const sourceRate = valueAt(row, "rate");
                const loanId =
                  valueAt(row, "loanId") ||
                  valueAt(row, "lender") ||
                  `第 ${index + 1} 行`;
                const rate = rates[index] ?? {
                  rateType: "fixed",
                  spreadBps: 0,
                };
                return (
                  <tr key={`${loanId}-${index}`}>
                    <td title={loanId}>{loanId}</td>
                    <td>{sourceRate || "—"}</td>
                    <td>
                      <select
                        className="loan-rate-pick"
                        disabled={busy}
                        value={rate.rateType}
                        onChange={(event) =>
                          onEdit(index, {
                            rateType: event.target
                              .value as LoanRateSetting["rateType"],
                          })
                        }
                      >
                        <option value="fixed">固定</option>
                        <option value="floating">浮动</option>
                      </select>
                    </td>
                    <td>
                      <NumberInput
                        label={`${loanId}的加减点`}
                        className="loan-rate-bps"
                        step="1"
                        disabled={busy || rate.rateType !== "floating"}
                        value={rate.spreadBps}
                        onCommit={(text) =>
                          onEdit(index, { spreadBps: loanBps(text) })
                        }
                      />
                    </td>
                    <td>
                      <Badge
                        variant="outline"
                        className={sourceRate ? "badge-ready" : "badge-warning"}
                      >
                        {sourceRate ? "已识别" : "待补充"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Results({
  rows,
  editRate,
  result,
}: {
  rows: LoanRow[];
  editRate: (index: number, patch: ResultRateEdit) => void;
  result?: Record<string, unknown>;
}) {
  const total = rows.reduce((s, r) => s + Number(r.calculatedInterest ?? 0), 0);
  const totals = rows.reduce(
    (sum, row) => ({
      opening: sum.opening + Number(row.openingPrincipal),
      additions: sum.additions + Number(row.additions),
      reductions: sum.reductions + Number(row.reductions),
      closing: sum.closing + Number(row.closingPrincipal),
    }),
    { opening: 0, additions: 0, reductions: 0, closing: 0 },
  );
  const amount = (value: number) =>
    value.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const reviewCount = rows.filter((row) => row.matchStatus !== "已匹配").length;
  const metric = (label: string, value: number | string, detail?: string) => (
    <div className="fx-bridge-metric">
      <span>{label}</span>
      <strong>{typeof value === "number" ? amount(value) : value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
  return (
    <section className="loan-results">
      <div className="fx-result-heading">
        <div>
          <h3>借款本金变动与利息测算</h3>
          <p>期初＋本期增加－本期减少＝期末；请优先处理待复核行。</p>
        </div>
        {((result?.outputPaths ?? []) as string[]).map((p) => (
          <Button
            key={p}
            variant="secondary"
            onClick={() => void openOutput(p)}
          >
            打开 Excel 底稿
          </Button>
        ))}
      </div>
      <div className="loan-result-overview" role="status">
        <Badge
          variant="outline"
          className={reviewCount ? "badge-warning" : "badge-ready"}
        >
          {reviewCount ? `${reviewCount} 笔待复核` : "测算完成"}
        </Badge>
        <span>
          {reviewCount
            ? "先处理待复核行，确认本金变化、利率和勾稽差异，再生成底稿。"
            : "可继续检查逐笔明细并打开或生成 Excel 底稿。"}
        </span>
      </div>
      <div className="fx-bridge-step">
        <div className="fx-step-label">
          <b>1</b>
          <span>本金变动</span>
        </div>
        <div className="loan-bridge-equation">
          {metric("期初本金", totals.opening)}
          <span className="fx-operator" aria-hidden="true">
            ＋
          </span>
          {metric("本期增加", totals.additions)}
          <span className="fx-operator" aria-hidden="true">
            －
          </span>
          {metric("本期减少", totals.reductions)}
          <span className="fx-operator" aria-hidden="true">
            ＝
          </span>
          {metric("期末本金", totals.closing)}
        </div>
      </div>
      <div className="fx-bridge-step comparison">
        <div className="fx-step-label">
          <b>2</b>
          <span>测算结果</span>
        </div>
        <div className="loan-result-summary">
          {metric("借款笔数", `${rows.length} 笔`)}
          {metric("测算利息合计", total)}
          {metric(
            "待复核",
            `${rows.filter((row) => row.matchStatus !== "已匹配").length} 笔`,
            "推算行：期初/减少或归还时点系推算，悬停状态列看依据",
          )}
        </div>
      </div>
      <div className="loan-rate-table">
        <table>
          <thead>
            <tr>
              <th>借款标识</th>
              <th>期初</th>
              <th>增加</th>
              <th>减少</th>
              <th>期末（台账）</th>
              <th>期末（推算）</th>
              <th>勾稽差异</th>
              <th>利率类型</th>
              <th>固定/基准利率</th>
              <th>加点 BP</th>
              <th>有效利率</th>
              <th>测算利息</th>
              <th>匹配状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.loanId}-${i}`}>
                <td title={r.matchBasis}>{r.loanId}</td>
                {[
                  r.openingPrincipal,
                  r.additions,
                  r.reductions,
                  r.ledgerClosing ?? null,
                  r.closingPrincipal,
                  loanEquation(r),
                ].map((n, j) => (
                  <td key={j}>
                    {n == null ? "—" : Number(n).toLocaleString()}
                  </td>
                ))}
                <td>
                  <select
                    value={r.rateType}
                    onChange={(e) => {
                      const rateType = e.target.value as LoanRow["rateType"];
                      editRate(
                        i,
                        rateType === "floating"
                          ? { rateType, fixedRate: undefined }
                          : {
                              rateType,
                              benchmarkRate: undefined,
                              spreadBps: undefined,
                            },
                      );
                    }}
                  >
                    <option value="fixed">固定</option>
                    <option value="floating">浮动</option>
                  </select>
                </td>
                <td>
                  <NumberInput
                    label={`${r.loanId}的${
                      r.rateType === "fixed" ? "固定利率" : "基准利率"
                    }`}
                    step=".0001"
                    value={
                      r.rateType === "fixed"
                        ? (r.fixedRate ?? "")
                        : (r.benchmarkRate ?? "")
                    }
                    onCommit={(text) =>
                      editRate(
                        i,
                        r.rateType === "fixed"
                          ? { fixedRate: loanRateValue(text) }
                          : { benchmarkRate: loanRateValue(text) },
                      )
                    }
                  />
                </td>
                <td>
                  <NumberInput
                    label={`${r.loanId}的加点 BP`}
                    step="1"
                    disabled={r.rateType !== "floating"}
                    value={r.spreadBps ?? 0}
                    onCommit={(text) =>
                      editRate(i, { spreadBps: loanBps(text) })
                    }
                  />
                </td>
                <td>
                  {r.rateType === "floating" && r.benchmarkRate == null
                    ? "请再次测算"
                    : `${(
                        loanEffectiveRate(
                          r.rateType,
                          r.fixedRate,
                          r.benchmarkRate,
                          r.spreadBps,
                        ) * 100
                      ).toFixed(4)}%`}
                </td>
                <td>{Number(r.calculatedInterest ?? 0).toLocaleString()}</td>
                <td>
                  <Badge
                    variant="outline"
                    className={
                      r.matchStatus === "已匹配"
                        ? "badge-ready"
                        : "badge-warning"
                    }
                    title={r.matchBasis}
                  >
                    {r.matchStatus ?? "—"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fx-rate-note">
        修改利率后请再次测算。已有执行利率默认为固定利率；手动改为浮动后，不再沿用执行利率，改按基准利率加减BP重算。
      </p>
    </section>
  );
}
