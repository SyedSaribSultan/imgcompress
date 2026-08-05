"""imgcompress - quality-targeted image compression for design assets."""

from .core import CompressionResult, Settings, compress, compress_file, compress_tree, write_result

__all__ = [
    "CompressionResult",
    "Settings",
    "compress",
    "compress_file",
    "compress_tree",
    "write_result",
]
__version__ = "2.3.0"
