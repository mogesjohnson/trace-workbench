#!/usr/bin/env node
"use strict";

// Read-only protocol acceptance through the actual TRACE CLI and controller.
// Native readiness is reported separately; this never takes an input lease.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const ROOT = path.resolve(__dirname, "..");
const TOOLS = [
  "trace_computer_act", "trace_computer_close_session", "trace_computer_doctor",
  "trace_computer_list_windows", "trace_computer_observe", "trace_computer_open_session",
];

function reportPath(argv) {
  if (!argv.length) return null;
  if (argv.length !== 2 || argv[0] !== "--report") {
    throw new Error("Usage: node scripts/smoke-computer-mcp.cjs [--report evidence/report.json]");
  }
  const destination = path.resolve(ROOT, argv[1]);
  const relative = path.relative(path.join(ROOT, "evidence"), destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(relative) !== ".json") {
    throw new Error("Report must be a JSON file inside evidence/");
  }
  return destination;
}

async function main() {
  const destination = reportPath(process.argv.slice(2));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Computer MCP smoke exceeded 45 seconds")), 45_000);
  const client = new Client({ name: "trace-computer-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "bin", "trace.cjs"), "computer", "mcp"],
    cwd: ROOT,
    env: process.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-8_192); });
  try {
    await client.connect(transport, { timeout: 15_000, signal: abort.signal });
    const { tools } = await client.listTools({}, { timeout: 10_000, signal: abort.signal });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
    const result = await client.callTool({ name: "trace_computer_doctor", arguments: {} }, { timeout: 15_000, signal: abort.signal });
    assert.notEqual(result.isError, true, "Doctor returned a tool error");
    assert.ok(result.structuredContent && typeof result.structuredContent === "object");
    assert.equal(result.content.some((item) => item.type === "image"), false, "Doctor must not capture the desktop");
    const receipt = {
      observedAt: new Date().toISOString(),
      result: "pass",
      scope: "read-only CLI stdio discovery and provider diagnostics; no desktop action or model-host session",
      server: client.getServerVersion(),
      toolCount: tools.length,
      toolNames: TOOLS,
      doctorReturnedStructuredResult: true,
      // Only readiness booleans are retained; no titles, paths, or diagnostics
      // that might contain personal environment details enter the receipt.
      providerReady: result.structuredContent.ready === true,
      desktopActions: 0,
      modelRequests: 0,
    };
    if (destination) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Computer MCP smoke failed: ${error.message}\n`);
    if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
  }
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
