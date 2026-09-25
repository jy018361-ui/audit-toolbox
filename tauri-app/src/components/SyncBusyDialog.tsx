import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import "./SyncBusyDialog.css";
import {
  onSyncBusyChange,
  syncBusyAbortAll,
  type SyncBusyEntry,
} from "@/api";

/** 短于这个时间的调用不弹窗：快操作弹一下就关只会闪。 */
const SHOW_DELAY_MS = 1000;

/** 同步调用的英文方法名 → 面向用户的动宾短语（展示时前面拼「正在」）。 */
const METHOD_LABELS: Record<string, string> = {
  // 看账（AudiPick）
  "audipick.document_import": "导入文档",
  "audipick.ocr": "OCR 识别",
  "audipick.classify": "识别文档类型",
  "audipick.extract": "提取字段",
  "audipick.document_text": "读取文档内容",
  "audipick.document_text_save": "保存识别文本",
  "audipick.export": "导出结果",
  "audipick.backup_export": "导出备份",
  "audipick.project_save": "保存项目",
  // Excel 合并
  "excel_merger.inspect": "检查文件",
  "excel_merger.scan_folder": "扫描文件夹",
  "excel_merger.expand_paths": "展开文件清单",
  // FA 系列
  "fa.inspect": "读取底稿",
  "fa.review": "复核底稿",
  "fa.dep_inspect": "读取折旧表",
  "fa.dep_review": "复核折旧表",
  "fa.supplement_inspect": "读取补充表",
  "fa.supplement_review": "复核补充表",
  // 看账凭证
  "kanzhang.accounts": "读取科目",
  "kanzhang.llm_mapping": "识别字段映射",
  "kanzhang.mark_sign_report": "生成标记报告",
  // 函证 / 存款 / 外汇 / 借款 / 模糊匹配
  "confirmation.inspect": "读取函证清单",
  "deposit.classify_source": "识别存款来源",
  "deposit.rate_tiers": "读取利率档次",
  "deposit.inspect_tb": "读取 TB 账表",
  "deposit.inspect_je": "读取序时账",
  "fx.classify_source": "识别外汇来源",
  "fx.check_mapping_alignment": "核对字段映射",
  "fx.inspect_tb": "读取 TB 账表",
  "fx.inspect_je": "读取序时账",
  "fx.validate_currency_mapping": "校验币种映射",
  "ledger.auxiliary_link": "验证辅助核算联动",
  "ledger.check_mapping_alignment": "核对字段映射",
  "ledger.currency_link": "验证多币种账户联动",
  "ledger.entity_scope_suggestions": "识别主体范围",
  "ledger.forms": "读取账表结构",
  // 字段映射 LLM 复核（单文件 / TB＋JE 成对），一次一组、常与别的调用并发
  "ledger.review_mapping": "复核字段映射",
  "ledger.review_pair_mapping": "联合复核字段映射",
  // 来源分类 LLM 复核：上传识别低置信度 Sheet 的二次判型，常与 inspect 并发
  "deposit.classify_source_llm": "复核存款来源分类",
  "fa_tbje.classify_source_llm": "复核账表来源分类",
  "fx.classify_source_llm": "复核外汇来源分类",
  "loan.inspect": "读取借款数据",
  "loan.import_rates": "导入利率台账",
  "loan.rate_template": "读取利率模板",
  "loan.tb_accounts": "读取 TB 科目",
  "fuzzy.inspect": "读取匹配数据",
  "fuzzy.get_results": "读取匹配结果",
  "fuzzy.save_confirm": "保存确认结果",
  // Roll Forward / WP
  "roll_forward.cra.parse": "解析 CRA 报表",
  "roll_forward.catalog": "读取科目配置",
  "roll_forward.detect_subjects": "识别主体",
  "roll_forward.project_export": "导出项目",
  "roll_forward.validate": "校验滚期数据",
  "wp.validate": "校验 WP 服务单",
  // AudiPick 其余与缓存、设置页
  "audipick.config_status": "读取识别配置",
  "audipick.document_delete": "删除文档",
  "audipick.document_import_folder": "批量导入文档",
  "audipick.documents": "读取文档清单",
  "audipick.export_bundle": "导出打包结果",
  "audipick.project_delete": "删除项目",
  "audipick.projects": "读取项目清单",
  "cache.stat": "统计缓存占用",
  "cache.sweep": "清理过期缓存",
  "cache.clear": "清空缓存",
};

function labelOf(method: string): string {
  return METHOD_LABELS[method] ?? "处理";
}

/** 一条等待项的完整文案：做什么 ＋（调用方给了明细时）在处理哪份数据。 */
function busyText(entry?: SyncBusyEntry): string {
  const label = labelOf(entry?.method ?? "");
  return `正在${label}${entry?.detail ? `：${entry.detail}` : ""}`;
}

/** 多任务列表不重复「正在」；弹窗标题已经表达了统一的进行中状态。 */
type BusyGroup = {
  method: string;
  count: number;
  details: Map<string, number>;
};

/** 仅按同一动作合组，具体文件/对象在组内逐项保留。 */
function groupEntries(entries: SyncBusyEntry[]): BusyGroup[] {
  const groups = new Map<string, BusyGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.method);
    if (!group) {
      group = { method: entry.method, count: 0, details: new Map() };
      groups.set(entry.method, group);
    }
    group.count += 1;
    const detail = entry.detail?.trim() ?? "";
    group.details.set(detail, (group.details.get(detail) ?? 0) + 1);
  }
  return [...groups.values()];
}

/**
 * 同步操作（engineCall）的全局等待窗：导入文档、OCR 识别这类「一口气完成」
 * 的调用没有进度事件可听，超过 1 秒仍未返回就弹出转圈提示，完成自动关闭。
 *
 * 和 JobDialog（后台任务弹窗）是两回事：这类操作在引擎里一口气跑完，没有
 * 可续跑的断点，「暂停/继续」做不到；「停止等待」也只掐断前端的等待——
 * 立即恢复界面、页面不再采用其结果，后台处理仍会自行收尾。等不到头又不想
 * 干等就用「最小化」：弹窗收成右下角小条，点小条随时展开回来；全部操作
 * 结束后小条自动消失，下一批慢操作照常重新弹出。
 */
export function SyncBusyDialog({
  fixtureEntries,
  fixtureMinimized = false,
}: {
  /** 仅供开发态几何夹具注入；应用运行时不传，仍完全由 API 广播驱动。 */
  fixtureEntries?: SyncBusyEntry[];
  /** 仅供开发态几何夹具直接呈现「最小化后的小条」形态。 */
  fixtureMinimized?: boolean;
} = {}) {
  const [visible, setVisible] = useState(
    () => Boolean(fixtureEntries?.length) && !fixtureMinimized,
  );
  const [entries, setEntries] = useState<SyncBusyEntry[]>(() => fixtureEntries ?? []);
  // 「本批已被最小化」的批次号；null 表示当前没有收起（或已转空闲归零）。
  const [dismissedSession, setDismissedSession] = useState<number | null>(
    () => (fixtureMinimized && fixtureEntries?.length ? 0 : null),
  );
  const entriesRef = useRef<SyncBusyEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 忙碌批次号：每次从空闲转入忙碌递增；用户「最小化」掉的就是当前批。
  const sessionRef = useRef(0);
  const dismissedRef = useRef<number | null>(
    fixtureMinimized && fixtureEntries?.length ? 0 : null,
  );
  const pillButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () => {
      if (fixtureEntries) {
        const dismissed = fixtureMinimized && fixtureEntries.length > 0
          ? sessionRef.current
          : null;
        entriesRef.current = fixtureEntries;
        setEntries(fixtureEntries);
        dismissedRef.current = dismissed;
        setDismissedSession(dismissed);
        setVisible(fixtureEntries.length > 0 && dismissed === null);
        return;
      }
      return onSyncBusyChange((next) => {
        const wasIdle = entriesRef.current.length === 0;
        entriesRef.current = next;
        setEntries(next);
        if (next.length > 0) {
          // 从空闲转入忙碌才起表：忙碌期间的进出不清零计时，
          // 否则一个慢导入旁边夹几个快调用就会把弹窗无限推迟。
          if (wasIdle) {
            sessionRef.current += 1;
          }
          if (!timerRef.current) {
            timerRef.current = setTimeout(() => {
              timerRef.current = null;
              if (
                entriesRef.current.length > 0 &&
                dismissedRef.current !== sessionRef.current
              ) {
                setVisible(true);
              }
            }, SHOW_DELAY_MS);
          }
        } else {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setVisible(false);
          dismissedRef.current = null;
          setDismissedSession(null);
        }
      });
    },
    [fixtureEntries, fixtureMinimized],
  );

  // 卸载时清掉计时器，避免测试环境泄漏。
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const first = entries[0];
  const groups = groupEntries(entries);
  const dialogOpen = visible && Boolean(first);
  const pillShown = !dialogOpen && dismissedSession !== null && entries.length > 0;

  // 收成小条时把焦点交给小条：键盘/读屏用户不会「丢」了正在跑的操作。
  useEffect(() => {
    if (!pillShown) return;
    // Radix 关闭弹窗时也会恢复焦点；下一帧再把焦点交给真正替代弹窗的小条。
    const timer = window.setTimeout(() => pillButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [pillShown]);

  const minimize = () => {
    dismissedRef.current = sessionRef.current;
    setDismissedSession(sessionRef.current);
    setVisible(false);
  };

  const restore = () => {
    dismissedRef.current = null;
    setDismissedSession(null);
    setVisible(true);
  };

  const pillText =
    entries.length > 1
      ? `${entries.length} 项操作处理中`
      : busyText(first);

  return (
    <>
      <Dialog open={dialogOpen}>
        <DialogContent
          showCloseButton={false}
          className="sync-busy-dialog"
          // 关闭手段就是下面两个按钮：ESC 和点遮罩只会让人以为操作停了。
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="sync-busy-header" aria-live="polite">
            <span className="sync-busy-spinner" aria-hidden="true" />
            <div className="sync-busy-heading">
              <div className="sync-busy-title-row">
                <DialogTitle>
                  {entries.length > 1 ? "正在处理" : busyText(first)}
                </DialogTitle>
                {entries.length > 1 && (
                  <span className="sync-busy-count">
                    {entries.length} 项进行中
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* 多任务列表用 ul；DialogDescription 渲染成 <p>，p 里嵌不了 ul。 */}
          {entries.length > 1 && (
            <ul className="sync-busy-list" aria-label="进行中的操作">
              {groups.map((group) => {
                const details = [...group.details];
                const singleDetail = details.length === 1 ? details[0][0] : "";
                return <li key={group.method}>
                  <span className="sync-busy-item-dot" aria-hidden="true" />
                  <div className="sync-busy-group">
                    <span>
                      {labelOf(group.method)}{singleDetail ? `：${singleDetail}` : ""}
                      {group.count > 1 && (
                        <span className="sync-busy-group-count"> ×{group.count}</span>
                      )}
                    </span>
                    {details.length > 1 && (
                      <details className="sync-busy-group-details">
                        <summary>查看 {details.length} 个处理对象</summary>
                        <ul>
                          {details.map(([detail, count]) => (
                            <li key={detail || "__unspecified__"}>
                              {detail || "未提供对象名称"}
                              {count > 1 ? ` ×${count}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </li>;
              })}
            </ul>
          )}
          <DialogDescription className="sync-busy-note">
            可以最小化后继续浏览。停止等待不会中止后台处理，本次结果也不会应用。
          </DialogDescription>
          <div className="sync-busy-actions">
            <Button type="button" variant="secondary" size="sm" onClick={minimize}>
              最小化
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => syncBusyAbortAll()}
            >
              停止等待
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {pillShown && (
        <button
          ref={pillButtonRef}
          type="button"
          className="sync-busy-pill"
          onClick={restore}
          aria-label={`展开处理进度：${pillText}`}
        >
          <span
            className="sync-busy-spinner sync-busy-pill-spinner"
            aria-hidden="true"
          />
          <span className="sync-busy-pill-text">{pillText}</span>
          <span className="sync-busy-pill-hint" aria-hidden="true">
            点击展开
          </span>
        </button>
      )}
    </>
  );
}
