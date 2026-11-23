// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { combineTaxPageGrids, parseTaxHtmlTables } from "./audipickTaxTable";

describe("税表结构OCR直接转Excel网格", () => {
  const legacyAppendix="\n【PDF文字层定位 v2（tax-display-layout-v2；已应用页面旋转；单位：PDF点；坐标原点为显示页左上角，x向右、y向下；x/y/width/height为文字排版包围框，仅辅助核对位置）】\n";
  const positions=Array.from({length:4},(_,i)=>({text:`原文${i}`,x:i%2*100,y:Math.floor(i/2)*20,width:60,height:10}));
  it("旧HTML缓存只排除精确可验证的内部坐标附录，保留真实单位及原注",()=>{
    const html='<p>金额单位：元</p><table><tr><td>项目</td><td>123.45</td></tr></table><p>原注：亏损额按原表保留。</p>';
    const tables=parseTaxHtmlTables(html+legacyAppendix+JSON.stringify(positions))!;
    expect(tables[0].rows).toEqual([["项目","123.45"]]);
    expect(tables[0].notes).toEqual(["金额单位：元","原注：亏损额按原表保留。"]);
    expect(parseTaxHtmlTables(html+legacyAppendix+JSON.stringify(positions.map(item=>({...item,text:"原文".repeat(9000)}))))![0].notes).toEqual(tables[0].notes);
  });
  it("不吞掉损坏坐标附录、相似标记或普通原页说明",()=>{
    const html='<table><tr><td>原表</td></tr></table>';
    for(const note of [
      legacyAppendix+'[{"text":"截断原文"',
      legacyAppendix+JSON.stringify({说明:"原页JSON说明"}),
      legacyAppendix+JSON.stringify(positions)+"\n后续原页说明必须保留",
      "\n【PDF文字层定位 v2（原页说明）】\n"+JSON.stringify(positions),
    ]) {
      expect(parseTaxHtmlTables(html+note)![0].notes?.join("\n")).toBe(note.trim());
    }
    const insideCell=html.replace("原表",`原注${legacyAppendix}${JSON.stringify(positions)}`);
    expect(parseTaxHtmlTables(insideCell)![0].rows[0][0]).toContain("原注");
    expect(parseTaxHtmlTables(insideCell)![0].rows[0][0]).toContain("PDF文字层定位");
  });
  it("多层表头由span确定，不重新推断合并；末行金额列独立", () => {
    const html = `<p>A106000 企业所得税弥补亏损明细表</p><table>
      <tr><th rowspan="3">行次</th><th rowspan="3">项目</th><th colspan="12">金额与年度</th></tr>
      <tr><th colspan="3">年度</th><th colspan="9">亏损</th></tr>
      <tr>${Array.from({length:12},(_,i)=>`<th>${i+1}</th>`).join("")}</tr>
      <tr><td>1</td><td>本年度</td>${Array.from({length:12},(_,i)=>`<td>${i===1?"-1,234.50":i===2?"*":i===3?"0.00":""}</td>`).join("")}</tr>
      <tr><td>12</td><td colspan="12">可结转以后年度弥补的亏损额合计</td><td>123.45</td></tr></table>`;
    const [grid] = parseTaxHtmlTables(html)!;
    expect(grid.rows).toHaveLength(5);
    expect(grid.rows.every(row=>row.length===14)).toBe(true);
    expect(grid.merges).toContainEqual({firstRow:4,lastRow:4,firstCol:1,lastCol:12});
    expect(grid.rows[4][13]).toBe("123.45");
    expect(grid.rows[3].slice(3,7)).toEqual(["-1,234.50","*","0.00",null]);
    expect(grid.rows.flat().filter(v=>v==="可结转以后年度弥补的亏损额合计")).toHaveLength(1);
    expect(grid.notes).toEqual(["A106000 企业所得税弥补亏损明细表"]);
  });
  it("解码文字而不执行HTML，保留换行、管道符、实体和文字型数字", () => {
    const [grid]=parseTaxHtmlTables('```html\n<p>表号 A106000<br>金额单位：元</p><table><tr><td>001</td><td>A &amp; B<br>使用境内所|得</td></tr></table>\n```')!;
    expect(grid.rows).toEqual([["001","A & B\n使用境内所|得"]]);
    expect(grid.notes).toEqual(["表号 A106000\n金额单位：元"]);
    for(const html of ['<table><tr><td><script>alert(1)</script></td></tr></table>', '<table><tr><td><table><tr><td>嵌套</td></tr></table></td></tr></table>']) expect(()=>parseTaxHtmlTables(html)).toThrow();
  });
  it("拒绝截断、非法span、跨界和占位冲突，不把损坏结构当成功", () => {
    for(const html of [
      '<table><tr><td>被截断',
      '<table><tr><td colspan="0">错误</td></tr></table>',
      '<table><tr><td rowspan="2">越界</td></tr></table>',
      '<table><tr><td>一</td><td rowspan="2">二</td></tr><tr><td colspan="2">冲突</td></tr></table>',
    ]) expect(()=>parseTaxHtmlTables(html)).toThrow();
    expect(parseTaxHtmlTables("只有纯文本 | 年度 | 金额 |")).toBeUndefined();
  });
  it("同宽单表跨页保持原网格与合并坐标，金额不改变", () => {
    const a=parseTaxHtmlTables('<table><tr><td>年度</td><td>金额</td></tr><tr><td>2025</td><td>-5.00</td></tr></table>')!;
    const b=parseTaxHtmlTables('<table><tr><td colspan="2">表尾说明</td></tr></table>')!;
    expect(combineTaxPageGrids([{page:7,tables:a},{page:8,tables:b}])).toEqual({rows:[["年度","金额"],["2025","-5.00"],["表尾说明",null]],merges:[{firstRow:2,lastRow:2,firstCol:0,lastCol:1}]});
  });
  it("同页多表及不同列宽保留独立区域，既不猜列也不删除重复表头", () => {
    const first=parseTaxHtmlTables('<table><tr><td>项目</td><td colspan="2">金额</td></tr><tr><td>销售额</td><td>001.00</td><td>*</td></tr></table><table><tr><td>经办人</td><td>张三</td></tr></table>')!;
    const next=parseTaxHtmlTables('<table><tr><td>项目</td><td>金额</td></tr><tr><td>附加税</td><td>-20.30</td></tr></table>')!;
    const combined=combineTaxPageGrids([{page:6,tables:first},{page:7,tables:next}]);
    expect(combined.sections).toEqual([
      {page:6,tableIndex:1,...first[0]},
      {page:6,tableIndex:2,...first[1]},
      {page:7,tableIndex:1,...next[0]},
    ]);
    expect(combined.rows).toEqual([["项目","金额",null],["销售额","001.00","*"],["经办人","张三",null],["项目","金额",null],["附加税","-20.30",null]]);
    expect(combined.merges).toEqual([{firstRow:0,lastRow:0,firstCol:1,lastCol:2}]);
    expect(combined.sections![1].rows[0]).toHaveLength(2);
    expect(combined.sections![2].rows[1][1]).toBe("-20.30");
    combined.rows[0][0]="预览修改";
    expect(combined.sections![0].rows[0][0]).toBe("项目");
    expect(first[0].rows[0][0]).toBe("项目");
  });
  it("保留表外裸文字、div标题、单位和各表caption，不重复单元格内容", () => {
    const tables=parseTaxHtmlTables('```html\n<div>增值税附列资料（四）</div>金额单位：元<p>原页说明<br>第二行</p><table><caption>一、抵减情况</caption><tr><td>本期实际抵减</td><td>280.00</td></tr></table><table><caption>二、加计抵减</caption><tr><td>合计</td><td>0.00</td></tr></table>\n```')!;
    expect(tables[0].notes).toEqual(["增值税附列资料（四）","金额单位：元","原页说明\n第二行","一、抵减情况"]);
    expect(tables[1].notes).toEqual(["增值税附列资料（四）","金额单位：元","原页说明\n第二行","二、加计抵减"]);
    expect(tables.flatMap(table=>table.notes??[]).join("\n")).not.toContain("280.00");
    expect(tables.flatMap(table=>table.notes??[]).join("\n")).not.toContain("```");
  });
  it("独立区域组合仍拒绝空页、非法页码和超限规模", () => {
    const one={rows:[["保留原值"]],merges:[]};
    for(const pages of [[],[{page:1,tables:[]}],[{page:0,tables:[one]}],[{page:1,tables:[one]},{page:1,tables:[one]}],[{page:1,tables:[{rows:[["一",null],["缺列"]],merges:[]}]}]]) expect(()=>combineTaxPageGrids(pages)).toThrow();
    expect(()=>combineTaxPageGrids([{page:1,tables:[{rows:Array.from({length:2001},()=>Array.from({length:500},()=>"0.00")),merges:[]}]}])).toThrow();
  });
});
