fn main() {
    tauri_build::build();
    // 依赖图中的对话框实现（rfd/muda 的 TaskDialogIndirect）要求 comctl32 v6。
    // tauri_build 只为正式 EXE 嵌入清单；cargo 生成的测试可执行文件没有清单，
    // 加载器会绑定 comctl32 v5，进程启动即报 STATUS_ENTRYPOINT_NOT_FOUND，
    // 导致全部 --lib 测试无法运行。这里为测试/示例产物补一份 Common-Controls 6
    // 的清单依赖（不影响 bin，避免与 tauri 内嵌清单重复）。
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'"
    );
}
