import { describe, expect, it } from "vitest";
import {
  applyHighConfidenceAssociations,
  associationRoleForDocument,
  buildAssociationSuggestions,
} from "./audipickAssociations";

describe("AudiPick 关联建议", () => {
  it("识别资料角色，并用共享项目编号唯一匹配主合同", () => {
    const documents = [
      { id: "main", name: "C320借款合同.pdf", text: "借款人与贷款人签订本合同" },
      { id: "appendix", name: "C320补充协议.pdf", text: "补充协议\n项目编号：C320" },
    ];

    expect(associationRoleForDocument(documents[1])).toBe("补充协议/变更");
    expect(buildAssociationSuggestions(documents, [])).toEqual([
      expect.objectContaining({
        fileId: "appendix",
        anchorFileId: "main",
        confidence: "high",
        role: "补充协议/变更",
      }),
    ]);
  });

  it("候选主合同分数接近时不冒然建议，且排除已被占用文件", () => {
    const ambiguous = [
      { id: "main-a", name: "C320甲合同.pdf" },
      { id: "main-b", name: "C320乙合同.pdf" },
      { id: "appendix", name: "C320补充协议.pdf" },
    ];
    expect(buildAssociationSuggestions(ambiguous, [])).toEqual([]);

    const occupied = [{
      id: "ga",
      anchorFileId: "main-a",
      members: [{ fileId: "appendix", role: "补充协议/变更" }],
    }];
    expect(buildAssociationSuggestions(ambiguous, occupied)).toEqual([]);
    expect(buildAssociationSuggestions([
      { id: "main", name: "项目主合同.pdf", text: "合同编号：LOAN-ABCD" },
      { id: "appendix", name: "技术附件.pdf", text: "合同编号：LOAN-ABCD" },
    ], [], ["main>appendix"])).toEqual([]);
  });

  it("识别抵质押和提款资料，按 C320/C323 自动匹配对应主合同", () => {
    const documents = [
      { id: "c320", name: "C320借款合同.pdf" },
      { id: "c320-pledge", name: "C320借款合同_质押合同.pdf" },
      { id: "c323", name: "C323借款合同.pdf" },
      { id: "c323-draw", name: "C323借款合同_提款通知书_1亿4千万元.pdf" },
    ];

    expect(associationRoleForDocument(documents[1])).toBe("担保/抵质押资料");
    expect(associationRoleForDocument(documents[3])).toBe("提款/放款资料");
    expect(buildAssociationSuggestions(documents, [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileId: "c320-pledge", anchorFileId: "c320", confidence: "high" }),
      expect.objectContaining({ fileId: "c323-draw", anchorFileId: "c323", confidence: "high" }),
    ]));
  });

  it("只自动落库高置信建议，并保留来源、置信度和理由", () => {
    const suggestions = [
      { fileId: "high", anchorFileId: "main", anchorName: "主合同.pdf", role: "补充协议/变更", confidence: "high" as const, reason: "项目编号一致", score: 85 },
      { fileId: "medium", anchorFileId: "main", anchorName: "主合同.pdf", role: "技术附件", confidence: "medium" as const, reason: "合同编号一致", score: 70 },
    ];
    const groups = applyHighConfidenceAssociations([], suggestions);

    expect(groups).toEqual([expect.objectContaining({
      anchorFileId: "main",
      members: [{
        fileId: "high",
        role: "补充协议/变更",
        source: "ai",
        confidence: "high",
        reason: "项目编号一致",
      }],
    })]);
  });
});
