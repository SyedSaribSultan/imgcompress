"""Launcher for the desktop UI.

Opens a real application window when `pywebview` is installed, and falls back to
the default browser otherwise. Both paths talk to the same local server, so the
fallback is a full-featured app rather than a degraded mode - which is why this
is a soft dependency rather than a hard one.
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from . import __version__
from .server import serve


def _run_window(url: str, on_close=None) -> bool:
    try:
        import webview  # type: ignore
    except ImportError:
        return False
    try:
        window = webview.create_window(
            "Image Compressor",
            url,
            width=1280,
            height=840,
            min_size=(880, 600),
            background_color="#16171A",
        )
        if on_close:
            window.events.closed += on_close
        webview.start(debug=False)
        return True
    except Exception as exc:  # a window that won't open is not a fatal error
        print(f"Could not open an app window ({exc}); falling back to the browser.")
        return False


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="imgcompress-gui",
        description="Open the Image Compressor desktop interface.",
    )
    parser.add_argument("paths", nargs="*", help="files or folders to queue on launch")
    parser.add_argument("--port", type=int, default=0, help="port to bind (default: any free port)")
    parser.add_argument("--browser", action="store_true",
                        help="always use the browser, never an app window")
    parser.add_argument("--no-open", action="store_true",
                        help="just start the server and print the URL")
    parser.add_argument("-j", "--workers", type=int, default=0,
                        help="parallel compression workers (default: auto)")
    parser.add_argument("--version", action="version", version=f"imgcompress {__version__}")
    args = parser.parse_args(argv)

    httpd, session, url = serve(port=args.port, workers=args.workers)
    threading.Thread(target=httpd.serve_forever, daemon=True, name="http").start()

    for raw in args.paths:
        from pathlib import Path

        path = Path(raw).expanduser()
        if path.exists():
            session.add_path(path)

    print(f"Image Compressor {__version__}")
    print(f"  {url}")

    if args.no_open:
        print("  (leave this window open; press Ctrl+C to stop)")
        try:
            while True:
                threading.Event().wait(3600)
        except KeyboardInterrupt:
            pass
        return 0

    opened = False
    if not args.browser:
        opened = _run_window(url, on_close=httpd.shutdown)

    if not opened:
        webbrowser.open(url)
        print("  Opened in your browser. Close this window to quit.")
        print("  Tip: pip install pywebview  -  to get a real app window instead.")
        try:
            while True:
                threading.Event().wait(3600)
        except KeyboardInterrupt:
            print("\nBye.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
