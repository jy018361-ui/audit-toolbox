import os
import xlsxwriter
import tkinter as tk
from tkinter import filedialog, messagebox
from datetime import datetime
from pathlib import Path


class _NoopProgress:
    def __init__(self, total=0, desc=""):
        self.total = total
        self.desc = desc

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def update(self, _n=1):
        return None


def _escape_excel_formula_text(value):
    return str(value).replace('"', '""')


def _to_excel_hyperlink_formula(file_path, display_text):
    target = _escape_excel_formula_text(Path(file_path).resolve())
    label = _escape_excel_formula_text(display_text)
    return f'=HYPERLINK("{target}","{label}")'


def list_all_files_in_folder(folder_path, workbook, worksheet):
    # 获取文件夹的最大深度，用于动态设置列标题
    max_depth = 0
    for root, dirs, files in os.walk(folder_path):
        # 计算相对于根目录的深度
        relative_path = os.path.relpath(root, folder_path)
        if relative_path == '.':
            depth = 0
        else:
            depth = len(relative_path.split(os.sep))
        max_depth = max(max_depth, depth)

    # 设置标题行
    col = 0
    for i in range(max_depth + 1):
        worksheet.write(0, col, f'{i + 1}级文件夹')
        col += 1

    worksheet.write(0, col, '文件名称')
    col += 1
    worksheet.write(0, col, '超链接')
    col += 1
    worksheet.write(0, col, '文件路径')

    row = 1  # 从第二行开始写入数据，第一行是标题
    hyperlink_format = workbook.add_format({'font_color': 'blue', 'underline': 1})

    # 计算文件夹中的文件总数
    total_files = 0
    for root, dirs, files in os.walk(folder_path):
        total_files += len(files)

    # 递归遍历文件夹和子文件夹中的所有文件，并显示进度条
    with _NoopProgress(total=total_files, desc="正在列出文件") as pbar:
        for root, dirs, files in os.walk(folder_path):
            for file in files:
                file_path = os.path.join(root, file)
                file_name = os.path.basename(file_path)

                # 获取相对于根文件夹的路径
                relative_path = os.path.relpath(root, folder_path)

                col = 0

                # 如果是根目录
                if relative_path == '.':
                    # 只有根目录层级
                    worksheet.write(row, col, os.path.basename(folder_path))
                    col += 1
                else:
                    # 分割相对路径
                    folder_parts = relative_path.split(os.sep)

                    # 写入根文件夹名称
                    worksheet.write(row, col, os.path.basename(folder_path))
                    col += 1

                    # 写入子文件夹名称
                    for folder_name in folder_parts:
                        worksheet.write(row, col, folder_name)
                        col += 1

                # 填充剩余的文件夹列为空
                for _ in range(col, max_depth + 1):
                    worksheet.write(row, col, '')
                    col += 1

                # 写入文件名称
                worksheet.write(row, col, file_name)
                col += 1

                formula = _to_excel_hyperlink_formula(file_path, file_name)
                try:
                    worksheet.write_formula(row, col, formula, hyperlink_format, file_name)
                except ValueError:
                    worksheet.write(row, col, file_name)
                col += 1

                # 写入完整文件路径
                worksheet.write(row, col, file_path)

                row += 1
                pbar.update(1)  # 更新进度条


def choose_folder_and_save_file(root=None):
    own_root = root is None
    if own_root:
        root = tk.Tk()
    root.withdraw()  # 隐藏主窗口，仅作为对话框父窗口

    folder_path = filedialog.askdirectory(title="选择文件夹", parent=root)

    if folder_path:  # 如果用户选择了文件夹
        # 获取一级文件夹名称
        folder_name = os.path.basename(folder_path)

        # 获取当前日期和时间，格式化为年月日时分
        current_time = datetime.now()
        time_str = current_time.strftime("%Y%m%d%H%M")  # 格式如: 202512211827

        # 生成默认文件名
        default_filename = f"{folder_name}List-{time_str}.xlsx"

        # 获取用户选择的保存路径
        output_file = filedialog.asksaveasfilename(
            title="保存Excel文件",
            defaultextension=".xlsx",
            filetypes=[("Excel files", "*.xlsx")],
            initialfile=default_filename,  # 设置默认文件名
            initialdir=os.path.dirname(folder_path),  # 初始目录设为被选择文件夹的上级目录
            parent=root,
        )

        if output_file:  # 如果用户选择了文件路径
            # 创建一个新的Excel工作簿和工作表
            workbook = xlsxwriter.Workbook(output_file)
            worksheet = workbook.add_worksheet()

            # 列出所有文件
            list_all_files_in_folder(folder_path, workbook, worksheet)

            # 关闭工作簿
            workbook.close()
            print(f"文件路径已列出，并创建了超链接，保存在：{output_file}")
            messagebox.showinfo("导出完成", f"文件清单已导出到：\n{output_file}", parent=root)
        else:
            print("未选择保存路径。")
    else:
        print("未选择文件夹。")

    if own_root:
        root.destroy()


def main(root=None):
    try:
        choose_folder_and_save_file(root=root)
    finally:
        if root is not None and root.winfo_exists():
            root.destroy()


if __name__ == "__main__":
    main()
