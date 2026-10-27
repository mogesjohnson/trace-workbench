'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepare, apply, DESTINATIONS } = require('../scripts/sync-computer-skill.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function home(t, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-skill-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
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
    const backup = path.join(directory, copy.backup.slice(2));
    assert.equal(await fs.readFile(backup, 'utf8'), old);
  }
  assert.deepEqual((await prepare(directory)).entries.map(entry => entry.action), ['unchanged', 'unchanged', 'unchanged']);
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
