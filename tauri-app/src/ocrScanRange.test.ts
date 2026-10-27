import { describe, expect, it } from "vitest";
import { parseOcrScanRange } from "./ocrScanRange";

describe("扫描页码输入", () => {
  it.each(["2-5", "2-5页", "第2-5页", " 第 2 - 5 页 "])("接受范围 %s", (input) => {
    expect(parseOcrScanRange(input, 8)).toEqual([2, 3, 4, 5]);
  });

  it("接受混合页码，去重并按实际页序排列", () => {
    expect(parseOcrScanRange("5, 1，3-5、2", 5)).toEqual([1, 2, 3, 4, 5]);
    expect(parseOcrScanRange("1,3-5", 8)).toEqual([1, 3, 4, 5]);
    expect(parseOcrScanRange("3-3", 3)).toEqual([3]);
    expect(parseOcrScanRange("01,002", 3)).toEqual([1, 2]);
  });

  it.each(["‐", "‑", "‒", "–", "—", "―", "−", "﹣", "－"])("接受横线 %s", (dash) => {
    expect(parseOcrScanRange(`2${dash}4`, 4)).toEqual([2, 3, 4]);
  });

  it.each(["", " ", "第页", "0", "0-2", "-1", "1.5", "1-2.5", "5-2", "6", "1-6", "abc", "1a", "1e2", "+1", "1 2", "1\n2", "1,,2", "1,", ",1", "1/2", "1-2-3", "第第2页", "2页页", "第2页,3页", "扫描第2-3页", "2-3页面", "9007199254740992", "1-99999999999999999999999"])("拒绝无效输入 %s", (input) => {
    expect(() => parseOcrScanRange(input, 5)).toThrow(/[\u4e00-\u9fff]/);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("拒绝无效总页数 %s", (total) => {
    expect(() => parseOcrScanRange("1", total)).toThrow("文件总页数尚未确定");
  });

  it("在任何范围展开前验证完整输入", () => {
    expect(() => parseOcrScanRange("1-9007199254740991,无效", Number.MAX_SAFE_INTEGER)).toThrow("页码格式不正确");
  });
});
