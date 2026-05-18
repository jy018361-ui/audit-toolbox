# 审计工具箱

基于 tkinter 的审计辅助工具套件，采用"Hub + 插件"架构，支持多人协同开发和一键打包。

## 功能

- **FA List 匹配工具**：固定资产底稿双表匹配、透视与导出
- **看账小工具**：凭证导入、科目筛选、透视与导出
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
├── vendor/                # 子工具源码（gitignore）
│   ├── fa_list/
│   └── kanzhang/
└── dist/                  # 打包输出（gitignore）
```

## 添加新工具

详见 [CONTRIBUTING.md](CONTRIBUTING.md)

### 快速步骤

1. 在 `tools/` 目录下创建子目录，放入工具源码
2. 在 `tools.json` 中添加工具配置
3. 提交代码

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

## 多人协同

### 工作流

1. **开发者**：各自在 `tools/` 目录开发子工具，提交到 Git
2. **打包者**：拉取最新代码，执行 `python build_suite.py` 一键构建
3. **分发**：将 `dist/审计工具箱.exe` 发给用户

### 克隆仓库

```bash
git clone https://github.com/jy018361-ui/audit-toolbox.git
cd audit-toolbox
pip install -r requirements.txt
python suite_main.py
```

## 常见问题

### Q: 打包后运行报错"找不到模块"

A: 检查 `launcher/bundle_anchor.py` 是否包含该模块的 import，以及 `suite.spec` 的 `hiddenimports` 列表。

### Q: 如何在开发模式下测试打包效果？

A: 使用 `python build_suite.py --sync-only` 同步 vendor，然后运行 `python suite_main.py`。

### Q: vendor 目录和 tools 目录的区别？

A: `tools/` 在 Git 中托管，是源码；`vendor/` 由 `build_suite.py` 从 `tools/` 同步生成，不入库。

## License

MIT
