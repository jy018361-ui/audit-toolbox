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
- 响应锚点 key：单输出节点为 `output`、筛选 `T`/`F`、输出节点 `sheet:名`/`file:名`；样例每锚点 ≤200 行；十进制序列化为字符串、空值 null。
- 单节点内存上限 100 万行（`MAX_TABLE_ROWS`），超限中文报错等第三期磁盘路径，不静默截断。
- 全量运行目前走同步 engine_call（长任务 job 化、增量重跑属第三期）。

## 第二期：12 节点＋运行到选中（进行中，完成后回填）

关联 J/L/R（多对多组合、空键不匹配、同名后缀、膨胀统计）、纵向合并（差异报告）、去重 U/D、排序、汇总、透视、宽转长、分列、检查 P/NG（五类规则＋容差＋空输入摘要）、手工输入（小表随流程保存）、数据库文件输入（SQLite＋表清单）、Parquet 输入；`uptoNodeId` 只跑所选节点及其上游。

## 第三期（未开工）

长任务 job/worker 化＋进度取消；增量重跑（缓存复用）；磁盘执行路径（千万行）；临时空间管理。
