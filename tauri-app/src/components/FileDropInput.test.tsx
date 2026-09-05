// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDropInput } from "./FileDropInput";

afterEach(cleanup);

describe("FileDropInput", () => {
  it("多账表上传时完整显示文件名与 Sheet，不把组合文案截成最后一个 Sheet", () => {
    render(
      <FileDropInput
        value="C:/账套/序时账-1.xlsx"
        displayValue="JE：序时账-1.xlsx / 明细；TB：科目余额表.xls / 余额表"
        ariaLabel="重新选择 JE、TB 文件"
        onBrowse={vi.fn()}
        onDragStateChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "重新选择 JE、TB 文件" }),
    ).toHaveTextContent("JE：序时账-1.xlsx / 明细；TB：科目余额表.xls / 余额表");
  });
});
