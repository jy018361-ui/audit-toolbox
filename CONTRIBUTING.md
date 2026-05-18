# 贡献指南

感谢你参与审计工具箱的开发！本文档说明如何添加新工具和参与协同。

## 添加新工具

### 1. 创建工具目录

在项目根目录下创建 `tools/` 目录（如果不存在），然后以工具名创建子目录：

```
tools/
└── your_tool/
    ├── main.py           # 入口文件（必需）
    ├── gui/              # GUI 模块（可选）
    └── requirements.txt  # 工具专属依赖（可选）
```

### 2. 编写入口函数

入口文件必须包含一个可调用的函数（默认名为 `main`），支持 `parent` 参数：

```python
# tools/your_tool/main.py

def main(parent=None):
    """
    工具入口函数。
    
    Args:
        parent: 父窗口（tk.Tk 或 None），
                被 Hub 调用时传入，工具以 Toplevel 方式打开。
    """
    import tkinter as tk
    from tkinter import ttk
    
    if parent is not None:
        root = tk.Toplevel(parent)
        root.transient(parent)
    else:
        root = tk.Tk()
    
    root.title("我的工具")
    root.geometry("800x600")
    
    # 你的 GUI 代码...
    
    root.mainloop()
```

### 3. 注册工具

编辑 `tools.json`，在 `tools` 数组中添加你的工具配置：

```json
{
  "id": "your_tool",
  "name": "我的工具",
  "description": "工具功能描述",
  "vendor_dir": "your_tool",
  "entry": "main.py",
  "callable": "main"
}
```

**字段说明**：

| 字段 | 必需 | 说明 |
|------|------|------|
| `id` | 是 | 工具唯一标识符，用于模块命名 |
| `name` | 是 | 显示在 Hub 界面的名称 |
| `description` | 否 | 工具功能描述 |
| `vendor_dir` | 是 | `tools/` 下的子目录名 |
| `entry` | 否 | 入口文件名，默认 `main.py` |
| `entry_dev` | 否 | 开发模式入口（可选） |
| `entry_vendor` | 否 | vendor 模式入口（可选） |
| `callable` | 否 | 入口函数名，默认 `main` |

### 4. 测试工具

```bash
# 开发模式运行
python suite_main.py

# 或直接运行你的工具
python tools/your_tool/main.py
```

### 5. 提交代码

```bash
git add tools/your_tool/
git add tools.json
git commit -m "添加 XXX 工具"
git push
```

## 依赖管理

### 工具专属依赖

如果你的工具需要额外的第三方库：

1. 在 `tools/your_tool/requirements.txt` 中列出依赖
2. 在 `launcher/bundle_anchor.py` 的 `touch_bundle_deps()` 中添加 import
3. 在 `suite.spec` 的 `hiddenimports` 列表中添加模块名

示例：

```python
# launcher/bundle_anchor.py
def touch_bundle_deps() -> None:
    import dateutil
    import numpy
    import openpyxl
    import pandas
    import polars
    import python_calamine
    import xlsxwriter
    import xlrd
    import your_new_library  # 添加这一行
```

```python
# suite.spec
hiddenimports = [
    # ... 现有列表 ...
    "your_new_library",
]
```

## 开发规范

### 代码风格

- 使用 4 空格缩进
- 函数和变量使用 snake_case
- 类名使用 PascalCase
- 中文注释和文档字符串

### 文件编码

- 所有 Python 文件使用 UTF-8 编码
- 中文内容确保正确处理编码

### GUI 规范

- 使用 tkinter 和 ttk 组件
- 支持 `parent` 参数，被 Hub 调用时以 Toplevel 方式打开
- 窗口标题清晰，反映工具功能

### 错误处理

- 用户操作错误使用 `messagebox.showerror()` 提示
- 避免直接暴露技术细节给用户
- 关键操作前确认（如文件覆盖）

## 提交规范

### Commit Message 格式

```
<类型>: <描述>

<详细说明（可选）>
```

**类型**：
- `feat`: 新功能
- `fix`: 修复
- `docs`: 文档
- `style`: 格式
- `refactor`: 重构
- `test`: 测试
- `chore`: 其他

**示例**：

```bash
git commit -m "feat: 添加发票识别工具"
git commit -m "fix: 修复导出时的编码问题"
git commit -m "docs: 更新 README 使用说明"
```

### 分支管理

- `main`: 稳定版本
- `dev`: 开发分支（可选）
- `feature/xxx`: 功能分支（可选）

## 打包发布

打包由项目维护者统一执行：

```bash
# 拉取最新代码
git pull

# 一键构建
python build_suite.py

# 输出位置
dist/审计工具箱.exe
```

## 问题反馈

如有问题或建议，请通过以下方式联系：

- GitHub Issues: https://github.com/jy018361-ui/audit-toolbox/issues
- 或直接在仓库中提交 Issue

## License

贡献的代码将与项目一起以 MIT License 发布。
