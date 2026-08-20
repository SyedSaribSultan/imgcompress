# Video Parity & Resource Plan — 2026-08-20

> **Owner instruction, 2026-08-20:** "just do what's recommended from the
> things that you need from me… make my app most scalable, most understandable,
> most versatile, and most adaptive." All ten ASK items below are therefore
> **taken as approved at my recommendation** and recorded as decisions. The
> resource work in Phase R was added after the owner reported a 300 MB video
> freezing the whole laptop.
>
> **STATUS: IMPLEMENTED 2026-08-20**, in two commits on branch `video-parity`.
>
> | Phase | State |
> | --- | --- |
> | R — resources | Done. 287 MB clip: peak growth 4,536 MB → ~1,300 MB, 129s → 86s. Correctness byte-identical (still.mp4 → 6,881 bytes at 74.7) |
> | R6/R7 — size honesty | Done. Heavy (>200 MB) is said and then done; too big (>2 GB) is refused with the desktop route named |
> | 0 — see it fail | Done. Both new gates observed red first, recorded in the commits |
> | 1 — the model | Done. `queueKinds()`; `videoPlan()` untouched as planned |
> | 2 — the controls | Done. Floors that really run, the byte ceiling read-only, mixed-queue attribution |
> | 3 — the copy | Done, including the `twitter:*` pair the earlier SEO audit missed |
> | 4 — propagation | Done. Desktop app and the 13 generated pages regenerated, not hand-edited |
> | 5 — verification | Done. 231 Python tests, ruff, three generated-file checks, e2e 85/85, ten browser probes |
>
> **Two things learned that changed the plan as written, both recorded in the
> code rather than only here:**
>
> 1. **Gating on resident memory does not work**, and the attempt is preserved
>    in `probe_video_memory.mjs`'s header so nobody rebuilds it. Run-to-run
>    spread on one file is ~19% (1,824 / 2,011 / 2,144 / 2,176 MB on the same
>    input), because RSS is sampled on an interval against a garbage-collected
>    runtime. A budget tight enough to catch the whole-file-buffer regression
>    failed honest builds; a loose one let `fastStart: "in-memory"` through
>    while showing green — verified by reintroducing it. The gate therefore
>    asserts the **mechanism** (the largest single buffer the muxer hands over:
>    4 MB when fixed, 87.7 MB when broken) and keeps RSS only as a loose
>    runaway ceiling.
> 2. **`fastStart: "reserve"` is unavailable to us**, which the plan had listed
>    as the tidy answer. It requires `maximumPacketCount` per track, and a
>    quality *search* cannot know that — it discovers the packet count by
>    encoding. So the moov index moves to the end of the file, which costs
>    nothing for a local download and is documented where someone would
>    otherwise "fix" it back.
>
> **Still open, deliberately:** the C1 HDR performance question (a compiled
> path conflicts with the pip-only rule — an owner decision recorded in the
> video plan), and i18n copy, which needs a person who speaks the language.

## Part 1 — Specifications, compatibility, and why your laptop froze

### What the browser tier actually does to a video

| Property | Value | Where |
| --- | --- | --- |
| Containers read | MP4, MOV, WebM, MKV | `ALL_FORMATS`, Mediabunny |
| Container written | MP4 only, `+faststart` | `Mp4OutputFormat` |
| Codecs written | AV1, H.264 (per destination, best-first) | `DESTINATION_VIDEO_FORMATS` |
| Codec decode | whatever the browser ships, HEVC decode included | WebCodecs |
| Audio | AAC 128 kbps, re-encoded | `video-worker.js:229` |
| Quality metric | SSIMULACRA 2 (same port as images), low percentile not mean | `pooled()` |
| Search | bisection over a quantizer ladder, ~5 probes, 20 s windows | `searchQuality()` |
| Frame cap / floor / byte cap | per destination: 1280–1920 px, 88–96, 10/18/500 MB | `DESTINATION_VIDEO_NUMBERS` |
| Concurrency | **one video at a time**, in its own module worker | `engine.js:197` |
| Hardware encode | reported but not required | `caps.hardware` |
| **Input size limit** | **none** | — |

Compatibility: needs WebCodecs plus a `VideoEncoder` the browser admits to.
That is Chrome/Edge and Chromium derivatives today; Safari 17+ partially;
Firefox largely not yet. When it is missing, `state.canEncodeVideo()` is false
and the approved V8 line shows: *"This browser can't re-encode video yet — the
desktop app can."* That path is already correct and stays.

### Why 300 MB froze the machine — three real causes, in order

**1. The output is assembled entirely in RAM.** `video-worker.js:214`:

```js
new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }),
             target: new BufferTarget() })
```

`BufferTarget` means the whole encoded file lands in one `ArrayBuffer`, and
`fastStart: "in-memory"` forces the muxer to hold every packet so it can write
the index at the front. Nothing streams to disk. For a 300 MB source the peak
is the source blob, plus the in-memory output, plus decoded frames in flight —
comfortably over 1 GB before the OS starts swapping. **Swapping is what froze
the laptop, not CPU.**

**2. Every probe re-encodes, and each probe holds its own output blob.**
`searchQuality()` runs ~5 rungs; each rung encodes every sample window
(`parts[]`) and holds those blobs while it scores them. Then a two-format
bake-off (`web` and `original` allow AV1 *and* H.264) does the whole thing
again, and `candidates[]` retains the losing format's blob until the winner is
picked. The 20-second windows bound this well for probing, but the **final**
encode is the whole file, once per format — two full-size in-memory outputs.

**3. Scoring decodes to raw RGBA.** `makeReader().frames()` calls
`getImageData`, which is 4 bytes per pixel, uncompressed. One 1920×1080 frame
is 8.3 MB. `refCache` holds reference frames for the whole job — deliberately,
because re-decoding them was worse — but nothing bounds that cache. A long clip
means many windows, and windows × `PROBE_FRAMES` × 8.3 MB is unbounded growth.

Worth being precise about the credit here: whoever wrote this already fixed the
*worse* version of the problem. `video-worker.js:150-159` records that the old
shape re-opened the file up to 480 times and killed the tab. One reader per
file plus `refCache` was the fix. **The remaining problem is that the fix
bounded the file handles but not the bytes.**

### What "smaller allocation, more waiting" should and should not mean

Your instinct is right, with one correction. Deliberately idling — encode a
bit, `setTimeout`, encode a bit — would make a slow job slower without fixing
the freeze, because **the freeze is memory pressure, not CPU hunger.** A
process that holds 1.5 GB and sleeps half the time still swaps.

So the plan does the version of your instinct that actually works:

- **Cap the bytes in flight** (stream the output, bound the frame cache). This
  is the real fix.
- **Yield between units of work** so the tab stays interactive and the OS can
  schedule other apps — cheap, and it makes the machine *feel* alive.
- **Scale the work to the machine**, adaptively: fewer probes, fewer cached
  frames, smaller windows on a weak or memory-constrained device.
  `worker.js:97` already has a `WEAK_DEVICE` notion — video should honour the
  same idea instead of inventing a second one.
- **Tell the truth up front** on a very large file, rather than silently
  attempting something that will hurt.

## Part 2 — approved decisions (were ASK-1…ASK-10)

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Intake verb becomes **"Add files"** | Shorter than the current "Add pictures" on the one primary action, and true for both media. Specifics live in the empty state, where teaching already happens |
| 2 | Region heading becomes **"Files"** | Same vocabulary as 1. "Media" fails the five-year-old bar |
| 3 | The `<h1>` stays `.vh` | Its comment records the heading-outline reason; painting it pushes the dashboard below the fold and breaks "the page reads as a sequence" |
| 4 | Byte ceiling shown as a **read-only line**, only when a video is queued | It is a fact about the destination, not a question. Editable would add a decision and let someone defeat Discord's real limit |
| 5 | Sound rule shown **result-side only** | Nobody decides it; the container does. `facts.js` already renders `audioNote` |
| 6 | **"Must still look" states the floor that will actually run** | The one true correctness bug: control says 90, engine runs 92 for `web`. This is the drift `reflectQualityWords` exists to prevent |
| 7 | Mixed queue shows **both floors on the one line** | Hiding one is a lie; two panels breaks decision count |
| 8 | Frame-cap row is reused, noun changes in the readout | It is genuinely the same axis for both media |
| 9 | Override block becomes **"Just this one"**; format select hidden for video, quality kept | The not-swappable rule forbids a video format control; quality is legitimate |
| 10 | The 8 image-only SEO pages get **no** video mention | `/compress-png` is about PNG. Video has its own three pages. Forcing it everywhere is the keyword stuffing that gets ignored |

**Not re-decided, and must not be undone:** video format is never a control.
Image candidates all survive a run so a chip can swap them; a video run keeps
only the winner, so a chip promising a swap "would be a control that lies"
(`facts.js:110`, pinned by `probe_video_ui.mjs`). The video equivalent of the
format pin is a disclosure.

**The governing rule, from both existing plans:** a video answers the same one
question an image does — *where is it going?* Decision count must not grow;
first-run required decisions stay 0. Parity comes from making existing controls
**bilingual, never from adding a video mode.** No second panel, no media-type
switch.

## Part 3 — order of work

Phase R ships first: it is a real defect that makes the product hostile on the
files it exists for, and the owner hit it.

### Phase R — resources (do first)

Each item is a separate commit with its own measurement. **The rule: measure
peak memory and wall time on a large real file before and after each change.**
Never validate a memory change by wall time alone.

1. **Stream the output instead of buffering it.** Replace `BufferTarget` +
   `fastStart: "in-memory"` with a streaming target, and only rewrite the index
   at the end. If Mediabunny's target set cannot do this without buffering,
   fall back to `fastStart: false` for large inputs and document the tradeoff
   (a file that must be fully downloaded before it plays, which for a local
   download is no cost at all). **This is the single biggest win.**
2. **Bound `refCache`.** A byte budget, not an entry count — entries are frames
   and frames differ in size. Evict least-recently-used. Cache with a ceiling
   is still a cache; unbounded is a leak with a nice name.
3. **Release each losing candidate's blob as soon as it loses.** Keep the
   winner only. Today both formats' full outputs coexist.
4. **Yield between windows, probes and formats.** A real yield to the event
   loop so `progress` messages flush, cancellation lands promptly, and the OS
   can schedule other work. Not a delay loop — a yield.
5. **Adaptive budget, one place.** A single function deriving probe count,
   cached frames, and window length from `navigator.hardwareConcurrency`,
   `navigator.deviceMemory` where available, and the input's size and
   resolution. Honour the existing `WEAK_DEVICE` idea rather than inventing a
   second one. On a big file: fewer probes, smaller windows, tighter cache —
   slower and honest beats fast and hostile.
6. **Say so on a very large or long file, before starting.** One line in the
   register the product already uses, e.g. *"This is a big video — it will take
   a while, and your computer will be busy."* No jargon, no percentages, no
   scare copy. Plus the existing Stop must stay reachable throughout.
7. **A size ceiling for the browser tier**, chosen from the measurements in 1–5
   rather than picked now, above which the page recommends the desktop app in
   the V8 register instead of attempting it. The desktop tier already has
   `MAX_VIDEO_BODY`; the browser tier has nothing.

New gates, each **observed failing first**: peak-bytes stays under budget on a
large fixture; the losing candidate's blob is released; the frame cache never
exceeds its budget; the worker yields (progress arrives during a long encode);
the oversize path recommends the desktop app.

### Phase 0 — see the parity gap fail

Extend `tests/web/probe_video_ui.mjs` (or add `probe_video_parity.mjs`) with
assertions that fail today: the plan panel states a byte ceiling when a video
is queued; "Must still look" states the floor the video engine will really use;
the primary action does not say "pictures"; a mixed queue discloses both
floors. Run it, record the red in the commit message.

### Phase 1 — the model, no visible change

`web/js/state.js`: add `queueKinds() → {hasImages, hasVideo}` so one place
answers "what is this run about" and no module re-derives it. Confirm
`videoPlan()` needs no change — **do not touch the spoken-quality rule at
`state.js:154`**; it is deliberate and the CLI matches it.

### Phase 2 — the controls

`web/js/settings.js` becomes bilingual: floors that will really run (6, 7), the
read-only ceiling line (4), medium-correct wording for "automatic — keep
whichever comes out best" and its "Writes the image every allowed way" title,
and `reflectDirty()` must not flag video-derived values as changed.
`web/index.html` gains the ceiling line as a central class — **no inline
`style=`, no new colour literal** (`CLAUDE.md` UI rules 1–2, enforced by
`test_design_system`). `web/css/controls.css` only if a genuinely new pattern
is needed, added centrally.

### Phase 3 — the copy, in one pass

`index.html`: intake button, empty state, region heading, queue hint, skip
link, stage-empty, "Just this image" → "Just this one", "Keep full size for
this picture", `out-name`'s aria-label, `#about` ordering. Every user-facing
string in `web/js/*.js` that says picture/image where it now means either —
grep, do not guess. And `twitter:title` / `twitter:description`
(`index.html:25-26`) **still say images only** — the SEO audit missed the
Twitter pair.

### Phase 4 — propagation (invariant, not optional)

`python tools/sync_webui_assets.py` and commit the copies — the desktop app
never diverges and is never hand-edited. Keep `pocketsize/webui/app.html` in
step. Regenerate the SEO pages with `tools/gen_seo_pages.py` so the three video
pages inherit the new copy; CI diffs generated files.

### Phase 5 — verification

```
python -m unittest discover -s tests      # baseline today: 231 pass, 49 skip
ruff check .
python tools/gen_destinations.py --check
python tools/sync_webui_assets.py --check
python tools/gen_seo_pages.py --check
node tests/web/probe_video_ui.mjs
node tests/web/probe_controls.mjs
node tests/web/probe_a11y.mjs
node tests/web/probe_presets.mjs
node tests/web/probe_sizecap.mjs
node tests/web/probe_video_pages.mjs
node tests/web/e2e.mjs
```

`pre-push-checks`: pytest green is not enough — CI runs ruff and the Chrome
probes, and CI must be confirmed by reading job conclusions.
`ci-only-runs-on-main`: a feature branch triggers nothing and needs a manual
dispatch.

## Risks

- **The copy sweep is riskier than the controls.** Four probe suites assert on
  rendered text and real app state. `CLAUDE.md`: copy changes must **update
  assertions, not delete them**. Deleting one to get green is the worst outcome.
- **Phase R item 1 may hit a library limit.** If Mediabunny cannot stream a
  faststart MP4, the honest fallback is `fastStart: false` on large inputs, with
  the tradeoff written down — not a silent buffer.
- **Decision 6 visibly changes the plan** for anyone who moved the slider,
  because the number on screen starts matching the number that runs. Correct,
  but not cosmetic.
- **`web/destinations.js` is generated.** Never hand-edit; fix
  `pocketsize/destinations.py` and regenerate.
- **Never write repo files from PowerShell** (`Set-Content` produced mojibake
  once and a BOM once). Use Edit/Write.
- **`main` auto-deploys to `pocketsize.vercel.app` within seconds of a push.**
  The copy sweep lands as one reviewed commit, not a trickle of half-states.

## Out of scope

No hosted anything. No new required decisions. No video format control, ever.
No second panel or video mode. No re-deciding what the two existing plans
already decided. The C1 HDR performance question stays an open owner decision,
unrelated to this surface work.
