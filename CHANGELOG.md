# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Video, answering the same one question.** A video answers "where is this
  going?" exactly the way a picture does, so it lives in the same destination
  table rather than a parallel one, goes in the same folder, and comes out the
  same way: several settings tried, every result opened back up and measured
  against the source, and the smallest one that still looks close enough kept.
  Video adds **zero required decisions**.

  | `--for` | Formats | Frame | Visual match | Size limit | Sound |
  | --- | --- | --- | --- | --- | --- |
  | `web` | AV1 / H.264 MP4 | 1920px | 92 | — | kept as it was |
  | `email` | H.264 MP4 | 1920px | 90 | 18 MB | kept as it was |
  | `chat` | H.264 / AV1 MP4 | 1280px | 88 | 10 MB | AAC |
  | `social` | H.264 MP4 | 1920px | 90 | 500 MB | AAC |
  | `documents` | H.264 MP4 | 1920px | 90 | — | AAC |
  | `original` | AV1 / H.264 MP4 | never resized | 96 | — | kept as it was |

  `thumbnail` takes no video and says so rather than inventing an answer.
  `pip install "pocketsize[video]"` — Python 3.11+, deliberately not part of
  `full`, because PyAV needs 3.11 and the rest of the package still runs on 3.9.
  Without it a video is reported and skipped with the install command in the
  message, never a crash.

  Four things about the engine are worth stating because they are the
  difference between this and a tool that guesses. The search runs on **sampled
  20-second windows** rather than the whole file, because a ten-minute clip
  takes minutes per attempt and the search needs several; only the winning
  setting is applied to the whole file. The reported score is the **low
  percentile of the sampled frames, not their mean** — a per-frame metric cannot
  see time, and an average calls "perfect for four seconds, falls apart for one"
  fine. A **size limit is a limit, not an instruction to spend it**: quality is
  searched first even under a cap, and the cap only decides when the honest
  quality answer will not fit, which the result line then says. And **rotation
  and pixel shape are baked into the output**, because a flag is advice and
  plenty of players, upload forms and editors ignore it.
- **HDR video is tone mapped rather than flattened.** A clip with a PQ or HLG
  transfer — what a modern phone records by default — is detected and converted
  properly: inverse transfer to linear light, BT.2020 primaries to BT.709, a
  documented tone curve, and the result says the colour was converted. The
  arithmetic is pinned by tests against the standards rather than against
  itself. A transfer that cannot be named is refused rather than guessed at,
  and the browser tier, which has no tone mapper, leaves HDR alone and says so.
- **A second, unrelated measurement on every video result.** XPSNR is recorded
  alongside the score the search optimised, because a number the search was
  steering on is a claim rather than evidence — encoders now ship modes tuned to
  score well on named metrics. Where the build has no `xpsnr` filter the result
  carries one number instead of two, which is a missing second opinion and not a
  failure. This inverts the roles the plan proposed (steer on XPSNR, certify
  with SSIMULACRA 2): the destination targets are numbers on the SSIMULACRA 2
  scale, the same scale the picture tier reports, and steering on XPSNR would
  have meant mapping "visual match 92" onto a dB figure, which is
  content-dependent and has no principled conversion. The rule the plan exists
  to protect is intact — the number the search optimises is never the only
  number reported.
- **A long job says what it is doing, and can be stopped.** A video encode is
  the first thing this project does that can run for minutes, and silence for
  minutes is indistinguishable from a hang. The command line draws a live bar on
  a terminal and stays quiet when redirected, Ctrl-C stops cleanly, and nothing
  half-written is left behind.
- **A `chat` destination** ("Discord or group chat"): H.264 first then AV1,
  1280px, match 88, a hard 10 MB ceiling, AAC sound. Discord's 10 MB and a mail
  server's 25 MB are one destination for a picture and two for a video, and the
  numbers come from different companies.
- **The desktop app compresses and compares video.** The same stage gained a
  second pair of layers, so the split, the divider and the zoom keep working
  unchanged, with the compressed player following the original's clock — two
  free-running players drift apart within seconds, and a split showing second 3
  against second 5 is not a comparison. Preview is served with byte-range
  support and streamed off disk in chunks: the whole point of this tier is that
  the files are large, and a player that cannot seek cannot be compared against
  anything. Saving moves the file the engine already wrote instead of encoding
  twice, and never writes over a file already sitting there.
- **`tests/VIDEO_BENCHMARK.md`**, with `tests/bench_video.py` to reproduce it:
  every strategy that can be searched, searched to the same visual match of 92,
  scored by two metric families. On the near-static clip the searched AV1 encode
  ships 9,952 bytes at 94.8 and **every fixed-quality default misses the floor
  outright**, including two AV1 ones that produce *smaller* files (7,258 and
  8,701 bytes, at 90.5 and 91.2). On the screen recording it ships 3,379 bytes
  where x264 at the internet's usual CRF 23 needs 8,503. It is equally plain
  where nothing wins: the `motion` and `grain` fixtures are written near-lossless
  on purpose, no strategy clears 92 on either, and the rows say so rather than
  quietly lowering the bar.
- **Two video fixture corpora, for two different jobs.**
  `tests/make_video_fixtures.py` varies the *content* — motion, screen
  recording, heavy grain, near-static — which is what decides how well anything
  compresses. `tests/make_real_world_fixtures.py` varies the *container and
  metadata* — a phone held upright, one held upside down, non-square pixels,
  HDR, variable frame rate, two soundtracks — which is where a video compressor
  silently produces wrong output rather than merely a large file. Building the
  second one found five defects, each observed failing before it was fixed.
- **A browser video engine, proven on the device.**
  `web/video-worker.js` compresses video entirely on the device: Mediabunny
  (MPL-2.0, vendored and hash-pinned) reads and writes the containers, and every
  frame goes through the browser's own WebCodecs. Verified in real Chrome
  against the real CSP by `tests/web/probe_video.mjs` — an 18 KB clip to 6.9 KB
  as AV1, measured at 74.7 by the same SSIMULACRA 2 port the picture tier uses,
  with progress reported throughout and no console errors. No codec ships with
  the page, so it stays small and carries no patent licence; and because nothing
  needs threads, the site keeps its existing CSP with **no cross-origin
  isolation** — the ffmpeg.wasm route would have forced COEP across the whole
  site, run 12–25× slower, and shipped GPL-linked x264. `media-src 'self' blob:`
  was added to the CSP so a result can be played back, and the service worker
  went to `v3`. Stated plainly because it is the honest part: a browser's
  encoder is tuned for video calls, and gives up something like 10–30% of the
  file size a patient desktop encoder finds. What this entry covers is the
  engine; the page's own queue, settings panel and split-compare view are a
  separate piece of work.
- **`tools/gen_ss2_module.py`**, which writes `web/ss2.module.js` from
  `web/ss2.js`. The image worker is a classic worker and reads the metric with
  `importScripts`; the video worker is a module worker, which has none, and the
  CSP rules out every runtime escape hatch (`eval`, `new Function`, `data:`).
  Rather than keep a second hand-written copy of a validated metric, the module
  form is generated and CI checks it — exactly how the destinations table is
  handled. Drift there would mean the browser's two engines quietly disagreeing
  about what "looks the same" means.
- **Fifty small rights.** The principled-improvements round, everywhere at
  once: the caliper grew a visible grip and recentres on double-click; fit
  places the image between the floating bars instead of under them; the side
  labels never slide off-stage; After/Diff modes carry a badge saying what is
  showing (and the heatmap its legend); filenames middle-truncate so the
  distinguishing tail survives, with the full name on hover; every row has
  hover remove and, when failed, retry; the batch footer reads "4 of 6 done"
  mid-run and leads the saving with its percentage; the zip button carries the
  output size and flashes "Saved ✓"; Clear became undoable instead of
  confirmed; toasts queue, time themselves to their length, pass clicks
  through, and receipts preempt asides; the drag overlay counts what is about
  to be dropped; the plan sentence includes a pinned file type, changed fields
  wear a dot, and "Back to automatic" undoes the lot; the pixel limit offers
  landmark sizes; More choices remembers being open; the capability notice
  became a one-time aside instead of permanent header furniture; the alpha
  dialog's buttons carry the count; the resize disclosure gained a one-click
  "keep full size for this picture"; under-floor chips explain the floor on
  hover; hovering any chip previews it on the stage without committing; the
  per-image override speaks the plan's own quality words; the wordmark and "?"
  open a shortcuts card; one-time hints teach Space-to-flick, focus-mode's
  exit, offline readiness, and offer the install at the first moment of
  demonstrated value; and `prefers-contrast: more` steps the quiet inks up.
  Deliberately NOT done: multi-select (contradicts the single-selection
  listbox model - per-row remove covers it), list virtualisation (premature
  before a real 500-file test), and per-rung savings estimates (this product
  measures; it does not guess).
- **"identical — every pixel kept"** as the top rung of the quality control,
  web and CLI (`--lossless`, or `--for lossless`). Only pixel-exact candidates
  enter the bake-off and shrinking turns off visibly, because resizing changes
  pixels. The hidden `lossless` destination stopped carrying the everyday 2560px
  downscale, which quietly contradicted its own name.
- **A `social` destination** ("Social media post"): JPEG/PNG only, 2048px,
  match 88 — sized and saved so the platforms don't re-shrink uploads themselves.
- **A written record in every zip.** `pocketsize-report.txt`: per picture, what
  was kept, what changed in bytes and pixels, the measured match, whether it is
  pixel-exact, and the full versions-tried table.
- **A theme control.** Light / Dark / Match my device, cycled in the header,
  applied before first paint. The default remains following the device.
- **The web page finally mentions the CLI** — one line in the sidebar. Same
  engine, for folders and scripts.
- **A video reads as a video at a glance.** Purple where a picture takes the
  brand accent, on a badge that already says "Video" and how long the clip runs
  — so the colour is a second, faster signal in a mixed queue and never the only
  one. Two purples rather than one, because a single value cannot clear the
  contrast floor on both the light and the dark ground. The desktop queue drew
  no badge at all before this, so a clip was a row with an empty thumbnail
  square and nothing saying why.
- **Numbers follow the reader.** Sizes, scores, percentages and times are
  written in the notation of whoever is looking, taken from their own browser.
  The words are still English — that needs a person who speaks the language,
  not a machine translation, and the literal register this product is written
  in is the whole reason.
- **Three pages for people who arrive looking for video**: compressing a video
  at all, fitting one under Discord's 10 MB limit, and getting one small enough
  to email. Same machinery as the existing use-case pages, and the plan is set
  before the person does anything.
- **The licences of everything an installer bundles now travel with it.** A
  generated `THIRD-PARTY.txt` beside the application, collected from the wheels
  actually installed at build time rather than from a list somebody maintains
  by hand. The build fails rather than shipping one with a gap in it.
- **The downloadable installers ship without `imagequant`**, and Pocketsize
  stays MIT. Its wheel declares BSD, but that covers only the Python binding —
  the compiled libimagequant inside is GPL v3-or-later for open-source use,
  per upstream. Handing that out inside our binary would have put this whole
  MIT project under the GPL. Installing with pip is untouched, since your own
  package manager fetches the wheel and we distribute nothing. The cost was
  measured before the decision, not assumed: **0.5%** across the benchmark
  corpus (461,500 → 463,830 bytes), because the comparison almost always ships
  WebP-lossless or JPEG rather than PNG-8 anyway. Enforced in three places, one
  of which is a release gate that also fails if `--check` stops naming the
  excluded engines at all — an absence nobody can see is indistinguishable
  from a violation.

### Changed
- **Both interfaces wear a new skin, and not one line of it is a new colour in
  a component sheet.** The palette is PostHog's — a warm eggshell ground in
  light, deliberately cool blue-charcoal in dark, never white-on-black — and the
  patterns that come with it: the accent swaps hue between themes (orange in
  light, yellow in dark), buttons sit on a hard 3px plate rather than a soft
  shadow, depth comes from surface steps and border promotion instead of glows,
  every number renders in the mono face with tabular figures, and section
  headers are uppercase micro-labels. Mechanically it is a **re-valuing of the
  existing `--oz-*` vocabulary inside the existing theme blocks**: no sheet
  outside `heyoz-tokens.css` and `base.css` gained a colour literal, the desktop
  app received its copies from `tools/sync_webui_assets.py`, and
  `tests/test_design_system.py` held all 27 of its checks throughout. Two of
  PostHog's numbers were overridden on purpose — their 12px table headers and
  14px body lose to this project's 13px legibility floor and 15–16px body, which
  is a binding constraint and outranks a reference. The new palette was audited
  for contrast and passes AA on all twelve text pairs in both themes. This makes
  Pocketsize PostHog-*flavoured*, never PostHog-branded: no marks, mascots,
  illustrations or wordmarks are imitated. Details and the full value mapping:
  `docs/POSTHOG_DESIGN_SPEC.md`.
- **`email` is labelled "Email" rather than "Email or chat".** It has to be: an
  email attachment and a Discord message are one destination for a picture and
  two for a video, and 18 MB and 10 MB are numbers chosen by different
  companies. The chat half is now its own destination rather than a promise the
  label could not keep.
- **The project is renamed from imgcompress to Pocketsize.** The package, the
  `pocketsize` and `pocketsize-gui` commands, the installers and the repository
  slug all carry the new name, and the web app now lives at
  [pocketsize.vercel.app](https://pocketsize.vercel.app).
- **Resize disclosure moved to the same line as the saving, everywhere.** The
  stage bar, the queue row, the zip toast and the measured panel all say
  "shrunk" beside the percentage; the explanation sits above the stat grid at
  full strength, not under it in fine print. The documents destination's 4096px
  ceiling overriding an explicit "never shrink" is now a warning, stated in the
  plan before it happens and on the result when it did — carried by an explicit
  flag from the worker, never inferred from numbers.
- **Results appear the moment the first format clears the floor.** Each encode
  is posted as it finishes; the stage adopts the best-so-far ("Here's the JPEG —
  still trying 3 more ways in the background") and the chips fill in live. The
  final message remains the authority.
- **A settings change no longer blanks the screen or wastes the work.** Finished
  results stay up, marked "updating to your new settings…", until replacements
  land; workers mid-flight are told to stop instead of completing answers nobody
  will see; probe scores are remembered per rung, so a floor nudge re-reads them
  instead of re-encoding five rungs per format.
- **Codec WASMs load together, and early.** The four downloads run in parallel
  instead of one after another, and are warmed at page idle - the first drop
  starts encoding instead of downloading. Weak devices (≤3 cores or ≤4GB) skip
  AVIF in the automatic set, say so, and keep "always AVIF" as the way to insist.
- **The plan reads as one story in plain words.** Pictures first, then three
  visible questions — Going to / Must still look / Shrink big photos — with
  everything else under "More choices". The quality words reorder so each rung
  reads strictly weaker than the one above; base type moved to 16px with nothing
  below 13px anywhere; the evidence panels appear when there is evidence instead
  of sitting as dimmed scaffolding.

- **Works offline, installs as an app, and the OS can hand it files.** A
  service worker precaches the whole compressor - codecs included - so after
  one visit it runs with no network at all, which is the "nothing is uploaded"
  promise made physical. The manifest registers image file handlers: installed,
  "Open with Pocketsize" appears in the file manager and dropped launches land
  straight in the queue.
- **The panels are the person's own.** The sidebar's edge and the evidence
  panel's top edge drag (or arrow-key, focused) between sane bounds, remember
  their size, and double-click back to automatic.
- **Focus mode.** F, Escape, or the stage button: the comparison and nothing
  else. The queue keeps working behind it.
- **Every control got the refinement pass** on the token system: elevation at
  rest and on hover, real hover/press states off the system ramps (press squash
  through the spatial scale, so reduced motion collapses it), custom select
  chrome with a masked chevron, selected rows and chips on the system's
  selected fill, glass floating bars over the photograph, pill progress tags,
  an overlay-dimmed blurred dialog backdrop, and vendored Lucide glyphs beside
  their words - never instead of them (ISC, see vendor/LICENSES.md).
- **The browser app reads the HeyOz token layer again**, through one
  indirection: `base.css` aliases the app's six-name vocabulary onto `--oz-*`
  values (brand accent, surfaces, ink ramp, spacing steps, radius, Geist /
  Geist Mono via the self-hosted faces), so both interfaces draw from one
  design system. The theme control drives the token layer's own `data-theme`
  mechanism; `js/theme.js` stamps a resolved theme before first paint and
  re-stamps live when the OS preference changes.

### Fixed
Building video turned over fifteen defects, and an adversarial review of the
finished tier turned over sixteen more. The five the awkward-input corpus found
were each observed failing before they were fixed; most of the rest were turned
up by a benchmark, a probe, a corpus or an audit rather than by reading the
code, which is the point of building all four.

- **The browser silently ignored size limits.** The page computed the byte
  ceiling for a destination and then dropped it before the worker saw it, and
  the worker had no cap logic at all — so somebody choosing "Discord or group
  chat", whose help text says *"Fits Discord's free 10 MB limit"*, could be
  handed a file several times that with nothing said. Measured: 1,986,165 bytes
  against a 92,160-byte cap. The browser now runs the same quality-first hybrid
  the desktop engine does, and posts the same `capped` / `missedSize` flags the
  result line repeats.
- **The desktop app rendered neither the size-limit disclosure nor the sound
  note**, though the engine had been sending both all along. A quality traded
  away to meet a byte limit is exactly the kind of fact that has to ride on the
  same line as the saving, at the same size.
- **A video's sound could be described two ways that were not true.** The claim
  was worked out after the fact by comparing codec names on the finished file,
  so audio decoded and re-encoded back to its own codec read as "kept exactly as
  it was" — and a file whose sound failed to open at all, which is a *silent*
  result, read as "re-encoded". The claim now comes from what the encode
  recorded doing, and a silent result says so twice.
- **The second opinion was wrong on every rotated video.** XPSNR compared the
  straightened output against the sideways stored reference and reported about
  −1.3 dB — a catastrophe that was not there, on the single most common shape of
  consumer video. It now straightens the reference through the encoder's own
  transform chain, pairs frames by timestamp, and pools worst-first like every
  other score here.
- **A resized video could ship larger than its source, wearing "−0%".** The
  never-bigger rule stepped aside whenever the frame had been resized. A limit
  on the frame is not a licence to hand back a worse file.
- **Cancelling a video did nothing for minutes.** The stop flag was only checked
  between stages, and the desktop app never passed one at all — so removing a
  clip from the queue dropped the row while the worker encoded on. Stopping is
  now checked inside the encode and verify loops, and whoever owns a
  half-written file removes it on the way out.
- **Video working files were never deleted.** Thirty phone clips quietly left
  several gigabytes in the system temp folder, permanently. They are now removed
  with their item, swept if the item vanishes mid-encode, and cleared when the
  app closes.
- **A lying duration label could turn a 10 MB limit into a 5,690 MB file.**
  Container metadata is not always honest — a copy interrupted mid-transfer, a
  muxer that wrote the header early — and everything that divides by duration
  inherited the lie. The packets are counted instead whenever a cap is set.
- **The browser worker leaked decoder resources and re-opened the whole file for
  every read** — about 480 full-file opens on a four-hour clip, with WebCodecs
  frames that the garbage collector cannot see. The tab died partway through
  exactly the long jobs the tier exists for.
- **4K HDR was unusably slow**, at 2.2 seconds of per-pixel arithmetic per
  frame. Now ~1.2 s through thread-banded evaluation, with reference frames
  converted once per file instead of up to twelve times, and a two-format
  bake-off no longer converting every frame twice for identical pixels. A
  lookup table was measured and *rejected*: the conversion ends in a gamma whose
  slope is unbounded at black, so an interpolated table is 14–19 code values
  wrong at the gamut boundary. Long 4K HDR clips remain slow, which the plan
  document states plainly rather than hiding.
- **The desktop interface shipped with no Content-Security-Policy** while
  holding the API token that drives every local route. Nothing was exploitable,
  but the blast radius of any future slip was total.
- **Videos over 512 MB were refused as "file too large"** on the tier built for
  phone video, which routinely exceeds it: the separate video limit was defined
  and then referenced by nothing. Uploads also now stream to disk instead of
  being read whole into memory first.
- **Every machine-readable description of this app said "images only"** after
  video had shipped — the title, the description, the social cards, the
  structured data, and the only crawlable prose on the page. The installed app
  also could not *open* a video from the file manager.
- **Numbers were written the author's way, not the reader's.** Sizes and scores
  were hard-coded with a point decimal, so most of the world saw "1.4 MB" and
  "90.5" where they write "1,4 MB" and "90,5" — and on a product whose whole
  argument is a measured number, "90,5" read as "905" is a different claim.

- **A portrait video came out sideways.** A phone held upright records a
  landscape frame and attaches a rotation flag; the engine passed the flag along
  and a 270×480 clip arrived as 480×270. Rotation is now baked into the pixels,
  because a flag is advice — some players honour it, plenty of upload forms and
  editors do not, and the person who compressed the video finds out which kind
  they had when it is already sideways in front of an audience. The direction is
  pinned by a pixel assertion, not just by dimensions: a picture turned the
  wrong way and one turned the right way have identical dimensions.
- **A non-square-pixel video came out squashed.** Sample aspect ratio was
  ignored, so a clip whose picture is 2.37 wide came out at the stored frame's
  1.78. Everything downstream now works in the shape a player actually shows,
  and the output is always square-pixel.
- **HDR video was silently flattened.** A PQ or HLG clip passed through with no
  mention of colour at all. It is now refused with an explanation: this wheel
  ships no `zscale` and the colour filters it does ship cannot read those
  transfers, so the only available re-encode would have produced a washed-out
  grey video.
- **A second soundtrack was dropped without a word.** Both that and dropped
  subtitle tracks are now disclosed. One soundtrack is a defensible choice;
  losing the other one in silence is not.
- **Scoring compared a straightened output against a sideways source**, which
  would have reported a catastrophic quality loss that was not there. The
  comparison straightens the source too — our output carries no rotation flag
  because it no longer needs one.
- **Frames were paired by position instead of by timestamp.** Two encodes of one
  source do not necessarily hold the same number of frames, so frame 40 was
  scored against frame 39 and reported as SSIMULACRA 2 of −295 where the truth
  was about 72. Both files are now asked what they were showing at a given
  second, which cannot drift.
- **The demuxer's flush packet was skipped**, which silently truncated every
  encode by however many frames the decoder was still holding. That was the
  cause of the frame-count mismatch above, and it is what the usual "ignore
  packets with no dts" idiom does to a video.
- **Every resize failed**, reported as "every encoder failed on this file". PyAV
  looks the resampler up in an enum by name, and `"lanczos"` raises `KeyError`
  where `"LANCZOS"` does not.
- **A size cap inflated files that already fit.** `--for chat` on a 4 MB clip
  encoded *up* toward 10 MB, and then the never-bigger rule discarded the result
  and shipped nothing at all. A limit is not an instruction to spend it: quality
  is searched first even when a cap exists, and the cap only takes over when the
  honest quality answer does not fit.
- **A video could ship below its destination's quality floor in silence.** The
  shortfall warning hung off the `else` of the size-cap branch, and most video
  destinations carry a cap, so the disclosure almost never fired. A disclosure
  that only speaks up when nothing else went wrong is not a disclosure. Pinned
  by `test_falling_short_of_the_floor_is_disclosed_even_under_a_cap`.
- **Every multi-format destination deleted its own output.** AV1 and H.264 both
  live in `.mp4`, so both candidates were written to the same path, overwrote
  each other, and the loser's cleanup removed the winner — leaving the engine
  reporting a size for a file that was no longer there. `web`, `chat` and
  `original` all allow two formats, so this was most of them. It survived the
  whole suite because nearly every engine test pinned a single format. Pinned
  now by `test_a_bake_off_between_two_formats_leaves_a_real_file`.
- **The video benchmark's combined strategy silently produced no row.** It named
  its working folders after its own row labels, which carry markdown and
  punctuation Windows refuses in a path, so the strategy failed and simply did
  not appear in the table — the worst way for a benchmark to be wrong, because a
  missing row looks like a tidy result.
- **A folder of videos added nothing at all to the desktop app.** Folder intake
  listed pictures only, so the filter that accepted videos never saw one. A
  folder of holiday clips is exactly what a person drags in.
- **A finished video reported its shape as `0×0`** whenever it had not been
  resized, because "not resized" was being stored as "no dimensions" — which is
  what the UI would have drawn.
- **The video fixture corpus measured nothing but its own smallness.** Written at
  an ordinary quality it was already a compressed file, so the engine correctly
  refused to beat it and every test passed for the wrong reason. It is rebuilt
  near-lossless, which also makes the benchmark's hard clips genuinely hard —
  and `tests/VIDEO_BENCHMARK.md` says so in place rather than letting the
  numbers imply a compressor is worse than it is.
- **The sidebar no longer collapses or clips at any width.** Two structural
  bugs, found by a new width-sweep probe (`tests/web/probe_widths.mjs`,
  320–1920px × two heights × empty/populated): on one-column layouts the
  height-constrained grid squashed the pictures section to 0px and its content
  painted on top of the plan (body now flows at its content's height on
  phones); and the empty state's grid demanded max-content width, pushing
  every sidebar region under the stage — clipped text on desktop, sideways
  scroll at 320px (the sidebar is a flex column now, and breathes between
  300–384px instead of a fixed 320px).
- **Every control clears the 44px touch floor** wherever the pointer is coarse
  or the layout is one-column — selects, buttons, the disclosure, the checkbox
  row and the CLI link were 13–42px.
- An empty queue no longer hogs the sidebar's flexible share on tall screens:
  the plan follows the drop zone immediately, and spare space falls after the
  CLI note.
- The capability note no longer shouts raw engine keys ("WEBPLOSSLESS") — it
  says "This browser can't save AVIF or lossless WebP — everything else still
  works."

## [2.7.0] - 2026-08-08

### Changed
- **One design system, and the desktop app is inside it.** There were two
  interfaces and they looked like two products. `web/` rendered from a token
  layer with an automated gate; the desktop app had its own palette baked into
  the file — its own greys, its own brass, its own three corner radii, its own
  two transition shorthands and its own system-font stack — and nothing checked
  any of it. That is the real answer to "how do I get consistency": not a
  component library, but one interface sitting outside the gate.

  The token layer and the self-hosted faces are now copied into
  `imgcompress/webui/` by `tools/sync_webui_assets.py` and committed, the same
  pattern as `web/destinations.js`: no build step, and CI fails on a stale copy.
  The desktop app's private palette is gone — every colour, corner, face and
  spring comes from the shared tokens, and it shares the browser app's
  `--app-*` alias names so the two are one product rather than two that happen
  to share a name.
- **Motion is enforced, not just available.** The token layer already shipped a
  closed set (`--oz-duration-*`, `--oz-ease-*`, and the `--oz-spring-*` pairs);
  what was missing was anything rejecting a value from outside it.
  `verify_tokens.mjs` now fails on a hand-typed duration or easing curve,
  `transition: all`, and any transition of a layout property.
- **Three progress bars stopped animating `width`.** The batch hairline, the
  per-row hairline and the version-chip meter all transitioned `width`, which
  makes the browser recompute layout on every frame of every bar. They now
  scale a `transform`, which is composited and cannot reflow anything. The
  fraction arrives as a unitless `--p` instead of a percentage.
- **`prefers-reduced-motion` is handled once**, in the token layer, for both
  interfaces. The desktop app's own blanket `transition-duration: .01ms
  !important` is gone: the shared version collapses spatial travel and takes
  the overshoot off the springs while leaving fades alone, and a fade is often
  the thing carrying the meaning.

### Fixed
- **The desktop app labelled a rejected version as the winner.** Its versions
  list badged `Math.min(bytes)` — the smallest candidate — rather than the one
  that actually shipped, and hid that candidate's score behind the badge. On a
  real photograph it read `webp 229.6 KB WINNER` while the file it wrote was
  `webp-lossless` at 344.1 KB, with no way to see that WebP had scored 87
  against a target of 90. This is precisely the bug `core.py` fixed in the
  engine, reappearing in the picture of it. The badge now follows the shipped
  format, every version shows how close it came, and each one carries the same
  one-sentence reason the browser app gained in the vocabulary pass.
- **The desktop app was one 403 away from rendering in Times New Roman.** A
  `<link>` and a `url()` inside a stylesheet cannot carry the query string the
  page was opened with, so the token check refused the app's own stylesheets and
  Chrome dropped them for having a JSON MIME type. Static assets under
  `/webui/` are now served before the token check — they are files shipped in
  the package with no user data in them, the loopback-Host check still applies,
  and the token still gates every API route and every image. Found by the new
  runtime gate on its first run; every static check was green throughout.
- Faces are served as `font/woff2`. `mimetypes` has no woff2 entry on a stock
  Windows Python, so they went out as `application/octet-stream`.
- The desktop app has the product's icon. Without one linked the browser asked
  for `/favicon.ico`, which answered 403 — one console error on every launch,
  saying nothing useful.
- `Now` became `New size` in the browser app's result panel — a vocabulary-pass
  miss, caught by looking at a screenshot rather than at the code.

### Added
- **`tests/web/verify_desktop.mjs`** — the desktop app in real Chrome: the
  shared stylesheets arrive with a CSS type, the faces arrive as `font/woff2`,
  the tokens resolve to real values, six faces register, nothing renders above
  600, the private palette is undefined, and no request leaves the machine. The
  static gate can only prove the app *references* the token layer; this proves
  the browser receives it.
- **`tests/test_design_system.py`** — 22 tests covering everything reachable
  without a browser: the copies are current, the copy tool fails on an edited,
  missing or CRLF copy, the face URLs are rewritten for `/webui/` while the
  source is left alone, the desktop app declares no palette of its own, and
  neither app layer transitions a layout property.
- **`probe_a11y.mjs` and `probe_mobile.mjs` can now fail.** Both printed
  measurements and exited 0 whatever they said, which made them reports rather
  than tests — running them and seeing no errors carried almost no information,
  and it blocked Phase 4, whose criteria they are supposed to enforce.
  `probe_mobile` now measures at **375px**, not 390.
- `tests/web/shoot_both.mjs`, which screenshots both interfaces in both themes,
  so "recognisably the same product" is something you can look at.

- **The interface speaks English.** Eleven invented words for three ideas meant
  it was possible to look at this product and not know what it was telling you.
  One concept now gets one word everywhere a person can see it — the browser
  app, the desktop app, the command line, every error message and the README:

  | Was | Is |
  | --- | --- |
  | bake-off | the comparison |
  | candidate | version |
  | floor / quality floor | your target / minimum visual match |
  | passes, still passes | close enough to the original |
  | survives | wins |
  | untouched | left exactly as it is |
  | force a format | always use |
  | redo just this image | try different settings |
  | SSIMULACRA 2 82.8 | visual match 83 out of 100 |

  The measure's real name moved into the details panel, where it belongs: which
  measure produced the number is a fact about our implementation, and how close
  the result came is the fact somebody is actually here for. The SSIM fallback
  keeps its name, because that scale runs 0–1 and calling it the same thing
  would mislead.
- **What the tool does is described as a benefit, not as machinery.** "Every
  image is encoded several different ways, scored against the original with a
  perceptual metric, and only the smallest version that still passes survives"
  became "every image comes out as small as it can go without you being able to
  see the difference — and you get the side-by-side to check that for
  yourself."
- **Every version that lost now says why**, in one sentence: bigger than your
  original, too different from it (with both numbers), lost too much colour
  detail, or close enough but larger than the one chosen. A list of rejects
  with no reasons showed the machinery working without saying anything. The
  sentence for whichever version is on screen is shown under the row rather
  than hidden in a tooltip.
- **Error messages say what happened, then what to do next.** No apology, no
  blame, no error code as the headline. "Error: unsupported format" became
  "Those file types aren't supported yet. Try PNG, JPEG, WebP, AVIF, GIF, BMP
  or TIFF."
- **"How this was measured" is written for a person.** It explains that the
  comparison looks at local contrast and detail the way eyes do rather than
  counting pixel differences, and that 100 means indistinguishable — and it now
  carries the fact that makes this tool beat the obvious alternative: colour is
  never thrown away, because matching the same quality with colour detail
  discarded needed setting 97 instead of 76, a file 3.8× larger.

  Zero output bytes changed; both byte snapshots are identical.

- **Presets are now destinations, and the default is no longer a design tool.**
  There used to be two overlapping settings — `--preset` chose size and
  quality, `--target` chose which formats were allowed — and both defaulted to
  `figma`. That meant a person compressing a photograph for their website got
  JPEG or PNG and nothing else, for a reason that is true of Figma and of
  nothing they were doing. The restriction was researched and correct; making
  it everyone's default was not.

  One list replaces both, named after the only question somebody can answer
  without knowing anything about compression — where is this image going?

  | `--for` | Formats | Size | Visual match |
  | --- | --- | --- | --- |
  | `web` *(new default)* | all, incl. WebP and AVIF | 2560px | 90 |
  | `documents` | JPEG / PNG only | 2560px, ceiling 4096px | 90 |
  | `email` | JPEG / PNG only | 1920px | 88 |
  | `thumbnail` | all | 512px | 80 |
  | `original` | all | never resized | 95 |

  `--preset` still works as a synonym and the old names (`figma` → `documents`,
  `archive` → `original`) still resolve, so existing scripts do not break. The
  CLI says out loud when you have used one.
- **`documents` keeps every restriction `figma` had**, because the restriction
  is the feature: those tools re-encode WebP to PNG on import, so a beautifully
  compressed 40 KB file becomes a multi-megabyte one inside the saved document.
  What changed is who pays for it — the people actually sending images there.
- **Choosing a destination applies all three of its numbers**, in both
  interfaces. Setting only the format list would make "Thumbnail or avatar"
  mean nothing but a shorter list, and leave the person to work out that two
  more controls in Advanced needed changing for it to do what it says. Both
  remain editable afterwards; this moves the starting point, it does not lock
  it.
- **The desktop app builds its destination list from the server's table**
  rather than carrying its own copy of five numbers that have to agree.
- **`imgcompress --help` no longer names a specific product**, and prints what
  each destination actually does. Its output is ASCII, because a middot that
  arrives as a replacement character on a cp1252 console undoes the point of
  writing readable help.

### Added
- **The two engines are held together by CI on every pull request.** The claim
  that the browser scores an image the way the Python reference does had
  nothing enforcing it — `ss2_validate.mjs` existed and had to be remembered.
  A drift there is the worst kind of break: the app keeps working, it just
  stops being right. The job runs on every PR rather than only ones touching
  `ss2.js`, because the case that actually worries us is `quality.py` or a
  pinned dependency moving the numbers out from under a file nobody edited.
- **AVIF is a Python encoder**, feature-detected. Pillow only carries AVIF
  where the wheel was built against libavif, so on most machines this changes
  nothing; where it is present, AVIF now competes in the bake-off on the same
  terms as everything else — it ships only if it is both smaller and still
  clears the floor. This is what lets the destination table be literally the
  same in all four places rather than "the same except Python."
- **The browser's destination table is generated, not maintained.**
  `tools/gen_destinations.py` writes `web/destinations.js` from
  `imgcompress/destinations.py`; `worker.js` imports it, `index.html` loads it
  before `app.js`, and the Format control's options are rendered from it rather
  than typed into the markup. The generated file is committed, because `web/`
  has no build step and should not grow one — CI regenerates it and fails on
  any difference, so the commit is the check. Testing copies catches drift
  afterwards; not having copies prevents it.
- **A parity test for the destination table**, `tests/test_destination_parity.py`.
  The table now exists in Python, in `worker.js`, in `app.js` and in the
  markup, and nothing checked that they agreed — the same hazard `ss2.js` had
  before the CI job above, and it bit immediately: `app.js` was already
  claiming 4096px for `documents` and quality 85 for `thumbnail` while Python
  said 2560 and 80, so every browser compression would have used numbers the
  reference had already rejected, silently. Now that the copies are generated,
  the test guards the generator instead: the committed file must be current,
  and no consumer may hand-write a destination's name, frame size or format
  list. It found one more copy while being written — `app.js` restated the
  default destination's numbers in its initial state, where a stale value would
  have been wrong for exactly the people arriving for the first time.
- **`tests/web/check_ss2_corpus.py`**, wired into CI. `make_ss2_vectors.py`
  skips AVIF where Pillow cannot write it, which is right on a Windows laptop
  and wrong in CI: a failed plugin install would run 48 vectors instead of 60,
  print VALIDATED, and show the same green tick with AVIF parity untested from
  then on. The plugin install is no longer allowed to fail, and the vector
  count and codec coverage are asserted rather than merely reported.
- Tests pinning every destination's formats, size cap and minimum visual
  match, that only `documents` enforces a ceiling, that an explicit `-m 8000`
  is clamped to 4096 rather than refused, that a smaller request is never
  inflated, and that the old names still resolve. Previously the 4096px cap was
  tested but *only* the half that fires — nothing asserted that `original`
  leaves an image alone. The Python suite goes from 24 tests to 64; the browser
  suite from 72 assertions to 76.

### Fixed
- `make_ss2_vectors.py` no longer dies on a Pillow built without libavif. It
  says the twelve AVIF pairs are missing instead of quietly shrinking the
  corpus and still printing VALIDATED.

### Notes for anyone measuring this
- **Output is byte-identical at matched settings.** `bench.mjs` passes clean on
  both `documents` and `web`, at the real defaults — it takes the destination's
  own frame rather than a pinned one, which it can do because `documents` and
  `web` agree on 2560 and the format list is genuinely the only difference.
- **`--preset thumbnail` changed** from 800px to 512px. The quality target
  stays at 80. Nothing in the history records why 800 was chosen — it arrived
  in the initial import — so 512 is the change that can be argued for and the
  target was left alone: artefacts are *less* visible at a smaller size, so if
  anything it could fall, and raising it would have been a second change with
  no reason behind it.

- **A rule, in CONTRIBUTING.md: every new gate must be observed failing.**
  Four checks on this branch reported success while checking nothing — a
  snapshot with a hand-pinned frame, an AVIF skip that still printed
  `VALIDATED`, parser-based assertions that could match zero lines, and a
  `diff` against a file the job had not written yet. Two were caught in review
  and one by a file timestamp, which is not a process. Breaking a gate and
  watching it go red costs a minute and is the only thing separating it from a
  comment.
- **`tests/test_corpus_guard.py`**, because `check_ss2_corpus.py` was itself
  only verified by hand — the same posture `ss2_validate.mjs` was in before it
  was wired into CI. Nine tests, including the argparse bug it shipped with:
  `action="append"` adds to a list default rather than replacing it, so
  `--require-codec jpeg` meant "jpeg *and* the three defaults" and the
  narrowing path had never run.

### Fixed since
- **The clamp announces itself.** `-m 8000 --for documents` printed
  `up to 8000px` and produced 4096 — a dimension changing without saying so,
  which is the defect this whole rework exists to remove, surviving on the
  override path because that path is rarer. The rule now lives in one function,
  `destinations.effective_limit`, which both the engine and the CLI header
  call, so they cannot disagree. The header states the real limit and, when it
  differs from the request, says which destination clamped it and why.

### A bug this branch introduced and then removed
Recorded because the shape of it is worth remembering, not because it shipped.

`documents` briefly carried **one** size number where the old `figma` preset
had two. `figma` downscaled to 2560 and separately clamped at 4096 — the clamp
being the thing that fires when somebody explicitly asks for more, which is why
the original code described it as applying *regardless*. Collapsing them handed
the ceiling over as the everyday setting, so every design-asset compression
would have shipped roughly 2.5× the pixels it should, and downscaling saves
more than the encoder does.

`bench.mjs` caught the resulting byte change immediately, and it was
misdiagnosed as a test-isolation problem: the fix applied was to pin the frame
size so the comparison stayed clean. That was a correct testing instinct
reached for at the wrong moment. It isolated the variable and certified a
configuration no user would ever run — a green gate over a setting that does
not exist, which is worse than a red one. The pin is gone and the two numbers
are back to doing two jobs.

## [2.6.0] - 2026-08-07

### Changed
- **The set-up step is gone; dropping a file starts the work immediately.**
  2.5.0 added a step between "here are your images" and "here is the work"
  because starting unasked spends someone's laptop before they have been told
  they had a choice. That diagnosis was right and the remedy was wrong: a gate
  answers the question "may I?" by making everybody answer it, including the
  overwhelming majority who only ever wanted the default. The two real fears —
  *is this safe* and *would I ever find out I had a say* — are now answered by
  what is on screen and what happens when you touch it:
  - The **untouched original is painted first**, full size and labelled as
    such, and the encoders are not asked for anything until the frame after
    the browser has actually painted it.
  - A **plain sentence** says what is happening while it happens — "Trying a
    few ways to shrink this, keeping only the one that still looks right" —
    which is the landing page's promise in the present tense rather than a
    spinner.
  - The result **arrives beside the original**, not over it. The split
    comparison is the state you land in, not a tab to be discovered.
  - The sentence then **ends in a real action**: "Went with WebP — smallest
    option that still passes. *Prefer something else?*"
- **Every encode that was tried is a chip beside the picture, and tapping one
  swaps the preview instantly.** The bake-off already produced those files and
  used to throw all but one away, so changing format meant running the whole
  search again — seconds of waiting for work already done. The candidates now
  travel home with the result, and a tap is a relabel: the picture, the
  weights, the split view, the heatmap and the download all follow inside the
  click. That immediacy is the point. A control that answers the moment you
  touch it teaches that it exists; a dropdown pre-filled with what already
  happened reads as status, and nobody pulls it.
- **Keeping your original is one of the chips.** It sits at the end as the
  yardstick and is selectable, so "the original is one action away from being
  the only thing kept" is literally true rather than reassuring copy.
- **Renaming moved to the filename in the result view**, editable in place. It
  was only ever possible inside the set-up step.
- The per-image **Format and Quality overrides are still there**, in the
  detail panel, as a dropdown — where a dropdown belongs. It can name a format
  the bake-off never tried, which no chip can, and anything set there is a
  genuine re-run rather than a swap.

### Fixed
- Lifetime savings followed the file you actually kept. Choosing a different
  encode after the fact used to leave the total describing a file you no
  longer had.

## [2.5.0] - 2026-08-06

### Added
- **A set-up step between dropping images and compressing them.** Dropping
  files used to start the work immediately, which spent a minute of someone's
  laptop before they had been told they could pick a format, a quality, or a
  name. A drop into an empty queue now lands on a step that shows what was
  picked up, hands over the settings, and waits. Images can be renamed there
  (the extension is not editable — the format decides it) and dropped from the
  list. Adding more files while it is open extends the list; a drop onto a run
  that is already configured joins it rather than asking again, and the demo
  button skips it, because someone who pressed "see it work" asked to see it.
  The settings bar is *moved* into the step rather than copied, so there is
  still exactly one Format control and one Quality control in the document.
- **Copy** beside Save on each image, for pasting straight into Figma, Slack or
  a document. Clipboards accept `image/png` and nothing else, so a JPEG or WebP
  result is re-encoded losslessly for the paste and the toast says so rather
  than implying the compressed bytes travelled.

### Fixed
- **Zooming threw the image off the stage.** CSS alignment silently switches
  from `center` to `start` once an item is larger than its container — the
  "safe" behaviour — so the moment you zoomed past the frame the image snapped
  to the top-left and the rest hung off the bottom, which is why scrolling felt
  like it jumped to the top and needed a long drag back. The frame is now
  centred by transform, which has no such rule. Zoom is also anchored to the
  pointer, so whatever is under the cursor stays under it, and panning is
  clamped to the frame's own overhang so the image can no longer be dragged
  into empty space.
- The toast sat exactly on the toolbar and covered the Quality control while
  reporting on the file you had just saved. It now sits at the bottom, clear of
  every control.
- Thumbnails in the set-up list stayed blank when they finished decoding after
  the list had rendered.

### Changed
- The keyboard lands on the start button when the set-up step opens, and Enter
  starts the run from anywhere in the step except a name field, where it
  commits the rename instead.

## [2.4.0] - 2026-08-06

### Added
- **Both decisions are now the person's to make, and both still default to
  "let the app work it out".** The toolbar carries two controls:
  - **Format** spans the range from delegation to instruction. *Let the app
    choose* keeps the bake-off (design tools, web, or lossless-only sets);
    *Use one format* runs JPEG, WebP, PNG or AVIF alone. The group labels say
    which is which, so the trade-off is legible without knowing what a
    bake-off is. A format this browser cannot encode is disabled with the
    reason on the label rather than failing later. The single-format group is
    deliberately **not** sold as "faster": measured on the benchmark corpus,
    restricting to JPEG saves only 1.1–1.4× against the design-tool set,
    because JPEG's own quality search is nearly the entire cost.
  - **Quality** is now words — *Maximum, for masters you'll re-edit* through
    *Smallest, fine for thumbnails*. The 60–99 SSIMULACRA 2 floor stays in
    Advanced, and the two are one setting seen two ways: a named quality sets
    the floor, and a floor set between the names reads back as *Custom — floor
    87* instead of being snapped to the nearest preset.
- **Choosing JPEG for transparent artwork asks instead of assuming.** JPEG has
  no alpha channel, so the request is a question with two defensible answers,
  and the app puts it in a modal: keep those images as PNG, or flatten the
  transparency onto white and take the JPEG. Both answers say what they did on
  the affected image; cancelling restores the setting actually in force rather
  than leaving the control displaying one the engine never received.
  Transparency is measured from the decoded pixels, never inferred from the
  file extension, so an opaque PNG never triggers the question. Flattening
  happens before anything is encoded or scored, so the result is measured
  against the flattened original — the image that was actually asked for.
- **Every image reports how long it took.** The time appears on the image's
  row in the queue, in the "How this was measured" drawer alongside the
  candidate count, and as `time_ms` in exported CSV/JSON reports. The
  completion toast reports the run's wall clock. Per-image times are
  deliberately never summed into a batch total: images compress several at a
  time, so adding them up would claim a wait several times longer than the
  one that actually happened. The clock starts when an image reaches a
  worker, not when it was dropped, so time spent queued behind other images
  is not billed to it.

### Fixed
- **The broken-image glyph on the stage.** A file this browser cannot decode
  — a damaged export, or a format it has no decoder for — left an `<img>`
  pointing at something that would never paint, so Chrome drew its torn-page
  icon and the alt text over the artwork; a second `<img>` with no source at
  all laid out its alt text next to it. An image element with nothing to show
  is now out of the layout entirely, and the stage says what happened instead
  ("No preview — this browser can't read this file"). The E2E suite now fails
  on any visible image box with nothing decoded in it.
- Exported reports claimed version 2.2.0 regardless of the running version.
  The footer is now the single source of that string and the report reads it
  from there.

## [2.3.2] - 2026-08-05

### Changed
- **Web: JPEG quantisation tables now compete instead of being guessed.**
  Which mozjpeg table wins is content-dependent: on the benchmark's real
  photograph the default (ImageMagick) ships 371 KB where Annex K needs
  ~430 KB, and on the hard synthetic it is the other way round — Annex K
  passes at 461 KB where the default needs 597 KB. After the quality search
  converges, the alternate table is encoded at the chosen rung and the one
  below, verified with the same scorer, and the smallest passing file
  ships. At most two extra encodes, and an alternate that is not smaller
  is discarded without paying for verification.

## [2.3.1] - 2026-08-05

### Fixed
- **Web: the quality floor actually defaulted to 99, not 90.** Settings init
  still scaled the floor as if it were an SSIM fraction (`90 * 100`), which
  pinned the slider at its maximum. Every search then demanded SSIMULACRA 2
  >= 99, almost no lossy candidate could pass, and the app quietly
  over-shipped lossless files several times larger than needed (a 1.3 MP
  photograph shipped as a 1.5 MB lossless WebP; at the intended floor it
  ships as a 598 KB JPEG at score 90.6). Floors persisted while the bug was
  live are reset to the default once; targets and dimension caps are kept.
  The e2e suite now asserts the fresh-profile floor is exactly 90.

## [2.3.0] - 2026-08-05

### Added
- **SSIMULACRA 2 in the browser.** The web app now searches with the same
  perceptual metric as the desktop version — a JavaScript port
  (`web/ss2.js`) validated against the Python reference implementation to
  |Δ| = 0.0000 across a 60-pair corpus of codec-distorted images. The default
  quality floor is 90, the metric's published "not noticeable in a flicker
  test" line, and the UI speaks the same scale as the desktop app.
- **Real lossless WebP** in the web app (libwebp via WASM), competing in the
  Web and Lossless targets — the candidate that wins on flat artwork.
- `tests/bench_vs_alternatives.py` + `tests/BENCHMARK.md`: a reproducible
  head-to-head against single-format strategies and fixed-quality defaults,
  every strategy searched to the same SSIMULACRA 2 >= 90 floor.

### Changed
- Lossy ladders reach the high 90s (JPEG to 99, WebP to 98, AVIF to 96) in
  both engines. With the old ceilings, hard content could fail every lossy
  rung and a multi-megabyte lossless PNG won by forfeit.
- The web quantizer adds two Lloyd refinement iterations after median cut,
  and the shipped PNG gets a deeper oxipng pass — palette outputs now beat
  the pngquant + zopfli sizes from the previous benchmark.
- The per-channel chroma guard now applies only under the SSIM fallback
  metric; SSIMULACRA 2 weighs chroma natively.

### Fixed
- **Desktop selection bug:** a candidate that failed the quality floor could
  ship over one that passed, purely because it was smaller — an early failing
  JPEG would hold the winner's spot against a passing lossless PNG. Passing
  candidates now always outrank failing ones, matching the web engine.

## [2.2.0] - 2026-08-05

### Added
- **Web version** at [imgcompress-app.vercel.app](https://imgcompress-app.vercel.app) —
  the same encode-several-ways / score-every-candidate / keep-the-smallest engine,
  ported to run entirely in the browser (`web/`). SSIM at the 5th percentile,
  dual-backdrop transparency scoring, a palette-PNG encoder with exact-palette
  detection, per-image overrides, and zip download. Images never leave the
  device; the page makes no network requests after load.

### Security
- The desktop server now rejects requests whose `Host` header isn't loopback,
  closing the DNS-rebinding hole that could have exposed the API token via
  `GET /`.
- Request bodies are capped at 512 MB and oversized uploads answer `413`.
- Uploaded filenames are sanitised for Windows-hostile characters.
- Responses carry `Referrer-Policy: no-referrer`.

## [2.1.0] - 2026-08-05

### Added
- **Desktop app** (`imgcompress-gui`). Drag-and-drop queue with live progress, a
  before/after split slider with zoom, the full candidate bake-off per image,
  per-image format and quality overrides, and folder watching.
- Nothing is written to disk until you press Save — a whole batch can be
  reviewed and then saved or discarded.
- `compress()` and `write_result()` in the public API, for compressing into
  memory without touching the filesystem.
- Packaging: installable from PyPI or a checkout, with `imgcompress` and
  `imgcompress-gui` entry points.

### Changed
- `compress_file()` is now a thin wrapper over `compress()` + `write_result()`.

## [2.0.0] - 2026-08-05

Rewritten after benchmarking the first version against the state of the art.

### Added
- **Format bake-off.** Every image is encoded as JPEG *and* palette PNG *and*
  lossless PNG; each is searched independently and the smallest passing result
  wins. On the test corpus the winner differs by content type, with up to a 40x
  spread between best and worst candidate.
- **SSIMULACRA 2** as the default quality metric.
- `libimagequant` (pngquant's engine) for palette PNGs, `zopfli` for PNG
  recompression, `mozjpeg` for a lossless JPEG pass.
- `--target figma | web | lossless`, `--check`, `--fast`, `--metric`.

### Changed
- **Default output is now JPEG/PNG, not WebP.** Figma's plugin API only knows
  PNG/JPEG/GIF and the standing community answer is that WebP is transcoded to
  PNG on import, which would undo the compression entirely.
- **JPEG is always 4:4:4.** With chroma subsampling on, matching 4:4:4's quality
  on saturated content needed quality 97 instead of 76 — a 3.8x larger file.
- The SSIM fallback aggregates at the 5th percentile rather than the mean.
- Transparent images are scored over both a dark and a light backdrop, worse
  score wins.

### Fixed
- Alpha channels are composited before scoring. Comparing them raw produced
  meaningless numbers (the upstream `ssimulacra2` package has a dead alpha path).

## [1.0.0] - 2026-08-04

Initial version. WebP output, quality chosen by binary search on mean luminance
SSIM.
