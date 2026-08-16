# Pocketsize

[![CI](https://github.com/SyedSaribSultan/pocketsize/actions/workflows/ci.yml/badge.svg)](https://github.com/SyedSaribSultan/pocketsize/actions/workflows/ci.yml)
[![Try it in the browser](https://img.shields.io/badge/try_it-in_the_browser-d29a5e)](https://pocketsize.vercel.app)

**Image compression that proves it didn't ruin your image.**

Most compressors ask you to pick a quality number and hope. This one saves each
image several different ways, opens every version back up, compares it to your
original, and keeps the smallest one that still looks close enough. Then it
shows you the evidence.

Put plainly: every image comes out as small as it can go without you being able
to see the difference — and you get the side-by-side to check that for
yourself.

Typical result on design assets: **70–90% smaller**, at a measured
visually-lossless quality level.

![The app, dark theme](docs/screenshot-dark.webp)

```bash
pip install "pocketsize[full,app]"
pocketsize-gui            # the app
pocketsize photos/        # or the command line
```

Or skip the install: **[pocketsize.vercel.app](https://pocketsize.vercel.app)**
runs the same comparison entirely in your browser — including SSIMULACRA 2
itself, ported to JavaScript and validated against the reference
implementation. Nothing is uploaded; images never leave your device.

[tests/BENCHMARK.md](tests/BENCHMARK.md) holds a reproducible head-to-head
against single-format pipelines and fixed-quality defaults, every strategy
searched to the same visual match of 90 or better. On that corpus Pocketsize is
the smallest or tied-smallest passing file on every image; on the 12 MP
photograph the browser version ships 362 KB where searched single-format
JPEG needs 517–544 KB — and every fixed-quality default misses the target
outright. The one caveat is spelled out there too: on one hard palette image
the desktop's optional libimagequant quantizer beats the browser quantizer
by ~2.5 KB.

---

## Two ideas, both load-bearing

**1. Quality is measured, not guessed.**
Every version is opened back up and compared to the original with
[SSIMULACRA 2](https://github.com/cloudinary/ssimulacra2) — the metric the
image-compression community converged on, which correlates with human judgement
at r≈0.88 versus SSIM's ≈0.76, and unlike SSIM can actually see chroma damage.
The encoder quality setting is *found* by binary search, not assumed. Flat UI
artwork survives a very low setting; a noisy photograph automatically gets a
high one.

**2. The format is a comparison, not an assumption.**
Each image is saved as JPEG *and* palette PNG *and* lossless PNG (plus WebP if
you allow it), each searched separately, and the smallest one that still looks
close enough wins. The winner is genuinely content-dependent:

| Image | jpeg | png8 | png | webp | webp-lossless | winner |
| --- | --- | --- | --- | --- | --- | --- |
| photograph | **110 KB** | 536 KB | 1,531 KB | — | 1,468 KB | jpeg |
| UI screenshot | 43 KB | **10 KB** | 29 KB | 19 KB | 14 KB | png8 |
| vector logo (alpha) | n/a | 3.9 KB | 3.9 KB | 11 KB | **3.1 KB** | png8 / webp |
| smooth gradient | 7.5 KB | 115 KB | **2.7 KB** | 5.5 KB | 0.4 KB | png |

<sub>Smallest file scoring ≥ 80 SSIMULACRA 2. Reproduce:
`python tests/make_fixtures.py && python tests/bench_formats.py`</sub>

Four images, four different answers, and up to a **40× spread** between the best
and worst format. Palette PNG is the best choice for two of them and the *worst
possible* choice for the gradient. Picking one format up front leaves a lot on
the table.

---

## The app

![Before / after comparison](docs/screenshot-compare.jpg)

Drop images anywhere in the window. Every file is queued, encoded in parallel,
and shown with its before/after size, the format that won, and the measured
score.

- **Split comparison** — drag the divider, or press <kbd>Space</kbd> to flip
  between original and compressed. Zoom to 100%, 200%, 400% and pan around.
  This is the point of the whole thing: you can *check*.
- **Versions panel** — see every version that was tried, why each one lost in a
  single sentence, and switch to any of them instantly.
- **Nothing is written until you press Save.** Review the whole batch, then
  save it or throw it away.
- **Watch a folder** — point it at your Figma export folder and it compresses
  new arrivals as they land.

It runs a local server and opens a real app window when
[pywebview](https://pywebview.flowrl.com/) is installed, falling back to your
browser otherwise. Both are the same full application.

<details>
<summary>Light theme</summary>

![Light theme](docs/screenshot-light.webp)
</details>

---

## Video

The same idea, and the same one question. Videos go in the same folder as the
images and come out the same way: several settings tried, every result opened
back up and measured against the original, and the smallest one that still
looks close enough is what you get.

```bash
pip install "pocketsize[video]"       # needs Python 3.11+
pocketsize clips/ --for chat          # fits Discord's free 10 MB limit
pocketsize clips/ --for email         # small enough to attach
pocketsize holiday.mov --for web      # AV1 where it helps, H.264 where it must
```

| `--for` | Formats | Frame | Visual match | Size limit | Sound |
| --- | --- | --- | --- | --- | --- |
| `web` | AV1 / H.264 MP4 | 1920px | 92 | — | kept as it was |
| `email` | H.264 MP4 | 1920px | 90 | 18 MB | kept as it was |
| `chat` | H.264 / AV1 MP4 | 1280px | 88 | 10 MB | AAC |
| `social` | H.264 MP4 | 1920px | 90 | 500 MB | AAC |
| `documents` | H.264 MP4 | 1920px | 90 | — | AAC |
| `original` | AV1 / H.264 MP4 | never resized | 96 | — | kept as it was |

`thumbnail` is a place to send a picture and not a place to send a video, so a
video sent there is reported and left exactly as it is rather than guessed at.

A few things are worth knowing, because they are the difference between this
and a tool that guesses:

**A size limit is a limit, not an instruction to spend it.** If the smallest
version that still looks right is 3 MB, that is what you get — `--for chat`
does not inflate it to fill 10 MB. Only when the honest quality answer will not
fit does the limit take over and decide, and then the result line says so:
*not as sharp as the original, to fit the size limit.*

**The score you see is the worst part of the clip, not the average.** Frames are
sampled through the whole runtime and pooled worst-first, so the number you read
is the low percentile rather than the mean. A video that is perfect for four
seconds and falls apart for one is not a good video, and an average says it is.
Where the build can, the result also carries a second, unrelated measurement
(XPSNR), because a number the search was steering on is a claim rather than
evidence. Two exceptions, stated rather than hidden: a build without that
filter reports one number, and a tone-mapped HDR file reports one too — the
witness compares like with like, and a converted picture is not like its
original.

**It comes out the right way up, and the right shape.** A phone held upright
records a landscape frame with a "turn this" flag attached, and a flag is only
advice — plenty of players, upload forms and editors ignore it. The rotation is
baked into the pixels instead. Non-square pixels are resolved the same way, so
the output is always square-pixel and never squashed.

**Sound is kept exactly as it was where the destination allows it** — `web`,
`email` and `original` copy the original track untouched whenever the container
can carry it, because re-encoding audio that is already compressed only ever
loses and it is a small share of the bytes. `documents`, `chat` and `social`
re-encode to AAC, because that is what the players they are named after reliably
accept. Either way the result says which happened, and a second soundtrack or a
subtitle track that could not come along is reported rather than dropped in
silence.

**HDR video is converted, not flattened.** A clip with a PQ or HLG transfer —
what a modern phone records by default — cannot simply be re-encoded: strip the
wide colour without converting it and you get a washed-out grey video. So the
desktop tier tone maps it properly — the standard transfer curves, wide
primaries brought back to ordinary ones, a documented tone curve — and says on
the result that the colour was converted. A transfer it cannot name is still
refused rather than guessed at. **The browser tier has no tone mapper**, so an
HDR clip there is left alone with an explanation; that is the one job the
desktop app does that the page cannot.

**A video takes minutes, and it says so while it runs.** The command line draws
a live progress bar on a terminal, stays quiet when its output is redirected,
and stops cleanly on Ctrl-C without leaving a half-written file behind.

HEVC is decoded but never written: its patent position is three licensing pools
deep with no exemption for ordinary use, which is why no free tool emits it.
AV1 and Opus are royalty-free, and H.264 is the one that plays literally
everywhere.

[tests/VIDEO_BENCHMARK.md](tests/VIDEO_BENCHMARK.md) is the reproducible
version of all of that: every strategy that *can* be searched, searched to the
same visual match of 92 and scored by two metric families, against fixed-setting
rows that are what taking the internet's advice costs on content it does not
happen to suit. On the near-static clip the searched AV1 encode ships 9,952
bytes at a measured 94.8, and **every fixed-quality default misses the floor
outright** — including two AV1 ones that produce *smaller* files (7,258 and
8,701 bytes, at 90.5 and 91.2). On the screen recording it ships 3,379 bytes
where x264 at the internet's usual CRF 23 needs 8,503. The report is equally
plain about where nothing wins: the `motion` and `grain` fixtures are written
near-lossless on purpose, no strategy in the table clears 92 on either, and the
rows say **no** rather than quietly lowering the bar.

Video runs on the desktop tier today — the command line and the app. The browser
has an engine of its own, built and measured in a real browser, but the page
around it is still being wired up; until that lands,
[pocketsize.vercel.app](https://pocketsize.vercel.app) is pictures only.

---

## Command line

```bash
pocketsize                            # ./input -> ./output
pocketsize photos/ -o small/          # any folder
pocketsize hero.png                   # a single file
pocketsize input/ --for documents     # safe to import into a design tool
pocketsize input/ --for email         # small enough to attach
pocketsize input/ -q 95               # hold a higher visual match
pocketsize input/ --fast              # quicker, a few percent bigger
pocketsize --check                    # which engines are active
```

### Where is it going?

That is the only question you have to answer, and you can answer it without
knowing anything about compression. Everything else follows from it — which
formats are allowed, how large the frame may be, and how close the result has
to look.

| `--for` | For | Formats | Size | Visual match |
| --- | --- | --- | --- | --- |
| `web` | **Default.** Anything that loads in a browser | all, incl. WebP + AVIF | 2560px | 90 |
| `documents` | Design tools, office suites, docs | JPEG / PNG only | 2560px, hard ceiling 4096px | 90 |
| `email` | Attachments | JPEG / PNG only | 1920px | 88 |
| `chat` | Discord and group chats | JPEG / PNG only | 1920px | 88 |
| `social` | Instagram, X, Facebook posts | JPEG / PNG only | 2048px | 88 |
| `thumbnail` | Avatars, list icons, previews | all | 512px | 80 |
| `original` | Print, masters, archives | all | never resized | 95 |

`email` and `chat` do the same thing to a picture and different things to a
video — one is defined by a mail server's limit and the other by Discord's, and
those two numbers come from different companies. They were one destination
until video needed them to be two.

There is also `--lossless` (the same thing as `--for lossless`): never change a
pixel — only pixel-exact formats, never resized. Files come out larger this
way; it exists for archives, scans and records where "close enough" isn't.

`--preset` is accepted as a synonym, and the older names (`figma`, `archive`)
still resolve, so existing scripts keep working.

| Flag | What it does |
| --- | --- |
| `--for web \| documents \| email \| chat \| social \| thumbnail \| original` | Where the file is going (default: `web`) |
| `-m, --max-dimension 1920` | Cap the longest edge. `0` keeps original dimensions |
| `-q, --quality-target 95` | Minimum visual match, 0–100 (100 = indistinguishable) |
| `--metric ssimulacra2 \| ssim` | `ssim` is ~5× faster and cruder |
| `-f, --format jpeg` | Always use this format; repeat to allow several |
| `--fast` / `--no-zopfli` | Trade a few percent of size for speed |
| `--keep-metadata` | Preserve EXIF/ICC instead of stripping it |
| `-j 8` / `-v` | Workers / show every version tried |

### Choosing a quality target

The visual match runs to 100, where 100 means indistinguishable:

| Value | Feels like |
| --- | --- |
| `95` | Overkill for most things. Masters you'll re-edit |
| `90` | **Default.** Not noticeable even in a flicker test at 1:1 |
| `85` | Imperceptible when toggling A/B |
| `80` | Imperceptible side by side |
| `70` | Perceptible but not annoying. Fine for thumbnails |

---

## Why `documents` refuses WebP

"Just use WebP" is the standard advice and it is wrong if your image is going
into a design tool or a document. This looks like a limitation and is the
feature.

Figma's docs list WebP as an accepted upload format. But Figma's plugin API only
knows PNG, JPEG and GIF — `figma.createImage` rejects everything else — and the
standing community answer is that a WebP dropped onto the canvas is **decoded
and re-encoded as PNG**, with no way to recover the original. TIFF import
working *only in Safari* points the same way: Figma leans on the browser's
decoder, then re-encodes. Office suites and document editors behave much the
same way.

If that's right, handing one of these tools a beautifully compressed 40 KB WebP
photo gets you a multi-megabyte PNG inside the saved file. The downside is
severe and the upside is a few percent, so `--for documents` sticks to formats
those tools are documented to store byte-for-byte. AVIF isn't supported by
Figma at all, and neither is JPEG XL.

`documents` carries two size numbers, doing two different jobs. **2560px** is
the everyday downscale, the same as `web` — memory pressure in these tools comes
from pixel dimensions more than from bytes, and no codec recovers what a 6000px
export wastes when it renders at 1200px. **4096px** is a ceiling, not a setting:
it clamps even an explicit `-m 8000`, because anything above it is downscaled
destructively on import with no control over the resampling, so the choice is
between our Lanczos and theirs. Asking for more is not refused, just quietly
brought down — the intent is reasonable, the destination simply cannot carry
it.

Every other destination allows the modern formats, which is why `web` is the
default: the restriction is a fact about design tools, not about images.

---

## Install

```bash
pip install "pocketsize[full,app]"     # everything
pip install "pocketsize[video]"        # add video (needs Python 3.11+)
pip install pocketsize                 # core only, weaker fallbacks
```

`video` is a separate extra rather than part of `full`, for two reasons that are
both real. PyAV needs Python 3.11 and the rest of this package still runs on
3.9, so folding it in would drop two interpreter versions to add a feature most
people installing an image compressor did not ask for. And its wheel carries a
whole FFmpeg, x264 and x265 included.

Or from a checkout — on Windows, double-click **`run.bat`** for the app or
**`compress.bat`** for the command line; on macOS and Linux run `./run.sh`.
Either way the first run installs what it needs.

`full` pulls in the parts that do the real work. All ship Windows wheels, so
there is nothing to compile and no binaries to install:

| Package | What it does | Worth |
| --- | --- | --- |
| `ssimulacra2` + `scipy` | The perceptual metric | The whole premise |
| `imagequant` | libimagequant, the engine inside pngquant | Large — Pillow's own quantizers reached SSIMULACRA 2 87 at 256 colours where this reached 90 at 64 |
| `zopflipy` | zopflipng-grade deflate | ~10% off any PNG, lossless |
| `mozjpeg-lossless-optimization` | mozjpeg's lossless pass | ~1%, free |

`pocketsize --check` reports what's active. Without them the tool still runs,
with weaker built-ins.

**The downloadable installers ship without `imagequant` and without video.**
Both carry GPL-licensed compiled code — libimagequant, and the FFmpeg inside
PyAV — and putting either in a binary we hand out would place this MIT
project under the GPL. Installing with `pip` is unaffected: your own package
manager fetches them, so `pip install "pocketsize[full,video]"` gets
everything. The installer difference is measured at 0.5% on the benchmark
corpus, because the comparison usually ships WebP or JPEG rather than PNG-8
anyway. See [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

---

## What it does to each image

1. **Caps the pixel dimensions.** The single biggest win; no codec recovers the
   bytes wasted on a 6000px export that renders at 1200px.
2. **Strips metadata** — EXIF, camera junk, colour profiles, XMP blobs.
3. **Runs the comparison**, searching each format for the smallest setting that
   still looks close enough to the original.
4. **Keeps the smallest winner**, and never writes a file bigger than the source.

Transparency is preserved, and scored against both a dark and a light backdrop
with the worse score winning — a halo you can't see on white is still a defect.
Animated GIFs pass through untouched. Corrupt files are reported and skipped,
never crashing the run.

JPEG output is always **4:4:4**. With chroma subsampling on, matching 4:4:4's
score on saturated content needed quality 97 instead of 76 — a **3.8× larger
file**. Luma-only metrics like SSIM can't see this, which is how the mistake
survives in most hand-rolled compressors.

---

## Development

```bash
git clone https://github.com/SyedSaribSultan/pocketsize && cd pocketsize
pip install -e ".[full,app,video,dev]"
python -m unittest discover -s tests     # 201 tests, ~6 min
python tests/make_fixtures.py            # build the benchmark corpus
python tests/bench_formats.py            # the format table above
python tests/bench_versions.py           # matched-quality comparison vs v1
python tests/make_video_fixtures.py      # the video corpus
python tests/bench_video.py              # the video table above
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The one rule worth stating up front: any
change that affects output needs a measurement at **matched perceptual quality**
— a smaller file at a lower score isn't an improvement, it's a different
setting. And never validate a metric change using that same metric.

The screenshots in this README were compressed by the tool (`--for web`),
which is the least I could do.

## Licence

MIT.
