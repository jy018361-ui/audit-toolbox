import type { ToolManifest } from "../../types";
import type { TourStep } from "./BeginnerTour";
import { TOOL_TOUR_SCRIPTS } from "./toolTourContent";
import { TOUR_COPY, formatTourText } from "./tourCopy";

/**
 * 引导剧本。目标元素统一用 data-tour 属性挂点（App.tsx 侧边栏 / 工作台、
 * PageHeader、StepIndicator、FileDropInput 等），避免依赖会被重构的样式类名。
 */

/** 工作台总览导览：首次启动自动播放，也可随时重播。全程停在工作台一页。 */
export const workspaceTourSteps: TourStep[] = [
  {
    id: "welcome",
    title: "欢迎使用 E点通工具箱",
    body: "接下来用大约 1 分钟带你认识界面。引导过程中随时可以点「跳过引导」或按 Esc 退出；工作台右上角的「新手引导」可随时重播。",
  },
  {
    id: "sidebar-nav",
    targetSelector: '[data-tour="sidebar-nav"]',
    title: "主导航",
    body: "工作台、历史记录、设置三个常用入口固定在左上角，任何时候都能一键切换。",
  },
  {
    id: "sidebar-tools",
    targetSelector: '[data-tour="sidebar-tools"]',
    title: "工具目录",
    body: "全部工具按「审计工具 / 效率工具 / 运营工具」分组排列，点击工具名称即可打开；带「试用」或「即将上线」标记的工具功能已可使用，仍在继续完善。",
  },
  {
    id: "tool-cards",
    targetSelector: '[data-tour="dashboard-tool-groups"]',
    title: "工具卡片",
    body: "工作台按同样的分组铺开工具卡片，点击任意卡片就能进入对应工具。",
  },
  {
    id: "table-tips",
    title: "表格小技巧",
    body: "带列宽调整手柄的数据表支持拖动列边界、双击边界贴合内容、右键重置列宽。接入此功能的表格会在本机记住列宽，下次打开可继续使用。",
  },
  {
    id: "nav-history",
    targetSelector: '[data-tour="nav-history"]',
    title: "历史记录",
    body: "已登记任务的状态、时间和输出文件位置可在这里查询；有输出时可以打开结果，支持恢复的任务可点「继续任务」回填输入，修改后需重新运行。",
  },
  {
    id: "nav-settings",
    targetSelector: '[data-tour="nav-settings"]',
    title: "设置",
    body: "界面主题、AI、OCR、语音转写和本地缓存清理都在这里。需要重播界面总览时，回到工作台点击右上角「新手引导」。",
  },
  {
    id: "newbie-toggle",
    targetSelector: '[data-tour="newbie-toggle"]',
    title: "新手模式",
    body: "侧边栏顶部的开关控制自动提示：开启时，每次进入工具都会播放导览，适用的步骤切换和任务完成也会有提示；关闭后停止自动提示，重启后保持你的选择。",
  },
  {
    id: "done",
    title: "引导完成，开工！",
    body: "回到工作台挑一个工具试试吧。使用中有任何疑问，「历史记录」和「设置」永远是你的后盾。",
  },
];

/** 工具通用上手引导：没有任何针对性剧本时的兜底（新工具接入前的过渡）。 */
function genericToolTourSteps(tool: ToolManifest): TourStep[] {
  return [
    {
      id: "tool-welcome",
      title: formatTourText(TOUR_COPY.genericWelcomeTitle, { toolName: tool.name }),
      body: formatTourText(TOUR_COPY.genericWelcome, { description: tool.description }),
    },
    {
      id: "tool-header",
      targetSelector: '[data-tour="page-header"]',
      title: TOUR_COPY.genericHeaderTitle,
      body: TOUR_COPY.genericHeader,
    },
    {
      id: "tool-steps",
      targetSelector: '[data-tour="step-indicator"]',
      optional: true,
      title: TOUR_COPY.genericStepsTitle,
      body: TOUR_COPY.genericSteps,
    },
    {
      id: "tool-done",
      title: TOUR_COPY.genericDoneTitle,
      body: TOUR_COPY.genericDone,
    },
  ];
}

/**
 * 工具进页导览：优先用 toolTourContent.ts 里逐工具编写的针对性剧本
 * （讲清楚用途、要传什么文件、流程、产出），没有剧本的工具回落到通用模板。
 */
export function buildToolTourSteps(tool: ToolManifest): TourStep[] {
  const script = TOOL_TOUR_SCRIPTS[tool.id];
  if (!script) return genericToolTourSteps(tool);
  const steps: TourStep[] = [];
  // purpose 可省略（如 audipick：用途一目了然，不必再讲一遍），
  // 省略时导览直接从"要准备什么"讲起。
  if (script.purpose) {
    steps.push({
      id: "purpose",
      // 锚定页头：工具名称与说明就在那里，讲"是做什么的"时锁定它，
      // 避免整步只有一张全局居中卡片。
      targetSelector: '[data-tour="page-header"]',
      title: formatTourText(TOUR_COPY.purposeTitle, { toolName: tool.name }),
      body: script.purpose,
    });
  }
  if (script.mode) {
    // 有多种导入/测算模式的工具：进页先讲"选哪个、什么时候用"，
    // 聚光页面上的模式切换区；页面没有该挂点时整步自动跳过。
    steps.push({
      id: "mode",
      targetSelector: '[data-tour="tool-mode"]',
      optional: true,
      title: TOUR_COPY.modeTitle,
      body: script.mode,
    });
  }
  if (script.prepareTargeted) {
    steps.push({
      id: "prepare",
      targetSelector: '[data-tour="tool-upload"]',
      title: TOUR_COPY.prepareTitle,
      body: script.prepare,
    });
  } else {
    steps.push({ id: "prepare", title: TOUR_COPY.prepareTitle, body: script.prepare });
  }
  if (script.flow) {
    steps.push({
      id: "flow",
      targetSelector: '[data-tour="step-indicator"]',
      optional: true,
      title: TOUR_COPY.flowTitle,
      body: script.flow,
    });
  }
  steps.push({
    id: "result",
    // 收尾同样锚定页头（产出物没有固定挂点）：引导里不再出现全局卡片，
    // 个别页面没有页头时退化为居中卡片兜底。
    targetSelector: '[data-tour="page-header"]',
    title: TOUR_COPY.resultTitle,
    body: script.result,
  });
  return steps;
}
