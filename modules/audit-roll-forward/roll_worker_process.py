"""Run one existing roll-forward subject in an isolated process."""

import traceback

from roll_forward_core import process_multiple_subjects


def run_rollforward_process(connection, request):
    """Execute the unchanged core entry point and stream progress to the GUI."""
    try:
        subject_code = request["subject_code"]

        def progress_callback(current, total, message):
            connection.send(("progress", current, total, message))

        results = process_multiple_subjects(
            [subject_code],
            request["template_dir"],
            request["prior_dir"],
            None,
            request["company_name"],
            request["bs_date"],
            request["output_dir"],
            functional_currency=request.get("functional_currency"),
            accounting_standard=request.get("accounting_standard"),
            pm_value=request.get("pm_value"),
            te_value=request.get("te_value"),
            sad_value=request.get("sad_value"),
            cra_records=request.get("cra_records") or [],
            roll_forward_wording=bool(request.get("roll_forward_wording", False)),
            generate_summary=bool(request.get("generate_summary", True)),
            llm_enhanced=bool(request.get("llm_enhanced", False)),
            llm_wording_revision=bool(request.get("llm_wording_revision", False)),
            llm_options=request.get("llm_options") or {},
            progress_callback=progress_callback,
        )
        connection.send(("result", results))
    except BaseException:
        connection.send(("fatal", traceback.format_exc()))
    finally:
        connection.close()
