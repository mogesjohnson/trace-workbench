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
const CLIENTS = Object.freeze({
  codex: { path: ".codex/config.toml", format: "toml", table: "mcp_servers" },
  claude_code: { path: ".claude.json", format: "json", table: "mcpServers" },
  grok_build: { path: ".grok/config.toml", format: "toml", table: "mcp_servers" },
  gemini_cli: { path: ".gemini/settings.json", format: "json", table: "mcpServers" },
});

const failure = (code, message) => Object.assign(new Error(message), { code });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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
    source: path.join(root, "skills", SKILL_NAME, "SKILL.md"),
    beforeWrite: options.beforeWrite,
  };
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

async function skillItem(options, relative, source) {
  const directory = path.join(options.home, relative);
  const target = path.join(directory, "SKILL.md");
  const summary = { kind: "skill", path: `~/${relative.replace(/\\/g, "/")}` };
  try {
    let stat;
    try { stat = await fs.lstat(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) return { ...summary, target, action: "conflict", reason: "different_skill_destination" };
    const original = await snapshot(target);
    if (original.bytes !== null) {
      const same = original.bytes.equals(source);
      return { ...summary, directory, target, original, action: same ? "unchanged" : "conflict", ...(same ? {} : { reason: "different_skill_content" }) };
    }
    if (stat && (await fs.readdir(directory)).length > 0) return { ...summary, target, action: "conflict", reason: "existing_skill_content" };
    return { ...summary, directory, target, original, bytes: source, action: "add" };
  } catch {
    return { ...summary, target, action: "conflict", reason: "invalid_skill_destination" };
  }
}

async function prepare(options) {
  const source = await fs.readFile(options.source);
  if (!/^name: trace-computer-use\r?$/m.test(source.toString("utf8"))) throw failure("invalid_skill_source", "TRACE skill source has an unexpected name.");
  const entries = [];
  for (const client of options.clients) entries.push(await configItem(options, client));
  const skillPaths = [`.agents/skills/${SKILL_NAME}`];
  if (options.clients.includes("claude_code")) skillPaths.push(`.claude/skills/${SKILL_NAME}`);
  if (options.clients.includes("grok_build")) skillPaths.push(`.grok/skills/${SKILL_NAME}`);
  for (const relative of skillPaths) entries.push(await skillItem(options, relative, source));
  return { entries, skillSha256: hash(source) };
}

function describe(prepared, options) {
  return {
    serverName: SERVER_NAME, transport: "stdio", clients: options.clients,
    server: options.entry, skill: { name: SKILL_NAME, sha256: prepared.skillSha256 },
    conflicts: prepared.entries.filter((entry) => entry.action === "conflict").length,
    entries: prepared.entries.map(({ kind, client, path: displayPath, action, reason }) => ({ kind, ...(client ? { client } : {}), path: displayPath, action, ...(reason ? { reason } : {}) })),
  };
}

async function assertUnchanged(entry) {
  const current = await snapshot(entry.target);
  if (current.fingerprint !== entry.original.fingerprint) throw failure("configuration_changed", "Destination changed after planning; existing content was preserved. Run a fresh plan.");
}

async function publish(entry) {
  await fs.mkdir(path.dirname(entry.target), { recursive: true });
  const temporary = path.join(path.dirname(entry.target), `.trace-${randomUUID()}.tmp`);
  let backupCreated = false;
  try {
    await fs.writeFile(temporary, entry.bytes, { flag: "wx", mode: entry.original.mode });
    await assertUnchanged(entry);
    if (entry.original.bytes !== null) {
      const backup = `${entry.target}.trace.backup.${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      await fs.writeFile(backup, entry.original.bytes, { flag: "wx", mode: entry.original.mode });
      backupCreated = true;
      await assertUnchanged(entry);
      await fs.rename(temporary, entry.target);
    } else {
      // A hard link publishes a complete new file atomically and refuses an
      // intervening destination. Existing files use atomic rename above.
      await fs.link(temporary, entry.target);
    }
    return { backupCreated };
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
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
  const additions = prepared.entries.filter((entry) => entry.action === "add");
  // One preflight across every selected destination prevents known conflicts
  // from producing a partial installation. Recheck again just before publish.
  if (normalized.beforeWrite) await normalized.beforeWrite();
  for (const entry of additions) await assertUnchanged(entry);
  const completed = [];
  try {
    for (const entry of additions) {
      const result = await publish(entry);
      completed.push({ path: entry.path, kind: entry.kind, ...result });
    }
  } catch (error) {
    // Earlier completed writes remain valid and retain their recoverable
    // backups. Report partial progress without exposing parser/config data.
    return { ...summary, error: { code: error.code ?? "write_failed", message: "Installation stopped; inspect a fresh plan before retrying." }, completed };
  }
  return { ...summary, applied: true, completed, reconnectRequired: completed.length > 0 };
}

module.exports = { CLIENTS, SERVER_NAME, SKILL_NAME, plan, apply };
