import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const date = process.env.TOUR_COPY_DATE ?? new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Singapore', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
const support = path.join(root, 'artifacts', `tour-audit-${date.replaceAll('-', '')}`);
await fs.mkdir(support, {recursive:true});
const dataPath = path.join(support, 'current-copy.json');
execFileSync(process.execPath, ['scripts/collect_tour_copy.mjs', dataPath], {stdio:'inherit'});
const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
const deps = process.env.CODEX_WORKSPACE_NODE_MODULES ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const require = createRequire(import.meta.url);
const entry = require.resolve('@oai/artifact-tool', {paths:[path.dirname(deps)]});
const { FileBlob, SpreadsheetFile } = await import(pathToFileURL(entry).href);
const canonical = path.join(root, '新手指引文案清单.xlsx');
const backup = path.join(support, '新手指引文案清单-更新前.xlsx');
try { await fs.copyFile(canonical, backup, 1); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const input = process.argv[2] ? path.resolve(process.argv[2]) : canonical;
const wb = await SpreadsheetFile.importXlsx(await FileBlob.load(input));
const python = process.env.CODEX_WORKSPACE_PYTHON ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const sourceRows = JSON.parse(execFileSync(python,['scripts/read_tour_workbook.py',input],{encoding:'utf8'}));
const archived = [];
const preserved = new Map();
const oldSheets = new Map();
for (const name of ['说明','工作台导览','工具导览与步骤提示','通用兜底与固定文字','历史批改']) {
  let ws;
  try { ws = wb.worksheets.getItem(name); } catch { continue; }
  const rows = sourceRows[name];
  oldSheets.set(ws.name, rows);
  if (ws.name === '历史批改') archived.push(...rows.slice(1));
  if (!['工作台导览','工具导览与步骤提示','通用兜底与固定文字'].includes(ws.name)) continue;
  const edit = rows[0].indexOf('修改后文案'), note = rows[0].indexOf('备注'), id = rows[0].indexOf('文案ID');
  for (const row of rows.slice(1)) {
    if (!row[edit] && !row[note]) continue;
    if (id >= 0 && row[id]) preserved.set(row[id], [row[edit] ?? '', row[note] ?? '']);
    else archived.push(ws.name === '工具导览与步骤提示' ? [ws.name, ...row] : [ws.name,row[0],row[1],'',row[2],row[3],row[4]]);
  }
}

const workspace = [['步骤ID','标题','当前文案','修改后文案','备注','文案ID']];
for (const step of data.workspace) workspace.push([step.id,step.title,step.body,'','',`workspace.${step.id}`]);
const tools = [['工具ID','工具','段落 / 步骤','当前文案','修改后文案','备注','文案ID','显示条件']];
for (const tool of data.tools) {
  for (const step of tool.tour) tools.push([tool.id,tool.name,step.title,step.body,'','',`${tool.id}.tour.${step.id}`,step.optional ? '进入工具导览；对应区域存在时显示' : '进入工具导览']);
  for (const [key, body] of Object.entries(tool.script.stepHints ?? {})) {
    const steps = tool.steps.filter(step => step.key === key);
    const labels = [...new Set(steps.flatMap(step=>step.labels))].join(' / ');
    tools.push([tool.id,tool.name,`步骤提示：${labels}`,body,'','',`${tool.id}.hint.${key}`,steps.every(step=>step.disabled) ? '预定义文字；当前步骤仅显示进度，不触发提示' : '新手模式开启，切换到本步时；初次挂载不弹']);
  }
  for (const [index, step] of tool.steps.entries()) {
    for (const [variant, label] of step.labels.entries()) tools.push([tool.id,tool.name,`步骤名称：${step.file === 'FaTbJePage.tsx' ? 'TB＋JE 模式 / ' : ''}${step.key}`,label,'','',`${tool.id}.label.${step.file.replace('.tsx','')}.${step.key}.${variant}`,'步骤条及适用步骤提示卡的标题']);
  }
}
const fixedNames = {
  skip:'导览按钮：跳过', previous:'导览按钮：上一步', next:'导览按钮：下一步',finish:'导览按钮：完成',
  stepCount:'导览与步骤提示：进度', dialogLabel:'导览弹窗：朗读名称',closeSymbol:'步骤与完成提示：关闭符号',
  closeStepHint:'步骤提示：关闭按钮名称',closeSuccess:'完成提示：关闭按钮名称',
  fallbackHint:'通用步骤提示',fallbackLastHint:'通用最后一步提示',toggleLabel:'新手模式开关标签',
  workspaceReplayLabel:'工作台重播入口',toggleTitle:'新手模式开关说明',success:'任务完成提示',
  openResult:'完成提示：打开结果按钮',returnWorkspace:'完成提示：返回工作台按钮',openError:'完成提示：打开失败',
  purposeTitle:'工具导览标题：用途',modeTitle:'工具导览标题：模式',prepareTitle:'工具导览标题：资料',
  flowTitle:'工具导览标题：流程',resultTitle:'工具导览标题：产出',genericWelcomeTitle:'兜底导览：欢迎标题',
  genericWelcome:'兜底导览：欢迎正文',genericHeaderTitle:'兜底导览：页头标题',genericHeader:'兜底导览：页头正文',
  genericStepsTitle:'兜底导览：步骤标题',genericSteps:'兜底导览：步骤正文',genericDoneTitle:'兜底导览：结束标题',genericDone:'兜底导览：结束正文',
};
const fixed = [['位置','说明','当前文案','修改后文案','备注','文案ID']];
for (const [key, value] of Object.entries(data.fixed)) {
  if (!fixedNames[key]) throw new Error(`固定文字缺少清单位置说明：${key}`);
  fixed.push([fixedNames[key],value.includes('{') ? '花括号内为运行时替换内容' : '按适用场景显示；关闭按钮名称也供屏幕阅读器使用',value,'','',`fixed.${key}`]);
}

function writeSheet(name, rows, editColumn, widths) {
  const ws = wb.worksheets.getItem(name);
  const old = oldSheets.get(name);
  const idIndex = rows[0].indexOf('文案ID');
  if (idIndex >= 0) for (const row of rows.slice(1)) {
    const edits = preserved.get(row[idIndex]);
    if (edits) { row[editColumn-1] = edits[0]; row[editColumn] = edits[1]; preserved.delete(row[idIndex]); }
  }
  // 内容替换，原有蓝表头与黄色批改列保留；新增行延用相邻行格式。
  ws.getUsedRange().clear({applyTo:'contents'});
  if (rows.length > old.length && old.length > 1) ws.getRangeByIndexes(old.length,0,rows.length-old.length,Math.min(old[0].length,rows[0].length)).copyFrom(ws.getRangeByIndexes(1,0,1,Math.min(old[0].length,rows[0].length)),'all');
  ws.getRangeByIndexes(0,0,rows.length,rows[0].length).values = rows;
  const range = ws.getRangeByIndexes(0,0,rows.length,rows[0].length);
  range.format.wrapText = true;
  range.format.verticalAlignment = 'top';
  ws.getRangeByIndexes(0,0,1,rows[0].length).format.fill = '#D9E2F3';
  ws.getRangeByIndexes(0,0,1,rows[0].length).format.font.bold = true;
  ws.getRangeByIndexes(0,0,1,rows[0].length).format.font.color = '#000000';
  if (editColumn) ws.getRangeByIndexes(1,editColumn-1,rows.length-1,1).format.fill = '#FFF2CC';
  for (let col=0; col<widths.length; col++) ws.getRangeByIndexes(0,col,rows.length,1).format.columnWidth = widths[col];
  // 只按实际文案长度扩展行高，防止旧固定行高裁掉更新后的长文。
  for (let row=1; row<rows.length; row++) {
    const lines = Math.max(...rows[row].map((value,col)=>Math.ceil(String(value ?? '').replace(/[^\x00-\xff]/g,'aa').length / Math.max(widths[col]-2,8))));
    ws.getRangeByIndexes(row,0,1,rows[0].length).format.rowHeight = Math.max(30,lines*15+8);
  }
  ws.freezePanes.freezeRows(1);
}
writeSheet('工作台导览',workspace,4,[16,24,80,46,24,32]);
writeSheet('工具导览与步骤提示',tools,5,[22,24,30,80,46,24,40,48]);
writeSheet('通用兜底与固定文字',fixed,4,[34,42,80,46,24,34]);
const notes = [
  [`新手指引文案清单（${date}，对应 ${data.version} 当前工程）`],
  ['范围：工作台导览、全部工具进页导览与步骤提示、步骤名称、通用兜底、按钮、关闭名称及动态文字模板。'],
  ['浅黄色「修改后文案」列用于填写建议；留空表示保持当前文案。「备注」可填写修改理由。标题和步骤名称也可批改。'],
  ['{toolName}、{description}、{current}、{total}、{title} 为运行时占位符；具体工具名称与当前步骤名称已在工具清单中逐项列出。'],
  ['工作台右上角「新手引导」重播总览；开启侧边栏「新手模式」后，每次进入工具均播放对应导览。'],
  ['「显示条件」区分实际步骤提示与仅显示进度的预定义文案；精简提示的工具不展示未编写的通用提示。'],
  ['「历史批改」完整保留旧表批注；其中已删除或已改版内容仅供追溯，请在当前文案对应行提出新意见。'],
  ['本表直接提取程序中的实际文案和页面步骤定义生成；更新工程文案后可重新导出，避免另行手抄。'],
];
const noteSheet = wb.worksheets.getItem('说明');
noteSheet.getUsedRange().clear({applyTo:'contents'});
noteSheet.getRangeByIndexes(0,0,notes.length,1).values = notes;
noteSheet.getRangeByIndexes(0,0,notes.length,1).format.wrapText = true;
noteSheet.getRangeByIndexes(0,0,notes.length,1).format.columnWidth = 110;
noteSheet.getRangeByIndexes(0,0,notes.length,1).format.rowHeight = 44;
if (preserved.size) for (const [id, edits] of preserved) archived.push(['新版已移除文字',id,'','','',...edits]);
const uniqueArchive = [...new Map(archived.map(row=>[JSON.stringify(row),row])).values()];
if (uniqueArchive.length) {
  const ws = oldSheets.has('历史批改') ? wb.worksheets.getItem('历史批改') : wb.worksheets.add('历史批改');
  const count = Math.max(7,...uniqueArchive.map(row=>row.length));
  const rows = [['原工作表','工具/步骤ID','工具/标题','原段落','原文案','原修改后文案','原备注'],...uniqueArchive].map(row=>Array.from({length:count},(_,index)=>row[index]??''));
  ws.getUsedRange()?.clear({applyTo:'contents'});
  ws.getRangeByIndexes(0,0,rows.length,count).values=rows;
  ws.getRangeByIndexes(0,0,rows.length,count).format.wrapText=true;
  ws.getRangeByIndexes(0,0,rows.length,count).format.verticalAlignment='top';
  ws.getRangeByIndexes(0,0,rows.length,count).format.columnWidth=30;
  ws.getRangeByIndexes(0,4,rows.length,1).format.columnWidth=80;
  ws.getRangeByIndexes(0,0,1,count).format.fill='#D9E2F3';
  ws.getRangeByIndexes(0,0,1,count).format.font.bold=true;
  ws.getRangeByIndexes(0,0,1,count).format.font.color='#000000';
  ws.getRangeByIndexes(1,0,rows.length-1,count).format.rowHeight=100;
  ws.freezePanes.freezeRows(1);
}

wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'通用兜底与固定文字!A1:F4',include:'values',tableMaxRows:4,tableMaxCols:6,maxChars:1500})).ndjson);
const expected = [...workspace.slice(1).flatMap(row=>[row[1],row[2]]),...tools.slice(1).map(row=>row[3]),...fixed.slice(1).map(row=>row[2])];
const cellValues = [workspace,tools,fixed].flat(2);
if (expected.some(value=>typeof value !== 'string' || !cellValues.includes(value))) throw new Error('存在未导出的新手文案');
const ids = [...workspace.slice(1).map(row=>row[5]),...tools.slice(1).map(row=>row[6]),...fixed.slice(1).map(row=>row[5])];
if (new Set(ids).size !== ids.length) throw new Error('文案ID重复');
const errors = await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',options:{useRegex:true,maxResults:20},maxChars:1500});
console.log(errors.ndjson);
const output = await SpreadsheetFile.exportXlsx(wb);
const dated = path.join(root,`新手指引文案清单-${date}.xlsx`);
await output.save(dated);
await fs.copyFile(dated,canonical);
await fs.writeFile(path.join(support,'export-summary.json'),JSON.stringify({date,version:data.version,workspace:workspace.length-1,toolRows:tools.length-1,fixed:fixed.length-1,total:ids.length,historicalEdits:uniqueArchive.length,ids,expected},null,2));
console.log(`已更新 ${canonical}，另存 ${dated}；共 ${ids.length} 项，保留 ${uniqueArchive.length} 条历史批改。`);
execFileSync(python,['scripts/verify_tour_copy_workbook.py',dated,path.join(support,'export-summary.json'),dataPath],{stdio:'inherit'});
