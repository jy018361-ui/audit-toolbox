import { assessPdfTextLayer, pdfTextFromItems } from "./audipickPdfPreparation";
import { buildTaxPageIndex, type TaxDocumentIndex } from "./audipickTax";
import type { AudiPickOperationHandle } from "./audipickOperation";

export function isTaxRuleId(id?: string): boolean {
  return id === "tax_declaration" || id === "tax_vat" || id === "tax_corporate_income";
}

/** Read native text without triggering the ordinary whole-document OCR pipeline. */
export async function probeTaxDocument(pdf: any, fileName: string, options: {
  forceTax?: boolean;
  recognizeHeader?: (page: any, number: number) => Promise<string>;
  operation?: AudiPickOperationHandle;
} = {}): Promise<TaxDocumentIndex | undefined> {
  const pages: Array<{ page: number; text: string; source: "text" | "header_ocr" }> = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    await options.operation?.checkpoint();
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      pages.push({ page: number, text: pdfTextFromItems(content.items), source: "text" });
    } finally { page.cleanup?.(); }
  }
  let index = buildTaxPageIndex(pages, fileName);
  if (index.taxType === "unknown" && pages[0] && !assessPdfTextLayer(pages[0].text).usable && options.recognizeHeader) {
    await options.operation?.checkpoint();
    const first = await pdf.getPage(1);
    try {
      pages[0] = { page: 1, text: await options.recognizeHeader(first, 1), source: "header_ocr" };
      index = buildTaxPageIndex(pages, fileName);
    } finally { first.cleanup?.(); }
  }
  // Tax words also occur in ordinary invoice/payment clauses. Route only a
  // declaration heading/form, an explicit tax upload, or a tax-labelled file.
  const hasDeclaration = index.forms.length > 0 || pages.some(({ text }) =>
    /(?:企业所得税(?:年度|月[（(]季[）)]度|季度)?纳税申报表|增值税(?:及附加税费)?(?:纳税)?申报表)/.test(text.replace(/\s+/g, "").slice(0, 400)));
  return hasDeclaration || options.forceTax || /纳税申报|增值税|企业所得税/.test(fileName) ? index : undefined;
}
