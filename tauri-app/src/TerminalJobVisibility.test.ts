import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("取消任务后的页面反馈", () => {
  it("看账导出摘要与筛选摘要区分且输出按钮不强行铺满", () => {
    expect(source("KanzhangParityPage.tsx")).toContain('paths.length ? "已导出" : "筛选后共"');
    expect(source("KanzhangParityPage.tsx")).toContain('displayFileName(path)');
    expect(source("kanzhang-parity.css")).toContain('width: fit-content;');
  });
  it("正负数导出后结果卡留有独立间距与完整路径提示", () => {
    expect(source("je-sign-mark.css")).toMatch(/\.jm-page \.kz-actions \+ \.kz-result\s*\{\s*margin-top: var\(--sp-4\)/);
    expect(source("JeSignMarkPage.tsx")).toContain('title={path}');
  });
  it("TS 使用独立取消徽标并避免重复卡内进度", () => {
    expect(source("TsManagerParityPage.tsx")).toMatch(/!\["completed", "failed", "cancelled"\]\.includes\(job\.phase\)/);
    expect(source("TsManagerParityPage.tsx")).toContain('<Badge variant="warning">已取消</Badge>');
  });

  it("看账与正负数标记在读取任务取消后仍显示状态", () => {
    for (const page of ["KanzhangParityPage.tsx", "JeSignMarkPage.tsx"]) {
      expect(source(page)).toContain('<Badge variant="warning">已取消</Badge>');
      expect(source(page)).toContain('role="status"');
    }
  });
});
