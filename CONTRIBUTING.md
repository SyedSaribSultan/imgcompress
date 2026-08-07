# Contributing

Thanks for taking a look.

## Getting set up

```bash
git clone https://github.com/SyedSaribSultan/imgcompress
cd imgcompress
python -m pip install -e ".[full,app,dev]"
imgcompress --check          # confirm every engine is active
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

`web/destinations.js` is generated from `imgcompress/destinations.py` and
committed, because `web/` has no build step and should not grow one:

```bash
python tools/gen_destinations.py            # rewrite it
python tools/gen_destinations.py --check    # what CI runs
```

Never edit it. Change the Python and re-run. If you find yourself typing a
destination's name, frame size or format list into a second file, that is the
mistake this generator exists to prevent — the previous hand-written copy
drifted from the reference within an hour of being created.

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

Include the output of `imgcompress --check`, your OS and Python version, and
ideally the image that triggered it. "It made my file bigger" is a great bug
report if the file is attached.
