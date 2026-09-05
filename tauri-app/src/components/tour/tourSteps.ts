import type { ToolManifest } from "../../types";
import type { TourStep } from "./BeginnerTour";

/**
 * 引导剧本。目标元素统一用 data-tour 属性挂点（App.tsx 侧边栏 / 工作台、
 * PageHeader、StepIndicator），避免依赖会被重构的样式类名。
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
    id: "done",
    title: "引导完成，开工！",
    body: "回到工作台挑一个工具试试吧。使用中有任何疑问，「历史记录」和「设置」永远是你的后盾。",
  },
];

/** 工具通用上手引导：第一次进入某个工具时自动播放。 */
export function buildToolTourSteps(tool: ToolManifest): TourStep[] {
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
      body: "操作从左到右分步进行：当前步骤高亮，完成过的步骤会打勾。点击可用的步骤，可以在已完成环节之间来回切换。",
    },
    {
      id: "tool-done",
      title: "可以开始了",
      body: "从第一步开始操作吧。想再看一次引导，到「设置 → 新手模式」重播即可。",
    },
  ];
}
