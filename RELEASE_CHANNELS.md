# 正式版与开发版发布

同一仓库使用两个自动更新通道，Release 列表仍然共享。现有正式版无需重新安装。

| 项目 | 正式通道 | 开发通道 |
|---|---|---|
| 分支 | `main` | `dev` |
| 标签 | `v2.0.0-alpha.132` 或 `v2.0.0` 等 | `v2.0.0-dev.1`、`v2.0.0-dev.2` 等 |
| GitHub 发布 | 普通 Release，设为 Latest | Pre-release，永不设为 Latest |
| 更新入口 | `releases/latest/download/latest.json` | `releases/download/dev-channel/latest.json` |
| 应用名称 | E点通工具箱 | E点通工具箱 Dev |
| 应用标识 | `com.audittoolbox.desktop` | `com.audittoolbox.desktop.dev` |
| 本机数据 | 原 `AuditToolbox` 应用目录 | 独立 `AuditToolboxDev` 应用目录 |
| Windows 凭据服务 | `AuditToolbox` | `AuditToolboxDev` |

历史 `alpha` 标签继续属于现有正式更新通道，不自动更改历史 Release。
开发版不自动导入旧版设置；首次使用需自行配置 AI/OCR 等服务。
编译后的版本号决定数据库、业务缓存和凭据命名空间，worker 子进程也采用相同规则。

## 首次启用

1. 将配置 PR 合并到 `main`。
2. 从合并后的 `main` 创建 `dev` 分支。已有 `dev` 时，先将本次配置合并进去。
3. 确认仓库 Actions 已有 `TAURI_SIGNING_PRIVATE_KEY`，以及密钥有密码时的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。沿用现有签名，不生成或替换密钥。
4. 在 Actions → Build and publish E点通工具箱 → Run workflow，选择 **dev**，输入尚未使用的 `v2.0.0-dev.1`。
5. 测试和打包全部通过后，自动发布 Dev 安装包，并创建/更新 `dev-channel` 预发布记录中的更新清单。
6. 首次手动安装 Dev 安装包。原正式版无法通过自动更新转换为 Dev，反向也一样。

`dev-channel` 是更新清单的固定地址，不是程序版本标签。不要移动或删除它的标签，不要将其改为正式 Release。它只保留指向最新 Dev 安装包的清单，各版本安装包保存在各自的 `v…-dev.N` Release 中。此通道记录必须允许更新附件，不能设为不可变 Release。

## 每次发布

开发版：向 `dev` 提交/合并修改后，选择 `dev` 手动运行发布流程，输入递增的新 Dev 标签；也可以在 `dev` 提交上推送新 Dev 标签。

正式版：通过 PR 将验收完成的功能合并到 `main`，选择 `main` 手动运行发布流程并输入新的正式通道标签，或在 `main` 提交上推送新标签。

手动运行会自动为实际构建的提交创建对应标签；已有标签必须指向同一提交。不得覆盖已发布的版本。构建会同步四处版本号，并自动应用 Dev 安装身份和更新入口，无需手改源码切换通道。

不要在 Releases 页面预先发布普通 Release 来触发打包；本流程由推送标签或 Actions 手动运行触发，先生成草稿，签名安装包与清单齐全后再公开。失败时保留草稿以供排查。

发布流程串行执行。Dev 通道还会校验版本递增，拒绝让较旧构建覆盖较新更新清单。GitHub 的并发队列可能取消较早的等待任务；需要保留该版本时重新手动运行。

## 验证

若安装包已签名并通过打包程序验收，但公开预发布后的 Dev 更新清单同步失败，可在 `dev` 手动运行 **Build and publish E点通工具箱**，输入原 Dev 标签并勾选 **repair_published_dev**。修复只接受已公开的 Dev 预发布；根据该版本的实际 EXE 与签名附件核验并规范化清单，再同步 `dev-channel`，不会重新编译、替换安装包或更新正式 Latest。相同版本且清单一致时可重复执行，旧版本不能覆盖较新的通道。

打包工具可能返回 GitHub 附件 API 地址。发布脚本仅把精确匹配该版本附件 ID 的地址转换为对应公开下载地址；其他版本或未知附件一律拒绝。

```powershell
python tauri-app/scripts/test_release_channels.py
node --test tauri-app/scripts/publish_channel_release.check.cjs
```

PR 会运行前端测试、前端构建和 Rust 测试；实际发布也在签名打包前运行检查。正式验收需发布两个递增的 Dev 版本，在 Windows 同时安装正式版和 Dev，确认 Dev 仅收到 Dev 更新，正式版更新目标及设置不变。Dev 更新清单替换期间或网络故障时可能短暂检查失败，重试即可，不会回退读取正式通道。

本机自行打包 Dev 时，须先用发布准备脚本同步 `-dev.N` 版本并合并 Dev 配置。只手动加 `--config` 而保留正式版 Cargo 版本，会造成应用身份与数据通道不一致，不应分发。
