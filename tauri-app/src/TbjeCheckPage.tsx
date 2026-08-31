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
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
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
import { Download, Eye, Trash2 } from "lucide-react";
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
  resolveLedgerPairKinds,
  resolveRoleLabels,
  type LedgerSourceClassification,
} from "@/ledgerMapping";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  useLedgerForms,
} from "@/ledgerForms";
import {
  fileName,
  pairLedgerFiles,
  reassignJe,
  type LedgerKind,
  type PairedGroup,
  type PairingFile,
} from "./tbjePairing";
import type { ToolManifest } from "./types";
import "./fx-audit.css";
import "./tbje-check.css";

type Mapping = MappingDict;

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
  const [expanded, setExpanded] = useState<
    { groupId: string; kind: LedgerKind } | undefined
  >();
  const [detail, setDetail] = useState<string | undefined>();
  const [outcomes, setOutcomes] = useState<GroupOutcome[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [exported, setExported] = useState<
    { path: string; batch: boolean } | undefined
  >();
  const dropRef = useRef<HTMLDivElement | null>(null);
  const intakeSectionRef = useRef<HTMLElement | null>(null);
  const pairingSectionRef = useRef<HTMLElement | null>(null);
  const resultSectionRef = useRef<HTMLElement | null>(null);

  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "tbje_check",
    onEvent: (event) => {
      const payload = event.result as { groups?: GroupOutcome[] } | undefined;
      if (payload?.groups) setOutcomes(payload.groups);
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
    const files = selected.filter((path) => /\.(xlsx?|xlsm|csv)$/i.test(path));
    if (!files.length) return;
    setError("");
    invalidateResults();
    setBusy(true);
    const failures: string[] = [];
    const recognized: PairingFile[] = [];
    const nextInspects: Record<string, Inspection> = { ...inspects };
    const nextMappings: Record<string, Mapping> = { ...mappings };
    for (const [index, path] of files.entries()) {
      setStatus(`正在识别 ${index + 1} / ${files.length}：${fileName(path)}`);
      try {
        const classified = (await engineCall("deposit.classify_source", {
          source: { inputPath: path, sheet: "", headerRow: 0, headerDepth: 0 },
        })) as LedgerSourceClassification & {
          sheet: string;
          headerRow: number;
          headerDepth: number;
        };
        const kind = (resolveLedgerPairKinds([classified])[0] ??
          classified.kind) as LedgerKind;
        const inspected = (await engineCall(`fx.inspect_${kind}`, {
          source: {
            inputPath: path,
            sheet: classified.sheet,
            headerRow: classified.headerRow,
            headerDepth: classified.headerDepth,
          },
        })) as Inspection;
        nextInspects[path] = inspected;
        nextMappings[path] = inspected.suggestedMapping;
        recognized.push({ path, kind, entities: inspected.entities });
      } catch (e) {
        failures.push(`${fileName(path)}：${errorText(e)}`);
      }
    }
    // 已经在列表里的文件也参与重新配对，否则分两次拖入就配不到一起。
    const existing: PairingFile[] = groups.flatMap((group) =>
      [group.tb, group.je].filter(Boolean).map((file) => file!),
    );
    const merged = [...existing, ...recognized].filter(
      (file, index, all) =>
        all.findIndex((other) => other.path === file.path) === index,
    );
    setInspects(nextInspects);
    setMappings(nextMappings);
    setGroups(pairLedgerFiles(merged));
    setStatus(
      failures.length ? `${failures.length} 份文件没读成：${failures[0]}` : "",
    );
    setBusy(false);
  }

  /** 换一个 sheet 重读：识别默认挑内容最多的表，但审计师加工过的副本
   *  可能与原始导出并存——最终读哪张由用户说了算。 */
  async function switchSheet(path: string, kind: LedgerKind, sheet: string) {
    if (!sheet || busy) return;
    setBusy(true);
    setError("");
    try {
      const inspected = (await engineCall(`fx.inspect_${kind}`, {
        source: { inputPath: path, sheet, headerRow: 0, headerDepth: 0 },
      })) as Inspection;
      setInspects((current) => ({ ...current, [path]: inspected }));
      setMappings((current) => ({
        ...current,
        [path]: inspected.suggestedMapping,
      }));
      invalidateResults();
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
        .map((group) => ({ path: group.je!.path, owner: group.label })),
    [groups],
  );

  const runnable = groups.filter((group) => group.tb);
  const currentStep = outcomes.length > 0 ? 2 : groups.length > 0 ? 1 : 0;

  function invalidateResults() {
    activeJobId.current = "__inputs_changed__";
    setOutcomes([]);
    setDetail(undefined);
    setExported(undefined);
    setJob(undefined);
  }

  function removeGroup(group: PairedGroup) {
    if (
      !window.confirm(
        `确认移除第 ${group.label} 组？只会从本次核对中清除，不会删除原文件。`,
      )
    )
      return;
    const paths = [group.tb?.path, group.je?.path].filter(Boolean) as string[];
    setGroups((current) => current.filter((item) => item.id !== group.id));
    setInspects((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([path]) => !paths.includes(path)),
      ),
    );
    setMappings((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([path]) => !paths.includes(path)),
      ),
    );
    setExpanded((current) =>
      current?.groupId === group.id ? undefined : current,
    );
    invalidateResults();
  }

  function selectJe(groupId: string, path?: string) {
    setGroups((current) => reassignJe(current, groupId, path));
    setExpanded(undefined);
    invalidateResults();
  }

  const goToStep = (index: number) => {
    [intakeSectionRef, pairingSectionRef, resultSectionRef][
      index
    ]?.current?.scrollIntoView({
      block: "start",
    });
  };

  function paramsOf(group: PairedGroup) {
    const source = (file?: PairingFile) => {
      if (!file) return undefined;
      const inspected = inspects[file.path];
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
      tbMapping: mappings[group.tb!.path] ?? {},
    };
    const je = source(group.je);
    if (je) {
      params.jeSource = je;
      params.jeMapping = mappings[group.je!.path] ?? {};
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
            correctedMappings[group.tb.path] = groupParams.tbMapping as Mapping;
          }
          if (alignment.fix?.jeMapping) {
            groupParams.jeMapping = {
              ...(groupParams.jeMapping as Mapping),
              ...alignment.fix.jeMapping,
            };
            correctedMappings[group.je.path] = groupParams.jeMapping as Mapping;
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
          { key: "pairing", label: "确认配对", disabled: groups.length === 0 },
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
              把多组科目余额表和序时账一起加入。系统先识别文件类型，再按文件名与主体信息自动配对。
            </CardDescription>
          </CardHeader>
          <CardContent>
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
            {status && (
              <p className="tbje-status" role="status" aria-live="polite">
                {status}
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {groups.length > 0 && (
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
                    {groups.length} 组
                    {groups.some((group) => group.needsReview) &&
                      ` · ${groups.filter((g) => g.needsReview).length} 组待确认`}
                  </span>
                </h2>
              </CardTitle>
              <CardDescription>
                配对仅依据文件名和识别出的主体信息；待确认项目需要在核对前人工检查。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="tbje-groups">
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className={`tbje-group${group.needsReview ? " tbje-group-review" : ""}`}
                  >
                    <div className="tbje-group-row">
                      <span className="tbje-group-label">
                        {group.needsReview ? "待确认" : `第 ${group.label} 组`}
                      </span>
                      <span className="tbje-group-file">
                        {group.tb
                          ? fileName(group.tb.path)
                          : "（缺科目余额表）"}
                      </span>
                      <span className="tbje-group-arrow" aria-hidden="true">
                        ↔
                      </span>
                      <select
                        aria-label={`为第 ${group.label} 组选择序时账`}
                        value={group.je?.path ?? ""}
                        disabled={busy}
                        onChange={(event) =>
                          selectJe(group.id, event.target.value || undefined)
                        }
                      >
                        <option value="">（不配对序时账）</option>
                        {unusedJe.map((item) => (
                          <option key={item.path} value={item.path}>
                            {fileName(item.path)}
                            {item.path === group.je?.path
                              ? ""
                              : ` · 现属第 ${item.owner} 组`}
                          </option>
                        ))}
                      </select>
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
                              variant={active ? "secondary" : "ghost"}
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
                              {kind.toUpperCase()} 映射
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
                    <div className="tbje-group-reason">
                      {group.reasons.join(" · ")}
                    </div>
                    <div className="tbje-group-sheets">
                      {([group.tb, group.je] as (PairingFile | undefined)[])
                        .filter(Boolean)
                        .map((file) => {
                          const inspected = inspects[file!.path];
                          if (!inspected) return null;
                          const sheets = inspected.sheets ?? [];
                          const which =
                            file!.kind === "tb" ? "余额表" : "序时账";
                          return (
                            <span
                              key={file!.path}
                              className="tbje-sheet-picker"
                            >
                              {which}工作表：
                              {sheets.length > 1 ? (
                                <select
                                  aria-label={`${which}使用的工作表`}
                                  value={inspected.sheet}
                                  disabled={busy}
                                  onChange={(event) =>
                                    void switchSheet(
                                      file!.path,
                                      file!.kind,
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
                            </span>
                          );
                        })}
                    </div>
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
                              key={file.path}
                              kind={file.kind}
                              inspection={inspects[file.path]}
                              mapping={
                                (mappings[file.path] ?? {}) as MappingDict
                              }
                              onChange={(next) => {
                                setMappings((current) => ({
                                  ...current,
                                  [file.path]: next,
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
                <span className="fx-hint">
                  系统按组依次核对；运行中的任务可在统一进度窗口暂停或停止。
                </span>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {outcomes.length > 0 && (
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
              <CardDescription>
                差异用于提示复核，不会阻止后续操作；请结合尾差、期间范围和账套口径判断。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="tbje-result-toolbar">
                <span className="fx-hint">
                  已完成 {outcomes.filter((outcome) => outcome.ok).length} 组；
                  可逐组预览，或一次导出全部成功结果。
                </span>
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
      onChange={props.onChange}
    />
  );
}
