import { describe, expect, it } from "vitest";

import {
  historyGet,
  jobCancel,
  pickPath,
  settingsGet,
  settingsSet,
  updateReleaseNotes,
} from "./api";

describe("browser preview API fallbacks", () => {
  it("keeps draft settings in memory without calling Tauri IPC", async () => {
    await settingsSet({ rollForwardProjects: { version: 2, projects: [] } });

    await expect(settingsGet()).resolves.toMatchObject({
      rollForwardProjects: { version: 2, projects: [] },
    });
  });

  it("returns safe empty states for history and task cancellation", async () => {
    await expect(historyGet()).resolves.toEqual([]);
    await expect(jobCancel("preview-job")).resolves.toBe(false);
    await expect(pickPath("file", "选择文件")).resolves.toBeNull();
    await expect(updateReleaseNotes()).rejects.toThrow(
      "浏览器预览模式不能读取版本更新说明",
    );
  });
});
