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

**Verify before relying — imagequant.** The binding declares BSD-3-Clause;
the underlying libimagequant has changed licence across major versions
(GPLv3-or-commercial in some). The pip posture is fine either way; if an
installer ever bundles it (the current ones do), the exact libimagequant
version inside the pinned wheel should be checked once and the answer
recorded here.

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

Still open for the installers: embedding the bundled packages' full licence
texts into the installer artifacts themselves (a `THIRD-PARTY.txt` beside
the binary). The BSD/MIT/Apache family all require the notice to travel with
the binary; today it travels with the repository. This needs a small
packaging step, not a decision.
