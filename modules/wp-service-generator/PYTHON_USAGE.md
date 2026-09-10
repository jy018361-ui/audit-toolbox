# Python版详细使用说明

## 1. 文件夹内容

Python 版文件夹应保留以下程序文件：

- `FY27_WP服务单生成工具.py`：适合 Windows 本地 Python 或 VS Code 直接运行。
- `generate_wp_project_workbook.py`：适合命令行或 Jupyter `%run`。
- `format_wp_workbook.py`：生成脚本依赖的格式化模块。
- `main.py`：audit-toolbox 图形入口，也可以单独运行后选择输入文件夹。
- `生成项目组展示版_Jupyter.ipynb`：Jupyter Notebook 示例。
- `requirements.txt`：Python 依赖清单。
- `templates/FY27+WP服务单.xlsx.b64`：脱敏模板资源，不要删除。

三个 `.xlsx` 输入文件也应放在同一文件夹。文件名不固定，但必须分别包含 `WP服务单`、`Section List` 和 `我的订单`。

## 2. Python 环境要求

- 推荐 Python 3.10 或更高版本。
- 依赖：`openpyxl>=3.1,<4`。
- 运行前关闭三个输入文件和旧的输出文件。

首次使用时，在 Python 版文件夹打开 PowerShell 或 VS Code Terminal，运行：

```powershell
python -m pip install -r requirements.txt
```

如果电脑使用 `py` 启动 Python，也可以运行：

```powershell
py -m pip install -r requirements.txt
```

## 3. Windows 本地 Python / PowerShell

### 方式一：直接运行工具

在 Python 版文件夹的地址栏输入 `powershell` 并回车，然后运行：

```powershell
python FY27_WP服务单生成工具.py
```

程序会自动读取与脚本同一文件夹中的三个输入文件，确认后开始生成。

### 方式二：指定输入和输出

```powershell
python generate_wp_project_workbook.py --input "FY27 WP服务单.xlsx" --output "FY27+WP服务单汇总.xlsx"
```

`Section List` 和“我的订单”会按文件名关键词从同一文件夹自动识别。

### 方式三：选择输入文件夹

```powershell
python main.py
```

此方式会打开文件夹选择窗口，适合程序文件和业务输入不在同一位置的情况。

不建议直接双击 `.py` 后观察报错，因为发生错误时命令窗口可能立即关闭。使用 PowerShell 更容易看到完整提示。

## 4. VS Code 中运行

1. 在 VS Code 中选择 `File > Open Folder`，打开 `WP服务单小工具_Python版` 文件夹。
2. 按 `Ctrl+Shift+P`，执行 `Python: Select Interpreter`，选择准备使用的 Python 环境。
3. 打开 `Terminal > New Terminal`。
4. 首次使用运行 `python -m pip install -r requirements.txt`。
5. 运行 `python FY27_WP服务单生成工具.py`。

也可以打开 `FY27_WP服务单生成工具.py`，点击 VS Code 的 `Run Python File`。如果需要查看详细报错，优先使用 Terminal 运行。

使用 VS Code Notebook 时，先在右上角选择安装了 `openpyxl` 的 Python Kernel，再按照下一节运行。

## 5. Jupyter Notebook / Anaconda

### 首次安装依赖

在 Notebook 单元格中运行：

```python
%pip install -r "C:\项目\WP服务单小工具\WP服务单小工具_Python版\requirements.txt"
```

安装完成后，如 Jupyter 提示重启 Kernel，请重启后再继续。

### 直接生成

```python
%run "C:\项目\WP服务单小工具\WP服务单小工具_Python版\generate_wp_project_workbook.py" --input "C:\项目\WP服务单小工具\WP服务单小工具_Python版\FY27 WP服务单.xlsx" --output "C:\项目\WP服务单小工具\WP服务单小工具_Python版\FY27+WP服务单汇总.xlsx"
```

也可以在 Jupyter 中打开 `生成项目组展示版_Jupyter.ipynb`，依次运行其中的代码单元格。

Jupyter 使用的是当前 Notebook 的 Kernel 环境。即使电脑已经安装 `openpyxl`，如果 Kernel 指向另一个 Python 环境，仍需在该 Kernel 中执行 `%pip install`。

## 6. 模板说明

Python 版需要保留 `templates` 文件夹，但不需要手工准备 `FY27+WP服务单.xlsx`。

首次生成时，程序会从 `templates/FY27+WP服务单.xlsx.b64` 自动还原模板。还原后的 `FY27+WP服务单.xlsx` 可以保留；删除后，下次运行会再次自动还原。

## 7. 输出文件

程序会在输入文件所在目录生成或更新：

- `FY27+WP服务单_自动拆分.xlsx`
- `FY27+WP服务单汇总.xlsx`

如需保留旧结果，请在再次运行前将旧文件改名或移动到其他文件夹。

## 8. 常见问题

### `ModuleNotFoundError: No module named 'openpyxl'`

当前 Python 环境未安装依赖。使用同一个 Python 解释器运行：

```powershell
python -m pip install -r requirements.txt
```

### 找不到服务方案模板

确认 `templates/FY27+WP服务单.xlsx.b64` 存在，并使用最新版 `generate_wp_project_workbook.py`。最新版会自动还原模板。

### 找到多个 WP服务单、Section List 或我的订单

同一文件夹中每类输入只能保留一份。将旧导出、备份或重复文件移动到其他文件夹后重试。

### 输出文件无法保存

关闭 Excel 中已经打开的 `FY27+WP服务单汇总.xlsx` 和自动拆分文件，再重新运行。

### VS Code 可以运行，但 Jupyter 不可以

VS Code Terminal 和 Jupyter Kernel 可能使用不同的 Python 环境。检查 Notebook 右上角的 Kernel，并在 Notebook 中执行 `%pip install -r ...`。

完整输入字段要求请查看 `输入文件命名及字段要求.md` 或项目 README。
