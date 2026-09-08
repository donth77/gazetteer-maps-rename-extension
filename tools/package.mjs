/**
 * Builds a release zip for the Chrome Web Store.
 *
 * RELEASE=1 so the build leaves out the dev version stamp, and the zip is made
 * from inside dist/ so manifest.json sits at the root, which is where the
 * store looks for it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const zip = path.resolve(`gazetteer-${version}.zip`);

execFileSync('node', ['build.mjs'], { stdio: 'inherit', env: { ...process.env, RELEASE: '1' } });

const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
if (manifest.version !== version) throw new Error(`manifest ${manifest.version} != package ${version}`);
if (manifest.version_name) throw new Error('version_name is still set; this is not a release build');

if (existsSync(zip)) rmSync(zip);
execFileSync('zip', ['-r', '-q', '-X', zip, '.'], { cwd: 'dist', stdio: 'inherit' });

const bytes = readFileSync(zip).length;
console.log(`${path.basename(zip)}  ${(bytes / 1024).toFixed(0)} KB  (manifest ${manifest.version})`);
