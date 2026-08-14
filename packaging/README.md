# Packaging

This directory builds the downloadable application: a self-contained folder with
its own Python, Pillow, numpy, scipy and all four optional engines, so somebody
who has never installed Python can double-click an installer and get the same
results a developer gets.

It changes nothing about the developer path. `pip install -e ".[full,app]"` is
still the way to work on this, still the thing CI tests, and still what
[CONTRIBUTING.md](../CONTRIBUTING.md) describes. Nothing in here is imported by
`pocketsize` and nothing in `pocketsize` knows it exists.

For *why* it is built this way — the arch matrix, onedir, the engines that fail
silently — read [docs/PACKAGING.md](../docs/PACKAGING.md). This file is the
instructions.

## What comes out

| Platform | Artifact | Contains |
| --- | --- | --- |
| Windows x64 | `pocketsize-<version>-windows-x64[-unsigned]-setup.exe` | per-user installer, Start-menu entry, optional desktop shortcut |
| macOS arm64 | `pocketsize-<version>-macos-arm64[-unsigned].dmg` | `Pocketsize.app`, drag to Applications |
| macOS x86_64 | `pocketsize-<version>-macos-x86_64[-unsigned].dmg` | the same, for Intel Macs |

Every artifact holds two programs. `pocketsize-gui` is the window; `pocketsize`
is the console command, and it is the one CI interrogates. On Windows both sit in
the install directory. On macOS the console command is inside the bundle at
`Pocketsize.app/Contents/MacOS/pocketsize`.

Until signing is sorted out (see below) `-unsigned` appears in every filename.
That is deliberate and it is load-bearing: an unsigned installer should not be
able to acquire a filename that suggests otherwise. The word is added or omitted
once, before anything is named, from whether the signing credentials exist — so
the name and the signature cannot disagree.

## Building it yourself

You need Python 3.13 — not 3.12, not 3.14. That is the version with wheels for
all four engines and the version the release builds with.

```bash
python -m pip install ".[full,app]" pyinstaller
pyinstaller --clean --noconfirm packaging/pocketsize.spec
```

Note the missing `-e`. The spec builds from the installed distribution rather
than from the working tree, and it stops with an error if the package is not
installed. Building from the tree would hide a mistake in the package-data list
in `pyproject.toml` until somebody pip-installed a release.

Then check the result the same way CI does:

```bash
# Windows
dist/pocketsize/pocketsize.exe --check
dist/pocketsize/pocketsize.exe tests/bench_corpus -o /tmp/out

# macOS
"dist/Pocketsize.app/Contents/MacOS/pocketsize" --check
"dist/Pocketsize.app/Contents/MacOS/pocketsize" tests/bench_corpus -o /tmp/out
```

`--check` must print `[x]` on all four lines. Anything else means an engine did
not make it in, the application is quietly compressing worse than it should, and
the build is not shippable. A build takes a couple of minutes; compressing the
corpus takes about six, because that is a real quality search over a 12 MP
photograph.

## What the release workflow does

`.github/workflows/release.yml` runs on a `v*` tag and, per platform: installs,
builds, then **gates**. It reads the output of `pocketsize --check` from the
frozen binary and fails the release if any engine is inactive; compresses the
benchmark corpus with the frozen binary and fails if the file count is wrong;
and confirms the architecture is the one the filename claims. Only then does it
wrap the build into an installer, and it publishes to a **draft** release that a
person has to look at and promote.

The gate parses the report rather than trusting the exit status, because
`--check` returns 0 whether or not everything is present. That is the correct
behaviour for a diagnostic and useless for a gate.

## What only the owner can do

Signing cannot be automated from this repository. Both halves need paid accounts
and credentials that belong to a person, and neither can be faked. The workflow
therefore builds and gates unsigned artifacts, with the signing steps present,
skipped unless the credentials exist, and marked in the file as never having run.

### Windows

Since June 2023 the CA/Browser Forum has required the private key for an OV
code-signing certificate to live on FIPS 140-2 Level 2 (or Common Criteria
EAL4+) hardware. A `.pfx` file in a repository secret is no longer a thing that
exists. The realistic routes, all of which need the owner's identity documents
and a company or sole-trader registration:

| Route | Roughly | Notes |
| --- | --- | --- |
| Azure Trusted Signing | a few dollars a month plus per-signature | cheapest; needs an Azure subscription and a verified identity. Uses `signtool` with Microsoft's key-store library, not the command in the workflow |
| Certificate in Azure Key Vault (HSM-backed) | certificate cost plus Key Vault | what the workflow is currently written against, via `AzureSignTool` |
| DigiCert KeyLocker / SSL.com eSigner | a few hundred a year | cloud signing service with its own CLI |
| A physical token (YubiKey / eToken) | a few hundred a year | cannot be used from CI at all; signing becomes a manual step on the owner's machine |

Secrets the current step expects: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`, `AZURE_KEY_VAULT_URL`, `AZURE_KEY_VAULT_CERTIFICATE`.
`AZURE_CLIENT_ID` is the one whose presence flips the build into signed mode, so
add it last.

Note what signing does and does not buy. A brand-new OV certificate has no
SmartScreen reputation, so the first few hundred downloads may still show a
warning; reputation accrues per certificate and per publisher. Only an EV
certificate starts with reputation, and it costs several times more.

### macOS

Two separate things, both needed:

1. **A Developer ID Application certificate**, which requires an Apple Developer
   Program membership (99 USD a year). This is what `codesign` uses. A free
   Apple ID cannot issue one.
2. **Notarisation** — uploading the signed artifact to Apple, who scan it and
   return a ticket that gets stapled into the disk image. Without it, Gatekeeper
   on a machine that has never seen the app refuses to open it, and the
   right-click-Open trick has been getting steadily harder to find since
   macOS 15.

Secrets the current steps expect: `MACOS_CERTIFICATE_P12` (the exported
certificate and key, base64), `MACOS_CERTIFICATE_PASSWORD`,
`MACOS_SIGNING_IDENTITY` (for example `Developer ID Application: Name (TEAMID)`),
`APPLE_ID`, `APPLE_APP_PASSWORD` (an app-specific password, not the account
password) and `APPLE_TEAM_ID`. `MACOS_CERTIFICATE_P12` is the one that flips the
build into signed mode.

Expect to debug the first notarisation. A PyInstaller bundle is hundreds of
individual Mach-O files and Apple checks all of them. If the rejection mentions
executable memory or JIT, write an entitlements plist and point the build at it
with `POCKETSIZE_ENTITLEMENTS` — the spec already reads that variable and
passes it through — rather than dropping the hardened runtime, which would make
notarisation impossible instead of merely annoying.

## Things to check first when it breaks

- **The job never starts.** Runner labels for Intel macOS have changed before and
  will change again. `macos-15-intel` is the current one; if it has been retired,
  that is the line to fix, and dropping the x86_64 build is a product decision,
  not a build fix.
- **`--check` reports one engine missing.** Nothing about the application is
  broken; one shared library did not get collected. `docs/PACKAGING.md` has the
  known causes, one per engine.
- **The build is enormous.** `dist/pocketsize` measured 154 MB on Windows x64 in
  an environment holding only the declared dependencies; the installer that wraps
  it is compressed and smaller again. The same spec, built from a general-purpose
  Python install that also had torch, transformers and a few machine-learning
  libraries in it, came out at 1.5 GB — PyInstaller collects what it can reach,
  and hooks fire for packages you did not know were installed. Build in a fresh
  virtual environment. The release does.
- **`AppId` in the generated Inno Setup script.** Never change it. It is how
  Windows recognises one version as an upgrade of another; a new value turns
  every future release into a second, parallel installation.
