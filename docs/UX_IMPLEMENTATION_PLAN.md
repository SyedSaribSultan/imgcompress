# UX Implementation Plan — approved 2026-08-13

> **Status: IMPLEMENTED 2026-08-13.** All six steps landed. Verification:
> 110/110 Python unit tests, destinations generator current, browser E2E
> 82 passed / 0 failed, and every focused probe (flow, controls, states,
> sizecap, a11y, mobile, theme) green. Deviations from the letter of this plan,
> all disclosed in the implementation report: the weak-device core threshold is
> ≤3 (not ≤4 — 4-core machines and CI are not weak); the edge-mode label reads
> "Count the shrink limit on" (the planned "size limit" wording collided with
> the KB Size limit field); §6.3's result sentence ships via the batch-end
> toast. Two bugs were found and fixed during verification: a fresh profile
> booted into "identical" because it was the select's first option (fixed with
> an explicit `selected` on 90), and concurrent codec loads could collide and
> silently disable a format (fixed with single-flight promise caching).

This is the canonical plan for the UX/performance overhaul. It records what was
approved, the exact copy, the file-by-file order of work, and the rules that
bind every change. The proposal it condenses was reviewed and approved by the
owner on 2026-08-13 ("everything is good, do whatever is recommended").
Presentation copy of the proposal: https://claude.ai/code/artifact/b9411fb9-f837-4620-9615-3761ddd232b2

## Approved decisions

| Question | Decision |
| --- | --- |
| Fix set | Problems A–F as specified below, plus UI rules and performance plan |
| Problem D | Footer link to the existing CLI (option a). No hosted API, ever — contradicts "nothing is uploaded" |
| Problem F | Decline org layer (SSO/policy/usage). Ship `pocketsize-report.txt` in every zip, always, no checkbox |
| "identical" × documents ceiling | Warning fires and the 4096px ceiling wins (the destination physically can't take more) |
| Report format | Plain text only |
| Local vs server | Stay local. Perceived slowness is fixed by the §Performance plan, not by a server |

## Binding constraints (check every change against these)

1. **Decision count must not grow.** First-run required decisions stay at 0.
   Visible plan fields go from 7 to 3; everything else lives in a collapsed
   "More choices".
2. **Five-year-old-readable, literal copy.** No "lossless / format / quality
   floor / compression" outside More choices; any technical residue carries its
   meaning in place ("always PNG — every pixel kept"). Say exactly what happens.
3. **Resize disclosure (Problem B) is non-negotiable**: if pixels were removed,
   the same line that shows the % says so — never after, never smaller.
4. **Legibility floor: no text below 13px** (13px only for uppercase
   micro-labels with letter-spacing); body/control text 15–16px; headline
   numbers 16px+. Spacious spacing scale.
5. **The page reads as a sequence**: add pictures → one question → result →
   evidence only on demand (facts blocks hidden until a result exists, not
   dimmed scaffolding).
6. **Stop and ask** on any decision this plan doesn't cover. Do not improvise
   UX mid-implementation.

## The fixes

### A — plain-language panel

Visible fields (all others move to a collapsed "More choices"):

| Before | After |
| --- | --- |
| Going to → (destinations) | unchanged + new option **Social media post** |
| Never below → good enough to re-edit / indistinguishable / indistinguishable unless you compare / indistinguishable side by side / clean at thumbnail size | **Must still look** → **identical — every pixel kept** / perfect, even for re-editing / exactly the same to your eye / the same unless you zoom in and compare / the same at a glance / clean when shown small |
| Measured on → longest edge / width / height / nothing — keep original, + No wider than [2560] px | **Shrink big photos** → to at most [2560] px / **never — keep every pixel** (one row) |

More choices (collapsed):

| Before | After |
| --- | --- |
| Aim for → the smallest file / a size limit | Size limit → none — just make it small / at most [200 KB] |
| Write as → whichever format wins / always JPEG / … | File type → automatic — keep whichever comes out best / always JPEG / always PNG — every pixel kept / … |
| (edge mode from "Measured on") | Count the size limit on → the longest side / the width / the height |
| Add `-min` to filenames | unchanged |

New destination in `destinations.py`:
`name="social"`, `label="Social media post"`, `max_dimension=2048`,
`ss2_target=88`, `formats=jpeg/png8/png`,
`help="Sized and saved so Instagram, X and Facebook won't shrink it again themselves."`

Other copy: quality sentence follows the new words ("The smallest file that
still looks exactly the same to your eye."); lossless sentence: "Every pixel
stays exactly as it is. Files come out larger this way."; caps note: "This
browser can't save AVIF or lossless WebP — everything else still works." (and
fix the label-key fallthrough that printed WEBPLOSSLESS); versions helper:
"Every version here is real and ready. Tap one to keep it instead."

### B — resize disclosure (ships in full)

| Where | After |
| --- | --- |
| Stage bottom bar | `330.3 KB  −91% · shrunk to 3186×4096` |
| Queue row | `3.7 MB → JPEG · −91% · shrunk` |
| How this was measured | First line of the panel, full-strength, before the stat grid: "Part of the −91% comes from shrinking the picture from 3500×4500 to 3186×4096 — not just from compressing it. The visual match below was measured on the compression alone." |
| Zip toast | "Zipped 6 images — 10.9 MB lighter. 3 of them were shrunk in pixels, not just compressed." |

Hard-ceiling case (documents 4096px firing against "never — keep every pixel")
uses the orange warn slot: "You asked for no shrinking, but design tools damage
anything over 4096 px when you import it — so this was shrunk to 4096 px first.
Pick a different 'Going to' if you need every pixel." And the plan warns before
it happens (destination=documents + shrink=never): "Design tools are the
exception: images over 4096 px will still be shrunk to 4096, because those
tools crush anything bigger on their own."
Worker must post an explicit hard-cap-applied flag; the UI must not infer it.

### C — "identical" as the top quality rung

Choosing "identical — every pixel kept": bake-off restricted to `png`,
`webp-lossless`, `png8x` (the hidden lossless set in destinations.py);
"Shrink big photos" flips to never + disables with "Shrinking changes pixels,
so it's off while 'identical' is chosen."; documents ceiling still wins, with
the B warning up front. Per-image override label: "PNG — every pixel kept".
CLI gains `--lossless` mapping to the same set.

### D — footer line

"Also a command line — the same engine, for folders and scripts:
`pip install pocketsize`" → links to the GitHub README.

### E — weak devices

When `hardwareConcurrency <= 4` or `deviceMemory <= 4`: automatic set skips
AVIF; versions panel says "AVIF was skipped to save time and battery on this
device. Pick 'always AVIF' under More choices to try it anyway."

### F — audit record

`pocketsize-report.txt` in every zip: per image — original name, dimensions,
bytes → kept format, dimensions, bytes; visual match; shrunk?; pixel-identical?;
full versions-tried table. Plain text.

## Performance plan (all verified findings)

| # | Finding (evidence) | Fix |
| --- | --- | --- |
| P1 | Settings change wipes finished results and requeues everything; in-flight work completes then is discarded on stale rev; workers never told to stop (`main.js` pushSettings, `engine.js` rev check/requeue) | Stale-while-revalidate: never blank a finished result — keep it on screen marked "updating to your new settings…" and swap when ready. Abort message to workers on stale jobs. Only redo what the change touches (floor change → re-pick/re-search from remembered probe scores; destination change → only changed formats) |
| P2 | Nothing shown until the whole bake-off finishes (`worker.js` single done post) | Progressive candidates: worker posts each candidate as it finishes; UI adopts best-so-far the moment the first one clears the floor — "Here's the JPEG — still trying 3 more ways in the background."; chips fill live; pick upgrades with a note if a later format wins |
| P3 | Codec WASMs (incl. 3.5 MB AVIF) load serially before the first encode (`worker.js` sequential awaits) | Load codecs in parallel; start encoding with whichever is ready first; idle-time prefetch after page load |
| P4 | Re-runs re-probe rungs already measured (memo scoped to one searchOne call) | Persist per-format probe scores on the item across re-runs of the same pixels |

## UI system

- Three-state theme toggle in the header: Light / Dark / Match my device;
  stamps `data-theme` on the root; persists in localStorage; default = match.
  `heyoz-tokens.css` must honor `data-theme` in both directions, not only
  `prefers-color-scheme`.
- Type scale and spacing per binding constraint 4.
- Page order per binding constraint 5.

## Order of work (files)

1. **Foundation**: `pocketsize/destinations.py` (social + lossless set) →
   run `tools/gen_destinations.py` → `web/destinations.js` regenerated →
   `pocketsize/webui/app.html` parity → `tests/test_compress.py`.
2. **Panel & copy (A+C)**: `web/index.html`, `web/js/settings.js`,
   `web/js/format.js`, `web/js/state.js`.
3. **Disclosure & outputs (B+D+F)**: `web/worker.js` (hard-cap flag),
   `web/js/facts.js`, `web/js/queue.js`, `web/js/views.js`/`compare.js`,
   `web/js/save.js` (toast + report), `web/index.html` (footer).
4. **Performance (P1–P4)**: `web/worker.js`, `web/js/engine.js`,
   `web/js/main.js`, `web/js/views.js`, `web/js/render.js`.
5. **Theme & legibility**: `web/js/theme.js` (new), `web/heyoz-tokens.css`,
   `web/css/*.css`.
6. **Verification**: `python -m unittest discover -s tests`; regenerate-and-diff
   `destinations.js`; locate and update the browser harness (referenced from
   `main.js`/`facts.js` comments — assertions on chip order, default floor,
   pool size will need updating to the new copy); manual pass of every changed
   string against the binding constraints.

## CLI notes

- `--lossless` flag → the lossless format set + no resize (mirrors "identical").
- `--for social` arrives automatically via destinations.py.
- README gains the social/lossless rows in its `--for` table.
