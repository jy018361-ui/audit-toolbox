import { assessPdfTextLayer, pdfTextFromItems } from "./audipickPdfPreparation";
import { taxPdfTextPositions, type TaxPdfTextPosition } from "./audipickTaxLayout";

// Public OPS protocol of our bundled PDF.js 3.11.174. The vendor contract test
// locks these numbers; do not infer a border from an unknown painting operator.
export const TAX_NATIVE_PDF_OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, moveTo: 13, lineTo: 14, closePath: 18, rectangle: 19, stroke: 20 } as const;
type Point = [number, number];
type Segment = [Point, Point];
type Matrix = number[];
const EPS = 0.08, EDGE = 0.8;
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const matrixValid = (value: any): value is Matrix => value?.length === 6 && Array.from(value).every(Number.isFinite);
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Clip = { x0: number; y0: number; x1: number; y1: number };
type PaintedSegment = Segment & { halfWidth?: number; filled?: boolean };
type VisibleSegments = Segment[] & { erasures?: Clip[] };
function vectorSegments(operatorList: any, viewport: Matrix): VisibleSegments | undefined {
  const O = TAX_NATIVE_PDF_OPS;
  if (!operatorList?.fnArray || operatorList.fnArray.length > 100_000) return undefined;
  type State = { matrix: Matrix; clip?: Clip; strokeAlpha: number; fillAlpha: number; blend: string; width: number; fillBlack: boolean; strokeBlack: boolean; strokeWhite: boolean; cap: number };
  let state: State = { matrix: identity(), strokeAlpha: 1, fillAlpha: 1, blend: "source-over", width: 1, fillBlack: true, strokeBlack: true, strokeWhite: false, cap: 0 };
  let pending: Segment[] = [], rectangles: Clip[] = [], rectangleOnly = true;
  let current: Point | undefined, start: Point | undefined;
  const stack: { kind: number; state: State }[] = [], result: PaintedSegment[] = [], erasures: Clip[] = [];
  const push = (kind: number) => stack.push({ kind, state: { ...state, matrix: [...state.matrix], clip: state.clip && { ...state.clip } } });
  const pop = (kind: number) => { const saved = stack.pop(); if (saved?.kind !== kind) return false; state = saved.state; return true; };
  const intersect = (a: Clip | undefined, b: Clip): Clip => a ? { x0: Math.max(a.x0,b.x0),y0: Math.max(a.y0,b.y0),x1: Math.min(a.x1,b.x1),y1: Math.min(a.y1,b.y1) } : b;
  const transformRect = (rect: number[]): Clip | undefined => {
    if (rect?.length !== 4 || !rect.every(Number.isFinite)) return undefined;
    const m = multiply(viewport,state.matrix);
    if (Math.abs(m[0]*m[2])+Math.abs(m[1]*m[3]) > 1e-9) return undefined;
    const corners = [[rect[0],rect[1]],[rect[2],rect[1]],[rect[2],rect[3]],[rect[0],rect[3]]].map(([x,y]) => [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
    return { x0: Math.min(...corners.map(p=>p[0])), y0: Math.min(...corners.map(p=>p[1])),x1: Math.max(...corners.map(p=>p[0])), y1: Math.max(...corners.map(p=>p[1])) };
  };
  const clear = () => { pending=[];rectangles=[];rectangleOnly=true;current=start=undefined; };
  const add = (segment: Segment, halfWidth: number, filled = false) => {
    let [a,b] = segment.map(p => [...p]) as Segment;
    const clip = state.clip;
    if (clip) {
      if (Math.abs(a[0]-b[0]) <= EPS) { if (a[0] < clip.x0 || a[0] > clip.x1) return; const lo=Math.max(Math.min(a[1],b[1]),clip.y0),hi=Math.min(Math.max(a[1],b[1]),clip.y1); if (hi<=lo) return; a=[a[0],lo];b=[b[0],hi]; }
      else if (Math.abs(a[1]-b[1]) <= EPS) { if (a[1] < clip.y0 || a[1] > clip.y1) return; const lo=Math.max(Math.min(a[0],b[0]),clip.x0),hi=Math.min(Math.max(a[0],b[0]),clip.x1); if (hi<=lo) return; a=[lo,a[1]];b=[hi,b[1]]; }
      else return;
    }
    const painted = [a,b] as PaintedSegment; painted.halfWidth=halfWidth; painted.filled=filled; result.push(painted);
  };
  for (let i=0;i<operatorList.fnArray.length;i++) {
    const op=operatorList.fnArray[i],args=operatorList.argsArray[i];
    if (op===O.save) push(10);
    else if (op===O.restore) { if (!pop(10)) return undefined; }
    else if (op===O.transform) { if (!matrixValid(args)) return undefined; state.matrix=multiply(state.matrix,args); }
    else if (op===2) { if (!Number.isFinite(args?.[0]) || args[0]<0) return undefined; state.width=args[0]; }
    else if (op===3) { if(![0,1,2].includes(args?.[0]))return undefined;state.cap=args[0]; }
    else if (op===58 || op===59) { const values=Array.from(args??[]) as number[]; const black=values.length===3 && values.every(v=>Number.isFinite(v)&&v===0); if(op===58){state.strokeBlack=black;state.strokeWhite=values.length===3&&values.every(v=>v===255);}else state.fillBlack=black; }
    else if (op===56 || op===57) { const black=args?.[0]===0; if(op===56){state.strokeBlack=black;state.strokeWhite=args?.[0]===1;}else state.fillBlack=black; }
    else if ([50,51,52,53,54,55,60,61].includes(op)) { if([50,52,53,60].includes(op)){state.strokeBlack=false;state.strokeWhite=false;}else state.fillBlack=false; }
    else if (op===9) {
      if (!Array.isArray(args?.[0])) return undefined;
      for (const pair of args[0]) {
        if (!Array.isArray(pair)) return undefined;
        const [key,value]=pair;
        if (key==="CA" || key==="ca") { if (![0,1].includes(value)) return undefined; if (key==="CA") state.strokeAlpha=value; else state.fillAlpha=value; }
        else if (key==="BM") { if (!["source-over","multiply"].includes(value)) return undefined; state.blend=value; }
        else if (key==="SMask") { if (value!==false) return undefined; }
        else return undefined;
      }
    } else if (op===6 && args?.[0]?.length) return undefined;
    else if (op===74) {
      push(74); if (args?.[0]) { if (!matrixValid(args[0])) return undefined; state.matrix=multiply(state.matrix,args[0]); }
      if (args?.[1]) { const clip=transformRect(args[1]); if (!clip) return undefined; state.clip=intersect(state.clip,clip); }
    } else if (op===75) { if (!pop(74)) return undefined; }
    else if (op===80) {
      if (!matrixValid(args?.[2]) || !matrixValid(args?.[3])) return undefined;
      push(80);state.matrix=multiply(args[2],args[3]);const clip=transformRect(args[1]);if (!clip) return undefined;state.clip=clip;
    } else if (op===81) { if (!pop(80)) return undefined; }
    else if (op===76 || op===77) return undefined;
    else if (op===O.constructPath) {
      if (!args?.[0] || !args?.[1]) return undefined;
      const transform=multiply(viewport,state.matrix);
      const point=(x:number,y:number):Point=>[transform[0]*x+transform[2]*y+transform[4],transform[1]*x+transform[3]*y+transform[5]];
      const coords=Array.from(args[1]) as number[];if (!coords.every(Number.isFinite)) return undefined;
      let offset=0;
      for (const pathOp of args[0]) {
        if (pathOp===O.moveTo) { rectangleOnly=false;current=point(coords[offset++],coords[offset++]);start=current; }
        else if (pathOp===O.lineTo) { rectangleOnly=false;if (!current) return undefined;const next=point(coords[offset++],coords[offset++]);pending.push([current,next]);current=next; }
        else if (pathOp===O.closePath) { if (!current || !start) return undefined;pending.push([current,start]);current=start; }
        else if (pathOp===O.rectangle) {
          const x=coords[offset++],y=coords[offset++],w=coords[offset++],h=coords[offset++];
          const corners=[point(x,y),point(x+w,y),point(x+w,y+h),point(x,y+h)];
          if (corners.some((a,c)=>{const b=corners[(c+1)%4];return Math.abs(a[0]-b[0])>EPS&&Math.abs(a[1]-b[1])>EPS;})) return undefined;
          for(let c=0;c<4;c++)pending.push([corners[c],corners[(c+1)%4]]);
          rectangles.push({x0:Math.min(...corners.map(p=>p[0])),y0:Math.min(...corners.map(p=>p[1])),x1:Math.max(...corners.map(p=>p[0])),y1:Math.max(...corners.map(p=>p[1]))});current=start=corners[0];
        } else return undefined;
      }
      if (offset!==coords.length || pending.length>20_000) return undefined;
    } else if (op===20 || op===21) {
      if (state.strokeAlpha && (state.blend!=="source-over" || (!state.strokeBlack && !state.strokeWhite))) return undefined;
      if (state.strokeAlpha && state.strokeWhite && state.cap===1) return undefined;
      if (state.strokeAlpha && state.strokeWhite) for(const [a,b] of pending) {
        if(Math.abs(a[0]-b[0])>EPS&&Math.abs(a[1]-b[1])>EPS)return undefined;
        const horizontal=Math.abs(a[1]-b[1])<=EPS,half=state.width/2,cap=state.cap===0?0:half;
        let erase: Clip={x0:Math.min(a[0],b[0])-(horizontal?cap:half),y0:Math.min(a[1],b[1])-(horizontal?half:cap),x1:Math.max(a[0],b[0])+(horizontal?cap:half),y1:Math.max(a[1],b[1])+(horizontal?half:cap)};
        if(state.clip)erase=intersect(state.clip,erase);erasures.push(erase);
        for(let j=result.length-1;j>=0;j--) {
          const segment=result[j],[p,q]=segment,isHorizontal=Math.abs(p[1]-q[1])<=EPS,axis=isHorizontal?0:1,other=1-axis,borderHalf=segment.halfWidth??0;
          const lows=[erase.x0,erase.y0],highs=[erase.x1,erase.y1],coordinate=p[other];
          if(lows[other]>coordinate-borderHalf+EPS||highs[other]<coordinate+borderHalf-EPS)continue;
          const lo=Math.min(p[axis],q[axis]),hi=Math.max(p[axis],q[axis]),cut0=Math.max(lo,lows[axis]),cut1=Math.min(hi,highs[axis]);
          if(cut1<=cut0)continue;result.splice(j,1);
          for(const [from,to] of [[lo,cut0],[cut1,hi]])if(to-from>EPS) {const u=[...p] as Point,v=[...q] as Point;u[axis]=from;v[axis]=to;const part=[u,v] as PaintedSegment;part.halfWidth=segment.halfWidth;part.filled=segment.filled;result.push(part);}
        }
      }
      else if (state.strokeAlpha) for(const segment of pending)add(segment,state.width/2);
      clear();
    } else if (op===22 || op===23) {
      if (state.fillAlpha) {
        if (state.blend!=="source-over" || !state.fillBlack || !rectangleOnly) return undefined;
        for(const rect of rectangles) {
          const w=rect.x1-rect.x0,h=rect.y1-rect.y0;
          // A filled border must be a narrow opaque bar, not an opaque patch
          // which could conceal text. Its real painted thickness proves joins.
          if (Math.min(w,h)>2 || Math.max(w,h)<Math.min(w,h)*4) return undefined;
          if(w>h)add([[rect.x0,(rect.y0+rect.y1)/2],[rect.x1,(rect.y0+rect.y1)/2]],h/2,true);
          else add([[(rect.x0+rect.x1)/2,rect.y0],[(rect.x0+rect.x1)/2,rect.y1]],w/2,true);
        }
      }
      clear();
    } else if (op===29 || op===30) {
      if (!rectangleOnly || rectangles.length!==1) return undefined;
      state.clip=intersect(state.clip,rectangles[0]);
    } else if (op===28) clear();
    else if ([24,25,26,27].includes(op)) return undefined;
  }
  if (pending.length || !result.length || result.length>20_000 || stack.length) return undefined;
  // Adjacent pieces of one border may use different painted thicknesses.
  // A common centerline is admissible only inside the intersection of their
  // real ink bands and while their painted longitudinal ranges touch.
  for (const axis of [0,1] as const) {
    const other=1-axis,parallel=result.map((segment,i)=>({segment,i})).filter(({segment:[a,b]})=>Math.abs(a[axis]-b[axis])<=EPS).sort((u,v)=>u.segment[0][axis]-v.segment[0][axis]);
    const parents=parallel.map((_,i)=>i),find=(i:number):number=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
    const maxHalf=Math.max(0,...parallel.map(p=>p.segment.halfWidth??0));
    for(let i=0;i<parallel.length;i++)for(let j=i+1;j<parallel.length;j++) {
      const a=parallel[i].segment,b=parallel[j].segment,delta=b[0][axis]-a[0][axis];
      if(delta>maxHalf*2+EPS)break;
      if(delta>EPS && (!a.filled || !b.filled))continue;
      if(delta>(a.halfWidth??0)+(b.halfWidth??0)+EPS)continue;
      if(Math.max(Math.min(a[0][other],a[1][other]),Math.min(b[0][other],b[1][other]))>Math.min(Math.max(a[0][other],a[1][other]),Math.max(b[0][other],b[1][other]))+EPS)continue;
      parents[find(i)]=find(j);
    }
    const groups=new Map<number,PaintedSegment[]>();parallel.forEach(({segment},i)=>{const root=find(i);groups.set(root,[...(groups.get(root)??[]),segment]);});
    for(const group of groups.values()) {
      const lo=Math.max(...group.map(s=>s[0][axis]-(s.halfWidth??0))),hi=Math.min(...group.map(s=>s[0][axis]+(s.halfWidth??0)));
      if(lo>hi+EPS)return undefined;
      if(group.length>1)for(const segment of group)segment[0][axis]=segment[1][axis]=(lo+hi)/2;
    }
  }
  // Thin filled bars meet by painted area, while their centerlines can stop a
  // half-stroke short. Snap only endpoints whose actual ink bands intersect.
  const visible = result.map(segment=>{
    const [a,b]=segment.map(p=>[...p]) as Segment;
    const horizontal=Math.abs(a[1]-b[1])<=EPS,axis=horizontal?0:1,other=1-axis;
    for(const endpoint of [a,b]) {
      const candidates=result.filter(perpendicular=>Math.abs(perpendicular[0][axis]-perpendicular[1][axis])<=EPS && Math.abs(endpoint[axis]-perpendicular[0][axis])<=(perpendicular.halfWidth??0)+EPS && endpoint[other]>=Math.min(perpendicular[0][other],perpendicular[1][other])-(segment.halfWidth??0)-EPS && endpoint[other]<=Math.max(perpendicular[0][other],perpendicular[1][other])+(segment.halfWidth??0)+EPS);
      if(candidates.length)endpoint[axis]=candidates.sort((u,v)=>Math.abs(endpoint[axis]-u[0][axis])-Math.abs(endpoint[axis]-v[0][axis]))[0][0][axis];
    }
    return [a,b] as Segment;
  }) as VisibleSegments;
  visible.erasures=erasures;return visible;
}

function boundaries(values: number[]): number[] {
  const result: number[] = [];
  for (const value of values.sort((a, b) => a - b)) if (!result.length || value - result[result.length - 1] > EPS) result.push(value);
  return result;
}

/** Resolve the PDF's actual glyph advances; getTextContent may combine text
 * from adjacent financial cells into one item. Unsupported font state falls back. */
type TaxGlyphPosition = TaxPdfTextPosition & { origin: Point };
function glyphPositions(page: any, operators: any, viewport: Matrix): TaxGlyphPosition[] | undefined {
  if (!operators.fnArray.includes(44) || !page.commonObjs?.get) return undefined;
  type State = { clip?: Clip; ctm: Matrix; tm: Matrix; x: number; y: number; lx: number; ly: number; size: number; font: any; cs: number; ws: number; hs: number; rise: number; leading: number; mode: number };
  let state: State = { ctm: identity(), tm: identity(), x: 0, y: 0, lx: 0, ly: 0, size: 0, font: undefined, cs: 0, ws: 0, hs: 1, rise: 0, leading: 0, mode: 0 };
  const stack: State[] = [], result: TaxGlyphPosition[] = [];
  let clipPath: Clip[] = [], nonRectClipPath = false;
  const displayRect = (rect: number[]) => {
    if (rect?.length !== 4 || !rect.every(Number.isFinite)) return undefined;
    const m = multiply(viewport,state.ctm);
    if (Math.abs(m[0]*m[2])+Math.abs(m[1]*m[3]) > 1e-9) return undefined;
    const points = [[rect[0],rect[1]],[rect[2],rect[1]],[rect[2],rect[3]],[rect[0],rect[3]]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
    return { x0: Math.min(...points.map(p=>p[0])), y0: Math.min(...points.map(p=>p[1])), x1: Math.max(...points.map(p=>p[0])), y1: Math.max(...points.map(p=>p[1])) };
  };
  const clipTo = (rect: Clip) => { const prior=state.clip; state.clip=prior ? {x0:Math.max(prior.x0,rect.x0),y0:Math.max(prior.y0,rect.y0),x1:Math.min(prior.x1,rect.x1),y1:Math.min(prior.y1,rect.y1)} : rect; };
  const move = (dx: number, dy: number) => { state.x = state.lx += dx; state.y = state.ly += dy; };
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], a = operators.argsArray[i];
    if (op === 10) stack.push({ ...state, ctm: [...state.ctm], tm: [...state.tm] });
    else if (op === 11) { if (!stack.length) return undefined; state = stack.pop()!; }
    else if (op === 12) { if (!matrixValid(a)) return undefined; state.ctm = multiply(state.ctm, a); }
    else if (op === 31) { state.tm = identity(); state.x = state.y = state.lx = state.ly = 0; }
    else if (op === 33) state.cs = a[0];
    else if (op === 34) state.ws = a[0];
    else if (op === 35) state.hs = a[0] / 100;
    else if (op === 36) state.leading = -a[0];
    else if (op === 37) { state.font = page.commonObjs.get(a[0]); state.size = a[1]; }
    else if (op === 38) state.mode = a[0];
    else if (op === 39) state.rise = a[0];
    else if (op === 40) move(a[0], a[1]);
    else if (op === 41) { state.leading = -a[1]; move(a[0], a[1]); }
    else if (op === 42) { if (!matrixValid(a)) return undefined; state.tm = a; state.x = state.y = state.lx = state.ly = 0; }
    else if (op === 43) move(0, state.leading);
    else if (op === 44) {
      const f = state.font;
      if (!f || f.vertical || f.isType3Font || !matrixValid(f.fontMatrix) || f.fontMatrix[1] || f.fontMatrix[2] || state.size <= 0 || state.hs <= 0 || !Number.isFinite(f.ascent) || !Number.isFinite(f.descent) || state.mode > 2) return undefined;
      const transform = multiply(viewport, multiply(state.ctm, state.tm));
      for (const glyph of a[0]) {
        if (typeof glyph === "number") { state.x -= glyph * state.size * 0.001 * state.hs; continue; }
        if (!Number.isFinite(glyph.width) || typeof glyph.unicode !== "string" || glyph.accent) return undefined;
        const advance = glyph.width * f.fontMatrix[0] * state.size;
        const x0 = state.x, x1 = x0 + advance * state.hs;
        const y0 = state.y + state.rise + f.descent * state.size, y1 = state.y + state.rise + f.ascent * state.size;
        const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [transform[0] * x + transform[2] * y + transform[4], transform[1] * x + transform[3] * y + transform[5]]);
        const x = Math.max(Math.min(...corners.map(p => p[0])),state.clip?.x0 ?? -Infinity), y = Math.max(Math.min(...corners.map(p => p[1])),state.clip?.y0 ?? -Infinity);
        const width = Math.min(Math.max(...corners.map(p => p[0])),state.clip?.x1 ?? Infinity) - x, height = Math.min(Math.max(...corners.map(p => p[1])),state.clip?.y1 ?? Infinity) - y;
        if (glyph.unicode.trim()) { if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined; result.push({ text: glyph.unicode, x, y, width, height, origin: [transform[0]*state.x+transform[2]*(state.y+state.rise)+transform[4],transform[1]*state.x+transform[3]*(state.y+state.rise)+transform[5]] }); }
        state.x += (advance + state.cs + (glyph.isSpace ? state.ws : 0)) * state.hs;
      }
    } else if (op === 74 || op === 80) {
      stack.push({ ...state, ctm: [...state.ctm], tm: [...state.tm] });
      if (op === 74) { if (a?.[0]) { if (!matrixValid(a[0])) return undefined; state.ctm = multiply(state.ctm,a[0]); } if (a?.[1]) { const rect=displayRect(a[1]); if(!rect)return undefined;clipTo(rect); } }
      else { if (!matrixValid(a?.[2]) || !matrixValid(a?.[3])) return undefined; state.ctm = multiply(a[2],a[3]); const rect=displayRect(a[1]);if(!rect)return undefined;state.clip=rect; }
    } else if (op === 75 || op === 81) { if (!stack.length) return undefined; state = stack.pop()!; }
    else if (op === 91) {
      if (a?.[0]?.length !== 1 || a[0][0] !== 19 || a[1]?.length !== 4) nonRectClipPath=true;
      else { const [x,y,w,h]=a[1],rect=displayRect([x,y,x+w,y+h]);if(!rect)return undefined;clipPath.push(rect); }
    } else if (op === 29 || op === 30) { if(nonRectClipPath||clipPath.length!==1)return undefined;clipTo(clipPath[0]); }
    else if ([20,21,22,23,24,25,26,27,28].includes(op)) { clipPath=[];nonRectClipPath=false; }
    else if ([45,46,47,48,49,76,77].includes(op)) return undefined;
  }
  return result.length ? result : undefined;
}
// PDF.js can synthesize a space between separately painted word runs. Keep
// those source spaces only when the complete glyph sequence matches exactly;
// their positioned following glyph decides the cell, so inter-cell whitespace
// remains leading/trailing whitespace rather than moving financial content.
function preserveItemWhitespace(positions: TaxPdfTextPosition[], source: string): void {
  const compact = (text: string) => text.replace(/\s/gu, "");
  if (compact(positions.map(p => p.text).join("")) !== compact(source)) return;
  let cursor = 0;
  for (const position of positions) {
    let text = "";
    for (const character of position.text.replace(/\s/gu, "")) {
      while (cursor < source.length && /\s/u.test(source[cursor])) text += source[cursor++];
      text += character; cursor += character.length;
    }
    position.text = text;
  }
  // Whitespace at the end of the entire stream is never table data.
}
const characterBag = (text: string) => [...text.normalize("NFKC")].filter(c => !/\s/u.test(c)).sort().join("");

function tableRegions(segments: Segment[]): Segment[][] {
  const parents=segments.map((_,i)=>i), find=(i:number):number=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  const horizontal=segments.map((s,i)=>({s,i})).filter(({s:[a,b]})=>Math.abs(a[1]-b[1])<=EPS), vertical=segments.map((s,i)=>({s,i})).filter(({s:[a,b]})=>Math.abs(a[0]-b[0])<=EPS);
  for(const h of horizontal)for(const v of vertical) {
    if(v.s[0][0]>=Math.min(h.s[0][0],h.s[1][0])-EDGE && v.s[0][0]<=Math.max(h.s[0][0],h.s[1][0])+EDGE && h.s[0][1]>=Math.min(v.s[0][1],v.s[1][1])-EDGE && h.s[0][1]<=Math.max(v.s[0][1],v.s[1][1])+EDGE)parents[find(h.i)]=find(v.i);
  }
  const groups=new Map<number,Segment[]>();segments.forEach((s,i)=>{const id=find(i);groups.set(id,[...(groups.get(id)??[]),s]);});
  return [...groups.values()].filter(group=>group.length>=6 && Math.max(...group.flatMap(s=>s.map(p=>p[0])))-Math.min(...group.flatMap(s=>s.map(p=>p[0])))>=60 && Math.max(...group.flatMap(s=>s.map(p=>p[1])))-Math.min(...group.flatMap(s=>s.map(p=>p[1])))>=30);
}
function cellText(items: TaxPdfTextPosition[]): string {
    const lines: TaxPdfTextPosition[][] = [];
    for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const last = lines.at(-1);
      if (last && Math.abs(last[0].y - item.y) < Math.min(last[0].height, item.height) * 0.4) last.push(item); else lines.push([item]);
    }
    return lines.map((line) => line.sort((a, b) => a.x - b.x).map((item) => item.text).join("").trim()).filter(Boolean).map(escapeHtml).join("<br>");
}

/** Derive independently closed ruled table regions from visible PDF paint.
 * No template or financial value determines cells or merged regions. */
export async function nativeTaxTableHtml(page: any): Promise<string | undefined> {
  if (typeof page?.getOperatorList !== "function") return undefined;
  const viewport = page.getViewport({ scale: 1 })?.transform;
  if (!matrixValid(viewport)) return undefined;
  const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  if (!assessPdfTextLayer(pdfTextFromItems(content.items).replace(/[□■√✓☑☐○●]/gu, "")).usable) return undefined;
  const segments = vectorSegments(operators, viewport);
  if (!segments || segments.some(([a, b]) => ![...a, ...b].every(Number.isFinite) || (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) > EPS))) return undefined;
  const glyphs = glyphPositions(page, operators, viewport);
  if (glyphs) preserveItemWhitespace(glyphs, content.items.map((i: any) => i.str ?? "").join(""));
  const positions = glyphs ?? taxPdfTextPositions(content.items, viewport);
  if (glyphs ? characterBag(positions.map(p => p.text).join("")) !== characterBag(content.items.map((i: any) => i.str ?? "").join("")) : positions.length !== content.items.filter((item: any) => item.str?.trim()).length) return undefined;
  if (segments.erasures?.some(rect=>positions.some(p=>p.x<rect.x1&&p.x+p.width>rect.x0&&p.y<rect.y1&&p.y+p.height>rect.y0))) return undefined;
  const regions=tableRegions(segments).map(lines=>({lines,x0:Math.min(...lines.flatMap(s=>s.map(p=>p[0]))),x1:Math.max(...lines.flatMap(s=>s.map(p=>p[0]))),y0:Math.min(...lines.flatMap(s=>s.map(p=>p[1]))),y1:Math.max(...lines.flatMap(s=>s.map(p=>p[1]))),positions:[] as TaxPdfTextPosition[]})).sort((a,b)=>a.y0-b.y0||a.x0-b.x0);
  if(!regions.length)return undefined;
  const notes: TaxPdfTextPosition[]=[];
  for(const item of positions) {
    const x=item.x+item.width/2,y=item.y+item.height/2;
    const matches=regions.filter(r=>x>=r.x0&&x<=r.x1&&y>=r.y0&&y<=r.y1);
    if(matches.length>1)return undefined;
    if(matches.length)matches[0].positions.push(item);
    else { if(regions.some(r=>item.x<r.x1&&item.x+item.width>r.x0&&item.y<r.y1&&item.y+item.height>r.y0))return undefined;notes.push(item); }
  }
  const tables: string[]=[];
  for(const region of regions) { const html=geometryTableHtml(region.lines,region.positions,!!glyphs);if(!html)return undefined;tables.push(html); }
  return `${notes.length?`<p data-tax-source-note="native-vector-v1">${cellText(notes)}</p>`:""}${tables.join("")}`;
}

function geometryTableHtml(segments: Segment[], positions: TaxPdfTextPosition[], glyphMode: boolean): string | undefined {
  // A text underline is not a cell wall. Consolidate split collinear strokes,
  // then require both endpoints to meet an orthogonal stroke. The strict
  // closed-frame and per-cell wall checks below still prove every accepted cell.
  const consolidate = (axis: 0 | 1): Segment[] => {
    const other = 1 - axis;
    const list = segments.filter(([a,b]) => Math.abs(a[axis] - b[axis]) <= EPS && Math.abs(a[other] - b[other]) > EPS);
    const coordinates = boundaries(list.map(([a]) => a[axis]));
    return coordinates.flatMap(coordinate => {
      const ranges = list.filter(([a]) => Math.abs(a[axis] - coordinate) <= EPS).map(([a,b]) => [Math.min(a[other],b[other]),Math.max(a[other],b[other])]).sort((a,b) => a[0]-b[0]);
      const combined: number[][] = [];
      for (const range of ranges) { const last = combined.at(-1); if (last && range[0] <= last[1] + EDGE) last[1] = Math.max(last[1],range[1]); else combined.push([...range]); }
      return combined.map(([lo,hi]) => axis === 0 ? [[coordinate,lo],[coordinate,hi]] as Segment : [[lo,coordinate],[hi,coordinate]] as Segment);
    });
  };
  const horizontalStrokes = consolidate(1), verticalStrokes = consolidate(0);
  const touches = (point: Point, lines: Segment[], axis: 0 | 1) => lines.some(([a,b]) => Math.abs(point[axis] - a[axis]) <= EDGE && point[1-axis] >= Math.min(a[1-axis],b[1-axis])-EDGE && point[1-axis] <= Math.max(a[1-axis],b[1-axis])+EDGE);
  const horizontal = horizontalStrokes.filter(([a,b]) => touches(a,verticalStrokes,0) && touches(b,verticalStrokes,0));
  const vertical = verticalStrokes.filter(([a,b]) => touches(a,horizontalStrokes,1) && touches(b,horizontalStrokes,1));
  const xs = boundaries(vertical.map(([a]) => a[0])), ys = boundaries(horizontal.map(([a]) => a[1]));
  const rows = ys.length - 1, cols = xs.length - 1;
  const smallContinuation = rows < 3 || cols < 3;
  if (rows < 2 || cols < 2 || (smallContinuation && positions.map(p=>p.text).join("").replace(/\s/gu,"").length < 60) || rows > 1000 || cols > 200 || rows * cols > 50_000 || xs.at(-1)! - xs[0] < 60 || ys.at(-1)! - ys[0] < 30) return undefined;
  if (xs.some((x, i) => i > 0 && x - xs[i - 1] < 2) || ys.some((y, i) => i > 0 && y - ys[i - 1] < 2)) return undefined;
  const covers = (list: Segment[], axis: 0 | 1, coordinate: number, from: number, to: number) => {
    const other = axis === 0 ? 1 : 0;
    const ranges = list.filter(([a]) => Math.abs(a[axis] - coordinate) <= EPS).map(([a, b]) => [Math.min(a[other], b[other]), Math.max(a[other], b[other])]).sort((a, b) => a[0] - b[0]);
    let end = from;
    for (const [start, stop] of ranges) { if (stop < end) continue; if (start > end + EDGE) return false; end = Math.max(end, stop); if (end >= to - EDGE) return true; }
    return false;
  };
  if (!covers(horizontal, 1, ys[0], xs[0], xs.at(-1)!) || !covers(horizontal, 1, ys.at(-1)!, xs[0], xs.at(-1)!)
    || !covers(vertical, 0, xs[0], ys[0], ys.at(-1)!) || !covers(vertical, 0, xs.at(-1)!, ys[0], ys.at(-1)!)) return undefined;
  const parents = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parents[root] !== root) root = parents[root];
    while (parents[i] !== i) { const next = parents[i]; parents[i] = root; i = next; }
    return root;
  };
  const join = (a: number, b: number) => { parents[find(a)] = find(b); };
  const wall = (list: Segment[], axis: 0 | 1, coordinate: number, midpoint: number) => list.some(([a, b]) => Math.abs(a[axis] - coordinate) <= EPS && midpoint >= Math.min(a[1 - axis], b[1 - axis]) - EPS && midpoint <= Math.max(a[1 - axis], b[1 - axis]) + EPS);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c + 1 < cols && !wall(vertical, 0, xs[c + 1], (ys[r] + ys[r + 1]) / 2)) join(r * cols + c, r * cols + c + 1);
    if (r + 1 < rows && !wall(horizontal, 1, ys[r + 1], (xs[c] + xs[c + 1]) / 2)) join(r * cols + c, (r + 1) * cols + c);
  }
  const groups = new Map<number, { cells: number[]; r0: number; r1: number; c0: number; c1: number; text: TaxPdfTextPosition[] }>();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const id = find(r * cols + c), group = groups.get(id) ?? { cells: [], r0: r, r1: r, c0: c, c1: c, text: [] };
    group.cells.push(r * cols + c); group.r0 = Math.min(group.r0, r); group.r1 = Math.max(group.r1, r); group.c0 = Math.min(group.c0, c); group.c1 = Math.max(group.c1, c); groups.set(id, group);
  }
  for (const g of groups.values()) if (g.cells.length !== (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1)
    || !covers(horizontal, 1, ys[g.r0], xs[g.c0], xs[g.c1 + 1]) || !covers(horizontal, 1, ys[g.r1 + 1], xs[g.c0], xs[g.c1 + 1])
    || !covers(vertical, 0, xs[g.c0], ys[g.r0], ys[g.r1 + 1]) || !covers(vertical, 0, xs[g.c1 + 1], ys[g.r0], ys[g.r1 + 1])) return undefined;
  const notes: TaxPdfTextPosition[] = [];
  for (const item of positions) {
    const x = item.x + item.width / 2, y = item.y + item.height / 2;
    if (x < xs[0] || x > xs.at(-1)! || y < ys[0] || y > ys.at(-1)!) {
      if (item.x < xs.at(-1)! && item.x + item.width > xs[0] && item.y < ys.at(-1)! && item.y + item.height > ys[0]) return undefined;
      notes.push(item);
      continue;
    }
    const c = xs.findIndex((right) => right > x) - 1, r = ys.findIndex((bottom) => bottom > y) - 1;
    if (r < 0 || c < 0) return undefined;
    const group = groups.get(find(r * cols + c))!;
    const wholeBox = item.x >= xs[group.c0] - EDGE && item.x + item.width <= xs[group.c1 + 1] + EDGE && item.y >= ys[group.r0] - EDGE && item.y + item.height <= ys[group.r1 + 1] + EDGE;
    if (!wholeBox) {
      if (!glyphMode || !("origin" in item)) return undefined;
      const area = Math.max(0,Math.min(item.x+item.width,xs[group.c1+1])-Math.max(item.x,xs[group.c0])) * Math.max(0,Math.min(item.y+item.height,ys[group.r1+1])-Math.max(item.y,ys[group.r0]));
      const origin=(item as TaxGlyphPosition).origin;
      if (area <= item.width*item.height*0.5 + 1e-8 || origin[0]<xs[group.c0]-EDGE || origin[0]>xs[group.c1+1]+EDGE || origin[1]<ys[group.r0]-EDGE || origin[1]>ys[group.r1+1]+EDGE) return undefined;
    }
    group.text.push(item);
  }
  if ([...groups.values()].filter((group) => group.text.length).length < (smallContinuation ? 4 : 8)) return undefined;
  let html = `${notes.length ? `<p data-tax-source-note="native-vector-v1">${cellText(notes)}</p>` : ""}<table data-tax-source="native-vector-v1">`;
  for (let r = 0; r < rows; r++) {
    html += "<tr>";
    for (let c = 0; c < cols; c++) {
      const g = groups.get(find(r * cols + c))!;
      if (r !== g.r0 || c !== g.c0) continue;
      html += `<td${g.r1 > r ? ` rowspan="${g.r1 - r + 1}"` : ""}${g.c1 > c ? ` colspan="${g.c1 - c + 1}"` : ""}>${cellText(g.text)}</td>`;
    }
    html += "</tr>";
  }
  return `${html}</table>`;
}
