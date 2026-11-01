'use strict';

// Phone controller: keeps one agent connection through the adb server, starts
// the agent when it is not running, saves every frame locally and converts
// image-space coordinates from the last frame back to device pixels.

const fs = require('node:fs');
const path = require('node:path');
const { createAdbClient } = require('./adb.cjs');
const { createAgentClient, AGENT_VERSION } = require('./agent.cjs');

const REMOTE_DEX = '/data/local/tmp/trace-phone.dex';
const DEFAULT_DEX = path.join(__dirname, '..', '..', '.runtime', 'phone', 'build', 'classes.dex');
const DEFAULT_FRAMES = path.join(__dirname, '..', '..', '.runtime', 'phone', 'frames');

function createPhoneController({
  adb = createAdbClient(),
  dexPath = DEFAULT_DEX,
  framesDir = DEFAULT_FRAMES,
  agentName = 'trace-phone',
  startTimeoutMs = 5000,
  now = () => Date.now(),
} = {}) {
  let agent = null;
  let info = null;
  let lastFrame = null; // header of the last encoded frame (scale, region)
  let lastHash = null;
  let frameCount = 0;

  async function attach() {
    const { socket, leftover } = await adb.openAbstract(agentName);
    const client = createAgentClient(socket, leftover);
    const { header } = await client.call({ op: 'hello' }, { timeoutMs: 5000 });
    if (String(header.version) !== AGENT_VERSION) {
      client.close();
      throw Object.assign(new Error(`agent version ${header.version}, host expects ${AGENT_VERSION}`), { versionMismatch: header });
    }
    agent = client;
    info = header;
    return header;
  }

  async function start() {
    if (!fs.existsSync(dexPath)) throw new Error(`agent dex not built: ${dexPath} (run node scripts/build-phone-agent.cjs)`);
    await adb.push(fs.readFileSync(dexPath), REMOTE_DEX);
    const output = await adb.spawn(`CLASSPATH=${REMOTE_DEX} app_process / trace.phone.Main ${agentName}`);
    await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`agent did not start within ${startTimeoutMs} ms: ${text.trim()}`)), startTimeoutMs);
      output.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (text.includes('listening')) { clearTimeout(timer); resolve(); }
      });
      output.once('close', () => { clearTimeout(timer); if (!text.includes('listening')) reject(new Error(`agent exited: ${text.trim()}`)); });
    });
  }

  async function ensure() {
    if (agent && !agent.closed) return info;
    agent = null;
    try { return await attach(); }
    catch (error) {
      if (error.versionMismatch) await stopPid(error.versionMismatch.pid);
    }
    await start();
    return attach();
  }

  /** One retry on a dropped link (Wi-Fi blips); agent errors are not retried. */
  async function call(request, options) {
    await ensure();
    try { return await agent.call(request, options); }
    catch (error) {
      if (!agent.closed) throw error;
      agent = null;
      await ensure();
      return agent.call(request, options);
    }
  }

  async function stopPid(pid) {
    if (Number.isInteger(pid) && pid > 0) await adb.exec(`kill ${pid}`);
  }

  function saveFrame(header, payload) {
    fs.mkdirSync(framesDir, { recursive: true });
    frameCount += 1;
    const file = path.join(framesDir, `${now()}-${String(frameCount).padStart(4, '0')}.${header.format === 'png' ? 'png' : header.format === 'webp' ? 'webp' : 'jpg'}`);
    fs.writeFileSync(file, payload);
    return file;
  }

  function remember(header, payload) {
    if (header.hash) lastHash = header.hash;
    if (!payload.length) return null;
    lastFrame = header;
    return saveFrame(header, payload);
  }

  /** Map a point from the last frame's image space to device pixels. */
  function toDevice(x, y) {
    if (!lastFrame) throw new Error('no frame yet: call screen first or pass space:"device"');
    return {
      x: Math.round(lastFrame.regionX + x / lastFrame.scale),
      y: Math.round(lastFrame.regionY + y / lastFrame.scale),
    };
  }

  async function screen({ onlyIfChanged = true, maxSide, quality, format, region } = {}) {
    const request = { op: 'screen' };
    if (onlyIfChanged && lastHash) request.ifChangedFrom = lastHash;
    if (maxSide) request.maxSide = maxSide;
    if (quality) request.quality = quality;
    if (format) request.format = format;
    if (region) request.region = region;
    const { header, payload } = await call(request);
    const file = remember(header, payload);
    return { header, payload, file };
  }

  async function settle({ stableMs = 300, timeoutMs = 3000, maxSide, quality } = {}) {
    const request = { op: 'wait', until: 'stable', stableMs, timeoutMs, image: true };
    if (lastHash) request.from = lastHash;
    if (maxSide) request.maxSide = maxSide;
    if (quality) request.quality = quality;
    const { header, payload } = await call(request, { timeoutMs: timeoutMs + 10000 });
    const file = remember(header, payload);
    return { header, payload, file };
  }

  /**
   * One action, then wait for the screen to settle and return the new frame.
   * target: { selector } (accessibility node), or { x, y, space: 'image'|'device' }.
   */
  async function act({ action = 'tap', target = {}, value, key, swipe, settleOptions } = {}) {
    let result;
    if (key !== undefined) {
      result = await call({ op: 'key', code: key });
    } else if (action === 'text') {
      result = await call({ op: 'text', text: String(value ?? '') });
    } else if (swipe) {
      const a = swipe.space === 'device' ? swipe.from : toDevice(swipe.from.x, swipe.from.y);
      const b = swipe.space === 'device' ? swipe.to : toDevice(swipe.to.x, swipe.to.y);
      result = await call({ op: 'swipe', x1: a.x, y1: a.y, x2: b.x, y2: b.y, durationMs: swipe.durationMs || 250 });
    } else if (target.selector) {
      const nodeAction = { tap: 'click', long_press: 'long_click' }[action] || action;
      result = await call({ op: 'node', ...target.selector, action: nodeAction, value });
    } else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      const point = target.space === 'device' ? { x: Math.round(target.x), y: Math.round(target.y) } : toDevice(target.x, target.y);
      result = await call({ op: 'tap', x: point.x, y: point.y, holdMs: action === 'long_press' ? 700 : 40 });
    } else {
      throw new Error('act needs a selector, a point, a key, a swipe or action:"text"');
    }
    const after = await settle(settleOptions);
    return { action: result.header, after };
  }

  async function ui(options = {}) {
    const { header, payload } = await call({ op: 'ui', ...options });
    return { header, nodes: JSON.parse(payload.toString('utf8') || '[]') };
  }

  async function find(selector) {
    const { header, payload } = await call({ op: 'find', ...selector });
    return { header, nodes: JSON.parse(payload.toString('utf8') || '[]') };
  }

  /** Stop the agent process and remove its dex. Safe to call when nothing runs. */
  async function stop() {
    let pid = info && info.pid;
    if (!pid) { try { pid = (await attach()).pid; } catch { pid = null; } }
    if (agent) { agent.close(); agent = null; }
    await stopPid(pid);
    await adb.exec(`rm -f ${REMOTE_DEX}`);
    info = null;
    return { stopped: Boolean(pid), pid: pid || null };
  }

  return {
    ensure, screen, settle, act, ui, find, stop, toDevice,
    release: () => call({ op: 'release' }).then((r) => r.header),
    logcat: async ({ lines = 200, filter } = {}) => {
      const n = Math.max(1, Math.min(5000, Math.floor(lines)));
      const spec = filter && /^[\w.*:\s-]+$/.test(filter) ? ` ${filter}` : '';
      return (await adb.exec(`logcat -d -t ${n}${spec}`)).toString('utf8');
    },
    get info() { return info; },
    get lastFrame() { return lastFrame; },
    close() { if (agent) agent.close(); agent = null; },
  };
}

module.exports = { createPhoneController, REMOTE_DEX };
