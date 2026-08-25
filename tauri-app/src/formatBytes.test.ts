import { describe, expect, it } from "vitest";
import { formatBytes } from "./App";

describe("缓存占用的字节格式化", () => {
  it("按量级选单位，缓存占用不该让人数零", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4.5 * 1024 * 1024)).toBe("4.5 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });

  it("三位数以上不留小数——「128 MB」比「128.0 MB」好读", () => {
    expect(formatBytes(128 * 1024 * 1024)).toBe("128 MB");
    expect(formatBytes(999 * 1024)).toBe("999 KB");
  });

  it("字节数不带小数", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("异常输入不显示 NaN——统计读失败时按钮上不能出现乱码", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("超出 GB 仍按 GB 计，不会掉出单位表", () => {
    expect(formatBytes(5000 * 1024 ** 3)).toBe("5000 GB");
  });
});
