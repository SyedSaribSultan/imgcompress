# Third-party notices

Pocketsize's own source is MIT. Everything else it stands on is listed here,
in three tiers, because the obligations differ by how the code reaches the
person: a pip dependency is fetched by the user's own package manager under
its own licence; a vendored file is redistributed by us and carries its
notice in-repo; a binary bundled into an installer is redistributed by us in
compiled form, which is where licence terms bind hardest.

Licence identifiers below are what each wheel's own metadata declares
(collected with `importlib.metadata` at the versions pinned in CI), except
where a discrepancy is known - those are flagged in bold rather than
repeated, because a notices file that repeats a wheel's optimistic
self-description is worse than none.

## 1. Python dependencies (fetched by pip, not redistributed by us)

| Package | Declared licence | Used for |
| --- | --- | --- |
| pillow | MIT-CMU | image decode/encode |
| numpy | BSD-3-Clause and permissive others | arithmetic |
| scipy | BSD-3-Clause | one gaussian filter in the metric |
| ssimulacra2 | BSD | the perceptual metric |
| imagequant | BSD-3-Clause (binding) | palette quantisation |
| zopflipy | Apache-2.0 | PNG recompression |
| mozjpeg-lossless-optimization | BSD-3-Clause | JPEG optimisation |
| pywebview | BSD | the desktop window |
| av (optional `[video]` extra) | BSD-3-Clause (binding) | video decode/encode |

**Known discrepancy — av.** The `av` wheels contain a complete FFmpeg build
that includes GPL x264 and x265; the wheel's BSD label describes the Python
binding, not everything inside it. As a pip dependency this is the accepted
posture and Pocketsize's own licence is unaffected. It is why decision V3
exists (see below).

**Open question — imagequant.** Checked, and the answer is "the wheel does
not say". `imagequant` 1.1.5 ships `imagequant/_libimagequant.pyd` — the
compiled C library — alongside its Python binding, and the only licence text
in the wheel is the binding's (BSD-3-Clause, Wanadev, 2021). libimagequant
itself has used different terms across its major versions, including
GPLv3-or-commercial, and its own text is not present.

This matters because the installers **do** bundle it. It does not affect the
pip posture, where the user's own package manager fetches the wheel under
whatever terms it carries. Before the next signed release, somebody should
establish which libimagequant version is inside that wheel and under what
licence, and record the answer here. Until then `tools/collect_licences.py`
states the gap in the shipped notices file rather than letting the BSD label
stand for the whole thing.

## 2. Vendored web assets (redistributed in this repository)

`web/vendor/LICENSES.md` is the authoritative record: every vendored file,
its licence, and the SHA-256 it is pinned to. Summary: mozjpeg (BSD-style),
oxipng (MIT), libwebp (BSD-3-Clause), avif/aom (BSD-2-Clause + AOM patent
grant), Mediabunny (MPL-2.0). Nothing GPL is vendored, and no codec ships
with the page for the video tier - the browser's own WebCodecs does the
encoding, which is also the patent posture.

## 3. Installer bundles (binaries redistributed by us)

The standalone installers bundle the packages from tier 1 **except `av`**.
That exclusion is decision V3 in `docs/VIDEO_IMPLEMENTATION_PLAN.md`:
*distributing* GPL x264/x265 inside a shipped binary carries obligations the
pip posture does not, so the installers ship without video until either
custom LGPL wheels exist (no x264/x265; `ae-ffmpeg` is precedent) or the
obligations are deliberately accepted. Enforced twice: `packaging/
pocketsize.spec` excludes `av` from collection, and the release gate fails
any bundle whose `--check` reports PyAV present.

**The notices now travel with the binary.** `tools/collect_licences.py`
gathers the full licence text of every bundled package from the metadata of
the wheels actually installed at build time, and the release workflow writes
the result into the payload each installer packages — `THIRD-PARTY.txt` next
to the executable on Windows, inside `Contents/Resources` on macOS. Generated
rather than hand-kept, because a hand-kept list is a second copy of the
dependency set and would drift the first time one changed.

The step runs with `--strict`, so a bundled package whose wheel yields no
licence text fails the release instead of shipping a notices file that is
quietly missing an entry. At the time of writing all eight recover their full
text.
