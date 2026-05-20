# 独立模块目录（方式 B）

本目录用于存放**各同事独立 Git 仓库**克隆下来的工具源码。主仓库**不提交**具体模块内容，只保留本说明与 `.gitkeep`。

## 同事如何添加自己的工具

1. 克隆主项你好目后，进入本目录：

   ```bash
   cd audit-toolbox/modules
   ```

2. 克隆自己的仓库（目录名需与 `tools.json` 里的 `vendor_dir` 一致）：

   ```bash
   git clone https://github.com/你的账号/你的工具.git fa_list
   ```

   **已接入示例**：[Excel-Merger](https://github.com/JY01013232/Excel-Merger)（同事仓库）

   ```bash
   # 在项目根目录双击，或命令行执行：
   克隆Excel合并工具.bat
   ```

   等价手动步骤：

   ```bash
   git clone https://github.com/JY01013232/Excel-Merger.git modules/excel_merger
   copy module_entries\excel_merger\main.py modules\excel_merger\main.py
   ```

   `tools.json` 中已注册 `id: excel_merger`，`vendor_dir` 须为 `excel_merger`。

3. 请维护者在主仓库 `tools.json` 中注册该工具（或通过 PR 只提交 `tools.json` 的条目，不提交 `modules/` 内代码）。

4. 本地运行主程序：

   ```bash
   python suite_main.py
   ```

   启动器查找顺序：`vendor/` → **`modules/`** → `tools/` → `dev_root`。

5. 打包 exe 前，维护者执行（会把 `modules/` 同步进 `vendor/`）：

   ```bash
   python build_suite.py
   ```

## 目录名约定

| tools.json 字段 | 对应路径 |
|-----------------|----------|
| `"vendor_dir": "fa_list"` | `modules/fa_list/` |
| `"vendor_dir": "kanzhang"` | `modules/kanzhang/` |
| `"vendor_dir": "Excel-Merger"` | `modules/Excel-Merger/` |

## 常见问题排查

### 1. 脚本能跑但 EXE 不行

**原因**：入口文件不符合 Hub 调用规范，或目录名不匹配。

**解决**：
- 确保 `modules/` 下的目录名与 `tools.json` 的 `vendor_dir` **完全一致**（区分大小写）
- 确保入口文件有 `main(parent=None)` 函数
- 运行 `python build_suite.py --sync-only` 确认同步成功
- 运行 `python -c "from launcher.registry import load_tools, resolve_tool_root; tools = load_tools(); tool = [t for t in tools if t.id == '你的工具ID'][0]; print(resolve_tool_root(tool))"` 验证路径解析

### 2. 同步后 vendor/ 下没有文件

**原因**：`modules/` 下的目录名与 `tools.json` 的 `vendor_dir` 不一致。

**解决**：
- 检查目录名是否完全匹配（注意大小写、连字符 `-` vs 下划线 `_`）
- 修改 `tools.json` 的 `vendor_dir` 或重命名目录

### 3. 入口文件找不到

**原因**：`tools.json` 里的 `entry` 字段指向了不存在的文件。

**解决**：
- 检查入口文件是否在 `modules/` 目录下
- 如果入口不是 `main.py`，请创建一个适配器（见下方示例）

### 4. 适配器示例

如果原仓库入口是 `batch_merger.py`，创建 `main.py`：

```python
"""适配器：将原入口封装为 Hub 调用格式。"""
import tkinter as tk

def main(parent=None):
    if parent is not None:
        root = tk.Toplevel(parent)
    else:
        root = tk.Tk()
    
    from batch_merger import BatchMergeApp
    app = BatchMergeApp(root)
    root.mainloop()
```

---

入口文件默认 `main.py`，或在 `tools.json` 中指定 `entry`。

## 入口函数约定

```python
def main(parent=None):
    # parent 由 Hub 传入时，请用 tk.Toplevel(parent) 打开窗口
    ...
```
