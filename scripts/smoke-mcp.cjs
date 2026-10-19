#!/usr/bin/env node
"use strict";

// A real MCP protocol test through TRACE's wrapper to the pinned public REA. It uses
// only the synthetic fixture below: no model, target execution, or open port.
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "owned-demo");
const EXPECTED_REA = "6.7.0";
const EXPECTED_TOOLS = 207;
const REQUEST_TIMEOUT_MS = 45_000;
const RUN_TIMEOUT_MS = 90_000;
const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureIdentity() {
  const entries = await fs.readdir(FIXTURE, { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["main.cjs", "package.json"]);
  assert.ok(entries.every((entry) => entry.isFile()), "Fixture must contain only its two owned files");
  const files = [];
  for (const name of ["main.cjs", "package.json"]) {
    const bytes = await fs.readFile(path.join(FIXTURE, name));
    files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { files, digest: sha256(JSON.stringify(files)) };
}

function unwrap(result, operation) {
  assert.notEqual(result.isError, true, `${operation} returned an MCP tool error`);
  if (result.structuredContent) return result.structuredContent;
  const item = result.content?.find((entry) => entry.type === "text");
  assert.ok(item, `${operation} returned no structured or text result`);
  return JSON.parse(item.text);
}

function verifyStaticEvidence(evidence, target) {
  assert.match(evidence.evidence_id, /^ev_[a-f0-9]{64}$/);
  assert.equal(evidence.operation, "analyze_javascript_application");
  assert.equal(evidence.confidence, "derived");
  assert.equal(evidence.authority, "shipped-artifact");
  const result = evidence.normalized_result;
  const sourceHash = target.files.find((file) => file.path === "main.cjs").sha256;
  assert.equal(result.root_artifact_sha256, evidence.subject.digest.sha256);
  assert.deepEqual(result.integrity_contradictions, []);
  assert.equal(result.statistics.parsed_javascript_files, 1);
  assert.equal(result.statistics.parse_failures, 0);
  assert.equal(result.graph.coverage.status, "complete");
  assert.equal(result.graph.coverage.truncated, false);
  const exports = ["createRecordingPlan", "formatOverlay", "OUTPUT_FORMAT"];
  const observations = [];
  for (const name of exports) {
    const observation = result.graph.nodes.flatMap((node) => node.observations).find((item) =>
      item.properties.semantic_role === "export-binding" &&
      item.properties.module_path === "main.cjs" &&
      item.properties.exported_name === name,
    );
    assert.ok(observation, `Analysis did not recover fixture export ${name}`);
    assert.equal(observation.evidence.authority, "ast-static-analysis");
    assert.equal(observation.evidence.state, "observed");
    assert.equal(observation.evidence.confidence, "exact");
    assert.equal(observation.evidence.artifact.sha256, sourceHash);
    assert.equal(observation.evidence.location.value.source, "main.cjs");
    observations.push({ name, observationId: observation.observation_id });
  }
  for (const name of exports.slice(0, 2)) {
    const callable = result.semantic_graph.nodes.find((node) =>
      node.kind === "function" && node.label === name &&
      node.identity.module_path === "main.cjs" &&
      node.identity.artifact_sha256 === sourceHash,
    );
    assert.ok(callable, `No artifact-bound callable for ${name}`);
  }
  return {
    exports: observations,
    graphCoverage: result.graph.coverage,
    semanticCoverage: result.semantic_graph.coverage.status,
    residualUnknownCount: result.semantic_graph.unknowns.length,
    parsedJavascriptFiles: result.statistics.parsed_javascript_files,
    artifactSha256: result.root_artifact_sha256,
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopOwnedTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0 || !processAlive(pid)) resolve();
        else reject(new Error("Could not stop the owned MCP process tree"));
      });
    });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

async function ownedWindowsChildren(pid) {
  if (process.platform !== "win32") return [];
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object ProcessId, Name | ConvertTo-Json -Compress`,
  ], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const children = Array.isArray(parsed) ? parsed : [parsed];
  assert.ok(children.every((child) => Number.isSafeInteger(child.ProcessId)));
  return children;
}

function reportDestination(argv) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--report") {
    throw new Error("Usage: node scripts/smoke-mcp.cjs [--report evidence/report.json]");
  }
  const destination = path.resolve(ROOT, argv[1]);
  const relative = path.relative(path.join(ROOT, "evidence"), destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The sanitized report must be inside this repository's evidence directory");
  }
  return destination;
}

async function main() {
  const destination = reportDestination(process.argv.slice(2));
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const runRoot = path.join(ROOT, ".runtime", "mcp-smoke", runId);
  await fs.mkdir(runRoot, { recursive: true });
  const saveRaw = async (name, data) => {
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(path.join(runRoot, name), bytes);
    return { file: name, sha256: sha256(bytes) };
  };
  const targetBefore = await fixtureIdentity();
  const serverPath = require.resolve("rea-agents/scripts/rea.mjs");
  const packageJson = JSON.parse(
    await fs.readFile(path.join(path.dirname(serverPath), "..", "package.json"), "utf8"),
  );
  assert.equal(packageJson.version, EXPECTED_REA, "Pinned REA package version changed");
  const client = new Client(
    { name: "trace-workbench-acceptance", version: "0.1.0-alpha.1" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "bin", "trace.cjs"), "mcp"],
    cwd: runRoot,
    stderr: "pipe",
    maxBufferSize: 20 * 1024 * 1024,
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    // Bound diagnostics retained locally, never print environment or raw results.
    if (stderr.length < 128 * 1024) stderr += chunk.toString("utf8");
  });
  let ownedPid;
  let ownedChildPids = [];
  let reaChildCount = 0;
  let completed = false;
  let watchdog;
  let summary;
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("MCP acceptance interrupted"));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const watchdogExpired = new Promise((_, reject) => {
    watchdog = setTimeout(() => {
      const error = new Error("MCP acceptance exceeded the 90 second run limit");
      abort.abort(error);
      reject(error);
    }, RUN_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS, signal: abort.signal });
        ownedPid = transport.pid;
        assert.ok(Number.isSafeInteger(ownedPid), "SDK did not expose the owned server PID");
        const children = await ownedWindowsChildren(ownedPid);
        ownedChildPids = children.map((child) => child.ProcessId);
        await saveRaw("owned-processes.json", { wrapperPid: ownedPid, children });
        reaChildCount = children.filter((child) =>
          child.Name.toLowerCase() === path.basename(process.execPath).toLowerCase(),
        ).length;
        if (process.platform === "win32") {
          assert.equal(reaChildCount, 1, "TRACE should own exactly one direct REA Node child");
        }
        assert.deepEqual(client.getServerVersion(), { name: "rea", version: EXPECTED_REA });
        const tools = [];
        let cursor;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, {
            timeout: REQUEST_TIMEOUT_MS,
            signal: abort.signal,
          });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        assert.equal(tools.length, EXPECTED_TOOLS, "Unexpected actual MCP tool count");
        assert.equal(new Set(tools.map((tool) => tool.name)).size, EXPECTED_TOOLS);
        const catalogReceipt = await saveRaw("tools-list.json", { tools });
        const healthSchema = tools.find((tool) => tool.name === "binary_session")?.inputSchema;
        const analysisSchema = tools.find((tool) => tool.name === "analyze_javascript_application")?.inputSchema;
        assert.ok(healthSchema?.properties?.expected_package_version);
        assert.ok(analysisSchema?.required?.includes("input_path"));
        assert.ok(analysisSchema.properties.format.enum.includes("directory"));
        assert.ok(analysisSchema.properties.detail.enum.includes("complete"));
        const call = (name, args) => client.callTool({ name, arguments: args }, {
          timeout: REQUEST_TIMEOUT_MS,
          signal: abort.signal,
        });
        const healthResult = await call("binary_session", {
          expected_package_version: EXPECTED_REA,
          expected_server_path: serverPath,
        });
        const healthReceipt = await saveRaw("binary-session.json", healthResult);
        const health = unwrap(healthResult, "binary_session").result;
        assert.equal(health.open, false, "Health probe unexpectedly opened a native target");
        assert.equal(health.cleanup_pending, false);
        assert.equal(health.server_identity.package.version, EXPECTED_REA);
        assert.equal(health.server_identity.alignment.state, "aligned");
        assert.equal(health.server_identity.catalog.counts.mcp_tools, EXPECTED_TOOLS);
        assert.ok(health.server_identity.negotiated_protocol_version);
        const analysisResult = await call("analyze_javascript_application", {
          input_path: FIXTURE,
          format: "directory",
          integrity_policy: "fail",
          detail: "complete",
          max_heap_mb: 256,
          analysis_timeout_ms: 15_000,
        });
        const analysisReceipt = await saveRaw("javascript-analysis.json", analysisResult);
        const evidence = unwrap(analysisResult, "analyze_javascript_application");
        const verified = verifyStaticEvidence(evidence, targetBefore);
        const targetAfter = await fixtureIdentity();
        assert.deepEqual(targetAfter, targetBefore, "Static analysis modified the fixture");
        summary = {
          schemaVersion: 1,
          passed: true,
          observedAt: new Date().toISOString(),
          scope: "TRACE wrapper -> REA",
          transport: "stdio",
          client: "@modelcontextprotocol/client@2.3.1",
          server: client.getServerVersion(),
          toolCount: tools.length,
          health: {
            completed: true,
            noNativeTargetOpen: true,
            alignment: health.server_identity.alignment.state,
            negotiatedProtocol: health.server_identity.negotiated_protocol_version,
            catalogDigests: health.server_identity.catalog.digests,
          },
          target: {
            kind: "owned-synthetic-javascript-application",
            relativePath: "tests/fixtures/owned-demo",
            ...targetBefore,
            unchanged: true,
          },
          analysis: {
            evidenceId: evidence.evidence_id,
            confidence: evidence.confidence,
            operation: evidence.operation,
            authority: evidence.authority,
            ...verified,
            limitations: evidence.limitations,
          },
          localEvidenceRun: `.runtime/mcp-smoke/${runId}`,
          rawEvidence: [catalogReceipt, healthReceipt, analysisReceipt],
          limits: {
            paidCalls: 0,
            modelClientTests: 0,
            executedTargetCode: false,
            nativeEngineInstalled: false,
            persistentNetworkListener: false,
            staticEvidenceOnly: true,
          },
        };
        completed = true;
      })(),
      watchdogExpired,
    ]);
  } finally {
    clearTimeout(watchdog);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    ownedPid ??= transport.pid;
    if (!completed && ownedPid) await stopOwnedTree(ownedPid);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    if (ownedPid && processAlive(ownedPid)) await stopOwnedTree(ownedPid);
    for (const childPid of ownedChildPids) {
      if (processAlive(childPid)) await stopOwnedTree(childPid);
    }
    await fs.writeFile(path.join(runRoot, "stderr.log"), stderr);
  }
  summary.cleanup = {
    ownedWrapperExited: !processAlive(ownedPid),
    ownedReaChildCount: reaChildCount,
    ownedDirectChildCount: ownedChildPids.length,
    ownedChildrenExited: ownedChildPids.length ? ownedChildPids.every((pid) => !processAlive(pid)) : null,
    childExitCheck: process.platform === "win32" ? "owned-pids-through-windows-cim" : "not-checked-on-this-platform",
  };
  assert.equal(summary.cleanup.ownedWrapperExited, true);
  if (process.platform === "win32") assert.equal(summary.cleanup.ownedChildrenExited, true);
  await saveRaw("summary.json", summary);
  if (destination) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`MCP acceptance failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { reportDestination, unwrap, verifyStaticEvidence };
