import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  openOutput,
  pickPath,
} from "./api";
import type { Inspection } from "./DepositInterestPage";
import {
  depositDropTargetInside,
  JE_LABELS,
  TB_LABELS,
} from "./DepositInterestPage";
import { MappingPanel, type MappingDict } from "@/components/MappingPanel";
import { confirmDialog } from "@/components/ConfirmDialog";
import { LedgerReviewCompact } from "@/components/LedgerReviewAll";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, Eye, FolderOpen, Plus, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useJobEvents } from "@/hooks/useJobEvents";
import { errorText } from "@/lib/errors";
import {
  applyLedgerReviewsTogether,
  LEDGER_MULTI_COLUMN_ROLES,
  scanLedgerUploadSources,
  resolveRoleLabels,
  selectLedgerWorkbookKindSources,
  type LedgerReviewOutcome,
  type LedgerWorkbookSheetClassification,
} from "@/ledgerMapping";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  useLedgerForms,
} from "@/ledgerForms";
import {
  compareGroups,
  fileName,
  pairLedgerFiles,
  pairingFileKey,
  pairingFileLabel,
  reassignJe,
  type LedgerKind,
  type PairedGroup,
  type PairingFile,
} from "./tbjePairing";
import type { ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import "./fx-audit.css";
import "./tbje-check.css";

type Mapping = MappingDict;
type GroupLedgerReview = Partial<Record<LedgerKind, LedgerReviewOutcome>>;

type Verdict = { performed: boolean; passed?: boolean; reason?: string };

type SideTotals = {
  byCategory: { category: string; amount: number }[];
  total: number;
  balanced: boolean;
};

type CheckResult = {
  rollforward: Verdict & {
    checked?: number;
    mismatched?: number;
    units?: {
      unit: string;
      checked: number;
      mismatched: number;
      items: {
        sourceRow: number;
        account: string;
        currency?: string;
        opening: number;
        debit: number;
        credit: number;
        derived: number;
        closing: number;
        difference: number;
      }[];
    }[];
  };
  tbVsJe: Verdict & {
    sidePassed?: boolean;
    netPassed?: boolean;
    accounts?: number;
    mismatched?: number;
    netMismatched?: number;
    widespread?: boolean;
    items?: {
      entity: string;
      code: string;
      name: string;
      presence: "both" | "tbOnly" | "jeOnly";
      tbIncludedCurrencies?: string;
      tbIncludedRows?: number;
      tbDebit: number;
      jeDebit: number;
      debitDifference: number;
      tbCredit: number;
      jeCredit: number;
      creditDifference: number;
      tbNet?: number;
      jeNet?: number;
      netDifference?: number;
      netPassed?: boolean;
      overallVerdict?: string;
    }[];
  };
  equation: Verdict & {
    balancePassed?: boolean;
    classificationComplete?: boolean;
    accounts?: number;
    signConvention?: string;
    opening?: SideTotals | null;
    closing?: SideTotals | null;
    unclassified?: {
      sourceRow: number;
      code: string;
      name: string;
      opening: number;
      closing: number;
    }[];
  };
  mappingWarnings?: string[];
  currencyScope?: {
    functionalCurrency?: string | null;
    includedRows: number;
    excludedForeignRows: number;
  };
};

const CHECK_NAMES = {
  rollforward: "TB 发生额与余额勾稽",
  tbVsJe: "TB 与 JE 发生额勾稽",
  equation: "BS 与 PL 勾稽",
} as const;

type GroupOutcome = {
  label: string;
  ok: boolean;
  error?: string;
  result?: CheckResult;
};

const money = (value: number) =>
  value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function VerdictBadge({ verdict }: { verdict?: Verdict }) {
  if (!verdict?.performed)
    return (
      <Badge variant="outline" className="badge-neutral">
        未执行
      </Badge>
    );
  return verdict.passed ? (
    <Badge variant="outline" className="badge-ready">
      通过
    </Badge>
  ) : (
    <Badge variant="destructive">有差异</Badge>
  );
}

function EquationVerdict({ equation }: { equation?: CheckResult["equation"] }) {
  if (!equation?.performed) return <VerdictBadge verdict={equation} />;
  const balancePassed =
    equation.balancePassed ??
    [equation.opening, equation.closing]
      .filter(Boolean)
      .every((side) => side?.balanced !== false);
  const classificationComplete =
    equation.classificationComplete ?? !equation.unclassified?.length;
  if (!balancePassed) return <Badge variant="destructive">金额不平</Badge>;
  if (!classificationComplete)
    return (
      <Badge variant="outline" className="badge-warning">
        分类待确认
      </Badge>
    );
  return (
    <Badge variant="outline" className="badge-ready">
      通过
    </Badge>
  );
}

function TbJeVerdict({ check }: { check?: CheckResult["tbVsJe"] }) {
  if (!check?.performed) return <VerdictBadge verdict={check} />;
  const sidePassed = check.sidePassed ?? check.passed === true;
  const netPassed = check.netPassed ?? check.passed === true;
  if (!netPassed) return <Badge variant="destructive">不通过</Badge>;
  if (!sidePassed)
    return (
      <Badge variant="outline" className="badge-warning">
        净额通过，单边发生额有差异
      </Badge>
    );
  return (
    <Badge variant="outline" className="badge-ready">
      通过
    </Badge>
  );
}

/** 预览截断的行数。几百条差异全塞进页面没法看——预览管定位，导出管全量。 */
const PREVIEW_CAP = 100;
const MULTI_COLUMN_ROLES = new Set(["id", "accountName", "auxiliary"]);

const presenceLabel = (presence: string) =>
  presence === "tbOnly"
    ? "仅余额表"
    : presence === "jeOnly"
      ? "仅序时账"
      : "两边都有";

/** 结果预览：三条核对的差异就地展开，不用先导出工作簿才能看到数字。 */
function OutcomeDetail({ result }: { result: CheckResult }) {
  const rollforwardUnits = (result.rollforward.units ?? []).filter(
    (unit) => unit.mismatched,
  );
  const tbItems = result.tbVsJe.items ?? [];
  const unclassified = result.equation.unclassified ?? [];
  const equationSides = (
    [
      ["年初", result.equation.opening],
      ["年末", result.equation.closing],
    ] as [string, SideTotals | null | undefined][]
  ).filter(([, side]) => side);
  const nothing =
    !rollforwardUnits.length &&
    !tbItems.length &&
    !unclassified.length &&
    !equationSides.some(([, side]) => !side!.balanced);
  return (
    <div className="tbje-preview">
      {(result.mappingWarnings ?? []).map((warning) => (
        <p className="fx-hint" key={warning}>
          {warning}
        </p>
      ))}
      {nothing && <p className="fx-hint">无差异明细。</p>}
      {rollforwardUnits.map((unit) => (
        <div key={unit.unit} className="tbje-preview-block">
          <h4>
            {CHECK_NAMES.rollforward}不平（{unit.unit}）{unit.mismatched} /{" "}
            {unit.checked} 行
          </h4>
          <div className="tbje-preview-scroll">
            <Table className="tbje-preview-table">
              <TableHeader>
                <TableRow>
                  <TableHead>源表行</TableHead>
                  <TableHead>科目</TableHead>
                  <TableHead>TB币种</TableHead>
                  <TableHead>期初</TableHead>
                  <TableHead>本年借方</TableHead>
                  <TableHead>本年贷方</TableHead>
                  <TableHead>期初＋借−贷</TableHead>
                  <TableHead>期末</TableHead>
                  <TableHead>差额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unit.items.slice(0, PREVIEW_CAP).map((item, index) => (
                  <TableRow key={index}>
                    <TableCell>{item.sourceRow}</TableCell>
                    <TableCell className="tbje-text-cell">
                      {item.account}
                    </TableCell>
                    <TableCell>{item.currency || "未标明"}</TableCell>
                    <TableCell className="tbje-number">
                      {money(item.opening)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.debit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.credit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.derived)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.closing)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.difference)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {unit.items.length > PREVIEW_CAP && (
            <p className="fx-hint">
              仅显示前 {PREVIEW_CAP} 行，共 {unit.items.length}{" "}
              行——导出工作簿看全部。
            </p>
          )}
        </div>
      ))}
      {tbItems.length > 0 && (
        <div className="tbje-preview-block">
          <h4>
            {CHECK_NAMES.tbVsJe}差异 {tbItems.length} 个科目
          </h4>
          <div className="tbje-preview-scroll">
            <Table className="tbje-preview-table">
              <TableHeader>
                <TableRow>
                  <TableHead>科目编码</TableHead>
                  <TableHead>科目名称</TableHead>
                  <TableHead>出现在</TableHead>
                  <TableHead>TB纳入币种</TableHead>
                  <TableHead>TB 借方</TableHead>
                  <TableHead>JE 借方</TableHead>
                  <TableHead>借方差额</TableHead>
                  <TableHead>TB 贷方</TableHead>
                  <TableHead>JE 贷方</TableHead>
                  <TableHead>贷方差额</TableHead>
                  <TableHead>TB 净额</TableHead>
                  <TableHead>JE 净额</TableHead>
                  <TableHead>净额差异</TableHead>
                  <TableHead>净额结论</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tbItems.slice(0, PREVIEW_CAP).map((item, index) => (
                  <TableRow key={index}>
                    <TableCell>{item.code}</TableCell>
                    <TableCell className="tbje-text-cell">
                      {item.name}
                    </TableCell>
                    <TableCell>{presenceLabel(item.presence)}</TableCell>
                    <TableCell>
                      {item.tbIncludedRows
                        ? `${item.tbIncludedCurrencies || "未标明"}（${item.tbIncludedRows}行）`
                        : "—"}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.tbDebit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.jeDebit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.debitDifference)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.tbCredit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.jeCredit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.creditDifference)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.tbNet ?? item.tbDebit - item.tbCredit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.jeNet ?? item.jeDebit - item.jeCredit)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(
                        item.netDifference ??
                          item.tbDebit -
                            item.tbCredit -
                            (item.jeDebit - item.jeCredit),
                      )}
                    </TableCell>
                    <TableCell>
                      {item.netPassed === false ? "不通过" : "通过"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {tbItems.length > PREVIEW_CAP && (
            <p className="fx-hint">
              仅显示前 {PREVIEW_CAP} 条，共 {tbItems.length}{" "}
              条——导出工作簿看全部。
            </p>
          )}
        </div>
      )}
      {equationSides.some(([, side]) => !side!.balanced) && (
        <div className="tbje-preview-block">
          <h4>{CHECK_NAMES.equation}（已归类科目合计应为 0）</h4>
          <div className="tbje-preview-scroll">
            <Table className="tbje-preview-table">
              <TableHeader>
                <TableRow>
                  <TableHead>时点</TableHead>
                  <TableHead>会计要素</TableHead>
                  <TableHead>金额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {equationSides.map(([label, side]) => (
                  <Fragment key={label}>
                    {side!.byCategory.map((row) => (
                      <TableRow key={`${label}-${row.category}`}>
                        <TableCell>{label}</TableCell>
                        <TableCell>{row.category}</TableCell>
                        <TableCell className="tbje-number">
                          {money(row.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow key={`${label}-total`}>
                      <TableCell>{label}</TableCell>
                      <TableCell>合计（应为 0）</TableCell>
                      <TableCell className="tbje-number">
                        {money(side!.total)}
                      </TableCell>
                    </TableRow>
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      {unclassified.length > 0 && (
        <div className="tbje-preview-block">
          <h4>
            {CHECK_NAMES.equation}：{unclassified.length} 个科目无法自动分类
          </h4>
          <p className="fx-hint">
            这些科目未按科目编码识别为资产、负债、权益、成本或损益，暂未纳入 BS
            与 PL 勾稽；请核对科目编码或后续补充分类。
          </p>
          <div className="tbje-preview-scroll">
            <Table className="tbje-preview-table">
              <TableHeader>
                <TableRow>
                  <TableHead>源表行</TableHead>
                  <TableHead>科目编码</TableHead>
                  <TableHead>科目名称</TableHead>
                  <TableHead>年初</TableHead>
                  <TableHead>年末</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unclassified.slice(0, PREVIEW_CAP).map((item, index) => (
                  <TableRow key={index}>
                    <TableCell>{item.sourceRow}</TableCell>
                    <TableCell>{item.code}</TableCell>
                    <TableCell className="tbje-text-cell">
                      {item.name}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.opening)}
                    </TableCell>
                    <TableCell className="tbje-number">
                      {money(item.closing)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

export function TbjeCheckPage({ tool }: { tool: ToolManifest }) {
  const [inspects, setInspects] = useState<Record<string, Inspection>>({});
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [groups, setGroups] = useState<PairedGroup[]>([]);
  // JE-only groups remain in memory so a later TB upload or manual selection can
  // claim them, but they are not rows: this page is TB-led and a JE cannot run alone.
  const visibleGroups = useMemo(
    () => groups.filter((group) => Boolean(group.tb)),
    [groups],
  );
  const [expanded, setExpanded] = useState<
    { groupId: string; kind: LedgerKind } | undefined
  >();
  const [detail, setDetail] = useState<string | undefined>();
  const [outcomes, setOutcomes] = useState<GroupOutcome[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [llmReviewBusy, setLlmReviewBusy] = useState(false);
  const [llmReviewStatus, setLlmReviewStatus] = useState("");
  const [llmReviews, setLlmReviews] = useState<
    Record<string, GroupLedgerReview>
  >({});
  const [currentStep, setCurrentStep] = useState(0);
  const [exported, setExported] = useState<
    { path: string; batch: boolean } | undefined
  >();
  const dropRef = useRef<HTMLDivElement | null>(null);
  const intakeSectionRef = useRef<HTMLElement | null>(null);
  const pairingSectionRef = useRef<HTMLElement | null>(null);
  const resultSectionRef = useRef<HTMLElement | null>(null);
  // 用户在配对页明确选过「不配对序时账」的 TB。二次添加文件时这些组不许被
  // 自动配对重新塞回 JE——那是用户亲手清掉的，不是没配上。
  const clearedTbsRef = useRef(new Set<string>());

  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "tbje_check",
    onEvent: (event) => {
      const payload = event.result as { groups?: GroupOutcome[] } | undefined;
      if (payload?.groups) {
        setOutcomes(payload.groups);
        setCurrentStep(2);
      }
      const single = event.result as { outputPath?: string } | undefined;
      if (typeof single?.outputPath === "string")
        setExported({ path: single.outputPath, batch: false });
      const batch = event.result as { outputDirectory?: string } | undefined;
      if (typeof batch?.outputDirectory === "string")
        setExported({ path: batch.outputDirectory, batch: true });
      if (["completed", "failed", "cancelled"].includes(event.phase))
        setBusy(false);
      if (event.phase === "failed") setError(event.message);
    },
  });

  useEffect(() => {
    const drops = listenPositionedFileDrops(({ paths, x, y }) => {
      if (
        !depositDropTargetInside(x, y, dropRef.current?.getBoundingClientRect())
      )
        return;
      void intake(paths);
    });
    return () => {
      void drops.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 历史记录「继续任务」：把存档里的 TB/JE 文件重新批量识别（自动配对），
  // 完成后用存档映射覆盖建议映射。此前手动「不配对序时账」的组会被重新
  // 自动配对，需要的话在配对页再清一次。run_batch 是组数组，单组导出的
  // 存档把组字段放在顶层，两种形状都兼容。
  useTaskRestore(tool.id, (restore) => {
    type TbjeGroupParams = {
      tbSource?: { inputPath?: unknown; sheet?: unknown };
      tbMapping?: Mapping;
      jeSource?: { inputPath?: unknown; sheet?: unknown };
      jeMapping?: Mapping;
    };
    const raw = restore.params.groups;
    const groups = (
      Array.isArray(raw) ? raw : [restore.params]
    ) as TbjeGroupParams[];
    if (!groups.length) return;
    const paths = new Set<string>();
    for (const group of groups) {
      if (typeof group?.tbSource?.inputPath === "string" && group.tbSource.inputPath)
        paths.add(group.tbSource.inputPath);
      if (typeof group?.jeSource?.inputPath === "string" && group.jeSource.inputPath)
        paths.add(group.jeSource.inputPath);
    }
    if (!paths.size) return;
    setError("");
    setOutcomes([]);
    setExported(undefined);
    void (async () => {
      await intake([...paths]);
      setMappings((current) => {
        const next = { ...current };
        for (const group of groups) {
          const tbPath = group?.tbSource?.inputPath;
          if (
            typeof tbPath === "string" &&
            group.tbMapping &&
            typeof group.tbMapping === "object"
          )
            next[
              pairingFileKey({
                path: tbPath,
                sheet:
                  typeof group.tbSource?.sheet === "string"
                    ? group.tbSource.sheet
                    : undefined,
              })
            ] = group.tbMapping;
          const jePath = group?.jeSource?.inputPath;
          if (
            typeof jePath === "string" &&
            group.jeMapping &&
            typeof group.jeMapping === "object"
          )
            next[
              pairingFileKey({
                path: jePath,
                sheet:
                  typeof group.jeSource?.sheet === "string"
                    ? group.jeSource.sheet
                    : undefined,
              })
            ] = group.jeMapping;
        }
        return next;
      });
    })();
  });

  async function browse() {
    const picked = await pickPath("files", "选择 TB 与 JE 文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
    ]);
    if (!picked) return;
    void intake(Array.isArray(picked) ? picked : [picked]);
  }

  /** 批量识别：每份文件判类型、读表头、给映射建议。配对不读文件内容。 */
  async function intake(selected: string[]) {
    const existingPaths = new Set(
      groups
        .flatMap((group) => [group.tb?.path, group.je?.path])
        .filter((path): path is string => Boolean(path)),
    );
    const files = selected.filter(
      (path) => /\.(xlsx?|xlsm|csv)$/i.test(path) && !existingPaths.has(path),
    );
    if (!files.length) {
      if (visibleGroups.length) setCurrentStep(1);
      return;
    }
    setError("");
    invalidateResults(false);
    setBusy(true);
    const failures: string[] = [];
    const recognized: PairingFile[] = [];
    const nextInspects: Record<string, Inspection> = { ...inspects };
    const nextMappings: Record<string, Mapping> = { ...mappings };
    const scan = await scanLedgerUploadSources<LedgerWorkbookSheetClassification>(
      engineCall,
      files,
      {
        onWorkbookStart: (path, index, total) =>
          setStatus(`正在识别 ${index + 1} / ${total}：${fileName(path)}`),
      },
    );
    const classifiedSources = selectLedgerWorkbookKindSources(scan.sources);
    const hiddenSheets = scan.hiddenSheets;
    failures.push(
      ...scan.failures.map(
        (failure) => `${fileName(failure.path)}：${errorText(failure.error)}`,
      ),
    );
    for (const item of classifiedSources) {
      // 批量页不能把全批来源拿去做“两文件联合判型”；那会为了凑 TB/JE
      // 数量而把明确的 04JE 辅助 Sheet 强行改成 TB。
      const kind = item.classification.kind as LedgerKind;
      const provisionalKey = pairingFileKey({
        path: item.path,
        sheet: item.classification.sheet,
      });
      // 重复选入只当“确认要这份”；已换标题行、改过映射的 Sheet 原样保留。
      if (nextInspects[provisionalKey]) continue;
      try {
        const inspected = (await engineCall(`fx.inspect_${kind}`, {
          source: {
            inputPath: item.path,
            sheet: item.classification.sheet,
            headerRow: 0,
            headerDepth: 0,
          },
        })) as Inspection;
        const source: PairingFile = {
          path: item.path,
          sheet: inspected.sheet,
          kind,
          entities: inspected.entities,
        };
        const key = pairingFileKey(source);
        nextInspects[key] = inspected;
        nextMappings[key] = inspected.suggestedMapping;
        recognized.push(source);
      } catch (e) {
        failures.push(
          `${fileName(item.path)} / ${item.classification.sheet}：${errorText(e)}`,
        );
      }
    }
    // 二次添加不推翻已有配对：配好对的组（包括用户手工调整过的）原样保留，
    // 手工选过「不配对」的 TB 组也原样保留，只有「没配上 JE 的 TB」「没被
    // 认领的 JE」和新文件一起重新自动配对——分两批拖入仍能配上，但用户确认
    // 过的结果不会被冲掉。
    const settled = groups.filter(
      (group) => group.tb && (group.je || clearedTbsRef.current.has(group.id)),
    );
    const openTbs = groups
      .filter(
        (group) =>
          group.tb && !group.je && !clearedTbsRef.current.has(group.id),
      )
      .map((group) => group.tb!);
    const looseJes = groups
      .filter((group) => !group.tb && group.je)
      .map((group) => group.je!);
    const pool = [...openTbs, ...looseJes, ...recognized].filter(
      (file, index, all) =>
        all.findIndex((other) => pairingFileKey(other) === pairingFileKey(file)) ===
        index,
    );
    const paired = pairLedgerFiles(pool);
    const nextGroups = [...settled, ...paired].sort(compareGroups);
    setInspects(nextInspects);
    setMappings(nextMappings);
    setGroups(nextGroups);
    const displayedGroups = nextGroups.filter((group) => group.tb);
    const defaultGroup =
      displayedGroups.find((group) => group.needsReview) ?? displayedGroups[0];
    setExpanded((current) => {
      if (
        current &&
        nextGroups.some(
          (group) =>
            group.id === current.groupId &&
            (current.kind === "tb" ? group.tb : group.je),
        )
      )
        return current;
      if (!defaultGroup) return undefined;
      return {
        groupId: defaultGroup.id,
        kind: defaultGroup.tb ? "tb" : "je",
      };
    });
    // LLM 联合复核的结论跟着组走：组还在就继续算复核过，组被解散才清掉。
    const survivingIds = new Set(nextGroups.map((group) => group.id));
    setLlmReviews((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => survivingIds.has(id)),
      ),
    );
    setLlmReviewStatus("");
    if (displayedGroups.length > 0) setCurrentStep(1);
    setStatus(
      failures.length
        ? `${failures.length} 个来源没读成：${failures[0]}`
        : hiddenSheets
          ? `已识别可用账表；${hiddenSheets} 张低置信度工作表未显示。`
          : "",
    );
    setBusy(false);
  }

  /** 换一个 sheet 重读：识别默认挑内容最多的表，但审计师加工过的副本
   *  可能与原始导出并存——最终读哪张由用户说了算。 */
  async function switchSheet(
    file: PairingFile,
    kind: LedgerKind,
    sheet: string,
    headerRow = 0,
    headerDepth = 0,
  ) {
    if (!sheet || busy) return;
    setBusy(true);
    setError("");
    const oldKey = pairingFileKey(file);
    try {
      const inspected = (await engineCall(`fx.inspect_${kind}`, {
        source: { inputPath: file.path, sheet, headerRow, headerDepth },
      })) as Inspection;
      const nextFile = { ...file, sheet: inspected.sheet, entities: inspected.entities };
      const nextKey = pairingFileKey(nextFile);
      setInspects((current) => {
        const next = { ...current };
        delete next[oldKey];
        next[nextKey] = inspected;
        return next;
      });
      setMappings((current) => {
        const next = { ...current };
        delete next[oldKey];
        next[nextKey] = inspected.suggestedMapping;
        return next;
      });
      setGroups((current) =>
        current.map((group) => ({
          ...group,
          tb:
            group.tb && pairingFileKey(group.tb) === oldKey ? nextFile : group.tb,
          je:
            group.je && pairingFileKey(group.je) === oldKey ? nextFile : group.je,
        })),
      );
      invalidateResults();
    } catch (e) {
      setError(`${fileName(file.path)}：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function changeSourceKind(file: PairingFile, nextKind: LedgerKind) {
    if (file.kind === nextKind || busy) return;
    const key = pairingFileKey(file);
    const current = inspects[key];
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const inspected = (await engineCall(`fx.inspect_${nextKind}`, {
        source: {
          inputPath: file.path,
          sheet: current.sheet,
          headerRow: 0,
          headerDepth: 0,
        },
      })) as Inspection;
      const changed: PairingFile = {
        ...file,
        kind: nextKind,
        sheet: inspected.sheet,
        entities: inspected.entities,
      };
      const pool = groups
        .flatMap((group) => [group.tb, group.je])
        .filter((item): item is PairingFile => Boolean(item))
        .map((item) => (pairingFileKey(item) === key ? changed : item))
        .filter(
          (item, index, all) =>
            all.findIndex(
              (other) => pairingFileKey(other) === pairingFileKey(item),
            ) === index,
        );
      setInspects((value) => ({ ...value, [key]: inspected }));
      setMappings((value) => ({
        ...value,
        [key]: inspected.suggestedMapping,
      }));
      setGroups(pairLedgerFiles(pool));
      clearedTbsRef.current.clear();
      setExpanded(undefined);
      invalidateResults();
    } catch (e) {
      setError(`${pairingFileLabel(file)}：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 用户明确指定类型时不再经过分类器：选 Excel 后由对应 inspect 自动选正表，
   *  行内 Sheet 下拉仍可继续改。TB 是建组锚点；JE 可选、可替换。 */
  async function pickManualSource(kind: LedgerKind, groupId?: string) {
    if (busy) return;
    const picked = await pickPath(
      "file",
      kind === "tb" ? "选择科目余额表（TB）" : "选择序时账（JE）",
      ["xlsx", "xls", "xlsm", "csv"],
    );
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    setBusy(true);
    setError("");
    setStatus(
      `正在读取${kind === "tb" ? "科目余额表" : "序时账"}：${fileName(path)}`,
    );
    try {
      const inspected = (await engineCall(`fx.inspect_${kind}`, {
        source: { inputPath: path, sheet: "", headerRow: 0, headerDepth: 0 },
      })) as Inspection;
      const source: PairingFile = {
        path,
        sheet: inspected.sheet,
        kind,
        entities: inspected.entities,
      };
      const key = pairingFileKey(source);
      if (
        kind === "tb" &&
        groups.some(
          (group) => group.id !== groupId && group.tb && pairingFileKey(group.tb) === key,
        )
      ) {
        setError(`${pairingFileLabel(source)} 已在其他配对组中。`);
        return;
      }
      setInspects((current) => ({ ...current, [key]: inspected }));
      setMappings((current) => ({
        ...current,
        [key]: inspected.suggestedMapping,
      }));
      if (!groupId) {
        const manualGroup: PairedGroup = {
          id: `manual:${key}`,
          label: fileName(path).replace(/\.(?:xlsx?|xlsm|csv)$/i, ""),
          tb: source,
          reasons: ["手工指定 TB"],
          needsReview: true,
        };
        setGroups((current) => [...current, manualGroup].sort(compareGroups));
        setExpanded({ groupId: manualGroup.id, kind: "tb" });
        setCurrentStep(1);
      } else {
        setGroups((current) =>
          current
            .map((group) => {
              if (group.id === groupId) {
                return {
                  ...group,
                  [kind]: source,
                  reasons: [`手工指定 ${kind.toUpperCase()}`],
                  needsReview: kind === "tb" ? !group.je : false,
                };
              }
              // 同一 JE 只能属于一组；手工选中后从原组释放。
              if (kind === "je" && group.je && pairingFileKey(group.je) === key) {
                return {
                  ...group,
                  je: undefined,
                  reasons: ["序时账已手工移至另一组"],
                  needsReview: true,
                };
              }
              return group;
            })
            .filter((group) => group.tb || group.je)
            .sort(compareGroups),
        );
        clearedTbsRef.current.delete(groupId);
        setExpanded({ groupId, kind });
      }
      invalidateResults();
      setStatus(`${pairingFileLabel(source)} 已作为 ${kind.toUpperCase()} 加入。`);
    } catch (e) {
      setError(`${fileName(path)}：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const unusedJe = useMemo(
    () =>
      groups
        .filter((group) => group.je)
        .map((group) => ({
          id: pairingFileKey(group.je!),
          label: pairingFileLabel(group.je!),
          owner: group.label,
        })),
    [groups],
  );

  const runnable = visibleGroups;
  function invalidateResults(clearLlm = true) {
    activeJobId.current = "__inputs_changed__";
    setOutcomes([]);
    setDetail(undefined);
    setExported(undefined);
    setJob(undefined);
    if (clearLlm) {
      setLlmReviews({});
      setLlmReviewStatus("");
    }
  }

  async function removeGroup(group: PairedGroup) {
    if (
      !(await confirmDialog({
        title: "确认移除分组",
        message: `确认移除第 ${group.label} 组？只会从本次核对中清除，不会删除原文件。`,
        confirmLabel: "移除",
        tone: "danger",
      }))
    )
      return;
    const sourceKeys = [group.tb, group.je]
      .filter(Boolean)
      .map((file) => pairingFileKey(file!));
    setGroups((current) => current.filter((item) => item.id !== group.id));
    setInspects((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !sourceKeys.includes(key)),
      ),
    );
    setMappings((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !sourceKeys.includes(key)),
      ),
    );
    setExpanded((current) =>
      current?.groupId === group.id ? undefined : current,
    );
    clearedTbsRef.current.delete(group.id);
    if (visibleGroups.length === 1) setCurrentStep(0);
    invalidateResults();
  }

  async function removeAllGroups() {
    if (
      !(await confirmDialog({
        title: "确认移除全部分组",
        message: `确认移除全部 ${visibleGroups.length} 组？只会清空本次核对，不会删除原文件。`,
        confirmLabel: "移除",
        tone: "danger",
      }))
    )
      return;
    setGroups([]);
    setInspects({});
    setMappings({});
    setExpanded(undefined);
    setLlmReviews({});
    setLlmReviewStatus("");
    clearedTbsRef.current.clear();
    setStatus("");
    setCurrentStep(0);
    invalidateResults();
  }

  function selectJe(groupId: string, sourceId?: string) {
    setGroups((current) => reassignJe(current, groupId, sourceId));
    if (sourceId) clearedTbsRef.current.delete(groupId);
    else clearedTbsRef.current.add(groupId);
    setExpanded(undefined);
    invalidateResults();
  }

  const goToStep = (index: number) => {
    setCurrentStep(index);
  };

  const reviewTargetsOf = (group: PairedGroup) => {
    const target = (kind: LedgerKind, file?: PairingFile) => {
      if (!file) return undefined;
      const key = pairingFileKey(file);
      const inspection = inspects[key];
      if (!inspection) return undefined;
      return {
        headers: inspection.headers,
        preview: inspection.preview ?? [],
        mapping: Object.fromEntries(
          Object.entries(mappings[key] ?? {}).filter(
            ([, value]) => typeof value === "string" || Array.isArray(value),
          ),
        ) as Record<string, string | string[]>,
        labels: resolveRoleLabels(
          inspection.roles,
          kind === "tb" ? TB_LABELS : JE_LABELS,
        ),
        tool: "tbje_check",
        pairLabel: group.label,
      };
    };
    return { tb: target("tb", group.tb), je: target("je", group.je) };
  };

  /** 页面级一键复核：每组一次真正的 TB＋JE 联合请求，最多并发两组。 */
  async function reviewAllGroups() {
    const candidates = visibleGroups.filter((group) => {
      const targets = reviewTargetsOf(group);
      return targets.tb || targets.je;
    });
    if (!candidates.length || llmReviewBusy) return;
    invalidateResults(false);
    setError("");
    setBusy(true);
    setLlmReviewBusy(true);
    setLlmReviewStatus(`正在联合复核 0 / ${candidates.length} 组…`);
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const group = candidates[cursor++];
        const result = await applyLedgerReviewsTogether(
          engineCall,
          reviewTargetsOf(group),
        );
        if (Object.values(result).some((item) => item?.failed)) failed += 1;
        setLlmReviews((current) => ({ ...current, [group.id]: result }));
        setMappings((current) => {
          const next = { ...current };
          if (group.tb && result.tb && !result.tb.failed)
            next[pairingFileKey(group.tb)] = result.tb.mapping;
          if (group.je && result.je && !result.je.failed)
            next[pairingFileKey(group.je)] = result.je.mapping;
          return next;
        });
        completed += 1;
        setLlmReviewStatus(
          `正在联合复核 ${completed} / ${candidates.length} 组…`,
        );
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(2, candidates.length) }, worker),
      );
      setLlmReviewStatus(
        failed
          ? `联合复核完成：${candidates.length - failed} 组成功，${failed} 组失败；失败组保留 Coding 映射。`
          : `联合复核完成：已复核 ${candidates.length} 组。`,
      );
    } finally {
      setBusy(false);
      setLlmReviewBusy(false);
    }
  }

  function undoGroupReview(
    group: PairedGroup,
    kind: LedgerKind,
    index: number,
  ) {
    const file = kind === "tb" ? group.tb : group.je;
    const outcome = llmReviews[group.id]?.[kind];
    const change = outcome?.applied[index];
    if (!file || !outcome || !change) return;
    const mapping = { ...outcome.mapping };
    if (change.beforeValue === undefined) delete mapping[change.role];
    else
      mapping[change.role] = Array.isArray(change.beforeValue)
        ? [...change.beforeValue]
        : change.beforeValue;
    const applied = outcome.applied.filter((_, at) => at !== index);
    setMappings((current) => ({
      ...current,
      [pairingFileKey(file)]: mapping,
    }));
    setLlmReviews((current) => ({
      ...current,
      [group.id]: {
        ...current[group.id],
        [kind]: { ...outcome, mapping, applied, appliedCount: applied.length },
      },
    }));
    invalidateResults(false);
  }

  function acceptGroupPending(
    group: PairedGroup,
    kind: LedgerKind,
    index: number,
  ) {
    const file = kind === "tb" ? group.tb : group.je;
    const outcome = llmReviews[group.id]?.[kind];
    const change = outcome?.pending[index];
    if (!file || !outcome || !change) return;
    const mapping = { ...outcome.mapping };
    const beforeValue = mapping[change.role];
    mapping[change.role] = LEDGER_MULTI_COLUMN_ROLES.has(change.role)
      ? [
          ...new Set([
            ...(Array.isArray(beforeValue)
              ? beforeValue
              : beforeValue
                ? [beforeValue]
                : []),
            change.suggestedColumn,
          ]),
        ]
      : change.suggestedColumn;
    const pending = outcome.pending.filter((_, at) => at !== index);
    const applied = [
      ...outcome.applied,
      {
        ...change,
        beforeValue: Array.isArray(beforeValue)
          ? [...beforeValue]
          : beforeValue,
        currentColumn: Array.isArray(beforeValue)
          ? beforeValue.join("＋")
          : beforeValue || "未映射",
        attention: true,
      },
    ];
    setMappings((current) => ({
      ...current,
      [pairingFileKey(file)]: mapping,
    }));
    setLlmReviews((current) => ({
      ...current,
      [group.id]: {
        ...current[group.id],
        [kind]: {
          ...outcome,
          mapping,
          applied,
          pending,
          appliedCount: applied.length,
        },
      },
    }));
    invalidateResults(false);
  }

  function paramsOf(group: PairedGroup) {
    const source = (file?: PairingFile) => {
      if (!file) return undefined;
      const inspected = inspects[pairingFileKey(file)];
      if (!inspected) return undefined;
      return {
        inputPath: file.path,
        sheet: inspected.sheet,
        headerRow: inspected.headerRow,
        headerDepth: inspected.headerDepth,
      };
    };
    const params: Record<string, unknown> = {
      label: group.label,
      tbSource: source(group.tb),
      tbMapping: mappings[pairingFileKey(group.tb!)] ?? {},
    };
    const je = source(group.je);
    if (je) {
      params.jeSource = je;
      params.jeMapping = mappings[pairingFileKey(group.je!)] ?? {};
    }
    return params;
  }

  /** 导出某一组的差异明细。逐组导——十组的明细塞一个工作簿没法看。 */
  async function exportGroup(label: string) {
    const group = runnable.find((item) => item.label === label);
    if (!group?.tb) return;
    const suggested = group.tb.path.replace(/\.[^.\/]+$/, `_完整性核对.xlsx`);
    const picked = await pickPath(
      "save",
      `导出第 ${label} 组的核对明细`,
      ["xlsx"],
      fileName(suggested),
    );
    if (!picked || typeof picked !== "string") return;
    setError("");
    setBusy(true);
    try {
      const id = await jobStart("tbje_check.export", {
        ...paramsOf(group),
        outputPath: picked,
      });
      activeJobId.current = id;
      setJob({
        jobId: id,
        toolId: "tbje_check",
        phase: "running",
        message: "正在导出明细…",
      } as never);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  /** 一次选目录，把所有成功核对的组分别导出为完整工作簿。 */
  async function exportAll() {
    const successful = runnable.filter((group) =>
      outcomes.some((outcome) => outcome.label === group.label && outcome.ok),
    );
    if (!successful.length) return;
    const picked = await pickPath("folder", "选择全部核对结果的导出文件夹", []);
    if (!picked || typeof picked !== "string") return;
    setError("");
    setExported(undefined);
    setBusy(true);
    try {
      const id = await jobStart("tbje_check.export_batch", {
        groups: successful.map(paramsOf),
        outputDirectory: picked,
      });
      activeJobId.current = id;
      setJob({
        jobId: id,
        toolId: "tbje_check",
        phase: "running",
        message: `正在导出全部 ${successful.length} 组核对结果…`,
      } as never);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  async function runAll() {
    if (!runnable.length) return;
    setError("");
    setOutcomes([]);
    setBusy(true);
    try {
      const alignedGroups: Record<string, unknown>[] = [];
      const correctedMappings: Record<string, Mapping> = {};
      const alignmentWarnings: string[] = [];
      for (const group of runnable) {
        const groupParams = paramsOf(group);
        if (group.je) {
          const alignment = (await engineCall(
            "ledger.check_mapping_alignment",
            groupParams,
          )) as {
            aligned?: boolean;
            errors?: string[];
            warnings?: string[];
            fix?: {
              jeMapping?: Mapping;
              tbMapping?: Mapping;
            };
          };
          if (alignment.aligned === false) {
            throw new Error(
              alignment.errors?.[0] ?? "TB与JE的科目字段无法对齐。",
            );
          }
          if (alignment.fix?.tbMapping && group.tb) {
            groupParams.tbMapping = {
              ...(groupParams.tbMapping as Mapping),
              ...alignment.fix.tbMapping,
            };
            correctedMappings[pairingFileKey(group.tb)] =
              groupParams.tbMapping as Mapping;
          }
          if (alignment.fix?.jeMapping) {
            groupParams.jeMapping = {
              ...(groupParams.jeMapping as Mapping),
              ...alignment.fix.jeMapping,
            };
            correctedMappings[pairingFileKey(group.je)] =
              groupParams.jeMapping as Mapping;
          }
          alignmentWarnings.push(...(alignment.warnings ?? []));
        }
        alignedGroups.push(groupParams);
      }
      if (Object.keys(correctedMappings).length) {
        setMappings((current) => ({ ...current, ...correctedMappings }));
      }
      if (alignmentWarnings.length) setStatus(alignmentWarnings[0]);
      const id = await jobStart("tbje_check.run_batch", {
        groups: alignedGroups,
      });
      activeJobId.current = id;
      setJob({
        jobId: id,
        toolId: "tbje_check",
        phase: "running",
        message: "正在核对…",
      } as never);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const resultReviewCount = outcomes.filter(
    (outcome) =>
      !outcome.ok ||
      [
        outcome.result?.rollforward,
        outcome.result?.tbVsJe,
        outcome.result?.equation,
      ].some((verdict) => !verdict?.performed || verdict.passed !== true),
  ).length;

  return (
    <main className="tool-page fx-page tbje-page">
      <PageHeader
        eyebrow="账套完整性"
        title={tool.name}
        detail="批量配对科目余额表与序时账，统一核对勾稽关系、发生额和会计恒等式。"
      />
      <StepIndicator
        steps={[
          { key: "files", label: "添加文件" },
          {
            key: "pairing",
            label: "确认配对",
            disabled: visibleGroups.length === 0,
          },
          {
            key: "results",
            label: "查看结果",
            disabled: outcomes.length === 0,
          },
        ]}
        current={currentStep}
        onStepClick={goToStep}
      />

      {error && <ErrorBox error={error} onDismiss={() => setError("")} />}
      {job && (
        <JobProgress
          job={job}
          onCancel={busy ? (id) => void jobCancel(id) : undefined}
        />
      )}

      {currentStep === 0 && (
        <section
          ref={intakeSectionRef}
          className="tbje-section"
          aria-labelledby="tbje-files-title"
        >
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 id="tbje-files-title" className="tbje-section-title">
                  1. 添加 TB 与 JE 文件
                </h2>
              </CardTitle>
              <CardDescription>
                把多组科目余额表和序时账一起加入。系统逐 Sheet 识别类型，优先配对同一工作簿，再按文件名与主体信息配对。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataHandlingNotice
                mode="network-assisted"
                title="核对默认在本机完成"
                description="文件读取与勾稽在本机进行；AI 辅助识别或 LLM 联合复核可能将字段名和预览样本按设置发送到所配置服务。"
                details="至少加入一份 TB；如需核对 TB 与 JE 发生额，请为同组补充 JE。"
              />
              <div ref={dropRef}>
                <FileDropInput
                  value=""
                  placeholder="把多组 TB 与 JE 一起拖进来，或点击选择"
                  disabled={busy}
                  onBrowse={() => void browse()}
                  onDragStateChange={setDropActive}
                  highlight={dropActive}
                />
              </div>
              <div className="tbje-manual-entry">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void pickManualSource("tb")}
                >
                  <Plus aria-hidden="true" />
                  手动添加配对组
                </Button>
                <span>先选择 TB Excel；进入配对组后可再选择 JE Excel 和两侧 Sheet。</span>
              </div>
              {visibleGroups.length === 0 && (
                <EmptyState
                  compact
                  title="准备核对资料"
                  description="加入至少一份科目余额表（TB）；如需发生额勾稽，再加入对应的序时账（JE）。支持一次拖入多组文件。"
                />
              )}
              {status && (
                <p className="tbje-status" role="status" aria-live="polite">
                  <i aria-hidden="true" />
                  {status}
                </p>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {currentStep === 1 && visibleGroups.length > 0 && (
        <section
          ref={pairingSectionRef}
          className="tbje-section"
          aria-labelledby="tbje-pairing-title"
        >
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 id="tbje-pairing-title" className="tbje-section-title">
                  2. 确认配对与字段{" "}
                  <span className="tbje-count">
                    {visibleGroups.length} 组
                    {visibleGroups.some((group) => group.needsReview) &&
                      ` · ${visibleGroups.filter((g) => g.needsReview).length} 组待确认`}
                  </span>
                </h2>
              </CardTitle>
              <CardDescription>
                只展示已找到 TB 的配对组；未配上的 JE 会保留为可选来源，不单独占一行。也可手工选择两侧 Excel 与 Sheet。
              </CardDescription>
              <div className="tbje-llm-action">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void pickManualSource("tb")}
                >
                  <Plus aria-hidden="true" />
                  手动添加配对组
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || !visibleGroups.length}
                  onClick={() => void reviewAllGroups()}
                >
                  {llmReviewBusy
                    ? "LLM 联合复核中…"
                    : `LLM 一键联合复核 ${visibleGroups.length} 组`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || !visibleGroups.length}
                  className="tbje-remove-all"
                  onClick={removeAllGroups}
                >
                  <Trash2 aria-hidden="true" />
                  移除全部
                </Button>
                {llmReviewStatus && (
                  <span aria-live="polite">{llmReviewStatus}</span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="tbje-pairing-list">
                <div className="tbje-pairing-head" aria-hidden="true">
                  <span>配对组</span>
                  <span>科目余额表 TB</span>
                  <span>序时账 JE</span>
                  <span>字段预览与映射</span>
                </div>
                {visibleGroups.map((group) => (
                  <div
                    key={group.id}
                    className={`tbje-group${group.needsReview ? " tbje-group-review" : ""}`}
                  >
                    <div className="tbje-group-row">
                      <div className="tbje-group-identity">
                        <strong title={`第 ${group.label} 组`}>
                          第 {group.label} 组
                        </strong>
                        <span
                          className={`tbje-pair-status${group.needsReview ? " review" : ""}`}
                        >
                          <i aria-hidden="true" />
                          {group.needsReview ? "待确认" : "已识别"}
                        </span>
                      </div>
                      <div className="tbje-file-cell">
                        <div className="tbje-file-line">
                          <span className="tbje-kind-tag">TB</span>
                          <span
                            className="tbje-group-file"
                            title={group.tb?.path}
                          >
                            {fileName(group.tb!.path)}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="tbje-pick-file"
                            disabled={busy}
                            onClick={() => void pickManualSource("tb", group.id)}
                          >
                            <FolderOpen aria-hidden="true" />
                            更换 Excel
                          </Button>
                        </div>
                        {group.tb &&
                          (() => {
                            const inspected = inspects[pairingFileKey(group.tb)];
                            if (!inspected) return null;
                            const sheets = inspected.sheets ?? [];
                            return (
                              <label className="tbje-sheet-picker">
                                <span>工作表</span>
                                {sheets.length > 1 ? (
                                  <select
                                    aria-label="余额表使用的工作表"
                                    value={inspected.sheet}
                                    disabled={busy}
                                    onChange={(event) =>
                                      void switchSheet(
                                        group.tb!,
                                        "tb",
                                        event.target.value,
                                      )
                                    }
                                  >
                                    {sheets.map((name) => (
                                      <option key={name} value={name}>
                                        {name}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="tbje-sheet-name">
                                    {inspected.sheet || "（自动）"}
                                  </span>
                                )}
                              </label>
                            );
                          })()}
                      </div>
                      <div className="tbje-file-cell">
                        <div className="tbje-file-line">
                          <span className="tbje-kind-tag je">JE</span>
                          <select
                            className="tbje-je-select"
                            title={group.je?.path}
                            aria-label={`为第 ${group.label} 组选择序时账`}
                            value={group.je ? pairingFileKey(group.je) : ""}
                            disabled={busy}
                            onChange={(event) =>
                              selectJe(
                                group.id,
                                event.target.value || undefined,
                              )
                            }
                          >
                            <option value="">（不配对序时账）</option>
                            {unusedJe.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label}
                                {item.id === (group.je ? pairingFileKey(group.je) : "")
                                  ? ""
                                  : ` · 现属第 ${item.owner} 组`}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="tbje-pick-file"
                            disabled={busy}
                            onClick={() => void pickManualSource("je", group.id)}
                          >
                            <FolderOpen aria-hidden="true" />
                            {group.je ? "更换 Excel" : "选择 Excel"}
                          </Button>
                        </div>
                        {group.je &&
                          (() => {
                            const inspected = inspects[pairingFileKey(group.je)];
                            if (!inspected) return null;
                            const sheets = inspected.sheets ?? [];
                            return (
                              <label className="tbje-sheet-picker">
                                <span>工作表</span>
                                {sheets.length > 1 ? (
                                  <select
                                    aria-label="序时账使用的工作表"
                                    value={inspected.sheet}
                                    disabled={busy}
                                    onChange={(event) =>
                                      void switchSheet(
                                        group.je!,
                                        "je",
                                        event.target.value,
                                      )
                                    }
                                  >
                                    {sheets.map((name) => (
                                      <option key={name} value={name}>
                                        {name}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="tbje-sheet-name">
                                    {inspected.sheet || "（自动）"}
                                  </span>
                                )}
                              </label>
                            );
                          })()}
                      </div>
                      <div className="tbje-group-buttons">
                        {(["tb", "je"] as LedgerKind[]).map((kind) => {
                          const active =
                            expanded?.groupId === group.id &&
                            expanded.kind === kind;
                          const available = kind === "tb" ? group.tb : group.je;
                          return (
                            <Button
                              key={kind}
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busy || !available}
                              aria-expanded={active}
                              aria-controls={`tbje-mapping-${group.id}-${kind}`}
                              onClick={() =>
                                setExpanded(
                                  active
                                    ? undefined
                                    : { groupId: group.id, kind },
                                )
                              }
                            >
                              <Eye aria-hidden="true" />
                              {active
                                ? `收起 ${kind.toUpperCase()} 映射`
                                : `查看并调整 ${kind.toUpperCase()} 映射`}
                            </Button>
                          );
                        })}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          className="tbje-remove-group"
                          onClick={() => removeGroup(group)}
                        >
                          <Trash2 aria-hidden="true" />
                          移除本组
                        </Button>
                      </div>
                    </div>
                    {llmReviews[group.id] &&
                      (() => {
                        const review = llmReviews[group.id];
                        const present = (["tb", "je"] as LedgerKind[]).filter(
                          (kind) => review[kind],
                        );
                        const failed = present.some(
                          (kind) => review[kind]?.failed,
                        );
                        const changed = present.some(
                          (kind) =>
                            (review[kind]?.applied.length ?? 0) > 0 ||
                            (review[kind]?.pending.length ?? 0) > 0,
                        );
                        return (
                          <div
                            className="tbje-group-llm-result"
                            aria-live="polite"
                          >
                            <span className={failed ? "failed" : undefined}>
                              {failed
                                ? "LLM 联合复核失败，已保留 Coding 映射。"
                                : changed
                                  ? "LLM 联合复核完成"
                                  : "LLM 联合复核完成，当前映射无需调整。"}
                            </span>
                            <LedgerReviewCompact
                              present={present}
                              names={{ tb: "TB", je: "JE" }}
                              results={review}
                              onUndo={(kind, index) =>
                                undoGroupReview(group, kind, index)
                              }
                              onAccept={(kind, index) =>
                                acceptGroupPending(group, kind, index)
                              }
                            />
                          </div>
                        );
                      })()}
                    {expanded?.groupId === group.id && (
                      <div
                        id={`tbje-mapping-${group.id}-${expanded.kind}`}
                        className="tbje-group-mapping"
                      >
                        {(() => {
                          const file =
                            expanded.kind === "tb" ? group.tb : group.je;
                          if (!file) return null;
                          return (
                            <LedgerMappingPanel
                              key={pairingFileKey(file)}
                              kind={file.kind}
                              inspection={inspects[pairingFileKey(file)]}
                              mapping={
                                (mappings[pairingFileKey(file)] ?? {}) as MappingDict
                              }
                              disabled={busy}
                              onHeaderChange={(row, depth) =>
                                void switchSheet(
                                  file,
                                  file.kind,
                                  inspects[pairingFileKey(file)]?.sheet ??
                                    file.sheet ??
                                    "",
                                  row,
                                  depth,
                                )
                              }
                              onKindChange={() =>
                                void changeSourceKind(
                                  file,
                                  file.kind === "tb" ? "je" : "tb",
                                )
                              }
                              onChange={(next) => {
                                setMappings((current) => ({
                                  ...current,
                                  [pairingFileKey(file)]: next,
                                }));
                                invalidateResults();
                              }}
                            />
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="tbje-actions">
                <Button
                  type="button"
                  disabled={busy || !runnable.length}
                  onClick={() => void runAll()}
                >
                  开始核对 {runnable.length} 组
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {currentStep === 2 && outcomes.length > 0 && (
        <section
          ref={resultSectionRef}
          className="tbje-section"
          aria-labelledby="tbje-results-title"
        >
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 id="tbje-results-title" className="tbje-section-title">
                  3. 查看核对结果
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="tbje-result-toolbar">
                <div className="tbje-result-overview" role="status">
                  <Badge
                    variant="outline"
                    className={
                      resultReviewCount ? "badge-warning" : "badge-ready"
                    }
                  >
                    {resultReviewCount
                      ? `${resultReviewCount} 组需复核`
                      : "全部核对通过"}
                  </Badge>
                  <span className="fx-hint">
                    {resultReviewCount
                      ? "先预览异常组并检查字段映射，确认后再导出底稿。"
                      : "未发现异常，可逐组预览或一次导出全部结果。"}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !outcomes.some((outcome) => outcome.ok)}
                  onClick={() => void exportAll()}
                >
                  <Download aria-hidden="true" />
                  导出全部结果
                </Button>
              </div>
              <div className="tbje-result-table-wrap">
                <Table className="tbje-result-table">
                  <caption className="sr-only">TB/JE 完整性核对结果</caption>
                  <colgroup>
                    <col className="tbje-col-group" />
                    <col className="tbje-col-check" />
                    <col className="tbje-col-check" />
                    <col className="tbje-col-check" />
                    <col className="tbje-col-actions" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">组</TableHead>
                      <TableHead scope="col">
                        {CHECK_NAMES.rollforward}
                      </TableHead>
                      <TableHead scope="col">{CHECK_NAMES.tbVsJe}</TableHead>
                      <TableHead scope="col">{CHECK_NAMES.equation}</TableHead>
                      <TableHead scope="col">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outcomes.map((outcome) => (
                      <Fragment key={outcome.label}>
                        <TableRow>
                          <TableCell className="tbje-group-result">
                            {outcome.label || "—"}
                          </TableCell>
                          {outcome.ok ? (
                            <>
                              <TableCell>
                                <VerdictBadge
                                  verdict={outcome.result?.rollforward}
                                />
                                {outcome.result?.rollforward.mismatched ? (
                                  <span className="tbje-detail">
                                    {outcome.result.rollforward.mismatched} /{" "}
                                    {outcome.result.rollforward.checked} 行
                                  </span>
                                ) : null}
                              </TableCell>
                              <TableCell>
                                <TbJeVerdict check={outcome.result?.tbVsJe} />
                                {outcome.result?.tbVsJe.mismatched ? (
                                  <span className="tbje-detail">
                                    {outcome.result.tbVsJe.mismatched} /{" "}
                                    {outcome.result.tbVsJe.accounts} 科目
                                    {(outcome.result.tbVsJe.netMismatched ??
                                      0) > 0 &&
                                      ` · ${outcome.result.tbVsJe.netMismatched} 个科目净额不通过`}
                                    {outcome.result.tbVsJe.widespread &&
                                      " · 大范围差异"}
                                  </span>
                                ) : null}
                              </TableCell>
                              <TableCell>
                                <EquationVerdict
                                  equation={outcome.result?.equation}
                                />
                                {outcome.result?.equation.closing ? (
                                  <span className="tbje-detail">
                                    已归类科目合计{" "}
                                    {money(
                                      outcome.result.equation.closing.total,
                                    )}
                                    {(outcome.result.equation.unclassified
                                      ?.length ?? 0) > 0 &&
                                      ` · ${outcome.result!.equation.unclassified!.length} 个科目未纳入勾稽`}
                                  </span>
                                ) : null}
                              </TableCell>
                            </>
                          ) : (
                            <TableCell colSpan={3} className="tbje-failed">
                              {outcome.error}
                            </TableCell>
                          )}
                          <TableCell className="tbje-detail-actions">
                            {outcome.ok && (
                              <div className="tbje-action-group">
                                <Button
                                  type="button"
                                  variant="default"
                                  size="sm"
                                  disabled={busy}
                                  aria-expanded={detail === outcome.label}
                                  aria-controls={`tbje-result-detail-${outcome.label}`}
                                  onClick={() =>
                                    setDetail(
                                      detail === outcome.label
                                        ? undefined
                                        : outcome.label,
                                    )
                                  }
                                >
                                  <Eye aria-hidden="true" />
                                  {detail === outcome.label
                                    ? "收起明细"
                                    : "预览明细"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    void exportGroup(outcome.label)
                                  }
                                >
                                  <Download aria-hidden="true" />
                                  导出明细
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                        {detail === outcome.label &&
                          outcome.ok &&
                          outcome.result && (
                            <TableRow className="tbje-detail-row">
                              <TableCell
                                id={`tbje-result-detail-${outcome.label}`}
                                colSpan={5}
                              >
                                <OutcomeDetail result={outcome.result} />
                              </TableCell>
                            </TableRow>
                          )}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {exported && (
                <div className="tbje-exported" role="status" aria-live="polite">
                  <span title={exported.path}>
                    {exported.batch ? "全部结果已导出至：" : "明细已导出："}
                    {fileName(exported.path)}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void openOutput(exported.path)}
                  >
                    {exported.batch ? "打开导出文件夹" : "打开导出文件"}
                  </Button>
                </div>
              )}
              {outcomes.some(
                (outcome) => outcome.result?.tbVsJe.widespread,
              ) && (
                <p className="fx-hint">
                  有组的绝大多数科目存在单边发生额差异，请依次复核字段映射、金额口径与期间范围；
                  只有日期或会计期间字段提供直接证据时，工具才会提示期间不匹配。
                </p>
              )}
            </CardContent>
          </Card>
        </section>
      )}
    </main>
  );
}

/**
 * TB／JE 字段映射面板。下拉分组与必填标记跟着当前命中的型走，
 * 与 FA TBJE、汇兑损益是同一套（型的定义在 Rust，由 `ledger.forms` 下发）。
 */
function LedgerMappingPanel(props: {
  kind: LedgerKind;
  inspection?: Inspection;
  mapping: MappingDict;
  disabled?: boolean;
  onHeaderChange?: (row: number, depth: number) => void;
  onKindChange?: () => void;
  onChange: (next: MappingDict) => void;
}) {
  // 标签优先取引擎随识别结果下发的 roles（deposit.inspect_* 响应），
  // 未下发或没有该角色时回落本地标签表——清单与顺序仍由本地表定。
  const labels = resolveRoleLabels(
    props.inspection?.roles,
    props.kind === "tb" ? TB_LABELS : JE_LABELS,
  );
  const roles = Object.entries(labels) as [string, string][];
  const forms = useLedgerForms(props.kind);
  const match = forms.length
    ? resolveForm(props.kind, forms, props.mapping)
    : undefined;
  if (!props.inspection) return null;
  return (
    <MappingPanel
      title={props.kind === "tb" ? "科目余额表字段映射" : "序时账字段映射"}
      headers={props.inspection.headers}
      rows={props.inspection.preview ?? []}
      mapping={props.mapping}
      roles={roles}
      groups={formGroups(props.kind, roles, forms, props.mapping)}
      requirementOf={(role) => roleRequirement(match, role)}
      formNote={describeForm(match, (role) => labels[role] ?? role)}
      multi={MULTI_COLUMN_ROLES}
      busy={props.disabled}
      toolbar={
        props.onHeaderChange ? (
          <>
            <label>
              标题行
              <input
                type="number"
                min={1}
                value={props.inspection.headerRow}
                disabled={props.disabled}
                onChange={(event) =>
                  props.onHeaderChange?.(
                    Number(event.target.value),
                    props.inspection!.headerDepth,
                  )
                }
              />
            </label>
            <label>
              表头层数
              <select
                value={props.inspection.headerDepth}
                disabled={props.disabled}
                onChange={(event) =>
                  props.onHeaderChange?.(
                    props.inspection!.headerRow,
                    Number(event.target.value),
                  )
                }
              >
                <option value={1}>1 层</option>
                <option value={2}>2 层</option>
              </select>
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={props.disabled}
              onClick={props.onKindChange}
            >
              更正为 {props.kind === "tb" ? "JE" : "TB"}
            </Button>
          </>
        ) : undefined
      }
      onChange={props.onChange}
    />
  );
}
