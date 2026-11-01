'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {WinappBackend}=require('../src/computer/winapp-backend.cjs');
const {createComputerController}=require('../src/computer/controller.cjs');
const {createComputerServer}=require('../src/computer/server.cjs');
const {Client,InMemoryTransport}=require('@modelcontextprotocol/client');
const rect={x:0,y:0,width:1,height:1},window={id:'123',pid:456,processName:'fixture',processCreationTime:'100',sessionId:2};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=','base64');
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trace-visual-')),calls=[],control={fault:null,identities:0,bounds:0};
  const backend=new WinappBackend({supervisor:null,run:async(_exe,args)=>{
    const verb=args[0];calls.push(verb);assert.notEqual(verb,'ui','Visual observation must never invoke UIA');
    let value={hwnd:'123',pid:456,processCreationTime:'100',sessionId:2};
    if(verb==='identity'&&++control.identities>1&&control.fault==='lifetime')value.processCreationTime='101';
    if(verb==='bounds'){
      control.bounds++;value={...value,frameBounds:rect,windowBounds:rect,minimized:false,enabled:true};
      if(control.fault==='geometry'&&control.bounds>1)value.frameBounds={...rect,x:1};
      if(control.fault==='after-lifetime'&&control.bounds>1)value.processCreationTime='101';
    }
    if(verb==='capture'){
      if(control.fault==='capture')throw Object.assign(Error('blank'),{code:'capture_blank'});
      await fs.writeFile(args[3],png);
      value={...value,filePath:args[3],width:1,height:1,bounds:rect,method:'public-win32-printwindow-dwm',uiaRequired:false};
      if(control.fault==='path')value.filePath=path.join(directory,'other.png');
      if(control.fault==='size')value.width=2;
      if(control.fault==='method')value.method='screen-composite';
    }
    return {exitCode:0,stdout:JSON.stringify(value),stderr:''};
  }});
  backend.listWindows=async()=>[window];
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('trace-visual-'));await fs.rm(directory,{recursive:true,force:true});});
  return {backend,directory,calls,control};
}
test('visual capture rejects provenance, dimensions, lifetime, geometry and native failure without UIA fallback',async t=>{
  for(const [fault,code]of [['path','invalid_capture'],['size','capture_mismatch'],['method','invalid_capture'],
    ['lifetime','window_identity_changed'],['after-lifetime','window_identity_changed'],['geometry','window_moved'],['capture','capture_blank']]){
    const f=await fixture(t);f.control.fault=fault;
    await assert.rejects(f.backend.observe({window,screenshotPath:path.join(f.directory,'frame.png'),visualOnly:true}),{code});
    assert.equal(f.calls.includes('ui'),false);
  }
});
test('MCP can open and capture an exact window with UIA unavailable; screenshot evidence never authorizes input',async t=>{
  const f=await fixture(t),indicator={signal:new AbortController().signal,async start(){return{};},assertActive(){},async stop(){}};
  const lease={async acquire(){},async assert(){},async release(){}};
  const controller=createComputerController({backend:f.backend,indicator,lease,runtimeDirectory:f.directory});
  const [a,b]=InMemoryTransport.createLinkedPair(),server=createComputerServer({controller});await server.connect(b);
  const client=new Client({name:'visual-test',version:'1'});await client.connect(a);
  t.after(async()=>{await client.close();await server.close();await controller.close();});
  await controller.listWindows();const session=await controller.openSession({windowId:window.id});
  const call=()=>client.callTool({name:'trace_computer_observe',arguments:{sessionId:session.sessionId,mode:'screenshot'}});
  const result=await call(),value=result.structuredContent;
  assert.notEqual(result.isError,true);assert.equal(value.actionable,false);assert.equal(value.mode,'screenshot');
  assert.equal(value.captureMethod,'public-win32-printwindow-dwm');assert.equal(value.screenshot.width,1);
  assert.deepEqual(Buffer.from(result.content[value.screenshot.contentIndex].data,'base64'),png);
  assert.equal(value.accessibility,undefined);assert.equal(value.elements,undefined);assert.equal(value.focused.code,'visual_only');
  assert.deepEqual(f.calls,['identity','identity','identity','bounds','capture','identity','bounds']);
  await assert.rejects(controller.act({...session,observationId:value.observationId,action:{type:'activate'}}),{code:'stale_observation'});
  f.control.fault='capture';const failed=await call();assert.equal(failed.isError,true);assert.equal(failed.structuredContent.error.code,'capture_blank');
});
