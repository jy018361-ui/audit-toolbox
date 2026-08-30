// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NumberInput } from "./NumberInput";

afterEach(cleanup);

/** 存款/借款利率格子的真实用法：父组件存的是小数，格子里显示百分数。 */
function Harness({ initial = 0.0005 }: { initial?: number }) {
  const [rate, setRate] = useState<number | undefined>(initial);
  return (
    <>
      <NumberInput
        label="利率"
        step="0.01"
        value={rate == null ? "" : Number((rate * 100).toFixed(6))}
        onCommit={(text) =>
          setRate(text.trim() === "" ? undefined : Number(text) / 100)
        }
      />
      <output>{rate === undefined ? "未填" : rate}</output>
    </>
  );
}

describe("数字输入框", () => {
  const box = () => screen.getByRole("spinbutton", { name: "利率" });

  it("逐字符敲 0.05 不会被回写吞掉小数位", () => {
    render(<Harness />);
    // 敲之前是父组件给的默认值 0.05%。
    expect(box()).toHaveValue(0.05);
    for (const text of ["0", "0.0", "0.05"]) {
      fireEvent.change(box(), { target: { value: text } });
      // 关键：格子里必须还是用户敲进去的那串，不能被"数字→文本"改写。
      expect((box() as HTMLInputElement).value).toBe(text);
    }
    expect(screen.getByText("0.0005")).toBeInTheDocument();
  });

  it("失焦后交回上层规范化后的值", () => {
    render(<Harness />);
    // 敲的时候原样保留，包括上层会归一掉的多余小数位。
    fireEvent.change(box(), { target: { value: "0.1234567" } });
    expect((box() as HTMLInputElement).value).toBe("0.1234567");
    expect(screen.getByText("0.001234567")).toBeInTheDocument();
    // 上层按 6 位小数归一，失焦后格子跟着回到归一值。
    fireEvent.blur(box());
    expect(box()).toHaveValue(0.123457);
  });

  it("清空格子交给上层当没填处理", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.blur(box());
    expect((box() as HTMLInputElement).value).toBe("");
    expect(screen.getByText("未填")).toBeInTheDocument();
  });
});
