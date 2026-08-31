# Gazetteer

Control what Google Maps calls things.

A Chrome extension that restores place names on Google Maps. Names are **data, not code** —
adding one is a config edit, never a release.

## What it does

Rewrites renamed places wherever they appear: the sidebar, search results, place cards,
autocomplete, `aria-label`/`title` text, the browser tab title — **and the labels painted on
the map itself**. Ships with `Gulf of Mexico` and `Lake Ontario` enabled, so it works on
install without opening settings.

Everything is display-local. Nothing is sent anywhere — no telemetry, no config sync, no
network calls of any kind.

## How the map labels are reached

Google draws map labels with WebGL from glyph atlases, in a Web Worker, fed by WASM.
`fillText` is never called anywhere, so the canvas hook the design doc planned around does not
exist. But the label text does surface as ordinary strings on its way out of WASM, through
`TextDecoder.prototype.decode` inside that worker.

So the extension wraps `Worker` construction from a MAIN-world content script and prepends a
small runtime that patches `TextDecoder`. Two things make that injection survivable, and both
fail *silently* if you skip them — the page renders fine and the hook simply does nothing:

- a `blob:` worker reports the blob as its `location`, and Google's worker parses its own URL,
  so `location` is shadowed with the real one;
- a `blob:` worker resolves relative URLs against the blob, breaking its own WASM fetch, so
  `importScripts`, `fetch` and `XHR` are re-based on the real worker URL.

Labels are also line-broken *before* they reach us — "Gulf of America" arrives as `"Gulf of"`
then `"America"`, a few decodes apart and in either order. `src/core/lines.ts` rewrites only
the line that differs, and only when another line of the same name was decoded in the last few
calls. That gating is what keeps "North America" intact.

Measurement, including the mistakes made getting there, is in
[`docs/M0-spike.md`](docs/M0-spike.md).

Wrapped labels ("Gulf of" / "America" on two lines) work too. Google runs two map workers —
one decodes label lines in reading order and can resolve the name with context, the other
draws the glyphs but often decodes the changed word first, out of context. The context-aware
worker broadcasts its result to the drawing worker, which applies it. Details and the measured
timeline are in [`docs/M0-spike.md`](docs/M0-spike.md).

No flash on load, in either place it could come from. Page text: the DOM hook rewrites
synchronously inside the mutation callback — before the browser paints — and every hook
starts from the shipped name table immediately, so the served name never survives to a paint.
Map surface: while the vector renderer boots, Maps briefly paints server-rendered preview
tiles with the served names baked into the pixels — unreachable by any text hook — so those
tiles are replaced with a gray loading grid (Google's palette, with line geometry measured
from a live slow load) until the real map, whose labels this extension rewrites, takes over. Loading looks like a normal slow load; the first label
you see is the corrected one. Toggleable in Settings, and skipped automatically when WebGL is
unavailable, where the raster tiles are the only map there is.

Some labels are not drawn in the workers at all: on slower machines Maps rasterizes pin
titles on the main thread, so the same decode hook is installed there too, sharing one
resolution store across every context.

### What it still does not do

- Non-Latin or heavily localised names are untested; the shipped table is English only.
- If two renamed places share a wrapped label word (both shipped rules share "America") and
  both are drawn in the same session, a label drawn earlier can briefly show the other
  place's word. The extension detects the collision and self-heals: it cycles the map's
  WebGL context, which makes Maps rebuild its renderer and redraw every label correctly.
  Rate-limited, and skipped when the two places are on screen simultaneously (genuinely
  ambiguous) — the popup warning with a one-tap reload covers that case.
- Because both hooks start from the shipped defaults, a rule you disabled can apply for the
  first few milliseconds after load until your saved config replaces it.

## See it work

```sh
pnpm install
pnpm run build
pnpm run demo
```

That opens a browser with the extension already loaded, on a Maps page, and leaves it open
for you to click around. The sidebar, the tab title and the label out in the water should all
read the restored name.

## Install it in your own Chrome

```sh
pnpm install
pnpm run build          # → dist/
```

`chrome://extensions` → enable **Developer mode** (top right) → **Load unpacked** → select
the `dist/` folder. Then open Google Maps and **reload any tab that was already open** — a
content script only attaches on page load.

Where to look, in order of how obvious it is:

1. The **browser tab title** — the fastest confirmation.
2. The **sidebar** heading and place card after searching for a renamed place.
3. The **map itself** — the label out in the water. Pan or zoom if it looks stale.
4. The **toolbar popup** — a status line for the current tab ("Rewriting page and map",
   with a rewrite count). Green dot means both hooks are working.

If nothing changes, check in this order: the tab was reloaded after install; the URL is a
`google.com/maps` page; the popup's master switch is on; and the popup does not say
"Hook did not install".

## Configure

Click the toolbar icon for quick per-place toggles and live counters, or open **Settings**
for the full editor: add places, edit substitutions per locale, import/export the name table
as JSON, restore defaults.

Each rename is a row:

| Field | Meaning |
|---|---|
| Language | Which display language the rename applies in. "All languages" applies everywhere; English also covers regional variants like en-US. |
| Google shows | The string exactly as Maps renders it. Matched literally and case-sensitively. |
| Show instead | What to display. |

Longer patterns are always tried first, so a dual-label form like `X (Y)` cannot be mangled
into `X (X)` by the bare rule — you do not have to order the table yourself.

Changes apply immediately to newly rendered text. Reload the tab to re-apply them to text
already on screen.

### The search box

On by default: after a search, Maps fills the box with the served name, which otherwise sits
at the top of the screen looking unfixed. The trade, and why the toggle exists: pressing
Enter on a box Maps filled in searches for the *renamed* text. Google resolves the shipped
defaults fine ("Gulf of Mexico" and "Lake Ontario" are searchable), but if you use renames
Google would not recognise, turn this off. The box is never touched while you are typing in
it, and the hook gives up after three attempts if Maps keeps overwriting it.

## Adding a place — any place

Any category of thing on the map renames the same way; this was exercised live across the
whole taxonomy (the rule set is kept as [`test/fixtures/taxonomy.json`](test/fixtures/taxonomy.json)):

| Category | Tested | On the map | In page text |
|---|---|---|---|
| Country | Iceland → Frostheim | ✔ country label | ✔ |
| Territory | Puerto Rico → Borinquen | ✔ (at zooms where Google draws it) | ✔ |
| State | Florida → Sunshine + FLORIDA → SUNSHINE | ✔ region label | ✔ |
| City | Houston → Space City | ✔ city label | ✔ |
| Town | Oswego → Ozville | ✔ | ✔ |
| Street | Broadway → Wideway | ✔ painted along the street | ✔ |
| Landmark | Statue of Liberty → Statue of Freedom | ✔ POI label | ✔ incl. tab title |
| Store | Walgreens → Wellgreens | ✔ POI label | ✔ incl. tab title |

What to know when writing rules:

- **Observe the string, don't guess it.** Match exactly what Maps renders, including case:
  states and regions are painted UPPERCASE on the map but Title Case in the sidebar, so a
  state needs both forms ("Florida" and "FLORIDA").
- **Map labels match exact rendered strings; page text matches substrings.** Renaming
  "Houston" leaves the "South Houston" map label alone but rewrites "South Houston" in
  sidebar text. Add explicit longer-pattern rules if you need different behaviour.
- **Single-word names always work on the map.** Multi-word names where exactly one word
  changes ("Statue of Liberty" → "Statue of Freedom") also work when the label wraps across
  lines. A rename that changes the word count, or more than one word ("Puerto Rico" →
  "Borinquen"), applies to page text and to labels rendered on one line — a wrapped form of
  such a name stays as served.
- Do not guess translations either — per-locale rows exist so each locale's observed string
  gets its own entry.

Add rules in Settings, or edit [`data/names.json`](data/names.json) and rebuild to change
the shipped defaults.

## Development

```sh
pnpm test          # unit tests — deterministic, offline, no dependencies
pnpm run typecheck
pnpm run check     # both of the above; this is the gate
pnpm run watch     # rebuild on change
pnpm run verify    # live check against real Google Maps (see below)
```

Tests run on plain Node via native TypeScript stripping. There is no test framework and no
runtime dependency; `esbuild` and `typescript` are the only devDependencies.

### Testing discipline

Two categories, and they never mix:

- **Gating** — `pnpm run check`. Unit tests over the pure engine. These block merges.
- **Monitoring** — `pnpm run verify`. Loads the built extension into Chrome, opens real Maps,
  and asserts both shipped rules still work. Non-deterministic by nature; it talks to Google
  and can fail for reasons that have nothing to do with this code. **Never put it in a
  blocking CI path** — that is the fastest way to end up disabling it.

Dev builds stamp the manifest's `version_name` with the build time, shown in the popup
footer, so you can always tell whether Chrome has picked up a rebuild. The version itself
only changes at releases; `RELEASE=1 pnpm run build` produces an unstamped build.

`pnpm run verify` needs a *Chrome for Testing* build, because stable Chrome 137+ ignores
`--load-extension`. It finds one in the Playwright browser cache automatically; override with
`CHROME_PATH=…`, and set `HEADED=1` to watch it run.

### Continuous monitoring

Two GitHub Actions workflows watch for breakage:

- **ci** (push/PR): typecheck, unit tests, build. Deterministic; this is the merge gate.
- **daily-health** (daily cron): two independent signals. A GNIS watcher polls the federal
  names database for the tracked features and fails loudly when an official name changes —
  that is the *cause-side* alarm, and it fires days before Google ships the change. A live
  check then loads the built extension against real Google Maps and fails if the hooks
  stopped rewriting. Challenge pages from Google count as infrastructure noise: they warn
  and retry rather than alert, because alert fatigue is what kills self-monitoring.

When a GNIS alert fires: observe the new string Maps renders, add it to
[`data/names.json`](data/names.json), and refresh the baseline in
[`data/gnis-watch.json`](data/gnis-watch.json).

Note that automated access to Maps is contrary to Google's Terms of Service. For an
occasional local check the practical consequence is CAPTCHAs, but make that call knowingly.

## Layout

```
src/core/       engine.ts, rules.ts, lines.ts, counters.ts  ← pure; no DOM, no deps
src/hooks/      dom.ts          sidebar, cards, tab title (ISOLATED)
                worker-inject.ts  wraps Worker construction (MAIN)
                worker-runtime.ts patches TextDecoder inside the worker
src/extension/  manifest.json, background, options/, popup/
data/           names.json                         ← the name table
test/unit/      engine + rules tests               ← the merge gate
tools/          make-icons.mjs, verify-live.mjs
docs/           M0-spike.md                        ← why there is no canvas hook
```

`src/core/` is dependency-free and runs under plain Node. No place name appears anywhere in
`src/` — if a place-name string literal shows up there, that is a bug. The one deliberate
exception is the store description in `manifest.json`, which is listing copy rather than
matching logic; it is specified that way on purpose, so the extension stays discoverable by
the specific cases without the name going stale when those cases shift.

## Languages and accessibility

The extension UI (settings page and popup) ships in English, Spanish, French, German,
Brazilian Portuguese, and Japanese via Chrome's standard `_locales` mechanism; Chrome picks
the catalog matching the browser's UI language, and English is the fallback. Store-listing
text per language is prepared in [`docs/store-listing.md`](docs/store-listing.md).

The settings page and popup are keyboard-first and screen-reader friendly: the language
picker is a proper ARIA combobox (arrow keys, Enter, Escape, `aria-activedescendant`), native
language names carry `lang` attributes so screen readers pronounce them correctly, every
icon-only button and switch has an accessible name, destructive confirmations are real
focus-trapping dialogs, and status updates announce politely via live regions.

## Permissions

`storage`, plus an explicit allowlist of Google Maps hosts. Never `<all_urls>`, no `tabs`,
nothing else.
