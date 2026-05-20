# -*- coding: utf-8 -*-
"""
一键添加新工具到审计工具箱
双击运行，按提示操作即可
"""
import json
import os
import sys
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from pathlib import Path


class AddToolApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("添加新工具到审计工具箱")
        self.root.geometry("600x500")
        self.root.resizable(False, False)

        # 项目根目录
        self.project_root = Path(__file__).resolve().parent
        self.modules_dir = self.project_root / "modules"
        self.modules_dir.mkdir(parents=True, exist_ok=True)

        self._build_ui()
        self.root.mainloop()

    def _build_ui(self):
        # 标题
        title_frame = ttk.Frame(self.root, padding=(20, 15, 20, 10))
        title_frame.pack(fill="x")
        ttk.Label(title_frame, text="添加新工具", font=("", 16, "bold")).pack(anchor="w")
        ttk.Label(title_frame, text="按照提示填写信息，自动完成工具添加", foreground="#666").pack(anchor="w", pady=(4, 0))

        # 表单区域
        form_frame = ttk.Frame(self.root, padding=(20, 10, 20, 10))
        form_frame.pack(fill="both", expand=True)

        # 工具名称
        ttk.Label(form_frame, text="工具名称（必填）:").pack(anchor="w", pady=(0, 4))
        self.name_var = tk.StringVar()
        ttk.Entry(form_frame, textvariable=self.name_var, width=50).pack(fill="x", pady=(0, 10))
        ttk.Label(form_frame, text="  示例: 发票识别工具、银行流水分析", foreground="#999", font=("", 9)).pack(anchor="w", pady=(0, 5))

        # 工具描述
        ttk.Label(form_frame, text="工具描述（可选）:").pack(anchor="w", pady=(0, 4))
        self.desc_var = tk.StringVar()
        ttk.Entry(form_frame, textvariable=self.desc_var, width=50).pack(fill="x", pady=(0, 10))
        ttk.Label(form_frame, text="  简单说明工具用途", foreground="#999", font=("", 9)).pack(anchor="w", pady=(0, 5))

        # 选择脚本
        ttk.Label(form_frame, text="选择入口脚本文件:").pack(anchor="w", pady=(0, 4))
        script_frame = ttk.Frame(form_frame)
        script_frame.pack(fill="x", pady=(0, 10))
        self.script_var = tk.StringVar()
        ttk.Entry(script_frame, textvariable=self.script_var, width=40).pack(side="left", fill="x", expand=True)
        ttk.Button(script_frame, text="浏览...", command=self._browse_script).pack(side="right", padx=(8, 0))
        ttk.Label(form_frame, text="  选择工具的主入口文件（如 main.py 或 app.py）", foreground="#999", font=("", 9)).pack(anchor="w", pady=(0, 5))

        # 选择额外文件夹（可选）
        ttk.Label(form_frame, text="额外文件夹（可选，多个用分号分隔）:").pack(anchor="w", pady=(0, 4))
        extra_frame = ttk.Frame(form_frame)
        extra_frame.pack(fill="x", pady=(0, 10))
        self.extra_var = tk.StringVar()
        ttk.Entry(extra_frame, textvariable=self.extra_var, width=40).pack(side="left", fill="x", expand=True)
        ttk.Button(extra_frame, text="浏览...", command=self._browse_extra).pack(side="right", padx=(8, 0))
        ttk.Label(form_frame, text="  如有 GUI 目录或其他模块，可在此选择", foreground="#999", font=("", 9)).pack(anchor="w", pady=(0, 5))

        # 选项
        options_frame = ttk.Frame(form_frame)
        options_frame.pack(fill="x", pady=(10, 0))
        self.create_main_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(options_frame, text="自动生成 main.py 入口文件", variable=self.create_main_var).pack(side="left")
        ttk.Label(form_frame, text="  如果选择的脚本已有 main 函数，可取消勾选", foreground="#999", font=("", 9)).pack(anchor="w", pady=(4, 0))

        # 按钮区域
        btn_frame = ttk.Frame(self.root, padding=(20, 10, 20, 15))
        btn_frame.pack(fill="x")
        ttk.Button(btn_frame, text="取消", command=self.root.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(btn_frame, text="添加工具", command=self._add_tool).pack(side="right")
        ttk.Button(btn_frame, text="查看使用说明", command=self._show_help).pack(side="left")

    def _browse_script(self):
        filetypes = [
            ("Python 文件", "*.py"),
            ("所有文件", "*.*")
        ]
        filename = filedialog.askopenfilename(
            title="选择入口脚本",
            filetypes=filetypes,
            parent=self.root
        )
        if filename:
            self.script_var.set(filename)

    def _browse_extra(self):
        dirpath = filedialog.askdirectory(
            title="选择额外文件夹",
            parent=self.root
        )
        if dirpath:
            current = self.extra_var.get().strip()
            if current:
                self.extra_var.set(f"{current};{dirpath}")
            else:
                self.extra_var.set(dirpath)

    def _add_tool(self):
        # 验证
        name = self.name_var.get().strip()
        if not name:
            messagebox.showerror("错误", "请输入工具名称", parent=self.root)
            return

        script = self.script_var.get().strip()
        if not script or not Path(script).is_file():
            messagebox.showerror("错误", "请选择有效的入口脚本文件", parent=self.root)
            return

        # 生成工具 ID（英文，小写）
        tool_id = self._generate_id(name)
        if not tool_id:
            messagebox.showerror("错误", "无法从工具名称生成 ID，请手动输入英文 ID", parent=self.root)
            return

        # 创建工具目录
        tool_dir = self.modules_dir / tool_id
        if tool_dir.exists():
            if not messagebox.askyesno("确认", f"工具目录 '{tool_id}' 已存在，是否覆盖？", parent=self.root):
                return
            import shutil
            shutil.rmtree(tool_dir)

        tool_dir.mkdir(parents=True)

        # 复制入口脚本
        import shutil
        script_path = Path(script)
        dest_script = tool_dir / script_path.name
        shutil.copy2(script, dest_script)

        # 复制额外文件夹
        extra_dirs = self.extra_var.get().strip()
        if extra_dirs:
            for dir_path in extra_dirs.split(";"):
                dir_path = dir_path.strip()
                if dir_path and Path(dir_path).is_dir():
                    dest_dir = tool_dir / Path(dir_path).name
                    shutil.copytree(dir_path, dest_dir)

        # 生成 main.py（如果需要）
        if self.create_main_var.get():
            self._create_main_py(tool_dir, script_path.name)

        # 更新 tools.json
        self._update_tools_json(tool_id, name, script_path.name)

        messagebox.showinfo(
            "成功",
            f"工具 '{name}' 已添加成功！\n\n"
            f"工具目录: modules/{tool_id}/\n"
            f"（独立仓库模式，该目录默认不入主仓库 Git）\n\n"
            f"入口文件: {script_path.name}\n\n"
            f"重启工具箱即可看到新工具。",
            parent=self.root
        )
        self.root.destroy()

    def _generate_id(self, name):
        """从中文名称生成英文 ID"""
        # 简单规则：取首字母或用下划线
        import re
        # 移除特殊字符，保留中文、英文、数字
        clean = re.sub(r'[^\w一-鿿]', '', name)
        if not clean:
            return None

        # 如果全是中文，生成简单 ID
        if all('一' <= c <= '鿿' for c in clean):
            # 用时间戳后几位
            import time
            return f"tool_{int(time.time()) % 10000}"

        # 如果有英文，转为小写
        return clean.lower()[:20]

    def _create_main_py(self, tool_dir, original_script):
        """生成 main.py 入口文件"""
        content = f'''# -*- coding: utf-8 -*-
"""
{self.name_var.get()} - 入口文件
由添加工具脚本自动生成
"""
import sys
from pathlib import Path

# 确保工具目录在 sys.path 中
_tool_dir = Path(__file__).resolve().parent
if str(_tool_dir) not in sys.path:
    sys.path.insert(0, str(_tool_dir))


def main(parent=None):
    """
    工具入口函数。

    Args:
        parent: 父窗口（tk.Tk 或 None），
                被 Hub 调用时传入，工具以 Toplevel 方式打开。
    """
    import tkinter as tk

    # 导入原脚本的 main 函数
    from {original_script.replace(".py", "")} import main as original_main

    if parent is not None:
        root = tk.Toplevel(parent)
        root.transient(parent)
    else:
        root = tk.Tk()

    # 调用原脚本的 main 函数
    original_main(parent=root)


if __name__ == "__main__":
    main()
'''
        main_file = tool_dir / "main.py"
        with open(main_file, "w", encoding="utf-8") as f:
            f.write(content)

    def _update_tools_json(self, tool_id, name, entry_file):
        """更新 tools.json"""
        config_path = self.project_root / "tools.json"

        # 读取现有配置
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        else:
            config = {
                "suite_title": "审计工具箱",
                "suite_version": "1.0.0",
                "tools": []
            }

        # 添加新工具
        new_tool = {
            "id": tool_id,
            "name": name,
            "description": self.desc_var.get().strip(),
            "vendor_dir": tool_id,
            "entry": entry_file if entry_file != "main.py" else "main.py",
            "callable": "main"
        }

        # 检查是否已存在同 ID 工具
        existing_ids = [t.get("id") for t in config["tools"]]
        if tool_id in existing_ids:
            # 更新已有工具
            for i, t in enumerate(config["tools"]):
                if t.get("id") == tool_id:
                    config["tools"][i] = new_tool
                    break
        else:
            # 添加新工具
            config["tools"].append(new_tool)

        # 写入文件
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

    def _show_help(self):
        help_text = """
使用说明

1. 工具名称
   - 输入工具的中文名称，会显示在工具箱界面

2. 选择入口脚本
   - 选择工具的主文件（.py 文件）
   - 这个文件需要有一个可调用的函数（默认 main）

3. 额外文件夹（可选）
   - 如果工具依赖其他 Python 文件（如 gui/ 目录）
   - 可以选择这些文件夹，会自动复制

4. 自动生成 main.py
   - 建议勾选，会自动创建入口文件
   - 如果你的脚本已经有 main() 函数，可以取消勾选

5. 添加完成后
   - 重启工具箱即可看到新工具
   - 工具会显示在列表中，点击"进入"即可使用

注意事项
- 原脚本需要使用 tkinter 创建 GUI
- 如果有特殊依赖库，需要手动安装
- 所有文件会被复制到 modules/ 目录（不入主仓库，见 modules/README.md）
"""
        messagebox.showinfo("使用说明", help_text, parent=self.root)


def main():
    AddToolApp()


if __name__ == "__main__":
    main()
