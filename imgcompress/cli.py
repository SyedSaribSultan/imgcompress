"""Command line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
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
    if res.level is not None:
        bits.append(f"q{res.level}")
    if res.score is not None:
        fmt = "{:.1f}" if res.metric == "ssimulacra2" else "{:.4f}"
        bits.append(f"{res.metric} " + fmt.format(res.score))
    line = f"  ok {name}  " + "  ".join(bits)
    if verbose and res.candidates:
        losers = "   ".join(f"{c}={human(s)}" for c, s, _ in sorted(res.candidates, key=lambda x: x[1]))
        line += f"\n       candidates: {losers}"
    for warning in res.warnings:
        line += f"\n     ! {warning}"
    return line


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
        prog="imgcompress",
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
            "  imgcompress                           ./input -> ./output\n"
            "  imgcompress photos/ -o small/         compress a folder\n"
            "  imgcompress hero.png --for documents  safe to import into a design tool\n"
            "  imgcompress input/ --for email        small enough to attach\n"
            "  imgcompress input/ -q 95              hold a higher visual match\n"
            "  imgcompress input/ --fast             quicker, slightly bigger\n"
            "  imgcompress --check                   show which engines are active\n"
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
                        help="cap the longest edge in pixels. 0 keeps the original size")
    parser.add_argument("-q", "--quality-target", type=float,
                        help="minimum visual match, 0-100 where 100 is indistinguishable "
                             "(90 = you will not see the difference), or 0-1 with "
                             "--metric ssim")
    parser.add_argument("--metric", choices=["ssimulacra2", "ssim"], default=None,
                        help="quality metric (default: ssimulacra2 when installed)")
    parser.add_argument("-f", "--format", dest="formats", action="append",
                        choices=sorted(enc.ALL),
                        help="always use this format; repeat to allow several")
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
    parser.add_argument("--version", action="version", version=f"imgcompress {__version__}")
    return parser


def report_capabilities() -> int:
    print("engines")
    caps = dict(enc.capabilities())
    caps["ssimulacra2 (perceptual metric)"] = HAVE_SSIMULACRA2
    for label, ok in caps.items():
        print(f"  [{'x' if ok else ' '}] {label}")
    if not all(caps.values()):
        print("\nMissing engines fall back to weaker built-ins.")
        print("Install everything with:  pip install -r requirements.txt")
    else:
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

    settings = Settings(
        target=going_to.name,
        max_dimension=max_dim,
        metric=metric.name,
        quality_target=target,
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
    effective = dest.effective_limit(going_to.name, max_dim)
    size = f"up to {effective}px" if effective else "never resized"
    print(f"            {size}, visual match at least {match}")
    if effective != (max_dim or 0):
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

    if not results:
        print("No supported images found.")
        return 1

    before = sum(r.original_bytes for r in results)
    after = sum(r.new_bytes for r in results if not r.error)
    failed = [r for r in results if r.error]

    print()
    print(f"{len(results) - len(failed)} image(s) processed")
    pct = 100.0 * (before - after) / before if before else 0
    print(f"{human(before)} -> {human(after)}   saved {human(before - after)} ({pct:.1f}%)")
    if failed:
        print(f"{len(failed)} file(s) failed - see the ! lines above")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
