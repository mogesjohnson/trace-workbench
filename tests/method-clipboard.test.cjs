'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createClipboardProvider, createClipboardTransport } = require('../src/method/clipboard-provider.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error('untrusted helper output is never shown'), { code });

function fixture(formats = new Map([[13, Buffer.from('PRIVATE_SNAPSHOT\0', 'utf16le')]])) {
  const initial = new Map([...formats].map(([id, bytes]) => [id, Buffer.from(bytes)]));
  const state = { formats, sequence:1, owner:'original', active:null, writes:0, bytesRead:0, snapshots:0, recoveryWrites:0,
    pendingRecovery:false, lostReply:false, requests:[], closeUnknown:false };
  const check = token => { if (state.active?.token !== token) throw fail('clipboard_transaction_mismatch'); };
  const current = () => { if (state.sequence !== state.active.sequence || state.owner !== 'helper') throw fail('clipboard_changed'); };
  const wire = {
    async request(command, fields = {}) {
      state.requests.push(command);
      if (command === 'info') return { version:1,ready:!state.pendingRecovery,recoveryPending:state.pendingRecovery,mode:'text-only',desktopInput:false };
      if (command === 'inspect_formats') {
        const ids=[...state.formats.keys()],supportedFormatIds=ids.filter(id=>[1,7,13,16].includes(id));
        const category=id=>[2,3,8,9,14,17].includes(id)?'image':id===15?'file-list':id>=0xc000?'registered':id>=0x300&&id<=0x3ff?'graphics-object':id>=0x200&&id<=0x2ff?'private':id<=0x1ff?'standard-other':'other';
        const groups=new Map();for(const id of ids.filter(id=>![1,7,13,16].includes(id)))groups.set(category(id),(groups.get(category(id))||0)+1);
        const unsupportedCount=ids.length-supportedFormatIds.length;
        return {mode:'text-only',inspection:'format-identifiers-only',supported:unsupportedCount===0,supportedFormatIds,
          formatCount:ids.length,unsupportedCount,categories:[...groups].map(([category,count])=>({category,count})),recoveryPending:state.pendingRecovery,
          ready:unsupportedCount===0&&!state.pendingRecovery,code:state.pendingRecovery?'clipboard_recovery_required':unsupportedCount?'clipboard_unsupported_formats':null,
          contentsRead:false,contentsChanged:false,recoveryWritten:false};
      }
      if (command === 'snapshot') {
        if ([...state.formats.keys()].some(id => ![1,7,13,16].includes(id))) throw fail('clipboard_unsupported_formats');
        state.snapshots++;state.bytesRead+=state.formats.size;
        state.active = { token:randomUUID(), sequence:state.sequence, original:new Map([...state.formats].map(([id, bytes])=>[id,Buffer.from(bytes)])) };
        return { token:state.active.token,sequence:state.sequence,mode:'text-only',
          formats:[...state.formats].map(([id,bytes])=>({id,bytes:bytes.length,sha256:sha(bytes)})),
          unexpectedPlaintext:'PRIVATE_SNAPSHOT' };
      }
      if (command === 'write_text') {
        check(fields.token);
        if (state.sequence !== state.active.sequence) throw fail('clipboard_changed');
        state.formats = new Map([[13,Buffer.from(fields.text+'\0','utf16le')]]); state.sequence++;state.writes++;state.owner='helper';
        state.active.sequence=state.sequence;state.active.sha256=sha(Buffer.from(fields.text,'utf16le'));
        if (state.lostReply) throw fail('clipboard_transport_uncertain');
        return { token:fields.token,written:true,verified:true,sequence:state.sequence,sha256:state.active.sha256,bytes:Buffer.byteLength(fields.text,'utf16le') };
      }
      if (command === 'readback') { check(fields.token);current();return {token:fields.token,verified:true,matches:true,sequence:state.sequence,sha256:state.active.sha256}; }
      if (command === 'defer_restore') { check(fields.token);current();state.active.requiresInputQuiescence=true;return {token:fields.token,automaticRestoreDeferred:true,requiresInputQuiescence:true}; }
      if (command === 'restore') { check(fields.token);if(state.active.requiresInputQuiescence && fields.inputQuiescent!==true)throw fail('clipboard_input_quiescence_required');current();state.formats=state.active.original;state.active=null;state.writes++;return {restored:true,verified:true,exactSupportedBytes:true}; }
      if (command === 'abandon') {check(fields.token);state.active=null;return {restored:false,currentClipboardPreserved:true,recoveryArchived:true};}
      if (command === 'close') return {cleanup:state.closeUnknown||state.active?.requiresInputQuiescence?'unknown':'confirmed',...(state.closeUnknown?{code:'clipboard_changed'}:{})};
      throw fail('clipboard_invalid_command');
    },
    async dispose() { state.disposed=true; }
  };
  return { wire,state,initial };
}

test('explicit text-only provider verifies readback and exact supported-format restoration without exposing snapshots',async()=>{
  const f=fixture(new Map([[13,Buffer.from('PRIVATE_SNAPSHOT\0','utf16le')],[1,Buffer.from([65,0,0])],[7,Buffer.from([66,0])],[16,Buffer.from([9,4,0,0])]]));
  const p=createClipboardProvider({transport:f.wire});assert.equal((await p.doctor()).transport,'injected');
  const snap=await p.snapshot();assert.equal(JSON.stringify(snap).includes('PRIVATE_SNAPSHOT'),false);
  const written=await p.writeText({token:snap.token,text:'temporary 日本語'});
  assert.equal(written.verified,true);assert.equal(written.sha256,sha(Buffer.from('temporary 日本語','utf16le')));
  assert.equal((await p.readback({token:snap.token})).contentReturned,false);
  assert.equal((await p.restore({token:snap.token})).exactSupportedBytes,true);
  assert.deepEqual([...f.state.formats],[...f.initial]);assert.equal(f.state.writes,2);
  assert.equal((await p.close()).cleanup,'confirmed');assert.deepEqual(await p.close(),await p.close());
});

test('format-only preflight reports unsupported categories before any bytes, snapshot or recovery API',async()=>{
  const f=fixture(new Map([[13,Buffer.from('PRIVATE_TEXT\0','utf16le')],[49152,Buffer.from('PRIVATE_REGISTERED_FORMAT')],[2,Buffer.from('PRIVATE_IMAGE')],[15,Buffer.from('PRIVATE_FILE_LIST')]]));
  const p=createClipboardProvider({transport:f.wire});
  const result=await p.inspectFormats();
  assert.equal(result.supported,false);assert.equal(result.ready,false);assert.equal(result.code,'clipboard_unsupported_formats');
  assert.deepEqual(result.supportedFormatIds,[13]);assert.equal(result.unsupportedCount,3);
  assert.deepEqual(result.categories,[{category:'registered',count:1},{category:'image',count:1},{category:'file-list',count:1}]);
  assert.equal(result.contentsRead,false);assert.equal(result.contentsChanged,false);assert.equal(result.recoveryWritten,false);
  assert.deepEqual(f.state.requests,['inspect_formats']);assert.equal(f.state.bytesRead,0);assert.equal(f.state.snapshots,0);assert.equal(f.state.writes,0);assert.equal(f.state.recoveryWrites,0);assert.equal(f.state.active,null);
  assert.equal(/PRIVATE|sequence|owner|token|sha256/.test(JSON.stringify(result)),false);
  await p.doctor();await assert.rejects(p.snapshot(),{code:'clipboard_unsupported_formats'});assert.equal(f.state.bytesRead,0);assert.equal(f.state.snapshots,0);await p.close();
});

test('format inspection preserves pending recovery and never turns it into transaction authority',async()=>{
  const f=fixture();f.state.pendingRecovery=true;
  const p=createClipboardProvider({transport:f.wire});assert.equal((await p.doctor()).ready,false);
  const result=await p.inspectFormats();assert.equal(result.supported,true);assert.equal(result.recoveryPending,true);assert.equal(result.ready,false);assert.equal(result.code,'clipboard_recovery_required');
  assert.equal(f.state.pendingRecovery,true);assert.equal(f.state.bytesRead,0);assert.equal(f.state.writes,0);assert.equal(f.state.snapshots,0);
  await assert.rejects(p.snapshot(),{code:'clipboard_provider_unavailable'});
  assert.deepEqual(f.state.requests,['info','inspect_formats']);await p.close();
});

test('empty and supported format preflights are observations; snapshot still rejects a later unsupported clipboard',async()=>{
  for(const formats of [new Map(),new Map([1,7,13,16].map(id=>[id,Buffer.from('private')]))]){
    const f=fixture(formats),p=createClipboardProvider({transport:f.wire});const result=await p.inspectFormats();
    assert.equal(result.supported,true);assert.equal(result.ready,true);assert.equal(result.unsupportedCount,0);assert.deepEqual(result.categories,[]);
    assert.equal(f.state.bytesRead,0);assert.equal(f.state.snapshots,0);assert.equal(p.available,false,'Read-only inspection must not enable transaction dispatch.');
    f.state.formats.set(49153,Buffer.from('new private format'));await p.doctor();
    await assert.rejects(p.snapshot(),{code:'clipboard_unsupported_formats'});assert.equal(f.state.bytesRead,0);await p.close();
  }
});

test('format preflight rejects malformed or private helper output with a fixed sanitized error',async()=>{
  const good={mode:'text-only',inspection:'format-identifiers-only',supported:false,supportedFormatIds:[13],formatCount:2,unsupportedCount:1,
    categories:[{category:'registered',count:1}],recoveryPending:false,ready:false,code:'clipboard_unsupported_formats',contentsRead:false,contentsChanged:false,recoveryWritten:false};
  for(const bad of [{...good,registeredName:'PRIVATE_NAME'},{...good,token:randomUUID()},{...good,sequence:42},{...good,owner:'private'},
    {...good,sha256:'a'.repeat(64)},{...good,contentsRead:true},{...good,contentsChanged:true},{...good,recoveryWritten:true},
    {...good,categories:[{category:'PRIVATE_REGISTERED_NAME',count:1}]},{...good,categories:[{category:'registered',count:1,name:'PRIVATE_NAME'}]},
    {...good,supportedFormatIds:[49152]},{...good,unsupportedCount:0},{...good,formatCount:65},{...good,ready:true}]){
    const p=createClipboardProvider({transport:{request:async command=>{assert.equal(command,'inspect_formats');return bad;}}});
    await assert.rejects(p.inspectFormats(),error=>error.code==='clipboard_invalid_response'&&!error.message.includes('PRIVATE'));
  }
});

test('format preflight propagates bounded busy/unavailable failures without retry or fallback snapshot',async()=>{
  const calls=[],p=createClipboardProvider({transport:{request:async command=>{calls.push(command);throw fail('clipboard_busy');}}});
  await assert.rejects(p.inspectFormats(),{code:'clipboard_busy'});assert.deepEqual(calls,['inspect_formats']);
  const q=createClipboardProvider({platform:'linux'});await assert.rejects(q.inspectFormats(),{code:'clipboard_unsupported_platform'});
});

test('rich formats and changed pre-write sequence reject before any text mutation',async()=>{
  const rich=fixture(new Map([[13,Buffer.from('text\0','utf16le')],[49152,Buffer.from('rich fixture')]]));
  const p=createClipboardProvider({transport:rich.wire});await p.doctor();await assert.rejects(p.snapshot(),{code:'clipboard_unsupported_formats'});assert.equal(rich.state.writes,0);await p.close();
  const f=fixture(),q=createClipboardProvider({transport:f.wire});await q.doctor();const snap=await q.snapshot();f.state.sequence++;
  await assert.rejects(q.writeText({token:snap.token,text:'x'}),{code:'clipboard_changed'});assert.equal(f.state.writes,0);await q.close();
});

test('human owner/sequence changes are preserved and explicit abandonment retains an unresolved restoration result',async()=>{
  const f=fixture(),p=createClipboardProvider({transport:f.wire});await p.doctor();const snap=await p.snapshot();await p.writeText({token:snap.token,text:'temporary'});
  f.state.formats=new Map([[13,Buffer.from('HUMAN_NEW_COPY\0','utf16le')]]);f.state.sequence++;f.state.owner='human';
  await assert.rejects(p.restore({token:snap.token}),{code:'clipboard_changed'});assert.equal(f.state.writes,1);
  const abandoned=await p.abandon({token:snap.token});assert.equal(abandoned.restored,false);assert.equal(abandoned.currentClipboardPreserved,true);
  assert.equal(f.state.formats.get(13).toString('utf16le'),'HUMAN_NEW_COPY\0');await p.close();
});

test('lost write reply cannot authorize replay; independent readback can reconcile the same transaction',async()=>{
  const f=fixture(),p=createClipboardProvider({transport:f.wire});await p.doctor();const snap=await p.snapshot();f.state.lostReply=true;
  await assert.rejects(p.writeText({token:snap.token,text:'once'}),{code:'clipboard_transport_uncertain'});
  await assert.rejects(p.writeText({token:snap.token,text:'once'}),{code:'clipboard_write_already_attempted'});
  assert.equal((await p.readback({token:snap.token})).matches,true);assert.equal(f.state.writes,1);
  await p.restore({token:snap.token});await p.close();
});

test('unknown cleanup remains unknown; tokens, malformed text and untrusted helper messages stay bounded',async()=>{
  const f=fixture(),p=createClipboardProvider({transport:f.wire});await p.doctor();const snap=await p.snapshot();
  await assert.rejects(p.writeText({token:randomUUID(),text:'x'}),{code:'clipboard_transaction_mismatch'});
  await assert.rejects(p.writeText({token:snap.token,text:'bad\0text'}),{code:'clipboard_invalid_text'});
  await assert.rejects(p.writeText({token:snap.token,text:'\ud800'}),{code:'clipboard_invalid_text'});
  f.state.closeUnknown=true;assert.equal((await p.close()).cleanup,'unknown');assert.equal(f.state.writes,0);
  const malformed=createClipboardProvider({transport:{request:async()=>{throw new Error('PRIVATE_PAYLOAD_MUST_NOT_ESCAPE');}}});
  const result=await malformed.doctor();assert.equal(result.ready,false);assert.equal(JSON.stringify(result).includes('PRIVATE_PAYLOAD'),false);await malformed.close();
});

test('simultaneous operations cannot take a second snapshot while one request is pending',async()=>{
  const f=fixture();let release;const pending=new Promise(resolve=>{release=resolve;});const original=f.wire.request;
  f.wire.request=async(command,fields)=>{if(command==='snapshot')await pending;return original(command,fields);};
  const p=createClipboardProvider({transport:f.wire});await p.doctor();const first=p.snapshot();
  await assert.rejects(p.snapshot(),{code:'clipboard_busy'});release();await first;await p.close();
});

test('restart diagnostics and close retain a protected pending recovery instead of asserting cleanup',async()=>{
  const calls=[];
  const p=createClipboardProvider({transport:{async request(command){calls.push(command);
    if(command==='info')return {version:1,ready:false,recoveryPending:true,mode:'text-only',desktopInput:false};
    if(command==='close')return {cleanup:'unknown',code:'clipboard_recovery_required',recoveryRetained:true};
    throw fail('clipboard_unexpected_command');
  }}});
  const info=await p.doctor();assert.equal(info.ready,false);assert.equal(info.recoveryPending,true);
  const closed=await p.close();assert.equal(closed.cleanup,'unknown');assert.equal(closed.code,'clipboard_recovery_required');
  assert.deepEqual(calls,['info','close']);
});

test('durable defer requires explicit host quiescence acknowledgment before restore and does not restore on close',async()=>{
  const f=fixture(),p=createClipboardProvider({transport:f.wire});await p.doctor();const snap=await p.snapshot();
  await p.writeText({token:snap.token,text:'synthetic'});
  const armed=await p.deferAutomaticRestore({token:snap.token});assert.equal(armed.requiresInputQuiescence,true);
  const before=f.state.requests.length;
  await assert.rejects(p.restore({token:snap.token}),{code:'clipboard_input_quiescence_required'});
  assert.equal(f.state.requests.length,before,'Unacknowledged restore must reject before transport.');
  await p.restore({token:snap.token,inputQuiescent:true});assert.deepEqual([...f.state.formats],[...f.initial]);
  assert.equal((await p.close()).cleanup,'confirmed');
  const g=fixture(),q=createClipboardProvider({transport:g.wire});await q.doctor();const pending=await q.snapshot();
  await q.writeText({token:pending.token,text:'synthetic'});await q.deferAutomaticRestore({token:pending.token});
  assert.equal((await q.close()).cleanup,'unknown');assert.equal(g.state.writes,1);assert.equal(g.state.active.requiresInputQuiescence,true);
});

test('restarted pending metadata retains the quiescence gate and recovery forwards only an explicit true acknowledgement',async()=>{
  const calls=[],token=randomUUID();
  const p=createClipboardProvider({transport:{async request(command,fields){calls.push({command,fields});
    if(command==='info')return {version:1,ready:false,recoveryPending:true,mode:'text-only',desktopInput:false};
    if(command==='recovery_info')return {token,phase:'written',sha256:'a'.repeat(64),sequence:2,recoveryPending:true,requiresInputQuiescence:true};
    if(command==='recover'){
      if(fields.inputQuiescent!==true)throw fail('clipboard_input_quiescence_required');
      return {restored:true,verified:true};
    }
    if(command==='close')return {cleanup:'confirmed'};
    throw fail('clipboard_unexpected_command');
  }}});
  await p.doctor();assert.equal((await p.recoveryInfo()).requiresInputQuiescence,true);
  await assert.rejects(p.restore({token}),{code:'clipboard_input_quiescence_required'});
  await assert.rejects(p.recover(),{code:'clipboard_input_quiescence_required'});
  assert.equal((await p.recover({inputQuiescent:true})).verified,true);
  assert.deepEqual(calls.filter(c=>c.command==='recover').map(c=>c.fields.inputQuiescent),[false,true]);await p.close();
});

test('private native transport keeps payload out of argv and rejects arbitrary commands',async()=>{
  const calls=[];let child;
  const spawnImpl=(executable,args,options)=>{
    calls.push({executable,args,options});child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();
    child.stdin=new Writable({write(bytes,_encoding,done){const request=JSON.parse(bytes.toString());queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result:{accepted:true}})+'\n'));done();},
      final(done){child.exitCode=0;queueMicrotask(()=>child.emit('close',0));done();}});
    child.kill=()=>{child.exitCode=1;child.emit('close',1);};return child;
  };
  const transport=createClipboardTransport({helperPath:require('node:path').resolve('owned-helper.exe'),spawnImpl});
  await transport.request('write_text',{token:randomUUID(),text:'PRIVATE_IPC_ONLY'});
  assert.equal(JSON.stringify(calls).includes('PRIVATE_IPC_ONLY'),false);assert.deepEqual(calls[0].args,['--stdio']);assert.equal(calls[0].options.shell,false);
  await assert.rejects(transport.request('launch_shell'),{code:'clipboard_invalid_command'});await transport.dispose();
});
