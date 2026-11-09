import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 读取实际 TS 导出及步骤条定义，禁止维护另一份手抄文案。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => {
    if (!name.startsWith('.')) throw new Error(`不允许加载外部模块：${name}`);
    return load(path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`)));
  }, module, module.exports);
  cache.set(filename, module.exports);
  return module.exports;
}

const { TOUR_COPY } = load('src/components/tour/tourCopy.ts');
const { TOOL_TOUR_SCRIPTS } = load('src/components/tour/toolTourContent.ts');
const { workspaceTourSteps, buildToolTourSteps } = load('src/components/tour/tourSteps.ts');
// 提示组件不再允许漏在清单之外的内联显示文字。
for (const name of ['BeginnerTour','StepTourHint','SuccessNudge','NewbieModeToggle']) {
  const filename = path.join(root,`src/components/tour/${name}.tsx`);
  const source = ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function check(node) {
    if (ts.isJsxText(node) && node.text.trim()) throw new Error(`${name} 存在未集中导出的文字：${node.text.trim()}`);
    if (ts.isJsxAttribute(node) && ['title','aria-label','placeholder'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
      throw new Error(`${name} 存在未集中导出的提示属性：${node.initializer.text}`);
    }
    ts.forEachChild(node,check);
  }
  check(source);
}
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/tool-catalog.json'), 'utf8'));
const pages = {
  fa_list: ['FaListPage.tsx', 'FaTbJePage.tsx'], fa_dep_calc: ['FaDepCalcPage.tsx'],
  fa_policy_compare: ['FaPolicyComparePage.tsx'], kanzhang: ['KanzhangParityPage.tsx'],
  je_sign_mark: ['JeSignMarkPage.tsx'], deposit_interest: ['DepositInterestPage.tsx'],
  loan_interest: ['LoanInterestPage.tsx'], fx_audit: ['FxAuditPage.tsx'], tbje_check: ['TbjeCheckPage.tsx'],
  ts_manager: ['TsManagerParityPage.tsx'], confirmation_progress: ['ConfirmationProgressPage.tsx'],
  Excel_Merger: ['ExcelMergerPage.tsx'], file_list_directory: ['FileListDirectoryPage.tsx'],
  pdf_to_excel: ['PdfToExcelPage.tsx'], fuzzy_match: ['FuzzyMatchPage.tsx'],
  meeting_minutes: ['MeetingMinutesPage.tsx'], audipick: ['AudiPickPage.tsx'],
  audit_roll_forward: ['RollForwardPage.tsx'], wp_service_generator: ['WpServicePage.tsx'],
};
function textVariants(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...textVariants(node.whenTrue), ...textVariants(node.whenFalse)];
  throw new Error(`步骤标签需要支持新的表达式：${node.getText()}`);
}
function pageSteps(file) {
  const filename = path.join(root, 'src', file);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result = [];
  function visit(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === 'StepIndicator') {
      const attr = node.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(source) === 'steps');
      const expression = attr?.initializer?.expression;
      if (!expression || !ts.isArrayLiteralExpression(expression)) throw new Error(`${file} 步骤定义需要更新提取逻辑`);
      for (const object of expression.elements) {
        const properties = Object.fromEntries(object.properties.map((p) => [p.name.getText(source), p.initializer]));
        result.push({ key: textVariants(properties.key)[0], labels: textVariants(properties.label), file,
          disabled: properties.disabled?.kind === ts.SyntaxKind.TrueKeyword });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

const tools = catalog.map((tool) => {
  if (!TOOL_TOUR_SCRIPTS[tool.id] || !pages[tool.id]) throw new Error(`工具缺少指引或审核页面：${tool.id}`);
  const script = TOOL_TOUR_SCRIPTS[tool.id];
  const steps = pages[tool.id].flatMap(pageSteps);
  for (const key of Object.keys(script.stepHints ?? {})) {
    if (!steps.some((step) => step.key === key)) throw new Error(`${tool.id} 提示步骤不存在：${key}`);
  }
  return { id: tool.id, name: tool.name, tour: buildToolTourSteps(tool), script, steps };
});
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = process.argv[2] ?? 'artifacts/tour-audit-20261018/current-copy.json';
fs.mkdirSync(path.dirname(path.resolve(root, output)), { recursive: true });
fs.writeFileSync(path.resolve(root, output), JSON.stringify({ version: packageInfo.version, workspace: workspaceTourSteps, fixed: TOUR_COPY, tools }, null, 2));
console.log(`已提取 ${workspaceTourSteps.length} 条工作台导览、${tools.length} 个工具及 ${Object.keys(TOUR_COPY).length} 项固定文案。`);
