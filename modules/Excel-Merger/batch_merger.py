import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import pandas as pd
import os
import threading
import warnings

# 忽略警告
warnings.filterwarnings("ignore")

# 尝试导入 xlsxwriter
try:
    import xlsxwriter
    HAS_XLSXWRITER = True
except ImportError:
    HAS_XLSXWRITER = False

# ==========================================
# V2.3: 页签选择弹窗 (保持 V2.2 逻辑不变)
# ==========================================
class SheetSelectDialog(tk.Toplevel):
    def __init__(self, parent, file_list, default_file_index):
        super().__init__(parent)
        self.title("检测到多Sheet - 请定义合并范围")
        self.geometry("500x600")
        self.transient(parent)
        self.grab_set()
        
        self.result_action = "cancel"
        self.selected_sheets = []
        self.file_list = file_list
        
        # 底部按钮
        f_bot = tk.Frame(self, pady=10, bg="#f0f0f0")
        f_bot.pack(side="bottom", fill="x")
        ttk.Button(f_bot, text="✅ 确定合并", command=self.on_confirm).pack(side="right", padx=20)
        ttk.Button(f_bot, text="取消", command=self.destroy).pack(side="right")
        
        # 1. 基准文件
        f_ref = tk.LabelFrame(self, text="1. 选择基准文件 (用于查看页签)", padx=10, pady=5)
        f_ref.pack(side="top", fill="x", padx=10, pady=5)
        
        self.excel_files = [f for f in file_list if f.lower().endswith(('.xlsx', '.xls'))]
        self.excel_basenames = [os.path.basename(f) for f in self.excel_files]
        
        self.cb_files = ttk.Combobox(f_ref, values=self.excel_basenames, state="readonly")
        self.cb_files.pack(fill="x", pady=5)
        self.cb_files.bind("<<ComboboxSelected>>", self.on_file_change)
        
        default_path = file_list[default_file_index]
        if default_path in self.excel_files:
            self.cb_files.current(self.excel_files.index(default_path))
        elif self.excel_files:
            self.cb_files.current(0)
            
        # 2. 合并模式
        f_mode = tk.LabelFrame(self, text="2. 合并逻辑", padx=10, pady=5)
        f_mode.pack(side="top", fill="x", padx=10, pady=5)
        
        self.var_mode = tk.StringVar(value="match")
        r1 = ttk.Radiobutton(f_mode, text="A. 按名称匹配 (勾选下方Sheet)", variable=self.var_mode, value="match", command=self.toggle_list)
        r1.pack(anchor="w")
        tk.Label(f_mode, text="   (仅提取所有文件中与勾选名称一致的Sheet)", fg="gray", font=("size", 8)).pack(anchor="w", pady=(0,5))
        
        r2 = ttk.Radiobutton(f_mode, text="B. 合并所有Sheet (无差别堆叠)", variable=self.var_mode, value="all", command=self.toggle_list)
        r2.pack(anchor="w")
        
        # 3. 列表区
        self.f_list = tk.LabelFrame(self, text="3. 请勾选目标Sheet (可多选)")
        self.f_list.pack(side="top", fill="both", expand=True, padx=10, pady=10)
        
        f_tool = tk.Frame(self.f_list)
        f_tool.pack(fill="x")
        ttk.Button(f_tool, text="全选", command=lambda: self.set_all(True), width=6).pack(side="left")
        ttk.Button(f_tool, text="全不选", command=lambda: self.set_all(False), width=6).pack(side="left")

        self.cvs = tk.Canvas(self.f_list)
        sb = ttk.Scrollbar(self.f_list, orient="vertical", command=self.cvs.yview)
        self.frm_inner = tk.Frame(self.cvs)
        self.cvs.create_window((0,0), window=self.frm_inner, anchor="nw")
        self.cvs.configure(yscrollcommand=sb.set)
        self.cvs.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.frm_inner.bind("<Configure>", lambda e: self.cvs.configure(scrollregion=self.cvs.bbox("all")))
        
        self.vars = {}
        self.refresh_sheet_list(self.excel_files[self.cb_files.current()])

    def on_file_change(self, event):
        idx = self.cb_files.current()
        if idx >= 0: self.refresh_sheet_list(self.excel_files[idx])

    def refresh_sheet_list(self, filepath):
        for w in self.frm_inner.winfo_children(): w.destroy()
        self.vars = {}
        try:
            xls = pd.ExcelFile(filepath)
            for sn in xls.sheet_names:
                v = tk.BooleanVar(value=True)
                self.vars[sn] = v
                tk.Checkbutton(self.frm_inner, text=sn, variable=v, anchor="w").pack(fill="x", padx=5)
            self.toggle_list()
        except Exception as e:
            tk.Label(self.frm_inner, text=f"读取失败: {e}", fg="red").pack()

    def toggle_list(self):
        state = "normal" if self.var_mode.get() == "match" else "disabled"
        for child in self.frm_inner.winfo_children(): child.configure(state=state)

    def set_all(self, val):
        for v in self.vars.values(): v.set(val)

    def on_confirm(self):
        if self.var_mode.get() == "all":
            self.result_action = "merge_all"
        else:
            self.result_action = "match_selected"
            self.selected_sheets = [k for k,v in self.vars.items() if v.get()]
            if not self.selected_sheets:
                return messagebox.showwarning("提示", "请至少勾选一个Sheet")
        self.destroy()

# ==========================================
# 主程序 V2.3 (增加目录索引功能)
# ==========================================
class BatchMergeApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Excel/CSV 批量智能合并工具 By CSDC      !!!大文件合并建议选CSV格式!!!")
        self.root.geometry("850x650")
        
        self.KEYWORDS = {
            "role_id": ["凭证编号", "凭证号", "单据号", "jenumber", "je number", "id", "序号", "No."],
            "role_acc": ["科目名称", "科目", "account", "gl account", "description", "摘要", "desc"],
            "role_date": ["日期", "date", "posting date", "doc date", "时间", "time"],
            "role_amt": ["金额", "amount", "amt", "本币金额", "余额", "balance", "money"],
            "role_dr": ["借方", "借方金额", "debit", "dr", "debit amount"],
            "role_cr": ["贷方", "贷方金额", "credit", "cr", "credit amount"],
            "role_entity": ["公司", "主体", "entity", "company", "unit", "部门", "dept"]
        }
        
        self.file_list = []
        self.var_mode = tk.StringVar(value="one_sheet")
        self.var_direction = tk.StringVar(value="vertical")
        self.var_smart_align = tk.BooleanVar(value=False)
        
        self.setup_ui()
        self.update_ui_state()

    def setup_ui(self):
        frame_top = tk.LabelFrame(self.root, text=" 1. 文件源 ", padx=10, pady=5)
        frame_top.pack(fill="both", expand=True, padx=10, pady=5)
        
        f_list = tk.Frame(frame_top)
        f_list.pack(side="left", fill="both", expand=True)
        self.lb_files = tk.Listbox(f_list, selectmode="extended", height=10, bg="#f9f9f9")
        sb = ttk.Scrollbar(f_list, orient="vertical", command=self.lb_files.yview)
        self.lb_files.configure(yscrollcommand=sb.set)
        self.lb_files.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        
        f_btns = tk.Frame(frame_top)
        f_btns.pack(side="right", fill="y", padx=10)
        ttk.Button(f_btns, text="➕ 添加文件", command=self.add_files).pack(fill="x", pady=3)
        ttk.Button(f_btns, text="📂 扫描文件夹", command=self.add_folder).pack(fill="x", pady=3)
        ttk.Separator(f_btns, orient="horizontal").pack(fill="x", pady=8)
        ttk.Button(f_btns, text="⬆️ 上移", command=lambda: self.move_item(-1)).pack(fill="x", pady=3)
        ttk.Button(f_btns, text="⬇️ 下移", command=lambda: self.move_item(1)).pack(fill="x", pady=3)
        ttk.Separator(f_btns, orient="horizontal").pack(fill="x", pady=8)
        ttk.Button(f_btns, text="➖ 移除选中", command=self.remove_files).pack(fill="x", pady=3)
        ttk.Button(f_btns, text="🗑️ 清空列表", command=self.clear_files).pack(fill="x", pady=3)
        
        self.lbl_status = tk.Label(frame_top, text="待处理: 0 个文件", fg="gray")
        self.lbl_status.pack(side="bottom", anchor="w", pady=(5,0))

        frame_mid = tk.LabelFrame(self.root, text=" 2. 合并规则 ", padx=10, pady=10)
        frame_mid.pack(fill="x", padx=10, pady=5)
        
        f_mode = tk.Frame(frame_mid)
        f_mode.pack(fill="x", pady=2)
        tk.Label(f_mode, text="输出目标：", font=("微软雅黑", 9, "bold")).pack(side="left")
        ttk.Radiobutton(f_mode, text="合并成一张大表 (One Sheet)", variable=self.var_mode, value="one_sheet", command=self.update_ui_state).pack(side="left", padx=15)
        ttk.Radiobutton(f_mode, text="合并成一个工作簿 (多Sheet)", variable=self.var_mode, value="one_workbook", command=self.update_ui_state).pack(side="left", padx=5)

        ttk.Separator(frame_mid, orient="horizontal").pack(fill="x", pady=10)

        self.f_opts = tk.Frame(frame_mid)
        self.f_opts.pack(fill="x")
        tk.Label(self.f_opts, text="拼接方向：", font=("微软雅黑", 9, "bold")).pack(side="left")
        self.rb_v = ttk.Radiobutton(self.f_opts, text="⬇️ 纵向堆叠 (上下拼)", variable=self.var_direction, value="vertical", command=self.update_ui_state)
        self.rb_v.pack(side="left", padx=10)
        self.rb_h = ttk.Radiobutton(self.f_opts, text="➡️ 横向拼接 (左右拼)", variable=self.var_direction, value="horizontal", command=self.update_ui_state)
        self.rb_h.pack(side="left", padx=10)
        
        ttk.Separator(self.f_opts, orient="vertical").pack(side="left", fill="y", padx=20)
        self.cb_smart = ttk.Checkbutton(self.f_opts, text="🧠 启用智能清洗 (合并表头)", variable=self.var_smart_align)
        self.cb_smart.pack(side="left")

        frame_bot = tk.Frame(self.root, pady=15)
        frame_bot.pack(fill="x", padx=15)
        self.pb = ttk.Progressbar(frame_bot, mode="indeterminate")
        self.pb.pack(fill="x", pady=5)
        btn_run = ttk.Button(frame_bot, text="🚀 开始执行合并", command=self.prepare_and_start)
        btn_run.pack(fill="x", ipady=5)

    def update_ui_state(self):
        mode = self.var_mode.get()
        children = self.f_opts.winfo_children()
        if mode == "one_workbook":
            for c in children: 
                try: c.configure(state="disabled")
                except: pass
        else:
            for c in children: 
                try: c.configure(state="normal")
                except: pass
            if self.var_direction.get() == "horizontal":
                self.cb_smart.configure(state="disabled")
                self.var_smart_align.set(False)

    # --- 文件操作 ---
    def add_files(self):
        files = filedialog.askopenfilenames(filetypes=[("表格文件", "*.xlsx *.xls *.csv *.txt")])
        for f in files:
            if f not in self.file_list:
                self.file_list.append(f)
                self.lb_files.insert(tk.END, os.path.basename(f))
        self.lbl_status.config(text=f"待处理: {len(self.file_list)} 个文件")

    def add_folder(self):
        folder = filedialog.askdirectory()
        if not folder: return
        for root, _, files in os.walk(folder):
            for f in files:
                if f.lower().endswith(('.xlsx', '.xls', '.csv', '.txt')):
                    full_path = os.path.join(root, f)
                    if full_path not in self.file_list:
                        self.file_list.append(full_path)
                        self.lb_files.insert(tk.END, f)
        self.lbl_status.config(text=f"待处理: {len(self.file_list)} 个文件")

    def remove_files(self):
        indices = list(self.lb_files.curselection())
        indices.reverse()
        for i in indices:
            self.lb_files.delete(i)
            del self.file_list[i]
        self.lbl_status.config(text=f"待处理: {len(self.file_list)} 个文件")

    def clear_files(self):
        self.file_list = []
        self.lb_files.delete(0, tk.END)
        self.lbl_status.config(text=f"待处理: 0 个文件")
    
    def move_item(self, direction):
        sel = self.lb_files.curselection()
        if not sel: return
        idx = sel[0]
        new_idx = idx + direction
        if 0 <= new_idx < len(self.file_list):
            val = self.file_list.pop(idx)
            self.file_list.insert(new_idx, val)
            self.lb_files.delete(0, tk.END)
            for f in self.file_list: self.lb_files.insert(tk.END, os.path.basename(f))
            self.lb_files.selection_set(new_idx)

    # --- 核心逻辑 ---
    def prepare_and_start(self):
        if not self.file_list:
            return messagebox.showwarning("提示", "请先添加需要合并的文件！")
        
        trigger_index = -1
        for i, f in enumerate(self.file_list):
            if f.lower().endswith(('.xlsx', '.xls')):
                try:
                    xls = pd.ExcelFile(f)
                    if len(xls.sheet_names) > 1:
                        trigger_index = i
                        break
                except: continue
        
        sheet_config = {"action": "default", "targets": []}
        if trigger_index != -1:
            dlg = SheetSelectDialog(self.root, self.file_list, trigger_index)
            self.root.wait_window(dlg)
            if dlg.result_action == "cancel": return
            sheet_config["action"] = dlg.result_action
            sheet_config["targets"] = dlg.selected_sheets
        
        save_path = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel文件", "*.xlsx"), ("CSV文件", "*.csv")])
        if not save_path: return

        self.pb.start(10)
        threading.Thread(target=self.run_process, args=(save_path, sheet_config), daemon=True).start()

    def run_process(self, save_path, sheet_config):
        try:
            mode = self.var_mode.get()
            
            # === 1. 多 Sheet 模式 (带 Reference) ===
            if mode == "one_workbook":
                if save_path.lower().endswith(".csv"):
                    raise Exception("多Sheet模式必须保存为 .xlsx 格式")
                
                with pd.ExcelWriter(save_path, engine="xlsxwriter" if HAS_XLSXWRITER else "openpyxl") as writer:
                    # 【核心更新】提前创建目录页，并记录目录数据
                    toc_data = [] # [(filename, sheet_name), ...]
                    
                    # 1. 如果使用 xlsxwriter，可以先预留一个Sheet位置
                    # 但为了简单，我们可以先遍历写数据，最后再把 Reference 页移动到最前？
                    # 不，xlsxwriter 写入顺序决定了显示顺序。
                    # 更好的方法：先创建一个空的 'Reference' 页
                    
                    if HAS_XLSXWRITER:
                        ws_ref = writer.book.add_worksheet('Reference')
                    
                    # 2. 写入数据页
                    for idx, fp in enumerate(self.file_list):
                        df_dict = self.load_all_sheets(fp, sheet_config)
                        if not df_dict: continue
                        f_base = self.clean_sheet_name(os.path.basename(fp))
                        
                        for sn, df in df_dict.items():
                            target = f"{f_base}_{sn}" if len(df_dict)>1 or sheet_config['action']!='default' else f_base
                            target = self.clean_sheet_name(target)
                            if target in writer.sheets: target = f"{target}_{idx}"
                            
                            # 写入数据
                            df.to_excel(writer, sheet_name=target, index=False)
                            
                            # 记录到目录
                            # 注意：Source File 显示原名，Sheet Name 显示最终名
                            toc_data.append({
                                "Source File": os.path.basename(fp),
                                "Target Sheet": target
                            })

                    # 3. 填充 Reference 页内容 (如果支持 xlsxwriter)
                    if HAS_XLSXWRITER and toc_data:
                        ws_ref = writer.sheets['Reference']
                        # 样式
                        fmt_head = writer.book.add_format({'bold':True, 'border':1, 'bg_color':'#D9D9D9', 'align':'center'})
                        fmt_link = writer.book.add_format({'font_color':'blue', 'underline':1, 'border':1})
                        fmt_norm = writer.book.add_format({'border':1})
                        
                        # 写表头
                        ws_ref.write(0, 0, "Source File Name", fmt_head)
                        ws_ref.write(0, 1, "Target Sheet Link", fmt_head)
                        ws_ref.set_column(0, 0, 40)
                        ws_ref.set_column(1, 1, 40)
                        
                        # 写内容
                        for i, item in enumerate(toc_data):
                            row = i + 1
                            ws_ref.write(row, 0, item["Source File"], fmt_norm)
                            # 写入超链接: internal:'SheetName'!A1
                            # 注意 Excel Sheet 名如果包含空格或特殊字符，需用单引号包裹
                            s_name = item["Target Sheet"]
                            link = f"internal:'{s_name}'!A1"
                            ws_ref.write_url(row, 1, link, fmt_link, string=s_name)
                        
                        # 激活 Reference 页为默认打开页
                        ws_ref.activate()

            # === 2. 单 Sheet 合并模式 ===
            else:
                direction = self.var_direction.get()
                use_smart = self.var_smart_align.get()
                dfs = []
                dfs_metadata = [] 
                
                is_physical = (direction == "vertical" and not use_smart)

                for fp in self.file_list:
                    f_base = os.path.basename(fp)
                    df_dict = self.load_all_sheets(fp, sheet_config, auto_header=(not is_physical))
                    if not df_dict: continue

                    for sn, df in df_dict.items():
                        if df.empty: continue
                        meta = {"path": fp, "fname": f_base, "sheet": sn, "rows": len(df), "cols": len(df.columns)}
                        
                        if direction == "horizontal":
                            df.reset_index(drop=True, inplace=True)
                            dfs.append(df)
                            dfs_metadata.append(meta)
                        elif direction == "vertical":
                            if use_smart: df = self.apply_smart_mapping(df)
                            if is_physical: df.columns = range(len(df.columns))
                            df.insert(0, "【来源文件】", f_base)
                            if len(df_dict)>1 or sheet_config['action']!='default':
                                df.insert(1, "【来源Sheet】", sn)
                            dfs.append(df)
                            dfs_metadata.append(meta)

                if not dfs: raise Exception("没有读取到有效数据")

                if direction == "horizontal":
                    keys = [f"{m['fname']} - {m['sheet']}" for m in dfs_metadata]
                    final_df = pd.concat(dfs, axis=1, keys=keys)
                else:
                    final_df = pd.concat(dfs, axis=0, ignore_index=True, sort=False)

                if save_path.lower().endswith(".csv"):
                    final_df.to_csv(save_path, index=False, header=(not is_physical), encoding="utf-8-sig")
                else:
                    with pd.ExcelWriter(save_path, engine='xlsxwriter') as writer:
                        if direction == "horizontal":
                            flat_df = final_df.copy()
                            flat_df.columns = flat_df.columns.get_level_values(1)
                            flat_df.to_excel(writer, sheet_name="合并结果", startrow=2, header=False, index=False)
                            ws = writer.sheets['合并结果']
                            fmt_h = writer.book.add_format({'bold':True, 'border':1, 'align':'center', 'bg_color':'#D7E4BC'})
                            fmt_l = writer.book.add_format({'font_color':'blue', 'underline':1, 'bold':True, 'border':1, 'align':'center', 'bg_color':'#D7E4BC'})
                            
                            start_col = 0
                            for meta in dfs_metadata:
                                w = meta['cols']
                                if w == 0: continue
                                display_name = meta['fname']
                                if sheet_config['action'] != 'default': display_name += f" ({meta['sheet']})"
                                for offset in range(w):
                                    try: ws.write_url(0, start_col+offset, f"external:{meta['path']}", fmt_l, string=display_name)
                                    except: ws.write(0, start_col+offset, display_name, fmt_h)
                                sub_df = dfs[dfs_metadata.index(meta)]
                                for c_i, c_name in enumerate(sub_df.columns):
                                    ws.write(1, start_col+c_i, str(c_name), fmt_h)
                                start_col += w
                        else:
                            final_df.to_excel(writer, sheet_name="合并结果", index=False, header=(not is_physical))
                            if HAS_XLSXWRITER:
                                ws = writer.sheets['合并结果']
                                link_fmt = writer.book.add_format({'font_color':'blue', 'underline':1})
                                current_row = 0 if is_physical else 1
                                for i, meta in enumerate(dfs_metadata):
                                    row_count = len(dfs[i]) 
                                    f_path = meta['path']; f_name = meta['fname']
                                    for _ in range(row_count):
                                        try: ws.write_url(current_row, 0, f"external:{f_path}", link_fmt, string=f_name)
                                        except: pass
                                        current_row += 1

            self.root.after(0, lambda: self.on_success(save_path))

        except Exception as e:
            err_msg = str(e); print(err_msg)
            self.root.after(0, lambda: self.on_error(err_msg))

    def load_all_sheets(self, fp, sheet_config, auto_header=True):
        result = {}
        try:
            if fp.lower().endswith(('.csv', '.txt')):
                df = self.load_single_sheet_data(fp, None, auto_header)
                if df is not None: result["CSV"] = df
                return result

            xls = pd.ExcelFile(fp)
            all_sheets = xls.sheet_names
            targets = []
            action = sheet_config.get("action", "default")
            
            if action == "match_selected":
                req = sheet_config.get("targets", [])
                targets = [s for s in all_sheets if s in req]
            elif action == "merge_all":
                targets = all_sheets
            else:
                targets = [all_sheets[0]]
            
            for s in targets:
                df = self.load_single_sheet_data(fp, s, auto_header)
                if df is not None: result[s] = df
            return result
        except: return {}

    def load_single_sheet_data(self, fp, sheet_name, auto_header):
        try:
            read_func = pd.read_csv if fp.lower().endswith(('.csv','.txt')) else pd.read_excel
            args = {'dtype': str}
            if sheet_name and not fp.lower().endswith(('.csv','.txt')): args['sheet_name'] = sheet_name
            
            if not auto_header:
                args['header'] = None
                if fp.lower().endswith(('.csv','.txt')):
                    try: return read_func(fp, encoding='utf-8-sig', **args)
                    except: return read_func(fp, encoding='gbk', **args)
                else: return read_func(fp, **args)

            p_args = args.copy(); p_args.update({'nrows':20, 'header':None})
            if fp.lower().endswith(('.csv','.txt')):
                try: df_p = read_func(fp, encoding='utf-8-sig', **p_args)
                except: df_p = read_func(fp, encoding='gbk', **p_args)
            else: df_p = read_func(fp, **p_args)
            
            if df_p.empty: return None
            s_r=0; s_c=0; found=False
            for r, row in df_p.iterrows():
                if row.isna().all(): continue
                idx = row.first_valid_index()
                if idx is not None: s_r=r; s_c=idx; found=True; break
            if not found: return None
            
            vals = df_p.iloc[s_r, s_c:]
            has_num = False
            for v in vals:
                if pd.isna(v): continue
                try: float(str(v).replace(',','')); has_num=True; break
                except: continue
            
            f_args = args.copy(); f_args.update({'skiprows':s_r, 'header':(None if has_num else 0)})
            if fp.lower().endswith(('.csv','.txt')):
                try: df = read_func(fp, encoding='utf-8-sig', **f_args)
                except: df = read_func(fp, encoding='gbk', **f_args)
            else: df = read_func(fp, **f_args)
            
            if s_c > 0: df = df.iloc[:, s_c:]
            return df
        except: return None

    def clean_sheet_name(self, filename):
        name = os.path.splitext(filename)[0]
        for char in '[]:*?/\\': name = name.replace(char, "_")
        return name[:31]

    def apply_smart_mapping(self, df):
        rename_map = {}
        cols_map = {c: str(c).lower().replace(" ", "").replace("_", "") for c in df.columns}
        for role, kws in self.KEYWORDS.items():
            t = f"【统一】{self.get_role_label(role)}"
            for col_o, col_c in cols_map.items():
                for kw in kws:
                    if kw.replace(" ", "") in col_c: rename_map[col_o] = t; break
                if col_o in rename_map: break
        if rename_map: df.rename(columns=rename_map, inplace=True)
        return df

    def get_role_label(self, role):
        m = {"role_id": "ID", "role_acc": "科目", "role_date": "日期", "role_amt": "金额", "role_dr": "借方", "role_cr": "贷方", "role_entity": "主体"}
        return m.get(role, role)

    def on_success(self, path):
        self.pb.stop()
        messagebox.showinfo("完成", f"合并成功！\n文件已保存至：\n{path}")
        
    def on_error(self, msg):
        self.pb.stop()
        messagebox.showerror("发生错误", msg)

if __name__ == "__main__":
    root = tk.Tk()
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except: pass
    app = BatchMergeApp(root)
    root.mainloop()