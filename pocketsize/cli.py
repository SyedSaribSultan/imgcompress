"""Command line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__, video
from . import destinations as dest
from . import encoders as enc
from .core import CompressionResult, Settings, compress_tree
from .quality import HAVE_SSIMULACRA2, get_metric


def human(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024.0 or unit == "GB":
            return f"{value:,.0f} {unit}" if unit == "B" else f"{value:,.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} GB"


_UNITS = {"b": 1, "k": 1024, "kb": 1024, "m": 1024**2, "mb": 1024**2,
          "g": 1024**3, "gb": 1024**3}


def parse_size(text: str) -> int:
    """`200kb`, `1.5MB`, `480000` -> bytes. Raises ValueError on anything else.

    Spelled in the units people actually think in. A byte ceiling typed as a
    raw byte count is a number nobody has in their head; the limit they were
    given is almost always in KB or MB.
    """
    cleaned = str(text).strip().lower().replace(" ", "").replace(",", "")
    for suffix in sorted(_UNITS, key=len, reverse=True):
        if cleaned.endswith(suffix):
            cleaned = cleaned[: -len(suffix)]
            scale = _UNITS[suffix]
            break
    else:
        scale = 1
    value = float(cleaned)          # ValueError here is the caller's answer
    if value <= 0:
        raise ValueError("size must be greater than zero")
    return int(value * scale)


def describe(res: CompressionResult, verbose: bool = False) -> str:
    name = res.source.name
    if res.error:
        return f"  !  {name}  ({res.error})"
    if res.skipped:
        return f"  =  {name}  {human(res.original_bytes)}  ({res.note})"

    bits = [f"{human(res.original_bytes)} -> {human(res.new_bytes)}", f"-{res.saved_pct:.0f}%"]
    bits.append(res.fmt)
    if res.resized_to:
        bits.append(f"{res.resized_from[0]}x{res.resized_from[1]}"
                    f" -> {res.resized_to[0]}x{res.resized_to[1]}")
    # The encoder level is an implementation detail: it means nothing without
    # knowing which ladder it came from, it is not comparable between formats,
    # and it is not something anyone can act on. Kept for --verbose, where the
    # whole point is to see the internals, and out of the ordinary line.
    if verbose and res.level is not None:
        bits.append(f"q{res.level}")
    if res.score is not None:
        fmt = "{:.1f}" if res.metric == "ssimulacra2" else "{:.4f}"
        label = "visual match" if res.metric == "ssimulacra2" else res.metric
        bits.append(f"{label} " + fmt.format(res.score))
    line = f"  ok {name}  " + "  ".join(bits)
    if verbose and res.candidates:
        losers = "   ".join(f"{c}={human(s)}" for c, s, _ in sorted(res.candidates, key=lambda x: x[1]))
        line += f"\n       versions tried: {losers}"
    for warning in res.warnings:
        line += f"\n     ! {warning}"
    return line


def describe_video(res, verbose: bool = False) -> str:
    """One line for one video, in the same shape as the image line.

    The differences are the ones a person would ask about: how long it was,
    whether the sound was touched, and - when a size limit is what decided the
    answer - that the picture is not as sharp as the original. That last one
    goes on this line and not a later one, for the same reason resizing does:
    a disclosure that arrives after the number has already been read is not a
    disclosure.
    """
    name = res.source.name
    if res.error:
        return f"  !  {name}  ({res.error})"
    if res.skipped:
        return f"  =  {name}  {human(res.original_bytes)}  ({res.note})"

    bits = [f"{human(res.original_bytes)} -> {human(res.new_bytes)}",
            f"-{res.saved_pct:.0f}%", res.fmt]
    if res.resized_to:
        bits.append(f"{res.resized_from[0]}x{res.resized_from[1]}"
                    f" -> {res.resized_to[0]}x{res.resized_to[1]}")
    if verbose and res.level:
        bits.append(f"crf{res.level}")
    bits.append(f"visual match {res.score:.1f}")
    if verbose and res.witness:
        bits.append(f"xpsnr {res.witness:.1f}dB")
    line = f"  ok {name}  " + "  ".join(bits)
    if res.capped:
        line += "\n       not as sharp as the original, to fit the size limit"
    if res.audio_note:
        line += f"\n       {res.audio_note}"
    if verbose and res.candidates:
        losers = "   ".join(
            f"{c}={human(s)}" for c, s, _ in sorted(res.candidates,
                                                    key=lambda x: x[1])
        )
        line += f"\n       versions tried: {losers}"
    for warning in res.warnings:
        line += f"\n     ! {warning}"
    return line


def iter_videos(root: Path, recursive: bool = True):
    if root.is_file():
        return [root] if video.is_video_path(root) else []
    walk = root.rglob("*") if recursive else root.glob("*")
    return sorted(
        p for p in walk if p.is_file() and video.is_video_path(p)
    )


def destination_help() -> str:
    """The five destinations, spelled out, for the bottom of --help.

    Deliberately ASCII: this prints to a Windows console under cp1252 as often
    as not, and a middot that arrives as a replacement character undoes the
    point of writing readable help.
    """
    lines = ["where the image is going:"]
    for d in dest.visible():
        head = f"  --for {d.name}"
        size = f"up to {d.max_dimension}px" if d.max_dimension else "never resized"
        lines.append(f"{head.ljust(20)} {d.label}")
        lines.append(f"{' ' * 20} {d.help}")
        lines.append(f"{' ' * 20} {', '.join(d.formats)}"
                     f" | {size} | visual match {d.ss2_target:g}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    here = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        prog="pocketsize",
        description=(
            "Make images as small as they go without you being able to see the "
            "difference. Each image is written several ways, every version is "
            "measured against the original, and the smallest one that still "
            "looks close enough is the one you get."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            destination_help() + "\n\n"
            "examples:\n"
            "  pocketsize                           ./input -> ./output\n"
            "  pocketsize photos/ -o small/         compress a folder\n"
            "  pocketsize hero.png --for documents  safe to import into a design tool\n"
            "  pocketsize input/ --for email        small enough to attach\n"
            "  pocketsize input/ -q 95              hold a higher visual match\n"
            "  pocketsize scans/ --lossless         never change a pixel\n"
            "  pocketsize hero.jpg --under 200KB    best quality that fits a limit\n"
            "  pocketsize input/ --fit width -m 1600   pin every image to 1600px wide\n"
            "  pocketsize input/ --fast             quicker, slightly bigger\n"
            "  pocketsize --check                   show which engines are active\n"
        ),
    )
    parser.add_argument("source", nargs="?", default=str(here / "input"),
                        help="file or folder to compress (default: ./input)")
    parser.add_argument("-o", "--output", default=str(here / "output"),
                        help="where to write the results (default: ./output)")
    # Validated by hand rather than with `choices`, so that the older names go
    # on working without argparse listing them back at anyone who mistypes.
    parser.add_argument("--for", "--preset", dest="destination",
                        default=dest.DEFAULT, metavar="DESTINATION",
                        help="where the image is going: "
                             + " | ".join(dest.names())
                             + f" (default: {dest.DEFAULT}). Sets the formats, the size "
                               "cap and the minimum visual match; see the list below")
    # Kept working for scripts written against 2.6 and earlier, where `--target`
    # chose the format list and `--preset` chose size and quality. Both now name
    # the same thing, so both land here. Not advertised.
    parser.add_argument("--target", dest="legacy_target", default=None,
                        help=argparse.SUPPRESS)
    parser.add_argument("-m", "--max-dimension", type=int,
                        help="cap an edge in pixels. 0 keeps the original size")
    parser.add_argument("--fit", choices=["longest", "width", "height"],
                        default="longest",
                        help="which edge -m caps (default: longest). Aspect ratio is "
                             "always kept, and an image already inside the limit is "
                             "left alone rather than enlarged")
    parser.add_argument("--under", dest="size_target", metavar="SIZE",
                        help="hold the file under this size and spend whatever room "
                             "is left on quality, e.g. 200KB or 1.5MB. Without it the "
                             "search runs the other way: the smallest file that still "
                             "clears -q")
    parser.add_argument("-q", "--quality-target", type=float,
                        help="the visual match the result may not fall below, 0-100 "
                             "where 100 is indistinguishable (90 = you will not see "
                             "the difference), or 0-1 with --metric ssim. With --under "
                             "it is the point past which shrinking is not worth doing")
    parser.add_argument("--metric", choices=["ssimulacra2", "ssim"], default=None,
                        help="quality metric (default: ssimulacra2 when installed)")
    parser.add_argument("-f", "--format", dest="formats", action="append",
                        choices=sorted(enc.ALL),
                        help="always use this format; repeat to allow several")
    parser.add_argument("--lossless", action="store_true",
                        help="never change a pixel: only pixel-exact formats, "
                             "never resized. Files come out larger this way. "
                             "Shorthand for --for lossless")
    parser.add_argument("--fast", action="store_true",
                        help="skip the slowest final passes; a few percent bigger")
    parser.add_argument("--no-zopfli", action="store_true",
                        help="skip zopfli PNG recompression (faster, ~10%% bigger PNGs)")
    parser.add_argument("--keep-metadata", action="store_true",
                        help="preserve EXIF/ICC instead of stripping it")
    parser.add_argument("--no-recursive", action="store_true",
                        help="do not descend into subfolders")
    parser.add_argument("-j", "--workers", type=int, default=0,
                        help="parallel workers (default: auto)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="show every version that was tried, not just the winner")
    parser.add_argument("--check", action="store_true",
                        help="report which optional engines are installed, then exit")
    parser.add_argument("--version", action="version", version=f"pocketsize {__version__}")
    return parser


def report_capabilities() -> int:
    print("engines")
    caps = dict(enc.capabilities())
    caps["ssimulacra2 (perceptual metric)"] = HAVE_SSIMULACRA2
    for label, ok in caps.items():
        print(f"  [{'x' if ok else ' '}] {label}")

    print("\nvideo")
    vcaps = video.capabilities()
    if not vcaps.get("pyav"):
        # Named even when absent. The release gate reads these rows to prove
        # the GPL-carrying engines are NOT in an installer, and a row that
        # omits the engine's name leaves it unable to tell "correctly absent"
        # from "no longer reported at all".
        print("  [ ] pyav (not installed)")
        print(f"      add it with:  {video.INSTALL_HINT}")
    else:
        print(f"  [x] pyav {vcaps.get('version', '?')}")
        for key in ("h264-mp4", "av1-mp4", "aac", "libopus"):
            if key in vcaps:
                print(f"  [{'x' if vcaps[key] else ' '}] {key}")
        # The second opinion is optional and its absence is not a fault: it
        # means this build has no independent witness to offer, and the
        # result carries one number instead of two.
        print(f"  [{'x' if vcaps.get('xpsnr') else ' '}] xpsnr (second opinion)")

    if not all(caps.values()):
        print("\nMissing engines fall back to weaker built-ins.")
        print("Install everything with:  pip install -r requirements.txt")
    elif vcaps.get("pyav"):
        print("\nAll engines active.")
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.check:
        return report_capabilities()

    source = Path(args.source).expanduser()
    if not source.exists():
        print(f"Nothing to do: {source} does not exist.", file=sys.stderr)
        return 2

    try:
        metric = get_metric(args.metric)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2

    # `--target` is the pre-2.7 spelling of the same idea and wins when given,
    # so a script that says `--target figma` keeps landing on the design-tool
    # rules under their new name.
    asked_for = args.legacy_target or args.destination
    # `--lossless` is a promise, not a preference, so it does not merge with a
    # destination - the two name different rules and combining them silently
    # would honour neither. Saying both is asked back, not resolved.
    if args.lossless:
        if asked_for != dest.DEFAULT and dest.resolve(asked_for) != "lossless":
            print("--lossless and --for name different rules. "
                  "Use one or the other.", file=sys.stderr)
            return 2
        asked_for = "lossless"
    if not dest.exists(asked_for):
        print(f"There's no destination called '{asked_for}'. "
              f"Choose one of: {', '.join(dest.names())}.", file=sys.stderr)
        return 2
    going_to = dest.get(asked_for)
    renamed = asked_for if asked_for != going_to.name else ""

    max_dim = going_to.max_dimension
    target = going_to.ss2_target if metric.name == "ssimulacra2" else going_to.ssim_target
    if args.max_dimension is not None:
        max_dim = args.max_dimension
    if args.quality_target is not None:
        target = args.quality_target
    if not metric.valid_target(target):
        upper = "100" if metric.name == "ssimulacra2" else "1.0"
        print(f"--quality-target must be between 0 and {upper} for {metric.name}",
              file=sys.stderr)
        return 2

    size_target = 0
    if args.size_target is not None:
        try:
            size_target = parse_size(args.size_target)
        except ValueError:
            print(f"--under wants a size like 200KB or 1.5MB, "
                  f"not '{args.size_target}'.", file=sys.stderr)
            return 2

    settings = Settings(
        target=going_to.name,
        max_dimension=max_dim,
        dimension_mode=args.fit,
        metric=metric.name,
        quality_target=target,
        size_target=size_target,
        keep_metadata=args.keep_metadata,
        zopfli=not args.no_zopfli,
        fast=args.fast,
        formats=args.formats,
    )

    # `destination` is the folder; `going_to` is the kind of place the image is
    # headed. Naming both of them the same thing is how this got confusing in
    # the first place.
    out_dir = Path(args.output).expanduser()
    allowed = settings.formats or enc.usable(going_to.formats)
    match = f"{target:g}" if metric.name == "ssimulacra2" else f"{target:g} ({metric.name})"
    print(f"source      {source}")
    print(f"writing to  {out_dir}")
    print(f"going to    {going_to.name} - {going_to.label.lower()}")
    # What will actually happen, not what was asked for. Printing the request
    # meant `-m 8000 --for documents` advertised "up to 8000px" and produced
    # 4096 - a dimension changing without saying so, which is the whole defect
    # this destination work exists to remove, just moved onto the override path.
    # `longest` is still the only mode whose clamp `effective_limit` can express,
    # because a ceiling on the long edge and a pin on the width are different
    # numbers. The other modes print their pin and name the clamp separately
    # rather than pretending one number covers both.
    pinned = args.fit != "longest" and max_dim
    if pinned:
        effective = max_dim
        size = f"{args.fit} up to {max_dim}px"
        if going_to.hard_cap:
            size += f", never past {going_to.hard_cap}px on the long edge"
    else:
        effective = dest.effective_limit(going_to.name, max_dim)
        size = f"up to {effective}px on the longest edge" if effective else "never resized"
    if size_target:
        print(f"            under {human(size_target)}, at the best quality that fits")
        print(f"            {size}, and never below a visual match of {match}")
    else:
        print(f"            {size}, visual match at least {match}")
    if not pinned and effective != (max_dim or 0):
        print(f"            (asked for {max_dim or 'no limit'}; {going_to.name} clamps at "
              f"{going_to.hard_cap}px because these tools rescale above it "
              f"destructively on import)")
    if renamed:
        print(f"            ('{renamed}' is the old name for this; both work)")
    print(f"formats     {', '.join(allowed)}")
    missing = [k for k, v in enc.capabilities().items() if not v]
    if missing:
        print(f"note        not installed: {', '.join(missing)} "
              f"(run --check for details)")
    print()

    results = compress_tree(
        source, out_dir, settings,
        recursive=not args.no_recursive,
        workers=args.workers,
        on_result=lambda r: print(describe(r, args.verbose), flush=True),
    )

    # Videos travel through the same run, answer the same question, and land in
    # the same folder. They take a different engine because encoding one is a
    # different job, not because it is a different product.
    clips = iter_videos(source, recursive=not args.no_recursive)
    video_results = []
    if clips and not dest.takes_video(going_to.name):
        print(f"\n{len(clips)} video(s) skipped: {going_to.name} is for "
              f"pictures. Try --for web, email, chat, social or original.")
    elif clips and not video.available():
        print(f"\n{len(clips)} video(s) skipped: video needs an extra install.")
        print(f"           {video.INSTALL_HINT}")
    elif clips:
        print()
        # A video can take minutes, so it says what it is doing while it does
        # it. Written over one line and cleared when the result lands, so a
        # piped or redirected run is not full of half-drawn bars.
        live = sys.stderr.isatty()

        def show(name):
            def step(stage, fraction, detail):
                if not live:
                    return
                bar = "#" * int(fraction * 20)
                sys.stderr.write(
                    f"\r     {name[:28]:<28} [{bar:<20}] {fraction * 100:3.0f}%"
                    f"  {stage}   "
                )
                sys.stderr.flush()
            return step

        for clip in clips:
            try:
                res = video.compress(
                    clip, going_to.name,
                    fast=args.fast,
                    size_target=size_target or 0,
                    max_dimension=args.max_dimension,
                    output_dir=out_dir,
                    on_progress=show(clip.name),
                )
            except KeyboardInterrupt:
                if live:
                    sys.stderr.write("\r" + " " * 78 + "\r")
                print("\nStopped. Nothing half-written was kept.")
                return 130
            if live:
                sys.stderr.write("\r" + " " * 78 + "\r")
                sys.stderr.flush()
            video_results.append(res)
            print(describe_video(res, args.verbose), flush=True)

    if not results and not video_results:
        print("No supported images or videos found.")
        return 1

    everything = list(results) + list(video_results)
    before = sum(r.original_bytes for r in everything)
    after = sum(r.new_bytes for r in everything if not r.error)
    failed = [r for r in everything if r.error]

    print()
    counts = []
    if results:
        counts.append(f"{len(results) - len([r for r in results if r.error])} image(s)")
    if video_results:
        counts.append(
            f"{len(video_results) - len([r for r in video_results if r.error])} video(s)"
        )
    print(" and ".join(counts) + " processed")
    pct = 100.0 * (before - after) / before if before else 0
    print(f"{human(before)} -> {human(after)}   saved {human(before - after)} ({pct:.1f}%)")
    if failed:
        print(f"{len(failed)} file(s) failed - see the ! lines above")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
