// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  historyGet,
  historyClear,
  jobCancel,
  pickPath,
  settingsGet,
  settingsSet,
  telemetryTrack,
  updateReleaseNotes,
} from "./api";
import { DEMO_FLAG_KEY } from "./preview/demoRegistry";

describe("browser preview API fallbacks", () => {
  it("keeps draft settings in memory without calling Tauri IPC", async () => {
    await settingsSet({ rollForwardProjects: { version: 2, projects: [] } });

    await expect(settingsGet()).resolves.toMatchObject({
      rollForwardProjects: { version: 2, projects: [] },
    });
  });

  it("returns safe empty states for history and task cancellation", async () => {
    await expect(historyGet()).resolves.toEqual([]);
    await expect(historyClear()).resolves.toEqual({ removed: 0 });
    await expect(jobCancel("preview-job")).resolves.toBe(false);
    await expect(pickPath("file", "选择文件")).resolves.toBeNull();
    await expect(updateReleaseNotes()).rejects.toThrow(
      "浏览器预览模式不能读取版本更新说明",
    );
  });

  it("keeps usage telemetry silent in preview mode", async () => {
    await expect(
      telemetryTrack("tool_open", "fx_audit"),
    ).resolves.toBeUndefined();
  });

  it("给回函选择器返回 PDF 演示文件，文件夹也匹配该类型", async () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    try {
      const files = await pickPath("files", "选择回函 PDF 文件", ["pdf"]);
      expect(files).toHaveLength(3);
      expect(files).toEqual(expect.arrayContaining([
        expect.stringMatching(/工商银行询证函回函\.pdf$/),
      ]));
      expect((files as string[]).every((path) => path.endsWith(".pdf"))).toBe(true);
      await expect(pickPath("folder", "选择包含回函 PDF 的文件夹"))
        .resolves.toMatch(/回函PDF$/);
    } finally {
      localStorage.removeItem(DEMO_FLAG_KEY);
    }
  });
});
