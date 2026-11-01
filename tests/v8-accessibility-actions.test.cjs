'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WinappBackend,BackendError}=require('../src/computer/winapp-backend.cjs');
const {parseAction,validateAction,actionSupport,compatibleSupport}=require('../src/computer/action-contract.cjs');
const {createComputerServer}=require('../src/computer/server.cjs');
const {createTraceProvider,TOOL_NAMES}=require('../src/method/trace-adapter.cjs');
const {Client,InMemoryTransport}=require('@modelcontextprotocol/client');
const rect={x:10,y:20,width:100,height:100},window={id:'1234',pid:456,processName:'fixture',bounds:rect};
const action=name=>({type:'accessibility_action',elementId:'field',action:name});
function fixture(){
  const control={selector:'field',name:'Same label',type:'Custom',automationId:'bound',className:'Fixture',isEnabled:true,...rect,expandState:'collapsed'},calls=[];
  const state={control,duplicate:false,blocked:false,invokeError:false};
  const backend=new WinappBackend({run:async()=>{throw Error('No unsupervised calls');},supervisor:{ready:true,async run(provider,args,options){
    calls.push({provider,args,options});let value;
    if(provider==='bridge')value={hwnd:'1234',pid:456,frameBounds:rect,windowBounds:rect,minimized:false,enabled:!state.blocked,foreground:true};
    else if(args[1]==='status')value={hwnd:1234,processId:456,processName:'fixture',coordinateSpace:'physical-screen-pixels'};
    else if(args[1]==='inspect')value={windows:[{hwnd:1234,coordinateSpace:'physical-screen-pixels',elements:[{selector:'root',type:'Window',...rect,children:[{...control},...(state.duplicate?[{...control}]:[])]}]}]};
    else {assert.equal(args[1],'invoke');if(state.invokeError)throw new BackendError('unsupported_pattern','Pattern changed after admission.');value={hwnd:1234};}
    return {stdout:JSON.stringify(value),stderr:'',exitCode:0};
  }}});
  const snapshot=async()=>({...await backend.inspect(window),window,bounds:rect,uiaBounds:rect,frameBounds:rect,nativeWindowBounds:rect});
  return {backend,state,calls,snapshot};
}
test('secondary actions come only from enabled direct pattern state, never labels/invokable/scroll hints',async()=>{
  const f=fixture();
  for(const [fields,expected]of [[{expandState:'collapsed'},['expand']],[{expandState:'expanded'},['collapse']],
    [{expandState:null,toggleState:'indeterminate'},['toggle']],[{expandState:null,toggleState:null,isInvokable:true,scrollDir:'vh'},[]],
    [{expandState:'collapsed',isEnabled:false},[]]]){
    Object.assign(f.state.control,{toggleState:null,isEnabled:true},fields);
    assert.deepEqual((await f.snapshot()).elements.find(e=>e.id==='field').secondaryActions,expected);
  }
});
test('observed exact actions dispatch explicit no-fallback invoke options under supervision',async()=>{
  for(const name of ['expand','collapse','toggle']){
    const f=fixture();Object.assign(f.state.control,{expandState:name==='collapse'?'expanded':name==='expand'?'collapsed':null,toggleState:name==='toggle'?'off':null});
    const snapshot=await f.snapshot();validateAction(action(name),snapshot);
    const result=await f.backend.act({window,observation:snapshot,action:action(name)});
    const native=f.calls.find(c=>c.args[1]==='invoke');
    assert.deepEqual(native.args,['ui','invoke','--json','-w','1234','--action',name,'--','field']);
    assert.equal(native.options.mutating,true);assert.equal(result.transport,'exact-uia-pattern');
  }
});
test('changed patterns, duplicate IDs, changed binding, disabled controls and blocked parents reject before primary dispatch',async()=>{
  for(const mutate of [f=>f.state.control.expandState='expanded',f=>f.state.duplicate=true,f=>f.state.control.automationId='replacement',
    f=>f.state.control.className='replacement',f=>f.state.control.isEnabled=false,f=>f.state.blocked=true]){
    const f=fixture(),snapshot=await f.snapshot();mutate(f);
    await assert.rejects(f.backend.act({window,observation:snapshot,action:action('expand')}),e=>e.details.outcome==='not_dispatched');
    assert.equal(f.calls.some(c=>c.args[1]==='invoke'||c.args[0]==='activate'),false);
  }
  const f=fixture(),snapshot=await f.snapshot();f.backend.supervisor.ready=false;
  await assert.rejects(f.backend.act({window,observation:snapshot,action:action('expand')}),{code:'supervision_required'});
  f.backend.supervisor.ready=true;f.state.invokeError=true;
  await assert.rejects(f.backend.act({window,observation:snapshot,action:action('expand')}),e=>e.details.outcome==='unknown');
  assert.throws(()=>validateAction(action('collapse'),snapshot),{code:'unsupported_action'});
  assert.throws(()=>validateAction(action('expand'),{elements:[snapshot.elements[1],snapshot.elements[1]]}),{code:'unsupported_action'});
});
test('MCP strict schema and shared parser admit only the bounded named actions; legacy support stays truthful',async t=>{
  const received=[],controller=Object.fromEntries(['doctor','listWindows','openSession','observe','closeSession','close'].map(n=>[n,async()=>({})]));
  controller.act=async value=>{received.push(value);return{};};
  const[a,b]=InMemoryTransport.createLinkedPair(),server=createComputerServer({controller});await server.connect(b);
  const client=new Client({name:'secondary-test',version:'1'});await client.connect(a);t.after(async()=>{await client.close();await server.close();});
  for(const name of ['expand','collapse','toggle'])assert.notEqual((await client.callTool({name:'trace_computer_act',arguments:{sessionId:'s',observationId:'o',action:action(name)}})).isError,true);
  for(const payload of [action('scroll_down'),action('select'),{...action('toggle'),fallback:true},{...action('expand'),x:1}]){
    assert.throws(()=>parseAction(payload));assert.equal((await client.callTool({name:'trace_computer_act',arguments:{sessionId:'s',observationId:'o',action:payload}})).isError,true);
  }
  assert.equal(received.length,3);
  const support=actionSupport();delete support.actions.accessibility_action;assert.equal(compatibleSupport(support),true);
  const provider=createTraceProvider({app:'fixture',windowId:'1',tools:TOOL_NAMES.map(name=>({name,inputSchema:{}})),callTool:async()=>({structuredContent:{ready:true,support}})});
  assert.equal((await provider.doctor()).ready,true);assert.equal(provider.constraints.nativeSupport.actions.accessibility_action,undefined);
  const invalid=actionSupport();invalid.actions.accessibility_action.fallback=true;assert.equal(compatibleSupport(invalid),false);
});
