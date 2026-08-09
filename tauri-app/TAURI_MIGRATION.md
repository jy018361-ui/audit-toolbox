# Tauri 迁移状态

当前分支采用 Tauri 2 + React/TypeScript 前端、Rust 安全边界和 Rust 原生任务 worker。九个注册工具的生产 RPC 已全部切换至 Rust；Python 内核源码继续作为迁移金标保留，但不参与应用启动和发布打包。

## 已实现

- 九个注册工具的统一导航、路由、配置表单、任务中心和迁移状态。
- Rust 命令白名单、系统文件选择、受限输出打开、单实例、SQLite、Windows Credential Manager。
- 统一 Rust 命令白名单、任务事件、排队、暂停和协作取消；未知方法不再回退到 Python。
- 文件夹超链接清单：扫描和导出。
- WP 服务单：输入校验和真实生成。
- 函证进度：输入校验和银行/往来真实生成。
- Excel Merger：已停止生产路径中的 Python 调用。Calamine 负责读取，rust_xlsxwriter/CSV 负责流式写出，同一 Tauri EXE 的独立 Rust worker 负责任务隔离；多 Sheet 模式使用 Rust COM 调用 Excel 原样复制。
- TS：共享 Rust Polars 数据层已接入读取、稳定 Parquet 缓存、精确筛选、默认 by经理/by项目双 Sheet 透视和明细 CSV。
- 看账：共享 Rust Polars 数据层已接入读取、自动/人工映射、目标科目扩展完整凭证、剔除科目、全局净额口径、损益结转、JE 直接/跨凭证匹配、宽松/严格凭证类型、多批次和 XLSX 套表导出。
- 发布包已移除 Python sidecar、PyInstaller 构建和运行时释放；冷启动验收确保不产生 `audit-engine.exe` 子进程或新 Python runtime。
- FA List：双文件结构读取和组合键匹配预览。
- Roll Forward：模板校验和现有核心批处理接口。
- AudiPick 旧版迁移备份导出、Tauri 幂等导入及 Hub 全局 LLM 配置桥接。
- 正式 `tauri build --no-bundle` 单文件构建、Rust worker 冷启动检查、无 sidecar 反向检查和发布 SHA-256。

## 仍需真实样例验收

- TS 与看账已脱离 Python Polars；看账高级能力已有合成金标回归，正式等价切换仍需用户使用真实脱敏样例验收高风险口径。
- FA List、AudiPick、Roll Forward 已使用 Rust 生产路由；仍需用户真实脱敏样例覆盖高风险边界后，才能宣告业务金标完全等价。
- Python 基线测试仍会在开发/发布门禁中运行，但其产物不会被嵌入发布 EXE。

## 开发命令

```powershell
npm install
npm run build
npm test
python -m unittest discover -s tests -p "test_*.py"
npm run tauri:dev
```

严格单文件发布使用 `打包Tauri审计工具箱.bat`。发布脚本不会覆盖现有 `dist/审计工具箱.exe`。
当前迁移构建版本为 `2.0.0-alpha.6`；看账已加入复杂凭证类型、JE 两轮匹配、多批次和损益结转的 Rust 实现。TS/看账在取得脱敏真实金标前继续显示为迁移预览，不以合成样例替代正式结果一致性结论。
