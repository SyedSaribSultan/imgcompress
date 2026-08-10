# -*- mode: python -*-
"""PyInstaller spec for the desktop build.

One onedir bundle, two executables: `imgcompress`, the console command, and
`imgcompress-gui`, the windowed app that the installer puts in the Start menu or
in /Applications. They share one copy of Python, Pillow, numpy, scipy and the
four optional engines, which is the entire reason they live in the same bundle -
the payload is around 250 MB and building it twice would double every download.

Read docs/PACKAGING.md before changing anything here. Every collection rule
below exists because of a specific engine that goes *quiet* rather than crashing
when it cannot load, and a build that compresses images with weaker built-ins
looks exactly like a working one. That is also why `imgcompress --check` is a
release gate in .github/workflows/release.yml rather than a diagnostic anyone is
expected to read.

Build it from an installed package, not from the source tree:

    python -m pip install ".[full,app]" pyinstaller
    pyinstaller --clean --noconfirm packaging/imgcompress.spec
"""

# PyInstaller execs this file with Analysis, PYZ, EXE, COLLECT, BUNDLE, SPECPATH
# and workpath already bound in the namespace, so to a linter reading it as an
# ordinary module they are all undefined names. Silenced once here rather than
# eight times inline.
# ruff: noqa: F821

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_delvewheel_libs_directory,
)

REPO = Path(SPECPATH).resolve().parent

IS_MACOS = sys.platform == "darwin"

# The name people see. gui.py already titles the window this, so the .app, the
# Start menu entry and the window agree without anybody retyping the string.
APP_NAME = "Image Compressor"
BUNDLE_ID = "com.heyoz.imgcompress"

# One 512px source for both platforms. PyInstaller converts it to .ico or .icns
# with Pillow, which is a build dependency anyway. The obvious-looking
# alternative, web/favicon.ico, is 16x16 only - it would give the installed
# application a blurred smudge everywhere Windows asks for 48px or 256px.
ICON = REPO / "web" / "icon-512.png"

# Signing is handled outside PyInstaller on Windows and can be handled either
# way on macOS; see packaging/README.md. When the identity is absent these stay
# None and PyInstaller falls back to the ad-hoc signature that arm64 macOS
# requires just to execute, which is not the same thing as a signed app.
CODESIGN_IDENTITY = os.environ.get("IMGCOMPRESS_CODESIGN_IDENTITY") or None
ENTITLEMENTS_FILE = os.environ.get("IMGCOMPRESS_ENTITLEMENTS") or None


# --------------------------------------------------------------------------- #
# entry scripts
# --------------------------------------------------------------------------- #

# Neither imgcompress/cli.py nor imgcompress/gui.py can be handed to Analysis
# directly: PyInstaller runs the entry script as `__main__`, and both files
# start with relative imports (`from . import __version__`), which fail outside
# their package. So the two three-line shims are generated into the build
# directory instead of being committed. They are build output, not source -
# there is nothing in them to review or to keep in step with anything, and a
# committed copy would be one more file that can drift.
#
# `import imgcompress` is what runs multiprocessing.freeze_support() - see the
# comment in imgcompress/__init__.py, which describes what a frozen build does
# to a ProcessPoolExecutor without it. Both shims reach it on their first line.

CLI_ENTRY_NAME = "imgcompress_cli_entry"
GUI_ENTRY_NAME = "imgcompress_gui_entry"


def _write_entry_shim(name, module):
    """Write a shim that calls `module.main()` and return its path."""
    directory = Path(workpath) / "entry"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.py"
    path.write_text(
        "import sys\n"
        f"from {module} import main\n"
        "sys.exit(main())\n",
        encoding="utf-8",
    )
    return str(path)


cli_entry = _write_entry_shim(CLI_ENTRY_NAME, "imgcompress.cli")
gui_entry = _write_entry_shim(GUI_ENTRY_NAME, "imgcompress.gui")


# --------------------------------------------------------------------------- #
# what has to be collected by hand
# --------------------------------------------------------------------------- #

# The desktop UI: one HTML file, the design system copied from web/, and the
# faces. server.py resolves them as Path(__file__).resolve().parent / "webui",
# which in a onedir build lands inside _internal/imgcompress/ - exactly where
# collect_data_files puts them. (This is also why onefile is not an option; see
# docs/PACKAGING.md.) Collected wholesale rather than by extension so that
# adding an icon or a face to webui/ never needs an edit here.
datas = collect_data_files("imgcompress")

binaries = []

# zopflipy's wheel is delvewheel-repaired: zopfli/__init__.py runs
# os.add_dll_directory(<parent>/zopflipy.libs), guarded by os.path.isdir. In a
# frozen build that directory is not at that relative path, so the guard quietly
# does nothing, and _zopfli.pyd then cannot resolve the vendored MSVCP140 DLL.
# The result is not a crash: encoders.py catches the ImportError, sets
# HAVE_ZOPFLI = False, and every PNG ships about 10% larger than it should. It
# loads on any developer machine that has the VC++ redistributable and fails on
# a clean Windows install, which is the machine this whole exercise is for.
#
# So the directory is collected under its own name, one level above the package,
# where the patch already looks for it. PyInstaller's own numpy hook solves the
# same problem by dumping the DLLs into the bundle root and relying on the
# bootloader having put that on the search path; putting them where the package
# itself looks does not depend on bootloader behaviour, and keeps working if a
# later zopflipy version vendors a different set of libraries.
#
# A no-op off Windows, so it needs no guard. Only zopflipy needs this - neither
# imagequant nor mozjpeg-lossless-optimization was delvewheel-repaired, and
# numpy and scipy are handled by hooks that ship with PyInstaller.
datas, binaries = collect_delvewheel_libs_directory(
    "zopfli", "zopflipy.libs", datas=datas, binaries=binaries
)

hiddenimports = [
    # imagequant and mozjpeg-lossless-optimization are cffi out-of-line API
    # modules: the Python side does `from ._libimagequant import lib, ffi`, and
    # the real `import _cffi_backend` happens inside the compiled extension,
    # where PyInstaller's bytecode scan cannot see it. Neither package ships a
    # PyInstaller hook, and PyInstaller has none for cffi either.
    #
    # On Windows this has been working by accident: pywebview pulls in pythonnet,
    # pythonnet imports cffi, and cffi imports _cffi_backend, so the module gets
    # collected for an unrelated reason. On macOS pywebview uses pyobjc and never
    # touches cffi - so without this line both engines die silently there, the
    # palette quantizer falls back to Pillow's (which scored 87 against
    # libimagequant's 90 in a *larger* file) and the mozjpeg pass disappears.
    "_cffi_backend",
    # The four engines are all imported inside `try: ... except Exception:` in
    # encoders.py and quality.py, so a build that fails to collect one produces
    # a working application rather than an error. Naming them here does not by
    # itself make the build fail - PyInstaller only warns about a hidden import
    # it cannot find - which is precisely why the release workflow runs
    # `imgcompress --check` against the built binary and reads the answer.
    "imagequant",
    "mozjpeg_lossless_optimization",
    "zopfli",
    "ssimulacra2",
    # ssimulacra2 is pure Python and reaches scipy through `from scipy import
    # ndimage` for a single gaussian_filter call. Stated explicitly because that
    # one import is what makes 134 MB of scipy a hard requirement of the metric,
    # and someone reading this list should see the cost rather than discover it.
    "scipy.ndimage",
]

excludes = [
    # GitHub's runner images carry more than a developer's laptop does, and
    # pywebview's backend selection imports whichever of these it finds. On
    # Windows it uses EdgeChromium via pythonnet and on macOS it uses pyobjc;
    # a Qt or GTK binding that happens to be installed on the runner would be
    # collected for a backend the shipped app never selects.
    "PyQt5",
    "PyQt6",
    "PySide2",
    "PySide6",
    "gi",
    # Nothing here draws with Tk. Pillow's own hook already excludes it, but
    # this build also pulls in scipy and pywebview, and the exclusion should
    # not depend on which package happened to be analysed first.
    "tkinter",
]

a = Analysis(
    [cli_entry, gui_entry],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)

# Analysis returns the runtime hooks and the entry scripts in one list, and each
# executable has to be given exactly one entry script plus all of the hooks. If
# the filter below silently matched nothing, both executables would embed both
# entry scripts and run them in sequence: `imgcompress --check` would print the
# engine report and then open an application window. That is a defect you find
# by launching the artifact, not by reading a build log, so the names are
# asserted here instead.
ENTRY_NAMES = {CLI_ENTRY_NAME, GUI_ENTRY_NAME}
_analysed = {name for name, _path, _kind in a.scripts}
_missing = sorted(ENTRY_NAMES - _analysed)
if _missing:
    raise SystemExit(
        "imgcompress.spec: PyInstaller did not name the entry scripts as "
        f"expected - {_missing} not found in {sorted(_analysed)}. The two "
        "executables are separated by matching those names, so this build "
        "would have produced two identical programs. Fix the filter, do not "
        "delete the check."
    )

# The application's own modules have to be in the archive, and PyInstaller only
# *warns* when they are not: the build succeeds, and both executables die on
# their second line with ModuleNotFoundError: No module named 'imgcompress.cli'.
# That is what happens when the spec is run without the package installed -
# `collect_data_files` finds it through the working directory and copies webui/
# in, while the module graph, which searches the spec's own directory, does not
# find a thing. Building against the installed distribution rather than the
# source tree is deliberate: it means a missing entry in the package-data list
# in pyproject.toml fails a release instead of shipping an app with no interface.
REQUIRED_MODULES = ("imgcompress", "imgcompress.cli", "imgcompress.gui", "imgcompress.server")
_collected = {name for name, _path, _kind in a.pure}
_absent = [name for name in REQUIRED_MODULES if name not in _collected]
if _absent:
    raise SystemExit(
        f"imgcompress.spec: {_absent} did not make it into the archive. "
        "Install the package into the environment you are building from:\n"
        '    python -m pip install ".[full,app]"'
    )


def _scripts_for(entry_name):
    """The runtime hooks plus one entry script, in the order Analysis gave."""
    return [item for item in a.scripts if item[0] not in ENTRY_NAMES or item[0] == entry_name]


pyz = PYZ(a.pure)

# strip=False on purpose: stripping a Mach-O binary invalidates the code
# signature that has to survive notarisation. upx=False on purpose too - a
# UPX-compressed DLL cannot be signature-verified and reliably trips antivirus
# heuristics, which is the opposite of what signing the installer is for.
_exe_common = {
    "exclude_binaries": True,
    "debug": False,
    "bootloader_ignore_signals": False,
    "strip": False,
    "upx": False,
    "disable_windowed_traceback": False,
    "argv_emulation": False,
    # Never "universal2". zopflipy ships a universal2 macOS wheel but
    # mozjpeg-lossless-optimization ships x86_64 and arm64 separately and no
    # universal2 at all, so a fat build would need a hand-lipo'd engine that
    # nobody publishes. None follows the interpreter, and the release workflow
    # builds arm64 and x86_64 on their own runners.
    "target_arch": None,
    "codesign_identity": CODESIGN_IDENTITY,
    "entitlements_file": ENTITLEMENTS_FILE,
    "icon": str(ICON),
}

cli_exe = EXE(
    pyz,
    _scripts_for(CLI_ENTRY_NAME),
    [],
    name="imgcompress",
    # A console executable, and not only so people can read the output: a
    # windowed build has no stdout on Windows, so `imgcompress --check | ...`
    # would hand the release gate an empty string to parse and pass.
    console=True,
    **_exe_common,
)

gui_exe = EXE(
    pyz,
    _scripts_for(GUI_ENTRY_NAME),
    [],
    name="imgcompress-gui",
    console=False,
    **_exe_common,
)

# The windowed executable is passed last on purpose. COLLECT copies `console`
# from the last EXE it is handed and BUNDLE inherits it from the COLLECT, and a
# BUNDLE that thinks it is a console app writes LSBackgroundOnly=True into
# Info.plist - an .app that launches with no window and no dock icon, which is
# a bug you only find by shipping it. The Info.plist keys below say the same
# thing a second time, explicitly, because one ordering-dependent line is a
# thin thing to hang the app's ability to appear on.
coll = COLLECT(
    cli_exe,
    gui_exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="imgcompress",
)

if IS_MACOS:
    # BUNDLE takes the app's main executable from the first EXECUTABLE entry it
    # sees, and COLLECT sorts its own contents alphabetically - so the windowed
    # executable is handed over directly rather than left to depend on how two
    # filenames happen to sort. The console `imgcompress` still ships inside the
    # bundle, at Contents/MacOS/imgcompress, which is what the release gate runs
    # and what somebody can symlink onto their PATH.
    app = BUNDLE(
        gui_exe,
        coll,
        name=f"{APP_NAME}.app",
        icon=str(ICON),
        bundle_identifier=BUNDLE_ID,
        version=os.environ.get("IMGCOMPRESS_VERSION", "0.0.0"),
        info_plist={
            "CFBundleName": APP_NAME,
            "CFBundleDisplayName": APP_NAME,
            "LSBackgroundOnly": False,
            "NSHighResolutionCapable": True,
            # The app is a compressor with a local server on 127.0.0.1. It has
            # no reason to reach the internet and saying so keeps the hardened
            # runtime honest.
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
            # Apple silicon only ships 11.0 and later, and the x86_64 build has
            # no reason to promise anything older than the SDK it was made with.
            "LSMinimumSystemVersion": "11.0",
        },
    )
