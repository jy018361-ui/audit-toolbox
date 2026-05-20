# 审计工具箱

基于 tkinter 的审计辅助工具套件，采用"Hub + 插件"架构，支持多人协同开发和一键打包。

## 功能

- **FA List 匹配工具**：固定资产底稿双表匹配、透视与导出
- **看账小工具**：凭证导入、科目筛选、透视与导出
- **Excel 批量合并**：独立仓库 [Excel-Merger](https://github.com/JY01013232/Excel-Merger)，克隆到 `modules/excel_merger`
- **可扩展架构**：轻松添加新的审计工具

## 快速开始

### 环境要求

- Python 3.10+
- Windows 10/11

### 安装依赖

```bash
pip install -r requirements.txt
```

### 运行开发模式

```bash
python suite_main.py
```

### 一键打包

```bash
# 完整构建（同步 vendor + 安装依赖 + 打包 exe）
python build_suite.py

# 仅同步 vendor 目录
python build_suite.py --sync-only

# 跳过基线对比
python build_suite.py --no-baseline
```

打包完成后，`dist/审计工具箱.exe` 即可分发给用户使用。

## 项目结构

```
audit-toolbox/
├── suite_main.py          # 套件主入口
├── tools.json             # 工具注册配置
├── build_suite.py         # 构建脚本
├── suite.spec             # PyInstaller 配置
├── requirements.txt       # Python 依赖
├── launcher/              # 启动器模块
│   ├── hub_window.py      # Hub 主界面
│   ├── registry.py        # 工具注册表
│   ├── runner.py          # 工具加载器
│   └── bundle_anchor.py   # 依赖追踪锚点
├── modules/               # 独立仓库克隆目录（gitignore 内容，见 modules/README.md）
├── tools/                 # 可选：主仓内置工具源码（兼容）
├── vendor/                # 打包用副本（gitignore，由 build_suite 同步）
└── dist/                  # 打包输出（gitignore）
```

## 添加新工具

### 方式一：使用添加工具界面（推荐新手）

1. 双击运行 `添加工具.bat`
2. 在界面中填写工具名称、选择脚本文件
3. 点击"添加工具"，完成！

详见 [添加工具使用说明.md](添加工具使用说明.md)

### 方式二：手动添加

详见 [CONTRIBUTING.md](CONTRIBUTING.md)

#### 快速步骤

1. 在 `modules/` 下克隆独立仓库（推荐，见 [modules/README.md](modules/README.md)）
2. 在 `tools.json` 中添加工具配置（可只提交 JSON，不提交模块源码）
3. 维护者打包：`python build_suite.py`

示例：

```json
{
  "id": "my_tool",
  "name": "我的工具",
  "description": "工具描述",
  "vendor_dir": "my_tool",
  "entry": "main.py",
  "callable": "main"
}
```

## 架构说明

### 运行时流程

```
suite_main.py
    ↓
launcher.hub_window.HubWindow   ← 工具选择界面
    ↓
launcher.runner.launch_tool()   ← 动态加载子工具
    ↓
子工具 GUI 界面
```

### 子工具加载机制

启动器通过 `importlib.util` 动态加载子工具，执行后自动清理模块缓存，实现工具间完全隔离。

### PyInstaller 打包

- 入口：`suite_main.py`
- `tools.json` 和整个 `vendor/` 目录打包进单文件 exe
- `bundle_anchor.py` 触发重依赖追踪，确保运行时不缺模块

## 多人协同（方式 B：独立仓库 + modules/）

### 工作流

1. **维护者**：主仓库提供 Hub、`tools.json`、空目录 `modules/`
2. **各开发者**：在自己的 Git 仓库开发；克隆主项目后执行：
   ```bash
   cd modules
   git clone https://github.com/xxx/你的工具.git <vendor_dir名>
   ```
   `vendor_dir名` 必须与 `tools.json` 里该项的 `vendor_dir` 一致。
3. **注册工具**：向主仓提 PR，**只改 `tools.json`**（不必提交 `modules/` 内代码）
4. **打包者**：在本机拉齐各 `modules/*` 后执行 `python build_suite.py`
5. **分发**：将 `dist/审计工具箱.exe` 发给最终用户

开发时启动器查找顺序：`vendor/` → `modules/` → `tools/` → `dev_root`。

### 克隆主项目

```bash
git clone https://github.com/jy018361-ui/audit-toolbox.git
cd audit-toolbox
pip install -r requirements.txt
# 按需克隆子模块到 modules/，见 modules/README.md
python suite_main.py
```

## 常见问题

### Q: 打包后运行报错"找不到模块"

A: 检查 `launcher/bundle_anchor.py` 是否包含该模块的 import，以及 `suite.spec` 的 `hiddenimports` 列表。

### Q: 如何在开发模式下测试打包效果？

A: 使用 `python build_suite.py --sync-only` 同步 vendor，然后运行 `python suite_main.py`。

### Q: modules、tools、vendor 有什么区别？

A:
- **`modules/`**：各人独立仓库 clone 的位置，**默认不入主仓 Git**
- **`tools/`**：可选，主仓内置工具源码（兼容旧流程）
- **`vendor/`**：打包缓存，由 `build_suite.py` 从 `modules/`（优先）或 `tools/` 同步，不入库

## License

MIT
