# Gazetteer

A Chrome extension that lets you decide what Google Maps calls things.

Google renamed the Gulf of Mexico and Lake Ontario. This puts the old names
back, or any name you want, on anything from countries to corner stores.
Renames show up everywhere: sidebar, search results, tab title, and the
labels on the map itself. Display-only. No network requests, no tracking.
Names are settings, not code.

## Install

```sh
pnpm install
pnpm run build
```

Open `chrome://extensions`, turn on Developer mode, click "Load unpacked",
pick `dist/`. Reload any open Maps tabs. Or run `pnpm run demo` to try it in
a throwaway browser first.

## Use

The popup has an on/off switch per place. Settings has the full editor, plus
JSON import/export. Things to know:

- Match names exactly as Maps shows them, case included. States need both
  "Florida" and "FLORIDA".
- Map labels that wrap onto two lines only rename cleanly when a single word
  changes.
- A rename can apply in one language or all of them. The UI itself ships in
  six.
- Search with your names. Type "Gulf of Bananas" and Maps is sent the name
  it knows; the box keeps showing yours.

## How it works

Page text is a DOM observer that rewrites strings before paint. Map labels
are harder: Google draws them with WebGL inside web workers and never calls
a text API you could hook, but the text passes through `TextDecoder` on its
way out of WASM, so the extension injects into those workers and rewrites it
there. Details live in the comments in `src/hooks/`.

While the map loads, Google shows prerendered images that still contain the
old names. The extension hides those behind a replica of Maps' own loading
grid, so the first names you see are yours.

## Development

```sh
pnpm run check    # typecheck + unit tests; gates merges
pnpm run verify   # drives real Google Maps; never gates anything
pnpm run watch    # rebuild on change
```

`verify` needs a Chrome for Testing build (found automatically in the
Playwright cache) and is technically against Google's terms; occasional
local runs mean CAPTCHAs at worst. Dev builds show a build timestamp in the
popup so you know Chrome picked up your rebuild. `RELEASE=1 pnpm run build`
omits it.

## Monitoring

`ci` runs tests and the build on every push. `daily-health` runs once a day
and fails only if the extension stops rewriting live Maps. It also polls the
federal names database and leaves a warning when an official name changes,
which means: update `data/names.json` soon, Google ships the change within
days.

## Permissions

`storage` plus Google Maps domains. Nothing else.

One rule about the code: no place name may appear in `src/`. They all live
in `data/names.json`.
