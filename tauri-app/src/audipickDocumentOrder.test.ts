import { describe, expect, it } from "vitest";
import { documentsByRequestedOrder } from "./audipickDocumentOrder";

describe("AudiPick 批量执行顺序", () => {
  it("按界面提交的文件 ID 顺序处理，而不是回退到数据库返回顺序", () => {
    const documents = [
      { id: "c10", name: "C10合同.pdf" },
      { id: "c2", name: "C2合同.pdf" },
      { id: "c1", name: "C1合同.pdf" },
    ];

    expect(
      documentsByRequestedOrder(documents, ["c1", "c2", "c10"]).map(
        (document) => document.id,
      ),
    ).toEqual(["c1", "c2", "c10"]);
  });
});
