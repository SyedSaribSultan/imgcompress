# PostHog-style reskin — extracted spec and token mapping (2026-08-14)

> **Status: APPLIED 2026-08-15, except D5.** Decisions D1–D4 and D6 shipped:
> the warm eggshell light surfaces and cool blue-charcoal dark ones, the
> orange→yellow accent swap, the 3D button chrome on primary and secondary
> with tertiary left flat, and the Geist family kept with the mono-for-data,
> tabular-numeral and uppercase-micro-label patterns adopted at this project's
> 13px floor rather than PostHog's 12px. It landed the way §0 requires — a
> re-valuing of the existing `--oz-*` tokens inside the existing theme blocks,
> no colour literal outside `web/heyoz-tokens.css` and `web/css/base.css`,
> desktop copies produced by `tools/sync_webui_assets.py` — with
> `tests/test_design_system.py` green in all 27 checks and a contrast audit of
> the new palette passing AA on all twelve text pairs in both themes.
>
> **D5 (two-accent media coding: orange = images, purple = videos) has NOT
> shipped.** It was recommended for "when video ships", and video has now
> shipped on the desktop tier, so it is the one open item in this document.
> Nothing in the CSS defines a video accent today.
>
> Everything below is the gathered information the decisions were made from:
> every value was read from PostHog's open-source repos (posthog/posthog
> `base.scss`, posthog.com `tailwind.config.js` + `global.css`, Lemon UI
> component sources, the brand handbook), not eyeballed from screenshots. Raw
> fetched sources are archived in the session scratchpad (`posthog/`). The
> Base44 mockup the owner supplied is a **visual reference only** — its UX
> (quality slider, bitrate slider, format pickers) contradicts the
> zero-required-decisions constraint and is not adopted.

## 0. How this lands in the repo (mechanics, non-negotiable)

The reskin is a **re-valuing of the existing 373-token `--oz-*` vocabulary**
in `web/heyoz-tokens.css` (plus the named vocabulary in `web/css/base.css`),
under the existing `[data-theme]` blocks. No new colour literals anywhere
else; the desktop app receives its copy via `tools/sync_webui_assets.py`;
`test_design_system.py` continues to enforce all of it. Nothing in the UI
construction rules changes — only the values.

## 1. The palettes (verified hex; HSL is PostHog's ground truth)

PostHog runs two related palettes. The **website** palette is the warm
"eggshell" low-contrast look the owner pointed at; the **product app**
(Lemon UI) palette is slightly cooler in light mode with white cards. The
recommendation below uses the website's warm surfaces with the app's
semantic structure.

### Light mode (warm — every gray is green-warm, never blue; this is the entire "easy on the eyes" secret)

| Role | Value | Maps onto |
| --- | --- | --- |
| Page ground | `#EEEFE9` | `--oz-color-background` |
| Card / raised surface | `#FDFDF8` (site) or `#FFFFFF` (app cards) | `--oz-color-surface-*` / fill-elevated |
| Nested / secondary surface | `#E5E7E0` | secondary fills, hover accents |
| Deepest nested surface | `#D2D3CC`-family steps | tertiary fills |
| Border, default | `#BFC1B7` (site) / `#DBDED4` (app) | `--oz-color-border-primary` |
| Border, hover | darker warm gray `#ABAD9F` | `--oz-color-border-*-hover` (hover darkens the border — never a glow or shadow) |
| Text primary | `#111111` (site) / `#0D0D0D` (app) — used at ~90% opacity | `--oz-color-content-primary` |
| Text secondary | `#65675E` (warm gray-green) | `--oz-color-content-secondary` |
| Text muted | `#9EA096` | `--oz-color-content-tertiary` / placeholder |

Full warm neutral ramp (site `light-1…12`): `#FDFDF8 #EEEFE9 #E5E7E0
#D2D3CC #C8CAC1 #BFC1B7 #B6B7AF #D0D1C9 #73756B #9EA096 #4D4F46 #23251D`.

### Dark mode (cool blue-charcoal — deliberately NOT warm; never white-on-black)

| Role | Value | Maps onto |
| --- | --- | --- |
| Page ground | `#1D1F27` (site) / `#131316` (app) | `--oz-color-background` |
| Card / surface | `#1E1F23` → `#25262B` → `#2D2E37` (site steps) / `#232429` (app cards) | surfaces |
| Border | `#3E424F` (site) / `#2F3037` (app) — ~20% lightness, barely-there | borders; hover `#5E616E` |
| Text primary | `#FAFAFA` (site) / `#E6E6E6` (app) — **never pure white** | content-primary |
| Text secondary | `#AEB3C2` / `#A6A6A6` | content-secondary |
| Text muted | `#626674` | content-tertiary |

### Brand and accents

- Brand CTA red-orange **`#F54E00`** — PostHog's handbook is explicit: this
  is a *brand* colour, **never an error indicator**. Status colours are
  separate: danger `#DB3707`, warning `#F7A501`, success `#388600`
  (light-mode text values; fills at ~10% alpha; dark mode flips to
  desaturated deep fills with `*-400`-class text).
- **The signature dark-mode move: the accent swaps hue.** Light accent =
  orange `#F54E00`; dark accent = yellow `#F9BD2B` (links `#F54E00` →
  `#F1A82C`). Hover = +10% lightness, active = +15%; accent highlight fills
  = accent at 20/14/10% alpha.
- Interaction states are **alpha overlays, not new colours**: hover = black
  2.5–7.5%, active = black 5–10% (white-alpha in dark) via color-mix.
- Secondary accent set (site): orange `#EB9D2A`, yellow `#F7A501`, blue
  `#2F80FA`, purple `#B62AD9`, lilac `#8567FF`, light-purple `#E2D6FF`,
  teal `#29DBBB`, green `#6AA84F`.
- Chart ramp (app, 15 series): `#1D4AFF #621DA6 #42827E #CE0E74 #F14F58
  #7C440E #529A0A #0476FB #FE729E #35416B #41CBC4 #B64B02 #E4A604 #A56EFF
  #30D5C8` → `--oz-color-chart-1…5` takes the first five.
- **Two-accent media coding from the mockup** (orange = images, purple
  `#B62AD9`/lilac = videos) is adoptable and PostHog-palette-native — useful
  the day video ships. Proposed, not decided.

## 2. Typography

- **PostHog's own fonts are unusable**: RoundHog is PolyForm-Strict licensed
  (verified — no commercial use, no distribution) and Matter SQ is a paid
  Displaay licence (and posthog.com no longer even loads it).
- **What PostHog actually falls back to, and what is free**: Inter (OFL,
  bundled in their app), IBM Plex Sans (OFL, their site buttons/nav),
  Source Code Pro / system mono for code.
- **Recommendation: keep the repo's existing Geist + Geist Mono** (already
  self-hosted, OFL, visually in the Inter class) and adopt PostHog's
  *patterns* instead of their faces:
  - **Monospace for all data** — sizes, percentages, scores, counts — with
    `font-variant-numeric: tabular-nums`. This is the single strongest
    PostHog signal in the owner's mockup, and Geist Mono ships today.
  - **Uppercase micro-labels** with ~0.5px letter-spacing for section
    headers ("QUEUE", "PLAN", "MEASURED"). PostHog sets these at 12px; ours
    obey the **13px legibility floor** — the floor wins, per binding
    constraint 4. Body/control text stays 15–16px (PostHog's 14px is
    likewise overridden by our floor).
  - Weight vocabulary: medium 500 / semibold 600; headings bold.
  - Bricolage Grotesque (our display face) stays for the wordmark/hero;
    optional owner swap to a rounder OFL face (Nunito Sans / Onest) if the
    RoundHog flavour is wanted — decision D2.

## 3. Shape and depth

- Radii: **6px** controls (buttons/inputs/chips/tags), **10px** cards/
  panels/modals, 4px small, pill for round badges → mapped onto the existing
  radius tokens.
- **Borders over shadows, always 1px.** Depth comes from surface steps and
  border promotion (default → darker on hover). The only shadows that exist:
  modal elevation and the button chrome below. No glows; inputs signal focus
  by border darkening or a 3px soft alpha ring (black/7.5%), never a glow.
- **The PostHog 3D button** (their most recognizable control): the face sits
  on a 3px hard-edged plate — app version: `box-shadow: 0 3px 0 -1px
  <frame-colour>`; primary chrome border `#B17816`, frame `#EB9D2A` (light)
  / `#926826` (dark); hover lifts ~0.5px, active presses down. Site version:
  two-layer block (shadow `#CD8407`, face `#EB9D2A`, black text) with a
  −4px resting offset. **Adopting this is a visible personality change to
  every button in the product — flagged as decision D3.** The segmented
  control shows selection by the pressed chrome, not a fill.
- Selection/tint pattern everywhere else: tinted fill + 1px accent border +
  accent text — never solid accent fills (the low-contrast selection rule,
  visible throughout the owner's mockup).

## 4. Components (Lemon UI patterns → our central classes)

All of these are re-stylings of existing central classes (`.btn`, `.field`,
`.chips`, …) — no new one-off primitives:

- **Buttons**: primary (filled 3D, subject to D3), secondary (outlined 3D,
  white/dark-surface face), tertiary (flat, transparent, hover = black/7.5%
  overlay) — tertiary is the sidebar/menu pattern. Disabled = opacity .65.
- **Inputs**: 1px border, 6px radius, hover *and* focus darken the border;
  error = danger border. Height aligned to button height.
- **Tags/status pills**: outline style — coloured text + coloured border on
  transparent bg (success/warning/danger per status palette). The mockup's
  DONE/PROCESSING pills follow directly.
- **Tables/facts**: header row uppercase 13px letter-spaced; row borders
  only (1px top); table bg one step off the surface (`#F9FAF7` light /
  `#232429` dark).
- **Toasts/banners**: 1px status border + pale status fill, 6px radius.
- **Focus**: 2px solid accent outline on `:focus-visible` (orange light /
  yellow dark).
- **KPI stat strip, session card, file-card anatomy** from the mockup
  (overlay type badge + status pill + savings-in-green-mono) are adoptable
  compositions for the queue/results — each becomes a central class.

## 5. Motion

PostHog's durations (200ms ease default; 150ms ease-out small elements;
100ms presses; modal 200ms) map onto the **existing** `--oz-duration-*` /
`--oz-ease-*` vocabulary by re-valuing — no second motion vocabulary, per
CONTRIBUTING.md. Layout-property transitions remain banned (our gate);
nothing PostHog does requires them. `prefers-reduced-motion` stays handled
once in the token layer.

## 6. Dark-mode mechanics

PostHog re-binds the same semantic variables under `[theme='dark']` — we
already do exactly this with `[data-theme='dark']`, so the entire reskin is
value substitution inside existing blocks. Carry-overs worth naming:
`color-scheme: light dark` on body; light/dark **parity is a hard rule**
(their screenshots ship in both themes, same data — our
`tests/web/shoot_both.mjs` already does this).

## 7. PostHog principles adopted as review criteria

- Deliberately limited palette; colour guides attention, never decorates.
- Opacity variants over new colours (text 90%, links 95%, hover 100%).
- **No gradients** ("a cliché of generic SaaS design").
- Prefer HSL notation so lightness can tune without shifting tone.
- Brand colour is never an error colour.
- If an element could belong to any SaaS product, it isn't distinctive
  enough (the logo-removal test).

## 8. What is NOT adopted (constraint conflicts, resolved in our favour)

1. PostHog's 12px table headers / 14px body → **13px floor / 15–16px body
   win** (binding constraint 4).
2. The mockup's quality slider, bitrate slider, output-format picker, preset
   grids → **not adopted**; the plan panel stays 3 fields + More choices
   (binding constraint 1; quality is measured, not guessed).
3. The mockup's "re-encodes to WebM in real-time" static promise → the
   engine decides by measurement.
4. PostHog's in-progress "Quill" migration (12px base) → ignored; we spec
   against what ships today.

## 9. Owner decisions (design)

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Surface palette: website warm eggshell (`#EEEFE9`/`#FDFDF8`) vs app-style white cards on `#F3F4F0` | Website warm — it is the "easy on the eyes" look the owner pointed at |
| D2 | Fonts: keep Geist/Geist Mono/Bricolage (zero new files, OFL) vs adopt Inter + IBM Plex Sans (PostHog's real free stack) | Keep Geist family; adopt the mono-for-data + tabular-nums + 13px micro-label patterns |
| D3 | The 3D button chrome: adopt (strong PostHog personality) or keep flat buttons with the new palette | Adopt on primary/secondary only; tertiary stays flat |
| D4 | Accent semantics: single brand accent with orange→yellow dark swap (PostHog's signature) vs current heyoz accent behaviour | Adopt the swap |
| D5 | Two-accent media coding (orange = images, purple = videos) now, or when video ships | When video ships |
| D6 | Brand identity: this reskin makes Pocketsize *PostHog-flavoured*, not PostHog-branded — confirm no PostHog trademarks/illustrations/mascots are imitated | Confirm (palette + patterns only) |

## 10. Order of work (when approved)

1. `web/heyoz-tokens.css` — re-value light + dark blocks (colour, radius,
   duration values); `web/css/base.css` named vocabulary follows.
2. `web/css/*.css` region sheets — component pattern updates (3D button,
   outline tags, border-promotion hovers) using tokens only.
3. `tools/sync_webui_assets.py` — run, commit the desktop copies.
4. `tests/web/verify_tokens.mjs`, `shoot_both.mjs`, full design-system gate
   run; any new gate (e.g. a no-gradient check) observed failing first.
5. SEO landing pages + `docs/` screenshots regenerate last.
