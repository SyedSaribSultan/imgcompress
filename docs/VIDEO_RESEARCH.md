# Video compression — research and proposal (2026-08-14)

> **Status: RESEARCH COMPLETE, NOTHING APPROVED, NOTHING IMPLEMENTED.**
> This document records what was found and what is recommended. Every decision
> it proposes is listed in §11 for the owner to approve, change, or reject.
> The image product's rules bind everything here: quality is measured, not
> guessed; one question ("where is it going?"); zero required decisions;
> local-first with nothing uploaded; matched-perceptual-quality evidence for
> every claim.

Research method: eight parallel investigations (codebase seams, codec
landscape, target-quality search prior art, quality metrics, browser stack,
pip-only Python stack, market/destination caps/licensing, plus design), each
against primary sources current to August 2026. Load-bearing claims carry
their source; anything unverifiable is flagged in §12 rather than asserted.

---

## 1. The headline finding

**Nobody ships what Pocketsize's premise implies for video.** The tools that
search for "the smallest encode that still measures visually identical"
(ab-av1, Av1an) are enthusiast CLIs needing external encoders; the tools
normal people can use (HandBrake, online compressors) either demand codec
knowledge or upload the file to a server. No tool — commercial or open
source — combines: quality-by-measurement, the destination question,
local-only processing, and one product across browser + desktop + images +
video. A pip-only, offline, quality-targeted video compressor does not exist
at all. The positioning is empty.

Two supporting facts:

- HandBrake, the best free desktop tool, has **no target-size mode** and its
  presets describe encoder speed ("Fast 1080p30"), not user intent. It never
  answers "will it fit / will it play there?"
- Most "online video compressors" upload. 8mb.video's own privacy page says
  files are "permanently deleted from the server after 20 minutes" — i.e.
  they were on a server. True client-side competitors exist (videocompress.dev,
  8mb.fit, compress.lol) but are thin single-slider tools: no destination
  model, no measurement, no batch, no desktop, no images. "Nothing is
  uploaded" alone is no longer unique in video; *"nothing is uploaded + one
  question answers everything + the same tool as your images + the evidence
  to check"* is.

## 2. What people actually need (destinations)

Verified caps, August 2026 (sources in the research archive; several
platforms publish nothing official — flagged in §12):

| Destination | The constraint | Notes |
| --- | --- | --- |
| Email | **25 MB** (Gmail send, Outlook.com) | MIME base64 inflates ~33% → real target ≈ **18–20 MB** |
| Discord | **10 MB** free (50/500 MB Nitro tiers) | official FAQ blocks fetchers; 10 MB confirmed via multiple 2026 sources |
| WhatsApp | ~16 MB inline, brutal re-encode (~720p) | document-mode sends 2 GB untouched — the escape hatch |
| Slack / Telegram | 1 GB / 2 GB | rarely the driver |
| iMessage | ~100 MB practical | unpublished |
| Social (IG/TikTok/X/YT) | platforms re-encode **everything** | the job is to stay *above their floor*, not under a cap; YouTube official: MP4 H.264 High + AAC, faststart, 8 Mbps@1080p30 |
| Slides/docs | PowerPoint & Keynote & Google Slides: **H.264+AAC MP4 only** safe | Microsoft's official recommendation; Keynote converts everything else; Notion free plan caps files at **5 MB** |
| Self-hosted web | hero loop: 720p, ~1 Mbps, 2–5 MB, muted; content: 1080p H.264 2.5–5 Mbps, AV1 source ≈ −40–50% | practitioner consensus (Mux et al.) |
| Courts/portals/LMS | 20–50 MB portals; Canvas media 500 MB; Moodle default 20 MB | |

The recurring magic numbers: **10, 16, 20, 25, 100, 500 MB, 1 GB.** The
destination model transfers to video *better* than it did to images, because
video destinations are dominated by hard byte caps — which the engine can hit
exactly (§4) — and by "will it even play there," which the format list
answers.

## 3. Codec and encoder landscape

- **AV1 is the efficiency winner**: ~−48–55% bitrate vs H.264 and ~−20% vs
  HEVC at matched quality (Netflix production: AV1 = 30% of its streaming,
  −48.1% vs H.264, Dec 2025). Royalty-free, BSD encoders, plays in ~94% of
  browsers. The gap: Apple — no software AV1 decoder ever; hardware decode
  only on A17 Pro/M3 and newer. So AV1 output needs an H.264 companion or an
  explicit compatibility destination.
- **H.264 is still the only "plays literally anywhere" codec**, and its last
  US patent expires **2027-11-29**, after which it is effectively
  royalty-free in the US.
- **HEVC encode: never.** Multi-pool licensing mess (Access Advance is
  actively litigating), no internet-use exemption. Decoding what arrives is
  fine; producing it has no place here. VVC/H.266: zero browser support —
  not a candidate. VP9: legacy; only value is universal WebM playback.
- **The encoder that matters is SVT-AV1** (v4.2.0, July 2026): CRF to 70 in
  quarter-steps, adaptive film grain, variance boost merged from the
  now-archived PSY fork. Community transparency band at 1080p: **CRF 18–25 at
  preset 2–4**; "visibly fine": CRF 26–32; HandBrake maps its HQ preset to
  preset 6. Preset 6 ≈ preset-2 file sizes at 18–20× the speed; preset 8 is
  roughly real-time at 1080p on a modern laptop. For x264: **CRF 17–18,
  preset slow** is the long-standing visually-lossless consensus.
- **Hardware encoders (NVENC/QSV/AMF/VideoToolbox) are speed tools**:
  measured (SSIMULACRA2 curves) at roughly SVT-AV1 preset 9–10 quality.
  Behind a "smallest possible" promise they can only ever be an explicit,
  labeled fast mode — never the default.
- **Audio**: Opus 128 kbps stereo = transparent; AAC needs ~128–192. The trap:
  **Safari refuses Opus in MP4** — so MP4 carries AAC, WebM/MKV carries Opus.
  Default behaviour should be **copy the audio track** whenever the source
  codec is container-compatible and ≤ ~256 kbps: lossy→lossy transcodes only
  lose, and audio is a small fraction of the file.
- **Containers**: MP4 with `+faststart` (moov up front — mandatory for web
  playback, lossless remux) for everything shared; WebM for the
  licensing-clean AV1+Opus lane; MKV never (no browser plays it).

## 4. The search — how "smallest file that still looks identical" works for video

The image engine's binary search transfers almost verbatim; the prior art is
**ab-av1** (the enthusiast gold standard, doing exactly our premise with VMAF):

- **Sample, don't encode everything.** 20-second samples, evenly spaced,
  ~1 per 10–12 minutes of runtime (whole-file below ~1 minute, per ab-av1's
  85% rule). A 3-sample probe predicts final quality within ~0.3 VMAF of the
  full-file truth. Probes cost ~1–3 minutes; the final encode dominates.
- **Interpolated bisection over CRF**, coarse increments (0.25–1.0), an
  *expanding acceptance tolerance* per iteration to absorb metric noise
  (CRF→quality is broadly monotone but noisy — every shipped tool hedges).
  ~4 probe iterations is the industry norm. Cache probe results keyed on
  input + settings, like the browser tier's score memo.
- **Size caps are a different, solved problem**: bitrate = (0.95 × cap −
  audio) ÷ duration, **two-pass**, verify, one retry (the ffmpeg4discord
  precedent). Sample-based size *prediction* is the weak spot (ab-av1's own
  demo missed by 7 points), so caps use two-pass, not CRF search. Hybrid:
  quality-first search; if the passing encode exceeds the destination's cap,
  flip to two-pass at the cap and **report the measured quality actually
  achieved** — the honest inverse of the promise.
- **Resolution join the search only under caps**: convex-hull research
  (Netflix per-title) shows downscale-then-encode wins only below a
  content-dependent bitrate crossover. At "looks identical" targets, 1080p
  stays 1080p; a 4K source squeezed under 10 MB is where a 1080p candidate
  enters — scored **upscaled back to source resolution**, or the metric
  conflates resize loss with codec loss (this is the video form of the
  resize-disclosure rule).
- **Scene detection is a v2 optimization, not a prerequisite**: uniform
  samples + worst-sample pooling is what ab-av1 ships and it holds up;
  detection accuracy actually degrades on messy consumer footage. The
  in-wheel `scdet` filter is available when v2 wants it (no OpenCV).
- **Realistic wall clock, 1080p on a no-GPU laptop**: SVT-AV1 preset 6–8
  including search ≈ **1.5–3× the video's duration**; x264 slow ≈ 0.3–1×.
  This must be visible in the UI's expectations (queue copy, progress), the
  way weak-device handling already is for images.

The bake-off idea survives too, in bounded form: candidates are (codec ×
occasionally resolution), each CRF-searched — e.g. AV1 vs H.264 where the
destination allows both — with the same two-slot best-passing/best-failing
rule and the same never-bigger rule (if the search cannot beat the source
file, ship the source untouched; remux-only when only the container is
wrong).

## 5. The metric — what certifies "looks the same"

The decisive June 2026 event: **Netflix shipped VMAF v1** (libvmaf 3.2.0) —
NEG (the anti-gaming model) is now the default, CAMBI (banding detection) is
built in, chroma is finally scored, and it is faster than v0. Evidence tiers
for "visually indistinguishable":

| Metric | Threshold | Evidence quality |
| --- | --- | --- |
| VMAF ≥ 95 (mean) | transparency | controlled study (Joyn/RheinMain, SPIE 2021) |
| VMAF ≈ 93 | "indistinguishable or not annoying" | Netflix guidance, folklore-with-provenance; ~6 pts ≈ 1 JND |
| SSIMULACRA2 ≥ 90 per frame | visually lossless (flicker test) | image-dataset evidence only — **no published video validation**; must be stated as image-derived |
| XPSNR ≥ 42 dB | visually lossless | community folklore, weakly sourced |

Two structural facts drive the design:

1. **Per-frame metrics are temporally blind.** Flicker, GOP "breathing"
   (quality pumping at keyframes), shimmer — invisible to SSIMULACRA2 by
   construction, and VMAF's motion term is computed on the *reference*, so it
   doesn't see them either (the documented "VMAF paradox"). The affordable
   guard: pool per-frame scores by **mean AND a low percentile (p5)**, and
   watch the score time-series for keyframe-aligned sawtooth. Certify only if
   the low percentile also clears.
2. **The house rule — never validate with the metric you searched on — now
   has a sharp edge**: SVT-AV1 4.2 ships a TUNE-VMAF mode (+15% "VMAF
   BD-rate"), i.e. encoders now openly game VMAF. The clean posture is to
   steer and certify with **different metric families**:
   - **Desktop**: search on XPSNR (in the PyAV wheel today; the only
     candidate with *video*-dataset correlation evidence, SROCC 0.831 vs
     VMAF's 0.796) and certify with VMAF v1 when `av` v19 lands (weeks away
     — libvmaf is already in pyav-ffmpeg main), cross-checked with the
     existing `ssimulacra2` wheel on sampled frames as the second witness —
     exactly the BENCHMARK.md "two metrics agreeing" pattern.
   - **Browser**: our validated SSIMULACRA2 JS port on sampled frames
     (decode-back via VideoDecoder; score in YUV-derived planes, never
     browser-converted RGB; ~est. 0.3–1.5 s/frame — benchmark the port
     before committing UX), plus the p5/time-series temporal guard. A JS
     XPSNR port (~3× PSNR cost, cheapest credible port) is the natural
     second witness later. There is **no maintained WASM VMAF** (the one
     port died May 2023).
   - Encode with AV1 film-grain synthesis **off** for anything scored
     (hardware and software decoders synthesize grain differently).

## 6. The browser tier

**Recommended stack: WebCodecs + Mediabunny, in a worker. No ffmpeg.wasm.**

- **WebCodecs** reaches ~93.6% of users (Chrome/Edge 94+, Firefox desktop
  130+, Safari 16.4+ video / full API in Safari 26). Encode reality per the
  1.14M-session field dataset: VP8 ~100%, H.264 64%, HEVC 42%, VP9 26%, AV1
  20% — the ladder **AV1 → H.264/VP9 floor** covers ~99.9% of
  encode-capable sessions. Firefox Android: no WebCodecs at all; Safari
  <17.4 broken — both get an honest "not supported on this browser yet"
  gate. Chromium exposes `quantizer` bitrate mode (per-frame QP = the
  CRF-like handle) and `prefer-software` (more consistent across machines);
  Safari encodes H.264/HEVC via VideoToolbox only.
- **Honesty requirement**: browser encoders are realtime-tuned (Chrome's AV1
  = libaom at realtime speeds; hardware ≈ SVT-AV1 preset 9–10 class). A
  browser encode is realistically **10–30% larger at matched quality** than
  the desktop's tuned SVT-AV1. Two product-honest responses: the measured
  score is still real (we certify what we made, not what we hoped), and the
  desktop app is the "absolute smallest" tier — said plainly, the way the
  BENCHMARK.md already concedes the 2.5 KB quantizer gap.
- **Mediabunny** (MPL-2.0, zero deps, tree-shakable): demuxes/muxes
  MP4/MOV/MKV/WebM (iPhone HEVC MOV included), streams lazily with
  backpressure, writes direct-to-disk via `FileSystemWritableFileStream`,
  supports `registerEncoder` for a future wasm SVT-AV1. This is the
  Clipchamp architecture (wasm for containers, platform codecs for encode)
  available as a library. ffmpeg.wasm is rejected: ~12–25× slower,
  effectively unmaintained, GPL-built cores, and threading would force
  COOP/COEP onto the whole site. The WebCodecs path needs none of that.
- **Patent posture is a genuine advantage**: the browser vendor ships and
  licenses the encoder; a site calling the API distributes nothing (this is
  why Firefox routes H.264 through Cisco's OpenH264 binary). No safe-harbor
  document exists, but it is the least-exposed architecture available.
- **Repo consequences** (from the codebase map): `media-src blob:` must be
  added to the CSP (currently `default-src 'none'` blocks `<video>`
  playback of results); the service worker's precache lists + VERSION bump;
  `LICENSES.md` SHA-256 pin table extended for any vendored file;
  `.gitattributes` binary rules for new extensions; memory discipline —
  WebCodecs has **no built-in backpressure**, frames must be `close()`d and
  queues watched, output streamed to disk (OPFS sync-handle path on Safari),
  so a 2 GB phone video never fully lives in RAM.

## 7. The desktop tier

**Recommended stack: PyAV (`av` on PyPI) as the single video dependency.**

- Wheels for Windows x64/ARM64, macOS x64/arm64, Linux — **27.6 MB, no
  external binary, no shelling out**, in-process libav with per-frame filter
  metadata readable from Python (no log parsing). Inside: **libx264, libx265,
  SVT-AV1 4.1 (4.2 in the next release), libvpx, libopus, native AAC, dav1d;
  filters: xpsnr, psnr, ssim, scdet** (scene detection without OpenCV).
  `av` v19 (imminent) adds **libvmaf 3.2.0 = VMAF v1 in-wheel, models
  embedded**. Hardware encoders (NVENC/QSV/AMF/VideoToolbox/MediaFoundation)
  load dynamically and fail catchably — a perfect fit for the
  degrade-gracefully rule, as an opt-in fast mode.
- **Constraint 1 — Python floor**: av 18.x requires **Python ≥ 3.11**; CI
  currently includes 3.9. Video must be an optional extra
  (`pocketsize[video]`) gated on interpreter version, or the project floor
  moves. Owner decision.
- **Constraint 2 — the GPL wrinkle**: the av wheels self-report BSD/LGPLv3
  but contain GPL x264/x265 (a build patch relabels them; it changes a
  configure guard, not the license). As a *pip dependency* this is the
  accepted safe posture and Pocketsize's code stays MIT. But the **three
  installers** would be *distributing* GPL binaries — the bundle must comply
  with GPL terms, or we build custom LGPL wheels without x264/x265
  (feasible; auto-editor's `ae-ffmpeg` is precedent), or installers encode
  AV1/VP9/Opus only. Owner decision; it is the only real blocker found.
- Precedent that the whole shape works: auto-editor shipped a full video
  editor pure-PyAV for several major versions.

## 8. Where the engine seams already are (from the codebase map)

- Video-shaped input currently exits at the animated-passthrough guard
  (`core.py:431`, `worker.js:1352`) — the natural intake point.
- The `Encoder` contract (ascending `levels`, `encode(level, fast)`,
  `available()`) is codec-agnostic; a video encoder's ladder is CRF rungs and
  `_search_one`/`searchOne` bisect it unchanged. The two-slot bake-off,
  size-cap inversion, never-bigger rule, candidate tuples, progressive
  candidate posting — all transfer.
- The `Metric` facade needs one genuinely new concept: **time** (sampled
  windows + mean/p5 pooling instead of pixel tiles only).
- `Destination` needs video fields (or a parallel video table): formats are
  codec+container pairs, the size cap is a first-class number (images never
  had "25 MB" as a *destination property*; video destinations are defined by
  it), plus an audio policy. Generated into `destinations.js` exactly like
  today, browser-only extras declared not smuggled.
- The split-compare view is the one place the image geometry argument does
  not carry: synchronized A/B playback of two `<video>` layers is genuinely
  new UI work (frame-stepped comparison of decoded stills is the affordable
  v1; live synced playback is the v2 aspiration).
- The E2E harness, design-system gates, destination-parity gates and
  CI matrix all apply as-is; every new gate must be observed failing first.

## 9. Proposed shape (PROPOSED — nothing here is decided)

One product, same page, same question. Videos drop into the same queue.

**Proposed video destination table** (draft numbers, all owner-approvable;
formats listed best-first, the bake-off decides):

| Destination | Formats | Frame cap | Quality floor | Size cap | Audio |
| --- | --- | --- | --- | --- | --- |
| web | AV1-MP4, H.264-MP4 | 1920 | high (VMAF 95-class) | — | copy/AAC·Opus |
| email / chat | H.264-MP4 | 1920 | high | **18 MB** | copy/AAC |
| discord | H.264-MP4, AV1-MP4 | 1920 | best-under-cap | **10 MB** | AAC 128k |
| social | H.264-MP4 (platform floor specs) | 1920 | high | 512 MB | AAC |
| documents / slides | H.264-MP4 only | 1920 | high | — | AAC |
| original | AV1-MP4 (+H.264 fallback) | never resized | transparency | — | copy |

(A hero-loop/web-background destination and a WhatsApp-specific 16 MB entry
are candidates; deliberately not proposed to keep the visible list short —
the size-cap field in More choices covers the long tail, as it does today.)

**Copy stays literal**: "Small enough to attach — under 18 MB, plays
everywhere." "Discord's free limit is 10 MB — this will fit." If the cap
forced quality below the floor: the same line says so, same size, never
after (the resize-disclosure rule generalized to quality-under-cap
disclosure).

**Phasing recommendation**: desktop engine first (it is the "best in the
world" tier — SVT-AV1 + real search + VMAF v1 certification), browser second
(reach tier, honest about the encoder class), because the desktop result
also produces the benchmark corpus the browser tier is validated against.
Both ship behind the same destinations table from day one.

## 10. Proof obligations before any claim ships (CONTRIBUTING.md applied to video)

1. A video benchmark corpus in `tests/` mirroring `make_fixtures.py`
   rationale: screen recording, phone footage (shaky, grain), animation,
   talking head, high-motion — content classes that push codecs differently.
2. `bench_video_vs_alternatives.py`: HandBrake presets, fixed-CRF defaults,
   two online competitors' outputs — everything scored at matched perceptual
   quality by **two metric families** (VMAF v1 + SSIMULACRA2-sampled), sizes
   compared only among passing encodes. Fixed-quality rows unsearched on
   purpose, exactly like the image benchmark.
3. The browser tier scored by the same harness driving the real page
   (`bench_web_out.mjs` pattern).
4. Metric-parity gate for whatever the browser scores with (the
   `check_ss2_corpus.py --expect N` pattern extended to video frames).
5. Every new gate observed failing, said so in the commit.

## 11. Decisions for the owner (nothing proceeds without these)

| # | Question | Recommendation |
| --- | --- | --- |
| V1 | Ship video at all, and in which order? | Yes; desktop engine first, browser second (§9) |
| V2 | Python floor: optional `[video]` extra on py≥3.11, or move the project floor? | Optional extra; keep 3.9 core |
| V3 | Installer GPL posture: bundle GPL av wheels (comply), custom LGPL wheels (no x264/x265 in installers), or AV1-only installers? | Custom LGPL wheels later; pip extra now (dependency posture is clean) |
| V4 | H.264 in the pip path: accept x264-in-wheel (patent exposure ends 2027-11), or AV1/VP9-only until then? | Accept; risk to a small free tool is negligible and time-limited |
| V5 | Metrics: XPSNR-steer + VMAF-v1-certify + SS2 second witness (desktop); SS2-sampled + temporal guard (browser)? | As stated in §5 |
| V6 | Video destination table (§9): entries, numbers, copy | Review the draft table |
| V7 | Browser honesty copy: how plainly do we state the browser encode is larger than desktop's? | Same register as BENCHMARK.md's quantizer concession |
| V8 | Unsupported-browser gate copy (Firefox Android, old Safari) | "This browser can't re-encode video yet — the desktop app can." |
| V9 | Hardware encoders: opt-in fast mode under More choices, desktop only? | Yes, never default |
| V10 | HEVC: confirm encode-never, decode-always | Confirm |

## 12. Unverified / flagged (do not repeat as fact without re-checking)

Discord's official FAQ (403-blocked; 10 MB from secondaries) · TikTok/
WhatsApp/X publish no official caps · VMAF v1 has no third-party threshold
validation yet (too new) · SSIMULACRA2's 90-threshold is image-derived, not
video-validated · XPSNR 42 dB is folklore · the JS SS2 per-frame cost
(0.3–1.5 s) is an estimate — benchmark before committing UX · WebCodecs
encoder quality penalty (10–30%) is direction-supported, magnitude estimated
· cross-browser decode bit-exactness is a spec-level argument ("expect
exact, tolerate epsilon") · Safari's exact encoder list needs on-device
`isConfigSupported` probes · pyav-ffmpeg's x264 relabeling has no public
legal justification · per-competitor upload behaviour needs network traces
before any comparative marketing claim · x264 laptop fps figures are
folklore · av v19 release timing is inferred from commit activity.

Full per-topic research reports with all source URLs are archived in the
session scratchpad (`research/01`–`08`); this document is the synthesis.
