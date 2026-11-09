# 按钮尺寸一致性检查与修复记录

检查与修复日期：2026-10-25。状态：**A01–A18、B01–B02 已修复并通过浏览器尺寸验收。**

## 修复结果

- 页面操作组统一高 40px；看账待选科目工具条统一高 32px。主次操作保留颜色与边框区别，不强制不同长度的按钮等宽。
- 旧 `.actions`、任务行、紧凑操作区、PDF 工具条的按钮规则排除共用 `Button`，组件自行控制内边距、行高和边框，避免页面样式覆盖组件尺寸。
- 正负数凭证标记与 PDF 转 Excel 的开始/停止状态切换保持 40px；AudiPick 关联资料弹窗的取消、保存改用同一套 40px 组件按钮。
- 显式标记操作组尺寸，新增 `scripts/button-size-contract.cjs`，同时接入工作流布局门禁。新增 `npm run audit:layout:buttons`，覆盖两种视口下的步骤切换、禁用、运行、暂停和取消状态。
- 专项验收覆盖 9 个工具、1600×900 与 1000×680 两种视口，共 78 个状态，按钮高度错误为 0。B01 已实际返回导入页测得三个按钮均为 40px；B02 已固定演示任务运行态测得“读取并自动映射”和“停止”均为 40px。原生 Windows 业务任务未在本轮重新执行。
- 修复后测量及截图：[`after/report.json`](ui-audit-20261025/buttons/after/report.json)、[`after/`](ui-audit-20261025/buttons/after/)。AudiPick 弹窗本轮仅完成源码替换及编译测试，不宣称其入口已动态验收。
- 回归验证：`npm run build` 完整通过；`npm test` 全量通过（134 个测试文件，1455 项通过、3 项跳过）。受影响工具的两种视口工作流 200 个快照、全部入口两种视口静态布局 44 例均为 0 失败，报告分别见 [`after-workflows/report.json`](ui-audit-20261025/buttons/after-workflows/report.json) 与 [`after/static-report.json`](ui-audit-20261025/buttons/after/static-report.json)。

以下保留修复前的问题与证据，便于对照。

## 结论

截图中的问题可以复现，而且并非个例：**6 个工具、18 处操作组已动态复现同组按钮 32px / 40px 高度混用；折旧测算另有 1 处源码确认，共用加载区运行态另有 1 处源码确认。** 同一处在初始态、选件后、完成态重复出现，只计一处。

根因主要有两层：页面把主要操作设为默认尺寸、相邻次要操作设为 `sm`；旧的全局 CSS 又覆盖了组件声明的内边距。主要/次要操作可以有颜色和视觉重量的区别，但这不足以解释同一操作行的高度差。

## A. 修复前已动态复现：18 处（现已修复）

以下修复前尺寸均为 Chromium `getBoundingClientRect()` 测得的 CSS 像素；不是从用户截图估算的屏幕像素。当时全部为 **32px 对 40px，差 8px**。

| 编号 | 工具 / 层级 | 较矮按钮（32px） | 较高按钮（40px） | 代码位置 |
| --- | --- | --- | --- | --- |
| A01 | FA List → 两期清单 → 文件与匹配 | 重新读取表格、读表并复核 | 开始匹配 / 重新开始匹配 | `src/FaListPage.tsx:2593` |
| A02 | FA List → 匹配完成后的分流 | 有，进入补充清单 | 没有，直接导出 | `src/FaListPage.tsx:3201` |
| A03 | FA List → 补充清单 | 上一步、无补充清单，跳过 | 应用补充映射并继续 | `src/FaListPage.tsx:2864` |
| A04 | FA List → 导出 | 上一步 | 生成 FA List 底稿 | `src/FaListPage.tsx:3047` |
| A05 | 折旧政策对比 → 选择文件 | 读取表格 + LLM 复核、LLM 重新复核 | 下一步 | `src/FaPolicyComparePage.tsx:955` |
| A06 | 折旧政策对比 → 输出 | 上一步 | 生成折旧政策对比 / 重新生成 | `src/FaPolicyComparePage.tsx:1069` |
| A07 | 看账 → 加载与映射 → 读取后 | 重新进行 LLM 复核 | 下一步：科目筛选 | `src/KanzhangParityPage.tsx:566` |
| A08 | 看账 → 科目筛选 → 待选科目操作 | 全选当前结果、清除选择、加入下一批次、加入剔除/例外 | 加入目标批次 | `src/KanzhangParityPage.tsx:584` |
| A09 | 看账 → 科目筛选 → 页底 | 返回映射、筛选预览 | 下一步：透视与导出 | `src/KanzhangParityPage.tsx:589` |
| A10 | 看账 → 透视与导出 → 页底 | 返回筛选 | 导出结果 | `src/KanzhangParityPage.tsx:591` |
| A11 | TS 管理 → 加载 | 加载文件 | 下一步：条件筛选 | `src/TsManagerParityPage.tsx:700` |
| A12 | TS 管理 → 条件筛选 | 清除全部筛选、上一步 | 下一步：导出 | `src/TsManagerParityPage.tsx:758` |
| A13 | TS 管理 → 导出 | 上一步 | 导出默认双 Sheet | `src/TsManagerParityPage.tsx:806` |
| A14 | 函证进度小能手 → 导入与检查 | 检查数据 | 下一步：报告范围 | `src/ConfirmationProgressPage.tsx:427` |
| A15 | 函证进度小能手 → 报告范围 | 上一步 | 下一步：生成报告 | `src/ConfirmationProgressPage.tsx:475` |
| A16 | 函证进度小能手 → 生成报告 → 首次生成前 | 上一步 | 生成进度报告 | `src/ConfirmationProgressPage.tsx:509` |
| A17 | 文件夹超链接清单 → 扫描 | 重新扫描 | 下一步：输出文件 | `src/FileListDirectoryPage.tsx:325` |
| A18 | 文件夹超链接清单 → 输出 | 上一步 | 生成文件清单 | `src/FileListDirectoryPage.tsx:360` |

截图证据位于 [`ui-audit-20261025/buttons/shots/`](ui-audit-20261025/buttons/shots/)。按操作组对应：

- A01–A02：`fa_list-cards-step1-state.png`，同时有 1000px 窄屏版本。
- A03：`fa_list-cards-supplement.png`；A04：`fa_list-cards-export.png`。
- A05：`fa_policy_compare-files-selected.png`；A06：`fa_policy_compare-step2-state.png`。
- A07：`kanzhang-step1-state.png`；A08–A09：`kanzhang-step2-state.png`；A10：`kanzhang-step6-state.png`。
- A11–A13：`ts_manager-initial.png`、`ts_manager-step2-state.png`、`ts_manager-step3-state.png`。
- A14–A16：`confirmation_progress-initial.png`、`confirmation_progress-step2-state.png`、`confirmation_progress-step3-state.png`。
- A17–A18：`file_list_directory-initial.png`、`file_list_directory-step2-state.png`。

## B. 原源码确认项：2 处（现已修复并补动态验收）

| 编号 | 工具 / 层级 | 问题 | 代码位置与覆盖范围 |
| --- | --- | --- | --- |
| B01 | 折旧测算 → 已读取后返回导入页 | “重新复核映射”显式 `sm`；“下一步：核对映射”“重新读取表格”为默认尺寸。声明为 32px / 40px | `src/FaDepCalcPage.tsx:612`。正常导入后会自动跳到映射页；本轮返回导入页的自动点击超时，因此没有将此项写成动态复现 |
| B02 | 共用凭证加载区 → 运行中 | “读取并自动映射”默认尺寸；`busy && job && onCancel` 时追加的“停止”为 `sm`，两者同时渲染 | `src/components/LedgerSourceCard.tsx:42`。影响看账和正负数凭证标记；演示任务较快，本轮没有固定采到这一短暂状态 |

## C. 修复前的共用样式问题（现已处理）

`src/styles.css:772` 的 `.actions button, .task-row button` 对所有后代按钮设置 `padding: 8px 16px`。实测 A01 的 `sm` 按钮虽然仍高 32px，内边距已是 `8px 16px`，而组件 `sm` 原本声明的是水平 12px。这些不在 Tailwind 层中的旧规则，优先于组件所在的工具类层；只改页面 `size` 不能完成尺寸规则收口。

相关位置：

- `src/components/ui/button.tsx:28`：默认 40px、`sm` 32px、`xs` 28px、`icon-xs` 24px 的组件尺寸定义。
- `src/styles.css:241`：所有原生按钮的统一字号和行高规则，同样会影响组件工具类。
- `src/styles.css:772`：操作区与任务行按钮的通用内边距。
- `src/styles.css:1432`：紧凑操作区再次改写字号与内边距。
- `src/kanzhang-parity.css:95`、`:116`：卡片内原生按钮的通用规则，会影响文件名按钮。

已让旧规则只作用于仍使用旧样式的按钮，保留 `Button` 组件对自身尺寸的控制，并修复 A、B 两表的具体调用点。

## D. 修复前候选项（不计入 A、B 数量）

| 候选 | 实测 / 源码情况 | 判断 |
| --- | --- | --- |
| Excel 合并 → 文件队列的上移 / 下移 / 移除 | 箭头为 24px × 24px 的 `icon-xs`，“移除”为 32px；`src/ExcelMergerPage.tsx:512` | 图标和文字按钮可以有不同宽度。若统一行内命中区，可把箭头也设为 32px；不直接判成 A 类缺陷 |
| 看账、正负数凭证标记 → 已选文件槽 | 文件名按钮 38px，“清空”32px；截图 `kanzhang-files-selected.png`、`je_sign_mark-files-selected.png` | 文件名与操作按钮角色不同，但共用 `FileDropInput` 在卡片内受旧 CSS 影响，建议复查槽位的纵向对齐；位置 `src/components/FileDropInput.tsx:128` |
| 借款、存款 → 已识别文件行 | 文件名链接 22px，“移除 / 更正”为 32px；见 `loan_tb-step1-uploaded.png`、`deposit_interest-files-selected.png` | 文件名有明确链接语义，不宜为追求等高而强制改成普通操作按钮 |
| PDF、正负数标记等 → 开始 / 取消状态切换 | 默认尺寸的开始按钮，被 `sm` 的取消 / 停止按钮替换 | 不是同时出现的相邻按钮，因此不计入 A 类；修复时建议保持同一任务位置的外框高度稳定 |
| AudiPick → 关联资料弹窗 | 原生 `.ghost`“取消”和 `.primary min-h-10`“保存关联”混用，可能为 38px / 40px | `src/AudiPickAssociationDialog.tsx:93`；仅源码候选，待功能入口可访问后动态测量 |
| 模糊匹配 → 候选卡与拒绝按钮 | 候选卡因多行内容高 70–96px，拒绝按钮 38px | 属于卡片和动作按钮的角色差异，剔除自动检测误报 |

按钮文字长短导致的自然宽度差异、文件上传热区、导航步骤条、关闭图标和普通按钮之间的尺寸差异，均不算作同组普通按钮尺寸缺陷。

## 修复与验收口径

1. 页面主要操作行：建议统一高 40px，主次通过颜色、边框和字重区分；同组高度差不超过 1 CSS px。
2. 表格行内操作和紧凑工具条：统一高 32px；需要图标按钮时保持相同的命中区高度，宽度可独立。
3. 不要求不同字数的按钮等宽；“保存 / 取消”等确需等宽的组合单独约定。
4. 加载、禁用、暂停、停止、完成、重新生成状态都要检查；不要只验初始页。
5. 修复后重拍 A01–A18，并补 B01 返回导入页、B02 运行中两个场景；至少复核 1600px 和 1000px 视口。
6. 给现有几何验收增加“已约定操作组的按钮高度一致”检查。不要对页面所有相邻按钮一刀切，否则会把上传热区和候选卡误判。

## 原始检查覆盖与边界

- 固定预览构建采集 110 个状态，覆盖工具清单全部入口、工作台 / 历史 / 设置；主视口 1600×900，并抽查关键页 1000×680。补查采集 15 个状态（与主采集有重复，不作为 125 个唯一场景）。
- 原始测量：[`measurements-stable.json`](ui-audit-20261025/buttons/measurements-stable.json)、[`measurements-extra.json`](ui-audit-20261025/buttons/measurements-extra.json)。包含按钮文字、尺寸、计算样式、所在容器和状态。
- 全部非测试 TSX 的组件调用与混用容器另作源码排查：[`source-buttons.json`](ui-audit-20261025/buttons/source-buttons.json)、[`source-mixed-groups.json`](ui-audit-20261025/buttons/source-mixed-groups.json)。源码候选不等于确认缺陷，68 组候选已按用途筛选。
- 已测状态内，TBJE、汇兑、借款、存款、WP 服务单、PDF、会议纪要的普通同组操作未发现新的 A 类问题；这不代表未触发的所有分支都已验收。
- AudiPick、WP Roll Forward 当前入口存在待上线限制，未完成其内部流程动态验收。共用确认框、同步等待窗、任务弹窗、新手引导、汇率缺失对话框做了源码尺寸检查；开发夹具本轮未能稳定挂载，不宣称弹窗全量动态通过。
- 检查期间共享工作区有其他修改，源码行号可能后续移动；请同时按按钮文字定位。固定预览快照避免后续热更新污染主测量。
- 初次排查时 `npm run build` 被 FA 补充清单类型错误阻断；该错误已由工作区其他修改修复，本次按钮修复后完整 `npm run build` 已通过。
- 本次修复已同步 `UI_CHANGELOG.md`，未打包发布 EXE。

辅助检查依据：[Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)。本清单的尺寸一致性判断主要依据用户提出的同组按钮要求与实际 DOM 测量，不把通用指南当作强制等宽规则。
