# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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

### 子工具入口签名（统一窗口管理）

子工具入口函数使用 `main(root=None)` 签名：

```python
def main(root=None):
    if root is None:
        # 独立运行：自己创建 Tk 根窗口
        root = tk.Tk()
        MyApp(root)
        root.mainloop()
    else:
        # 被工具箱调用：直接使用 runner 传入的窗口
        MyApp(root)
```

**runner 的行为**：
- 检测到 `root` 参数 → 由 runner 统一创建标准 Toplevel 窗口传入，子工具只管填充 UI
- `runner` 不再接受旧 `parent` 签名；新增或替换工具时必须改成 `main(root=None)`

**硬性约束**（子工具必须遵守）：
1. **禁止调用 `transient()`** — 会移除最大化/最小化按钮，且行为依赖 WM
2. **禁止修改窗口装饰器**（如 `attributes('-toolwindow', ...)`、`overrideredirect()`）
3. **禁止调用 `root.mainloop()`**（被工具箱调用时） — 仅允许在 `root is None` 的独立运行分支里调用
4. **禁止在嵌入分支调用 `wait_window()`、`grab_set()` 或自行阻塞 Hub**
5. 子工具的行为在独立运行和工具箱调用下必须完全一致

### 新增子工具
1. 在 `tools.json` 的 `tools` 数组中添加条目，指定 `vendor_dir`、`entry`、`callable`
2. 子工具入口函数需使用 `main(root=None)` 签名（见上方约定）
3. 在 `build_suite.py` 中添加对应的 `sync_xxx()` 函数
4. 若依赖新的第三方库，需同步更新 `suite.spec` 的 `hiddenimports` 和 `launcher/bundle_anchor.py`

### 新增/替换脚本功能的接入清单

以下清单来自 2026-05-19 的实战排查，今后新增或替换 Hub 子工具时必须逐项确认：

1. **优先使用 ASCII 入口文件名**  
   - `tools.json` 的 `entry` 优先指向 `main.py` 之类的 ASCII 文件。  
   - 如果真实脚本文件名是中文、带空格或历史随机名（如 `超链接2.0.py`、`cop123213y.py`），请额外包一层 `main.py`，不要直接把这些文件名挂到 `tools.json`。

2. **包装入口必须先注册到 `sys.modules`**  
   - 若 `main.py` 内部再用 `importlib.util.spec_from_file_location()` 动态加载实现脚本，必须先执行：
   ```python
   module = importlib.util.module_from_spec(spec)
   sys.modules[spec.name] = module
   spec.loader.exec_module(module)
   ```
   - 否则像 `@dataclass` 这类运行时会回查模块对象的逻辑，可能出现 `NoneType has no attribute '__dict__'` 之类错误。

3. **嵌入模式只负责建 UI，不负责卡住 Hub**
   - `root is None`：工具自己 `Tk()` 并 `mainloop()`
   - `root is not None`：只使用 runner 传入的窗口并填充 UI，**不要** `mainloop()`、`wait_window()`、`grab_set()`
   - 若工具本身有 `App.run()`，必须确保它在嵌入模式下不阻塞 Hub

4. **禁止点击一次触发两次启动**
   - Hub 卡片若同时支持卡片点击和按钮点击，必须确认不会因为事件冒泡导致重复打开同一工具
   - 新增工具后要手动测试“单击按钮 / 单击卡片 / 快速连点”三种路径

5. **替换现有工具来源时，要改运行源而不是只改备份源码**
   - `registry.py` 的查找顺序是 `vendor` → `modules` → `tools` → `dev_root`
   - 如果要让 Hub 立刻使用新的脚本来源，必须确认 `tools.json` 的 `vendor_dir`/`entry` 已指向实际想运行的目录
   - 不要只改 `tools/xxx`，结果运行中的仍是 `vendor/xxx`

6. **切换来源后立即同步并回归**
   - 开发模式至少执行一次：
   ```bash
   python build_suite.py --sync-only
   ```
   - 然后手动验证：
     - 从 Hub 打开工具
     - 关闭后再切到别的工具
     - 连续切换 2-3 个工具
     - 确认不会出现假死、重复启动、错误父窗口或残留弹窗

7. **控制台输出不要用不安全字符**
   - 若脚本会在 Windows 控制台输出日志，避免直接 `print("✅ ...")`、`print("❌ ...")`
   - 推荐统一成 ASCII 文本，或做兼容包装，避免 `gbk` 控制台编码触发 `UnicodeEncodeError`

### vendor 目录
`vendor/` 已被 `.gitignore` 排除，由 `build_suite.py --sync-only` 从外部开发目录同步。开发时可直接编辑 `vendor/` 下的文件，但需注意这些更改不会被版本控制。

## 测试

项目目前没有自动化测试套件。验证修改的方式是直接运行 `python suite_main.py` 启动 GUI 并手动测试各子工具的完整流程。
