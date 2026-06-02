# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

审计工具箱是一个基于 tkinter 的桌面应用，采用"Hub + 插件"架构，通过 `tools.json` 注册子工具，由 `launcher/` 负责加载和隔离运行。

当前包含两个子工具：
- **fa_list**: 固定资产底稿双表匹配、透视与 FA List 导出（独立 GUI 模块体系）
- **kanzhang**: 凭证导入、科目筛选、透视与导出（单文件应用）

## 常用命令

### 开发运行
```bash
# 直接启动（开发模式，自动从 tools/ 和 modules/ 加载工具）
python suite_main.py
```

### 打包构建
```bash
# 完整构建：安装依赖 → 构建单文件 exe（直接从 tools/ 和 modules/ 打包）
python build_suite.py

# 跳过基线对比
python build_suite.py --no-baseline

# 跳过 pip install
python build_suite.py --no-pip

# 手动同步工具到 vendor/（仅旧版兼容，一般不需要）
python build_suite.py --sync-only
```

### 依赖安装
```bash
pip install -r requirements.txt
```

## 核心架构

### 运行时流程
`suite_main.py` → `launcher.hub_window.HubWindow`（工具选择界面）→ `launcher.runner.launch_tool()`（动态加载子工具入口）

### 子工具加载机制
`runner.py` 通过 `importlib.util` 动态加载子工具的 entry 文件，加载前将工具根目录插入 `sys.path`，执行后清理所有该工具引入的模块（`_purge_tool_modules`），实现工具间隔离。

### 入口优先级
`registry.py` 中 `resolve_entry_path` 按 `entry` → `entry_dev` → `entry_vendor` 顺序查找入口文件。vendor 目录优先于 dev_root。

### 构建系统
`build_suite.py` 负责：
1. 直接使用 `tools/` 和 `modules/` 目录中的源码进行打包
2. 调用 PyInstaller 使用 `suite.spec` 构建单文件 exe
3. 可选地构建各子工具的基线 exe 用于体积对比
4. `--sync-only` 仅作为旧版兼容，手动将工具同步到 `vendor/`（一般不需要）

### 跨电脑协同构建
当多个同事各自开发子工具、需要在不同电脑上统一打包时，推荐以下工作流：

1. **各自开发，代码托管到 Git 仓库**
2. **每人把子工具源码放入对应目录**：
   - `tools/fa_list/` — 本地开发的工具
   - `modules/confirmation_progress/` — 外部克隆的工具仓库
3. **打包者拉取最新代码**后执行 `python build_suite.py`，直接从 `tools/` 和 `modules/` 打包，无需额外同步步骤

### PyInstaller 配置（suite.spec）
- 入口：`suite_main.py`
- `tools.json` 和整个 `tools/`、`modules/` 目录打包进 exe
- `launcher/bundle_anchor.py` 通过 `touch_bundle_deps()` 触发 PyInstaller 追踪 pandas/numpy/openpyxl 等重依赖
- 大量排除了不使用的科学计算库以控制体积

## 关键约定

### 子工具入口签名（硬性约束，runner 会强制校验）

**唯一支持的签名**：`main(root=None)`

```python
def main(root=None):
    is_embedded = root is not None
    if root is None:
        root = tk.Tk()

    MyApp(root)  # 构建 UI

    if is_embedded:
        root.wait_window()  # 等待窗口关闭，禁止调用 mainloop()
    else:
        root.mainloop()     # 独立运行时启动事件循环
```

**runner 的强校验机制**（`launcher/runner.py`）：
- **签名检查**：入口函数必须接受 `root` 参数。使用旧 `parent` 签名或无参数会被直接拒绝启动，并给出修复提示
- **禁止模式扫描**：启动前扫描入口源码，检测以下危险模式并打印警告：
  - `SetProcessDpiAwareness()` — 进程级 DPI 设置，会改变 Hub 分辨率
  - `.mainloop()` — 可能引发事件循环冲突导致 Hub 卡死
- **孤儿窗口清理**：工具退出后自动销毁残留的 Toplevel 窗口
- **模块隔离清理**：移除工具引入的所有模块（`_purge_tool_modules`），避免重复进入时状态污染

**新接入工具的检查清单**：
1. [ ] 入口函数使用 `main(root=None)` 签名（不接受 `parent` 参数）
2. [ ] 接收 `root` 时 **不调用 `mainloop()`**，改用 `wait_window()` 或直接返回
3. [ ] **不调用 `SetProcessDpiAwareness()`**（如需要 DPI 适配，放在 `if __name__ == "__main__"` 块中）
4. [ ] **不调用 `grab_set()`** 在入口传入的 `root` 窗口上（内部对话框可用）
5. [ ] **不修改窗口装饰器**（`transient()`、`overrideredirect()`、`attributes('-toolwindow')`）
6. [ ] 独立运行和嵌入式运行行为一致

### 源码目录约定
- `tools/` — 本地开发的子工具源码，纳入版本控制
- `modules/` — 外部克隆的子工具仓库，纳入版本控制
- `vendor/` — 已废弃，不再作为打包源。仅 `--sync-only` 手动同步时使用，已被 `.gitignore` 排除

## 测试

项目目前没有自动化测试套件。验证修改的方式是直接运行 `python suite_main.py` 启动 GUI 并手动测试各子工具的完整流程。
