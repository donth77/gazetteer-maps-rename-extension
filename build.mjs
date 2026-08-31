import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR ?? 'dist';
const watch = process.argv.includes('--watch');

const ENTRIES = {
  content: 'src/extension/content.ts',
  background: 'src/extension/background.ts',
  'main-world': 'src/extension/main-world.ts',
  options: 'src/extension/options/options.ts',
  popup: 'src/extension/popup/popup.ts',
};

/**
 * The in-worker runtime is injected as source text, not loaded as a file, so it
 * is bundled on its own first and then inlined into the MAIN-world script.
 */
async function buildWorkerRuntime() {
  const result = await esbuild.build({
    entryPoints: ['src/hooks/worker-runtime.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['chrome110'],
    platform: 'browser',
    minify: !watch,
    legalComments: 'none',
    define: { __GZ_DEBUG__: process.env.GZ_DEBUG ? 'true' : 'false' },
  });
  return result.outputFiles[0].text;
}

/** Static files copied verbatim into dist, flattened next to their bundles. */
const STATIC = [
  ['src/extension/manifest.json', 'manifest.json'],
  ['src/extension/options/options.html', 'options.html'],
  ['src/extension/options/options.css', 'options.css'],
  ['src/extension/popup/popup.html', 'popup.html'],
  ['src/extension/popup/popup.css', 'popup.css'],
];

async function copyStatic() {
  for (const [from, to] of STATIC) {
    await mkdir(path.dirname(path.join(OUT, to)), { recursive: true });
    await cp(from, path.join(OUT, to));
  }
  if (existsSync('_locales')) {
    await cp('_locales', path.join(OUT, '_locales'), { recursive: true });
  }
  if (existsSync('assets/icons')) {
    await cp('assets/icons', path.join(OUT, 'icons'), { recursive: true });
    // The options page lives at dist/options.html and references icons/ relatively.
  }
}

/**
 * Keep manifest version and package version from drifting apart, and stamp
 * dev builds. The version only changes at actual releases; the stamp changes
 * every build, so "did Chrome pick up my rebuild" is answerable from the
 * popup without burning version numbers. RELEASE=1 builds carry no stamp.
 */
async function checkVersions() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = pkg.version;
  if (process.env.RELEASE) {
    delete manifest.version_name;
  } else {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;
    manifest.version_name = `${pkg.version} dev ${stamp}`;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const options = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  platform: 'browser',
  logLevel: 'info',
  legalComments: 'none',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await copyStatic();

  const runtime = await buildWorkerRuntime();
  options.define = { __WORKER_RUNTIME__: JSON.stringify(runtime) };

  const builds = Object.entries(ENTRIES).map(([name, entry]) =>
    esbuild.context({ ...options, entryPoints: [entry], outfile: path.join(OUT, `${name}.js`) }),
  );
  const contexts = await Promise.all(builds);

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching…');
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    await checkVersions();
    console.log(`built → ${OUT}/`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
