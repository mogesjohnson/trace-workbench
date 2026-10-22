'use strict';
// Actual non-GUI recipe example. This fixture inspector is specific to the supplied
// source-owned IPC application; a GUI recipe needs its own real OS/app inspector.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {createApplicationProvider,ComputerMethod}=require('../../src/method/index.cjs');

async function main(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trace-application-example-'));
  const profileRoot=path.join(root,'isolated-profile'),documents=path.join(root,'documents');
  await fs.mkdir(profileRoot);await fs.mkdir(documents);
  const documentPath=path.join(documents,'example report 日本語.txt');await fs.writeFile(documentPath,'Example document.\n');
  const processes=new Map();
  const provider=createApplicationProvider({usesDesktop:false,recipe:{
    id:'source-owned-reader',app:'document-reader',environment:'local',executable:process.execPath,
    root,profile:{id:'example-profile',root:profileRoot},documentRoots:[documents],extensions:['.txt'],ipc:true,
    arguments:[path.join(__dirname,'application-fixture.cjs'),'--document','{document}',
      '--profile-root','{profileRoot}','--profile-id','{profileId}','--root','{root}','--environment','{environment}']},
    inspectOwnership:async({pid,child})=>{
      if(child)processes.set(pid,child);const processHandle=processes.get(pid);
      if(!processHandle||processHandle.exitCode!==null)return {exists:false,pid};
      const nonce=randomUUID();return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{processHandle.off('message',receive);reject(new Error('Fixture identity timed out.'));},3000);
        const receive=message=>{if(message?.type==='identity'&&message.nonce===nonce){clearTimeout(timer);processHandle.off('message',receive);resolve(message.identity);}};
        processHandle.on('message',receive);processHandle.send({type:'inspect',nonce});
      });
    }});
  const method=new ComputerMethod({providers:[provider],
    verifyStep:({after})=>after.evidence.process?.documentProof?.opened?'confirmed':'absent',
    verifyEffect:({after})=>after.evidence.process?.documentProof?.opened?'confirmed':'absent'});
  try{
    if(!(await provider.doctor()).ready)throw new Error('Known recipe is unavailable.');
    method.start({goalId:'open-owned-example',effects:[{id:'document',checkId:'opened-by-owned-reader',steps:[{
      id:'launch',checkId:'opened',capability:'application-launch',target:{environment:'local',app:'document-reader',kind:'app'}}]}]});
    await method.discover('document','launch');await method.observe('document','launch');
    await method.execute('document','launch',{type:'launch',documentPath});await method.verifyStep('document','launch');
    const result=await method.verifyEffect('document');
    process.stdout.write(JSON.stringify({scope:'actual-source-owned-non-GUI-child',complete:result.complete,desktopInput:false})+'\n');
  }finally{
    await method.close();const cleanup=await provider.dispose();
    if(cleanup.cleanup!=='confirmed')throw new Error('Owned application cleanup is unresolved.');
    await fs.rm(root,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(error=>{process.stderr.write(`${error.code||'error'}: ${error.message}\n`);process.exitCode=1;});
module.exports={main};
