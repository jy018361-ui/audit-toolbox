import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./task-state.css", import.meta.url), "utf8");

describe("任务结果状态样式", () => {
  it.each(["danger", "warning", "success"])("%s 使用独立状态背景与边框，不依赖合并页样式", (tone) => {
    const rule = css.match(new RegExp(`\\.job-progress \\.job-banner\\.${tone}\\s*\\{([^}]*)\\}`))?.[1];
    expect(rule).toContain(`background: var(--${tone}-bg)`);
    expect(rule).toContain(`border-color: var(--${tone}-border)`);
    expect(rule).toContain(`color: var(--${tone}-fg)`);
  });
});
