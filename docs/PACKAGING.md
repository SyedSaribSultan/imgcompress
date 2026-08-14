# Packaging the desktop application

This explains why the build is shaped the way it is. For the commands, see
[packaging/README.md](../packaging/README.md).

The pip path is unchanged and stays unchanged. `pip install "pocketsize[full,app]"`
is the developer's install, the thing CI tests on three operating systems and two
Python versions, and the only supported way to work on the code. What is added
here is a second, parallel way to *ship* it, for the person the README is written
for: a designer on Windows who does not have Python and should not have to care.

---

## The one fact that shapes everything else

Every optional engine is imported like this
(`pocketsize/encoders.py`, `pocketsize/quality.py`):

```python
try:
    import zopfli as _zopfli
    HAVE_ZOPFLI = True
except Exception:
    HAVE_ZOPFLI = False
```

That guard is correct and should stay. It is what lets a plain
`pip install pocketsize` work on a machine with no wheels for anything, and
[CONTRIBUTING.md](../CONTRIBUTING.md) requires it of any new engine.

But it means a frozen build that cannot load an extension module **does not
crash**. It starts, reports the engine inactive, and compresses every image with
weaker built-ins for the rest of the application's life. The palette quantizer
falls back to Pillow's, which on a UI screenshot reached a visual match of 87 in
a *larger* file than libimagequant's 90. PNGs come out about 10% bigger with no
zopfli. Nothing is reported anywhere, because from the code's point of view
nothing went wrong.

There is no user-visible symptom. There is no crash log. There is only a product
that is quietly worse than the one that was tested.

## So `--check` is a release gate, not a diagnostic

`pocketsize --check` prints one line per engine and then `return 0`
(`pocketsize/cli.py`). The zero is right for a diagnostic — a machine without
zopfli is not in an error state — and useless for a release, so
`.github/workflows/release.yml` runs the frozen binary, captures the output, and
parses it. Any `[ ]` fails the build.

This is not a theoretical risk. Removing one line from the spec and rebuilding
produced this, from a real Windows x64 bundle:

```
engines
  [x] imagequant (pngquant engine)
  [ ] zopfli (png recompression)
  [x] mozjpeg (lossless jpeg pass)
  [x] ssimulacra2 (perceptual metric)
```

Exit status: 0. That build would have shipped, installed, launched, compressed
images, and made every PNG about a tenth larger than it should be.

The parser asserts two things, not one: that it understood the report at all, and
that all four engines are named in it. A regex that can match nothing and still
succeed is the third entry in the table of checks-that-checked-nothing in
CONTRIBUTING.md, and a `[ ]` scan over an empty string finds no problems.

A second gate compresses `tests/bench_corpus` with the frozen binary. `--check`
only proves four modules imported; this proves the application works, and it is
the only step that starts a process pool. The comment in
`pocketsize/__init__.py` explains why that matters: a frozen build without
`multiprocessing.freeze_support()` re-launches itself once per worker, and no
single-image test can show it, because `compress_tree` takes a single-process
path when there is one job.

---

## The four things that had to be collected by hand

### `_cffi_backend`, for imagequant and mozjpeg

Both are cffi *out-of-line API* modules. The Python side says
`from ._libimagequant import lib, ffi`, and the real `import _cffi_backend`
happens inside the compiled extension, in C, where PyInstaller's bytecode scanner
cannot see it. Neither package ships a PyInstaller hook, and PyInstaller has no
hook for cffi either.

On Windows this has been working by accident for as long as anyone has tried it:
`pywebview` pulls in `pythonnet`, `pythonnet` imports `cffi`, `cffi` imports
`_cffi_backend`, and the module gets collected for a completely unrelated reason.
On macOS pywebview uses pyobjc and never touches cffi. Two of the four engines
would have died on macOS only — the platform where nobody would have thought to
look, because the Windows build was fine.

Fixed by naming `_cffi_backend` in `hiddenimports`.

### `zopflipy.libs`, for zopfli

zopflipy's Windows wheel is repaired with delvewheel, so `zopfli/__init__.py`
opens with a generated patch:

```python
if os.path.isdir(libs_dir := os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, 'zopflipy.libs'))):
    os.add_dll_directory(libs_dir)
```

Frozen, that directory is not at that relative path. `os.path.isdir` returns
False, the patch silently does nothing, and `_zopfli.pyd` cannot resolve the
MSVCP140 DLL the wheel vendors under a hash-suffixed name. On a developer machine
with the Visual C++ redistributable installed it still fails, because the
extension's import table names `msvcp140-a4c2229b….dll` and `System32` has no
such file.

What made this worth chasing rather than assuming: PyInstaller 6.22 *does* notice
the directory. It records `os.add_dll_directory` calls made while importing and
uses them as extra search paths, so it finds the DLL. It then places it in
`_internal/numpy.libs/`, because numpy vendors a DLL with the same name and
PyInstaller preserves the first directory structure it settled on. So the file is
in the bundle, `zopflipy.libs/` does not exist, the guard no-ops, and zopfli is
inactive — which is exactly the report quoted above.

Fixed with PyInstaller's own `collect_delvewheel_libs_directory("zopfli",
"zopflipy.libs")`, which puts the DLLs where the package's own patch looks for
them. Only zopflipy needs it: imagequant and mozjpeg were not delvewheel-repaired,
and numpy and scipy are handled by hooks that ship with PyInstaller.

### `scipy.ndimage`, for the quality metric

`ssimulacra2` is pure Python and does `from scipy import ndimage` at module level.
It is reachable by the scanner, so it is named in `hiddenimports` for a different
reason: to make the cost visible in the file that pays it. See below.

### pywebview, which came free

`pywebview` registers a `pyinstaller40` entry point and ships a hook that collects
`webview/lib` and `webview/js`. Its backend selection uses real `import` statements
inside functions (`webview/guilib.py`), which PyInstaller's scanner does walk, so
the EdgeChromium and Cocoa backends are found without help. `pythonnet` ships a
hook directory too. Nothing to do, which is worth writing down so nobody adds
hidden imports for it later on the assumption that dynamic dispatch must need
them.

---

## onedir, not onefile

A onefile build is a self-extracting archive: every launch unpacks the whole
payload — around 150 MB — to a temporary directory before the application starts.
For a tool somebody opens to compress six images, that is a multi-second pause
every single time, for nothing. It is also the known-bad shape for macOS
notarisation, because what Apple signs and what actually executes are different
files.

The application is already onedir-safe: `pocketsize/server.py` resolves its
assets as `Path(__file__).resolve().parent / "webui"`, which lands inside
`_internal/pocketsize/` in a onedir bundle, exactly where `collect_data_files`
puts them. Nothing in the application needed changing to be freezable, which is a
credit to it and not an accident — the `freeze_support()` call in
`pocketsize/__init__.py` was already there, with a comment about the fork bomb
it prevents.

## Three builds, and why not fewer

Verified against PyPI metadata for cp313:

| Engine | macOS universal2 | macOS arm64 | macOS x86_64 | Windows x64 | Windows arm64 |
| --- | --- | --- | --- | --- | --- |
| imagequant 1.1.5 | yes | yes | yes | yes | **yes** |
| zopflipy 1.13 | **only** | no | no | yes | **no** |
| mozjpeg 1.3.2 | **no** | yes | yes | yes | **no** |
| ssimulacra2 0.3.0 | pure Python, `py3-none-any` | | | | |

Read the two bold columns:

- **A universal2 macOS build is impossible.** zopflipy ships *only* universal2 and
  mozjpeg ships *no* universal2. One fat build would need somebody to `lipo` two
  single-architecture mozjpeg extensions together by hand, per release. So macOS
  is built twice, on its own runner each time, and each build gets the
  architecture-specific mozjpeg wheel and one half of the fat zopfli wheel.
- **A Windows arm64 build can never be green.** Neither zopflipy nor mozjpeg
  publishes a win_arm64 wheel, so two of the four engines would be inactive and
  the gate would reject it — correctly. Windows on ARM runs the x64 build under
  emulation, which is slower but complete. Shipping a native arm64 build that is
  quietly worse than the emulated one would be the wrong trade.

Python is pinned to 3.13 for the same kind of reason: it is the version with cp313
wheels for all four engines and the version the working environment uses. A
release is the worst possible place for a new interpreter's first outing.

## What scipy costs

Measured in a clean Windows x64 environment with only the declared dependencies:

| | Installed | In the bundle |
| --- | --- | --- |
| scipy + `scipy.libs` | 134 MB | 68 MB |
| everything else | 79 MB | 86 MB |
| **total** | **213 MB** | **154 MB** |

scipy is 63% of the dependency install and 44% of what people download. It is
pulled in for **one call**: `ndimage.gaussian_filter`, in `ssimulacra2`'s own
implementation, invoked from the downsampling step of the metric.

That is 68 MB of shipped bytes for one Gaussian blur.

Three things could be done about it, and none of them are being done here:

1. **Replace the call.** A separable Gaussian blur is a few lines of numpy, and
   numpy is already a hard dependency. The problem is that the call is inside the
   `ssimulacra2` package, not this one, so the fix is either a patch upstream or a
   vendored copy of a metric implementation — and this project's central claim is
   that its numbers match the reference implementation. Vendoring the reference
   in order to shrink a download is the wrong side of that trade unless the
   substitute blur is proven identical to the last decimal, on the whole
   validation corpus, in both directions.
2. **Prune scipy in the spec.** Excluding `scipy.stats`, `scipy.sparse` and the
   rest would recover most of the 68 MB. It is also exactly the kind of change
   whose failure mode is an `ImportError` on somebody else's machine, months
   later, on a code path the gate never touches. If anyone tries it, the gate to
   add first is one that imports every module the metric touches, in the frozen
   bundle, before the size is celebrated.
3. **Ship two builds**, one with the reference metric and one without. This
   halves the download and doubles the number of things that can be wrong, and it
   would mean shipping a build whose quality numbers are not comparable to the
   ones in the README. Not worth it.

Written down here so the next person does not have to rediscover that 68 MB
traces back to one line, and does not delete it in an afternoon without a gate
under it.

## What the gate does not cover

Being explicit about this, because a gate whose limits are unstated gets trusted
for more than it does.

- **AVIF.** `AvifEncoder.available()` reports whether this Pillow can write AVIF,
  but `capabilities()` does not include it, so `--check` never mentions it and the
  gate cannot see it. A release that silently loses the AVIF encoder would be
  green. Every destination that offers AVIF also offers WebP and JPEG, so the
  consequence is a lost format rather than a failure — but it is unmeasured.
- **The window.** Nothing in CI opens `pocketsize-gui`. The gate exercises the
  console command, which shares all of the compression code but none of the
  pywebview path. A build where the window fails to open falls back to the
  browser, prints a line saying so, and would pass every check here.
- **Signing.** Unsigned artifacts are the default and are named `-unsigned`.
  See [packaging/README.md](../packaging/README.md) for what the owner has to buy
  and why neither half can be automated from a repository secret.
- **`webui/favicon.svg` is not in the wheel.** `pyproject.toml` lists
  `webui/*.html`, `webui/*.css` and `webui/fonts/*.woff2` as package data and no
  `*.svg`, so the icon `app.html` links is missing from a pip install and
  therefore from the bundle. Pre-existing, and only visible as a 404 and a
  default tab icon. Noted here because building from the installed distribution
  rather than the source tree is what made it visible at all.

## What the first real release build found

Recorded because it is the kind of thing only a runner can tell you.

`v2.7.0` was tagged, the workflow ran, and **two of the three installers built on
the first attempt**. Windows failed with `You may not specify more than one
script filename.`

`shell: bash` on a Windows runner is Git Bash, and Git Bash rewrites any argument
that looks like a POSIX path before handing it to a native `.exe`.
`/DOutDir=...` looks exactly like one, so Inno Setup received
`C:/Program Files/Git/DOutDir=...` — no longer an option, and now containing
spaces, so it counted several filenames. Fixed with `MSYS_NO_PATHCONV=1` and
`MSYS2_ARG_CONV_EXCL='*'` on that one command. There is no way to hit this
without a Windows runner, because `ISCC.exe` only exists there.

The second run produced all three, and both gates did their job:

| Build | Installer | Engines | A real folder |
| --- | --- | --- | --- |
| `windows-x64` | 49 MB `.exe` | all four active | 3.6 MB → 994.5 KB (73.2%) |
| `macos-arm64` | 47 MB `.dmg` | all four active | 3.6 MB → 994.5 KB (73.2%) |
| `macos-x86_64` | 51 MB `.dmg` | all four active | 3.6 MB → 994.5 KB (73.2%) |

Two things worth taking from that table. Every engine reported active inside the
frozen application, which is the requirement, and it was checked rather than
assumed. And the folder test is the `freeze_support()` fix proven in the place it
matters: a folder means the process pool actually ran, and the build compressed
it instead of launching copies of itself. The three platforms agreed to the byte.

The installers are **unsigned**, which is the one part of this that cannot be
automated from here. See the signing section above.
