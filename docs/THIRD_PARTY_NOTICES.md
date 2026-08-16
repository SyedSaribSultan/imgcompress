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
| imagequant (pip only — **GPL inside**, see below) | BSD-3-Clause (binding) | palette quantisation |
| zopflipy | Apache-2.0 | PNG recompression |
| mozjpeg-lossless-optimization | BSD-3-Clause | JPEG optimisation |
| pywebview | BSD | the desktop window |
| av (optional `[video]` extra) | BSD-3-Clause (binding) | video decode/encode |

**Known discrepancy — av.** The `av` wheels contain a complete FFmpeg build
that includes GPL x264 and x265; the wheel's BSD label describes the Python
binding, not everything inside it. As a pip dependency this is the accepted
posture and Pocketsize's own licence is unaffected. It is why decision V3
exists (see below).

**Resolved — imagequant is GPL, and is no longer bundled.** The wheel's own
licence text is the binding's (BSD-3-Clause, Wanadev), which is why this
looked permissive for a long time. The compiled `_libimagequant` inside it is
a different thing, and upstream states its terms plainly:

> **Libimagequant** is dual-licensed:
> - For Free/Libre Open Source Software it's available under GPL v3 or later…
> - For use in closed-source software, AppStore distribution, and other
>   non-GPL uses, you can obtain a commercial license.

— [wanadev/imagequant-python](https://github.com/wanadev/imagequant-python),
which vendors [libimagequant at `b075eb0`](https://github.com/ImageOptim/libimagequant/tree/b075eb0aecfdd552adcab30b549feee9d3aacbe6)
as a submodule.

So it is excluded from the installers, exactly like PyAV and for exactly the
same reason: distributing GPL code inside this MIT-licensed bundle would put
the whole bundle under GPL. **The pip path is untouched** — the user's own
package manager fetches the wheel, this project distributes nothing, and
`pip install "pocketsize[full]"` still gets the better quantizer.

The cost was measured before deciding rather than assumed. Dropping it changes
the end-to-end result on the benchmark corpus by **0.5%** (461,500 → 463,830
bytes), because the bake-off almost always ships WebP-lossless or JPEG rather
than PNG-8 anyway. The alarming figure — PNG-8 quality falling from 83.4 to
53.5 on a gradient — is real but applies to a *candidate the engine rejects*.
`Png8Encoder` already falls back to Pillow's quantizer when the import is
absent, so an installer build simply chooses PNG-8 less often.

Enforced in three independent places, because one of them is a YAML file that
only runs on a tag: the PyInstaller `excludes` list, the release gate reading
`pocketsize --check`, and `tests/test_installer_licensing.py`.

## 2. Vendored web assets (redistributed in this repository)

`web/vendor/LICENSES.md` is the authoritative record: every vendored file,
its licence, and the SHA-256 it is pinned to. Summary: mozjpeg (BSD-style),
oxipng (MIT), libwebp (BSD-3-Clause), avif/aom (BSD-2-Clause + AOM patent
grant), Mediabunny (MPL-2.0). Nothing GPL is vendored, and no codec ships
with the page for the video tier - the browser's own WebCodecs does the
encoding, which is also the patent posture.

## 3. Installer bundles (binaries redistributed by us)

The standalone installers bundle the packages from tier 1 **except `av` and
`imagequant`** — the two whose compiled payload is GPL. This is the whole of
the difference between the two ways to get Pocketsize, and it exists for one
reason: *distributing* GPL code inside a shipped binary makes us the
distributor and would put this MIT-licensed bundle under GPL, whereas
depending on it through pip means the user's own package manager fetches it
and we distribute nothing.

- **`av`** — decision V3 in `docs/VIDEO_IMPLEMENTATION_PLAN.md`. The wheel
  carries a complete FFmpeg including GPL x264/x265. Video therefore stays a
  pip extra until either custom LGPL wheels exist (no x264/x265;
  `ae-ffmpeg` is precedent) or the obligations are deliberately accepted.
- **`imagequant`** — libimagequant is GPL v3-or-later for open-source use,
  per upstream. Costs 0.5% end to end to leave out; see §1.

Enforced in three places, because the release gate is YAML that runs only on
a tag and nothing else would notice it being weakened:
`packaging/pocketsize.spec` excludes both from collection; the release gate
fails any bundle whose `--check` reports either as active, *and* fails if
`--check` stops naming them at all; and `tests/test_installer_licensing.py`
checks the first two are still in place on every ordinary test run.

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
