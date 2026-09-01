# UI 修改记录

这份文件持续记录界面方案、已落地修改和后续决策。新任务在顶部追加，保留旧版本，方便回看为什么这样改。

## 2026-09-01 · 全工具分步向导化与文件名显示统一 v1

### 目标

- 把存贷利息、汇兑损益、账表核对、FA 系列等复杂工具统一改造成分步向导流程，降低单屏信息密度。
- 文件选择处一律只显示文件名，完整路径保留在状态中供读取、导出和打开使用。
- 映射面板等跨页面公共区域的样式收敛统一。

### 用户反馈

- 长路径撑爆文件输入框、多区块平铺导致主次不清。

### 设计决策

- 先在 `artifacts/fx-ui-redesign/` 做三个方向的高保真原型（引导式 guide / 工作台 workbench / 清单式 checklist），对比后按引导式分步方向落地，另附存贷利息优化稿与 1440px 截图。
- 新增 `src/fileDisplay.ts`（含测试）统一处理 Windows/POSIX 路径与末尾分隔符，`FileInput`、`FileDropInput`、`ResultView` 及各页面直接复用。
- 步骤条复用既有 `StepIndicator` 组件，不另造导航体系。

### 已修改

- `DepositInterestPage` / `LoanInterestPage` / `FxAuditPage` / `TbjeCheckPage` / `FaTbJePage` / `FaListPage` / `FaDepCalcPage` / `FaPolicyComparePage` / `FileListDirectoryPage` / `PdfToExcelPage` / `RollForwardPage` / `TsManagerParityPage` / `ConfirmationProgressPage` 等改造成分步向导布局。
- `FileInput` / `FileDropInput` / `ResultView` 及各页面文件回显改为仅文件名。
- `styles.css`、`loan-interest.css`、`deposit-interest.css`、`fx-audit.css`、`tbje-check.css`、`kanzhang-parity.css` 同步调整分步布局与映射面板公共样式。

### 待确认

- 勾稽引擎侧同步落地科目匹配策略（`AccountMatchPolicy`：仅编码真实一对多才判歧义、TB 借贷分列余额按勾稽等式定符号），详见对应测试。

## 2026-08-31 · 设置页软件更新面板 v1

### 目标

- 把更新面板收成一个容易扫读的单任务区域。
- 下载时让进度成为视觉焦点，更新说明退到第二层级。
- 保留现有青灰主题和组件体系，不另造配色或装饰。

### 方案

1. 顶部：小标签「软件更新」+ 目标版本 + 当前版本路径。
2. 状态区：独立浅色底，安装时显示百分比和进度条。
3. 内容区：更新说明按版本排列；警告单独显示。
4. 技术提交：默认折叠，仅在需要排查时展开。
5. 操作区：底部分隔，保留「重新检查」和唯一主操作。

### 已落地

- 更新面板增加状态徽标，明确区分检查、可安装、安装中和已是最新。
- 下载事件驱动真实进度条；未知总大小时使用不定进度动画。
- 提交记录改为可展开区域，降低默认信息密度。
- 操作区从正文中分离，主次按钮关系更清楚。

### 后续修改模板

每次新增任务按下面格式追加：

```text
## YYYY-MM-DD · 页面/模块 vN
目标：
用户反馈：
设计决策：
已修改：
待确认：
```
