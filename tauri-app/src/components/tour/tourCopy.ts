/** 新手引导的固定文案。界面与 Excel 清单共用，动态内容用具名占位符。 */
export const TOUR_COPY = {
  skip: "跳过引导",
  previous: "上一步",
  next: "下一步",
  finish: "完成",
  stepCount: "第 {current} 步 · 共 {total} 步",
  dialogLabel: "新手引导：{title}",
  closeSymbol: "×",
  closeStepHint: "关闭本步提示",
  closeSuccess: "关闭完成提示",
  fallbackHint: "按页面提示完成当前操作，再使用页面上的按钮继续；步骤条中可点击的步骤支持返回修改。",
  fallbackLastHint: "按页面提示完成测算或导出，再查看结果；修改输入后请重新运行，确保结果与当前设置一致。",
  toggleLabel: "新手模式",
  workspaceReplayLabel: "新手引导",
  toggleTitle: "开启时，每次进入工具都会播放引导，并显示适用的步骤提示与完成提示；关闭后停止自动提示。工作台右上角可重播新手引导。",
  success: "{toolName}已完成",
  openResult: "打开结果",
  returnWorkspace: "返回工作台",
  openError: "无法打开结果文件。文件可能已移动或删除，请在历史记录中确认输出位置。",
  purposeTitle: "「{toolName}」是做什么的",
  modeTitle: "先选对模式",
  prepareTitle: "要准备什么",
  flowTitle: "操作流程",
  resultTitle: "做完你会得到什么",
  genericWelcomeTitle: "初识「{toolName}」",
  genericWelcome: "{description}。跟着下面的提示快速熟悉操作；新手模式开启时，每次进入工具都会播放引导。",
  genericHeaderTitle: "工具页头",
  genericHeader: "这里显示工具名称和说明，部分工具会把常用操作放在右侧。",
  genericStepsTitle: "步骤条",
  genericSteps: "步骤条显示当前环节。部分工具可点击步骤切换，部分只显示进度，请按页面按钮操作；适用的环节切换后会显示步骤提示。",
  genericDoneTitle: "可以开始了",
  genericDone: "从页面上的第一项操作开始。需要重看本工具引导时，开启侧边栏「新手模式」后重新进入工具；工作台右上角的「新手引导」可重播界面总览。",
} as const;

export function formatTourText(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
