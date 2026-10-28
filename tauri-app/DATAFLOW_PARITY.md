# 数据流 DataFlow 验收矩阵（PARITY）

> 本工具为全新工具，无旧 Python 金标；本文是「设计文档条目 → 实现行为 → 验证方式」的验收矩阵，与 `DATAFLOW_DESIGN.md`（需求唯一来源）、`DATAFLOW_NODE_SPECS.md`（节点配置规格）、`DATAFLOW_ACCEPTANCE_FLOWS.md`（三条验收流程与规模场景）配套。
> 约定：不写死测试数量（以运行命令为准）；「已实现」仅指所列行为有对应测试，不代表「已保留全部设计行为」——设计文档中未在下表出现的条目即尚未实现或属后续期次。

## 运行命令

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib dataflow:: -- --test-threads=1   # 引擎全部测试
cargo test --manifest-path src-tauri/Cargo.toml --lib bundled_catalog                  # 工具清单登记
npx vitest run src/dataflow                                                            # 前端工作流模型与页面
npm run build                                                                          # 前端类型检查与构建
python scripts/gen_dataflow_fixtures.py                                                # 重建合成测试数据（固定随机种子）
```

合成测试数据在 `tests/fixtures/DataFlow/`（用途逐文件见其 README：编码/分隔符矩阵、千分位、全角、前导零、18 位流水号、重复凭证号、伪 xls、关联用重复键映射表等）。

## 第一期：8 节点最小闭环（已实现）

| 能力 | 实现行为 | 验证 |
| --- | --- | --- |
| 工作流模型 | JSON 保存/打开往返、参数占位替换（路径与文件名）、连线校验（禁自环/重复/环/输入口占用）、草稿与撤销栈 | `npx vitest run src/dataflow`（model 相关用例） |
| 画布交互 | 节点拖动、锚点连线、平移缩放、删除、状态着色与行数耗时角标、参数确认页 | `DataFlowPageUi.test.tsx` |
| Excel/CSV 输入 | 复用统一读取层：xlsx/xls/xlsm、伪 xls（文本/XML 内容按内容识别）、GBK/UTF-8/BOM/UTF-16 自动识别、分隔符自动、文件夹批量、表头行/起始行、来源列（文件/Sheet/行号） | 引擎 `dataflow::nodes::input` 用例 |
| 类型规则 | 超 15 位整数保底文本、前导零保留、千分位金额解析、列类型锁定、空值/空文本区分 | 引擎 `column_type_inference_follows_section9_rules`、`thousand_separator_leading_zero_and_long_id_rules` 等 |
| 字段选择/清洗 | 勾选保留/重命名/改序、新增字段自动传递；去空格/全半角/不可见字符/替换/删空行 | 引擎 clean/select 用例 |
| 公式 | 定点十进制（0.1+0.2=0.3）、ROUND 中点远离零、IF 短路、空值三值逻辑、除零行级异常、日期函数与 TODAY 固定 | 引擎 `dataflow::formula` 用例 |
| 筛选 | T/F 两路、行数守恒、空值进 F 路 | 引擎 filter 用例 |
| 输出 | 预览不写文件；全量临时文件成功后提交；覆盖三策略（报错/时间戳/覆盖）；xlsx 超量分 Sheet/分文件；csv 编码（GBK 不可表示字符报错）与按行分文件；精度往返校验失败自动按文本写出并警告 | 引擎 `dataflow::nodes::output` 用例 |
| 运行体系 | 预览=每输入前 1000 行；行级异常 stop（默认）/skip 并记录；结构性错误必停且保留已完成节点状态；环/悬空连线中文报错 | 引擎 engine 用例 |
| 路径安全 | lib.rs 注入本会话授权路径，引擎校验输入路径与输出目录（选中目录授权后代、文件仅自身）；流程文件保存走 pickPath("save") 授权后由 dataflow_save_workflow 落盘；打开流程用 HTML 文件选择，不反向授权 | 接线见 lib.rs dataflow 分支；授权门在 `RunContext::ensure_permitted` |
| 工具登记 | tool-catalog 第 21 个工具，效率工具分组 | `bundled_catalog_contains_unique_tools` |

## 契约备忘（前后端对接细节）

- 请求体＝工作流 JSON 本体＋可选 `paramOverrides`（引擎按方法名区分预览/全量；`runMode` 字段冗余可传）；节点类型双别名（`select`/`select_n`、`filter`/`filter_n`）。
- 响应锚点 key：单输出节点为 `output`、筛选 `T`/`F`、输出节点 `sheet:名`/`file:名`；样例每锚点 ≤200 行；十进制序列化为字符串、空值 null。2026-10-28 修复：前端规格/演示数据曾写 `out`，与引擎 `output` 不一致——真实引擎运行时结果区显示「样本数据为空」且连线锚点对不上；已统一为 `output`（nodeSpecs SINGLE_OUT、demoData、Canvas 兜底、测试夹具），并用真实引擎返回形态在浏览器端到端验证表格/行数/状态显示。
- 单节点内存上限 100 万行（`MAX_TABLE_ROWS`），超限中文报错等第三期磁盘路径，不静默截断。
- 全量运行目前走同步 engine_call（长任务 job 化、增量重跑属第三期）。

## 第二期：12 节点＋运行到选中（已实现，待第四期真实流程全量验收）

| 能力 | 实现行为 | 验证 |
| --- | --- | --- |
| 关联 Join | J/L/R 三路；多对多按笛卡尔组合（左3右4=12）不自动挑/不去重；复合键空值不匹配；左右键类型不一致中文提示；同名字段右侧加后缀（默认 _右）；stats 含左右行数、J/L/R、重复键膨胀提示 | 引擎 join 用例（含 fixtures/DataFlow 科目映射表重复键 6602） |
| 纵向合并 Union | 按字段名（并集补空）/按位置；类型冲突统一文本并披露；拼接次序按配置或连线序；差异报告进 stats/messages | 引擎 combine 用例 |
| 去重 Unique | U 保留/D 重复两路；首次出现/最后一次；空值键视为同键 | 引擎 unique 用例 |
| 排序 Sort | 多字段优先级；稳定排序；空值位置逐字段可配 | 引擎 sort 用例 |
| 汇总 Summarize | 分组（空值键归「（空）」组）；求和/总行数/非空计数/去重计数/平均/最小/最大；全整数求和保整数，超 i64 回落十进制 | 引擎 aggregate 用例 |
| 透视/宽转长 | 行/列/值透视，缺失组合填 0 或空值，动态列数上限；宽转长输出 项目/数值 两列 | 引擎 aggregate 用例 |
| 分列 Split | 分隔符/固定宽度；段不足补空、超出并入末段；上限 20 列 | 引擎 split 用例 |
| 检查 Check | 五类规则（借贷平衡按分组+容差、非空、唯一、区间、表达式）；空值从严；重复整组进 NG；通过 P/未通过 NG 附违规原因列；规则执行摘要（空输入不等同通过） | 引擎 check 用例 |
| 手工输入 Manual | 小表随流程文件保存（config 即数据）；列类型转换失败按行级策略 | 引擎 inputs2 用例 |
| 数据库文件输入 DB | SQLite 只读；表清单接口 dataflow_db_tables（授权后中文诊断非 SQLite/加密/损坏）；REAL 按最短十进制文本转定点并披露浮点来源；BLOB 十六进制 | 引擎 inputs2 用例（tempfile 建 SQLite）＋真实用友 NC5 采集库第四期验收 |
| Parquet 输入 | polars 读取，类型映射，浮点与日期时间转换方式入 stats | 引擎 inputs2 用例 |
| 运行到选中节点 | 请求 uptoNodeId：只执行该节点及其上游反向闭包，未执行节点不出现在响应 | 引擎 engine 用例 |
| 前端 12 节点 | 菜单全部解锁；多锚点（J/L/R、U/D、P/NG）连线与角标；12 种配置表单（含手工小表编辑器、db 表下拉）；「运行到选中节点」按钮 | `npx vitest run src/dataflow`（ConfigPanel.test.tsx 等） |

第二期已知边界：引擎与前端由两个会话并行开发、其中途断点由集成会话修复（编译错误 16 处、db 表清单返回形状、请求格式对齐）；全部节点仍受 100 万行内存上限约束。

## 第三期（未开工）

长任务 job/worker 化＋进度取消；增量重跑（缓存复用）；磁盘执行路径（千万行）；临时空间管理。
