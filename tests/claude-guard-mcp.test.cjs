'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { upstreamState } = require('../scripts/accept-claude-host.cjs');

test('Claude forwarding preserves proven non-delivery through both real MCP boundaries; unproved errors remain unknown', async t => {
  for (const proved of [true, false]) {
    let calls = 0;
    const controller = {
      doctor: async () => ({ ready: true }), listWindows: async () => ({ windows: [] }),
      openSession: async () => ({}), observe: async () => ({}),
      closeSession: async () => ({ closed: true }), close: async () => {},
      act: async () => {
        calls++;
        throw Object.assign(new Error('Use the latest observation.'), {
          code: 'stale_observation', ...(proved ? { details: { outcome: 'not_dispatched' } } : {}),
        });
      },
    };
    const connect = async controller => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = createComputerServer({ controller }); await server.connect(b);
      const client = new Client({ name: 'claude-forwarding-regression', version: '1.0.0' });
      await client.connect(a);
      t.after(async () => { await client.close(); await server.close(); });
      return client;
    };
    const upstream = await connect(controller);
    const forwarded = { ...controller, act: async args => upstreamState(
      await upstream.callTool({ name: 'trace_computer_act', arguments: args }), 'act') };
    const host = await connect(forwarded);
    const result = await host.callTool({ name: 'trace_computer_act', arguments: {
      sessionId: 'owned', observationId: 'consumed', action: { type: 'invoke', elementId: 'counter' },
    } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'stale_observation');
    assert.equal(result.structuredContent.outcome, proved ? 'not_dispatched' : 'unknown');
    assert.equal(JSON.parse(result.content[0].text).outcome, result.structuredContent.outcome);
    assert.equal(calls, 1);
  }
});
