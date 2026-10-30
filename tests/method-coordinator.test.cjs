'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComputerMethod, ProviderRegistry } = require('../src/method/index.cjs');

function provider(options = {}) {
  const store = { focused: false, text: '', saved: false }, calls = [];
  let count = 0;
  const p = { id: 'native', available: true, channel: 'desktop', usesDesktop: true,
    environments: ['local'], apps: ['writer', 'dialog'], capabilities: ['edit'], revision: 0,
    receipt: null, closeResult: 'confirmed', calls, store,
    async discover(t) { calls.push(['discover', t.app]); return [{ environment: t.environment, app: t.app,
      windowId: t.windowId || t.app, ownerWindowId: t.app === 'dialog' ? 'writer' : null,
      identity: { pid: 1, processName: 'fixture', generation: 'g1' } }]; },
    async observe({ target }) { calls.push(['observe', target.app]); return { id: `o${++count}`, target,
      evidenceKey: JSON.stringify([store,p.revision]), evidence: { ...store }, secret: 'PRIVATE_SCREEN_CONTENT' }; },
    async act({ payload }) {
      calls.push(['act', payload]); const receipt = p.receipt; p.receipt = null;
      if (receipt?.throw) throw new Error('lost reply');
      if (receipt?.apply !== false) {
        if (payload.type === 'focus') store.focused = true;
        if (payload.type === 'type') store.text = payload.text;
        if (payload.type === 'save') store.saved = true;
      }
      return receipt || { delivery: 'delivered' };
    },
    async close({ target, releaseOnly }) { calls.push(['close', target.app, releaseOnly]); return { cleanup: p.closeResult }; },
    async recover() { return { verified: true, inputReleased: true, ownedProcessExited: true }; },
    ...options };
  return p;
}
const step = (id, extra = {}) => ({ id, checkId: id, capability: 'edit',
  target: { environment: 'local', app: 'writer', kind: 'app' }, ...extra });
const effects = () => [{ id: 'report', checkId: 'saved-report', steps: [step('focus'),step('type'),step('save')] }];
const checkStep = ({ checkId, after }) => ({ focus:after.evidence.focused,
  type:after.evidence.text === 'hello', save:after.evidence.saved })[checkId] ? 'confirmed' : 'absent';
function setup(p = provider(), spec = effects(), extra = {}) {
  const m = new ComputerMethod({ providers: [p], verifyStep: checkStep,
    verifyEffect: ({ after }) => after.evidence.saved && after.evidence.text === 'hello' ? 'confirmed' : 'absent', ...extra });
  m.start({ goalId:'prepare-report', effects:spec }); return m;
}
async function ready(m,id='focus',effect='report') {await m.discover(effect,id);await m.observe(effect,id);}
const rejects=(promise,code)=>assert.rejects(promise,e=>e.code===code);

test('METHOD-EFFECT focus/type/save use independent step budgets and final effect predicate',async()=>{
  const p=provider(),m=setup(p);
  for(const [id,payload] of [['focus',{type:'focus'}],['type',{type:'type',text:'hello'}],['save',{type:'save'}]]) {
    await ready(m,id);await m.execute('report',id,payload);await m.verifyStep('report',id);
    assert.equal(m.status().lifecycle,'active');
  }
  assert.equal((await m.verifyEffect('report')).complete,true);
  assert.deepEqual(m.status().effects[0].steps.map(s=>s.attempts),[1,1,1]);
  assert.equal(p.calls.filter(c=>c[0]==='act').length,3);
});

test('normal next step cannot bypass unverified focus',async()=>{
  const m=setup();await ready(m);await m.execute('report','focus',{type:'focus'});await ready(m,'type');
  await rejects(m.execute('report','type',{type:'type',text:'hello'}),'step-order');
});

test('proven rejected focus cannot be skipped as though it succeeded',async()=>{
  for(const blocked of [false,true]) {
    const p=provider(),m=setup(p);await ready(m);p.receipt={delivery:'not-delivered',blocked,apply:false};
    await m.execute('report','focus',{type:'focus'});await ready(m,'type');
    await rejects(m.execute('report','type',{type:'type',text:'hello'}),'step-order');
    assert.equal(p.calls.filter(c=>c[0]==='act').length,1);
  }
});

test('METHOD-MODAL known parent rejection permits exact owned dialog and clean parent return',async()=>{
  const p=provider(),m=setup(p,[{id:'report',checkId:'saved',steps:[step('open')]}]);
  await ready(m,'open');p.receipt={delivery:'not-delivered',blocked:true,apply:false};
  assert.equal((await m.execute('report','open',{type:'open'})).status,'target-blocked');
  m.appendStep('report',step('dialog',{target:{environment:'local',app:'dialog',kind:'app',parentStepId:'open'}}));
  await ready(m,'dialog');await m.execute('report','dialog',{type:'save'});
  assert.equal(m.status().effects[0].steps[0].quarantine,false);
  assert.ok(p.calls.some(c=>c[0]==='close'&&c[1]==='writer'&&c[2]===true));
  await m.discover('report','open');await m.observe('report','open');
  assert.ok(p.calls.some(c=>c[0]==='close'&&c[1]==='dialog'));
});

test('modal relation is not inferred from app labels or same PID',async()=>{
  const p=provider(),original=p.discover;
  p.discover=async t=>(await original(t)).map(ref=>({...ref,ownerWindowId:'unrelated'}));
  const m=setup(p,[{id:'report',checkId:'saved',steps:[step('open'),step('dialog',{
    target:{environment:'local',app:'dialog',kind:'app',parentStepId:'open'}})]}]);
  await ready(m,'open');await rejects(m.discover('report','dialog'),'ownership-unverified');
});

test('METHOD-OUTCOME unknown saved effect is inspected and never resubmitted',async()=>{
  const p=provider(),m=setup(p,[{id:'report',checkId:'saved',steps:[step('save')]}],{
    verifyEffect:({after})=>after.evidence.saved?'confirmed':'absent'});
  await ready(m,'save');p.receipt={delivery:'unknown'};await m.execute('report','save',{type:'save'});
  await rejects(m.execute('report','save',{type:'save'}),'delivery-unknown');
  assert.equal((await m.verifyEffect('report')).complete,true);
  assert.equal(p.calls.filter(c=>c[0]==='act').length,1);
});

test('per-step retry requires changed evidence and has one corrective budget',async()=>{
  const p=provider(),m=setup(p,[{id:'report',checkId:'saved',steps:[step('focus')]}]);
  await ready(m);p.receipt={delivery:'unknown',apply:false};await m.execute('report','focus',{type:'focus'});
  await m.verifyStep('report','focus');await rejects(m.execute('report','focus',{type:'focus'}),'retry-denied');
  p.revision++;await m.observe('report','focus');p.receipt={delivery:'not-delivered',apply:false};
  await m.execute('report','focus',{type:'focus'});p.revision++;await m.observe('report','focus');
  await rejects(m.execute('report','focus',{type:'focus'}),'retry-denied');
});

test('METHOD-OBSERVE TTL, reused observation and failed refresh all prevent stale input',async()=>{
  let now=100;const p=provider(),m=setup(p,effects(),{clock:()=>now,ttlMs:10});
  await ready(m);now=111;await rejects(m.execute('report','focus',{type:'focus'}),'stale-observation');
  const original=p.observe;await m.observe('report','focus');const previous=m.effects.get('report').steps.get('focus').observation;
  p.observe=async()=>previous;await rejects(m.observe('report','focus'),'invalid-observation');
  await rejects(m.execute('report','focus',{type:'focus'}),'stale-observation');
  p.observe=original;await m.observe('report','focus');p.observe=async()=>{throw new Error('capture failed');};
  await assert.rejects(m.observe('report','focus'),/capture failed/);
  assert.equal(m.status().effects[0].steps[0].quarantine,true);
  await rejects(m.execute('report','focus',{type:'focus'}),'quarantined');
});

test('simultaneous execution consumes before dispatch and cannot duplicate input',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const p=provider({async act(){await pending;return {delivery:'delivered'};}}),m=setup(p);await ready(m);
  const first=m.execute('report','focus',{type:'focus'});
  await rejects(m.execute('report','focus',{type:'focus'}),'busy');release();await first;
});

test('true cleanup uncertainty blocks native transitions and survives close and resume',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('focus'),step('dialog',{
    target:{environment:'local',app:'dialog',kind:'app'}})]}],m=setup(p,spec);
  await ready(m);p.receipt={delivery:'not-delivered',blocked:true,cleanup:'unknown',apply:false};
  await m.execute('report','focus',{type:'focus'});
  await rejects(m.discover('report','dialog'),'unresolved-work');await m.close();
  const resumed=ComputerMethod.resume(m.checkpoint(),{goalId:'prepare-report',effects:spec,providers:[p],
    verifyStep:checkStep,verifyEffect:async()=> 'unknown'});
  assert.equal(resumed.status().effects[0].steps[0].quarantine,true);
  await rejects(resumed.discover('report','dialog'),'unresolved-work');
});

test('independent unrelated APIs may continue while the affected desktop remains blocked',async()=>{
  const desktop=provider(),api=provider({id:'api',channel:'app-connector',usesDesktop:false,apps:['service']});
  const spec=[{id:'report',checkId:'saved',steps:[step('focus')]},
    {id:'read-service',checkId:'read',steps:[step('read',{independent:true,target:{environment:'local',app:'service',kind:'app'}})]}];
  const m=setup(desktop,spec,{providers:[desktop,api]});await ready(m);desktop.receipt={delivery:'unknown',apply:false};
  await m.execute('report','focus',{type:'focus'});
  await ready(m,'read','read-service');await m.execute('read-service','read',{type:'read'});
  assert.equal(m.status().effects[0].steps[0].uncertain,true);
  assert.equal(desktop.calls.some(c=>c[0]==='close'),false,'Independent API must not touch unresolved desktop ownership.');
});

test('METHOD-OWNERSHIP failed lease release retains old target and blocks the new target',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('focus'),step('dialog',{
    target:{environment:'local',app:'dialog',kind:'app'}})]}],m=setup(p,spec);
  await ready(m);await m.execute('report','focus',{type:'focus'});await m.verifyStep('report','focus');p.closeResult='unknown';
  await rejects(m.discover('report','dialog'),'transition-cleanup-unknown');
  assert.equal(m.effects.get('report').steps.get('dialog').ref,null);
  assert.equal(m.status().effects[0].steps[0].quarantine,true);
});

test('METHOD-RESUME checkpoint excludes content and binds exact original process lifetime',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('save')]}],m=setup(p,spec);
  await ready(m,'save');p.receipt={delivery:'unknown'};await m.execute('report','save',{type:'save',text:'SECRET_PAYLOAD'});
  const snapshot=JSON.parse(JSON.stringify(m.checkpoint())),encoded=JSON.stringify(snapshot);
  for(const raw of ['SECRET_PAYLOAD','PRIVATE_SCREEN_CONTENT','writer','report','native','fixture']) assert.equal(encoded.includes(raw),false,raw);
  const p2=provider(),discover=p2.discover;p2.discover=async t=>(await discover(t)).map(ref=>({...ref,identity:{...ref.identity,generation:'g2'}}));
  const resumed=ComputerMethod.resume(snapshot,{goalId:'prepare-report',effects:spec,providers:[p2],verifyStep:checkStep,verifyEffect:async()=> 'unknown'});
  await rejects(resumed.discover('report','save'),'target-changed');
  assert.equal(resumed.status().effects[0].steps[0].uncertain,true);
});

test('METHOD-ROUTE only advertises ready exact operation/env with explicit channel selection',()=>{
  const native=provider(),api=provider({id:'api',channel:'app-connector',usesDesktop:false});
  const m=setup(native,effects(),{providers:[native,api]});assert.equal(m.route('report','focus').providerId,'api');
  api.available=false;assert.equal(m.route('report','focus').providerId,'native');native.environments=['remote'];
  assert.throws(()=>m.route('report','focus'),{code:'no-route'});
  assert.throws(()=>new ProviderRegistry([provider(),provider()]),{code:'invalid-provider'});
});

test('verified checkpoints require fresh revalidation and do not grant safe replay',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('save')]}],m=setup(p,spec,{
    verifyEffect:({after})=>after.evidence.saved?'confirmed':'absent'});
  await ready(m,'save');await m.execute('report','save',{type:'save'});await m.verifyEffect('report');
  const resumed=ComputerMethod.resume(m.checkpoint(),{goalId:'prepare-report',effects:spec,providers:[p],
    verifyStep:checkStep,verifyEffect:({after})=>after.evidence.saved?'confirmed':'absent'});
  assert.equal(resumed.status().lifecycle,'active');await ready(resumed,'save');
  await rejects(resumed.execute('report','save',{type:'save'}),'resume-revalidation');
  assert.equal((await resumed.verifyEffect('report')).complete,true);
});

test('lost Save receipt resumes from verified saved state without duplicate submission',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('save')]}],extra={verifyEffect:({after})=>after.evidence.saved?'confirmed':'absent'};
  const m=setup(p,spec,extra);await ready(m,'save');p.receipt={delivery:'unknown'};await m.execute('report','save',{type:'save'});
  const resumed=ComputerMethod.resume(m.checkpoint(),{goalId:'prepare-report',effects:spec,providers:[p],verifyStep:checkStep,...extra});
  await resumed.discover('report','save');assert.equal((await resumed.verifyEffect('report')).complete,true);
  assert.equal(p.calls.filter(c=>c[0]==='act').length,1);
});

test('resume retains exhausted per-step corrective retry and original provider pin',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('focus')]}],m=setup(p,spec);
  await ready(m);p.receipt={delivery:'not-delivered',apply:false};await m.execute('report','focus',{type:'focus'});
  p.revision++;await m.observe('report','focus');p.receipt={delivery:'not-delivered',apply:false};await m.execute('report','focus',{type:'focus'});
  const better=provider({id:'api',channel:'app-connector',usesDesktop:false});
  const resumed=ComputerMethod.resume(m.checkpoint(),{goalId:'prepare-report',effects:spec,providers:[p,better],verifyStep:checkStep,verifyEffect:async()=> 'absent'});
  assert.equal(resumed.route('report','focus').providerId,'native');await resumed.discover('report','focus');await resumed.verifyStep('report','focus');
  p.revision++;await resumed.observe('report','focus');await rejects(resumed.execute('report','focus',{type:'focus'}),'retry-denied');
});

test('dependency cycles are rejected rather than becoming unrecoverable waiting goals',()=>{
  assert.throws(()=>setup(provider(),[
    {id:'a',checkId:'a',dependsOn:['b'],steps:[step('a')]},
    {id:'b',checkId:'b',dependsOn:['a'],steps:[step('b')]}]),{code:'invalid-dependency'});
});

test('shared-target cleanup quarantine can recover after checkpoint without losing unknown effects',async()=>{
  const p=provider(),spec=[{id:'report',checkId:'saved',steps:[step('focus'),step('type')]}],m=setup(p,spec);
  await ready(m);await m.execute('report','focus',{type:'focus'});await m.verifyStep('report','focus');
  await ready(m,'type');p.receipt={delivery:'unknown'};await m.execute('report','type',{type:'type',text:'hello'});
  p.closeResult='unknown';await m.close();
  const resumed=ComputerMethod.resume(m.checkpoint(),{goalId:'prepare-report',effects:spec,providers:[p],verifyStep:checkStep,verifyEffect:async()=> 'absent'});
  await resumed.discover('report','type');await resumed.recover('report','type');
  assert.equal(resumed.status().effects[0].steps.some(s=>s.quarantine),false);
  assert.equal(resumed.status().effects[0].steps[1].uncertain,true);
  await resumed.discover('report','type');await resumed.verifyStep('report','type');
  assert.equal(p.calls.filter(c=>c[0]==='act').length,2);
});

test('readiness-rejected refresh invalidates evidence even if provider becomes ready again',async()=>{
  const p=provider(),m=setup(p);await ready(m);p.available=false;
  await rejects(m.observe('report','focus'),'provider-unavailable');p.available=true;
  await rejects(m.execute('report','focus',{type:'focus'}),'stale-observation');
  assert.equal(p.calls.filter(c=>c[0]==='act').length,0);
});

test('malformed checkpoint collections and inconsistent retry state are rejected',()=>{
  const p=provider(),spec=effects(),m=setup(p,spec),snapshot=m.checkpoint();
  const deps={goalId:'prepare-report',effects:spec,providers:[p],verifyStep:checkStep,verifyEffect:async()=> 'unknown'};
  const objectSteps=structuredClone(snapshot);objectSteps.effects[0].steps={...objectSteps.effects[0].steps,length:3};
  assert.throws(()=>ComputerMethod.resume(objectSteps,deps),{code:'invalid-checkpoint'});
  const badRetry=structuredClone(snapshot);badRetry.effects[0].steps[0].retryUsed=true;
  assert.throws(()=>ComputerMethod.resume(badRetry,deps),{code:'invalid-checkpoint'});
});

test('failed rediscovery invalidates prior evidence before route or provider rejection',async()=>{
  for(const failure of ['provider','throw','identity']) {
    const p=provider(),m=setup(p);await ready(m);
    if(failure==='provider')p.available=false;
    if(failure==='throw')p.discover=async()=>{throw new Error('discovery failed');};
    if(failure==='identity')p.discover=async()=>[{environment:'wrong',app:'writer',windowId:'writer'}];
    await assert.rejects(m.discover('report','focus'));p.available=true;
    await rejects(m.execute('report','focus',{type:'focus'}),'stale-observation');
    assert.equal(p.calls.filter(c=>c[0]==='act').length,0);
  }
});
