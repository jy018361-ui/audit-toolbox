import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { loadTourState, saveTourState } from "./tourState";

/**
 * 侧边栏底部的新手模式开关：默认开启；关掉后首次启动和首次进工具
 * 都不再自动弹引导（设置里的手动重播不受影响）。状态存 localStorage，
 * 重启程序保持用户的选择。整行是一个 label，点文字与点开关等效。
 */
export function NewbieModeToggle() {
  const [enabled, setEnabled] = useState(
    () => loadTourState().newbieMode !== false,
  );
  const update = (checked: boolean) => {
    setEnabled(checked);
    saveTourState({ newbieMode: checked });
  };
  return (
    <label
      className="newbie-mode-toggle"
      data-tour="newbie-toggle"
      title="开启时，首次使用工具会播放分步动画引导；不需要时随手关掉，随时可在设置里重播。"
    >
      <Sparkles
        className="newbie-mode-toggle-icon"
        size={14}
        aria-hidden="true"
      />
      <span className="newbie-mode-toggle-label">新手模式</span>
      <Switch
        id="newbie-mode-switch"
        checked={enabled}
        onCheckedChange={update}
        aria-label="新手模式"
      />
    </label>
  );
}
