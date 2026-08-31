/**
 * GNIS watcher (design doc §8): polls the federal Geographic Names Information
 * System for the features this extension renames, and alarms when an official
 * name changes. This watches the CAUSE rather than the symptom: GNIS changes
 * days before Google ships them, the endpoint has no bot detection, and it is
 * the check most likely to still work when the browser-side hooks break.
 *
 * Exit codes:
 *   0  names match the committed baseline
 *   1  an official name changed: update data/names.json and the baseline
 *   2  infrastructure error (network, 5xx, malformed reply)
 * CI treats 1 and 2 as warnings, never failures; only a broken extension
 * fails the daily run.
 */
import { readFileSync } from 'node:fs';

const SERVICE = 'https://edits.nationalmap.gov/arcgis/rest/services/gaznames/gaznames_postversion/FeatureServer';
const baseline = JSON.parse(readFileSync(new URL('../data/gnis-watch.json', import.meta.url), 'utf8'));

async function arcgis(layer, params) {
  const url = new URL(`${SERVICE}/${layer}/query`);
  for (const [key, value] of Object.entries({ returnGeometry: 'false', f: 'json', ...params })) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { 'user-agent': 'gazetteer-gnis-watch' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.features ?? [];
}

let changed = 0;
let infra = 0;
for (const feature of baseline.features) {
  const label = `gaz_id ${feature.gazId} (${feature.note})`;
  try {
    const names = await arcgis(2, {
      where: `gaz_id = ${feature.gazId} AND gaz_featurenameofficial = 1`,
      outFields: 'gaz_name',
    });
    const official = names.map((f) => f.attributes.gaz_name).sort();
    const records = await arcgis(0, {
      where: `gaz_id = ${feature.gazId}`,
      outFields: 'datelasteditscommitted',
    });
    const lastEdit = Math.max(0, ...records.map((f) => f.attributes.datelasteditscommitted ?? 0));

    if (official.length === 0) {
      console.error(`ALERT ${label}: no official name on record (was "${feature.officialName}")`);
      changed++;
    } else if (!official.includes(feature.officialName)) {
      console.error(`ALERT ${label}: official name is now ${JSON.stringify(official)}, baseline "${feature.officialName}".`);
      console.error(`  Google ships GNIS changes within days: update data/names.json and this baseline.`);
      changed++;
    } else if (feature.lastEditMs && lastEdit > feature.lastEditMs) {
      console.log(`note  ${label}: record edited (${new Date(lastEdit).toISOString().slice(0, 10)}) but the official name is unchanged.`);
    } else {
      console.log(`ok    ${label}: "${feature.officialName}"`);
    }
  } catch (error) {
    console.error(`infra ${label}: ${error.message}`);
    infra++;
  }
}
if (changed > 0) process.exit(1);
if (infra > 0) process.exit(2);
