'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { TABLE, extractAnchors, loadTable, classifyChangedPaths } = require('../scripts/claude-settings-attribution.cjs');

// Synthetic minified shape of the inspected binaries; names differ between builds.
const SETS = 'var Dx=new Set(["numStartups","skillUsage","cachedGrowthBookFeatures",...[],...[]]),Fx=new Set(["lastCost","lastSessionId"]);';
const CHECKS = 'function id(e,n){return[]}function __(e,n){return id(e??{},n??{}).every((r)=>Fx.has(r))}'
  + 'function Lx(e,n){return id(e,n).every((r)=>{if(r==="projects"){return[].every((S)=>__(s[S],h[S]))}return Dx.has(r)})}';
const GLOBAL = 'function ad(e,n){let r=ve();if(cn()){let y=e(r.testGlobalConfig)}if(js(n,"saveGlobalConfig"))return Promise.resolve(!1);'
  + 'try{}catch(R){if(Bn(R)&&!x.cacheDerived&&Lx(P,H))return qs("save_global"),!1}}';
const PROJECT = 'function K_(e,n){let r=ve();if(cn()){let y=e(r.testProjectConfig)}if(js(n,"saveCurrentProjectConfig"))return Promise.resolve(!1);'
  + 'try{}catch(x){if(__(V,Z)){let q=1;if(qs("save_project",q))return}}}';
const BUILD = `firstStartVersion:{VERSION:"2.1.308",GIT_SHA:"${'a'.repeat(40)}"}`;
const binary = (...parts) => Buffer.from(['MZ\0', SETS, CHECKS, GLOBAL, PROJECT, BUILD, ...parts].join('\n'), 'latin1');

test('anchor extraction parses both routine sets and pins each anchor by offset and hash', () => {
  const bytes = binary(), result = extractAnchors(bytes);
  assert.deepEqual(result.routineGlobalKeys, ['numStartups', 'skillUsage', 'cachedGrowthBookFeatures']);
  assert.deepEqual(result.routineProjectKeys, ['lastCost', 'lastSessionId']);
  assert.equal(result.version, '2.1.308'); assert.equal(result.gitSha, 'a'.repeat(40));
  for (const value of Object.values(result.anchors)) {
    assert.equal(value.sha256, createHash('sha256').update(bytes.subarray(value.offset, value.offset + value.length)).digest('hex'));
  }
  const text = bytes.toString('latin1'), slice = name => text.slice(result.anchors[name].offset, result.anchors[name].offset + result.anchors[name].length);
  assert.ok(slice('globalSaver').includes('"saveGlobalConfig"')); assert.ok(slice('projectSaver').includes('"saveCurrentProjectConfig"'));
  assert.ok(slice('globalContentionSkip').endsWith('Lx(P,H))return qs("save_global"'));
  assert.ok(slice('projectContentionSkip').endsWith('"save_project"'));
});

test('anchor extraction fails closed on duplicate, missing or unparseable anchors', () => {
  assert.throws(() => extractAnchors(binary(GLOBAL.replace('function ad', 'function ae'))), { code: 'attribution_anchor_ambiguous' });
  assert.throws(() => extractAnchors(Buffer.from([SETS, CHECKS, PROJECT, BUILD].join('\n'), 'latin1')), { code: 'attribution_anchor_missing' });
  const unparsed = Buffer.from([SETS.replace('"skillUsage"', 'skillUsage'), CHECKS, GLOBAL, PROJECT, BUILD].join('\n'), 'latin1');
  assert.throws(() => extractAnchors(unparsed), { code: 'attribution_set_unparseable' });
  // A saver that never consults the routine check is not evidence of a routine skip.
  const unchecked = Buffer.from([SETS, CHECKS, GLOBAL.replace('Lx(P,H)', 'Other(P,H)'), PROJECT, BUILD].join('\n'), 'latin1');
  assert.throws(() => extractAnchors(unchecked), { code: 'attribution_check_unverified' });
  const unidentified = Buffer.from([SETS, CHECKS, GLOBAL, PROJECT, 'firstStartVersion:{}'].join('\n'), 'latin1');
  assert.throws(() => extractAnchors(unidentified), { code: 'attribution_build_unidentified' });
});

test('classification uses only the exact entry, the host workspace and the routine sets', () => {
  const entry = { routineGlobalKeys: ['numStartups', 'cachedGrowthBookFeatures'], routineProjectKeys: ['lastCost'] };
  const workspace = 'C:\\Temp\\trace-claude-host-1\\workspace';
  const paths = [
    { source: 'clientState', path: ['numStartups'] },
    { source: 'clientState', path: ['cachedGrowthBookFeatures', 'flag'] },
    { source: 'clientState', path: ['unlistedKey'] },
    { source: 'clientState', path: ['projects', 'c:/temp/trace-claude-host-1/workspace', 'lastCost'] },
    { source: 'clientState', path: ['projects', 'C:/Temp/trace-claude-host-1/workspace', 'allowedTools'] },
    { source: 'clientState', path: ['projects', 'C:/Users/owner/other', 'lastCost'] },
    { source: 'clientState', path: ['projects', 'C:/Temp/trace-claude-host-1/workspace'] },
    { source: 'userSettings', path: ['numStartups'] },
    { source: 'clientState', path: [], whole: true },
  ];
  const { classified, counts } = classifyChangedPaths(paths, entry, workspace);
  assert.deepEqual(classified.map(item => item.reason ?? item.class), ['routine_global_key', 'routine_global_key', 'global_key_not_routine',
    'routine_project_key', 'project_key_not_routine', 'other_project', 'project_entry_unresolved', 'source_not_covered', 'whole_source_changed']);
  assert.equal(classified[1].featureOrExperimentCache, true); assert.equal(classified[0].featureOrExperimentCache, undefined);
  assert.deepEqual(counts, { routineGlobalKeys: 2, routineProjectKeys: 1, unclassified: 6, featureOrExperimentCache: 1 });
  assert.ok(classifyChangedPaths(paths, undefined, workspace).classified.every(item => item.reason === 'binary_not_in_table'));
  assert.equal(classifyChangedPaths(paths.slice(3, 4), entry, undefined).classified[0].reason, 'other_project');
});

test('committed table covers the binary of both retained Claude host attempts and keeps review limits', async () => {
  const { table, sha256 } = await loadTable();
  assert.equal(sha256, createHash('sha256').update(await fs.readFile(TABLE)).digest('hex'));
  for (const attempt of ['claude-host-attempt-1', 'claude-host-attempt-2']) {
    const receipt = JSON.parse(await fs.readFile(path.resolve(__dirname, '../evidence/computer-use-method', attempt, 'receipt.json'), 'utf8'));
    assert.ok(table.entries.some(entry => entry.claudeExecutableSha256 === receipt.testedSource.claudeExecutableSha256));
  }
  for (const entry of table.entries) {
    assert.ok(entry.routineGlobalKeys.includes('numStartups') && entry.routineProjectKeys.includes('lastCost'));
    assert.ok(entry.review.limits.some(limit => limit.includes('does not establish')));
  }
  await assert.rejects(loadTable(TABLE, { readFile: async () => Buffer.from('{"schemaVersion":1,"entries":[{}]}') }), { code: 'attribution_table_invalid' });
});
