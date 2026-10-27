'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {createApplicationProvider}=require('../src/method/application-provider.cjs');
const {ComputerMethod}=require('../src/method/coordinator.cjs');

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trace-known-app-'));
  const profile=path.join(root,'isolated profile'),docs=path.join(root,'documents');
  await fs.mkdir(profile);await fs.mkdir(docs);
  const documentPath=path.join(docs,'Résumé & quoted report 日本語.txt'),content='Known application document\n';await fs.writeFile(documentPath,content);
  const recipe={id:'source-owned-document-reader',app:'document-reader',environment:'local',
    executable:process.execPath,root,profile:{id:'owned-profile',root:profile},documentRoots:[docs],extensions:['.txt'],ipc:true,
    arguments:[path.resolve(__dirname,'../examples/method/application-fixture.cjs'),
      '--document','{document}','--profile-root','{profileRoot}','--profile-id','{profileId}',
      '--root','{root}','--environment','{environment}']};
  const children=new Map();let replaceGeneration=false,inspectionFails=false;
  async function inspectOwnership({pid,child}) {
    if(child)children.set(pid,child);
    const processHandle=children.get(pid);
    if(!processHandle||processHandle.exitCode!==null||processHandle.signalCode!==null)return {exists:false,pid};
    if(inspectionFails)throw Object.assign(new Error('Inspection unavailable.'),{code:'inspector-unavailable'});
    const nonce=randomUUID();
    const actual=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{processHandle.off('message',message);reject(new Error('Fixture identity deadline.'));},3000);
      const message=result=>{if(result?.type==='identity'&&result.nonce===nonce){clearTimeout(timer);processHandle.off('message',message);resolve(result.identity);}};
      processHandle.on('message',message);processHandle.send({type:'inspect',nonce});
    });
    return replaceGeneration?{...actual,generation:'reused-pid-replacement-generation'}:actual;
  }
  t.after(async()=>{
    for(const child of children.values())if(child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
    }
    await fs.rm(root,{recursive:true,force:true});
  });
  const make=extra=>createApplicationProvider({recipe,inspectOwnership,usesDesktop:false,...extra});
  const external=async()=>{
    const values={'{document}':documentPath,'{profileRoot}':profile,'{profileId}':recipe.profile.id,'{root}':root,'{environment}':'local'};
    const child=spawn(recipe.executable,recipe.arguments.map(a=>values[a]||a),{shell:false,windowsHide:true,cwd:root,stdio:['ignore','ignore','ignore','ipc']});
    children.set(child.pid,child);await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});return child;
  };
  return {make,recipe,documentPath,content,children,inspectOwnership,external,
    set replaceGeneration(value){replaceGeneration=value;},set inspectionFails(value){inspectionFails=value;}};
}
async function observed(provider){assert.equal((await provider.doctor()).ready,true);const [target]=await provider.discover({environment:'local',app:'document-reader',kind:'app'});
  const observation=await provider.observe({target});return {target,observation};}
const request=(bound,payload,capability='application-launch')=>({target:bound.target,observationId:bound.observation.id,capability,payload});

test('known recipe actually launches shell:false non-GUI child with exact Unicode document and profile arguments',async t=>{
  const f=await fixture(t),p=f.make(),m=new ComputerMethod({providers:[p],
    verifyStep:({after})=>after.evidence.process?.documentProof?.opened?'confirmed':'absent',
    verifyEffect:async({after})=>after.evidence.process?.documentProof?.sha256===createHash('sha256').update(await fs.readFile(f.documentPath)).digest('hex')?'confirmed':'absent'});
  await p.doctor();m.start({goalId:'open-known-document',effects:[{id:'document',checkId:'opened-correct-bytes',steps:[
    {id:'launch',checkId:'running',capability:'application-launch',target:{environment:'local',app:'document-reader',kind:'app'}}]}]});
  await m.discover('document','launch');await m.observe('document','launch');
  const receipt=await m.execute('document','launch',{type:'launch',documentPath:f.documentPath});
  assert.equal(receipt.delivery,'delivered');assert.equal((await m.verifyStep('document','launch')).verdict,'confirmed');
  assert.equal((await m.verifyEffect('document')).complete,true);
  await m.close();const [child]=f.children.values();assert.equal(child.exitCode,null,'Coordinator release preserves the application.');
  const result=await p.dispose();assert.equal(result.applicationClosed,true);assert.equal(result.ownership,'created');
  assert.ok(child.exitCode!==null||child.signalCode!==null);
  t.diagnostic(JSON.stringify({scope:'actual-source-owned-non-GUI-child',shell:false,unicodeArgumentPreserved:true,
    documentBytesIndependentlyVerified:true,ownedChildClosed:true,desktopInput:false}));
});

test('attach verifies actual PID and creation generation without launching and preserves attached resources',async t=>{
  const f=await fixture(t),child=await f.external(),actual=await f.inspectOwnership({pid:child.pid}),p=f.make();
  const before=await observed(p),receipt=await p.act(request(before,{type:'attach',pid:actual.pid,generation:actual.generation,documentPath:f.documentPath},'application-attach'));
  assert.equal(receipt.ownership,'attached');assert.equal(f.children.size,1);
  const snapshot=await p.observe({target:before.target});assert.equal(snapshot.evidence.process.generation,actual.generation);
  assert.equal((await p.dispose()).applicationClosed,false);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
});

test('invalid document paths and arbitrary executable/argument fields fail before any child exists',async t=>{
  const f=await fixture(t),p=f.make(),before=await observed(p),outside=path.join(f.recipe.root,'outside.txt');await fs.writeFile(outside,'not allowed');
  for(const payload of [{type:'launch',documentPath:'relative.txt'},{type:'launch',documentPath:outside},
    {type:'launch',documentPath:path.dirname(f.documentPath)},{type:'launch',documentPath:f.documentPath,executable:process.execPath},
    {type:'launch',documentPath:f.documentPath,args:['arbitrary']}]) {
    await assert.rejects(p.validateAction(request(before,payload)));
  }
  assert.equal(f.children.size,0);
  assert.throws(()=>f.make({hostEnvironment:'other-host'}),{code:'application-config'});
  await p.dispose();
});

test('actual process lifetime revalidation prevents stale reads and killing a PID-replacement candidate',async t=>{
  const f=await fixture(t),p=f.make(),before=await observed(p);await p.act(request(before,{type:'launch',documentPath:f.documentPath}));
  const [child]=f.children.values();f.replaceGeneration=true;
  await assert.rejects(p.observe({target:before.target}),{code:'application-identity-changed'});
  await assert.rejects(p.dispose(),{code:'application-identity-changed'});assert.equal(child.exitCode,null);
  f.replaceGeneration=false;assert.equal((await p.dispose()).applicationClosed,true);
});

test('uncertain post-launch inspection retains the owned process and never falls back to another launch',async t=>{
  const f=await fixture(t),p=f.make(),before=await observed(p);f.inspectionFails=true;
  const result=await p.act(request(before,{type:'launch',documentPath:f.documentPath}));
  assert.equal(result.delivery,'unknown');assert.equal(result.cleanup,'unknown');assert.equal(f.children.size,1);
  const after=await p.observe({target:before.target});assert.equal(after.evidence.state,'uncertain');
  await assert.rejects(p.act({target:before.target,observationId:after.id,capability:'application-launch',payload:{type:'launch',documentPath:f.documentPath}}),{code:'application-already-bound'});
  assert.equal(f.children.size,1);f.inspectionFails=false;assert.equal((await p.dispose()).applicationClosed,true);
});

test('wrong-generation attach is rejected without launch fallback or terminating the actual process',async t=>{
  const f=await fixture(t),child=await f.external(),p=f.make(),before=await observed(p);
  await assert.rejects(p.act(request(before,{type:'attach',pid:child.pid,generation:'wrong-generation',documentPath:f.documentPath},'application-attach')),
    {code:'application-identity-changed'});
  assert.equal(f.children.size,1);assert.equal(child.exitCode,null);await p.dispose();
});

test('exact application slot selects the correct profile among ready providers of the same app',async t=>{
  const f=await fixture(t),secondProfile=path.join(f.recipe.root,'second isolated profile');await fs.mkdir(secondProfile);
  const first=f.make(),second=f.make({recipe:{...f.recipe,profile:{id:'profile-b',root:secondProfile}}});
  await Promise.all([first.doctor(),second.doctor()]);
  const m=new ComputerMethod({providers:[first,second],verifyStep:async()=> 'confirmed',verifyEffect:async()=> 'confirmed'});
  m.start({goalId:'profile-specific-open',effects:[{id:'open',checkId:'correct-profile',steps:[{
    id:'launch',checkId:'correct-profile',capability:'application-launch',target:{environment:'local',app:'document-reader',kind:'app',windowId:second.windowIds[0]}}]}]});
  assert.equal(m.route('open','launch').providerId,second.id);
  await m.discover('open','launch');await m.observe('open','launch');
  await m.execute('open','launch',{type:'launch',documentPath:f.documentPath});
  const capture=await m.observe('open','launch');assert.equal(capture.evidence.process.profileId,'profile-b');
  assert.equal(f.children.size,1);await m.close();await second.dispose();await first.dispose();
});

test('unsuccessful owned-process termination retains cleanup quarantine and cannot report ready',async t=>{
  const f=await fixture(t),p=f.make(),before=await observed(p);await p.act(request(before,{type:'launch',documentPath:f.documentPath}));
  const [child]=f.children.values(),kill=child.kill.bind(child);child.kill=()=>false;
  const result=await p.dispose();assert.equal(result.cleanup,'unknown');assert.equal(result.applicationClosed,false);
  assert.equal(child.exitCode,null);assert.equal((await p.close({target:before.target})).cleanup,'unknown');
  const doctor=await p.doctor();assert.equal(doctor.ready,false);assert.equal(doctor.code,'application-quarantined');
  child.kill=kill;assert.equal((await p.dispose()).cleanup,'confirmed');
});
