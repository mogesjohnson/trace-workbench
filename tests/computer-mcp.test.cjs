"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const { createComputerServer, runComputerServer } = require("../src/computer/server.cjs");

// Synthetic one-pixel PNG: protocol checks never access the user's desktop.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const WINDOW = { id: "fixture-window", processId: 42, title: "TRACE fixture" };
const OBSERVATION = {
  sessionId: "fixture-session", observationId: "fixture-observation", window: WINDOW,
  bounds: { x: 0, y: 0, width: 1, height: 1 }, elements: [],
  screenshot: { data: PNG, mimeType: "image/png", width: 1, height: 1 },
  observedAt: "2026-01-01T00:00:00.000Z",
};
const EXPECTED_TOOLS = [
  "trace_computer_act", "trace_computer_close_session", "trace_computer_doctor",
  "trace_computer_list_windows", "trace_computer_observe", "trace_computer_open_session",
];

function fakeController(overrides = {}) {
  const calls = [];
  let closed = 0;
  const defaults = {
    doctor: async () => ({ ready: true, provider: "test-double" }),
    listWindows: async () => ({ windows: [WINDOW] }),
    openSession: async () => ({ sessionId: OBSERVATION.sessionId, window: WINDOW }),
    observe: async () => structuredClone(OBSERVATION),
    act: async () => ({ actionId: "fixture-action", outcome: "completed", observation: structuredClone(OBSERVATION) }),
    closeSession: async ({ sessionId }) => ({ sessionId, closed: true }),
    close: async () => { closed += 1; },
  };
  const controller = {};
  for (const [name, operation] of Object.entries({ ...defaults, ...overrides })) {
    controller[name] = async (...args) => {
      calls.push({ method: name, args });
      return operation(...args);
    };
  }
  return { controller, calls, get closed() { return closed; } };
}

async function connection(t, overrides, run = false) {
  const fake = fakeController(overrides);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = run
    ? await runComputerServer({ controller: fake.controller, transport: serverTransport })
    : createComputerServer({ controller: fake.controller });
  if (!run) await server.connect(serverTransport);
  const client = new Client({ name: "trace-protocol-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);
  return { client, server, fake };
}

function assertImageResult(result, path = []) {
  assert.notEqual(result.isError, true);
  const images = result.content.filter((item) => item.type === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0].data, PNG);
  assert.equal(images[0].mimeType, "image/png");
  const text = result.content.find((item) => item.type === "text");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  assert.equal(text.text.includes(PNG), false);
  assert.equal(JSON.stringify(result.structuredContent).includes(PNG), false);
  const observation = path.reduce((value, key) => value[key], result.structuredContent);
  assert.equal(observation.observationId, OBSERVATION.observationId);
  assert.deepEqual(observation.screenshot, { mimeType: "image/png", width: 1, height: 1, contentIndex: 1 });
}

test("computer server discovers six tools with strict argument and action schemas", async (t) => {
  const { client } = await connection(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  assert.equal(client.getServerVersion().name, "trace-computer");
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const action = tools.find((tool) => tool.name === "trace_computer_act");
  assert.deepEqual(action.inputSchema.required.sort(), ["action", "observationId", "sessionId"]);
  assert.ok(action.inputSchema.properties.action.anyOf.every((variant) => variant.additionalProperties === false));
  assert.equal(action.annotations.idempotentHint, false);
  assert.equal(action.annotations.destructiveHint, true);
});

test("computer MCP routes discovery and session lifecycle with cancellation signals", async (t) => {
  const { client, fake } = await connection(t);
  const cases = [
    ["trace_computer_doctor", {}, "doctor"],
    ["trace_computer_list_windows", {}, "listWindows"],
    ["trace_computer_open_session", { windowId: WINDOW.id }, "openSession"],
    ["trace_computer_close_session", { sessionId: OBSERVATION.sessionId }, "closeSession"],
  ];
  for (const [name, args, method] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    const call = fake.calls.at(-1);
    assert.equal(call.method, method);
    const options = method === "doctor" || method === "listWindows" ? call.args[0] : call.args[1];
    if (method !== "doctor" && method !== "listWindows") assert.deepEqual(call.args[0], args);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
  }
});

test("observe returns native MCP image content without duplicating screenshot bytes", async (t) => {
  const { client, fake } = await connection(t);
  const result = await client.callTool({ name: "trace_computer_observe", arguments: { sessionId: OBSERVATION.sessionId } });
  assertImageResult(result);
  assert.deepEqual(fake.calls.at(-1).args[0], { sessionId: OBSERVATION.sessionId });
  assert.equal(OBSERVATION.screenshot.data, PNG, "Projection must not modify controller data");
});

test("all supported actions preserve their exact arguments and return a fresh observation", async (t) => {
  const { client, fake } = await connection(t);
  const actions = [
    { type: "activate" }, { type: "click", x: 0, y: 0 }, { type: "click", elementId: "button-1" },
    { type: "type_text", text: "A text value" }, { type: "press_key", key: "CTRL+A" },
    { type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: -120 },
    { type: "drag", fromX: 0, fromY: 0, toX: 10, toY: 10 },
    { type: "invoke", elementId: "button-1" }, { type: "set_value", elementId: "edit-1", value: "" },
  ];
  for (const action of actions) {
    const args = { sessionId: OBSERVATION.sessionId, observationId: OBSERVATION.observationId, action };
    const result = await client.callTool({ name: "trace_computer_act", arguments: args });
    assertImageResult(result, ["observation"]);
    assert.equal(result.structuredContent.outcome, "completed");
    assert.equal(fake.calls.at(-1).method, "act");
    assert.deepEqual(fake.calls.at(-1).args[0], args);
  }
});

test("invalid inputs never reach the desktop controller", async (t) => {
  const { client, fake } = await connection(t);
  const base = { sessionId: OBSERVATION.sessionId, observationId: OBSERVATION.observationId };
  const invalid = [
    ["trace_computer_doctor", { force: true }],
    ["trace_computer_list_windows", { includeHidden: true }],
    ["trace_computer_open_session", { windowId: "" }],
    ["trace_computer_open_session", { windowId: WINDOW.id, processId: 42 }],
    ["trace_computer_observe", { sessionId: OBSERVATION.sessionId, screenshot: false }],
    ["trace_computer_act", { sessionId: OBSERVATION.sessionId, action: { type: "activate" } }],
    ["trace_computer_act", { ...base, action: { type: "click", x: 0 } }],
    ["trace_computer_act", { ...base, action: { type: "click", x: 0, y: 0, elementId: "button" } }],
    ["trace_computer_act", { ...base, action: { type: "click", x: "0", y: 0 } }],
    ["trace_computer_act", { ...base, action: { type: "type_text", text: "a", submit: true } }],
    ["trace_computer_act", { ...base, action: { type: "shell", command: "anything" } }],
    ["trace_computer_act", { ...base, action: { type: "press_key", key: "a" }, retry: 2 }],
    ["trace_computer_close_session", { sessionId: OBSERVATION.sessionId, closeWindow: true }],
  ];
  for (const [name, args] of invalid) {
    // The SDK's tool validation can return a tool error rather than throwing a
    // protocol exception; both prevent dispatch. Calls below exercise that path.
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
  }
  assert.equal(fake.calls.length, 0);
});

test("controller failures are actionable tool errors without a stack trace", async (t) => {
  const { client } = await connection(t, {
    observe: async () => { throw Object.assign(new Error("Window no longer exists"), { code: "WINDOW_CLOSED" }); },
  });
  const result = await client.callTool({ name: "trace_computer_observe", arguments: { sessionId: OBSERVATION.sessionId } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { error: { code: "WINDOW_CLOSED", message: "Window no longer exists" } });
  assert.equal(result.content[0].text.includes(" at "), false);
});

test("unknown action outcome remains unknown, with its refreshed image intact", async (t) => {
  const { client } = await connection(t, {
    act: async () => ({ actionId: "attempt-1", outcome: "unknown", error: { code: "CAPTURE_FAILED" }, observation: structuredClone(OBSERVATION) }),
  });
  const result = await client.callTool({ name: "trace_computer_act", arguments: {
    sessionId: OBSERVATION.sessionId, observationId: OBSERVATION.observationId, action: { type: "activate" },
  } });
  assertImageResult(result, ["observation"]);
  assert.equal(result.structuredContent.outcome, "unknown");
  assert.equal(result.structuredContent.error.code, "CAPTURE_FAILED");
});

test("malformed controller screenshots fail without returning corrupt image content", async (t) => {
  const { client } = await connection(t, { observe: async () => ({ ...OBSERVATION, screenshot: { data: PNG, mimeType: "image/jpeg" } }) });
  const result = await client.callTool({ name: "trace_computer_observe", arguments: { sessionId: OBSERVATION.sessionId } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "INVALID_SCREENSHOT");
  assert.equal(result.content.some((item) => item.type === "image"), false);
  assert.equal(JSON.stringify(result).includes(PNG), false);
});

test("client cancellation reaches the controller's AbortSignal", async (t) => {
  let entered;
  let aborted;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const abortedPromise = new Promise((resolve) => { aborted = resolve; });
  const { client } = await connection(t, {
    observe: async (_args, { signal }) => new Promise((resolve) => {
      entered();
      signal.addEventListener("abort", () => { aborted(); resolve({ cancelled: true }); }, { once: true });
    }),
  });
  const abort = new AbortController();
  const call = client.callTool({ name: "trace_computer_observe", arguments: { sessionId: OBSERVATION.sessionId } }, { signal: abort.signal });
  const rejection = assert.rejects(call);
  await enteredPromise;
  abort.abort();
  await rejection;
  await abortedPromise;
});

test("stdio runner releases the controller once when its transport disconnects", async (t) => {
  const signalsBefore = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  const { client, server, fake } = await connection(t, {}, true);
  await client.close();
  await server.close();
  await server.close();
  assert.equal(fake.closed, 1);
  assert.equal(process.listenerCount("SIGINT"), signalsBefore.SIGINT);
  assert.equal(process.listenerCount("SIGTERM"), signalsBefore.SIGTERM);
});

test("computer server communicates over real stdio with no stdout logging or desktop access", { timeout: 10_000 }, async (t) => {
  const fixture = `
    const { runComputerServer } = require(process.argv[1]);
    const observation = ${JSON.stringify(OBSERVATION)};
    runComputerServer({ controller: {
      doctor: async () => ({ ready: true, provider: 'synthetic-stdio-fixture' }),
      listWindows: async () => ({ windows: [] }),
      openSession: async () => ({ sessionId: 'fixture-session' }),
      observe: async () => observation,
      act: async () => ({ actionId: 'fixture-action', outcome: 'completed', observation }),
      closeSession: async () => ({ closed: true }),
      close: async () => { process.stderr.write('SYNTHETIC_CONTROLLER_CLOSED\\n'); }
    } }).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", fixture, require.resolve("../src/computer/server.cjs")],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (data) => { stderr += data.toString(); });
  const client = new Client({ name: "trace-stdio-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport, { timeout: 5000 });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  const result = await client.callTool({ name: "trace_computer_observe", arguments: { sessionId: OBSERVATION.sessionId } });
  assertImageResult(result);
  await client.close();
  assert.equal(stderr.trim(), "SYNTHETIC_CONTROLLER_CLOSED");
});

test("observe accepts only an integer accessibilityDepth from 1 to 32; actions cannot carry one", async (t) => {
  const { client, fake } = await connection(t);
  const observed = await client.callTool({ name: "trace_computer_observe", arguments: { sessionId: "s", accessibilityDepth: 12 } });
  assert.notEqual(observed.isError, true);
  assert.deepEqual(fake.calls.find((call) => call.method === "observe").args[0], { sessionId: "s", accessibilityDepth: 12 });
  for (const accessibilityDepth of [0, 33, 8.5, "8"]) {
    const rejected = await client.callTool({ name: "trace_computer_observe", arguments: { sessionId: "s", accessibilityDepth } });
    assert.equal(rejected.isError, true);
  }
  const forged = await client.callTool({ name: "trace_computer_act", arguments: { sessionId: "s", observationId: "o", action: { type: "invoke", elementId: "e", accessibilityDepth: 32 } } });
  assert.equal(forged.isError, true);
  assert.equal(fake.calls.filter((call) => call.method === "observe").length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "act").length, 0);
});
