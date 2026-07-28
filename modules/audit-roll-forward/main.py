"""audit-toolbox adapter for Audit Roll Forward."""

from __future__ import annotations


def main(parent=None):
    """Launch the existing PyQt application from the audit-toolbox Hub.

    The Hub passes a Tk parent. Audit Roll Forward uses its own Qt window, so
    the parent is intentionally accepted for registry compatibility but is not
    embedded into Tk.
    """
    del parent
    from main_gui import main as launch

    return launch()


if __name__ == "__main__":
    main()
