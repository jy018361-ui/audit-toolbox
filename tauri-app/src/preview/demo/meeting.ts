// 仅显式浏览器演示模式使用；以下会议与正文均为合成示例。
import type { DemoHandler } from "../demoRegistry";

const content = `# 季度审计项目协调会（按内容）

## 一、会议信息
本示例为界面演示，会议时间与参会人未提及。

## 二、讨论要点
### 底稿准备与复核
说话人1介绍底稿准备进度；说话人2补充资料缺口及后续复核安排。同一议题的讨论合并展示，便于快速回顾。

### 资料交付
需要进一步核对已收到的台账和支持性文件，缺失材料应集中汇总。

## 三、会议结论
先整理资料缺口，再确定后续复核计划。

## 四、后续事项
| 类型 | 事项 | 责任人 | 截止时间 | 交付结果 |
| --- | --- | --- | --- | --- |
| 待办 | 整理资料缺口 | 说话人1 | 未提及 | 缺口清单 |
| 待确认 | 确认复核时间 | 未提及 | 未提及 | 复核安排 |
`;

export const handlers: Record<string, DemoHandler> = {
  "meeting.history_list": () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    return [
      {
        id: "demo-review",
        jobId: "demo-review-job",
        title: "演示：季度审计项目协调会",
        startedAt: today.toISOString(),
        timeLabel: "生成时间",
        status: "completed",
        message: "两个版本已生成",
      },
      {
        id: "demo-partial",
        jobId: "demo-partial-job",
        title: "演示：存货盘点准备沟通",
        startedAt: yesterday.toISOString(),
        timeLabel: "导入时间",
        status: "partial",
        message: "按时间版生成失败，按内容版可阅读",
      },
      {
        id: "demo-failed",
        jobId: "demo-failed-job",
        title: "演示：资料交付讨论",
        startedAt: new Date(today.getTime() - 3 * 86400000).toISOString(),
        timeLabel: "导入时间",
        status: "failed",
        message: "转写服务暂时不可用，原录音已保留",
      },
    ];
  },
  "meeting.history_get": ({ id }) =>
    id === "demo-failed"
      ? { audioPath: "C:/演示数据/资料交付.wav" }
      : {
          title:
            id === "demo-partial" ? "存货盘点准备沟通" : "季度审计项目协调会",
          transcriptPath: "C:/演示数据/原始转写.txt",
          minutesVersions: [
            {
              kind: "content",
              label: "按内容",
              minutesMarkdown: content,
              minutesPath: "C:/演示数据/按内容.md",
            },
            id === "demo-partial"
              ? {
                  kind: "timeline",
                  label: "按时间",
                  minutesError: "演示：服务响应超时，可从转写稿重新生成。",
                }
              : {
                  kind: "timeline",
                  label: "按时间",
                  minutesMarkdown:
                    "# 季度审计项目协调会（按时间）\n\n## 第一阶段：资料准备\n说话人1介绍台账与支持文件的准备情况。\n\n## 第二阶段：复核安排\n说话人2提出先汇总资料缺口，再确认复核时间。",
                  minutesPath: "C:/演示数据/按时间.md",
                },
          ],
        },
  "meeting.read_transcript": () =>
    "[00:00] 本文是界面演示用的合成转写。\n[00:08] 说话人1：我们先核对底稿和台账准备情况。\n[00:25] 说话人2：资料缺口整理后，再确认复核时间。",
};
