import multiprocessing

from .main import serve

multiprocessing.freeze_support()
raise SystemExit(serve())
