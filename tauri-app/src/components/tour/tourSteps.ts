import type { ToolManifest } from "../../types";
import type { TourStep } from "./BeginnerTour";
import { TOOL_TOUR_SCRIPTS } from "./toolTourContent";

/**
 * 引导剧本。目标元素统一用 data-tour 属性挂点（App.tsx 侧边栏 / 工作台、
 * PageHeader、StepIndicator、FileDropInput 等），避免依赖会被重构的样式类名。
 */

/** 工作台总览导览：首次启动自动播放，也可随时重播。全程停在工作台一页。 */
export const workspaceTourSteps: TourStep[] = [
  {
    id: "welcome",
    title: "欢迎使用 E点通工具箱",
    body: "接下来用大约 1 分钟带你认识界面。引导过程中随时可以点「跳过引导」或按 Esc 退出，之后能在「设置 → 新手模式」里重新观看。",
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
    body: "全部工具按「审计工具 / 效率工具 / 运营工具」分组排列，点击工具名称即可打开；带「试用」标记的工具功能已可使用，仍在继续完善。",
  },
  {
    id: "tool-cards",
    targetSelector: '[data-tour="dashboard-tool-groups"]',
    title: "工具卡片",
    body: "工作台按同样的分组铺开工具卡片，点击任意卡片就能进入对应工具。",
  },
  {
    id: "recent-tools",
    targetSelector: '[data-tour="recent-tools"]',
    optional: true,
    title: "最近使用",
    body: "刚用过的工具会出现在这里，方便接着上次的进度继续干。",
  },
  {
    id: "nav-history",
    targetSelector: '[data-tour="nav-history"]',
    title: "历史记录",
    body: "每个任务的状态、时间和输出文件位置都会留档，随时可以回看结果或恢复现场。",
  },
  {
    id: "nav-settings",
    targetSelector: '[data-tour="nav-settings"]',
    title: "设置",
    body: "界面主题、AI 与 OCR 配置、本地缓存清理都在这里；本引导也能在「设置 → 新手模式」里重新播放。",
  },
  {
    id: "newbie-toggle",
    targetSelector: '[data-tour="newbie-toggle"]',
    title: "新手模式",
    body: "侧边栏最底下的这个小开关管着全部分步引导：开启时，首次使用工具会有动画提示；不需要时随手关掉，重启后也保持你的选择。",
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
      title: `初识「${tool.name}」`,
      body: `${tool.description}。跟着下面的提示快速熟悉一下，以后进入本工具不会再自动弹出。`,
    },
    {
      id: "tool-header",
      targetSelector: '[data-tour="page-header"]',
      title: "工具页头",
      body: "这里显示工具名称和说明，部分工具会把常用操作放在右侧。",
    },
    {
      id: "tool-steps",
      targetSelector: '[data-tour="step-indicator"]',
      optional: true,
      title: "步骤条",
      body: "操作从左到右分步进行：当前步骤高亮，完成过的步骤会打勾。之后每切换一步，步骤条下方都会弹出这一步的提示；点击可用的步骤也可以在已完成环节之间来回切换。",
    },
    {
      id: "tool-done",
      title: "可以开始了",
      body: "从第一步开始操作吧。想再看一次引导，到「设置 → 新手模式」重播即可。",
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
  const steps: TourStep[] = [
    {
      id: "purpose",
      // 锚定页头：工具名称与说明就在那里，讲"是做什么的"时锁定它，
      // 避免整步只有一张全局居中卡片。
      targetSelector: '[data-tour="page-header"]',
      title: `「${tool.name}」是做什么的`,
      body: script.purpose,
    },
  ];
  if (script.mode) {
    // 有多种导入/测算模式的工具：进页先讲"选哪个、什么时候用"，
    // 聚光页面上的模式切换区；页面没有该挂点时整步自动跳过。
    steps.push({
      id: "mode",
      targetSelector: '[data-tour="tool-mode"]',
      optional: true,
      title: "先选对模式",
      body: script.mode,
    });
  }
  if (script.prepareTargeted) {
    steps.push({
      id: "prepare",
      targetSelector: '[data-tour="tool-upload"]',
      title: "要准备什么",
      body: script.prepare,
    });
  } else {
    steps.push({ id: "prepare", title: "要准备什么", body: script.prepare });
  }
  if (script.flow) {
    steps.push({
      id: "flow",
      targetSelector: '[data-tour="step-indicator"]',
      optional: true,
      title: "操作流程",
      body: script.flow,
    });
  }
  steps.push({
    id: "result",
    // 收尾同样锚定页头（产出物没有固定挂点）：引导里不再出现全局卡片，
    // 个别页面没有页头时退化为居中卡片兜底。
    targetSelector: '[data-tour="page-header"]',
    title: "做完你会得到什么",
    body: script.result,
  });
  return steps;
}
