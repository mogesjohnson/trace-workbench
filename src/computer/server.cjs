"use strict";

const { McpServer } = require("@modelcontextprotocol/server");
const { StdioServerTransport } = require("@modelcontextprotocol/server/stdio");
const { z } = require("zod");
const { version } = require("../../package.json");
const { safeError } = require("./controller.cjs");
const { LIMITS, KEY_PATTERN, parseAction } = require("./action-contract.cjs");

const id = z.string().min(1).max(256);
const coordinate = z.number().int().nonnegative();
const point = { x: coordinate, y: coordinate };
const elementId = z.string().min(1).max(LIMITS.elementId).regex(/^[^\0]*$/).describe('Observed element ID; at most 512 UTF-16 code units, without NUL.');
const wheelDelta = z.union([
  z.number().int().min(-LIMITS.wheel).max(-LIMITS.wheelStep).multipleOf(LIMITS.wheelStep),
  z.number().int().min(LIMITS.wheelStep).max(LIMITS.wheel).multipleOf(LIMITS.wheelStep),
]);

// Strict alternatives make coordinate clicks and accessibility clicks distinct.
// Extra fields never disappear silently before reaching the desktop controller.
const actionSchema = z.union([
  z.strictObject({ type: z.literal("activate") }),
  z.strictObject({ type: z.literal("click"), ...point }),
  z.strictObject({ type: z.literal("click"), elementId }),
  z.strictObject({ type: z.literal("type_text"), text: z.string().min(1).max(LIMITS.text).regex(/^[^\0]*$/).describe('1–8192 UTF-16 code units without NUL; supplementary characters use two units.') }),
  z.strictObject({ type: z.literal("press_key"), key: z.string().min(1).max(LIMITS.key).regex(new RegExp(KEY_PATTERN)) }),
  z.strictObject({
    type: z.literal("scroll"), ...point,
    deltaX: z.literal(0), deltaY: wheelDelta,
  }),
  z.strictObject({
    type: z.literal("drag"), fromX: coordinate, fromY: coordinate,
    toX: coordinate, toY: coordinate,
  }),
  z.strictObject({ type: z.literal("invoke"), elementId }),
  z.strictObject({ type: z.literal("set_value"), elementId, value: z.string().max(LIMITS.text).regex(/^[^\0]*$/).describe('0–8192 UTF-16 code units without NUL; empty clears the value.') }),
]);

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const sessionMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function errorResult(error, { action = false, explicitOutcomeAllowed = false, cleanupUnknown = false } = {}) {
  const message = error instanceof Error ? error.message : "Computer operation failed";
  const code = typeof error?.code === "string" ? error.code : "COMPUTER_ERROR";
  const projected = safeError({ ...error, code, message, details: error?.details });
  if (cleanupUnknown) Object.assign(projected, { cleanup: "unknown", inputRecoveryRequired: true });
  const state = { error: projected };
  if (action) {
    state.outcome = explicitOutcomeAllowed && error?.details?.outcome === "not_dispatched" ? "not_dispatched" : "unknown";
    if (projected.outcome) projected.outcome = state.outcome;
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state };
}

// A screenshot is sent once, as MCP image content. Text and structured state keep
// its dimensions and MIME type so hosts can bind pixels to their observation.
function toolResult(value) {
  const images = [];
  function project(item) {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(project);
    const result = {};
    for (const [key, child] of Object.entries(item)) {
      if (key === "screenshot" && child && typeof child === "object") {
        const { data, ...metadata } = child;
        if (typeof data !== "string" || data.length === 0 || metadata.mimeType !== "image/png") {
          const error = new Error("Controller returned an invalid PNG screenshot");
          error.code = "INVALID_SCREENSHOT";
          throw error;
        }
        const contentIndex = images.length + 1;
        images.push({ type: "image", data, mimeType: "image/png" });
        result.screenshot = { ...project(metadata), contentIndex };
      } else {
        result[key] = project(child);
      }
    }
    return result;
  }
  const state = project(value);
  if (state === null || Array.isArray(state) || typeof state !== "object") {
    throw new Error("Controller returned an invalid structured result");
  }
  return { content: [{ type: "text", text: JSON.stringify(state) }, ...images], structuredContent: state };
}

function createComputerServer({ controller, onError = () => {} } = {}) {
  for (const method of ["doctor", "listWindows", "openSession", "observe", "act", "closeSession", "close"]) {
    if (typeof controller?.[method] !== "function") throw new TypeError(`Computer controller requires ${method}()`);
  }
  const server = new McpServer({ name: "trace-computer", version }, { maxToolInputElements: 64 });
  let closePromise;
  const closeController = () => {
    closePromise ??= Promise.resolve().then(() => controller.close());
    return closePromise;
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    try {
      await originalClose();
    } finally {
      await closeController();
    }
  };
  server.server.onclose = () => { void closeController().catch(onError); };
  server.server.onerror = onError;

  function register(name, description, inputSchema, method, annotations) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args, context) => {
      let controllerReturned = false;
      try {
        const signal = context.mcpReq.signal;
        if (signal.aborted) throw Object.assign(new Error("Computer request cancelled"), { code: "CANCELLED" });
        // JSON Schema maxLength counts Unicode code points; enforce the runtime's
        // UTF-16 unit limit before crossing the controller boundary as well.
        if (method === "act") args = { ...args, action: parseAction(args.action) };
        const result = method === "doctor" || method === "listWindows"
          ? await controller[method]({ signal })
          : await controller[method](args, { signal });
        controllerReturned = true;
        return toolResult(result);
      } catch (error) {
        // Projection can fail after successful input. Only a controller rejection
        // carrying explicit dispatch proof may label an act as not dispatched.
        return errorResult(error, { action: method === "act", explicitOutcomeAllowed: !controllerReturned,
          cleanupUnknown: method === "closeSession" || (method === "openSession" && controllerReturned) });
      }
    });
  }

  register("trace_computer_doctor", "Check desktop provider and TRACE readiness without changing the desktop.",
    z.strictObject({}), "doctor", readOnly);
  register("trace_computer_list_windows", "List available desktop windows. Choose an exact returned window ID before opening a session.",
    z.strictObject({}), "listWindows", readOnly);
  register("trace_computer_open_session", "Claim the desktop input lease for one returned window ID. A session does not authorize acting on another window.",
    z.strictObject({ windowId: id }), "openSession", sessionMutation);
  register("trace_computer_observe", "Capture the session window, accessibility elements and fresh PNG. Capture may restore and focus the selected window. accessibilityDepth (1-32, default 8) sets how deep the accessibility tree is read; the action reuses it. Inspect this observation before one action.",
    z.strictObject({ sessionId: id, accessibilityDepth: z.number().int().min(1).max(32).optional() }), "observe", sessionMutation);
  register("trace_computer_act", "Perform one action grounded in the latest observation, then return fresh state. Coordinates are window-relative. not_dispatched means the requested input was never sent; unknown means it may have been. Observe before deciding what to do next; do not retry blindly.",
    z.strictObject({ sessionId: id, observationId: id, action: actionSchema }), "act",
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  register("trace_computer_close_session", "Release this session's desktop lease without closing the target application.",
    z.strictObject({ sessionId: id }), "closeSession", { ...sessionMutation, idempotentHint: true });

  return server;
}

async function runComputerServer(options = {}) {
  const controller = options.controller ?? require("./controller.cjs").createComputerController();
  const onError = options.onError ?? ((error) => {
    process.stderr.write(`TRACE Computer: ${error instanceof Error ? error.message : "Server error"}\n`);
  });
  const server = createComputerServer({ controller, onError });
  const shutdown = () => { void server.close().catch(onError); };
  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    originalOnClose();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.connect(options.transport ?? new StdioServerTransport());
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await server.close();
    throw error;
  }
  return server;
}

module.exports = { createComputerServer, runComputerServer };
