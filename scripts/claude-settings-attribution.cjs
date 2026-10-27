#!/usr/bin/env node
'use strict';

// Static attribution of Claude Code client-state (~/.claude.json) keys, keyed by the exact
// host binary hash. A table entry names keys the binary itself treats as routine saved state:
// its global and per-project config savers skip an unlocked fallback write when every changed
// key is in those sets. A class names a source; it never establishes preservation or removes a block.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const TABLE = path.join(ROOT, 'evidence/computer-use-method/claude-settings-attribution/table.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
const escape = text => text.replace(/[$]/g, '\\$');

function unique(text, needle) {
  const at = text.indexOf(needle);
  need(at !== -1, 'attribution_anchor_missing'); need(text.indexOf(needle, at + 1) === -1, 'attribution_anchor_ambiguous');
  return at;
}
// Offsets index the binary's bytes: latin1 decoding maps each byte to one character.
const anchor = (text, start, end) => ({ offset: start, length: end - start, sha256: sha(Buffer.from(text.slice(start, end), 'latin1')) });
function enclosingFunction(text, at, bound = 2000) {
  const start = text.lastIndexOf('function ', at);
  need(start !== -1 && at - start < bound, 'attribution_anchor_missing');
  return { start, name: text.slice(start + 9).match(/^[\w$]+/)?.[0] };
}
function stringSet(text, start, end) {
  const literal = text.slice(start, end);
  need(/^\[(?:"[\w$]+"|\.\.\.\[\])(?:,(?:"[\w$]+"|\.\.\.\[\]))*\]$/.test(literal), 'attribution_set_unparseable');
  const keys = [...literal.matchAll(/"([\w$]+)"/g)].map(match => match[1]);
  need(new Set(keys).size === keys.length, 'attribution_set_unparseable');
  return keys;
}

function extractAnchors(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const saver = (label, testConfig) => {
    const at = unique(text, `"${label}"))return`), { start, name } = enclosingFunction(text, at);
    need(text.slice(start, at).includes(testConfig), 'attribution_saver_unverified');
    return { start, end: at + label.length + 2, name };
  };
  const globalSaver = saver('saveGlobalConfig', 'testGlobalConfig'), projectSaver = saver('saveCurrentProjectConfig', 'testProjectConfig');
  // The routine global set starts with numStartups; the per-project set follows it directly.
  const globalAt = unique(text, '=new Set(["numStartups",'), projectAt = unique(text, '=new Set(["lastCost",');
  const globalName = text.slice(0, globalAt).match(/[\w$]+$/)?.[0], projectName = text.slice(0, projectAt).match(/[\w$]+$/)?.[0];
  need(globalName && projectName && projectAt > globalAt, 'attribution_set_unparseable');
  const globalOpen = globalAt + '=new Set('.length, globalClose = projectAt - projectName.length - 2;
  need(text.slice(globalClose, globalClose + 2) === '),', 'attribution_set_unparseable');
  const projectOpen = projectAt + '=new Set('.length, projectClose = text.indexOf('])', projectOpen) + 1;
  const routineGlobalKeys = stringSet(text, globalOpen, globalClose), routineProjectKeys = stringSet(text, projectOpen, projectClose);
  // Each set must be the one its saver consults before skipping a contended fallback write.
  const globalUse = unique(text, `return ${globalName}.has(r)})}`), projectUse = unique(text, `.every((r)=>${projectName}.has(r))}`);
  const globalCheck = enclosingFunction(text, globalUse), projectCheck = enclosingFunction(text, projectUse, 200);
  need(text.slice(globalCheck.start, globalUse).includes('==="projects"') && text.slice(globalCheck.start, globalUse).includes(projectCheck.name), 'attribution_check_unverified');
  const region = (from, pattern) => { const match = text.slice(from, from + 4000).match(pattern); need(match, 'attribution_check_unverified'); return from + match.index + match[0].length; };
  const globalSkip = region(globalSaver.start, new RegExp(`&&${escape(globalCheck.name)}\\([\\w$]+,[\\w$]+\\)\\)return [\\w$]+\\("save_global"`));
  const projectSkip = region(projectSaver.start, new RegExp(`if\\(${escape(projectCheck.name)}\\([\\w$]+,[\\w$]+\\)\\)\\{[^}]{0,200}"save_project"`));
  const versionAt = unique(text, 'firstStartVersion:{');
  const build = text.slice(versionAt, versionAt + 1200);
  const version = build.match(/VERSION:"(\d+\.\d+\.\d+)"/)?.[1], gitSha = build.match(/GIT_SHA:"([0-9a-f]{40})"/)?.[1];
  need(version && gitSha, 'attribution_build_unidentified');
  return { version, gitSha, routineGlobalKeys, routineProjectKeys, anchors: {
    globalSaver: anchor(text, globalSaver.start, globalSaver.end), projectSaver: anchor(text, projectSaver.start, projectSaver.end),
    routineGlobalKeys: anchor(text, globalOpen, globalClose), routineProjectKeys: anchor(text, projectOpen, projectClose),
    globalContentionSkip: anchor(text, globalSaver.start, globalSkip), projectContentionSkip: anchor(text, projectSaver.start, projectSkip),
    globalCheck: anchor(text, globalCheck.start, globalUse), projectCheck: anchor(text, projectCheck.start, projectUse) } };
}
async function entryFor(binary, io = fs) {
  const bytes = await io.readFile(binary);
  return { claudeExecutableSha256: sha(bytes), size: bytes.length, ...extractAnchors(bytes) };
}

async function loadTable(file = TABLE, io = fs) {
  const bytes = await io.readFile(file), table = JSON.parse(bytes.toString('utf8'));
  need(table?.schemaVersion === 1 && Array.isArray(table.entries) && table.entries.every(entry => /^[a-f0-9]{64}$/.test(entry?.claudeExecutableSha256 ?? '')
    && Array.isArray(entry.routineGlobalKeys) && Array.isArray(entry.routineProjectKeys)), 'attribution_table_invalid');
  return { table, sha256: sha(bytes) };
}
// Project keys are compared as Windows paths; any mismatch stays unclassified.
const projectKey = value => path.win32.resolve(String(value)).replaceAll('\\', '/').toLowerCase();
function classifyChangedPaths(paths, entry, hostWorkspace) {
  const classified = paths.map(item => {
    const result = (kind, reason) => ({ ...item, class: kind, ...(reason ? { reason } : {}) });
    if (!entry) return result('unclassified', 'binary_not_in_table');
    if (item.source !== 'clientState') return result('unclassified', 'source_not_covered');
    if (item.whole || !item.path.length) return result('unclassified', 'whole_source_changed');
    const [key, child, grandchild] = item.path;
    if (key === 'projects') {
      if (item.path.length < 3) return result('unclassified', 'project_entry_unresolved');
      if (!hostWorkspace || projectKey(child) !== projectKey(hostWorkspace)) return result('unclassified', 'other_project');
      return entry.routineProjectKeys.includes(grandchild) ? result('routine_project_key') : result('unclassified', 'project_key_not_routine');
    }
    if (!entry.routineGlobalKeys.includes(key)) return result('unclassified', 'global_key_not_routine');
    // Cached feature and experiment data can change host behavior even when routine.
    return { ...result('routine_global_key'), ...(key.startsWith('cached') ? { featureOrExperimentCache: true } : {}) };
  });
  const count = predicate => classified.filter(predicate).length;
  return { classified, counts: { routineGlobalKeys: count(item => item.class === 'routine_global_key'),
    routineProjectKeys: count(item => item.class === 'routine_project_key'), unclassified: count(item => item.class === 'unclassified'),
    featureOrExperimentCache: count(item => item.featureOrExperimentCache === true) } };
}

async function main(args) {
  const binaries = [], options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--binary') binaries.push(args[++index]);
    else if (args[index] === '--verify') options.verify = args[++index] ?? TABLE;
    else throw fail('usage: claude-settings-attribution.cjs --binary <claude.exe> [--binary ...] [--verify <table.json>]');
  }
  need(binaries.length > 0, 'binary_required');
  const entries = await Promise.all(binaries.map(binary => entryFor(path.resolve(binary))));
  if (!options.verify) return { entries };
  const { table } = await loadTable(path.resolve(options.verify));
  return { verified: entries.map(entry => {
    const listed = table.entries.find(item => item.claudeExecutableSha256 === entry.claudeExecutableSha256);
    const { review, ...extracted } = listed ?? {};
    return { claudeExecutableSha256: entry.claudeExecutableSha256, version: entry.version, listed: !!listed,
      matches: !!listed && JSON.stringify(extracted) === JSON.stringify(entry) };
  }) };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.verified?.some(item => !item.matches)) process.exitCode = 1;
  }).catch(error => { process.stderr.write(JSON.stringify({ code: error.code ?? 'attribution_failed' }) + '\n'); process.exitCode = 1; });
}
module.exports = { TABLE, extractAnchors, entryFor, loadTable, classifyChangedPaths, main };
