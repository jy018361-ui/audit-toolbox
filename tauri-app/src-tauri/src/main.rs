fn main() {
    if std::env::args().any(|arg| arg == "--excel-merger-worker" || arg == "--rust-table-worker") {
        std::process::exit(audit_toolbox_lib::run_excel_merger_worker());
    }
    audit_toolbox_lib::run();
}
