// WP Roll Forward 深层工作流演示剧本。
// 其他工具的状态剧本由各自领域文件维护，避免同一方法被重复注册后静默覆盖。
import type { DemoJobEvent } from "../demoRegistry";

type Params = Record<string, unknown>;

const ROOT = "C:\\演示数据\\年度审计\\超长客户集团名称与合并范围变更专项";
const output = (name: string) => `${ROOT}\\输出\\${name}`;
const queued = (message: string, total = 100): DemoJobEvent => ({
  phase: "queued", current: 0, total, message, severity: "info", outputPaths: [],
});
const running = (message: string, current = 55, total = 100): DemoJobEvent => ({
  phase: "running", current, total, message, severity: "info", outputPaths: [],
});

export const handlers: Record<string, (params: Params) => unknown> = {
  "roll_forward.catalog": () => ({ subjects: [
    { code: "A1", name: "现金及银行存款", templateFile: "A1.xlsx" },
    { code: "D1", name: "固定资产", templateFile: "D1.xlsx" },
    { code: "G1", name: "收入", templateFile: "G1.xlsx" },
  ] }),
  "roll_forward.detect_subjects": () => ({
    subjects: ["A1", "D1", "G1"], message: "识别到 3 个可结转科目。",
  }),
  "roll_forward.validate": () => ({ valid: true, message: "运行前检查通过。", rows: [
    { subject: "A1", valid: true, message: "模板与上年底稿均可访问" },
    { subject: "D1", valid: true, message: "模板与上年底稿均可访问" },
    { subject: "G1", valid: true, message: "模板与上年底稿均可访问" },
  ] }),
  "roll_forward.project_export": (params) => ({
    outputPath: String(params.outputPath ?? output("项目.auditproj")), message: "项目已导出。",
  }),
  "roll_forward.cra.parse": () => ({ headerOptions: ["Assessment", "Risk response"], records: [
    { subject_code: "A1", header: "Assessment", original_text: "银行存款存在性风险", revised_text: "银行存款存在性与权利义务风险", match_status: "将写入", source_row: 8 },
    { subject_code: "G1", header: "Risk response", original_text: "收入截止风险", revised_text: "收入截止及可变对价计量风险", match_status: "将写入", source_row: 15 },
  ] }),
};

export const jobHandlers: Record<string, (params: Params) => DemoJobEvent[]> = {
  "roll_forward.process": () => {
    const paths = [output("A1_现金及银行存款_2026.xlsx"), output("D1_固定资产_2026.xlsx")];
    return [
      queued("结转任务已进入队列…", 3),
      running("正在结转 A1 现金及银行存款…", 1, 3),
      running("正在结转 D1 固定资产…", 2, 3),
      { phase: "completed", current: 3, total: 3, message: "结转完成：生成 2 份，1 份需人工处理。", severity: "warning", outputPaths: paths, result: { generated: 2, failed: 1, outputPaths: paths, warnings: ["G1 收入底稿存在受保护工作表，未写入"] } },
    ];
  },
  "roll_forward.process_companies": (params) => {
    const companies = Array.isArray(params.companies) ? params.companies : [];
    const total = Math.max(companies.length, 1);
    const path = output("多公司结转汇总.xlsx");
    return [
      queued("多公司结转任务已进入队列…", total),
      running("正在处理公司底稿…", Math.max(1, total - 1), total),
      { phase: "completed", current: total, total, message: "全部公司处理完成。", severity: "success", outputPaths: [path], result: { generated: total * 3, failed: 0, outputPaths: [path] } },
    ];
  },
};
