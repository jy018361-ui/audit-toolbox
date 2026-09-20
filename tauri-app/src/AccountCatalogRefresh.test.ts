import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("四个账表工具的科目清单刷新契约", () => {
  it("存款：身份字段映射变化后按当前映射重读，并以引擎末级目录展示", () => {
    const text = source("DepositInterestPage.tsx");

    expect(text).toContain("async function refreshAccountCatalog(");
    expect(text).toContain("depositCatalogMappingKey(current) !== depositCatalogMappingKey(mapping)");
    expect(text).toMatch(
      /engineCall\(`deposit\.inspect_\$\{kind\}`,[\s\S]*?mapping,[\s\S]*?\) as Inspection/,
    );
    expect(text).toContain("tb?.accountsLeaf ?? tb?.accounts ?? []");
  });

  it("外汇：进入科目确认时强制把采样预览升级为完整末级目录", () => {
    const text = source("FxAuditPage.tsx");

    expect(text).toContain("const needsFullCatalog = step === 1 && current.sampledPreview === true;");
    expect(text).toContain("catalogMappingKeys.current[kind] === mappingKey && !needsFullCatalog");
    expect(text).toMatch(
      /engineCall\(`fx\.inspect_\$\{kind\}`,[\s\S]*?mapping,[\s\S]*?fullCatalog: needsFullCatalog/,
    );
    expect(text).toContain("tb?.accountsLeaf ?? tb?.accounts");
  });

  it("借款：TB 映射变化即废弃旧科目和利率状态，并按新映射重拉末级目录", () => {
    const text = source("LoanInterestPage.tsx");

    const invalidateStart = text.indexOf('if (kind === "tb") {');
    const invalidateEnd = text.indexOf("setSources", invalidateStart);
    const invalidation = text.slice(invalidateStart, invalidateEnd);
    expect(invalidation).toContain("setTbAccounts([])");
    expect(invalidation).toContain("setLoanAccountRoles({})");
    expect(invalidation).toContain("setLoanDetailRoles({})");
    expect(invalidation).toContain("setTbRateEdits({})");

    expect(text).toMatch(
      /engineCall\("loan\.tb_accounts",\s*\{[\s\S]*?tbSource: source\("tb"\)/,
    );
    expect(text).toContain(
      "[step, mode, sources.tb.inspection, sources.tb.mapping, tbAccounts.length]",
    );
    expect(text).toMatch(/function source\(kind: Kind\)[\s\S]*?mapping: x\.mapping/);
  });

  it("FA：进入科目复核前按已确认映射重读 TB 与 JE，再重建全部 TB 科目", () => {
    const text = source("FaTbJePage.tsx");

    expect(text).toContain("async function openAccountReview()");
    expect(text).toContain('(["tb", "je"] as const).map');
    expect(text).toMatch(
      /engineCall\(`deposit\.inspect_\$\{kind\}`,[\s\S]*?source: source\(kind\),[\s\S]*?mapping: mappings\[kind\]/,
    );
    expect(text).toContain("setAccountsReviewed(false)");
    expect(text).toContain("[...new Set(inspects.tb?.accounts ?? [])]");
    expect(text).toContain("faReviewEntityAccounts(inspects.tb?.entityAccounts, entityKeyEnabled)");
  });
});
