"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const toml = require("smol-toml");
const { plan, apply, rollback, CLIENTS, loadSkillBundle } = require("../src/computer/configuration.cjs");
const { parseArguments } = require("../scripts/configure-computer.cjs");

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, "skills", "trace-computer-use", "SKILL.md");
const SERVER = { command: process.execPath, args: [path.join(ROOT, "bin", "trace.cjs"), "computer", "mcp"] };

async function temporaryHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trace-computer-config-"));
  t.after(async () => {
    const resolved = path.resolve(home);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert.ok(relative.startsWith("trace-computer-config-") && !relative.includes(path.sep));
    await fs.rm(resolved, { recursive: true });
  });
  return home;
}

async function write(home, relative, content) {
  const target = path.join(home, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function readConfig(home, client) {
  const config = CLIENTS[client];
  const source = await fs.readFile(path.join(home, config.path), "utf8");
  return config.format === "json" ? JSON.parse(source) : structuredClone(toml.parse(source));
}

function removeOwned(config, table) {
  const result = structuredClone(config);
  delete result[table]["trace-computer"];
  return result;
}

test("computer configuration defaults to a four-client plan without filesystem writes", async (t) => {
  const home = await temporaryHome(t);
  const result = await plan({ home });
  assert.equal(result.mode, "plan");
  assert.equal(result.applied, false);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.clients, Object.keys(CLIENTS));
  assert.deepEqual(result.server, SERVER);
  assert.equal(result.entries.length, 7);
  assert.ok(result.entries.every((entry) => entry.action === "add"));
  assert.ok(result.skill.files.some(file => file.path === "references/readiness-routing.md" && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.deepEqual(await fs.readdir(home), []);
});

test("applying config preserves unrelated values and exact original-byte backups for all four clients", async (t) => {
  const home = await temporaryHome(t);
  const originalBytes = new Map();
  const originalParsed = new Map();
  for (const [client, descriptor] of Object.entries(CLIENTS)) {
    const content = descriptor.format === "toml"
      ? '# Keep this comment\r\nmodel = "test"\r\n[mcp_servers.other]\r\ncommand = "preserve"\r\nargs = ["one", "two"]\r\n[mcp_servers.other.env]\r\nLOCAL_FIXTURE_VALUE = "private fixture data"\r\n'
      : '{\r\n  "theme": "fixture",\r\n  "mcpServers": {"other": {"command": "preserve", "env": {"LOCAL_FIXTURE_VALUE": "private fixture data"}}}\r\n}\r\n';
    const target = await write(home, descriptor.path, content);
    originalBytes.set(client, await fs.readFile(target));
    originalParsed.set(client, await readConfig(home, client));
  }
  const result = await apply({ home });
  assert.equal(result.applied, true);
  assert.equal(result.completed.length, 7);
  assert.equal(result.completed.filter((entry) => entry.backupCreated).length, 4);
  assert.equal(JSON.stringify(result).includes("private fixture data"), false);
  assert.equal(JSON.stringify(result).includes("LOCAL_FIXTURE_VALUE"), false);
  for (const [client, descriptor] of Object.entries(CLIENTS)) {
    const current = await readConfig(home, client);
    assert.deepEqual(current[descriptor.table]["trace-computer"], SERVER);
    assert.deepEqual(removeOwned(current, descriptor.table), originalParsed.get(client));
    const target = path.join(home, descriptor.path);
    const backups = (await fs.readdir(path.dirname(target))).filter((name) => name.startsWith(`${path.basename(target)}.trace.backup.`));
    assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(target), backups[0])), originalBytes.get(client));
    if (descriptor.format === "toml") {
      assert.equal((await fs.readFile(target)).subarray(0, originalBytes.get(client).length).equals(originalBytes.get(client)), true);
    }
  }
  const source = await fs.readFile(SKILL);
  const bundle = await loadSkillBundle(path.dirname(SKILL));
  for (const clientFolder of [".agents", ".claude", ".grok"]) {
    assert.deepEqual(await fs.readFile(path.join(home, clientFolder, "skills", "trace-computer-use", "SKILL.md")), source);
    for (const [relative, bytes] of bundle.files) assert.deepEqual(await fs.readFile(path.join(home, clientFolder, "skills", "trace-computer-use", relative)), bytes);
  }
  const second = await apply({ home });
  assert.equal(second.applied, true);
  assert.deepEqual(second.completed, []);
  assert.ok(second.entries.every((entry) => entry.action === "unchanged"));
  for (const descriptor of Object.values(CLIENTS)) {
    const target = path.join(home, descriptor.path);
    assert.equal((await fs.readdir(path.dirname(target))).filter((name) => name.startsWith(`${path.basename(target)}.trace.backup.`)).length, 1);
  }
});

test("installation receipt rolls back all owned client and bundle changes exactly", async (t) => {
  const home = await temporaryHome(t);
  const original = Buffer.from('# exact fixture bytes\r\nmodel = "retain"\r\n');
  await write(home, CLIENTS.codex.path, original);
  const installed = await apply({ home });
  assert.equal(installed.applied, true);
  const result = await rollback({ home, receipt:installed });
  assert.equal(result.applied, true);
  assert.deepEqual(await fs.readFile(path.join(home, CLIENTS.codex.path)), original);
  for (const client of ["claude_code", "grok_build", "gemini_cli"]) await assert.rejects(fs.access(path.join(home, CLIENTS[client].path)), { code:"ENOENT" });
  for (const relative of [".agents", ".claude", ".grok"]) await assert.rejects(fs.access(path.join(home, relative, "skills", "trace-computer-use")), { code:"ENOENT" });
  assert.equal((await rollback({ home, receipt:installed })).applied, true);
});

test("rollback refuses concurrent configuration edits before altering any installed skill", async (t) => {
  const home = await temporaryHome(t);
  const installed = await apply({ home, clients:["codex"] });
  const target = path.join(home, CLIENTS.codex.path);
  const current = await fs.readFile(target, "utf8");
  await fs.writeFile(target, current+'\n# later human edit\n');
  const result = await rollback({ home, receipt:installed });
  assert.equal(result.applied, false);
  assert.equal(result.conflicts, 1);
  assert.equal(await fs.readFile(target, "utf8"), current+'\n# later human edit\n');
  assert.deepEqual(await fs.readFile(path.join(home, ".agents/skills/trace-computer-use/SKILL.md")), await fs.readFile(SKILL));
});

test("a partial installation retains receipts and rolls back client settings plus the failed bundle", async (t) => {
  const home = await temporaryHome(t);
  const original = Buffer.from('model = "before"\r\n');
  await write(home, CLIENTS.codex.path, original);
  const result = await apply({ home, beforeFileWrite:({index}) => {
    if (index === 1) throw Object.assign(new Error('owned fixture failure'), { code:"fixture_failure" });
  } });
  assert.equal(result.applied, false);
  assert.equal(result.error.code, "fixture_failure");
  assert.equal(result.completed.filter(item => item.kind === "configuration").length, 4);
  assert.equal(result.bundleRecovery.rollback.applied, true);
  const restored = await rollback({ home, receipt:result });
  assert.equal(restored.applied, true);
  assert.deepEqual(await fs.readFile(path.join(home, CLIENTS.codex.path)), original);
  await assert.rejects(fs.access(path.join(home, ".agents/skills/trace-computer-use")), { code:"ENOENT" });
});

test("narrowed client scope creates only the selected configuration and skill discoveries", async (t) => {
  const home = await temporaryHome(t);
  const result = await apply({ home, clients: ["gemini_cli", "gemini_cli"] });
  assert.equal(result.applied, true);
  assert.deepEqual(result.clients, ["gemini_cli"]);
  assert.equal(result.entries.length, 2);
  assert.deepEqual((await readConfig(home, "gemini_cli")).mcpServers["trace-computer"], SERVER);
  assert.deepEqual((await fs.readdir(home)).sort(), [".agents", ".gemini", ".trace"]);
});

test("a differing server entry blocks the complete apply before other configuration or skills are written", async (t) => {
  const home = await temporaryHome(t);
  const original = JSON.stringify({ mcpServers: { "trace-computer": { command: "owned-by-someone-else", args: ["retain"] } } });
  const target = await write(home, CLIENTS.claude_code.path, original);
  const result = await apply({ home });
  assert.equal(result.applied, false);
  assert.equal(result.conflicts, 1);
  assert.equal(result.entries.find((entry) => entry.client === "claude_code").reason, "different_server_entry");
  assert.equal(await fs.readFile(target, "utf8"), original);
  assert.deepEqual(await fs.readdir(home), [".claude.json"]);
  assert.equal(JSON.stringify(result).includes("owned-by-someone-else"), false);
});

test("existing custom skill content is preserved and blocks configuration writes", async (t) => {
  const home = await temporaryHome(t);
  const relative = ".agents/skills/trace-computer-use/SKILL.md";
  const target = await write(home, relative, "custom skill content");
  const result = await apply({ home, clients: ["codex"] });
  assert.equal(result.applied, false);
  assert.equal(result.conflicts, 1);
  assert.equal(await fs.readFile(target, "utf8"), "custom skill content");
  await assert.rejects(fs.access(path.join(home, CLIENTS.codex.path)), { code: "ENOENT" });
});

test("invalid config parsing remains private and never overwrites the source", async (t) => {
  const home = await temporaryHome(t);
  const privateText = '{"secret-looking-fixture":"must stay private", bad-json}';
  const target = await write(home, CLIENTS.gemini_cli.path, privateText);
  const result = await apply({ home, clients: ["gemini_cli"] });
  assert.equal(result.applied, false);
  assert.equal(result.entries[0].reason, "invalid_configuration");
  assert.equal(JSON.stringify(result).includes("must stay private"), false);
  assert.equal(await fs.readFile(target, "utf8"), privateText);
});

test("inline TOML tables retain unrelated parsed values when a complete serialization is necessary", async (t) => {
  const home = await temporaryHome(t);
  await write(home, CLIENTS.codex.path, 'model = "fixture"\nmcp_servers = { other = { command = "preserve", args = ["x"] } }\n');
  const before = await readConfig(home, "codex");
  const result = await apply({ home, clients: ["codex"] });
  assert.equal(result.applied, true);
  const after = await readConfig(home, "codex");
  assert.deepEqual(removeOwned(after, "mcp_servers"), before);
  assert.deepEqual(after.mcp_servers["trace-computer"], SERVER);
});

test("optimistic preflight preserves a concurrent edit and performs no writes", async (t) => {
  const home = await temporaryHome(t);
  const target = await write(home, CLIENTS.codex.path, 'model = "original"\n');
  await assert.rejects(apply({
    home, clients: ["codex"],
    beforeWrite: async () => { await fs.writeFile(target, 'model = "new concurrent value"\n'); },
  }), { code: "configuration_changed" });
  assert.equal(await fs.readFile(target, "utf8"), 'model = "new concurrent value"\n');
  assert.deepEqual(await fs.readdir(path.dirname(target)), ["config.toml"]);
  await assert.rejects(fs.access(path.join(home, ".agents")), { code: "ENOENT" });
});

test("symlinked configuration destinations are preserved as conflicts", async (t) => {
  const home = await temporaryHome(t);
  const destination = await write(home, "retained-source.json", "{}");
  try {
    await fs.symlink(destination, path.join(home, ".claude.json"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Creating file symlinks needs developer mode on this Windows host"); return; }
    throw error;
  }
  const result = await apply({ home, clients: ["claude_code"] });
  assert.equal(result.applied, false);
  assert.equal(result.entries[0].reason, "unsafe_destination");
  assert.equal(await fs.readFile(destination, "utf8"), "{}");
  assert.equal((await fs.lstat(path.join(home, ".claude.json"))).isSymbolicLink(), true);
});

test("configuration argument parsing rejects unknown destinations and ambiguous mutation modes", async () => {
  assert.deepEqual(parseArguments([]), { mode: "plan" });
  assert.deepEqual(parseArguments(["--apply", "--client", "codex", "--client", "codex"]), { mode: "apply", clients: ["codex"] });
  assert.deepEqual(parseArguments(["--plan", "--client", "grok_build", "--client", "claude_code"]), { mode: "plan", clients: ["grok_build", "claude_code"] });
  for (const args of [["--apply", "--plan"], ["--client"], ["--client", "other"], ["--home", "/anywhere"], ["--force"], ["--apply=true"]]) {
    assert.throws(() => parseArguments(args));
  }
  await assert.rejects(plan({ clients: [] }), { code: "invalid_client" });
});
