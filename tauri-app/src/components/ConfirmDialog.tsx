import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dedupeRepeatedText } from "@/lib/presentationText";

export type ConfirmDialogOptions = {
  /** 标题，短句说明要确认什么事。 */
  title: string;
  /** 正文，保留调用方的原始提示文案（支持换行）。 */
  message?: string;
  /** 确认按钮文案，默认「确认」，danger 态默认「删除」。 */
  confirmLabel?: string;
  /** 取消按钮文案，默认「取消」。 */
  cancelLabel?: string;
  /** danger 态用于删除、清空等不可恢复操作，确认按钮用破坏色。 */
  tone?: "danger" | "default";
};

type ConfirmRequest = ConfirmDialogOptions & {
  resolve: (value: boolean) => void;
};

/**
 * 模块级单例：同一时刻最多只有一个确认框。新的 confirmDialog 调用
 * 会覆盖前一个——被覆盖的那个按「取消」处理（resolve(false)），
 * 保证调用方永远不会悬挂等待。
 */
let current: ConfirmRequest | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function settle(value: boolean) {
  const request = current;
  if (!request) return;
  current = undefined;
  request.resolve(value);
  notify();
}

/**
 * 应用内确认对话框的编程式入口，替代浏览器原生 window.confirm。
 * 返回 true 表示用户点了确认按钮；Escape、遮罩点击、关闭按钮、
 * 取消按钮以及被新确认覆盖，一律返回 false。
 *
 * 必须由 ConfirmDialogHost 在应用根节点挂载一次，否则 Promise 不会落定。
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (current) current.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { ...options, resolve };
    notify();
  });
}

/**
 * 全局确认框挂载点：在应用根节点渲染一次即可，所有 confirmDialog
 * 调用都经由这里展示。无待确认请求时不渲染任何内容。
 */
export function ConfirmDialogHost() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (!current) return null;
  const request = current;
  const danger = request.tone === "danger";
  const message = request.message ? dedupeRepeatedText(request.message) : "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape、遮罩点击和右上角关闭按钮都会走到这里，统一按取消处理。
        if (!open) settle(false);
      }}
    >
      <DialogContent className="confirm-dialog flex max-w-md flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="confirm-dialog-header shrink-0 px-5 pt-5 pb-3">
          <DialogTitle
            className="confirm-dialog-title line-clamp-2"
            title={request.title}
            style={{ fontSize: "var(--fs-lg)" }}
          >
            {request.title}
          </DialogTitle>
        </DialogHeader>
        {message ? (
          <div className="confirm-dialog-body min-h-0 overflow-y-auto overscroll-contain px-5 pb-4">
            <DialogDescription
              className="confirm-dialog-message whitespace-pre-line text-foreground"
              style={{ fontSize: "var(--fs-md)", fontWeight: 400 }}
            >
              {message}
            </DialogDescription>
          </div>
        ) : null}
        <DialogFooter className="confirm-dialog-footer shrink-0 border-t bg-card px-5 py-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => settle(false)}
          >
            {request.cancelLabel ?? "取消"}
          </Button>
          <Button
            type="button"
            variant={danger ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? (danger ? "删除" : "确认")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
