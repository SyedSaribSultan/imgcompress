"""Local HTTP server behind the desktop UI.

Standard library only - no Flask, no FastAPI, no uvicorn. A tool people install
to compress a folder of images should not drag a web framework along with it,
and `http.server` is entirely adequate for one user on localhost.

Bound to 127.0.0.1 and gated on a per-run token, so nothing else on the machine
(or the network) can drive it.
"""

from __future__ import annotations

import io
import json
import mimetypes
import os
import queue
import re
import secrets
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from PIL import Image

from . import __version__
from . import destinations as dest
from . import encoders as enc
from .core import (
    SUPPORTED_SUFFIXES,
    CompressionResult,
    Settings,
    compress,
    iter_images,
    write_result,
)
from .quality import HAVE_SSIMULACRA2

WEBUI = Path(__file__).resolve().parent / "webui"
PREVIEW_MAX = 2800

# Uploads land fully in memory before hitting the temp dir; no legitimate
# design asset justifies more than this.
MAX_BODY = 512 * 1024 * 1024

# Characters Windows refuses in filenames, plus control characters.
_BAD_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #


@dataclass
class Item:
    id: str
    path: str
    name: str
    original_bytes: int = 0
    status: str = "queued"  # queued | working | done | failed | saved
    new_bytes: int = 0
    fmt: str = ""
    level: int | None = None
    score: float | None = None
    metric: str = ""
    width: int = 0
    height: int = 0
    out_width: int = 0
    out_height: int = 0
    candidates: list[dict] = field(default_factory=list)
    note: str = ""
    error: str = ""
    warnings: list[str] = field(default_factory=list)
    override: dict | None = None
    saved_to: str = ""
    temporary: bool = False
    """True when the bytes were uploaded rather than read from a real path."""

    def public(self) -> dict:
        out = asdict(self)
        out["saved_pct"] = (
            100.0 * (self.original_bytes - self.new_bytes) / self.original_bytes
            if self.original_bytes and self.new_bytes
            else 0.0
        )
        return out


class Session:
    """Everything the UI is looking at. One per running app."""

    def __init__(self, workers: int = 0):
        self.lock = threading.RLock()
        self.items: dict[str, Item] = {}
        self.order: list[str] = []
        self.results: dict[str, CompressionResult] = {}
        self.previews: dict[str, bytes] = {}
        self.settings = {
            "target": dest.DEFAULT,
            "quality_target": 90.0 if HAVE_SSIMULACRA2 else 0.97,
            "max_dimension": dest.get(dest.DEFAULT).max_dimension,
            "metric": "ssimulacra2" if HAVE_SSIMULACRA2 else "ssim",
            "fast": False,
            "keep_metadata": False,
        }
        # Deliberately empty: saving somewhere the user never chose is worse
        # than one extra click the first time.
        self.last_folder = ""
        self.watch_folder = ""
        self.watch_seen: set = set()
        self.rev = 0
        self.toast = ""

        self.queue: queue.Queue[str] = queue.Queue()
        count = workers or max(1, min(6, (os.cpu_count() or 2)))
        self.workers = [
            threading.Thread(target=self._worker, daemon=True, name=f"imgcompress-{i}")
            for i in range(count)
        ]
        for w in self.workers:
            w.start()
        threading.Thread(target=self._watcher, daemon=True, name="watch").start()

    # -- mutation ---------------------------------------------------------- #

    def touch(self, toast: str = "") -> None:
        with self.lock:
            self.rev += 1
            if toast:
                self.toast = toast

    def snapshot(self) -> dict:
        with self.lock:
            items = [self.items[i].public() for i in self.order if i in self.items]
            toast, self.toast = self.toast, ""
            active = sum(1 for i in items if i["status"] in ("queued", "working"))
            done = [i for i in items if i["status"] in ("done", "saved")]
            return {
                "rev": self.rev,
                "version": __version__,
                "items": items,
                "settings": dict(self.settings),
                # The interface builds its destination list from this rather
                # than carrying its own copy. One table, no drift.
                #
                # `formats` is what this machine can actually write, not what
                # the destination would like to - a tooltip promising AVIF on a
                # Pillow built without libavif is a promise the engine cannot
                # keep, and the person would only find out by its absence.
                "destinations": [
                    {"name": d.name, "label": d.label, "help": d.help,
                     "formats": enc.usable(d.formats), "max_dimension": d.max_dimension,
                     "quality_target": d.ss2_target if HAVE_SSIMULACRA2 else d.ssim_target}
                    for d in dest.visible()
                ],
                "watch_folder": self.watch_folder,
                "last_folder": self.last_folder,
                "engines": {**enc.capabilities(), "ssimulacra2 (perceptual metric)": HAVE_SSIMULACRA2},
                "busy": active > 0,
                "totals": {
                    "count": len(items),
                    "done": len(done),
                    "before": sum(i["original_bytes"] for i in done),
                    "after": sum(i["new_bytes"] for i in done),
                    "unsaved": sum(1 for i in items if i["status"] == "done"),
                },
                "toast": toast,
            }

    def add_path(self, path: Path, temporary: bool = False) -> list[str]:
        added = []
        paths = [path] if path.is_file() else list(iter_images(path))
        with self.lock:
            existing = {self.items[i].path for i in self.order if i in self.items}
            for p in paths:
                if p.suffix.lower() not in SUPPORTED_SUFFIXES:
                    continue
                if str(p) in existing:
                    continue
                item = Item(
                    id=secrets.token_hex(8),
                    path=str(p),
                    name=p.name,
                    temporary=temporary,
                )
                try:
                    item.original_bytes = p.stat().st_size
                    with Image.open(p) as im:
                        item.width, item.height = im.size
                except Exception as exc:
                    item.status = "failed"
                    item.error = f"{type(exc).__name__}: {exc}"
                self.items[item.id] = item
                self.order.append(item.id)
                added.append(item.id)
        for item_id in added:
            if self.items[item_id].status == "queued":
                self.queue.put(item_id)
        self.touch()
        return added

    def remove(self, ids: list[str]) -> None:
        with self.lock:
            for item_id in ids:
                item = self.items.pop(item_id, None)
                self.results.pop(item_id, None)
                self.previews.pop(item_id, None)
                if item_id in self.order:
                    self.order.remove(item_id)
                if item and item.temporary:
                    try:
                        Path(item.path).unlink(missing_ok=True)
                    except OSError:
                        pass
        self.touch()

    def requeue(self, ids: list[str]) -> None:
        with self.lock:
            for item_id in ids:
                item = self.items.get(item_id)
                if not item:
                    continue
                item.status = "queued"
                item.error = ""
                item.warnings = []
                item.note = ""
                item.candidates = []
        for item_id in ids:
            self.queue.put(item_id)
        self.touch()

    def settings_for(self, item: Item) -> Settings:
        merged = dict(self.settings)
        merged.update(item.override or {})
        formats = merged.pop("formats", None) or None
        # An older session's saved target may be a pre-2.7 name; resolve it
        # rather than letting `figma` reach the engine as an unknown place.
        going_to = dest.resolve(merged.get("target") or dest.DEFAULT)
        if not dest.exists(going_to):
            going_to = dest.DEFAULT
        return Settings(
            target=going_to,
            max_dimension=int(merged.get("max_dimension", 2560)),
            metric=merged.get("metric", ""),
            quality_target=float(merged["quality_target"]) if merged.get("quality_target") is not None else None,
            keep_metadata=bool(merged.get("keep_metadata", False)),
            fast=bool(merged.get("fast", False)),
            formats=formats,
        )

    # -- workers ----------------------------------------------------------- #

    def _worker(self) -> None:
        while True:
            item_id = self.queue.get()
            try:
                self._run_one(item_id)
            except Exception:
                traceback.print_exc()
            finally:
                self.queue.task_done()

    def _run_one(self, item_id: str) -> None:
        with self.lock:
            item = self.items.get(item_id)
            if not item or item.status != "queued":
                return
            item.status = "working"
            settings = self.settings_for(item)
        self.touch()

        result = compress(Path(item.path), settings)

        with self.lock:
            item = self.items.get(item_id)
            if not item:
                return
            if result.error:
                item.status = "failed"
                item.error = result.error
            else:
                self.results[item_id] = result
                item.status = "done"
                item.new_bytes = result.new_bytes
                item.fmt = result.fmt or Path(item.path).suffix.lstrip(".")
                item.level = result.level
                item.score = result.score
                item.metric = result.metric
                item.note = result.note
                item.warnings = list(result.warnings)
                item.candidates = [
                    {"format": c[0], "bytes": c[1], "score": c[2]} for c in result.candidates
                ]
                if result.resized_to:
                    item.out_width, item.out_height = result.resized_to
                else:
                    item.out_width, item.out_height = item.width, item.height
        self.touch()

    # -- folder watching --------------------------------------------------- #

    def _watcher(self) -> None:
        while True:
            time.sleep(2.0)
            folder = self.watch_folder
            if not folder:
                continue
            try:
                found = [p for p in Path(folder).iterdir()
                         if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES]
            except OSError:
                continue
            fresh = [p for p in found if str(p) not in self.watch_seen]
            for p in fresh:
                self.watch_seen.add(str(p))
            if fresh:
                for p in sorted(fresh):
                    self.add_path(p)
                self.touch(f"Picked up {len(fresh)} new file(s) from the watched folder")

    def set_watch(self, folder: str) -> None:
        self.watch_folder = folder or ""
        self.watch_seen = set()
        if folder:
            try:
                # Everything already there is "old" - only react to new arrivals.
                self.watch_seen = {
                    str(p) for p in Path(folder).iterdir()
                    if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES
                }
            except OSError:
                pass
        self.touch()

    # -- previews and saving ----------------------------------------------- #

    def preview_before(self, item_id: str) -> bytes | None:
        with self.lock:
            cached = self.previews.get(item_id)
            item = self.items.get(item_id)
        if cached:
            return cached
        if not item:
            return None
        try:
            with Image.open(item.path) as im:
                im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
                if max(im.size) > PREVIEW_MAX:
                    scale = PREVIEW_MAX / max(im.size)
                    im = im.resize((round(im.width * scale), round(im.height * scale)),
                                   Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, "PNG", compress_level=1)
                data = buf.getvalue()
        except Exception:
            return None
        with self.lock:
            self.previews[item_id] = data
        return data

    def result_bytes(self, item_id: str) -> tuple | None:
        with self.lock:
            result = self.results.get(item_id)
            item = self.items.get(item_id)
        if not result or not result.data or not item:
            return None
        return result.data, item.fmt

    def save(self, folder: str, ids: list[str] | None = None) -> dict:
        destination = Path(folder).expanduser()
        written, failed = [], []
        with self.lock:
            targets = ids or [i for i in self.order
                              if self.items.get(i) and self.items[i].status == "done"]
        for item_id in targets:
            with self.lock:
                result = self.results.get(item_id)
                item = self.items.get(item_id)
            if not result or not item:
                continue
            try:
                out = write_result(result, destination)
                with self.lock:
                    item.status = "saved"
                    item.saved_to = str(out)
                written.append(str(out))
            except Exception as exc:
                failed.append(f"{item.name}: {exc}")
        self.last_folder = str(destination)
        self.touch(
            f"Saved {len(written)} file(s) to {destination}" if written
            else "Nothing to save"
        )
        return {"written": written, "failed": failed}


# --------------------------------------------------------------------------- #
# native folder picker (stdlib tkinter, optional)
# --------------------------------------------------------------------------- #


def pick_folder(initial: str = "") -> str:
    """Open the OS folder chooser. Returns "" if unavailable or cancelled."""
    try:
        import tkinter
        from tkinter import filedialog
    except Exception:
        return ""
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(initialdir=initial or str(Path.home()))
        root.destroy()
        return chosen or ""
    except Exception:
        return ""


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


class Handler(BaseHTTPRequestHandler):
    server_version = f"imgcompress/{__version__}"
    session: Session = None  # type: ignore[assignment]
    token: str = ""
    upload_dir: Path = None  # type: ignore[assignment]
    on_quit = None

    def log_message(self, *args):  # silence the console
        pass

    # -- helpers ----------------------------------------------------------- #

    def _send(self, code: int, body: bytes, content_type: str, extra: dict = None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload, code: int = 200):
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json")

    def _host_ok(self) -> bool:
        """Refuse requests whose Host isn't loopback.

        This is the DNS-rebinding defence: a hostile page can point its own
        domain at 127.0.0.1 and drive this server same-origin — and `GET /`
        would even hand it the token. A browser always sends the Host it
        connected to, so rejecting foreign names closes the hole.
        """
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):  # ipv6 literal, e.g. [::1]:8000
            host = host.split("]", 1)[0] + "]"
        else:
            host = host.split(":", 1)[0]
        return host in ("127.0.0.1", "localhost", "[::1]")

    def _authorised(self, query: dict) -> bool:
        if not self.token:
            return True
        supplied = self.headers.get("X-Token") or (query.get("token") or [""])[0]
        return secrets.compare_digest(supplied, self.token)

    def _body(self) -> bytes | None:
        """Request body, or None when it is missing a sane length."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length) if length else b""

    def _json_body(self) -> dict:
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {}

    # -- routes ------------------------------------------------------------ #

    def do_GET(self):  # noqa: N802
        if not self._host_ok():
            return self._json({"error": "forbidden host"}, 403)
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        route = parsed.path

        if route in ("/", "/index.html"):
            html = (WEBUI / "app.html").read_bytes()
            html = html.replace(b"__TOKEN__", self.token.encode("ascii"))
            return self._send(200, html, "text/html; charset=utf-8")

        if not self._authorised(query):
            return self._json({"error": "unauthorised"}, 403)

        if route == "/api/state":
            return self._json(self.session.snapshot())

        if route.startswith("/api/image/"):
            parts = route.split("/")
            if len(parts) != 5:
                return self._json({"error": "bad path"}, 404)
            item_id, which = parts[3], parts[4]
            if which == "before":
                data = self.session.preview_before(item_id)
                if data is None:
                    return self._json({"error": "not found"}, 404)
                return self._send(200, data, "image/png")
            found = self.session.result_bytes(item_id)
            if not found:
                return self._json({"error": "not found"}, 404)
            data, fmt = found
            mime = {"jpeg": "image/jpeg", "png8": "image/png", "png": "image/png",
                    "webp": "image/webp", "webp-lossless": "image/webp"}.get(fmt, "image/png")
            return self._send(200, data, mime)

        if route.startswith("/webui/"):
            candidate = (WEBUI / unquote(route[len("/webui/"):])).resolve()
            if WEBUI.resolve() in candidate.parents and candidate.is_file():
                mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
                return self._send(200, candidate.read_bytes(), mime)

        return self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        if not self._host_ok():
            return self._json({"error": "forbidden host"}, 403)
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if not self._authorised(query):
            return self._json({"error": "unauthorised"}, 403)
        route = parsed.path
        session = self.session

        if route == "/api/upload":
            name = unquote(self.headers.get("X-Filename", "upload.png"))
            safe = _BAD_FILENAME.sub("_", Path(name.replace("\x00", "")).name) or "upload.png"
            data = self._body()
            if data is None:
                return self._json({"error": "file too large"}, 413)
            if not data:
                return self._json({"error": "empty upload"}, 400)
            self.upload_dir.mkdir(parents=True, exist_ok=True)
            target = self.upload_dir / safe
            stem, suffix, n = target.stem, target.suffix, 1
            while target.exists():
                target = self.upload_dir / f"{stem} ({n}){suffix}"
                n += 1
            target.write_bytes(data)
            return self._json({"added": session.add_path(target, temporary=True)})

        payload = self._json_body()

        if route == "/api/add":
            added = []
            for raw in payload.get("paths", []):
                path = Path(raw).expanduser()
                if path.exists():
                    added += session.add_path(path)
            if not added:
                session.touch("Nothing new to add - those files are already queued")
            return self._json({"added": added})

        if route == "/api/settings":
            with session.lock:
                session.settings.update(payload.get("settings", {}))
                ids = [i for i in session.order
                       if session.items.get(i) and session.items[i].status != "working"]
            if payload.get("recompress", True):
                session.requeue(ids)
            session.touch()
            return self._json({"ok": True})

        if route == "/api/override":
            item_id = payload.get("id", "")
            with session.lock:
                item = session.items.get(item_id)
                if not item:
                    return self._json({"error": "unknown item"}, 404)
                item.override = payload.get("override") or None
            session.requeue([item_id])
            return self._json({"ok": True})

        if route == "/api/remove":
            session.remove(payload.get("ids", []))
            return self._json({"ok": True})

        if route == "/api/clear":
            with session.lock:
                ids = list(session.order)
            session.remove(ids)
            session.touch("Cleared")
            return self._json({"ok": True})

        if route == "/api/retry":
            session.requeue(payload.get("ids", []))
            return self._json({"ok": True})

        if route == "/api/pick-folder":
            chosen = pick_folder(payload.get("initial") or session.last_folder)
            if chosen:
                session.last_folder = chosen
            return self._json({"folder": chosen})

        if route == "/api/watch":
            session.set_watch(payload.get("folder", ""))
            return self._json({"ok": True})

        if route == "/api/save":
            folder = payload.get("folder") or ""
            if not folder:
                return self._json({"error": "no folder"}, 400)
            return self._json(session.save(folder, payload.get("ids")))

        if route == "/api/quit":
            if self.on_quit:
                threading.Timer(0.2, self.on_quit).start()
            return self._json({"ok": True})

        return self._json({"error": "not found"}, 404)


def serve(host: str = "127.0.0.1", port: int = 0, workers: int = 0):
    """Start the server. Returns (httpd, session, url)."""
    import tempfile

    session = Session(workers=workers)
    token = secrets.token_urlsafe(16)
    upload_dir = Path(tempfile.mkdtemp(prefix="imgcompress-"))

    class Bound(Handler):
        pass

    Bound.session = session
    Bound.token = token
    Bound.upload_dir = upload_dir

    httpd = ThreadingHTTPServer((host, port), Bound)
    httpd.daemon_threads = True
    Bound.on_quit = httpd.shutdown
    url = f"http://{host}:{httpd.server_address[1]}/?token={token}"
    return httpd, session, url
