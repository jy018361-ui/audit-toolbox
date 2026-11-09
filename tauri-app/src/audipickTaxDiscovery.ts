import { taxFormCatalogue, type TaxDocumentIndex, type TaxForm } from "./audipickTax";

/** A directory is evidence of a possible missing form, never extraction content. */
export function taxDirectoryGaps(index: TaxDocumentIndex, confirmedKeys: string[] = []): TaxForm[] {
  const directory = index.pages.filter(page => page.kind === "directory").map(page => page.text.normalize("NFKC").replace(/\s+/g, "")).join("\n");
  if (!directory) return [];
  const found = new Set([...index.forms.map(form => form.key), ...confirmedKeys]);
  return taxFormCatalogue().filter(form => !found.has(form.key) && (
    /^[AB]\d{6}$/.test(form.formCode)
      ? new RegExp(`(?<![A-Z0-9])${form.formCode}(?![0-9])`, "i").test(directory)
      : directory.includes(form.formName.normalize("NFKC").replace(/\s+/g, ""))
  ));
}
