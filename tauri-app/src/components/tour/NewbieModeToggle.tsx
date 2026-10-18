import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { loadTourState, saveTourState } from "./tourState";
import { TOUR_COPY } from "./tourCopy";

/**
 * 侧边栏上部的新手模式开关：默认开启；关掉后不再自动弹引导
 * （工作台手动重播不受影响）。状态存 localStorage，
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
      title={TOUR_COPY.toggleTitle}
    >
      <Sparkles
        className="newbie-mode-toggle-icon"
        size={14}
        aria-hidden="true"
      />
      <span className="newbie-mode-toggle-label">{TOUR_COPY.toggleLabel}</span>
      <Switch
        id="newbie-mode-switch"
        checked={enabled}
        onCheckedChange={update}
        aria-label={TOUR_COPY.toggleLabel}
      />
    </label>
  );
}
