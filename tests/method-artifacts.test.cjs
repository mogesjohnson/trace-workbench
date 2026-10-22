'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ProviderRegistry,createLocalArtifactProvider,verifyArtifactHandoff,mapPoint}=require('../src/method/index.cjs');

test('METHOD-HANDOFF real local Unicode/space paths verify receiving bytes and reject changed bytes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trace-method-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const a=path.join(root,'source report 日本語.txt'),b=path.join(root,'received report 日本語.txt');
  await fs.writeFile(a,'saved report\n');await fs.copyFile(a,b);
  const registry=new ProviderRegistry([createLocalArtifactProvider()]);
  const request={source:{environment:'local',path:a},destination:{environment:'local',path:b}};
  const receipt=await verifyArtifactHandoff(registry,request);assert.equal(receipt.bytes,13);assert.equal(receipt.transferPerformed,false);
  await fs.writeFile(b,'other report\n');await assert.rejects(verifyArtifactHandoff(registry,request),{code:'artifact-mismatch'});
  await fs.unlink(b);await assert.rejects(verifyArtifactHandoff(registry,request),{code:'artifact-missing'});
  await assert.rejects(verifyArtifactHandoff(registry,{...request,destination:{environment:'worker',path:b}}),{code:'no-route'});
});

test('artifact handoff rejects relative paths and unverified identities',async()=>{
  const registry=new ProviderRegistry([createLocalArtifactProvider()]);
  await assert.rejects(verifyArtifactHandoff(registry,{source:{environment:'local',path:'relative.txt'},destination:{environment:'local',path:'/x'}}),{code:'invalid-artifact'});
});

test('atomic path-replacement metadata cannot verify bytes from the unchanged old open handle',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trace-method-swap-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const target=path.join(root,'report.txt'),replacement=path.join(root,'replacement.txt');
  await fs.writeFile(target,'original bytes');await fs.writeFile(replacement,'replacement bytes');
  const originalOpen=fs.open.bind(fs),originalStat=fs.stat.bind(fs);let swapped=false;
  // Model a namespace replacement at the stat boundary; Windows can deny renaming
  // over the open file, while a POSIX editor may atomically replace it.
  t.mock.method(fs,'stat',async(file,options)=>originalStat(swapped&&file===target?replacement:file,options));
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await originalOpen(...args),create=handle.createReadStream.bind(handle);
    handle.createReadStream=options=>({async *[Symbol.asyncIterator](){
      for await(const chunk of create(options)) {
        swapped=true;yield chunk;
      }
    }});return handle;
  });
  await assert.rejects(createLocalArtifactProvider().fileIdentity({environment:'local',path:target}),{code:'artifact-changed'});
  assert.equal(swapped,true);
});

test('METHOD-OBSERVE coordinate mapping defaults to TRACE window-local units and never guesses scaling',()=>{
  const args={observationId:'new',expectedObservationId:'new',frame:{x:-1920,y:60,width:1920,height:1080},
    source:{kind:'preview-pixels',width:960,height:540},point:{x:480,y:270}};
  assert.deepEqual(mapPoint(args),{x:960,y:540,coordinateSpace:'window-local-physical-pixels',observationId:'new'});
  assert.equal(mapPoint({...args,output:'physical-screen-pixels'}).x,-960);
  assert.throws(()=>mapPoint({...args,observationId:'old'}),{code:'invalid-geometry'});
  assert.throws(()=>mapPoint({...args,source:{kind:'css-pixels'}}),{code:'invalid-geometry'});
  assert.throws(()=>mapPoint({...args,point:{x:960,y:540}}),{code:'invalid-geometry'});
});
