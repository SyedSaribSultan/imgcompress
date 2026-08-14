#!/usr/bin/env python3
"""Entry point: python compress.py [source] [-o output] [options]"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pocketsize.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
