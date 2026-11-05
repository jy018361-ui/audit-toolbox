import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { nativeTaxTableHtml, TAX_NATIVE_PDF_OPS as O } from "./audipickTaxNative";

function fixture(options: { crossing?: boolean; open?: boolean; irregular?: boolean; curve?: boolean; garbled?: boolean } = {}) {
  const fnArray: number[] = [], argsArray: unknown[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => { fnArray.push(O.constructPath, O.stroke); argsArray.push([[O.moveTo, O.lineTo], [x1, y1, x2, y2], [0, 90, 0, 90]], null); };
  for (const y of [0, 30, 60, 90]) if (!(options.open && y === 90)) line(0, y, 90, y);
  for (const x of [0, 30, 60, 90]) {
    if (x === 30) line(x, 0, x, 60); // First displayed row has a two-column header.
    else line(x, 0, x, 90);
  }
  if (options.irregular) {
    // Remove only the left part of the first horizontal internal wall, making
    // the connected cells L-shaped rather than a rectangular merged cell.
    const i = argsArray.findIndex((a: any) => a?.[1]?.join(",") === "0,60,90,60");
    argsArray[i] = [[O.moveTo, O.lineTo], [30, 60, 90, 60], [0, 90, 0, 90]];
  }
  if (options.curve) { fnArray.push(O.constructPath, O.stroke); argsArray.push([[O.moveTo, 15], [0, 0, 10, 10, 20, 20, 30, 30]], null); }
  const items: { str: string; transform: number[]; width: number; height: number }[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (r === 0 && c === 1) continue;
    items.push({ str: options.garbled ? "�".repeat(10) : r === 0 && c === 0 ? "合并表头甲＆乙" : `第${r + 1}行第${c + 1}列测试内容`, transform: [8, 0, 0, 8, c * 30 + 3, 90 - r * 30 - 15], width: options.crossing && r === 1 && c === 0 ? 65 : 20, height: 8 });
  }
  return { getViewport: () => ({ transform: [1, 0, 0, -1, 0, 90] }), getOperatorList: async () => ({ fnArray, argsArray }), getTextContent: async () => ({ items }) };
}

function glyphFixture(options: { baseline?: number; descent?: number } = {}) {
  const page: any=fixture();
  const setup=async () => {
    const operators=await page.getOperatorList(),content=await page.getTextContent();
    if(options.baseline!==undefined)content.items.find((i:any)=>i.transform[4]===3&&i.transform[5]===45).transform[5]=90-options.baseline;
    for(const item of content.items) {
      operators.fnArray.push(31,37,42,44,32);
      operators.argsArray.push(null,["font",8],[1,0,0,1,item.transform[4],item.transform[5]],[[...item.str].map(unicode=>({unicode,width:item.width/[...item.str].length/8*1000,isSpace:false}))],null);
    }
    page.commonObjs={get:()=>({fontMatrix:[0.001,0,0,0.001,0,0],ascent:1,descent:options.descent??0})};
    page.getOperatorList=async()=>operators;page.getTextContent=async()=>content;
    return page;
  };
  return setup();
}

describe("native tax vector tables", () => {
  it("derives grid cells and merged headers from ruled boundaries, preserving text", async () => {
    const html = await nativeTaxTableHtml(fixture());
    expect(html).toContain('<td colspan="2">合并表头甲＆乙</td>');
    expect(html?.match(/<tr>/g)).toHaveLength(3);
    expect(html?.match(/<td/g)).toHaveLength(8);
    expect(html).toContain("第3行第3列测试内容");
  });
  it("preserves a path across split constructPath operators and clears it after painting", async () => {
    const page = fixture();
    const operators = await page.getOperatorList();
    const split = { fnArray: [] as number[], argsArray: [] as any[] };
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i], args = operators.argsArray[i] as any;
      if (op === O.constructPath) {
        // PDF.js may split a path between moveTo and lineTo at its buffer boundary.
        split.fnArray.push(O.constructPath, O.constructPath);
        split.argsArray.push([[O.moveTo], args[1].slice(0, 2)], [[O.lineTo], args[1].slice(2)]);
      } else { split.fnArray.push(op); split.argsArray.push(args); }
    }
    page.getOperatorList = async () => split;
    const html = await nativeTaxTableHtml(page);
    expect(html).toBe(await nativeTaxTableHtml(fixture()));
    expect(html).toContain("第3行第3列测试内容");
    split.fnArray.push(O.constructPath, O.stroke);
    split.argsArray.push([[O.lineTo], [30, 30]], null);
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it.each([{ crossing: true }, { open: true }, { irregular: true }, { curve: true }, { garbled: true }])("falls back for uncertain vector/text evidence %j", async (options) => {
    expect(await nativeTaxTableHtml(fixture(options))).toBeUndefined();
  });
  it("preserves table-external unit/annotation text as escaped notes without moving it into grid cells", async () => {
    const page = fixture();
    const content = await page.getTextContent();
    content.items.push({ str: "金额单位：元&角<分>", transform: [8, 0, 0, 8, 3, 105], width: 60, height: 8 });
    page.getTextContent = async () => content;
    const html = await nativeTaxTableHtml(page);
    expect(html).toContain('<p data-tax-source-note="native-vector-v1">金额单位：元&amp;角&lt;分&gt;</p>');
    expect(html?.match(/<td/g)).toHaveLength(8);
    expect(html).toContain('<table data-tax-source="native-vector-v1">');
  });
  it("orders external notes visually with line breaks and rejects partly overlapping text", async () => {
    const page = fixture();
    const content = await page.getTextContent();
    content.items.push(
      { str: "第二行", transform: [8, 0, 0, 8, 3, 102], width: 20, height: 8 },
      { str: "首行", transform: [8, 0, 0, 8, 3, 112], width: 20, height: 8 },
    );
    page.getTextContent = async () => content;
    expect(await nativeTaxTableHtml(page)).toContain('首行<br>第二行</p>');
    // Displayed advance box y=-5..3 overlaps the table, center y=-1 is outside.
    content.items.push({ str: "跨表框", transform: [8, 0, 0, 8, 3, 87], width: 20, height: 8 });
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("falls back when a nonempty item's placement cannot be transformed or graphics-state effects are unknown", async () => {
    const page = fixture();
    const content = await page.getTextContent();
    content.items[0].transform[4] = NaN;
    page.getTextContent = async () => content;
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
    const hidden = fixture();
    const operators = await hidden.getOperatorList();
    operators.fnArray.unshift(9); operators.argsArray.unshift(["unknown alpha/clipping effects"]);
    hidden.getOperatorList = async () => operators;
    expect(await nativeTaxTableHtml(hidden)).toBeUndefined();
  });
  it("separates adjacent amounts using glyph advances instead of a combined text item's box", async () => {
    const page: any = fixture(), operators = await page.getOperatorList(), content = await page.getTextContent();
    const placed = content.items.map((item: any) => ({ ...item }));
    placed.find((item: any) => item.transform[4] === 3 && item.transform[5] === 45).str = "12.00";
    placed.find((item: any) => item.transform[4] === 33 && item.transform[5] === 45).str = "34.00";
    // The real PDF.js text layer combines these two financial cells into one
    // item; the PDF painting stream still contains separate positioned glyphs.
    placed[0].str = "Company Tax Form";
    const combined = placed.filter((item: any) => !(item.transform[4] === 33 && item.transform[5] === 45)).map((item: any) => item.transform[4] === 3 && item.transform[5] === 45 ? { ...item, str: "12.00 34.00 ", width: 56 } : item);
    for (const item of placed) {
      operators.fnArray.push(31, 37, 42, 44, 32);
      operators.argsArray.push(null, ["font", 8], [1,0,0,1,item.transform[4],item.transform[5]], [[...item.str].map(unicode => ({ unicode, width: item.width / [...item.str].length / 8 * 1000, isSpace: false }))], null);
    }
    page.commonObjs = { get: () => ({ fontMatrix: [0.001,0,0,0.001,0,0], ascent: 1, descent: 0 }) };
    page.getTextContent = async () => ({ items: combined });
    page.getOperatorList = async () => operators;
    const html = await nativeTaxTableHtml(page);
    expect(html).toContain("<td>12.00</td><td>34.00</td>");
    expect(html).toContain("Company Tax Form");
    expect(html).toContain("第3行第3列测试内容");
    // Coordinates alone are not enough: require every original character to
    // occur in the resolved glyph stream, including independent monetary data.
    (operators.argsArray[operators.argsArray.length - 2] as any)[0].pop();
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("does not mistake a short text underline for a second cell border", async () => {
    const page = fixture(), operators = await page.getOperatorList();
    operators.fnArray.push(O.constructPath, O.stroke);
    operators.argsArray.push([[O.moveTo,O.lineTo],[4,30.5,20,30.5]],null);
    page.getOperatorList = async () => operators;
    expect(await nativeTaxTableHtml(page)).toBe(await nativeTaxTableHtml(fixture()));
  });
  it("accepts tax checkbox symbols without accepting a corrupted ToUnicode layer", async () => {
    const page = fixture(), content = await page.getTextContent();
    content.items[0].str = "是否享受优惠 □是 ■否 √已填写 □是 ■否 √已填写";
    page.getTextContent = async () => content;
    expect(await nativeTaxTableHtml(page)).toContain("□是 ■否 √已填写");
    content.items[0].str += "\uE000";
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("reads opaque filled rectangle borders while excluding transparent annotations and honoring rectangular clips", async () => {
    const page = fixture(), original = await page.getOperatorList();
    const fnArray: number[] = [10, O.constructPath, 30, 28], argsArray: any[] = [null, [[O.rectangle],[-2,-2,94,94]], null, null];
    for (let i = 0; i < original.fnArray.length; i++) if (original.fnArray[i] === O.constructPath) {
      const [x0,y0,x1,y1] = (original.argsArray[i] as any)[1];
      const thickness = 1;
      fnArray.push(O.constructPath,23);
      argsArray.push([[O.rectangle], Math.abs(y1-y0) < 0.01 ? [x0,y0-thickness/2,x1-x0,thickness] : [x0-thickness/2,y0,thickness,y1-y0]],null);
    }
    // A transparent large annotation rectangle is neither a visible wall nor
    // a reason to invent an extra row/column in an otherwise proven grid.
    fnArray.push(80,9,O.constructPath,22,81,11);
    argsArray.push(["annotation",[0,0,90,90],[1,0,0,1,0,0],[1,0,0,1,0,0],false],[[["BM","multiply"],["CA",0],["ca",0]]],[[O.rectangle],[3,3,80,80]],null,null,null);
    page.getOperatorList = async () => ({ fnArray,argsArray });
    expect(await nativeTaxTableHtml(page)).toBe(await nativeTaxTableHtml(fixture()));
    // A clip that physically removes the outer wall cannot be ignored.
    argsArray[1] = [[O.rectangle],[10,0,80,90]];
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("uses a unique majority cell only for exact glyphs with an agreeing baseline",async()=>{
    const page=await glyphFixture({baseline:59.5,descent:-0.5});
    expect(await nativeTaxTableHtml(page)).toContain("<td>第2行第1列测试内容</td>");
    expect(await nativeTaxTableHtml(await glyphFixture({baseline:62,descent:-0.5}))).toBeUndefined(); // 50/50 across the wall
    expect(await nativeTaxTableHtml(await glyphFixture({baseline:61,descent:-0.5}))).toBeUndefined(); // baseline across wall
  });
  it("accepts a real closed two-column continuation table without inventing cells",async()=>{
    const fnArray:number[]=[],argsArray:any[]=[];
    for(const [x0,y0,x1,y1] of [[0,0,90,0],[0,30,90,30],[0,60,90,60],[0,0,0,60],[45,0,45,60],[90,0,90,60]]) {fnArray.push(O.constructPath,O.stroke);argsArray.push([[O.moveTo,O.lineTo],[x0,y0,x1,y1]],null);}
    const items=Array.from({length:4},(_,i)=>({str:`第${i+1}格：声明及税务机关填写信息，原文完整保留。`,transform:[8,0,0,8,i%2*45+3,45-Math.floor(i/2)*30],width:35,height:8}));
    const page={getViewport:()=>({transform:[1,0,0,-1,0,60]}),getOperatorList:async()=>({fnArray,argsArray}),getTextContent:async()=>({items})};
    const html=await nativeTaxTableHtml(page);
    expect(html?.match(/<tr>/g)).toHaveLength(2);expect(html?.match(/<td/g)).toHaveLength(4);expect(html).toContain(items[3].str);
  });
  it("requires visible black fill and does not use a white filled rectangle as a wall",async()=>{
    const page=fixture(),operators=await page.getOperatorList();
    operators.fnArray.unshift(59,O.constructPath,23);operators.argsArray.unshift(new Uint8ClampedArray([255,255,255]),[[O.rectangle],[0,20,90,1]],null);
    page.getOperatorList=async()=>operators;
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("does not promote an isolated text rectangle into a financial grid",async()=>{
    const page=fixture();
    page.getOperatorList=async()=>({fnArray:[O.constructPath,O.stroke],argsArray:[[[O.rectangle],[0,0,90,90]],null]});
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("keeps independent closed tables separate on a single PDF page",async()=>{
    const first=fixture(),second=fixture(),a=await first.getOperatorList(),b=await second.getOperatorList(),one=await first.getTextContent(),two=await second.getTextContent();
    for(const args of b.argsArray as any[])if(args?.[1])for(let i=0;i<args[1].length;i+=2)args[1][i]+=120;
    for(const item of two.items)item.transform[4]+=120;
    const page={getViewport:first.getViewport,getOperatorList:async()=>({fnArray:[...a.fnArray,...b.fnArray],argsArray:[...a.argsArray,...b.argsArray]}),getTextContent:async()=>({items:[...one.items,...two.items]})};
    const html=await nativeTaxTableHtml(page);expect(html?.match(/<table /g)).toHaveLength(2);expect(html?.match(/<td/g)).toHaveLength(16);
  });
  it("subtracts an opaque white eraser from previously painted walls instead of treating it as a wall",async()=>{
    const fnArray:number[]=[],argsArray:any[]=[];
    for(const coordinate of [0,30,60,90,120])for(const coords of [[0,coordinate,120,coordinate],[coordinate,0,coordinate,120]]) {fnArray.push(O.constructPath,O.stroke);argsArray.push([[O.moveTo,O.lineTo],coords],null);}
    const items=Array.from({length:16},(_,i)=>({str:`第${Math.floor(i/4)+1}行第${i%4+1}列测试内容`,transform:[8,0,0,8,i%4*30+3,105-Math.floor(i/4)*30],width:20,height:8}));
    fnArray.push(58,2,O.constructPath,O.stroke);argsArray.push(new Uint8ClampedArray([255,255,255]),[1],[[O.moveTo,O.lineTo],[90,60,120,60]],null);
    const page={getViewport:()=>({transform:[1,0,0,-1,0,120]}),getOperatorList:async()=>({fnArray,argsArray}),getTextContent:async()=>({items})};
    expect(await nativeTaxTableHtml(page)).toContain('<td rowspan="2">第2行第4列测试内容<br>第3行第4列测试内容</td>');
    // Moving that same white paint over text must not silently export hidden
    // data from the text layer as if it were visible on the original page.
    (argsArray[argsArray.length-2] as any)[1]=[90,75,120,75];
    expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("rejects round white eraser caps whose rectangle approximation could conceal content",async()=>{
    const page=fixture(),operators=await page.getOperatorList();
    operators.fnArray.push(58,3,O.constructPath,O.stroke);operators.argsArray.push(new Uint8ClampedArray([255,255,255]),[1],[[O.moveTo,O.lineTo],[0,100,90,100]],null);
    page.getOperatorList=async()=>operators;expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("rejects a sheared Form XObject clip instead of replacing it with an axis-aligned bounding rectangle",async()=>{
    const page=fixture(),operators=await page.getOperatorList();
    operators.fnArray.unshift(74,75);operators.argsArray.unshift([[1,0.001,0,1,0,0],[0,0,90,90]],null);
    page.getOperatorList=async()=>operators;expect(await nativeTaxTableHtml(page)).toBeUndefined();
  });
  it("locks the supported operator protocol to the bundled PDF.js asset", () => {
    const vendor = readFileSync("assets/audipick/pdfjs/legacy/build/pdf.min.js", "utf8");
    for (const [name, number] of Object.entries(O)) expect(Number(vendor.match(new RegExp(`${name}:(\\d+)`))?.[1])).toBe(number);
  });
});
