"""Write `web/ss2.module.js` from `web/ss2.js`.

The metric has one implementation and this keeps it that way.

`ss2.js` is a classic script: the image worker pulls it in with
`importScripts`, which is the only thing a classic worker can do. The video
worker is an ES module, because Mediabunny ships as one, and a module worker
has no `importScripts` at all - the two loading mechanisms genuinely do not
meet, and the Content-Security-Policy that makes this site safe rules out the
usual escape hatches: no `eval`, no `new Function`, no `data:` URL.

So the module form is generated rather than written. It is the same file with
an export statement appended, produced by this tool and checked in CI, because
a second hand-maintained copy of a validated metric is exactly the drift the
generated-file rule exists to prevent - and drift here would mean the browser's
two engines quietly disagreeing about what "looks the same" means.

    python tools/gen_ss2_module.py            # write it
    python tools/gen_ss2_module.py --check    # fail if stale
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "web" / "ss2.js"
OUTPUT = ROOT / "web" / "ss2.module.js"

BANNER = """/* GENERATED FILE - DO NOT EDIT.
 *
 * Written by tools/gen_ss2_module.py from web/ss2.js, which is the reference.
 * Edit that file and re-run the generator; CI regenerates this one and fails
 * if it differs from what is committed.
 *
 * Why this exists: the image worker is a classic worker and reads ss2.js with
 * importScripts; the video worker is a module worker, which has no
 * importScripts, and the CSP forbids every other way of running a script
 * fetched at runtime. Same source, two loading mechanisms.
 */

"""

EXPORTS = "\nexport { ss2Score };\n"


def render() -> str:
    body = SOURCE.open("r", encoding="utf-8", newline="").read()
    return BANNER + body.rstrip("\n") + "\n" + EXPORTS


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the committed file is stale")
    args = parser.parse_args(argv)

    wanted = render()
    if args.check:
        if not OUTPUT.exists():
            print(f"{OUTPUT.relative_to(ROOT)} is missing", file=sys.stderr)
            return 1
        # Normalise line endings before comparing: a Windows checkout can
        # rewrite them without the content having changed.
        have = OUTPUT.open("r", encoding="utf-8", newline="").read()
        if have.replace("\r\n", "\n") != wanted.replace("\r\n", "\n"):
            print(f"{OUTPUT.relative_to(ROOT)} is out of date - "
                  f"run python tools/gen_ss2_module.py", file=sys.stderr)
            return 1
        print(f"{OUTPUT.relative_to(ROOT)} is up to date")
        return 0

    with OUTPUT.open("w", encoding="utf-8", newline="") as handle:
        handle.write(wanted)
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
