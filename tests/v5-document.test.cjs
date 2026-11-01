'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { createComputerServer } = require('../src/computer/server.cjs');
const rect = {x:0,y:0,width:1,height:1}, window = {id:'123',pid:456,processName:'fixture'};
const element = {id:'doc',automationId:'document',className:'TextBox',controlType:'Edit',bounds:rect};
const empty = () => ({method:'managed-uia-textpattern',document:{available:true,text:'',truncated:false},
  selection:{available:true,ranges:[],truncated:false}});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=','base64');

test('document target binding is unique and missing metadata never falls back to a label',async()=>{
  const backend = new WinappBackend({run:async()=>{throw Error('No OS calls');}}), calls=[];
  backend.bridge=async(...args)=>{calls.push(args);return empty();};
  await assert.rejects(backend.readDocument(window,null,[],'doc'),{code:'stale_element'});
  await assert.rejects(backend.readDocument(window,null,[element,element],'doc'),{code:'ambiguous_element'});
  const unavailable=await backend.readDocument(window,null,[{...element,automationId:''}],'doc');
  assert.equal(unavailable.document.reason,'binding_unavailable'); assert.equal(calls.length,0);
  assert.equal((await backend.readDocument(window,null,[element],'doc')).document.text,'');
  assert.deepEqual(calls[0].slice(0,3),['document',window,null]);
  assert.deepEqual(calls[0][3],['document','Edit','TextBox','0','0','1','1']);
});

test('native response distinguishes empty, unavailable, truncation and bounded selections; malformed data rejects',async()=>{
  const backend=new WinappBackend({run:async()=>{throw Error('No OS calls');}});
  let response=empty(); backend.bridge=async()=>response;
  const read=()=>backend.readDocument(window,null,[element],'doc');
  response.document={available:true,text:'x'.repeat(4096),truncated:true};
  response.selection={available:true,ranges:[{text:'x'.repeat(1024),truncated:true}],truncated:true};
  assert.equal((await read()).selection.ranges[0].text.length,1024);
  for (const reason of ['password_or_unknown','text_pattern_unavailable','selection_unavailable']) {
    response={...empty(),document:{available:false,reason},selection:{available:false,reason}};
    assert.equal((await read()).document.reason,reason);
  }
  for (const mutate of [r=>r.document.text='x'.repeat(4097),r=>delete r.document.truncated,
    r=>r.selection.ranges=Array(5).fill({text:'',truncated:false}),r=>r.selection.ranges=[{text:'x'.repeat(1025),truncated:false}],
    r=>r.document={available:false,reason:'fallback_name'},r=>r.method='label-reader']) {
    response=empty();mutate(response);await assert.rejects(read(),{code:'invalid_native_response'});
  }
});

test('connected MCP document observations are image-free evidence, revoke authority and do not journal content',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trace-document-')), calls=[], control={fail:false,acts:0};
  const backend=new WinappBackend({run:async()=>{throw Error('No OS calls');}});
  backend.listWindows=async()=>[window]; backend.identity=async()=>window;
  backend.bridge=async(verb,...args)=>{
    calls.push([verb,...args]);
    if(verb==='document') {
      if(control.fail) throw Object.assign(Error('stale binding'),{code:'stale_element'});
      return {...empty(),document:{available:true,text:'synthetic-private-content',truncated:false}};
    }
    return {frameBounds:rect,windowBounds:rect,minimized:false,enabled:true};
  };
  backend.inspect=async(_w,_s,depth)=>({bounds:rect,rootSelector:'doc',elements:[element],depth,
    hierarchy:[{nodeId:'n0',parentNodeId:null,elementId:'doc'}]});
  backend.focused=async()=>({available:true,hasFocus:false});
  backend.command=async(verb,args)=>{
    assert.equal(verb,'screenshot');const filePath=args[args.indexOf('--output')+1];await fs.writeFile(filePath,png);
    return {hwnd:123,processId:456,filePath,width:1,height:1};
  };
  backend.act=async()=>{control.acts++;return {performed:true};};
  const indicator={signal:new AbortController().signal,async start(){return{};},assertActive(){},async stop(){}};
  const lease={async acquire(){},async assert(){},async release(){}};
  const controller=createComputerController({backend,indicator,lease,runtimeDirectory:directory});
  const [a,b]=InMemoryTransport.createLinkedPair(),server=createComputerServer({controller});await server.connect(b);
  const client=new Client({name:'document-test',version:'1'});await client.connect(a);
  t.after(async()=>{await client.close();await server.close();await controller.close();
    assert.ok(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('trace-document-'));
    await fs.rm(directory,{recursive:true,force:true});});
  await controller.listWindows();const session=await controller.openSession({windowId:'123'});
  const call=args=>client.callTool({name:'trace_computer_observe',arguments:{sessionId:session.sessionId,...args}});
  const schema=(await client.listTools()).tools.find(tool=>tool.name==='trace_computer_observe').inputSchema;
  assert.equal(schema.properties.documentElementId.maxLength,512);
  let full=await controller.observe(session); const count=calls.length;
  assert.equal((await call({documentElementId:'doc'})).isError,true);
  await assert.rejects(controller.observe({...session,mode:'accessibility',documentElementId:'bad\0id'}),{code:'invalid_document_request'});
  assert.equal(calls.length,count);
  assert.equal((await controller.act({...session,observationId:full.observationId,action:{type:'activate'}})).outcome,'completed');
  assert.equal(calls.some(c=>c[0]==='document'),false);
  full=await controller.observe(session);
  const observed=await call({mode:'accessibility',documentElementId:'doc'}), result=observed.structuredContent;
  assert.notEqual(observed.isError,true);assert.equal(observed.content.some(c=>c.type==='image'),false);
  assert.equal(result.documentRead.document.text,'synthetic-private-content');
  assert.equal(result.accessibility.hierarchy[0].elementId,'doc');assert.equal(result.actionable,false);
  assert.equal(result.metrics.stages.fileRead,undefined);assert.equal(result.metrics.stages.backendPngRead,undefined);
  for(const observationId of [full.observationId,result.observationId])
    await assert.rejects(controller.act({...session,observationId,action:{type:'activate'}}),{code:'stale_observation'});
  full=await controller.observe(session);control.fail=true;
  assert.equal((await call({mode:'accessibility',documentElementId:'doc'})).isError,true);
  await assert.rejects(controller.act({...session,observationId:full.observationId,action:{type:'activate'}}),{code:'stale_observation'});
  assert.equal(control.acts,1);
  const journal=await fs.readFile(path.join(directory,'sessions',session.sessionId,'events.jsonl'),'utf8');
  assert.equal(journal.includes('synthetic-private-content'),false);
});
