"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const toml = require("smol-toml");

const ROOT = path.resolve(__dirname, "..", "..");
const SERVER_NAME = "trace-computer";
const SKILL_NAME = "trace-computer-use";
const MANIFEST = "manifest.json";
const BUNDLE_SCHEMA = "trace.skill-bundle/1";
const SKILL_DESTINATIONS = Object.freeze([`.agents/skills/${SKILL_NAME}`, `.claude/skills/${SKILL_NAME}`, `.grok/skills/${SKILL_NAME}`]);
const SKILL_BACKUPS = ".trace/skill-backups";
const CLIENTS = Object.freeze({
  codex: { path: ".codex/config.toml", format: "toml", table: "mcp_servers" },
  claude_code: { path: ".claude.json", format: "json", table: "mcpServers" },
  grok_build: { path: ".grok/config.toml", format: "toml", table: "mcp_servers" },
  gemini_cli: { path: ".gemini/settings.json", format: "json", table: "mcpServers" },
});

const failure = (code, message) => Object.assign(new Error(message), { code });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function traceSkill(bytes) {
  const frontmatter = bytes.toString("utf8").match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return false;
  const names = [...frontmatter.matchAll(/^name:\s*([^\r\n]+)\r?$/gm)];
  return names.length === 1 && /^(?:trace-computer-use|"trace-computer-use"|'trace-computer-use')$/.test(names[0][1].trim());
}

// smol-toml deliberately returns null-prototype records. Compare their values
// against generated records without discarding TOML date value semantics.
function equalValue(left, right) {
  function records(value) {
    if (Array.isArray(value)) return value.map(records);
    if (value && typeof value === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, records(child)]));
    }
    return value;
  }
  return isDeepStrictEqual(records(left), records(right));
}

function optionsFor(options = {}) {
  const clients = options.clients ?? Object.keys(CLIENTS);
  if (!Array.isArray(clients) || !clients.length || clients.some((client) => !Object.hasOwn(CLIENTS, client))) {
    throw failure("invalid_client", "Choose codex, claude_code, grok_build, or gemini_cli.");
  }
  const root = path.resolve(options.root ?? ROOT);
  return {
    home: path.resolve(options.home ?? os.homedir()), root,
    clients: [...new Set(clients)],
    entry: { command: options.nodeExecutable ?? process.execPath, args: [path.join(root, "bin", "trace.cjs"), "computer", "mcp"] },
    source: path.join(root, "skills", SKILL_NAME),
    beforeWrite: options.beforeWrite,
    beforeFileWrite: options.beforeFileWrite,
  };
}

function bundlePath(value) {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\\") || /[\0-\x1f:]/.test(value)
    || path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw failure("invalid_skill_manifest", "Skill manifest paths must stay inside the skill bundle.");
  }
  return value;
}

function bundleManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { /* Report no source text. */ }
  if (!plainObject(manifest) || manifest.schema !== BUNDLE_SCHEMA || manifest.name !== SKILL_NAME || !plainObject(manifest.files)
    || !Object.hasOwn(manifest.files, "SKILL.md") || Object.hasOwn(manifest.files, MANIFEST)) {
    throw failure("invalid_skill_manifest", "A complete TRACE skill ownership manifest is required.");
  }
  const seen = new Set();
  for (const [relative, digest] of Object.entries(manifest.files)) {
    bundlePath(relative);
    if (seen.has(relative.toLowerCase()) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw failure("invalid_skill_manifest", "Skill paths and hashes must be unique and valid.");
    seen.add(relative.toLowerCase());
  }
  return manifest;
}

async function ordinaryAncestors(home, target) {
  const relative = path.relative(home, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw failure("unsafe_destination", "Destination must remain within the selected home.");
  let current = home;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("unsafe_destination", "Skill ancestors must be ordinary directories."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function treeFiles(directory, prefix = "") {
  const names = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw failure("unsafe_destination", "Skill bundles cannot contain symbolic links.");
    if (entry.isDirectory()) names.push(...await treeFiles(directory, relative));
    else if (entry.isFile()) names.push(relative);
    else throw failure("unsafe_destination", "Skill bundles contain only ordinary files and directories.");
  }
  return names.sort();
}

function validateReferences(files) {
  for (const [relative, bytes] of files) {
    if (!relative.endsWith(".md")) continue;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const links = [...source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g),
      ...source.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)];
    for (const match of links) {
      const link = match[1].replace(/^<|>$/g, "");
      if (link.startsWith("#") || /^https?:\/\//i.test(link) || link.startsWith("mailto:")) continue;
      let decoded;
      try { decoded = decodeURIComponent(link.split(/[?#]/, 1)[0]); } catch { throw failure("invalid_skill_reference", "A local skill reference is malformed."); }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decoded));
      try { if (path.posix.isAbsolute(decoded) || decoded.includes("\\") || /[\0-\x1f:]/.test(decoded)) throw new Error(); bundlePath(target); }
      catch { throw failure("invalid_skill_reference", "Local skill references must stay inside the declared bundle."); }
      if (!files.has(target)) throw failure("invalid_skill_reference", "A local skill reference is missing from the bundle manifest.");
    }
  }
}

async function loadSkillBundle(directory = path.join(ROOT, "skills", SKILL_NAME)) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("invalid_skill_source", "Skill source must be an ordinary directory.");
  const manifestBytes = (await snapshot(path.join(directory, MANIFEST))).bytes;
  const manifest = bundleManifest(manifestBytes);
  const declared = [...Object.keys(manifest.files), MANIFEST].sort();
  if (!equalValue(await treeFiles(directory), declared)) throw failure("invalid_skill_source", "Every skill source file must be declared by its ownership manifest.");
  const files = new Map();
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const item = await snapshot(path.join(directory, relative));
    if (item.fingerprint !== digest) throw failure("skill_source_changed", "Skill source hashes differ from its manifest.");
    files.set(relative, item.bytes);
  }
  if (!traceSkill(files.get("SKILL.md"))) throw failure("invalid_skill_source", "TRACE skill source has an unexpected name.");
  validateReferences(files);
  files.set(MANIFEST, manifestBytes);
  return { directory, files, manifest, sha256: manifest.files["SKILL.md"], bundleSha256: hash(manifestBytes) };
}

async function assertSourceUnchanged(bundle) {
  const fresh = await loadSkillBundle(bundle.directory);
  if (fresh.bundleSha256 !== bundle.bundleSha256) throw failure("skill_source_changed", "Skill source changed after planning.");
}

async function snapshot(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw failure("unsafe_destination", "Destination must be an ordinary file.");
    const bytes = await fs.readFile(target);
    return { bytes, fingerprint: hash(bytes), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { bytes: null, fingerprint: null, mode: 0o600 };
    throw error;
  }
}

function parse(bytes, format) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  const parsed = format === "json" ? JSON.parse(source) : toml.parse(source);
  if (!plainObject(parsed)) throw failure("invalid_configuration", "Configuration root must be an object.");
  return parsed;
}

function updatedBytes(original, parsed, descriptor, entry) {
  const expected = original.bytes === null ? {} : parse(original.bytes, descriptor.format);
  expected[descriptor.table] ??= {};
  expected[descriptor.table][SERVER_NAME] = entry;

  let text;
  if (descriptor.format === "toml") {
    const addition = toml.stringify({ [descriptor.table]: { [SERVER_NAME]: entry } });
    const prefix = original.bytes?.toString("utf8") ?? "";
    const appended = `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}${prefix ? "\n" : ""}${addition}`;
    // Appending preserves existing TOML comments and layout whenever its table
    // form allows extension. Inline tables require full serialization instead.
    try {
      const candidate = parse(Buffer.from(appended), "toml");
      if (equalValue(candidate, expected)) text = appended;
    } catch { /* Preserve parsed values when an inline-table layout cannot extend. */ }
    text ??= toml.stringify(expected);
  } else {
    const newline = original.bytes?.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    text = `${JSON.stringify(expected, null, 2).replace(/\n/g, newline)}${newline}`;
  }
  const result = Buffer.from(text);
  const actual = parse(result, descriptor.format);
  if (!equalValue(actual, expected)) throw failure("preservation_failed", "Serialization changed configuration values.");
  const before = { ...parsed };
  const after = { ...actual };
  delete before[descriptor.table];
  delete after[descriptor.table];
  if (!equalValue(before, after)) throw failure("preservation_failed", "Serialization changed unrelated configuration.");
  return result;
}

async function configItem(options, client) {
  const descriptor = CLIENTS[client];
  const target = path.join(options.home, descriptor.path);
  const summary = { kind: "configuration", client, path: `~/${descriptor.path}` };
  try {
    await ordinaryAncestors(options.home, target);
    const original = await snapshot(target);
    const parsed = original.bytes === null ? {} : parse(original.bytes, descriptor.format);
    const table = parsed[descriptor.table];
    if (table !== undefined && !plainObject(table)) throw failure("invalid_configuration", "MCP settings must be an object.");
    if (table && Object.hasOwn(table, SERVER_NAME)) {
      const same = equalValue(table[SERVER_NAME], options.entry);
      return { ...summary, target, original, action: same ? "unchanged" : "conflict", ...(same ? {} : { reason: "different_server_entry" }) };
    }
    return { ...summary, target, original, bytes: updatedBytes(original, parsed, descriptor, options.entry), action: "add" };
  } catch (error) {
    return { ...summary, target, action: "conflict", reason: error.code === "unsafe_destination" ? error.code : "invalid_configuration" };
  }
}

async function skillItem(options, relative, bundle, { migrateLegacy = false, skipMissing = false } = {}) {
  const directory = path.join(options.home, relative);
  const summary = { kind: "skill", path: `~/${relative.replace(/\\/g, "/")}` };
  try {
    await ordinaryAncestors(options.home, path.join(directory, "SKILL.md"));
    let stat;
    try { stat = await fs.lstat(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) return { ...summary, directory, action: "conflict", reason: "different_skill_destination" };
    if (!stat && skipMissing) return { ...summary, directory, action: "skip", reason: "not_installed" };
    const installedManifest = await snapshot(path.join(directory, MANIFEST));
    const owned = new Map();
    if (installedManifest.bytes !== null) {
      const prior = bundleManifest(installedManifest.bytes);
      for (const [file, digest] of Object.entries(prior.files)) {
        await ordinaryAncestors(options.home, path.join(directory, file));
        const original = await snapshot(path.join(directory, file));
        if (original.fingerprint !== digest) throw failure("modified_skill_content", "An installed managed skill file was modified or removed.");
        owned.set(file, original);
      }
      owned.set(MANIFEST, installedManifest);
    } else {
      const legacy = await snapshot(path.join(directory, "SKILL.md"));
      if (legacy.bytes !== null) {
        if (!traceSkill(legacy.bytes)) throw failure("not_trace_owned", "Existing instructions do not identify TRACE.");
        if (!migrateLegacy && !legacy.bytes.equals(bundle.files.get("SKILL.md"))) throw failure("different_skill_content", "An existing single-file skill requires explicit synchronization.");
        const unexpected = (await treeFiles(directory)).filter(name => name !== "SKILL.md" && !name.startsWith("SKILL.md.trace.backup."));
        if (unexpected.length) throw failure("unexpected_files", "Unmanaged legacy files were preserved.");
        owned.set("SKILL.md", legacy);
      } else if (stat && (await fs.readdir(directory)).length) throw failure("existing_skill_content", "Existing unowned skill files were preserved.");
      else if (skipMissing) return { ...summary, directory, action: "skip", reason: "not_installed" };
    }
    const files = [];
    for (const name of [...new Set([...owned.keys(), ...bundle.files.keys()])].sort()) {
      await ordinaryAncestors(options.home, path.join(directory, name));
      const original = owned.get(name) ?? await snapshot(path.join(directory, name));
      if (!owned.has(name) && original.bytes !== null) throw failure("unmanaged_skill_collision", "A new managed path already contains unowned content.");
      const bytes = bundle.files.get(name) ?? null;
      const digest = bytes === null ? null : hash(bytes);
      files.push({ name, target: path.join(directory, name), original, bytes, sha256: digest,
        action: digest === original.fingerprint ? "unchanged" : bytes === null ? "remove" : original.bytes === null ? "add" : "replace" });
    }
    const changed = files.some(item => item.action !== "unchanged");
    return { ...summary, directory, files, bundle, action: !changed ? "unchanged" : owned.size ? "replace" : "add" };
  } catch (error) {
    return { ...summary, directory, action: "conflict", reason: ["not_trace_owned", "different_skill_content", "modified_skill_content", "unexpected_files", "existing_skill_content", "unmanaged_skill_collision", "invalid_skill_manifest", "unsafe_destination"].includes(error.code) ? error.code : "invalid_skill_destination" };
  }
}

async function prepare(options) {
  const bundle = await loadSkillBundle(options.source);
  const entries = [];
  for (const client of options.clients) entries.push(await configItem(options, client));
  const skillPaths = [`.agents/skills/${SKILL_NAME}`];
  if (options.clients.includes("claude_code")) skillPaths.push(`.claude/skills/${SKILL_NAME}`);
  if (options.clients.includes("grok_build")) skillPaths.push(`.grok/skills/${SKILL_NAME}`);
  for (const relative of skillPaths) entries.push(await skillItem(options, relative, bundle));
  return { entries, bundle, skillSha256: bundle.sha256 };
}

function describe(prepared, options) {
  return {
    serverName: SERVER_NAME, transport: "stdio", clients: options.clients,
    server: options.entry, skill: { name: SKILL_NAME, sha256: prepared.skillSha256, bundleSha256: prepared.bundle.bundleSha256,
      files: [...prepared.bundle.files].map(([relative, bytes]) => ({ path: relative, sha256: hash(bytes) })) },
    conflicts: prepared.entries.filter((entry) => entry.action === "conflict").length,
    entries: prepared.entries.map(({ kind, client, path: displayPath, action, reason, files }) => ({ kind, ...(client ? { client } : {}), path: displayPath, action, ...(reason ? { reason } : {}),
      ...(files ? { files: files.map(({ name, action: fileAction, sha256, original }) => ({ path: name, action: fileAction, sha256, priorSha256: original.fingerprint })) } : {}) })),
  };
}

async function assertUnchanged(entry) {
  if (entry.kind === "skill") {
    for (const file of entry.files) await assertUnchanged(file);
    return;
  }
  const current = await snapshot(entry.target);
  if (current.fingerprint !== entry.original.fingerprint) throw failure("configuration_changed", "Destination changed after planning; existing content was preserved. Run a fresh plan.");
}

async function publish(entry) {
  await fs.mkdir(path.dirname(entry.target), { recursive: true });
  const temporary = path.join(path.dirname(entry.target), `.trace-${randomUUID()}.tmp`);
  let backupCreated = false;
  let backup;
  try {
    await fs.writeFile(temporary, entry.bytes, { flag: "wx", mode: entry.original.mode });
    await assertUnchanged(entry);
    if (entry.original.bytes !== null) {
      backup = `${entry.target}.trace.backup.${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      await fs.writeFile(backup, entry.original.bytes, { flag: "wx", mode: entry.original.mode });
      backupCreated = true;
      await assertUnchanged(entry);
      await fs.rename(temporary, entry.target);
    } else {
      // A hard link publishes a complete new file atomically and refuses an
      // intervening destination. Existing files use atomic rename above.
      await fs.link(temporary, entry.target);
    }
    return { backupCreated, backup, priorSha256: entry.original.fingerprint, installedSha256: hash(entry.bytes) };
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

const displayed = (home, target) => `~/${path.relative(home, target).replaceAll(path.sep, "/")}`;
function fromDisplayed(home, target) {
  if (typeof target !== "string" || !target.startsWith("~/")) throw failure("invalid_rollback", "Rollback paths must be relative to the selected home.");
  return path.join(home, bundlePath(target.slice(2)));
}

async function writeOwnedFile(home, file, bytes) {
  await ordinaryAncestors(home, file.target);
  await assertUnchanged(file);
  if (bytes === null) { await fs.unlink(file.target); return; }
  await fs.mkdir(path.dirname(file.target), { recursive: true });
  const temporary = path.join(path.dirname(file.target), `.trace-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: file.mode ?? file.original.mode });
    await assertUnchanged(file);
    if (file.original.bytes === null) await fs.link(temporary, file.target);
    else await fs.rename(temporary, file.target);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

async function rollbackSkillBundle(home, receiptPath, { dryRun = false } = {}) {
  home = path.resolve(home);
  const target = fromDisplayed(home, receiptPath);
  await ordinaryAncestors(home, target);
  const receiptFile = await snapshot(target);
  let receipt;
  try { receipt = JSON.parse(receiptFile.bytes?.toString("utf8")); } catch { /* Report no persisted content. */ }
  if (receipt?.schema !== "trace.skill-rollback/1" || receipt.skill !== SKILL_NAME || !SKILL_DESTINATIONS.includes(receipt.directory)
    || !Array.isArray(receipt.changes) || !receipt.changes.length) throw failure("invalid_rollback", "Expected a TRACE skill rollback receipt.");
  if (receipt.createdDirectories !== undefined && !Array.isArray(receipt.createdDirectories)) throw failure("invalid_rollback", "Rollback directory metadata is invalid.");
  for (const name of receipt.createdDirectories || []) { if (name !== "") bundlePath(name); }
  const directory = path.join(home, receipt.directory);
  const backupRoot = path.dirname(target);
  if (path.basename(target) !== "receipt.json" || path.dirname(backupRoot) !== path.join(home, SKILL_BACKUPS)
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(backupRoot))) {
    throw failure("invalid_rollback", "Rollback backup is outside the private TRACE skill-backup location.");
  }
  const restore = [];
  const seen = new Set();
  for (const change of receipt.changes) {
    const name = bundlePath(change.path);
    const validHash = value => value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
    if (seen.has(name.toLowerCase()) || !validHash(change.beforeSha256) || !validHash(change.afterSha256)
      || !Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777) throw failure("invalid_rollback", "Rollback file metadata is invalid.");
    seen.add(name.toLowerCase());
    const destination = path.join(directory, name);
    await ordinaryAncestors(home, destination);
    const original = await snapshot(destination);
    if (original.fingerprint === change.beforeSha256) continue;
    if (original.fingerprint !== change.afterSha256) return { applied: false, conflicts: 1, error: "destination_changed", restored: [] };
    let bytes = null;
    if (change.beforeSha256 !== null) {
      const backup = path.join(backupRoot, "files", name);
      await ordinaryAncestors(home, backup);
      const prior = await snapshot(backup);
      if (prior.fingerprint !== change.beforeSha256) throw failure("backup_mismatch", "A skill backup differs from its recorded hash.");
      bytes = prior.bytes;
    }
    restore.push({ name, target: destination, original, bytes, mode: change.mode });
  }
  if (dryRun) return { applied: false, conflicts: 0, pending: restore.length };
  const restored = [];
  try {
    for (const file of restore.sort((a, b) => Number(a.name === MANIFEST) - Number(b.name === MANIFEST))) {
      await writeOwnedFile(home, file, file.bytes);
      restored.push(file.name);
    }
  } catch (error) {
    return { applied: false, conflicts: 0, error: error.code || "rollback_failed", restored };
  }
  for (const name of [...(receipt.createdDirectories || [])].sort((a, b) => b.length - a.length)) {
    if (name !== "") bundlePath(name);
    const targetDirectory = path.join(directory, name);
    await ordinaryAncestors(home, path.join(targetDirectory, ".trace-directory-check"));
    await fs.rmdir(targetDirectory).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
  }
  return { applied: true, conflicts: 0, restored };
}

async function publishSkillBundle(entry, options) {
  await assertSourceUnchanged(entry.bundle);
  await assertUnchanged(entry);
  const changes = entry.files.filter(file => file.action !== "unchanged");
  const createdDirectories = [];
  const parents = new Set([""]);
  for (const file of changes) {
    let parent = path.posix.dirname(file.name);
    while (parent !== ".") { parents.add(parent); parent = path.posix.dirname(parent); }
  }
  for (const name of parents) {
    try { await fs.lstat(path.join(entry.directory, name)); }
    catch (error) { if (error.code !== "ENOENT") throw error; createdDirectories.push(name); }
  }
  // Skill discovery may recurse through every directory under a skills root.
  // Keep exact SKILL.md backup bytes outside all canonical/client discovery trees.
  const backupRoot = path.join(options.home, SKILL_BACKUPS, randomUUID());
  await ordinaryAncestors(options.home, path.join(backupRoot, "receipt.json"));
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  for (const file of changes.filter(item => item.original.bytes !== null)) {
    const backup = path.join(backupRoot, "files", file.name);
    await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    await fs.writeFile(backup, file.original.bytes, { flag: "wx", mode: file.original.mode });
    if ((await snapshot(backup)).fingerprint !== file.original.fingerprint) throw failure("backup_mismatch", "A skill backup differs from its installed source.");
  }
  const receiptPath = path.join(backupRoot, "receipt.json");
  const receipt = { schema: "trace.skill-rollback/1", skill: SKILL_NAME, directory: path.relative(options.home, entry.directory).replaceAll(path.sep, "/"),
    sourceBundleSha256: entry.bundle.bundleSha256, createdDirectories,
    changes: changes.map(file => ({ path: file.name, beforeSha256: file.original.fingerprint, afterSha256: file.sha256, mode: file.original.mode })) };
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    let index = 0;
    for (const file of changes.sort((a, b) => Number(a.name === MANIFEST) - Number(b.name === MANIFEST))) {
      if (options.beforeFileWrite) await options.beforeFileWrite({ directory: entry.directory, file: file.name, index: index++ });
      await assertSourceUnchanged(entry.bundle);
      await writeOwnedFile(options.home, file, file.bytes);
    }
    for (const file of entry.files) if ((await snapshot(file.target)).fingerprint !== file.sha256) throw failure("skill_install_mismatch", "Installed skill bundle verification failed.");
  } catch (error) {
    const rollback = await rollbackSkillBundle(options.home, displayed(options.home, receiptPath)).catch(failed => ({ applied: false, error: failed.code || "rollback_failed" }));
    error.bundleRecovery = { path: entry.path, backup: displayed(options.home, receiptPath), rollback };
    throw error;
  }
  return { backupCreated: changes.some(file => file.original.bytes !== null), backup: displayed(options.home, receiptPath),
    exactBackupVerified: true, installedSha256: entry.bundle.sha256, bundleSha256: entry.bundle.bundleSha256,
    priorSha256: entry.files.find(file => file.name === "SKILL.md")?.original.fingerprint ?? null,
    files: entry.files.map(file => ({ path: file.name, sha256: file.sha256, action: file.action })) };
}

async function plan(options = {}) {
  const normalized = optionsFor(options);
  return { mode: "plan", applied: false, ...describe(await prepare(normalized), normalized) };
}

async function apply(options = {}) {
  const normalized = optionsFor(options);
  const prepared = await prepare(normalized);
  const summary = { mode: "apply", applied: false, ...describe(prepared, normalized) };
  if (summary.conflicts) return summary;
  const additions = prepared.entries.filter((entry) => ["add", "replace"].includes(entry.action));
  // One preflight across every selected destination prevents known conflicts
  // from producing a partial installation. Recheck again just before publish.
  if (normalized.beforeWrite) await normalized.beforeWrite();
  await assertSourceUnchanged(prepared.bundle);
  for (const entry of prepared.entries) await assertUnchanged(entry);
  const completed = [];
  try {
    for (const entry of additions) {
      const result = entry.kind === "skill" ? await publishSkillBundle(entry, normalized) : await publish(entry);
      if (entry.kind === "configuration" && result.backup) result.backup = displayed(normalized.home, result.backup);
      completed.push({ path: entry.path, kind: entry.kind, ...result });
    }
  } catch (error) {
    // Earlier completed writes remain valid and retain their recoverable
    // backups. Report partial progress without exposing parser/config data.
    return { ...summary, error: { code: error.code ?? "write_failed", message: "Installation stopped; inspect a fresh plan before retrying." }, completed,
      ...(error.bundleRecovery ? { bundleRecovery: error.bundleRecovery } : {}) };
  }
  return { ...summary, applied: true, completed, reconnectRequired: completed.length > 0 };
}

async function rollback({ home = os.homedir(), receipt } = {}) {
  home = path.resolve(home);
  if (!Array.isArray(receipt?.completed)) throw failure("invalid_rollback", "Expected an installation receipt with completed changes.");
  const files = [];
  const bundles = [];
  const entries = [...receipt.completed, ...(receipt.bundleRecovery ? [{ kind: "skill", path: receipt.bundleRecovery.path, backup: receipt.bundleRecovery.backup }] : [])];
  for (const entry of entries) {
    if (entry.kind === "skill") {
      const check = await rollbackSkillBundle(home, entry.backup, { dryRun: true });
      if (check.conflicts) return { applied: false, conflicts: check.conflicts, completed: [] };
      bundles.push(entry);
    } else if (entry.kind === "configuration") {
      if (!Object.values(CLIENTS).some(client => `~/${client.path}` === entry.path)) throw failure("invalid_rollback", "Configuration rollback is outside TRACE client locations.");
      const target = fromDisplayed(home, entry.path);
      await ordinaryAncestors(home, target);
      const original = await snapshot(target);
      if (original.fingerprint === entry.priorSha256) continue;
      if (original.fingerprint !== entry.installedSha256) return { applied: false, conflicts: 1, completed: [] };
      let bytes = null;
      if (entry.priorSha256 !== null) {
        const backup = fromDisplayed(home, entry.backup);
        if (path.dirname(backup) !== path.dirname(target) || !path.basename(backup).startsWith(`${path.basename(target)}.trace.backup.`)) throw failure("invalid_rollback", "Configuration backup is outside its owned location.");
        await ordinaryAncestors(home, backup);
        const saved = await snapshot(backup);
        if (saved.fingerprint !== entry.priorSha256) throw failure("backup_mismatch", "A configuration backup differs from its recorded hash.");
        bytes = saved.bytes;
      }
      files.push({ target, original, bytes, path: entry.path });
    } else throw failure("invalid_rollback", "Unknown installation receipt entry.");
  }
  const completed = [];
  for (const entry of bundles.reverse()) {
    const result = await rollbackSkillBundle(home, entry.backup);
    if (!result.applied) return { applied: false, conflicts: result.conflicts, error: result.error, completed };
    completed.push({ kind: "skill", path: entry.path, restored: result.restored });
  }
  for (const file of files.reverse()) {
    try { await writeOwnedFile(home, file, file.bytes); completed.push({ kind: "configuration", path: file.path }); }
    catch (error) { return { applied: false, conflicts: 0, error: error.code || "rollback_failed", completed }; }
  }
  return { applied: true, conflicts: 0, completed };
}

module.exports = { CLIENTS, SERVER_NAME, SKILL_NAME, MANIFEST, SKILL_DESTINATIONS, plan, apply, rollback,
  loadSkillBundle, skillItem, publishSkillBundle, rollbackSkillBundle, assertSourceUnchanged, assertUnchanged };
