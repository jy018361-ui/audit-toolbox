# 看账大 CSV 低内存验收与发布准备

## 验收边界

本验收使用完全合成的数据，不读取、不复制客户文件。目标是证明同一组凭证分别走普通内存路径和超过
256 MiB 的磁盘路径时，明细、分片、套表结果一致，并证明 worker 在验收脚本的独立 Job Object 内运行。
它不能替代真实 6 GB 文件的最终验收，也不能证明所有旧 Python 行为均已保留。

可运行脚本为 `scripts/verify_kanzhang_disk.py`。默认依次覆盖四种金额口径：

- 借贷分列，正数借贷；
- 借贷分列，原始值带符号；
- 单金额列加借贷方向；
- 单金额列自身带符号。

每种口径都包含跨大文件读取批次的完整凭证、多公司复用同一凭证号、期间加凭证号的多 ID、映射字段
前向填充、红字、损益结转、两个目标批次、CSV 明细三行一片以及套表。大文件通过给不命中目标的合成
行增加填充列达到 272 MiB；命中凭证本身与小文件一致，不使用前端参数或测试后门强制切换路径。

## 动态内存预算验收

生产策略由 `resource_budget::plan(total_bytes, available_bytes, commit_available_bytes)` 唯一计算，脚本不复制
算法，以免验收实现与生产实现同时写错。系统预留为总内存的 20%，最少 1 GiB、最多 8 GiB；worker
预算取总内存 25%、扣除预留后的当前可用内存 75%、扣除预留后的提交余量 75% 三者的最小值。
预算不足 256 MiB 时拒绝启动。大文件分流阈值仍固定为 256 MiB，主机内存多时增加 worker、批次和
SQLite 页缓存预算，不会把 6 GB CSV 改回整表加载。

`resource_budget::tests::adaptive_budget_scales_with_host_memory` 应覆盖可用内存为总量 75%、提交余量充足时：

| 主机总内存 | 系统预留 | worker 上限 | 批次上限 |
| ---: | ---: | ---: | ---: |
| 8 GiB | 1.6 GiB | 2 GiB | 128 MiB |
| 16 GiB | 3.2 GiB | 4 GiB | 128 MiB |
| 24 GiB | 4.8 GiB | 6 GiB | 128 MiB |
| 32 GiB | 6.4 GiB | 8 GiB | 128 MiB |
| 64 GiB | 8 GiB | 16 GiB | 128 MiB |

`resource_budget::tests::adaptive_budget_respects_busy_hosts_and_commit_pressure` 应另行锁住：32 GiB 主机只剩
8 GiB 可用时 worker 降至 1.2 GiB；提交余量只剩 8 GiB 时得到相同结果；16 GiB 主机只剩 1 GiB
可用、64 GiB 主机只剩 1 GiB 提交余量时均返回零预算，调用端必须以中文错误拒绝任务。

## 执行方法

先运行不创建大文件的脚本自检：

```powershell
python scripts/verify_kanzhang_disk.py --self-test
```

业务代码合并后，先由 Rust 纯函数测试验证内存矩阵，再使用当前构建出的 worker EXE 做一组受限验收：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml resource_budget::tests::adaptive_ -- --test-threads=1
python scripts/verify_kanzhang_disk.py --exe <待验收EXE> --out build/kanzhang-disk-acceptance-b --cases b_positive
```

单组通过后再运行全部四组。输出目录必须不存在；脚本会在启动前检查空间，并将事件、stderr、资源采样和
最终 `report.json` 留在该目录。默认每个 worker 最长 900 秒，可用 `--timeout` 在 1 至 1800 秒间调整。
脚本默认只删除 worker 为本次新建合成输入明确返回的缓存文件，不递归清理应用缓存目录；需要保留缓存
排查复用行为时加 `--keep-cache`。

```powershell
python scripts/verify_kanzhang_disk.py --exe <待验收EXE> --out build/kanzhang-disk-acceptance-all
```

通过条件：inspect 的小文件 `lowMemory=false`、大文件 `lowMemory=true`；两条路径的输出文件集合、CSV
逐行值与顺序、XLSX 可见业务页非空单元格一致；存在明细分片与套表；两个批次合计 12 行；跨批次对方分录、红字、
前向填充和损益结转标记均满足独立断言。脚本采样峰值是 0.2 秒间隔观测值，不应表述成操作系统精确峰值。

普通路径的隐藏 `_targets` 页包含“原值＋归一化值”两列，磁盘路径当前只保存目标原值。脚本不把这一
内部结构差异伪装成逐格等价，而是分别断言两个磁盘套表包含对应批次的目标科目。磁盘套表采用恒定内存
写出，目前也不宣称列宽、合并单元格、条件格式等版式细节与普通路径完全相同。

完成合成验收后，再对用户的 6.41 GB 文件做一次受限验收。先只跑 inspect，确认电脑可操作、预算和
缓存复用；再由用户选择的少量目标科目完成明细及套表导出，核对行数、金额、损益结转与两批输出。

## 发布门禁

当前四处版本均为 `2.0.0-alpha.47`，本次准备不修改版本。正式发布时必须把新版本同步到：

- `package.json`；
- `src-tauri/Cargo.toml`；
- `src-tauri/tauri.conf.json`；
- `scripts/build_tauri_release.py` 顶部 `VERSION`。

发布必须走项目脚本，不能直接分发 `cargo build --release` 产物。代码、前端、Rust 测试及上述验收均通过
后执行：

```powershell
python scripts/build_tauri_release.py
```

脚本会运行发布 EXE 自身的 worker 冷启动验收，并检查不产生 `audit-engine.exe` 子进程或新增 Python
runtime。若只复验已经存在且版本完全匹配的 runtime 产物，可执行：

```powershell
python scripts/build_tauri_release.py --smoke-only
```

目前 `dist/` 没有 `2.0.0-alpha.47` 的 runtime 或安装包，因此现在不能执行该版本的 `--smoke-only`，
也不能把已有旧版本产物当成本次改造的发布验收结果。
