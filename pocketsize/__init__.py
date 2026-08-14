"""Pocketsize - quality-targeted image compression for design assets."""

import multiprocessing as _multiprocessing

from .core import CompressionResult, Settings, compress, compress_file, compress_tree, write_result

# Must run before anything creates a process pool, and it belongs here rather
# than in one entry point because there are three ways in: the `pocketsize`
# command, the `pocketsize-gui` command, and `import pocketsize` from
# somebody else's script.
#
# `compress_tree` uses a ProcessPoolExecutor, and under the spawn start method -
# always on Windows, the default on macOS since 3.8 - each worker re-executes
# the program in order to import the module it needs. In a normal install that
# re-execution is a fresh `python`, and harmless. In a frozen bundle there is no
# python to re-execute: the child runs the application's own executable again,
# which starts a whole new Pocketsize, which opens a pool of its own. A folder
# of images becomes a fork bomb.
#
# It stayed hidden because `compress_tree` takes a single-process path when there
# is only one job, so every one-image smoke test passes. Only a real folder shows
# it, and only in a build nobody had made yet.
#
# A no-op on any non-frozen interpreter, and cheap enough not to guard.
_multiprocessing.freeze_support()

__all__ = [
    "CompressionResult",
    "Settings",
    "compress",
    "compress_file",
    "compress_tree",
    "write_result",
]
__version__ = "2.7.0"
