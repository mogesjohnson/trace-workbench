'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=';

test('MCP exposes selective schema and projects only present images', async t => {
  const calls = [];
  const controller = {
    async doctor() { return { ready: true }; }, async listWindows() { return { windows: [] }; },
    async openSession() { return { sessionId: 's' }; },
    async observe(args) {
      calls.push(args);
      const value = { sessionId: 's', observationId: 'o', bounds: { x: 0, y: 0, width: 1, height: 1 } };
      if (args.mode === 'accessibility') return { ...value, mode: args.mode, actionable: false, elements: [] };
      return { ...value, ...(args.mode ? { mode: args.mode, actionable: false } : {}),
        screenshot: { data: png, mimeType: 'image/png', width: 1, height: 1 } };
    },
    async act() { return {}; }, async closeSession() { return {}; }, async close() {},
  };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller });
  await server.connect(b);
  const client = new Client({ name: 'selective-test', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(item => item.name === 'trace_computer_observe');
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['full', 'accessibility', 'screenshot']);
  const call = mode => client.callTool({ name: tool.name, arguments: { sessionId: 's', ...(mode ? { mode } : {}) } });
  const a11y = await call('accessibility');
  assert.equal(a11y.structuredContent.actionable, false);
  assert.equal(a11y.content.filter(item => item.type === 'image').length, 0);
  const image = await call('screenshot');
  assert.equal(image.structuredContent.screenshot.contentIndex, 1);
  assert.equal(image.content[1].data, png);
  const full = await call(); assert.equal(full.content[1].data, png);
  const count = calls.length;
  const invalid = await call('unknown'); assert.equal(invalid.isError, true); assert.equal(calls.length, count);
});
