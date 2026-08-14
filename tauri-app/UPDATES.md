# 发布与自动更新

## 首次配置

更新签名私钥已生成在维护者本机的 `%USERPROFILE%\.tauri\audit-toolbox.key`，不要提交到 GitHub。
对应的公钥已经写入 `src-tauri/tauri.conf.json`，可以安全提交。

在 GitHub 仓库 `jy018361-ui/audit-toolbox` 的 Settings → Secrets and variables → Actions 中新增：

- `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整文本内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：本次密钥密码；当前密钥为空密码时填写空值即可

## 发布版本

1. 将 `tauri-app/package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本号同步为同一个 SemVer，例如 `2.0.1`。
2. 提交并推送代码。
3. 创建并推送 Git Tag，例如：

   ```powershell
   git tag v2.0.1
   git push origin v2.0.1
   ```

4. GitHub Actions 会自动测试、构建 NSIS 安装包、生成 updater 签名文件和 `latest.json`，并创建 Release。

用户安装一次支持 updater 的 NSIS 版本后，后续可在“设置 → 软件更新”中检查并安装新版本。

## 本地构建

本地构建前设置签名私钥路径：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\audit-toolbox.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
python scripts\build_tauri_release.py --reuse-dependencies --skip-tests
```

安装包输出到 `tauri-app/dist/`；运行时 EXE 仅用于本地冷启动验收，不作为用户发布包。
