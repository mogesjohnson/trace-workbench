'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { normalizeKey, parseAction, KEY_PATTERN, actionSupport, compatibleSupport } = require('../src/computer/action-contract.cjs');
const { createTraceProvider, TOOL_NAMES } = require('../src/method/trace-adapter.cjs');
const cases = [['Ctrl+PLUS','ctrl+shift+vk=0xbb'], ['Shift+Plus','shift+vk=0xbb'], ['NUMPAD1','vk=0x61'],
  ['NUMPAD_ADD','vk=0x6b'], ['Control+SEMICOLON','ctrl+vk=0xba'], ['INSERT','insert'], ['F16','f16'], ['RETURN','enter']];
test('bounded key aliases normalize to one pinned-provider chord without scripts or literal fallback', () => {
  for (const [key, expected] of cases) {
    assert.equal(new RegExp(KEY_PATTERN).test(key), true);
    assert.deepEqual(parseAction({type:'press_key',key}), {type:'press_key',key});
    assert.equal(normalizeKey(key), expected); assert.equal(/\s/.test(expected), false);
  }
  assert.notEqual(normalizeKey('1'), normalizeKey('NUMPAD1'));
  for (const key of ['vk=0x5b','WIN+R','ctrl+a enter','NUMPAD_DIVIDE','NUMPAD_ENTER','RCTRL+A','CTRL++','F17']) {
    assert.equal(new RegExp(KEY_PATTERN).test(key), false);
    assert.throws(() => parseAction({type:'press_key',key}), {code:'invalid_key'});
  }
});
test('connected MCP schema admits aliases, preserves original action, and rejects unsupported syntax', async t => {
  const received = [], controller = Object.fromEntries(['doctor','listWindows','openSession','observe','closeSession','close'].map(name => [name,async()=>({})]));
  controller.act = async ({action}) => { received.push(action); return {outcome:'not_dispatched'}; };
  const [a,b]=InMemoryTransport.createLinkedPair(), server=createComputerServer({controller}); await server.connect(b);
  const client=new Client({name:'keys-test',version:'1'}); await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  for (const [key] of cases) assert.notEqual((await client.callTool({name:'trace_computer_act',arguments:{sessionId:'s',observationId:'o',action:{type:'press_key',key}}})).isError,true);
  assert.equal(received.length,cases.length);
  const result=await client.callTool({name:'trace_computer_act',arguments:{sessionId:'s',observationId:'o',action:{type:'press_key',key:'ctrl+a enter'}}});
  assert.equal(result.isError,true); assert.equal(received.length,cases.length);
});
test('legacy support patterns remain compatible and never acquire invented key extensions', async () => {
  const support=actionSupport(); delete support.actions.press_key.extended;
  assert.equal(compatibleSupport(support),true);
  const provider=createTraceProvider({app:'fixture',windowId:'1',tools:TOOL_NAMES.map(name=>({name,inputSchema:{}})),
    callTool:async()=>({structuredContent:{ready:true,support}})});
  assert.equal((await provider.doctor()).ready,true);
  assert.equal(provider.constraints.nativeSupport.actions.press_key.extended,undefined);
  const invalid=actionSupport(); invalid.actions.press_key.extended.aliases.NUMPAD1='vk=0x31';
  assert.equal(compatibleSupport(invalid),false);
});
