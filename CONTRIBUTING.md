# Contributing

Thanks for taking a look.

## Getting set up

```bash
git clone https://github.com/SyedSaribSultan/pocketsize
cd pocketsize
python -m pip install -e ".[full,app,video,dev]"
pocketsize --check          # confirm every engine is active, video included
python -m unittest discover -s tests
```

`video` is the one extra that cannot be installed everywhere: PyAV needs Python
3.11, and the rest of the package still supports 3.9, so the dependency carries
a `python_version >= "3.11"` marker and simply installs nothing below that.
`pocketsize --check` will say so, and the video *engine* tests skip themselves
the way the AVIF ones skip without the plugin — the table and arithmetic tests
still run. That is the correct behaviour rather than a broken checkout: video
absent is not video broken.

## The one thing to know before changing behaviour

This project's whole claim is that quality is *measured*, not guessed. So any
change that affects output has to come with a measurement:

```bash
python tests/make_fixtures.py     # build the benchmark corpus
python tests/bench_formats.py     # per-format sizes at a fixed quality target
python tests/bench_versions.py    # matched-quality comparison against v1
```

If your change makes files smaller, show it at **matched perceptual quality**.
A smaller file at a lower score isn't an improvement, it's a different setting.

And don't validate a change to the metric using that same metric — that's
circular, and it is exactly the mistake that made version 1 look fine.

## The video corpora, and why there are two

```bash
python tests/make_video_fixtures.py        # content: motion, screen, grain, still
python tests/make_real_world_fixtures.py   # shapes: rotation, SAR, HDR, VFR, tracks
python tests/bench_video.py                # writes tests/VIDEO_BENCHMARK.md
```

They answer different questions and neither replaces the other.
`make_video_fixtures.py` varies the **content** — a moving gradient, a screen
recording, heavy sensor grain, a near-static shot — because content is what
decides how well anything compresses and where the right answer genuinely
differs between codecs. `make_real_world_fixtures.py` varies the **container and
the metadata** — a phone held upright, one held upside down, non-square pixels,
HDR, variable frame rate, two soundtracks — because that is where a video
compressor produces *wrong* output rather than merely large output, and wrong
output is invisible to a size-and-score benchmark. Writing the second corpus
found five defects on its first run; a sideways video scores fine against a
sideways reference.

Both corpora are written **near-lossless on purpose**. An earlier version wrote
them at an ordinary quality, which made them already-compressed files that the
engine correctly refused to beat — so the tests passed while measuring nothing
but the fixture's smallness. The cost of the fix is that matching a pristine
master at a visual match of 92 is a far harder ask than matching footage a
camera already compressed once, which is what a person actually hands this tool.
`tests/VIDEO_BENCHMARK.md` says that in place rather than letting the numbers
imply the compressor is worse than it is, and where no strategy clears the floor
it prints **no** on every row instead of quietly lowering the bar.

`bench_video.py` searches every strategy that can be searched to the same floor
and reports two metric families, because the rule above applies with more force
to video than to pictures: encoders now ship modes explicitly tuned to score
well on a named metric. The search steers on SSIMULACRA 2 and XPSNR is the
independent witness — never the other way round, and never only one of them.

## Every new gate must be observed failing

A test, check or CI job that has never been seen to go red is a guess about
whether it measures anything. Before you open the PR: break the thing it
watches, watch it fail, restore, and **say so in the commit message** — what
you broke and what it said.

This is not hypothetical bookkeeping. Four checks on one branch reported
success while checking nothing:

| The check | Why it was green | Caught by |
| --- | --- | --- |
| A byte-comparison snapshot | The frame size had been pinned by hand, so it certified a configuration no user would ever run | Review |
| The AVIF corpus skip | A failed plugin install dropped 12 vectors and still printed `VALIDATED` | Review |
| A parser-based parity test | Every regex could match nothing and pass | Writing this rule |
| A `diff` against a regenerated file | The job had not written the file yet, so it compared it to itself | A file mtime |

Two were found in review and one by luck. Watching a gate fail once costs a
minute and is the only thing that distinguishes it from a comment.

The same rule applies to guards *about* guards. `tests/test_corpus_guard.py`
exists because `check_ss2_corpus.py` was itself only verified by hand.

## Generated files

Several things are generated from a source of truth and committed, because
neither `web/` nor a pip install has a build step and neither should grow one:

```bash
python tools/gen_destinations.py    --check   # web/destinations.js
python tools/gen_ss2_module.py      --check   # web/ss2.module.js
python tools/sync_webui_assets.py   --check   # the desktop app's design system
python tools/gen_seo_pages.py       --check   # the use-case pages + sitemap
```

Drop `--check` to rewrite them. **Never edit the outputs.** Change the source
and re-run. Where each one is enforced differs, and it is worth knowing which:
`gen_destinations` and `sync_webui_assets` have their own CI step *and* a test
(`test_destination_parity.py`, `test_design_system.py`); `gen_seo_pages` is
gated by `test_seo_pages.py` inside the suite. **`gen_ss2_module` currently has
neither**, which by this project's own rule makes it a convention rather than a
guarantee — if you touch `web/ss2.js`, run the generator by hand and commit the
result until that gap is closed.

| Output | Source |
| --- | --- |
| `web/destinations.js` | `pocketsize/destinations.py` |
| `web/ss2.module.js` | `web/ss2.js` |
| `web/<slug>.html` + `web/sitemap.xml` | `web/index.html` |
| `pocketsize/webui/heyoz-tokens.css` | `web/heyoz-tokens.css` |
| `pocketsize/webui/fonts.css` + `fonts/` | `web/fonts.css` + `web/fonts/` |
| `pocketsize/webui/favicon.svg` | `web/favicon.svg` |

`web/ss2.module.js` is there for a reason worth knowing before you are tempted
to "simplify" it away. The image worker is a classic worker and pulls the metric
in with `importScripts`; the video worker is a module worker, because Mediabunny
ships as an ES module, and a module worker has no `importScripts` at all. The
CSP rules out every runtime escape hatch — no `eval`, no `new Function`, no
`data:` URLs — so the two loading mechanisms genuinely do not meet. One
validated implementation, generated into two forms, beats two hand-maintained
copies: drift between them would mean the browser's two engines quietly
disagreeing about what "looks the same" means.

If you find yourself typing a destination's name, a frame size, a colour or a
corner radius into a second file, that is the mistake these exist to prevent —
the previous hand-written copy of the destination table drifted from its
reference within an hour of being created.

## One design system, and one set of motion values

Both interfaces render from `web/heyoz-tokens.css`. The desktop app gets a
committed copy of it; nothing in either app declares a colour, a corner or a
duration of its own.

```bash
node tests/web/verify_tokens.mjs     # static: both app layers, colour + motion
node tests/web/verify_desktop.mjs    # runtime: the desktop app in real Chrome
node tests/web/shoot_both.mjs        # screenshots, both apps, both themes
```

`verify_tokens.mjs` fails on a hand-typed colour, a hand-typed duration or
easing curve, `transition: all`, and — the one that costs users something real
— **any transition of a layout property**. `width`, `height`, `top`, `left`,
`margin`, `padding` and `inset` all force the browser to recompute layout on
every frame; `transform` and `opacity` are composited and cannot. Three
progress bars in this app animated `width` before that rule existed.

Use the values the system already ships: `--oz-duration-*`, `--oz-ease-*`, and
the `--oz-spring-{effects,spatial}-{fast,default,slow}` pairs. Do not add a
second motion vocabulary — `--oz-ease-exit` already exists, and redefining it
would silently change every exit animation in the product.

`prefers-reduced-motion` is handled once, in the token layer, for both
interfaces. It collapses spatial travel and takes the overshoot off the springs
while leaving fades alone, because a fade is often the thing carrying the
meaning. Do not re-handle it per component or per app.

## Ground rules

- **Pip-installable dependencies only.** No shelling out to `cwebp`, `pngquant`
  or `avifenc` — and, since video landed, no shelling out to `ffmpeg` either. A
  designer on Windows has to be able to run this with nothing but Python, so
  every engine we use must ship a Windows wheel. PyAV is the whole reason video
  could be added under that rule at all: its wheels carry a complete FFmpeg,
  x264 and SVT-AV1 included, for Windows x64 and ARM64, macOS and Linux, and the
  API is in-process rather than a command line whose output has to be parsed.
- **The `video` extra must not reach the standalone installers.** Depending on
  PyAV is fine and leaves this package's own MIT licence alone; *bundling* the
  GPL FFmpeg inside it into a shipped binary is a different act with different
  obligations, and until that is resolved the installers ship without it. See
  `docs/VIDEO_IMPLEMENTATION_PLAN.md`, decision V3.
- **Optional engines must degrade, not crash.** Guard imports and fall back.
- **New behaviour needs a test**, especially the awkward cases: transparency,
  CMYK, animated GIFs, corrupt files, extreme aspect ratios — and, for video,
  rotated frames, non-square pixels, HDR, variable frame rate and more than one
  soundtrack. Those five are what `tests/make_real_world_fixtures.py` exists to
  produce, and every one of them was a real defect before it was a fixture.
- **Inherited values have no recorded reason.** The repository landed in a
  single initial commit, so nothing before it has a documented rationale. If
  you change one, write down why — you are the first person who can.
- Run `ruff check .` before opening a PR.

## Reporting a bug

Include the output of `pocketsize --check`, your OS and Python version, and
ideally the file that triggered it. "It made my file bigger" is a great bug
report if the file is attached. For video, `--check` also reports which encoders
this build can actually write and whether it has the `xpsnr` filter, which is
usually the first thing worth knowing.
