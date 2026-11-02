'use strict';

// MCP server for TRACE Phone: drives one Android phone through the on-device
// trace-phone agent (src/phone/controller.cjs). Frames are returned as MCP image
// content only when the screen changed; every frame is also saved locally.

const { McpServer } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { z } = require('zod');
const { version } = require('../../package.json');

const MIME = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };

// Android key codes for the names agents use most; any integer code also works.
const KEYS = {
  home: 3, back: 4, call: 5, endcall: 6, dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22,
  volume_up: 24, volume_down: 25, power: 26, camera: 27, tab: 61, space: 62, enter: 66, del: 67,
  menu: 82, search: 84, media_play_pause: 85, page_up: 92, page_down: 93, escape: 111,
  forward_del: 112, app_switch: 187, wakeup: 224, sleep: 223,
};

const text = (max) => z.string().min(1).max(max).regex(/^[^\0]*$/);
const coordinate = z.number().nonnegative().max(100000);
const space = z.enum(['image', 'device']).optional()
  .describe('image (default): pixels of the last returned frame; device: physical screen pixels.');
const selector = z.strictObject({
  text: text(512).optional(), desc: text(512).optional(), resourceId: text(512).optional(),
  className: text(256).optional(), exact: z.boolean().optional(), clickable: z.boolean().optional(),
  index: z.number().int().min(0).max(49).optional(),
}).refine((s) => s.text || s.desc || s.resourceId || s.className, 'selector needs text, desc, resourceId or className')
  .describe('Accessibility node match; text/desc/resourceId are case-insensitive substrings unless exact. index picks among matches.');
const settleSchema = {
  stableMs: z.number().int().min(50).max(5000).optional(),
  timeoutMs: z.number().int().min(100).max(30000).optional(),
};
const imageSchema = {
  maxSide: z.number().int().min(160).max(4096).optional().describe('Long side of the returned image; default 1280.'),
  quality: z.number().int().min(1).max(100).optional(),
};

const actionSchema = z.union([
  z.strictObject({ type: z.enum(['tap', 'long_press']), selector }),
  z.strictObject({ type: z.enum(['tap', 'long_press']), x: coordinate, y: coordinate, space }),
  z.strictObject({ type: z.literal('swipe'), from: z.strictObject({ x: coordinate, y: coordinate }),
    to: z.strictObject({ x: coordinate, y: coordinate }), durationMs: z.number().int().min(10).max(5000).optional(), space }),
  z.strictObject({ type: z.literal('key'), key: z.union([z.enum(Object.keys(KEYS)), z.number().int().min(0).max(400)]) }),
  z.strictObject({ type: z.literal('text'), text: text(4096) }),
  z.strictObject({ type: z.literal('set_text'), selector, value: z.string().max(4096).regex(/^[^\0]*$/) }),
  z.strictObject({ type: z.enum(['scroll_forward', 'scroll_backward', 'focus']), selector }),
]);

/** Map an MCP action to controller.act() arguments. */
function toControllerAction(action) {
  switch (action.type) {
    case 'key': return { key: typeof action.key === 'number' ? action.key : KEYS[action.key] };
    case 'text': return { action: 'text', value: action.text };
    case 'swipe': return { swipe: { from: action.from, to: action.to, durationMs: action.durationMs, space: action.space } };
    case 'set_text': return { action: 'set_text', target: { selector: action.selector }, value: action.value };
    default:
      if (action.selector) return { action: action.type, target: { selector: action.selector } };
      return { action: action.type, target: { x: action.x, y: action.y, space: action.space } };
  }
}

function cleanHeader(header = {}) {
  const { ok, id, ...rest } = header;
  return rest;
}

/** Frame result: header + saved file; the image goes in content only when there is one. */
function frameState({ header, payload, file }) {
  const state = { frame: { ...cleanHeader(header), bytes: payload ? payload.length : 0, file: file || null } };
  const images = payload && payload.length
    ? [{ type: 'image', data: payload.toString('base64'), mimeType: MIME[header.format] || 'image/jpeg' }] : [];
  state.frame.imageIncluded = images.length > 0;
  return { state, images };
}

function result(state, images = []) {
  return { content: [{ type: 'text', text: JSON.stringify(state) }, ...images], structuredContent: state };
}

function errorResult(error) {
  const state = { error: { message: error instanceof Error ? error.message : 'Phone operation failed' } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(state) }], structuredContent: state };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function createPhoneServer({ controller, onError = () => {}, stopOnClose = true } = {}) {
  for (const method of ['connect', 'screen', 'wait', 'act', 'ui', 'find', 'release', 'logcat', 'stop', 'close']) {
    if (typeof controller?.[method] !== 'function') throw new TypeError(`Phone controller requires ${method}()`);
  }
  const server = new McpServer({ name: 'trace-phone', version }, { maxToolInputElements: 64 });
  let closePromise;
  // Closing the server stops the agent and removes its dex, so nothing with
  // shell rights is left listening on the phone.
  const closeController = () => {
    closePromise ??= (async () => {
      try { if (stopOnClose) await controller.stop(); } catch (error) { onError(error); }
      controller.close();
    })();
    return closePromise;
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    try { await originalClose(); } finally { await closeController(); }
  };
  server.server.onclose = () => { void closeController(); };
  server.server.onerror = onError;

  function register(name, description, inputSchema, handler, annotations) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args, context) => {
      try {
        if (context?.mcpReq?.signal?.aborted) throw new Error('Phone request cancelled');
        return await handler(args);
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  register('phone_connect',
    'Pick the phone and start the trace-phone agent. For Wi-Fi debugging pass address (ip:port); add pairAddress and pairCode the first time. With one USB device, call with no arguments.',
    z.strictObject({ address: text(128).optional(), pairAddress: text(128).optional(),
      pairCode: z.string().regex(/^\d{6}$/).optional(), serial: text(128).optional() }),
    async (args) => {
      const out = await controller.connect(args);
      return result({ ...out, agent: cleanHeader(out.agent) });
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });

  register('phone_screen',
    'Capture the screen, scaled and encoded on the phone. Returns the image only when it changed since the last frame (force to always get it). Coordinates in later actions default to this image\'s pixels.',
    z.strictObject({ ...imageSchema, format: z.enum(['jpeg', 'webp', 'png']).optional(), force: z.boolean().optional(),
      region: z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0),
        width: z.number().int().min(1), height: z.number().int().min(1) }).optional().describe('Crop in device pixels.') }),
    async ({ force, ...options }) => {
      const { state, images } = frameState(await controller.screen({ ...options, onlyIfChanged: !force }));
      return result(state, images);
    }, readOnly);

  register('phone_ui',
    'Read the accessibility tree as a compact node list (text, desc, id, bounds in device pixels, flags). With selector, return only matching nodes. release frees the UiAutomation connection so uiautomator dump works again.',
    z.strictObject({ selector: selector.optional(), all: z.boolean().optional().describe('Include non-interesting nodes.'),
      maxNodes: z.number().int().min(1).max(2000).optional(), release: z.boolean().optional() }),
    async ({ selector: wanted, release, ...options }) => {
      const out = wanted ? await controller.find(wanted) : await controller.ui(options);
      if (release) await controller.release();
      return result({ ...cleanHeader(out.header), nodes: out.nodes });
    }, readOnly);

  register('phone_act',
    'Perform one action, wait on the phone until the screen settles, and return the new frame in the same call. Tap by selector (accessibility click on the clickable ancestor) or by point; points default to the last frame\'s image pixels.',
    z.strictObject({ action: actionSchema, ...settleSchema, ...imageSchema }),
    async ({ action, stableMs, timeoutMs, maxSide, quality }) => {
      const out = await controller.act({ ...toControllerAction(action), settleOptions: { stableMs, timeoutMs, maxSide, quality } });
      const { state, images } = frameState(out.after);
      return result({ action: cleanHeader(out.action), ...state }, images);
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

  register('phone_wait',
    'Wait on the phone, without link traffic, until the screen changes from the last frame (until:"change") or stays the same for stableMs (until:"stable"). Returns the frame; met:false means it timed out.',
    z.strictObject({ until: z.enum(['change', 'stable']).optional(), ...settleSchema, ...imageSchema }),
    async (args) => {
      const { state, images } = frameState(await controller.wait(args));
      return result(state, images);
    }, readOnly);

  register('phone_logcat',
    'Return the last lines of the device log (logcat -d). filter uses logcat filterspecs, e.g. "ActivityManager:I *:S".',
    z.strictObject({ lines: z.number().int().min(1).max(5000).optional(), filter: z.string().max(256).regex(/^[\w.*:\s-]+$/).optional() }),
    async (args) => result({ log: await controller.logcat(args) }), readOnly);

  return server;
}

async function runPhoneServer(options = {}) {
  const controller = options.controller ?? require('./controller.cjs').createPhoneController();
  const onError = options.onError ?? ((error) => {
    process.stderr.write(`TRACE Phone: ${error instanceof Error ? error.message : 'Server error'}\n`);
  });
  const server = createPhoneServer({ controller, onError });
  const shutdown = () => { void server.close().catch(onError); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    originalOnClose();
  };
  await server.connect(options.transport ?? new StdioServerTransport());
  return server;
}

module.exports = { createPhoneServer, runPhoneServer, toControllerAction, KEYS };
