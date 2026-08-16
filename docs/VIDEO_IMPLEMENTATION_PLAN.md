# Video Implementation Plan — approved 2026-08-14

> **Status: BOTH TIERS IMPLEMENTED. 2026-08-16: all sixteen defects from the
> correctness review and the honesty audit are resolved except C1, which is
> improved and precisely bounded — see "Correctness review" below for the
> per-defect record.** History of how it got here follows.
>
> **Status as of 2026-08-15: DESKTOP TIER, REAL-FOOTAGE CORRECTNESS AND RESKIN
> IMPLEMENTED. BROWSER TIER NOT STARTED** (scheduled second by decision V1).
> Verification: 162/162 Python tests including 44 video tests, `ruff` clean,
> both generated-file checks current, design-system gate green in all 27
> checks, and a contrast audit of the new palette passing AA on all twelve
> text pairs in both themes.
>
> **Phase 2 — correctness on real footage (2026-08-15).** A second corpus,
> `tests/make_real_world_fixtures.py`, covers the shapes real video arrives in
> rather than the content it carries: a phone held upright, one held upside
> down, non-square pixels, HDR, variable frame rate, and two soundtracks.
> Five defects were found by building it, each observed failing before it was
> fixed:
>
> | Defect | Evidence before the fix | Resolution |
> | --- | --- | --- |
> | Rotation flag ignored | portrait clip came out `480x270` — sideways | Rotation is baked into the pixels, not passed on as advice a player may ignore. Direction pinned by a pixel assertion, not just by dimensions |
> | Non-square pixels ignored | ratio `1.78` where the picture is `2.37` — squashed | Scaled to the display shape, output is always square-pixel |
> | HDR silently flattened | passed through with no mention of colour | **Refused with an explanation.** This wheel ships no `zscale`, and the colour filters it does ship cannot read a PQ or HLG transfer, so the only available re-encode would produce a washed-out grey video. Detect-and-say beats convert-and-hope |
> | Second soundtrack dropped in silence | no warning at all | Disclosed, along with dropped subtitle tracks |
> | Scoring compared a straightened output against a sideways source | would have reported a catastrophe that was not there | The comparison straightens the source too |
>
> Variable frame rate was tested and was already correct — timestamps are
> carried through rather than assumed.
>
> **Phase 3 — the benchmark (2026-08-15).** `tests/bench_video.py` produces
> `tests/VIDEO_BENCHMARK.md`: every strategy that can be searched, searched to
> the same floor, scored by two metric families. It found two more bugs on its
> first run, both of which had survived the whole test suite:
>
> - **Every multi-format destination deleted its own output.** AV1 and H.264
>   both live in `.mp4`, so candidates were written to the same path,
>   overwrote each other, and the loser's cleanup removed the winner - the
>   engine reported a size for a file that was no longer there. `web`, `chat`
>   and `original` all allow two formats, so this was most of them. It
>   survived because nearly every engine test pinned a single format. Pinned
>   now by `test_a_bake_off_between_two_formats_leaves_a_real_file`.
> - The benchmark named its own working folders after its row labels, which
>   carry markdown and punctuation Windows refuses in a path. The combined
>   strategy failed and simply did not appear in the table - the worst way for
>   a benchmark to be wrong, because a missing row looks like a tidy result.
>
> What it shows: on the screen recording, the searched AV1 encode is the
> smallest passing file and beats a fixed CRF 30 default while scoring on the
> right side of the floor; on the near-static clip, **every fixed-quality
> default misses the floor outright** and the searched encode is the only
> passing file under 10 KB. On the two near-lossless synthetic clips nothing
> clears 92, and the report says so in place rather than hiding it.
>
> **Phase 4 — the desktop app (2026-08-15).** `server.py` routes video to the
> video engine, and the queue knows a file is a video the moment it lands
> rather than after an encode it has not started. Progress reaches the UI
> through the ordinary polling rather than a second mechanism. `app.html`
> gained a second pair of layers on the same stage, so the split, the divider
> and the zoom keep working unchanged, with the compressed player following
> the original's clock - two free-running players drift apart within seconds,
> and a split showing second 3 against second 5 is not a comparison. Saving
> moves the file the engine already wrote instead of encoding twice, and never
> writes over a file already sitting there. Two more bugs found:
>
> - **A folder of videos added nothing at all.** Folder intake listed pictures
>   only, so the filter that accepted videos never saw one. A folder of
>   holiday clips is exactly what a person drags in.
> - **A finished video reported its shape as `0x0`** whenever it had not been
>   resized, because "not resized" was being stored as "no dimensions" - which
>   is what the UI would have drawn.
>
> Video preview is served with byte-range support, streamed off disk in chunks
> rather than read into memory: the whole point of this tier is that the files
> are large, and a player that cannot seek cannot be compared against
> anything.
>
> **Phase 5 — the browser engine (2026-08-15).** `web/video-worker.js`
> compresses video entirely on the device: Mediabunny (MPL-2.0, vendored and
> hash-pinned) reads and writes the containers, and every frame goes through
> the browser's own WebCodecs. Verified in real Chrome against the real CSP by
> `tests/web/probe_video.mjs` — an 18 KB clip to 6.9 KB as AV1, measured at
> 74.7 by the same SSIMULACRA 2 port the image tier uses, with progress
> reported throughout and no console errors.
>
> No codec ships with the page, so it stays small and carries no patent
> licence; and because nothing needs threads, the site keeps its existing CSP
> with **no cross-origin isolation** — the ffmpeg.wasm route would have forced
> COEP across the whole site, run 12–25× slower, and shipped GPL-linked x264.
> The reasoning is recorded in `web/vendor/LICENSES.md` beside the hashes.
>
> Three things this phase had to solve, each recorded where it was fixed:
>
> - **A module served as `application/octet-stream` under `nosniff` is refused
>   outright**, and `.mjs` is missing from more static hosts' MIME tables than
>   is comfortable. The vendored bundle is therefore `.js`; module-ness comes
>   from the worker's `type: "module"`, never from the extension.
> - **The metric could not be shared between the two workers.** The image
>   worker is classic and uses `importScripts`; a module worker has none, and
>   the CSP rules out every runtime escape hatch (`eval`, `new Function`,
>   `data:`). Rather than keep a second hand-written copy of a validated
>   metric, `tools/gen_ss2_module.py` generates `web/ss2.module.js` from
>   `web/ss2.js` and CI checks it, exactly as the destinations table is
>   handled. One implementation, two loading mechanisms.
> - The probe originally launched Chrome with a SharedArrayBuffer flag, which
>   the real site never has. Testing a browser with a capability the product
>   deliberately avoids is testing a different product; the flag is gone.
>
> `media-src 'self' blob:` was added to the CSP so a result can be played back,
> and the service worker went to `v3` with the new files precached.
>
> **Still to do on this tier:** wiring video into the page's own queue,
> settings panel and split-compare view (`web/js/*`). The engine is real and
> proven; the surface around it is not built yet.
>
> **Phase 2 also added progress and cancellation.** A video encode is the
> first thing this project does that can run for minutes, and silence for
> minutes is indistinguishable from a hang. `compress()` now takes
> `on_progress` and `should_stop`; the CLI draws a live bar on a terminal and
> stays quiet when redirected, Ctrl-C stops cleanly, and nothing half-written
> is ever left behind.
>
> **Deviations from the letter of this plan, all disclosed:**
>
> 1. **§V5 metric roles are inverted.** The plan said steer on XPSNR and
>    certify with SSIMULACRA 2. Shipped the other way round: the search
>    watches SSIMULACRA 2 and XPSNR is the independent witness recorded on
>    every result. The reason is that the destination targets are numbers on
>    the SSIMULACRA 2 scale (88, 90, 92, 96) — the same scale the image tier
>    reports — and steering on XPSNR would have required mapping "visual match
>    92" onto a dB figure, which is content-dependent and has no principled
>    conversion. The rule the plan exists to protect is intact: the number the
>    search optimises is never the only number reported.
> 2. **A `chat` destination was added**, splitting Discord's 10 MB from
>    email's 25 MB. They are one destination for an image and two for a video,
>    and the numbers come from different companies.
> 3. **`email`'s label changed** from "Email or chat" to "Email" as a
>    consequence of 2.
> 4. **A size cap no longer forces rate-targeting.** Quality is searched
>    first even when a cap exists, and the cap only takes over when the honest
>    quality answer does not fit — see "bugs found" below.
>
> **Bugs found and fixed during implementation:**
>
> - **Frames were paired by position, not by timestamp.** Two encodes of one
>   source do not necessarily hold the same number of frames, so frame 40 was
>   being scored against frame 39 and reported as catastrophic quality loss
>   (SSIMULACRA 2 of −295 where the truth was ~72). Now paired by presentation
>   time, which cannot drift.
> - **The demuxer's flush packet was skipped**, which silently truncated every
>   encode by however many frames the decoder was holding — the cause of the
>   frame-count mismatch above.
> - **Every resize failed** with "every encoder failed on this file", because
>   PyAV looks up the resampler by enum name and `"lanczos"` raises `KeyError`
>   where `"LANCZOS"` does not.
> - **A size cap inflated files that already fit.** `--for chat` on a 4 MB
>   clip encoded *up* toward 10 MB, then the never-bigger rule discarded the
>   result and shipped nothing. A limit is not an instruction to spend it.
> - **A video could ship below its destination's quality floor in silence.**
>   The shortfall warning hung off the `else` of the size-cap branch, and most
>   video destinations carry a cap, so the disclosure almost never fired.
>   Pinned now by `test_falling_short_of_the_floor_is_disclosed_even_under_a_cap`.
> - The fixture corpus was rebuilt near-lossless: written at an ordinary
>   quality it was already a compressed file, so the engine correctly refused
>   to beat it and the tests measured nothing but that the fixture was small.

## Correctness review, 2026-08-16 — RESOLVED SAME DAY (C1 partially; see its record)

An adversarial correctness review ran against commit `14239cd`. It verified the
colour maths against BT.2100/BT.2408 and found it **right** (`pq_nits(0.5) =
92.2457` vs spec ~92.2; HLG 75% neutral → 203.15 nits vs spec 203; BT.2020→709
rows sum to exactly 1.0), confirmed the tone map is applied symmetrically to
both sides when scoring, confirmed 10-bit is not truncated, and confirmed
`ToneMap` is thread-safe, the bisection correct over 4000 generated ladders,
and `encode()`'s containers closed on every path. What follows is what it
found wrong, and what became of each.

| # | Severity | Defect | Resolution |
| --- | --- | --- | --- |
| C1 | critical | **Tone mapping is per-frame full-frame numpy: 2.2 s per 4K frame**, measured. ~11 hours for a ten-minute 4K clip *per pass*, and the search runs many passes across two formats. | **Improved, not closed** — see the C1 record below. Four changes, each measured: the exact arithmetic runs thread-banded (2.0 s → 1.23 s per 4K frame on a 4-core/8-thread laptop; scales with real cores); reference frames for scoring are converted once per file instead of once per probe rung per format (five to twelve times); `ToneCache` means a two-format bake-off converts each frame once rather than twice for identical pixels; and the verify climb is bounded at 2 instead of a possible 19 whole-file passes. The lookup-table family is *measured out* — the record below says why, so nobody spends a third day on it. |
| C2 | critical | Cancellation unreachable during the minutes; `server.py` never passes `should_stop`; `/api/remove`//api/clear` drop the item while the worker encodes on. | **Fixed.** The encode and verify loops consult the stop flag every ~16 packets (`Progress.check`); the server registers a stop event per video, `remove`/`clear` set it, and the worker sweeps up. Gated by `test_stopping_reaches_inside_a_running_encode` and `test_removing_a_video_stops_the_encode_it_was_waiting_on`, both observed failing against `14239cd`. |
| H3 | high | Video temp directories never deleted. | **Fixed.** `video_workdir()` owns the layout; `remove()` deletes the item's folder, the worker sweeps a folder whose item vanished mid-encode, and `serve()` registers a cleanup that runs on quit and at interpreter exit (upload dir included). Gated by `test_working_files_do_not_outlive_the_item`. |
| H4 | high | A lying or missing duration breaks size caps both ways (10 MB cap → 5,690 MB file, measured). | **Fixed.** `measured_duration()` counts the packets whenever a cap is set or the label is missing, and `_under_cap` receives the counted number. When no usable rate exists at all, the quality-first candidate ships *over* the cap with `missed_size` disclosed instead of `"every encoder failed"`. Gated by `test_a_lying_duration_label_is_not_believed`, observed failing. |
| H5 | high | Browser worker never releases WebCodecs resources; re-opens the whole file dozens of times. | **Fixed.** One reader per file per job (`makeReader`), disposed in `finally`; the original is opened once and its reference frames cached across rungs and formats. |
| M6 | medium | One format throwing kills the whole browser job. | **Fixed.** Per-format try/catch mirroring the desktop loop; failures ride the result as warnings; `best` is null-guarded and the job only fails when every format failed. |
| M7 | medium | Cancelling mid-bake-off orphans the in-flight candidate file. | **Fixed.** `_at_quality`/`_under_cap` unlink their own path on `Cancelled` before re-raising — whoever owns a half-written file removes it on the way out. |
| M8 | medium | The verify-disagreement climb is unbounded (up to 19 whole-file encodes per format). | **Fixed.** `VERIFY_CLIMB_LIMIT = 2`, with progress reported per climb; a file still short after that is disclosed as short, which is the same contract the search itself has. |
| M9 | medium | `pooled()` returns the raw minimum under four scores, so one unlucky frame drives the search to a needlessly large file. | **Fixed.** Tiny sets report their median (lower-middle for pairs); the ≥4 percentile path is unchanged. Gated by `test_a_tiny_probe_is_not_hostage_to_one_unlucky_frame`, observed failing (40.0 where 90.0 was the answer). |
| L10 | low | The passthrough leaves the quality-shortfall warning describing the deleted encode. | **Fixed**, together with the cap-miss and lost-sound warnings, and folded into the passthrough gate `test_leaving_a_file_alone_erases_every_fact_about_the_deleted_encode`, observed failing. |

**The C1 record — why there is still no lookup table, with numbers.** The
reverted 1-D attempt is recorded above; this pass built and measured the 3-D
option the note suggested, and it is *mathematically excluded* by the
one-code-value bar, not merely hard:

- A straight 65³ tetrahedral table (the same interpolation `lut3d` uses) is
  fine on the narrow-gamut path (worst 0.32–0.98 code values) and **14–19
  code values wrong on the wide-gamut path** — measured on adversarial
  gamut-edge colours, at every table size tried (33³/65³/97³, with and
  without perceptual input shapers, split pipelines, and float inter-stages).
- The reason is structural: the conversion ends in a 2.4 gamma whose slope is
  unbounded at black, and the BT.2020→709 matrix pushes saturated colours
  *through* black (negative linear light, clipped to zero). At that boundary
  an error of *e* in linear light becomes `255·e^(1/2.4)` code values on
  screen, so staying under one code value needs linear error below
  `(1/255)^2.4 ≈ 1.7e-6`. A 65³ table leaves ~1e-3 there. Even float16
  evaluation of the *exact formulas* fails (1.58 code values, measured);
  float32 passes at ~0.19. Only near-exact evaluation clears the bar —
  which is now pinned by
  `test_the_float32_path_stays_exact_at_the_gamut_boundary`.
- So the fix is the plan's other option, genuine vectorisation: the exact
  float32 arithmetic runs on horizontal bands across a thread pool (numpy
  releases the GIL inside each sweep; every step is per-pixel, so banding
  changes nothing — pinned by
  `test_the_banded_path_agrees_with_the_plain_arithmetic`), with the 3×3
  matrices as explicit ufunc arithmetic because BLAS's own thread pool fights
  the band pool (measured 5× *slower* at two workers with `@`).
- Measured at 3840×2160 on this 4-core/8-thread laptop: `to_frame` 1993 ms →
  1226 ms. The bigger wins are structural: reference frames for scoring are
  now decoded and tone-mapped **once** per file instead of once per probe
  rung per format (five to twelve times), and the climb bound removes up to
  17 whole-file passes in the worst case.
- **What remains open on C1:** a ten-minute 4K HDR final encode still spends
  hours in Python-side per-pixel arithmetic. The two identified next steps,
  neither taken here: encode both final formats in one pass over the
  tone-mapped frames (halves the dominant cost; real surgery in `compress`),
  and/or a compiled path (zimg-class C with SIMD does this exactly at
  ~10–30 ms/frame — but no maintained wheel exists under the pip-only rule).
  4K HDR is *usable* now for the probe-and-cap paths and honest throughout;
  it is not yet fast, and the UI's expectations copy already says video
  takes time.

**Resolved alongside, from the same-day honesty audit:** the browser tier now
receives and honours size caps (quality-first, then rate-targeted under the
cap, `capped`/`missedSize` posted as flags — the old worker was measured
handing back **1,986,165 bytes against a 92,160-byte cap** with nothing
said); the browser bake-off uses the desktop's winner rule instead of
smallest-bytes-wins; the desktop app renders the cap disclosure on the same
line as the percentage and shows the audio note, running time and XPSNR
witness in the facts panel; the sound claim comes from what the encode
recorded doing rather than comparing codec names afterwards (which reported
"kept exactly as it was" for re-encoded audio and "re-encoded" for *silent*
files — silent output is now disclosed as silent); the XPSNR witness
straightens the reference with the encoder's own transform chain, pairs
frames by timestamp and pools worst-first (a rotated clip measured **−1.3 dB**
under the old comparison); the never-bigger rule no longer steps aside for
resized output; `probe()`'s first-frame decode failure is recorded as a
warning instead of swallowed; and the benchmark's `vs best` column is blank
on rows that missed the floor, because bytes are only comparable at equal
quality.

**The open items, and what became of them (2026-08-16, later the same day):**

1. **i18n — half done, and the half that was possible.** Every *number* in
   both interfaces now follows the reader's own locale through `Intl`: a
   German reader sees `1,4 MB` and `90,5` where the code used to hard-code
   `1.4 MB` and `90.5`. On a product whose whole argument is a measured
   number this was a correctness bug, not a nicety — `90,5` read as `905` is
   a different claim. Gated by `tests/web/probe_i18n.mjs`, which launches
   real Chrome in three locales rather than stubbing `Intl`, because the
   thing under test is whether the code asks the platform at all.
   **The copy is still English, deliberately.** Hitting this product's
   five-year-old-readable register in another language is work for a person
   who speaks it; a machine translation would be technically correct and
   break the one rule the writing exists to keep. That still needs owner
   decisions — which locales, and who writes them.
2. **Installer licence texts — done.** `tools/collect_licences.py` collects
   the full text of all eight bundled packages from the wheels actually
   installed at build time, and the release workflow writes
   `THIRD-PARTY.txt` into the payload each installer packages. Runs
   `--strict`, so a wheel yielding no text fails the release rather than
   shipping a notices file quietly missing an entry.

   **And the imagequant question is now answered, not merely disclosed.**
   Upstream states it plainly: libimagequant is GPL v3-or-later for
   open-source use, or a paid commercial licence — the wheel's BSD text
   covers only Wanadev's Python binding. So it joins `av` as pip-only and is
   excluded from the installers, because distributing GPL code inside this
   MIT bundle would put the whole bundle under GPL. Measured before
   deciding: **0.5%** end to end on the benchmark corpus (461,500 → 463,830
   bytes), since the bake-off almost always ships WebP-lossless or JPEG over
   PNG-8. Enforced in three places — the PyInstaller `excludes`, the release
   gate (which also fails if `--check` stops *naming* the excluded engines,
   because an absence nobody can see cannot be distinguished from a
   violation), and `tests/test_installer_licensing.py`.
3. **D5, the video accent — shipped.** Purple for video, the brand accent
   for images, in both interfaces. Two values rather than one because a
   single purple cannot clear AA on both grounds (PostHog's own `#B62AD9` is
   4.76:1 on light and 3.11:1 on dark). The desktop queue had the worse half
   of the problem and drew no kind badge at all, so a clip was a row with an
   empty thumbnail square. Gated by reading the *computed* colour off the
   painted badge in both themes.
4. **C1's remaining gap** — narrowed again, not closed. A two-format HDR
   bake-off used to convert every frame twice for identical pixels;
   `ToneCache` means the second format pays nothing for colour. What is
   still true: a ten-minute 4K HDR clip is hours of Python-side per-pixel
   arithmetic, and the honest fix is a compiled path, which conflicts with
   the pip-only rule. That is an owner decision, recorded in the review
   section above with its measurements.

**Found and fixed alongside, from an adversarial security and SEO audit:**
the desktop UI shipped with no CSP while holding the API token;
`MAX_VIDEO_BODY` was defined and referenced by nothing, so every upload was
capped at the 512 MB *picture* limit on the tier built for phone video, and
uploads were read whole into memory rather than streamed; the entire SEO
surface (title, description, OG/Twitter, JSON-LD, and the only crawlable
prose) said "images only" after video had shipped; the installed PWA could
not *open* a video from the file manager; and `LICENSES.md` pinned SHA-256
hashes that nothing ever recomputed.

This is the canonical plan for adding video compression and for the
PostHog-style reskin. It records what was approved, the exact copy, the
file-by-file order of work, and the rules that bind every change. The
proposal it condenses was reviewed and approved by the owner on 2026-08-14
("recommended decisions please, take it to the finish line").
Research record: `docs/VIDEO_RESEARCH.md`. Design record:
`docs/POSTHOG_DESIGN_SPEC.md`.
Presentation copy: https://claude.ai/code/artifact/bf1edbdd-8c77-4cca-8421-957c363d2ad6

## Approved decisions

| # | Question | Decision |
| --- | --- | --- |
| V1 | Ship video, in what order | Yes. Desktop engine first, browser second — the desktop tier is the quality flagship and produces the corpus the browser tier is measured against |
| V2 | Python floor (PyAV needs ≥3.11, CI has 3.9) | Optional `pocketsize[video]` extra. Core stays 3.9. Video absent ≠ broken: it degrades like every other optional engine |
| V3 | Installer GPL posture | pip extra now (dependency posture is clean, our source stays MIT). Custom LGPL wheels for the installers later — **installers must not bundle av until that is resolved** |
| V4 | H.264 in the pip path | Accept x264-in-wheel. Risk to a small free tool is negligible and the last US patent expires 2027-11-29 |
| V5 | Metrics | Desktop: **steer on XPSNR, certify with SSIMULACRA 2** on sampled frames; add VMAF v1 as a third witness when `av` v19 ships libvmaf. Browser: SSIMULACRA 2 sampled + temporal guard. Never certify with the metric the search steered on |
| V6 | Video destination table | As in §A below |
| V7 | Browser honesty copy | Same register as BENCHMARK.md's quantizer concession — stated plainly, in the open |
| V8 | Unsupported-browser copy | "This browser can't re-encode video yet — the desktop app can." |
| V9 | Hardware encoders | Opt-in fast mode, desktop only, never the default behind a "smallest" promise |
| V10 | HEVC | Encode never. Decode always |
| D1 | Surface palette | PostHog website warm eggshell |
| D2 | Fonts | Keep Geist / Geist Mono / Bricolage. Adopt the patterns: mono-for-data, tabular numerals, uppercase micro-labels at our 13px floor |
| D3 | 3D button chrome | Adopt on primary and secondary. Tertiary stays flat |
| D4 | Accent swap | Adopt: orange in light, yellow in dark |
| D5 | Two-accent media coding (orange images / purple video) | Ships with video |
| D6 | Brand posture | PostHog-*flavoured*, never PostHog-branded. No marks, mascots, illustrations, or wordmarks |

## Binding constraints (check every change against these)

1. **Decision count must not grow.** Video adds zero required decisions. A
   video answers the same one question an image does: where is it going?
2. **Quality is measured, not guessed.** A CRF number is never shown as the
   product's answer; the measured score is. The search finds the setting.
3. **Never certify with the metric you searched on.** XPSNR steers,
   SSIMULACRA 2 certifies. (SVT-AV1 4.2 ships a TUNE-VMAF mode — encoders now
   game metrics openly; this rule is load-bearing, not ceremonial.)
4. **Disclosure is non-negotiable.** If pixels were removed, the line that
   shows the % says so. Video adds two more: if a **size cap** forced quality
   below the destination's floor, the same line says so; if **audio was
   re-encoded** rather than copied, the facts panel says so.
5. **Five-year-old-readable copy.** No CRF, no bitrate, no codec names
   outside More choices. "Small enough to attach" not "H.264 CRF 23".
6. **Legibility floor: no text below 13px**; body/control text 15–16px.
7. **Local-first.** No hosted API, no upload path, ever.
8. **Stop and ask** on anything this plan does not cover.

## A — the video destination table (approved)

Video destinations live in the same `destinations.py` table, carrying video
fields. Formats are codec+container pairs, listed best-first; the bake-off
decides. `size_cap_mb` is a first-class destination property — video
destinations are defined by byte caps in a way images never were.

| name | label | formats | frame cap | floor | size cap | audio |
| --- | --- | --- | --- | --- | --- | --- |
| `web` | Website or app | av1-mp4, h264-mp4 | 1920 | 92 | — | copy |
| `email` | Email or chat | h264-mp4 | 1920 | 90 | 18 MB | copy |
| `chat` | Discord or group chat | h264-mp4, av1-mp4 | 1280 | 88 | 10 MB | aac |
| `social` | Social media post | h264-mp4 | 1920 | 90 | 500 MB | aac |
| `documents` | Slides or document | h264-mp4 | 1920 | 90 | — | aac |
| `original` | Keep full quality | av1-mp4, h264-mp4 | never resized | 96 | — | copy |

Copy for the new entries:

- `email` — "Small enough to attach, and plays everywhere."
- `chat` — "Fits Discord's free 10 MB limit, and plays everywhere."
- `original` — "No resizing, highest fidelity. For masters and archives."

## B — size-cap disclosure (ships in full)

| Where | Copy |
| --- | --- |
| Result line, cap met and floor cleared | `48.2 MB → 9.4 MB — 80% smaller` |
| Result line, resized | `… — 80% smaller, and made smaller on screen (1920 across)` |
| Result line, **cap forced quality down** | `… — 80% smaller, and not as sharp as the original to fit 10 MB` |
| Facts panel, audio re-encoded | `Sound re-encoded to fit this format.` |
| Facts panel, audio copied | `Sound kept exactly as it was.` |

The engine must post an explicit flag for each; the UI must not infer it from
comparing numbers. This is the same rule the image tier learned with
`hardCapped`.

## C — what the engine does to a video

1. Reads it without loading it into memory.
2. Caps the frame size if the destination says so.
3. **Searches** for the lowest bitrate/CRF whose sampled frames still measure
   at or above the destination's floor — 20-second windows, evenly spaced,
   ~4 probe rounds, interpolated bisection with an expanding tolerance.
4. Under a size cap, switches to two-pass at the cap's bitrate, then
   **measures and reports what quality it actually achieved**.
5. Copies the audio track when the container can carry it; otherwise encodes
   Opus (WebM/MKV) or AAC (MP4).
6. Writes MP4 with `+faststart`, and never writes a file bigger than the
   source.

## D — the reskin

Values, mapping and component patterns: `docs/POSTHOG_DESIGN_SPEC.md`.
Mechanically it is a re-valuing of the existing `--oz-*` tokens inside the
existing theme blocks; no sheet outside `heyoz-tokens.css` and `base.css`
gains a colour literal, and the desktop app receives its copy from
`tools/sync_webui_assets.py`.

## Order of work (files)

1. **Foundation** — `pocketsize/destinations.py` (video fields + entries) →
   `tools/gen_destinations.py` (emit them) → `web/destinations.js`
   (regenerate, never hand-edit) → `tests/test_compress.py` +
   `tests/test_destination_parity.py`.
2. **Engine** — `pocketsize/video.py` (new: probe, search, encode, measure) →
   `pocketsize/quality.py` (frame-sampled scoring for video) →
   `pocketsize/core.py` (route video files) → `pocketsize/encoders.py`
   (capability report).
3. **Surfaces** — `pocketsize/cli.py` (accepts video, reports it) →
   `pocketsize/server.py` (desktop intake) → `README.md` / `GUIDE.md`.
4. **Reskin** — `web/heyoz-tokens.css` → `web/css/*.css` →
   `tools/sync_webui_assets.py` (run, commit copies).
5. **Verification** — `python -m unittest discover -s tests`, `ruff check .`,
   `python tools/gen_destinations.py --check`,
   `python tools/sync_webui_assets.py --check`, the browser design gates, and
   every new gate observed failing first.
6. **Browser tier** (second, per V1) — WebCodecs + Mediabunny worker path,
   `media-src blob:` added to the CSP, service-worker precache + VERSION bump,
   `LICENSES.md` pin table extended.

## CLI notes

- `pocketsize clips/ --for chat` compresses video the same way it compresses
  images; a folder of both is one run.
- `pocketsize --check` reports the video engine and which encoders are live.
- Without the extra installed, video files are reported and skipped with the
  install command in the message — never a crash.
