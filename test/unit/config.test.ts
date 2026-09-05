import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal chrome.storage.local stand-in: what config.ts touches, nothing more. */
function fakeChrome(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            store[k] = JSON.parse(JSON.stringify(v)); // storage drops undefined, like JSON
            for (const l of listeners) l({ [k]: { newValue: store[k] } }, 'local');
          }
        },
      },
      onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) },
    },
  };
  (globalThis as { chrome?: unknown }).chrome = chrome;
  return { store };
}

const KEY = 'gazetteer.config';
const good = { id: 'good', enabled: true, substitutions: [{ locale: 'en', from: 'A', to: 'B' }] };

test('nothing stored yields the shipped defaults', async () => {
  fakeChrome();
  const { loadConfig } = await import('../../src/extension/config.ts');
  const config = await loadConfig();
  assert.equal(config.v, 2);
  assert.equal(config.enabled, true);
  assert.equal(config.suppressRasterPreview, true);
  assert.ok(config.rules.length >= 2);
});

test('one damaged stored rule does not empty the table', async () => {
  fakeChrome({ [KEY]: { v: 2, enabled: true, rules: [good, { id: 'broken' }, 'junk', { ...good, id: 'good' }] } });
  const { loadConfig } = await import('../../src/extension/config.ts');
  const config = await loadConfig();
  assert.deepEqual(config.rules.map((r) => r.id), ['good']);
});

test('a v1 config reads with the newer preferences defaulted on', async () => {
  fakeChrome({ [KEY]: { enabled: false, rules: [good] } });
  const { loadConfig } = await import('../../src/extension/config.ts');
  const config = await loadConfig();
  assert.equal(config.v, 1);
  assert.equal(config.enabled, false);
  assert.equal(config.suppressRasterPreview, true);
  assert.deepEqual(config.removedDefaults, []);
  assert.equal(config.rules.length, 1);
});

test('non-string tombstones are dropped', async () => {
  fakeChrome({ [KEY]: { v: 2, rules: [], removedDefaults: ['lake-ontario', 7, null] } });
  const { loadConfig } = await import('../../src/extension/config.ts');
  assert.deepEqual((await loadConfig()).removedDefaults, ['lake-ontario']);
});

test('change listeners get the parsed config and the value exactly as stored', async () => {
  fakeChrome();
  const { loadConfig, onConfigChanged, saveConfig } = await import('../../src/extension/config.ts');
  const seen: unknown[] = [];
  onConfigChanged((config, stored) => seen.push([config.rules.length, stored]));
  const config = await loadConfig();
  config.rules = [good];
  await saveConfig(config);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.length, 1);
  const [count, stored] = seen[0] as [number, { rules: unknown[] }];
  assert.equal(count, 1);
  assert.equal(stored.rules.length, 1);
});
