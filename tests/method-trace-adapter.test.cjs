'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createTraceProvider, ComputerMethod, TOOL_NAMES } = require('../src/method/index.cjs');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

async function fixture(t) {
  const calls=[],windows=[{id:'parent',pid:7,processName:'fixture',processCreationTime:'100',ownerWindowId:null},
    {id:'dialog',pid:7,processName:'fixture',processCreationTime:'100',ownerWindowId:'parent'}];
  let lease=null,count=0;
  const control={outcome:'completed',error:null,observeFails:false,ownerOverride:undefined};
  const controller={
    async doctor(){return {ready:true};},async listWindows(){return {windows};},
    async openSession(args){assert.equal(lease,null);lease={sessionId:`s-${args.windowId}`,window:windows.find(w=>w.id===args.windowId)};calls.push(['open',args]);return lease;},
    async observe(args){calls.push(['observe',args]);if(control.observeFails)throw new Error('capture failed');
      return {...lease,observationId:`capture-${++count}`,bounds:{x:0,y:0,width:1,height:1},elements:[],
        accessibility:{depth:args.accessibilityDepth||8,truncated:false},
        focused:{available:true,hasFocus:true,elementId:'editor',name:'Report',controlType:'Edit',provenance:'winapp-get-focused'},
        targetState:{enabled:true,ownerWindowId:control.ownerOverride===undefined?lease.window.ownerWindowId:control.ownerOverride},
        screenshot:{data:PNG,mimeType:'image/png',width:1,height:1,sha256:'a'.repeat(64)}};},
    async act(args){calls.push(['act',args]);return {outcome:control.outcome,error:control.error,
      preparation:[{step:'activation',status:'foreground'}]};},
    async closeSession(args){calls.push(['close',args]);lease=null;return {closed:true};},async close(){lease=null;}
  };
  const [a,b]=InMemoryTransport.createLinkedPair(),server=createComputerServer({controller});await server.connect(b);
  const client=new Client({name:'method-adapter-test',version:'1'});await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  return {client,calls,windows,control,get lease(){return lease;}};
}

test('METHOD-OBSERVE real six-tool schema routes depth12 only into observe and exposes focus',async t=>{
  const f=await fixture(t),p=createTraceProvider({client:f.client,app:'fixture',windowId:'parent',accessibilityDepth:12});
  assert.equal((await p.doctor()).ready,true);const [target]=await p.discover({environment:'local',app:'fixture'});
  const before=await p.observe({target});assert.equal(before.evidence.state.accessibility.depth,12);
  assert.equal(before.evidence.focus.elementId,'editor');
  await p.act({target,observationId:before.id,capability:'native-action',payload:{type:'activate'}});
  assert.equal(f.calls.find(c=>c[0]==='observe')[1].accessibilityDepth,12);
  assert.equal(Object.hasOwn(f.calls.find(c=>c[0]==='act')[1],'accessibilityDepth'),false);
  assert.equal((await p.close({target})).applicationClosed,false);
});

test('live schema discovery rejects unavailable depth or missing six-tool provider',async()=>{
  const legacy=TOOL_NAMES.map(name=>({name,inputSchema:{type:'object',properties:{}}}));
  let calls=0;const callTool=async()=>{calls++;return {structuredContent:{ready:true}};};
  const p=createTraceProvider({tools:legacy,callTool,app:'fixture',windowId:'parent',accessibilityDepth:12});
  assert.equal((await p.doctor()).code,'depth-unsupported');assert.equal(calls,0);
  const missing=createTraceProvider({tools:legacy.slice(1),callTool,app:'fixture',windowId:'parent'});
  assert.equal((await missing.doctor()).code,'schema-unavailable');
});

test('METHOD-OUTCOME known rejection, preparation and cleanup uncertainty remain distinct',async t=>{
  const f=await fixture(t),p=createTraceProvider({client:f.client,app:'fixture',windowId:'parent'});await p.doctor();
  const [target]=await p.discover({environment:'local',app:'fixture'});
  let observation=await p.observe({target});f.control.outcome='not_dispatched';f.control.error={code:'window_blocked',outcome:'not_dispatched'};
  let receipt=await p.act({target,observationId:observation.id,capability:'native-action',payload:{type:'activate'}});
  assert.equal(receipt.delivery,'not-delivered');assert.equal(receipt.blocked,true);assert.equal(receipt.cleanup,undefined);
  assert.deepEqual(receipt.preparation,[{step:'activation',status:'foreground'}]);
  observation=await p.observe({target});f.control.outcome='unknown';f.control.error={code:'cancelled',inputRecoveryRequired:true,recovery:{released:false}};
  receipt=await p.act({target,observationId:observation.id,capability:'native-action',payload:{type:'activate'}});
  assert.equal(receipt.delivery,'unknown');assert.equal(receipt.cleanup,'unknown');
  await p.close({target});
});

test('failed refresh invalidates adapter capture before awaited protocol error',async t=>{
  const f=await fixture(t),p=createTraceProvider({client:f.client,app:'fixture',windowId:'parent'});await p.doctor();
  const [target]=await p.discover({environment:'local',app:'fixture'}),before=await p.observe({target});
  f.control.observeFails=true;await assert.rejects(p.observe({target}),{code:'COMPUTER_ERROR'});
  await assert.rejects(p.act({target,observationId:before.id,capability:'native-action',payload:{type:'activate'}}),{code:'stale-target'});
  assert.equal(f.calls.filter(c=>c[0]==='act').length,0);await p.close({target});
});

test('METHOD-MODAL exact native owner relation permits release/dialog/reattach across one lease',async t=>{
  const f=await fixture(t),providers=['parent','dialog'].map(windowId=>createTraceProvider({client:f.client,app:windowId,windowId}));
  await Promise.all(providers.map(p=>p.doctor()));
  const m=new ComputerMethod({providers,verifyStep:async()=> 'confirmed',verifyEffect:async()=> 'confirmed'});
  const native=(id,app,parentStepId)=>({id,checkId:id,capability:'native-action',
    target:{environment:'local',app,kind:'app',windowId:app,...(parentStepId?{parentStepId}:{})}});
  m.start({goalId:'modal',effects:[{id:'save',checkId:'saved',steps:[native('open','parent'),native('submit','dialog','open')]}]});
  await m.discover('save','open');await m.observe('save','open');f.control.outcome='not_dispatched';f.control.error={code:'window_blocked'};
  await m.execute('save','open',{type:'activate'});await m.discover('save','submit');await m.observe('save','submit');
  assert.equal(f.lease.window.id,'dialog');
  await m.discover('save','open');await m.observe('save','open');assert.equal(f.lease.window.id,'parent');
  await m.close();assert.equal(f.lease,null);assert.equal(f.calls.filter(c=>c[0]==='close').length,3);
});

test('process lifetime replacement is rejected even when HWND/PID/name are reused',async t=>{
  const f=await fixture(t),p=createTraceProvider({client:f.client,app:'fixture',windowId:'parent'});await p.doctor();
  await p.discover({environment:'local',app:'fixture'});f.windows[0].processCreationTime='200';
  await assert.rejects(p.discover({environment:'local',app:'fixture'}),{code:'target-changed'});
});

test('invalid native payload is rejected by canonical validator before an attempt is consumed',async t=>{
  const f=await fixture(t),p=createTraceProvider({client:f.client,app:'fixture',windowId:'parent'});await p.doctor();
  const m=new ComputerMethod({providers:[p],verifyStep:async()=> 'confirmed',verifyEffect:async()=> 'confirmed'});
  m.start({goalId:'validation',effects:[{id:'effect',checkId:'saved',steps:[{id:'input',checkId:'input',capability:'native-action',
    target:{environment:'local',app:'fixture',kind:'app',windowId:'parent'}}]}]});
  await m.discover('effect','input');await m.observe('effect','input');
  await assert.rejects(m.execute('effect','input',{type:'activate',command:'arbitrary'}),{code:'invalid_action'});
  assert.equal(m.status().effects[0].steps[0].attempts,0);
  assert.equal(f.calls.filter(c=>c[0]==='act').length,0);
  await m.execute('effect','input',{type:'activate'});await m.close();
});

test('same-HWND dialog reownership invalidates the prior discovered parent relation',async t=>{
  const f=await fixture(t),p=createTraceProvider({client:f.client,app:'dialog',windowId:'dialog'});await p.doctor();
  const [target]=await p.discover({environment:'local',app:'dialog'});assert.equal(target.ownerWindowId,'parent');
  const before=await p.observe({target});f.control.ownerOverride='unrelated';
  await assert.rejects(p.observe({target}),{code:'ownership-changed'});
  await assert.rejects(p.act({target,observationId:before.id,capability:'native-action',payload:{type:'activate'}}),{code:'stale-target'});
  assert.equal(f.calls.filter(c=>c[0]==='act').length,0);await p.close({target});
});
