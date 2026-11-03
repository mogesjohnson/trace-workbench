"use strict";

const { McpServer } = require("@modelcontextprotocol/server");
const { StdioServerTransport } = require("@modelcontextprotocol/server/stdio");
const { z } = require("zod");
const { version } = require("../../package.json");
const { safeError } = require("./controller.cjs");
const { LIMITS, KEY_PATTERN, ACCESSIBILITY_ACTIONS, parseAction } = require("./action-contract.cjs");
const { performance } = require("node:perf_hooks");

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
const clickOptions = { button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(2).optional() };
const actionSchema = z.union([
  z.strictObject({ type: z.literal("activate") }),
  z.strictObject({ type: z.literal("click"), ...point, ...clickOptions }),
  z.strictObject({ type: z.literal("click"), elementId, ...clickOptions }),
  z.strictObject({ type: z.literal("type_text"), text: z.string().min(1).max(LIMITS.text).regex(/^[^\0]*$/).describe('1–8192 UTF-16 code units without NUL; supplementary characters use two units.') }),
  z.strictObject({ type: z.literal("press_key"), key: z.string().min(1).max(LIMITS.key).regex(new RegExp(KEY_PATTERN)) }),
  z.strictObject({
    type: z.literal("scroll"), ...point,
    deltaX: z.literal(0), deltaY: wheelDelta,
  }),
  z.strictObject({ type: z.literal("scroll"), ...point, placement: z.literal('point'),
    deltaX: z.union([z.literal(0), wheelDelta]), deltaY: z.union([z.literal(0), wheelDelta]) }),
  z.strictObject({
    type: z.literal("drag"), fromX: coordinate, fromY: coordinate,
    toX: coordinate, toY: coordinate,
  }),
  z.strictObject({ type: z.literal("invoke"), elementId }),
  z.strictObject({ type: z.literal('accessibility_action'), elementId, action: z.enum(ACCESSIBILITY_ACTIONS) }),
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
  const started = performance.now();
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
  const jsonText = JSON.stringify(state);
  const result = { content: [{ type: "text", text: jsonText }, ...images], structuredContent: state };
  const jsonTextBytes = Buffer.byteLength(jsonText);
  const imageBase64Bytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data), 0);
  // Every result reports its own size, so a host or agent can see what each call costs.
  result._meta = { "trace/response": { responseBytes: jsonTextBytes + imageBase64Bytes, jsonTextBytes, imageBase64Bytes, imageCount: images.length } };
  if (value.metrics || value.observation?.metrics) {
    result._meta["trace/projection"] = { version: 1, clock: "process-monotonic",
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      jsonTextBytes, imageBase64Bytes, imageCount: images.length };
  }
  return result;
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
        // listWindows takes its filters with the call options.
        const result = method === "doctor" ? await controller.doctor({ ...args, signal })
          : method === "listWindows" ? await controller.listWindows({ ...args, signal })
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

  register("trace_computer_doctor", "Check desktop provider and TRACE readiness without changing the desktop. support is compact (action names and the sha256 of the full descriptor) unless verbose is true.",
    z.strictObject({ verbose: z.boolean().optional().describe('Return the full action support descriptor.') }), "doctor", readOnly);
  register("trace_computer_list_windows", "List desktop windows as id, pid, processName, title and size. Tiny, shell and helper windows are omitted (counted in omitted) unless verbose is true; verbose also returns every identity field. processName (exact, .exe optional) and title (substring) narrow the list; both ignore case.",
    z.strictObject({ verbose: z.boolean().optional(), processName: z.string().min(1).max(256).optional(), title: z.string().min(1).max(256).optional() }), "listWindows", readOnly);
  register("trace_computer_open_session", "Claim the desktop input lease for one window ID. An ID missing from the last listing (a just-launched window or a new dialog) is looked up once, so no new listing is needed. A session does not authorize acting on another window.",
    z.strictObject({ windowId: id }), "openSession", sessionMutation);
  register("trace_computer_observe", "Observe the exact session window. Default full mode returns controls plus PNG and authorizes one action; screenshot none|scaled|full (default full) chooses the image, and full mode with screenshot none still authorizes one action. A scaled image reports scale.factor: multiply its pixels by it for window coordinates; accessibility and screenshot modes return evidence only and revoke input authority. Observe full before input. Modes may restore/focus. Screenshot mode captures the exact DWM frame through PrintWindow without UIA; noncooperating apps may be unsupported. Full/accessibility require a readable UIA root. ownedModal means the window is disabled by an owned dialog; observe with followModal true to work in it. accessibilityDepth (1-32, default 8) controls UIA inspection; start at 2 and deepen only when needed. Offscreen nodes are omitted unless includeOffscreen is true. rootElementId observes only that element's subtree and interactiveOnly keeps only interactive controls; window bounds, coordinates and the image stay window-level, and the next action re-inspects with the same scope. Optional documentElementId in accessibility mode reads bounded TextPattern document/selection from that exact observed control; unavailable, empty and truncated differ. No label fallback, clipboard or selection mutation.",
    z.strictObject({ sessionId: id, accessibilityDepth: z.number().int().min(1).max(32).optional(),
      mode: z.enum(['full', 'accessibility', 'screenshot']).optional(), documentElementId: elementId.optional(),
      includeOffscreen: z.boolean().optional().describe('Include offscreen UIA nodes (default false; omitted nodes are counted in accessibility.offscreenOmitted).'),
      screenshot: z.enum(['none', 'scaled', 'full']).optional().describe('Image to return: none, scaled (longest edge at most 1280 px) or full. Default full; accessibility mode allows only none, screenshot mode not none.'),
      rootElementId: elementId.optional().describe('Observe only this observed element and its descendants.'),
      interactiveOnly: z.boolean().optional().describe('Keep only interactive controls, each under its nearest kept ancestor.'),
      metrics: z.boolean().optional().describe('Return stage timings and byte counts (default false).'),
      followModal: z.boolean().optional().describe('Retarget the session at the owned modal reported as ownedModal; it returns to the owner when the modal closes.') })
      .refine(args => args.documentElementId === undefined || args.mode === 'accessibility',
        { message: 'documentElementId requires accessibility mode.', path: ['documentElementId'] })
      .refine(args => args.screenshot === undefined || (args.mode === 'accessibility' ? args.screenshot === 'none' : !(args.mode === 'screenshot' && args.screenshot === 'none')),
        { message: 'screenshot does not fit this mode.', path: ['screenshot'] })
      .refine(args => args.mode !== 'screenshot' || (args.rootElementId === undefined && args.interactiveOnly === undefined),
        { message: 'Screenshot mode has no accessibility tree to scope.', path: ['rootElementId'] }), "observe", sessionMutation);
  register("trace_computer_act", "Perform one action grounded in the latest observation. TRACE always re-observes afterwards and returns the next observationId, which authorizes one further action. returnObservation: summary (default) returns focus, target state and a bounded element diff without an image; full returns the complete observation (with the image setting of the consumed observation); none returns only the outcome and observationId. Observe again when the summary is not enough. scopeLost: true means the scope root disappeared and the refresh covered the whole window. target_closed_after_dispatch means the input was sent and the window then closed (expected after Save, Close or OK); with returnedToOwner true the session is back on the owner window with a fresh observationId. Coordinates are window-relative. not_dispatched means the requested input was never sent; unknown means it may have been. Observe before deciding what to do next; do not retry blindly.",
    z.strictObject({ sessionId: id, observationId: id, action: actionSchema,
      returnObservation: z.enum(['full', 'summary', 'none']).optional().describe('full, summary (default) or none.') }), "act",
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  if (typeof controller.launch === "function") register("trace_computer_launch", "Start an application without a shell and return its new windows in the list_windows form; open_session accepts their IDs directly. app is an App Paths name (such as notepad; .exe optional), settings or a packaged AUMID (PackageFamilyName!AppId), or an allowlisted Settings page: ms-settings:display, sound, notifications, power, storage, about, bluetooth, network-status, personalization, dateandtime or windowsupdate. Other URIs and paths are unsupported. Close any open session first. handedOff: true means another process owns the new windows (single-instance apps; packaged apps hosted by ApplicationFrameHost); they are still new and run the requested app. A packaged app that is already open returns code already_running and is not touched. An unknown outcome is never relaunched automatically.",
    z.strictObject({ app: z.string().min(1).max(128) }), "launch", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
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
