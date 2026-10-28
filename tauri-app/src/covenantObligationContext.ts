const compact = (text: string) => text.replace(/\s+/g, "");

// A percentage may describe a reportable event rather than a financial limit.
// Consent, an independent limit or a substantive remedy makes the duty more
// than notification alone. A generic default elsewhere is not this context.
const substantiveDuty = /(?:不得|禁止|不能|不应).{0,20}(?:超过|高于|低于|少于|分红|担保|投资|融资|关联交易|处置|出售|转让|分配利润|采取行动|进行|实施)|(?:须经|应经|未经|取得|征得|获得).{0,16}(?:同意|批准)|(?:应|须|必须|承诺|保证|确保|维持|保持).{0,20}(?:不超过|不高于|不低于|不少于|不大于|不小于)|(?:有权|可以|可|应|须).{0,20}(?:提前到期|提前偿还|提前清偿|追加担保|债务保障措施|停止放款)|(?:余额|保证金|净资产|财务指标).{0,20}(?:保持|维持).{0,8}至少|构成违约|违约事件/;
const notification = /(?:应当|应|须|需|必须).{0,100}(?:通知|报告|报备|报送)|(?:通知|报告|报备|报送)(?:贷款人|银行|债权人)/;

export function isNotificationOnlyCovenant(text: string, governingText = ""): boolean {
  const value = compact(text);
  if (substantiveDuty.test(value)) return false;
  if (notification.test(value)) return true;
  const parent = compact(governingText);
  return notification.test(parent) && !substantiveDuty.test(parent);
}

/** Read the list's governing introduction from the full document, across pages
 * and model chunks. Never borrow a preceding sibling's obligation or a remedy
 * from a later article. OCR margin symbols and numbered prefixes are tolerated.
 */
export function governingCovenantText(source: string, position: number): string {
  const lineEnd = source.indexOf("\n", position);
  const prefix = source.slice(0, lineEnd < 0 ? source.length : lineEnd);
  const heading = /^[\s▲△■□◆●*]*(?:[（(]\s*\d+\s*[)）]\s*)?(?:第[一二三四五六七八九十百\d]+条|\d+(?:\.\d+)+(?![\d.%％]))/gm;
  const start = [...prefix.matchAll(heading)].at(-1)?.index ?? 0;
  const before = source.slice(start, lineEnd < 0 ? source.length : lineEnd);
  const listStart = before.search(/^[ \t]*[（(]\s*(?:\d+|[一二三四五六七八九十]+)\s*[)）]/m);
  // Only the introduction governs sibling list entries. No list means there
  // is no reliable inherited scope; the candidate must carry its own duty.
  return listStart < 0 ? "" : before.slice(0, listStart);
}
