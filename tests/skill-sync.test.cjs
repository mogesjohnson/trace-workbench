'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepare, apply, rollback, DESTINATIONS } = require('../scripts/sync-computer-skill.cjs');
const { loadSkillBundle } = require('../src/computer/configuration.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function home(t, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-skill-sync-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative.startsWith('trace-skill-sync-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await fs.writeFile(path.join(directory, relative), content);
  }
  return directory;
}

const old = '---\nname: trace-computer-use\ndescription: old\n---\nold body\n';

test('replaces only owned copies after exact backups and reports unchanged afterwards', async t => {
  const files = Object.fromEntries(DESTINATIONS.map(relative => [`${relative}/SKILL.md`, old]));
  const directory = await home(t, files);
  const planned = await prepare(directory);
  assert.deepEqual(planned.entries.map(entry => entry.action), ['replace', 'replace', 'replace']);
  const result = await apply(directory);
  assert.equal(result.applied, true);
  assert.equal(result.allMatch, true);
  assert.equal(result.copies.length, 3);
  for (const copy of result.copies) {
    assert.equal(copy.priorSha256, hash(Buffer.from(old)));
    assert.equal(copy.installedSha256, planned.sourceSha256);
    const receiptPath = path.join(directory, copy.backup.slice(2));
    const backupRelative = path.relative(directory, path.dirname(receiptPath)).replaceAll(path.sep, '/');
    assert.match(backupRelative, /^\.trace\/skill-backups\/[a-f0-9-]+$/);
    assert.ok(DESTINATIONS.every(discovery => !backupRelative.startsWith(discovery)));
    assert.ok(!backupRelative.startsWith('.agents/skills/') && !backupRelative.startsWith('.claude/skills/') && !backupRelative.startsWith('.grok/skills/'));
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    assert.equal(receipt.schema, 'trace.skill-rollback/1');
    assert.equal(await fs.readFile(path.join(path.dirname(receiptPath), 'files', 'SKILL.md'), 'utf8'), old);
    assert.equal(copy.bundleSha256, planned.sourceBundleSha256);
    for (const [relative, bytes] of planned.bundle.files) assert.deepEqual(await fs.readFile(path.join(directory, copy.path.slice(2), relative)), bytes);
  }
  assert.deepEqual((await prepare(directory)).entries.map(entry => entry.action), ['unchanged', 'unchanged', 'unchanged']);
  assert.deepEqual((await apply(directory)).copies, []);
});

async function source(t, files) {
  const root = await home(t, Object.fromEntries(Object.entries(files).map(([relative, bytes]) => [`skills/trace-computer-use/${relative}`, bytes])));
  await fs.writeFile(path.join(root, 'skills/trace-computer-use/manifest.json'), JSON.stringify({ schema:'trace.skill-bundle/1', name:'trace-computer-use',
    files:Object.fromEntries(Object.entries(files).map(([relative, bytes]) => [relative, hash(Buffer.from(bytes))])) }, null, 2)+'\n');
  return root;
}

test('whole-bundle rollback restores legacy bytes and removes only newly owned references', async t => {
  const directory = await home(t, Object.fromEntries(DESTINATIONS.map(relative => [`${relative}/SKILL.md`, old])));
  const installed = await apply(directory);
  const unrelated = path.join(directory, DESTINATIONS[0], 'personal-note.txt');
  await fs.writeFile(unrelated, 'retain this user content');
  const restored = await rollback(directory, installed);
  assert.equal(restored.applied, true);
  for (const relative of DESTINATIONS) {
    assert.equal(await fs.readFile(path.join(directory, relative, 'SKILL.md'), 'utf8'), old);
    await assert.rejects(fs.access(path.join(directory, relative, 'manifest.json')), { code:'ENOENT' });
    await assert.rejects(fs.access(path.join(directory, relative, 'references/readiness-routing.md')), { code:'ENOENT' });
  }
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'retain this user content');
  assert.equal((await rollback(directory, installed)).applied, true);
});

test('clean manifest upgrade owns removals while preserving unrelated files and exact rollback', async t => {
  const root1 = await source(t, { 'SKILL.md':old+'[Old reference](references/old.md)\n', 'references/old.md':'old reference\r\n' });
  const root2 = await source(t, { 'SKILL.md':old+'[New reference](references/new.md)\n', 'references/new.md':'new reference\n' });
  const directory = await home(t, { [`${DESTINATIONS[0]}/SKILL.md`]:old });
  assert.equal((await apply(directory, { root:root1 })).applied, true);
  const extra = path.join(directory, DESTINATIONS[0], 'references/personal.md');
  await fs.writeFile(extra, 'unowned');
  const update = await apply(directory, { root:root2 });
  assert.equal(update.applied, true);
  assert.equal(update.copies[0].files.find(file => file.path === 'references/old.md').action, 'remove');
  await assert.rejects(fs.access(path.join(directory, DESTINATIONS[0], 'references/old.md')), { code:'ENOENT' });
  assert.equal(await fs.readFile(extra, 'utf8'), 'unowned');
  assert.equal((await rollback(directory, update)).applied, true);
  assert.equal(await fs.readFile(path.join(directory, DESTINATIONS[0], 'references/old.md'), 'utf8'), 'old reference\r\n');
  await assert.rejects(fs.access(path.join(directory, DESTINATIONS[0], 'references/new.md')), { code:'ENOENT' });
  assert.equal(await fs.readFile(extra, 'utf8'), 'unowned');
});

test('local managed edits and newly claimed unowned files block every synchronization copy', async t => {
  const root1 = await source(t, { 'SKILL.md':old });
  const root2 = await source(t, { 'SKILL.md':old+'[Added](references/added.md)\n', 'references/added.md':'new owned file' });
  const directory = await home(t, Object.fromEntries(DESTINATIONS.map(relative => [`${relative}/SKILL.md`, old])));
  assert.equal((await apply(directory, { root:root1 })).applied, true);
  const changed = path.join(directory, DESTINATIONS[0], 'SKILL.md');
  await fs.writeFile(changed, old+'local customization');
  const conflict = await apply(directory, { root:root2 });
  assert.equal(conflict.applied, false);
  assert.equal(conflict.entries[0].reason, 'modified_skill_content');
  assert.equal(await fs.readFile(changed, 'utf8'), old+'local customization');
  await fs.writeFile(changed, old);
  const userFile = path.join(directory, DESTINATIONS[1], 'references/added.md');
  await fs.mkdir(path.dirname(userFile), { recursive:true });
  await fs.writeFile(userFile, 'user owns this path');
  const collision = await apply(directory, { root:root2 });
  assert.equal(collision.applied, false);
  assert.equal(collision.entries[1].reason, 'unmanaged_skill_collision');
  assert.equal(await fs.readFile(userFile, 'utf8'), 'user owns this path');
  assert.equal(await fs.readFile(changed, 'utf8'), old);
});

test('mid-copy failure restores that bundle and all previously synchronized copies', async t => {
  const directory = await home(t, Object.fromEntries(DESTINATIONS.map(relative => [`${relative}/SKILL.md`, old])));
  const result = await apply(directory, { beforeFileWrite:({directory:target,index}) => {
    if (target === path.join(directory, DESTINATIONS[1]) && index === 1) throw Object.assign(new Error('synthetic write failure'), { code:'fixture_failure' });
  } });
  assert.equal(result.applied, false);
  assert.equal(result.error, 'fixture_failure');
  assert.equal(result.bundleRecovery.rollback.applied, true);
  assert.ok(result.rollback.every(item => item.applied));
  for (const relative of DESTINATIONS) {
    assert.equal(await fs.readFile(path.join(directory, relative, 'SKILL.md'), 'utf8'), old);
    await assert.rejects(fs.access(path.join(directory, relative, 'manifest.json')), { code:'ENOENT' });
  }
});

test('rollback preserves a concurrent managed edit and refuses every other bundle write', async t => {
  const directory = await home(t, Object.fromEntries(DESTINATIONS.map(relative => [`${relative}/SKILL.md`, old])));
  const result = await apply(directory);
  const edited = path.join(directory, DESTINATIONS[1], 'references/acceptance.md');
  await fs.writeFile(edited, 'new user edit after install');
  const restored = await rollback(directory, result);
  assert.equal(restored.applied, false);
  assert.equal(restored.conflicts, 1);
  assert.equal(await fs.readFile(edited, 'utf8'), 'new user edit after install');
  assert.deepEqual(await fs.readFile(path.join(directory, DESTINATIONS[0], 'SKILL.md')), (await prepare(directory)).bundle.files.get('SKILL.md'));
});

test('source manifests validate full content, local links, portable paths and hashes before writes', async t => {
  const valid = await source(t, { 'SKILL.md':old+'[Nested](references/a.md)\n', 'references/a.md':'[Entry](../SKILL.md)\n' });
  assert.equal((await loadSkillBundle(path.join(valid, 'skills/trace-computer-use'))).files.size, 3);
  for (const target of ['references/missing.md', '../outside.md', 'file:///private.md', 'C:/private.md', '%2e%2e/outside.md']) {
    const root = await source(t, { 'SKILL.md':old+'[Invalid]('+target+')\n' });
    await assert.rejects(prepare(await home(t, {}), { root }), { code:'invalid_skill_reference' });
  }
  const tampered = await source(t, { 'SKILL.md':old });
  await fs.appendFile(path.join(tampered, 'skills/trace-computer-use/SKILL.md'), 'unrecorded source edit');
  await assert.rejects(loadSkillBundle(path.join(tampered, 'skills/trace-computer-use')), { code:'skill_source_changed' });
  const undeclared = await source(t, { 'SKILL.md':old });
  await fs.writeFile(path.join(undeclared, 'skills/trace-computer-use/unlisted.md'), 'not declared');
  await assert.rejects(loadSkillBundle(path.join(undeclared, 'skills/trace-computer-use')), { code:'invalid_skill_source' });
});

test('a source change after planning prevents synchronization before destination writes', async t => {
  const root = await source(t, { 'SKILL.md':old });
  const directory = await home(t, { [`${DESTINATIONS[0]}/SKILL.md`]:old });
  await assert.rejects(apply(directory, { root, beforeWrite:() => fs.appendFile(path.join(root, 'skills/trace-computer-use/SKILL.md'), 'changed') }), { code:'skill_source_changed' });
  assert.deepEqual(await fs.readdir(path.join(directory, DESTINATIONS[0])), ['SKILL.md']);
});

test('a TRACE-looking name in a foreign document body does not establish legacy ownership', async t => {
  const foreign = '---\nname: foreign-skill\n---\nExample metadata:\nname: trace-computer-use\n';
  const directory = await home(t, { [`${DESTINATIONS[0]}/SKILL.md`]:foreign });
  const result = await apply(directory);
  assert.equal(result.applied, false);
  assert.equal(result.entries[0].reason, 'not_trace_owned');
  assert.equal(await fs.readFile(path.join(directory, DESTINATIONS[0], 'SKILL.md'), 'utf8'), foreign);
});

test('foreign skills, unexpected files and missing copies are never replaced', async t => {
  const directory = await home(t, {
    [`${DESTINATIONS[0]}/SKILL.md`]: '---\nname: someone-else\n---\n',
    [`${DESTINATIONS[1]}/SKILL.md`]: old,
    [`${DESTINATIONS[1]}/notes.txt`]: 'user file',
  });
  const result = await apply(directory);
  assert.equal(result.applied, false);
  assert.deepEqual(result.entries.map(entry => entry.reason ?? entry.action), ['not_trace_owned', 'unexpected_files', 'not_installed']);
  assert.equal(await fs.readFile(path.join(directory, DESTINATIONS[1], 'SKILL.md'), 'utf8'), old);
});
