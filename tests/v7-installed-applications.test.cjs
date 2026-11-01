'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {createInstalledApplications}=require('../src/method/index.cjs');
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trace-app-catalog-')),executable=path.join(directory,'app.exe');
  await fs.writeFile(executable,'synthetic regular executable fixture');
  const state={launches:0,releases:0,started:false,fault:null,processReads:0},registrations=[{name:'App',executable,registration:'synthetic/App Paths/app.exe'}];
  const window={id:'123',pid:400,processCreationTime:'100',sessionId:2,executable};
  const backend={
    async bridge(verb,_window,_signal,args){
      if(verb==='apps')return {applications:state.fault==='unregistered'?[]:registrations,coverage:'synthetic App Paths',partial:false,issues:[]};
      assert.equal(verb,'process');assert.deepEqual(args,['400']);state.processReads++;
      return {pid:400,processCreationTime:state.fault==='lifetime'&&state.processReads>1?'101':'100',sessionId:2,
        executable:state.fault==='executable'?path.join(directory,'other.exe'):executable};
    },
    async listWindows(){return state.fault==='no-window'?[]:[state.started?window:{...window,pid:300,processCreationTime:'90'}];},
    async currentVisualWindow(value){if(state.fault==='window')throw Object.assign(Error('changed'),{code:'window_identity_changed'});return value;}
  };
  const lease={signal:new AbortController().signal,async acquire(){if(state.fault==='busy')throw Object.assign(Error('busy'),{code:'desktop_busy'});},async assert(){},async release(){state.releases++;if(state.fault==='cleanup')throw Error('cleanup');}};
  const catalog=createInstalledApplications({backend,lease,verify:async()=>{},timeoutMs:100,spawnImpl:(file,args,options)=>{
    assert.equal(file,executable);assert.deepEqual(args,[]);assert.equal(options.shell,false);assert.equal(options.windowsHide,false);
    state.launches++;state.started=true;const child=new EventEmitter();child.pid=state.fault==='spawn'?undefined:400;child.unref=()=>{};
    queueMicrotask(()=>child.emit(state.fault==='spawn'?'error':'spawn',Error('spawn failed')));return child;
  }});
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('trace-app-catalog-'));await fs.rm(directory,{recursive:true,force:true});});
  return {catalog,state,executable,registrations};
}
test('catalog deduplicates canonical EXEs, distinguishes installed apps from current windows and returns verified launch handoff',async t=>{
  const f=await fixture(t);f.registrations.push({...f.registrations[0],registration:'second/view'});
  const listed=await f.catalog.discover();assert.equal(listed.applications.length,1);
  const app=listed.applications[0];assert.equal(app.windows[0].pid,300);assert.equal(app.verification,'canonical-regular-exe');assert.equal(f.state.launches,0);
  const result=await f.catalog.launch(app.appId);assert.equal(result.outcome,'launched');assert.equal(result.windows[0].pid,400);
  assert.equal(result.windows[0].processCreationTime,'100');assert.equal(result.cleanup,'confirmed');assert.equal(result.applicationClosed,false);
  await assert.rejects(f.catalog.launch(app.appId),{code:'application_already_attempted'});assert.equal(f.state.launches,1);assert.equal(f.state.releases,1);
});
test('unknown IDs, registration/file changes and busy ownership never spawn; discovery reports unverifiable files',async t=>{
  const f=await fixture(t),app=(await f.catalog.discover()).applications[0];
  await assert.rejects(f.catalog.launch('app:bad'),{code:'unknown_application'});
  f.state.fault='unregistered';assert.equal((await f.catalog.launch(app.appId)).outcome,'not_dispatched');
  f.state.fault='busy';assert.equal((await f.catalog.launch(app.appId)).code,'desktop_busy');
  f.state.fault=null;await fs.appendFile(f.executable,'changed');assert.equal((await f.catalog.launch(app.appId)).code,'application_changed');
  assert.equal(f.state.launches,0);assert.equal(f.state.releases,0);
  f.registrations.push({name:'Missing',executable:path.join(path.dirname(f.executable),'missing.exe'),registration:'missing'});
  const listed=await f.catalog.discover();assert.equal(listed.partial,true);assert.equal(listed.skipped,1);
});
test('spawn errors are non-dispatched; uncertain process/window/deadline/cleanup never relaunch or claim verified success',async t=>{
  for(const fault of ['spawn','executable','lifetime','window','no-window','cleanup']){
    const f=await fixture(t),app=(await f.catalog.discover()).applications[0];f.state.fault=fault;
    const result=await f.catalog.launch(app.appId);assert.equal(result.outcome,fault==='spawn'?'not_dispatched':'unknown',fault);
    assert.equal(f.state.releases,1);assert.equal(f.state.launches,1);
    await assert.rejects(f.catalog.launch(app.appId),{code:'application_already_attempted'});
    if(fault==='cleanup')assert.equal(result.cleanup,'unknown');
    if(fault==='no-window')assert.equal(result.code,'application_timeout');
  }
});
