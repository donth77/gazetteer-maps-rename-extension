# Gazetteer

A Chrome extension that lets you decide what Google Maps calls things.

Google renamed the Gulf of Mexico and Lake Ontario. If you preferred the old
names, this puts them back. If you want Houston to say "Space City", it can do
that too. Renames apply everywhere: the sidebar, search results, the tab
title, and the labels drawn on the map itself.

Everything happens on your screen only. The extension makes no network
requests, collects nothing, and talks to nothing. Names are config, not code:
adding one is an edit in the settings page, never a new release.

## Install

```sh
pnpm install
pnpm run build
```

Open `chrome://extensions`, turn on Developer mode, click "Load unpacked", and
pick the `dist/` folder. Reload any Maps tab that was already open.

Or run `pnpm run demo` to see it working in a throwaway browser first.

## Use

The toolbar popup shows whether renaming is active on the current tab and has
a switch per place. Settings holds the full editor: add a place, give it one
or more renames, export or import the whole table as JSON.

Rules to know when adding your own renames:

| | |
|---|---|
| Match exactly | Write the name exactly as Maps shows it, case included. States are painted UPPERCASE on the map but Title Case in the sidebar, so cover both. |
| One word per rename | Map labels that wrap across two lines can only be fixed when a single word changes ("Statue of Liberty" to "Statue of Freedom" works wrapped; "Puerto Rico" to "Borinquen" works everywhere else). |
| Language column | A rename can apply in every language or just one. Pick from the same list of languages Maps itself offers. |

The search box is a special case. Maps fills it with the old name after a
search, and by default the extension swaps in yours. Searching again will then
search for your name, which finds nothing if you invented it. There's a
settings toggle if you'd rather leave the box alone.

## How it works

Page text is easy: watch the DOM, rewrite matching strings before the browser
paints. The map was the hard part. Google draws map labels with WebGL inside
web workers, fed by WASM, and never calls any text API you could hook. The
text does pass through `TextDecoder` on its way out of WASM though, so the
extension injects itself into those workers and rewrites the strings there.
Details are in the comments of `src/hooks/worker-inject.ts` and
`src/hooks/worker-runtime.ts`.

While the map loads, Google briefly shows prerendered images with the old
names baked into the pixels. Nothing can rewrite an image, so the extension
hides those and shows a copy of Google's own loading grid instead, matched to
Maps' light or dark theme. The first names you see are yours.

## Development

```sh
pnpm test         # unit tests, offline, fast
pnpm run check    # tests plus typecheck; this gates merges
pnpm run watch    # rebuild on change
pnpm run verify   # loads the extension against real Google Maps
```

`verify` talks to Google and can fail for reasons that aren't your fault, so
it never gates a merge. It needs a Chrome for Testing build (stable Chrome
ignores `--load-extension`); it finds one in the Playwright cache on its own.
Automated access to Maps is against Google's terms of service. For occasional
local checks that means CAPTCHAs at worst, but know that going in.

Dev builds stamp the build time into the version shown in the popup, so you
can always tell whether Chrome picked up your rebuild. The version number
itself only changes at releases. `RELEASE=1 pnpm run build` makes a clean
build with no stamp.

## Monitoring

Google will eventually break this. Two GitHub Actions catch it:

- **ci** runs the tests and build on every push.
- **daily-health** runs once a day. It polls the federal names database
  (GNIS) and fails loudly if an official name changes, which happens days
  before Google ships the change. Then it loads the built extension against
  live Maps and fails if the hooks stopped rewriting. CAPTCHA pages count as
  noise, not failures; alerting on infrastructure noise is how monitoring
  dies.

When the GNIS check fires: look at what Maps actually renders, add that
string to `data/names.json`, and update the baseline in
`data/gnis-watch.json`.

## Languages

The UI ships in English, Spanish, French, German, Brazilian Portuguese, and
Japanese. Chrome picks the one matching your browser language. The settings
page works with a keyboard and a screen reader; language names are announced
in their own language.

## Permissions

`storage`, plus Google Maps domains. Nothing else. No tabs, no browsing
history, no `<all_urls>`.

## Layout

```
src/core/       matching engine, pure functions, no browser
src/hooks/      dom.ts (page text), worker-inject.ts + worker-runtime.ts (map)
src/extension/  manifest, settings page, popup
data/           names.json (the rename table), gnis-watch.json (baselines)
tools/          build helpers, demo, live verification, GNIS watcher
docs/           local planning notes, not committed
```

One rule about the code: no place name may appear anywhere in `src/`. Names
live in `data/names.json`. If a place name shows up in source, that's a bug.
