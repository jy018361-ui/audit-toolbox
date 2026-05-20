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
# 直接启动（开发模式，需要 vendor 目录已同步或 dev_root 可用）
python suite_main.py

# 仅同步 vendor 目录（从 dev_root 拷贝源码到 vendor/）
python build_suite.py --sync-only
```

### 打包构建
```bash
# 完整构建：同步 vendor → 安装依赖 → 构建单文件 exe（含体积对比）
python build_suite.py

# 跳过基线对比
python build_suite.py --no-baseline

# 跳过 pip install
python build_suite.py --no-pip
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
1. `sync_vendor()`: 从外部 dev_root 同步源码到 `vendor/`，自动排除测试文件、缓存、构建产物
2. 调用 PyInstaller 使用 `suite.spec` 构建单文件 exe
3. 可选地构建各子工具的基线 exe 用于体积对比

### 跨电脑协同构建（推荐方案）
当多个同事各自开发子工具、需要在不同电脑上统一打包时，推荐以下工作流：

1. **各自开发，代码托管到 Git 仓库**（vendor/ 已在 .gitignore 中，不入库）
2. **每人只把子工具源码目录提交到仓库的指定路径**，例如：
   - `tools/fa_list/` — 同事 A 的固定资产工具
   - `tools/kanzhang/` — 同事 B 的看账工具
   - `tools/your_tool/` — 你自己的新工具
3. **修改 `build_suite.py`**，将同步源从硬编码的本地路径改为读取仓库中的 `tools/` 目录：
   ```python
   # 替换 FA_SRC = Path(r"C:\Users\Administrator\Downloads\...") 为：
   FA_SRC = ROOT / "tools" / "fa_list"
   KANZHANG_SRC = ROOT / "tools" / "kanzhang"
   ```
4. **打包者拉取最新代码**后执行 `python build_suite.py`，即可一键同步并构建。

> **备选方案**：如果子工具开发者不想提交源码到仓库，也可以把各自目录放在共享网盘/内网共享文件夹，`build_suite.py` 中路径指向共享位置即可。

### PyInstaller 配置（suite.spec）
- 入口：`suite_main.py`
- `tools.json` 和整个 `vendor/` 目录打包进 exe
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

### vendor 目录
`vendor/` 已被 `.gitignore` 排除，由 `build_suite.py --sync-only` 从外部开发目录同步。开发时可直接编辑 `vendor/` 下的文件，但需注意这些更改不会被版本控制。

## 测试

项目目前没有自动化测试套件。验证修改的方式是直接运行 `python suite_main.py` 启动 GUI 并手动测试各子工具的完整流程。
