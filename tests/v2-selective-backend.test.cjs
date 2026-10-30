'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WinappBackend, BackendError } = require('../src/computer/winapp-backend.cjs');

const rect = { x: 10, y: 20, width: 100, height: 80 };
const window = { id: '123', pid: 456, processName: 'Fixture' };

function fixture() {
  const calls = [];
  const backend = new WinappBackend();
  backend.identity = async () => { calls.push('identity'); return window; };
  backend.bridge = async verb => {
    calls.push(verb);
    return { frameBounds: rect, windowBounds: rect, minimized: false, enabled: true };
  };
  backend.inspect = async (_window, _signal, depth) => {
    calls.push(`inspect:${depth}`);
    return { bounds: rect, rootSelector: 'root', elements: [{ id: 'root' }], depth };
  };
  backend.focused = async () => { calls.push('focus'); return { available: true, hasFocus: false }; };
  backend.command = async verb => { calls.push(verb); throw new Error('Unexpected screenshot'); };
  return { backend, calls };
}

test('no-image observation retains identity, geometry, UIA and focus bracketing', async () => {
  const { backend, calls } = fixture();
  const result = await backend.observe({ window, depth: 4, includeScreenshot: false });
  assert.deepEqual(calls, ['identity', 'bounds', 'inspect:4', 'bounds', 'identity', 'identity', 'inspect:1', 'bounds', 'focus']);
  assert.equal(result.elements[0].id, 'root');
  assert.deepEqual(result.bounds, rect);
  assert.equal('screenshot' in result, false);
  assert.equal('captureMethod' in result, false);
  assert.equal('actionCoordinateSpace' in result, false);
});

test('no-image observation rejects invalid options before native work', async () => {
  const { backend, calls } = fixture();
  await assert.rejects(backend.observe({ window, includeScreenshot: 'false' }), { code: 'invalid_observation' });
  await assert.rejects(backend.observe({ window, includeScreenshot: false, screenshotPath: path.resolve('frame.png') }), { code: 'invalid_screenshot_path' });
  assert.deepEqual(calls, []);
});

test('no-image observation rejects UIA, geometry and identity drift', async () => {
  for (const drift of ['uia', 'geometry', 'identity']) {
    const { backend } = fixture();
    if (drift === 'uia') {
      const inspect = backend.inspect;
      backend.inspect = async (...args) => {
        const state = await inspect(...args);
        return args[2] === 1 ? { ...state, bounds: { ...rect, x: 11 } } : state;
      };
    } else if (drift === 'geometry') {
      const bridge = backend.bridge;
      let reads = 0;
      backend.bridge = async (...args) => {
        const state = await bridge(...args);
        return ++reads === 3 ? { ...state, frameBounds: { ...rect, x: 11 } } : state;
      };
    } else {
      let reads = 0;
      backend.identity = async () => {
        if (++reads === 3) throw new BackendError('window_identity_changed', 'Changed.');
        return window;
      };
    }
    await assert.rejects(backend.observe({ window, includeScreenshot: false }), {
      code: drift === 'identity' ? 'window_identity_changed' : 'window_moved'
    });
  }
});

test('default full capture still rejects mismatched native provenance', async () => {
  const { backend } = fixture();
  backend.command = async () => ({ hwnd: '999', processId: 456, filePath: path.resolve('frame.png') });
  await assert.rejects(backend.observe({ window, screenshotPath: path.resolve('frame.png') }), { code: 'invalid_screenshot' });
});

test('pinned no-image observation validates both bounds receipts and independent final identity', async () => {
  for (const changed of ['none', 'initial', 'adjacent', 'final']) {
    const { backend, calls } = fixture();
    const pinned = { ...window, processCreationTime: '1000', sessionId: 2 };
    backend.identity = WinappBackend.prototype.identity.bind(backend);
    let boundsReads = 0;
    backend.command = async verb => {
      calls.push(verb);
      assert.equal(verb, 'status');
      return { hwnd: pinned.id, processId: pinned.pid, processName: pinned.processName, coordinateSpace: 'physical-screen-pixels' };
    };
    backend.bridge = async verb => {
      calls.push(verb);
      const receipt = { hwnd: pinned.id, pid: pinned.pid, processCreationTime: '1000', sessionId: 2,
        frameBounds: rect, windowBounds: rect, minimized: false, enabled: true };
      if (verb === 'bounds') boundsReads++;
      if ((changed === 'initial' && verb === 'bounds' && boundsReads === 1)
        || (changed === 'adjacent' && verb === 'bounds' && boundsReads === 2)
        || (changed === 'final' && verb === 'identity')) receipt.processCreationTime = 'changed';
      return receipt;
    };
    const observation = backend.observe({ window: pinned, includeScreenshot: false });
    if (changed === 'none') {
      const result = await observation;
      assert.equal('screenshot' in result, false);
      assert.deepEqual(calls, ['status', 'bounds', 'inspect:8', 'bounds', 'status', 'status', 'identity', 'inspect:1', 'bounds', 'focus']);
    } else {
      await assert.rejects(observation, { code: 'window_identity_changed' });
      assert.equal(calls.includes('identity'), changed === 'final');
    }
    assert.equal(calls.includes('screenshot'), false);
  }
});
