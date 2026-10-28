import { useEffect, useRef, useState, type RefObject } from "react";
import { listenNativeFileDragEvents } from "../api";

type Options = {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onDrop: (paths: string[]) => void | Promise<void>;
  onError?: (reason: unknown) => void;
};

/** 单上传区页面接受窗口拖放；保活的隐藏页和忙碌页不接收文件。 */
export function useNativeFileDropZone(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [highlight, setHighlight] = useState(false);
  function available() {
    const { enabled, containerRef } = latest.current;
    const node = containerRef.current;
    return enabled && !!node?.isConnected && !node.closest("[hidden], [inert]");
  }

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listenNativeFileDragEvents((event) => {
      if (disposed) return;
      const enabled = available();
      setHighlight(enabled && (event.type === "enter" || event.type === "over"));
      if (event.type === "drop" && enabled && event.paths?.length) {
        void Promise.resolve()
          .then(() => {
            // 同一批事件间页面可能已隐藏或进入忙碌状态。
            if (!disposed && available()) return latest.current.onDrop(event.paths!);
          })
          .catch((reason) => {
            if (!disposed) latest.current.onError?.(reason);
          });
      }
    }).then((stop) => {
      if (disposed) stop();
      else off = stop;
    }).catch((reason) => {
      if (!disposed) latest.current.onError?.(reason);
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!options.enabled) setHighlight(false);
  }, [options.enabled]);

  return {
    highlight: options.enabled && highlight,
    onDragStateChange: (active: boolean) => setHighlight(available() && active),
  };
}
