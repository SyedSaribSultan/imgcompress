# Contributing

Thanks for taking a look.

## Getting set up

```bash
git clone https://github.com/USERNAME/imgcompress
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

## Ground rules

- **Pip-installable dependencies only.** No shelling out to `cwebp`, `pngquant`
  or `avifenc`. A designer on Windows has to be able to run this with nothing
  but Python, so every engine we use must ship a Windows wheel.
- **Optional engines must degrade, not crash.** Guard imports and fall back.
- **New behaviour needs a test**, especially the awkward cases: transparency,
  CMYK, animated GIFs, corrupt files, extreme aspect ratios.
- Run `ruff check .` before opening a PR.

## Reporting a bug

Include the output of `imgcompress --check`, your OS and Python version, and
ideally the image that triggered it. "It made my file bigger" is a great bug
report if the file is attached.
