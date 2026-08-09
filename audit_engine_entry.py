"""PyInstaller entry point for the versioned JSON Lines engine."""

import sys

if __name__ == "__main__":
    if "--job-worker" in sys.argv:
        from audit_engine.worker import main

        raise SystemExit(main())
    from audit_engine.main import serve

    raise SystemExit(serve())
