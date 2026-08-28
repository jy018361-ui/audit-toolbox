import { useEffect, useMemo, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  pickPath,
} from "./api";
import type { Inspection } from "./DepositInterestPage";
import {
  depositDropTargetInside,
  JE_LABELS,
  TB_LABELS,
} from "./DepositInterestPage";
import { MappingPanel } from "@/components/MappingPanel";
import {
  LedgerReviewAll,
  useLedgerDictReviews,
} from "@/components/LedgerReviewAll";
import { FileDropInput } from "@/components/FileDropInput";
import { FileInput } from "@/components/FileInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { ResultView } from "@/components/ResultView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useJobEvents } from "@/hooks/useJobEvents";
import { errorText } from "@/lib/errors";

type Kind = "tb" | "je";
type Mapping = Record<string, string | string[]>;
type AccountRole = "cost" | "depreciation" | "excluded";
type Assignment = {
  entity?: string;
  account: string;
  role: AccountRole;
  category: string;
};
type Classification = {
  kind: Kind;
  sheet: string;
  headerRow: number;
  headerDepth: number;
};

const MULTI = new Set(["id", "accountName", "account", "auxiliary"]);

export function suggestFaAccount(account: string): Assignment {
  const depreciation =
    /累计折旧|accumulated\s+depreciation|accum\.?\s*dep/i.test(account);
  const cost =
    !depreciation &&
    /固定资产|房屋|建筑物|机器|设备|运输工具|电子设备|办公设备|fixture|equipment|building|vehicle/i.test(
      account,
    );
  const role: AccountRole = depreciation
    ? "depreciation"
    : cost
      ? "cost"
      : "excluded";
  const category =
    account
      .replace(/^\s*\d+[\s._-]*/, "")
      .replace(
        /累计折旧|固定资产|accumulated\s+depreciation|property[,\s]*plant\s*(and|&)\s*equipment|ppe/gi,
        "",
      )
      .replace(/^[-—:：\s]+|[-—:：\s]+$/g, "") || "未分类";
  return { account, role, category };
}

export function faAssignmentsForEntities(
  accounts: string[],
  entities: string[],
  current: Assignment[],
): Assignment[] {
  return entities.flatMap((entity) =>
    accounts.map(
      (account) =>
        current.find(
          (item) => item.account === account && item.entity === entity,
        ) ?? { ...suggestFaAccount(account), entity },
    ),
  );
}

function defaultOutput(input: string) {
  const slash = Math.max(input.lastIndexOf("\\"), input.lastIndexOf("/"));
  const dir = slash >= 0 ? input.slice(0, slash + 1) : "";
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `${dir}FA_TBJE_${stamp}.xlsx`;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function FaTbJePage() {
  const [paths, setPaths] = useState<Record<Kind, string>>({ tb: "", je: "" });
  const [inspects, setInspects] = useState<Partial<Record<Kind, Inspection>>>(
    {},
  );
  const [mappings, setMappings] = useState<Record<Kind, Mapping>>({
    tb: {},
    je: {},
  });
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [reportEnd, setReportEnd] = useState(
    `${new Date().getFullYear()}-12-31`,
  );
  const [tbFixedEntity, setTbFixedEntity] = useState("");
  const [jeFixedEntity, setJeFixedEntity] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  const [result, setResult] = useState<unknown>();
  const uploadDropRef = useRef<HTMLDivElement>(null);
  const reviews = useLedgerDictReviews(engineCall, {
    tb: JSON.stringify([
      paths.tb,
      inspects.tb?.sheet,
      inspects.tb?.headerRow,
      inspects.tb?.headerDepth,
    ]),
    je: JSON.stringify([
      paths.je,
      inspects.je?.sheet,
      inspects.je?.headerRow,
      inspects.je?.headerDepth,
    ]),
  });
  const reviewing = Boolean(reviews.reviewing.tb || reviews.reviewing.je);
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "fa_list",
    onEvent: (event) => {
      if (event.result) setResult(event.result);
      if (["completed", "failed", "cancelled"].includes(event.phase))
        setBusy(false);
      if (event.phase === "failed") setError(event.message);
    },
  });

  const accounts = useMemo(
    () => [
      ...new Set([
        ...(inspects.tb?.accounts ?? []),
        ...(inspects.je?.accounts ?? []),
      ]),
    ],
    [inspects],
  );
  const entities = useMemo(
    () => [
      ...new Set([
        ...(inspects.tb?.entities.length
          ? inspects.tb.entities
          : [tbFixedEntity.trim()]),
        ...(inspects.je?.entities.length
          ? inspects.je.entities
          : [jeFixedEntity.trim()]),
      ]),
    ],
    [inspects, tbFixedEntity, jeFixedEntity],
  );
  useEffect(() => {
    setAssignments((current) =>
      faAssignmentsForEntities(accounts, entities, current),
    );
  }, [accounts, entities]);
  useEffect(() => {
    const drops = listenPositionedFileDrops(({ paths: dropped, x, y }) => {
      if (
        !depositDropTargetInside(
          x,
          y,
          uploadDropRef.current?.getBoundingClientRect(),
        )
      )
        return;
      void classifyAndInspect(dropped);
    });
    return () => {
      void drops.then((unlisten) => unlisten());
    };
  }, []);

  async function browse() {
    const picked = await pickPath("files", "选择 TB 或 JE 文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
      "parquet",
    ]);
    if (!picked) return;
    void classifyAndInspect(Array.isArray(picked) ? picked : [picked]);
  }

  async function classifyAndInspect(selected: string[]) {
    const files = selected.filter((path) =>
      /\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(path),
    );
    if (!files.length) return;
    reviews.clearReview("tb");
    reviews.clearReview("je");
    setBusy(true);
    setError("");
    setSourceStatus("正在识别文件类型、Sheet、表头和字段…");
    const failures: string[] = [];
    try {
      for (const path of files) {
        try {
          const classified = (await engineCall("deposit.classify_source", {
            source: {
              inputPath: path,
              sheet: "",
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Classification;
          const kind = classified.kind;
          const inspected = (await engineCall(`deposit.inspect_${kind}`, {
            source: {
              inputPath: path,
              sheet: classified.sheet,
              headerRow: classified.headerRow,
              headerDepth: classified.headerDepth,
            },
          })) as Inspection;
          setPaths((current) => ({ ...current, [kind]: path }));
          setInspects((current) => ({ ...current, [kind]: inspected }));
          setMappings((current) => ({
            ...current,
            [kind]: inspected.suggestedMapping,
          }));
          reviews.clearReview(kind);
          if (kind === "je")
            setOutputPath((current) => current || defaultOutput(path));
          setSourceStatus(
            `${files.length} 个文件已识别；${kind === "tb" ? "TB 科目余额表" : "JE 序时账"}由公共引擎判定。`,
          );
        } catch (e) {
          failures.push(`${fileName(path)}：${errorText(e)}`);
        }
      }
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }

  async function reinspect(
    kind: Kind,
    over: Partial<Pick<Inspection, "sheet" | "headerRow" | "headerDepth">>,
  ) {
    const current = inspects[kind];
    if (!current || !paths[kind]) return;
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    try {
      const inspected = (await engineCall(`deposit.inspect_${kind}`, {
        source: {
          inputPath: paths[kind],
          sheet: over.sheet ?? current.sheet,
          headerRow: over.headerRow ?? current.headerRow,
          headerDepth: over.headerDepth ?? current.headerDepth,
        },
      })) as Inspection;
      setInspects((value) => ({ ...value, [kind]: inspected }));
      setMappings((value) => ({
        ...value,
        [kind]: inspected.suggestedMapping,
      }));
      reviews.clearReview(kind);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function source(kind: Kind) {
    const inspected = inspects[kind];
    return {
      inputPath: paths[kind],
      sheet: inspected?.sheet ?? "",
      headerRow: inspected?.headerRow ?? 0,
      headerDepth: inspected?.headerDepth ?? 0,
    };
  }
  function payload() {
    return {
      tbSource: source("tb"),
      jeSource: source("je"),
      tbMapping: mappings.tb,
      jeMapping: mappings.je,
      accountAssignments: assignments,
      reportEnd,
      tbFixedEntity,
      jeFixedEntity,
      outputPath,
    };
  }
  async function run(method: "fa.tbje_preview" | "fa.tbje_export") {
    if (reviewing) {
      setError("映射复核尚未结束，请等待复核完成后再生成底稿。");
      return;
    }
    if (!paths.tb || !paths.je) {
      setError("请同时上传 TB 和完整期间 JE。");
      return;
    }
    if (!assignments.some((x) => x.role !== "excluded")) {
      setError("请至少确认一个固定资产原值或累计折旧科目。");
      return;
    }
    if (method.endsWith("export") && !outputPath) {
      setError("请选择输出路径。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const id = await jobStart(method, payload());
      activeJobId.current = id;
      setJob({
        jobId: id,
        toolId: "fa_list",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }

  return (
    <div className="fa-tbje-page">
      <ErrorBox error={error} onDismiss={() => setError("")} />
      <Card>
        <CardHeader>
          <CardTitle>1. 上传 TB 与 JE</CardTitle>
        </CardHeader>
        <CardContent className="form-stack">
          <p className="fx-hint">
            与存款利息工具使用同一上传入口。可一次拖入 TB 和
            JE，系统自动判断文件类型、Sheet、标题行和字段映射。
          </p>
          <FileDropInput
            containerRef={uploadDropRef}
            value={[
              paths.tb && `TB：${fileName(paths.tb)}`,
              paths.je && `JE：${fileName(paths.je)}`,
            ]
              .filter(Boolean)
              .join("；")}
            disabled={busy}
            placeholder="拖放或选择 TB、JE 文件（可同时选择）"
            onBrowse={() => void browse()}
            onDragStateChange={() => {}}
            onClear={() => {
              reviews.clearReview("tb");
              reviews.clearReview("je");
              setPaths({ tb: "", je: "" });
              setInspects({});
              setMappings({ tb: {}, je: {} });
              setAssignments([]);
              setSourceStatus("");
              setResult(undefined);
            }}
          />
          {sourceStatus && (
            <p className="fx-source-status" aria-live="polite">
              {sourceStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {(inspects.tb || inspects.je) && (
        <LedgerReviewAll
          present={
            inspects.tb && inspects.je
              ? ["tb", "je"]
              : inspects.tb
                ? ["tb"]
                : ["je"]
          }
          names={{ tb: "TB", je: "JE" }}
          reviewing={reviews.reviewing}
          status={reviews.status}
          disabled={busy}
          onReviewAll={() =>
            void reviews.reviewAll({
              tb: inspects.tb
                ? {
                    headers: inspects.tb.headers,
                    preview: inspects.tb.preview,
                    mapping: mappings.tb,
                    labels: TB_LABELS,
                    onApplied: (next) =>
                      setMappings((m) => ({ ...m, tb: next })),
                  }
                : undefined,
              je: inspects.je
                ? {
                    headers: inspects.je.headers,
                    preview: inspects.je.preview,
                    mapping: mappings.je,
                    labels: JE_LABELS,
                    onApplied: (next) =>
                      setMappings((m) => ({ ...m, je: next })),
                  }
                : undefined,
            })
          }
        />
      )}
      {(["tb", "je"] as const).map(
        (kind) =>
          inspects[kind] && (
            <div key={kind}>
              <div className="fx-source-meta">
                <label>
                  Sheet
                  <select
                    disabled={busy}
                    value={inspects[kind]!.sheet}
                    onChange={(e) =>
                      void reinspect(kind, {
                        sheet: e.target.value,
                        headerRow: 0,
                        headerDepth: 0,
                      })
                    }
                  >
                    {(inspects[kind]!.sheets.length
                      ? inspects[kind]!.sheets
                      : [inspects[kind]!.sheet]
                    ).map((sheet) => (
                      <option key={sheet}>{sheet}</option>
                    ))}
                  </select>
                </label>
                <label>
                  标题行
                  <input
                    disabled={busy}
                    type="number"
                    min={1}
                    value={inspects[kind]!.headerRow}
                    onChange={(e) =>
                      void reinspect(kind, {
                        headerRow: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  表头层数
                  <select
                    disabled={busy}
                    value={inspects[kind]!.headerDepth}
                    onChange={(e) =>
                      void reinspect(kind, {
                        headerDepth: Number(e.target.value),
                      })
                    }
                  >
                    <option value={1}>1层</option>
                    <option value={2}>2层</option>
                  </select>
                </label>
                {inspects[kind]!.headerDetection.needsConfirmation && (
                  <strong className="fx-warning">
                    标题候选得分接近，请确认
                  </strong>
                )}
              </div>
              <MappingPanel
                title={`${kind.toUpperCase()} 文件预览`}
                headers={inspects[kind]!.headers}
                rows={inspects[kind]!.preview}
                mapping={mappings[kind]}
                roles={Object.entries(kind === "tb" ? TB_LABELS : JE_LABELS)}
                multi={MULTI}
                busy={reviews.reviewing[kind] || busy}
                note={`${inspects[kind]!.rowCount} 行 × ${inspects[kind]!.headers.length} 列`}
                onChange={(next) =>
                  setMappings((current) => ({
                    ...current,
                    [kind]: next as Mapping,
                  }))
                }
              />
            </div>
          ),
      )}

      {!!accounts.length && (
        <Card>
          <CardHeader>
            <CardTitle>2. 确认固定资产科目与类别</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="fx-hint">
              按主体分别确认科目角色和类别；同编码在不同主体之间不会共用分类。未在该主体账表中出现的组合不会参与计算。
            </p>
            <div className="data-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>主体</th>
                    <th>科目</th>
                    <th>角色</th>
                    <th>资产类别</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((item, index) => (
                    <tr key={JSON.stringify([item.entity, item.account])}>
                      <td>{item.entity || "未指定主体"}</td>
                      <td>{item.account}</td>
                      <td>
                        <select
                          value={item.role}
                          disabled={busy}
                          onChange={(e) =>
                            setAssignments((rows) =>
                              rows.map((row, i) =>
                                i === index
                                  ? {
                                      ...row,
                                      role: e.target.value as AccountRole,
                                    }
                                  : row,
                              ),
                            )
                          }
                        >
                          <option value="excluded">排除</option>
                          <option value="cost">固定资产原值</option>
                          <option value="depreciation">累计折旧</option>
                        </select>
                      </td>
                      <td>
                        <input
                          value={item.category}
                          disabled={busy || item.role === "excluded"}
                          onChange={(e) =>
                            setAssignments((rows) =>
                              rows.map((row, i) =>
                                i === index
                                  ? { ...row, category: e.target.value }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {paths.tb && paths.je && (
        <Card>
          <CardHeader>
            <CardTitle>3. 预览与导出</CardTitle>
          </CardHeader>
          <CardContent className="form-stack">
            <div className="form-grid">
              <label>
                报告截止日
                <input
                  type="date"
                  value={reportEnd}
                  onChange={(e) => setReportEnd(e.target.value)}
                />
              </label>
              <label>
                TB 固定主体（无主体列时）
                <input
                  value={tbFixedEntity}
                  onChange={(e) => setTbFixedEntity(e.target.value)}
                />
              </label>
              <label>
                JE 固定主体（无主体列时）
                <input
                  value={jeFixedEntity}
                  onChange={(e) => setJeFixedEntity(e.target.value)}
                />
              </label>
            </div>
            <label>
              输出路径
              <FileInput
                value={outputPath}
                onBrowse={async () => {
                  const value = await pickPath(
                    "save",
                    "保存固定资产 TB＋JE 底稿",
                    ["xlsx"],
                    "FA_TBJE.xlsx",
                  );
                  if (typeof value === "string") setOutputPath(value);
                }}
                disabled={busy}
              />
            </label>
            <div className="button-row">
              <Button
                variant="secondary"
                disabled={busy || reviewing}
                onClick={() => void run("fa.tbje_preview")}
              >
                生成预览
              </Button>
              <Button
                disabled={busy || reviewing}
                onClick={() => void run("fa.tbje_export")}
              >
                生成五表 Excel
              </Button>
              {busy && activeJobId.current && (
                <Button
                  variant="destructive"
                  onClick={() => void jobCancel(activeJobId.current!)}
                >
                  取消
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {job && <JobProgress job={job} />}
      <ResultView value={result} />
    </div>
  );
}
