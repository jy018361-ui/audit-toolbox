// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataHandlingNotice } from "./DataHandlingNotice";

afterEach(cleanup);

describe("DataHandlingNotice", () => {
  it("renders the exact data boundary supplied by the caller", () => {
    render(
      <DataHandlingNotice
        mode="local"
        title="文件处理说明"
        description="表格仅在本机读取。"
        details={<span>启用智能识别时会另行提示。</span>}
      />,
    );

    expect(screen.getByRole("complementary", { name: "文件处理说明" })).toBeTruthy();
    expect(screen.getByRole("complementary").getAttribute("data-mode")).toBe("local");
    expect(screen.getByText("表格仅在本机读取。")).toBeTruthy();
    expect(screen.getByText("启用智能识别时会另行提示。")).toBeTruthy();
  });

  it.each(["network-assisted", "telemetry"] as const)(
    "publishes the %s mode for consistent semantics",
    (mode) => {
      render(
        <DataHandlingNotice mode={mode} title="数据说明" description="说明内容" />,
      );
      expect(screen.getByRole("complementary").getAttribute("data-mode")).toBe(mode);
    },
  );
});
