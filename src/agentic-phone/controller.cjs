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
const FRAME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Deletes regular files directly in framesDir last modified more than maxAgeMs ago and returns
// how many it removed. trace-phone owns its frames, so it prunes them itself at startup: auto
// mode denied the same prune as an agent Bash call even with an exact allow rule (A7 C4, 2 Nov 2026).
function pruneFrames({ framesDir = DEFAULT_FRAMES, maxAgeMs = FRAME_MAX_AGE_MS, now = Date.now() } = {}) {
  let entries;
  try { entries = fs.readdirSync(framesDir, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(framesDir, entry.name);
    if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed += 1; }
  }
  return removed;
}

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
  let used = false; // set once this controller tries to reach the agent

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
    used = true;
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

  /** Poll on the phone until the screen changes from the last frame or settles; returns the frame. */
  async function wait({ until = 'stable', stableMs = 300, timeoutMs = 3000, maxSide, quality } = {}) {
    const request = { op: 'wait', until, stableMs, timeoutMs, image: true };
    if (lastHash) request.from = lastHash;
    if (maxSide) request.maxSide = maxSide;
    if (quality) request.quality = quality;
    const { header, payload } = await call(request, { timeoutMs: timeoutMs + 10000 });
    const file = remember(header, payload);
    return { header, payload, file };
  }

  const settle = (options = {}) => wait({ ...options, until: 'stable' });

  /**
   * Pair and/or connect over Wi-Fi when asked, pick the device, then make sure
   * the agent runs. address/pairAddress are host:port; serial picks among several.
   */
  async function connect({ address, pairAddress, pairCode, serial } = {}) {
    const steps = {};
    if (pairCode) steps.pair = (await adb.pair(pairAddress || address, pairCode)).trim();
    if (address) steps.connect = (await adb.connect(address)).trim();
    const devices = await adb.devices();
    const ready = devices.filter((d) => d.state === 'device');
    const chosen = serial || (address && ready.some((d) => d.serial === address) ? address : null)
      || (ready.length === 1 ? ready[0].serial : null);
    if (!chosen) {
      throw new Error(ready.length ? `several devices; pass serial (${ready.map((d) => d.serial).join(', ')})` : 'no device in state "device"');
    }
    if (chosen !== adb.serial) {
      if (agent) { agent.close(); agent = null; }
      info = null; lastFrame = null; lastHash = null;
      adb.setSerial(chosen);
    }
    return { ...steps, devices, serial: chosen, agent: await ensure() };
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

  /**
   * Stop the agent process and remove its dex. Safe to call when nothing runs.
   * onlyIfUsed leaves the phone alone if this controller never reached for the agent: a server that
   * only transcribed has no chosen device and must not stop an agent another session is using.
   */
  async function stop({ onlyIfUsed = false } = {}) {
    if (onlyIfUsed && !used) return { stopped: false, pid: null };
    let pid = info && info.pid;
    if (!pid) { try { pid = (await attach()).pid; } catch { pid = null; } }
    if (agent) { agent.close(); agent = null; }
    await stopPid(pid);
    await adb.exec(`rm -f ${REMOTE_DEX}`);
    info = null;
    return { stopped: Boolean(pid), pid: pid || null };
  }

  return {
    ensure, connect, screen, wait, settle, act, ui, find, stop, toDevice,
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

module.exports = { createPhoneController, pruneFrames, FRAME_MAX_AGE_MS, REMOTE_DEX };
