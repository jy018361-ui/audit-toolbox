import type { TaxGridMerge } from "./audipickTax";

export type TaxPageGrid = { rows: (string | number | null)[][]; merges: TaxGridMerge[]; notes?: string[] };
/** Independent source regions retain their own columns; tableIndex is 1-based. */
export type TaxPageGridSection = TaxPageGrid & { page: number; tableIndex: number };
export type CombinedTaxPageGrid = TaxPageGrid & { sections?: TaxPageGridSection[] };

function invalid(message: string): never { throw new Error(`税表结构 OCR 无效：${message}`); }

/** Browsers silently repair truncated HTML. Reject that before using the DOM. */
function checkClosedStructure(html: string) {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\s*(\/?)\s*(table|tr|td|th)\b[^>]*>/gi)) {
    const tag = match[2].toLowerCase();
    if (match[1]) {
      if (stack.pop() !== tag) invalid("表格标签未正确闭合，可能存在截断。");
    } else {
      const parent = stack.at(-1);
      if (tag === "table" ? stack.length > 0 : tag === "tr" ? parent !== "table" : parent !== "tr") invalid("表格嵌套或单元格标签顺序错误。");
      stack.push(tag);
    }
  }
  if (stack.length) invalid("表格标签未正确闭合，可能存在截断。");
}

function span(cell: HTMLTableCellElement, name: "rowspan" | "colspan", maximum: number): number {
  const value = cell.getAttribute(name) ?? "1";
  if (!/^\d+$/.test(value)) return invalid(`${name} 必须为正整数。`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) return invalid(`${name} 超出有效范围。`);
  return result;
}

function elementText(element: Element): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  return (copy.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

/** Earlier readers appended this exact internal trailer to structured OCR.
 * Remove it only when its complete shape proves it is generated positioning
 * data; similar original notes and damaged trailers remain visible. */
function withoutLegacyLayoutAppendix(text: string): string {
  const marker="\n【PDF文字层定位 v2（tax-display-layout-v2；已应用页面旋转；单位：PDF点；坐标原点为显示页左上角，x向右、y向下；x/y/width/height为文字排版包围框，仅辅助核对位置）】\n";
  const index=text.lastIndexOf(marker);
  if(index<0 || !/<\/table\s*>/i.test(text.slice(0,index))) return text;
  let items:unknown;
  try {items=JSON.parse(text.slice(index+marker.length));} catch {return text;}
  if(!Array.isArray(items)||items.length<4||!items.every(item=>item&&typeof item==="object"&&!Array.isArray(item)
    && Object.keys(item).length===5 && typeof item.text==="string"&&item.text.trim()
    && [item.x,item.y,item.width,item.height].every(value=>typeof value==="number"&&Number.isFinite(value))
    && item.width>=0&&item.height>=0)
    ||new Set(items.map(item=>item.x)).size<2||new Set(items.map(item=>item.y)).size<2) return text;
  return text.slice(0,index);
}

/** Keep visible titles/units even when OCR uses divs or bare text instead of p. */
function outsideTableNotes(body: HTMLElement): string[] {
  const notes: string[] = [];
  const add = (text: string) => {
    const value = text.split(/\r?\n/).filter(line => !/^\s*```(?:html)?\s*$/i.test(line)).join("\n").replace(/\u00a0/g, " ").trim();
    if (value) notes.push(value);
  };
  const block = /^(?:P|DIV|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|UL|OL|LI|PRE)$/;
  function visit(parent: Element) {
    let inline = "";
    const flush = () => { add(inline); inline = ""; };
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { inline += node.textContent ?? ""; continue; }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.tagName === "TABLE") { flush(); continue; }
      if (element.tagName === "BR") { inline += "\n"; continue; }
      if (block.test(element.tagName) || element.querySelector("table")) {
        flush();
        if ([...element.children].some(child => block.test(child.tagName)) || element.querySelector("table")) visit(element);
        else add(elementText(element));
      } else inline += elementText(element);
    }
    flush();
  }
  visit(body);
  return notes;
}

/** OCR already supplied the table topology. Never ask a second model to guess it. */
export function parseTaxHtmlTables(text: string): TaxPageGrid[] | undefined {
  if (!/<\s*table\b/i.test(text)) return undefined;
  text=withoutLegacyLayoutAppendix(text);
  if (/<\s*(?:script|iframe|object|embed|svg|img|link)\b/i.test(text)) invalid("表格不允许包含脚本、外部内容或图片。");
  checkClosedStructure(text);
  const doc = new DOMParser().parseFromString(text, "text/html");
  const tables = [...doc.querySelectorAll("table")];
  const notes = outsideTableNotes(doc.body);
  if (!tables.length || tables.some(table => table.querySelector("table"))) invalid("存在空表格或嵌套表格。");
  return tables.map(table => {
    const sourceRows = [...table.rows];
    if (!sourceRows.length || sourceRows.length > 20000) return invalid("表格行数无效。");
    const rows: TaxPageGrid["rows"] = sourceRows.map(() => []);
    const occupied = sourceRows.map(() => new Set<number>());
    const merges: TaxGridMerge[] = [];
    let width = 0;
    sourceRows.forEach((row, r) => {
      let col = 0;
      for (const cell of row.cells) {
        while (occupied[r].has(col)) col++;
        const height = span(cell, "rowspan", sourceRows.length), breadth = span(cell, "colspan", 512);
        if (r + height > rows.length || col + breadth > 512) invalid("合并区域超出表格行列范围。");
        for (let y = r; y < r + height; y++) for (let x = col; x < col + breadth; x++) {
          if (occupied[y].has(x)) invalid(`第 ${r + 1} 行合并区域覆盖已有单元格。`);
          occupied[y].add(x);
          rows[y][x] = null;
        }
        const value = elementText(cell);
        rows[r][col] = value || null;
        if (height > 1 || breadth > 1) merges.push({ firstRow: r, lastRow: r + height - 1, firstCol: col, lastCol: col + breadth - 1 });
        col += breadth;
        width = Math.max(width, col);
      }
    });
    if (!width || rows.length * width > 1_000_000 || !rows.some(row => row.some(value => value !== null && value !== undefined))) invalid("表格为空或规模超出限制。");
    // A missing cell must not silently shorten a row or shift another column.
    if (occupied.some(cols => cols.size !== width)) invalid("存在缺失单元格，无法确定完整列边界。");
    const tableNotes = [...notes, ...[...table.querySelectorAll("caption")].map(elementText).filter(Boolean)];
    return { rows: rows.map(row => Array.from({length:width}, (_, c) => row[c] ?? null)), merges, ...(tableNotes.length?{notes:tableNotes}: {}) };
  });
}

/** Keep every source region and heading. Padding is only a compatibility view;
 * independent sections are authoritative for rendering/exporting different grids. */
export function combineTaxPageGrids(pages: { page: number; tables: TaxPageGrid[] }[]): CombinedTaxPageGrid {
  if (!pages.length || pages.some(page => !Number.isSafeInteger(page.page) || page.page < 1 || !page.tables.length)
    || new Set(pages.map(page => page.page)).size !== pages.length) return invalid("所选页码无效、重复或页面没有完整表格。");
  let width = 0, height = 0, sections = 0;
  const widths = new Set<number>();
  for (const page of pages) for (const grid of page.tables) {
    const columns = grid.rows[0]?.length;
    if (!columns || columns > 512 || grid.rows.some(row => row.length !== columns)) invalid(`PDF 第 ${page.page} 页表格列边界不完整。`);
    width = Math.max(width, columns);
    widths.add(columns);
    height += grid.rows.length;
    sections++;
    if (height > 20000 || height * width > 1_000_000 || sections > 10000) invalid("所选表格总规模超出限制。");
  }
  const independent = widths.size > 1 || pages.some(page => page.tables.length > 1);
  const result: CombinedTaxPageGrid = { rows: [], merges: [], ...(independent ? { sections: [] } : {}) };
  for (const page of pages) {
    page.tables.forEach((grid, index) => {
      const offset = result.rows.length;
      result.rows.push(...grid.rows.map(row => Array.from({length:width}, (_, column) => row[column] ?? null)));
      result.merges.push(...grid.merges.map(merge => ({ ...merge, firstRow: merge.firstRow + offset, lastRow: merge.lastRow + offset })));
      if (grid.notes?.length) result.notes = [...new Set([...(result.notes??[]),...grid.notes])];
      result.sections?.push({ page: page.page, tableIndex: index + 1, rows: grid.rows.map(row => [...row]), merges: grid.merges.map(merge => ({...merge})), ...(grid.notes?.length ? {notes:[...grid.notes]} : {}) });
    });
  }
  return result;
}
