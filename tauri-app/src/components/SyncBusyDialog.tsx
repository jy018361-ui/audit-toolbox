import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { onSyncBusyChange, type SyncBusyEntry } from "@/api";

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
  "fx.classify_source": "识别外汇来源",
  "fx.check_mapping_alignment": "核对字段映射",
  "ledger.check_mapping_alignment": "核对字段映射",
  "loan.inspect": "读取借款数据",
  "fuzzy.inspect": "读取匹配数据",
  // Roll Forward / WP
  "roll_forward.cra.parse": "解析 CRA 报表",
  "roll_forward.detect_subjects": "识别主体",
  "roll_forward.project_export": "导出项目",
  "wp.validate": "校验 WP 服务单",
};

function labelOf(method: string): string {
  return METHOD_LABELS[method] ?? "处理";
}

/**
 * 同步操作（engineCall）的全局等待窗：导入文档、OCR 识别这类「一口气完成」
 * 的调用没有进度事件可听，超过 1 秒仍未返回就弹出转圈提示，完成自动关闭。
 *
 * 和 JobDialog（后台任务弹窗）是两回事：这类操作中途掐断会留下写了一半的
 * 数据，所以没有「停止」按钮——但等不到头确实干耗着，提供「后台等待」：
 * 把弹窗藏起来让操作继续后台跑，结果照常返回页面。 dismissed 只对当前
 * 这批忙碌生效（空闲→忙碌算一批），下一批慢操作照常重新弹出。
 */
export function SyncBusyDialog({
  fixtureEntries,
}: {
  /** 仅供开发态几何夹具注入；应用运行时不传，仍完全由 API 广播驱动。 */
  fixtureEntries?: SyncBusyEntry[];
} = {}) {
  const [visible, setVisible] = useState(() => Boolean(fixtureEntries?.length));
  const [entries, setEntries] = useState<SyncBusyEntry[]>(() => fixtureEntries ?? []);
  const entriesRef = useRef<SyncBusyEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 忙碌批次号：每次从空闲转入忙碌递增；用户「后台等待」掉的就是当前批。
  const sessionRef = useRef(0);
  const dismissedRef = useRef<number | null>(null);

  useEffect(
    () => {
      if (fixtureEntries) {
        entriesRef.current = fixtureEntries;
        setEntries(fixtureEntries);
        setVisible(fixtureEntries.length > 0);
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
        }
      });
    },
    [fixtureEntries],
  );

  // 卸载时清掉计时器，避免测试环境泄漏。
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const first = entries[0];

  return (
    <Dialog open={visible && Boolean(first)}>
      <DialogContent
        showCloseButton={false}
        className="sync-busy-dialog"
        // 没有关闭手段是有意的：这类操作无法安全中止，弹窗只能等它自己完成。
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="sync-busy-body" aria-live="polite">
          <span className="sync-busy-spinner" aria-hidden="true" />
          <div className="sync-busy-text">
            <DialogTitle>
              {entries.length > 1
                ? `正在处理 ${entries.length} 项操作`
                : `正在${labelOf(first?.method ?? "")}`}
            </DialogTitle>
            {/* 多任务列表用 ul；DialogDescription 渲染成 <p>，p 里嵌不了 ul */}
            {entries.length > 1 ? (
              <ul className="sync-busy-list">
                {entries.map((entry) => (
                  <li key={entry.id}>正在{labelOf(entry.method)}</li>
                ))}
              </ul>
            ) : (
              <DialogDescription>
                这类操作一口气完成，中途停止可能留下不完整的数据，完成后窗口会自动关闭。
              </DialogDescription>
            )}
          </div>
        </div>
        {/* 不是「停止」：操作没法安全中止，只能把它藏到后台继续跑。 */}
        <div className="sync-busy-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              dismissedRef.current = sessionRef.current;
              setVisible(false);
            }}
          >
            后台等待
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
