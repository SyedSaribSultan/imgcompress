# Contributing

Thanks for taking a look.

## Getting set up

```bash
git clone https://github.com/SyedSaribSultan/pocketsize
cd pocketsize
python -m pip install -e ".[full,app,dev]"
pocketsize --check          # confirm every engine is active
python -m unittest discover -s tests
```

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

Two things are generated from a source of truth and committed, because neither
`web/` nor a pip install has a build step and neither should grow one:

```bash
python tools/gen_destinations.py    --check   # web/destinations.js
python tools/sync_webui_assets.py   --check   # the desktop app's design system
```

Drop `--check` to rewrite them. **Never edit the outputs.** Change the source
and re-run; CI runs both with `--check` and fails on a stale copy.

| Output | Source |
| --- | --- |
| `web/destinations.js` | `pocketsize/destinations.py` |
| `pocketsize/webui/heyoz-tokens.css` | `web/heyoz-tokens.css` |
| `pocketsize/webui/fonts.css` + `fonts/` | `web/fonts.css` + `web/fonts/` |
| `pocketsize/webui/favicon.svg` | `web/favicon.svg` |

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
  or `avifenc`. A designer on Windows has to be able to run this with nothing
  but Python, so every engine we use must ship a Windows wheel.
- **Optional engines must degrade, not crash.** Guard imports and fall back.
- **New behaviour needs a test**, especially the awkward cases: transparency,
  CMYK, animated GIFs, corrupt files, extreme aspect ratios.
- **Inherited values have no recorded reason.** The repository landed in a
  single initial commit, so nothing before it has a documented rationale. If
  you change one, write down why — you are the first person who can.
- Run `ruff check .` before opening a PR.

## Reporting a bug

Include the output of `pocketsize --check`, your OS and Python version, and
ideally the image that triggered it. "It made my file bigger" is a great bug
report if the file is attached.
