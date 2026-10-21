'use strict';
// Executes one host-configured application recipe. Public actions cannot name an executable or arbitrary arguments.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fail, text, digest } = require('./shared.cjs');
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a,b) => text(a) && text(b) && canonical(a) === canonical(b);
const inside = (root,file) => {
  const relative=path.relative(root,file);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
};
async function deadline(operation,ms) {
  let timer;
  try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Application operation deadline expired.'),{code:'application-timeout'})),ms);})]);}
  finally{clearTimeout(timer);}
}
function createApplicationProvider({ recipe, inspectOwnership, hostEnvironment='local',
  id, usesDesktop=true, timeoutMs=5000 }={}) {
  const r=recipe;
  if(!r||!text(r.id)||!text(r.app)||!text(r.environment)||r.environment!==hostEnvironment
    ||!path.isAbsolute(r.executable||'')||!path.isAbsolute(r.root||'')||!r.profile||!text(r.profile.id)
    ||!path.isAbsolute(r.profile.root||'')||!Array.isArray(r.documentRoots)||!r.documentRoots.length
    ||!r.documentRoots.every(p=>text(p)&&path.isAbsolute(p))||!Array.isArray(r.arguments)
    ||!r.arguments.every(a=>typeof a==='string'&&!a.includes('\0'))||typeof inspectOwnership!=='function'
    ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000
    ||[r.id,r.app,r.environment,r.profile.id,hostEnvironment].some(value=>value.includes('\0'))
    ||(id!==undefined&&(!text(id)||id.includes('\0')))
    ||(r.extensions!==undefined&&(!Array.isArray(r.extensions)||!r.extensions.every(text)))) {
    fail('application-config','Configure one known host/app/executable/profile/root/document recipe and a real ownership inspector.');
  }
  const manifest={id:r.id,app:r.app,environment:r.environment,executable:r.executable,root:r.root,
    profile:{id:r.profile.id,root:r.profile.root},documentRoots:[...r.documentRoots],arguments:[...r.arguments],
    extensions:r.extensions?[...r.extensions].map(e=>e.toLowerCase()):null,ipc:r.ipc===true};
  const allowedTokens=['{document}','{profileRoot}','{profileId}','{root}','{environment}'];
  if(!manifest.arguments.includes('{document}')||manifest.arguments.some(a=>/\{[^}]+\}/.test(a)&&!allowedTokens.includes(a))
    ||(manifest.extensions&&(!manifest.extensions.length||!manifest.extensions.every(e=>/^\.[a-z0-9]+$/.test(e))))) {
    fail('application-config','Recipe arguments may use only whole declared tokens and explicit extension names.');
  }
  const slotGeneration=randomUUID(),slotId=`application:${manifest.id}:${manifest.profile.id}`;
  let capture=null,roots=null,bound=null,pending=null,disposed=false,busy=false,quarantine=false;
  const ref=()=>({environment:manifest.environment,app:manifest.app,windowId:slotId,
    identity:{generation:slotGeneration},profileId:manifest.profile.id,ownership:bound?.ownership||'unbound'});
  const assertTarget=target=>{
    if(disposed||target.environment!==manifest.environment||target.app!==manifest.app||target.windowId!==slotId
      ||target.identity?.generation!==slotGeneration)fail('target-mismatch','Use this exact configured application slot lifetime.');
  };
  const assertCapture=(target,observationId)=>{
    assertTarget(target);if(!capture||capture.id!==observationId)fail('stale-application','A current application observation is required.');
  };
  async function configure() {
    const executable=await fs.realpath(manifest.executable),root=await fs.realpath(manifest.root),profile=await fs.realpath(manifest.profile.root);
    const documentRoots=await Promise.all(manifest.documentRoots.map(p=>fs.realpath(p)));
    if(!(await fs.stat(executable)).isFile()||!(await fs.stat(root)).isDirectory()||!(await fs.stat(profile)).isDirectory()
      ||!inside(root,profile)||documentRoots.some(p=>!inside(root,p))
      ||!(await Promise.all(documentRoots.map(p=>fs.stat(p)))).every(s=>s.isDirectory())) {
      fail('application-root','Recipe profile and document directories must remain inside the configured root.');
    }
    roots={executable,root,profile,documentRoots};
  }
  async function document(file) {
    if(!text(file)||!path.isAbsolute(file))fail('document-out-of-scope','Use an absolute regular document path.');
    const actual=await fs.realpath(file);
    if(!roots.documentRoots.some(root=>inside(root,actual))||!(await fs.stat(actual)).isFile()
      ||(manifest.extensions&&!manifest.extensions.includes(path.extname(actual).toLowerCase()))) {
      fail('document-out-of-scope','Document is outside the configured real-path/extension allowlist.');
    }
    return actual;
  }
  async function inspect(candidate,expectedGeneration) {
    const actual=await deadline(Promise.resolve().then(()=>inspectOwnership({pid:candidate.pid,
      child:candidate.child||null,environment:manifest.environment,app:manifest.app})),timeoutMs);
    if(!actual||actual.exists===false)fail('application-exited','The bound application process is no longer present.');
    if(actual.pid!==candidate.pid||!text(actual.generation)||(expectedGeneration&&actual.generation!==expectedGeneration)
      ||actual.environment!==manifest.environment||!samePath(actual.executable,roots.executable)
      ||actual.profileId!==manifest.profile.id||!samePath(actual.profileRoot,roots.profile)||!samePath(actual.root,roots.root)
      ||(candidate.documentPath&&!samePath(actual.documentPath,candidate.documentPath))) {
      fail('application-identity-changed','Actual process lifetime/executable/profile/document identity differs from the configured binding.');
    }
    return {pid:actual.pid,generation:actual.generation,executable:roots.executable,
      profileId:manifest.profile.id,profileRoot:roots.profile,root:roots.root,environment:manifest.environment,
      documentPath:candidate.documentPath||actual.documentPath||null,
      documentProof:actual.documentProof?.opened===true&&/^[a-f0-9]{64}$/i.test(actual.documentProof.sha256||'')
        &&Number.isSafeInteger(actual.documentProof.bytes)&&actual.documentProof.bytes>=0
        ?{opened:true,sha256:actual.documentProof.sha256.toLowerCase(),bytes:actual.documentProof.bytes}:null};
  }
  async function validate(payload) {
    const fields={launch:['documentPath'],attach:['pid','generation','documentPath'],read:[]}[payload?.type];
    if(!fields||Object.keys(payload).some(k=>k!=='type'&&!fields.includes(k)))fail('invalid-application-action','Use typed launch, attach or read; executable/arguments are never action fields.');
    if(payload.type==='read')return {type:'read'};
    if(bound||pending||quarantine)fail('application-already-bound','Launch/attach never falls back or replaces an existing or uncertain process.');
    const documentPath=await document(payload.documentPath);
    if(payload.type==='attach'&&(!Number.isSafeInteger(payload.pid)||payload.pid<=0||!text(payload.generation))) {
      fail('invalid-application-action','Attach requires an explicitly observed PID and creation generation.');
    }
    return {...payload,documentPath};
  }
  async function perform(payload) {
    if(payload.type==='read')return {delivery:'delivered',ownership:bound?.ownership||'unbound'};
    if(payload.type==='attach') {
      const candidate={pid:payload.pid,documentPath:payload.documentPath};
      const actual=await inspect(candidate,payload.generation);
      bound={...candidate,generation:actual.generation,ownership:'attached',child:null};
      return {delivery:'delivered',ownership:'attached',process:actual};
    }
    const substitutions={'{document}':payload.documentPath,'{profileRoot}':roots.profile,
      '{profileId}':manifest.profile.id,'{root}':roots.root,'{environment}':manifest.environment};
    const args=manifest.arguments.map(arg=>Object.hasOwn(substitutions,arg)?substitutions[arg]:arg);
    let child;
    try {
      child=spawn(roots.executable,args,{shell:false,windowsHide:true,cwd:roots.root,
        stdio:manifest.ipc?['ignore','ignore','ignore','ipc']:'ignore'});
      child.on('error',()=>{});
      pending={pid:child.pid,child,documentPath:payload.documentPath,ownership:'created'};
      await deadline(new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}),timeoutMs);
      pending.pid=child.pid;
      const actual=await inspect(pending);
      bound={...pending,generation:actual.generation};pending=null;
      return {delivery:'delivered',ownership:'created',process:actual};
    } catch(error) {
      if(!child?.pid){pending=null;return {delivery:'not-delivered',errorCode:error.code||'application-launch-failed'};}
      quarantine=true;return {delivery:'unknown',cleanup:'unknown',errorCode:error.code||'application-launch-uncertain'};
    }
  }
  const provider={id:id||`application:${manifest.environment}:${manifest.id}:${manifest.profile.id}`,
    channel:'app-connector',usesDesktop,available:false,environments:[manifest.environment],apps:[manifest.app],windowIds:[slotId],
    capabilities:['application-launch','application-attach','application-read'],
    async doctor(){
      provider.available=false;
      try{if(disposed)fail('application-disposed','This adapter was disposed.');await configure();
        if(bound)await inspect(bound,bound.generation);provider.available=!quarantine;
        return {ready:provider.available,code:quarantine?'application-quarantined':null,recipeId:manifest.id};
      }catch(error){return {ready:false,code:error.code||'application-unavailable'};}
    },
    async discover(target){
      if(!provider.available)fail('provider-unavailable','Validate the actual configured recipe before lifecycle work.');
      if(target.environment!==manifest.environment||target.app!==manifest.app||target.kind!=='app'
        ||(target.windowId&&target.windowId!==slotId))return [];
      if(bound)await inspect(bound,bound.generation);return [ref()];
    },
    async observe({target}){
      capture=null;assertTarget(target);
      if(!provider.available)fail('provider-unavailable','The configured application provider is not ready.');
      const actual=bound?await inspect(bound,bound.generation):null;
      const evidence={state:bound?'running':pending?'uncertain':'not-running',process:actual,
        ownership:bound?.ownership||pending?.ownership||'unbound',recipeId:manifest.id,quarantine};
      const observation={id:randomUUID(),target:ref(),evidenceKey:digest(evidence),evidence};capture=observation;return observation;
    },
    async validateAction({target,observationId,capability,payload}){
      assertCapture(target,observationId);
      if(!provider.available)fail('provider-unavailable','The application recipe is no longer ready.');
      const expected={launch:'application-launch',attach:'application-attach',read:'application-read'}[payload?.type];
      if(capability!==expected)fail('unsupported-capability','Use the explicit lifecycle operation capability.');
      if(bound)await inspect(bound,bound.generation);
      const checked=await validate(payload);
      if(checked.type==='attach')await inspect({pid:checked.pid,documentPath:checked.documentPath},checked.generation);
      return checked;
    },
    async act(request){
      if(busy)fail('application-busy','A lifecycle operation is in flight.');busy=true;
      try{const checked=await provider.validateAction(request);capture=null;return await perform(checked);}
      finally{busy=false;}
    },
    async close({target}){if(busy)fail('application-busy','A lifecycle operation is in flight.');assertTarget(target);capture=null;return {cleanup:quarantine?'unknown':'confirmed',applicationClosed:false,
      ownership:bound?.ownership||pending?.ownership||'unbound',scope:'adapter use released; application disposal is explicit'};},
    async dispose(){
      if(busy)fail('application-busy','A lifecycle operation is in flight.');busy=true;
      try{
      capture=null;
      const resource=bound||pending;
      if(!resource||resource.ownership==='attached'){disposed=true;provider.available=false;return {cleanup:'confirmed',applicationClosed:false,ownership:resource?.ownership||'unbound'};}
      const child=resource.child;
      if(child?.exitCode!==null||child?.signalCode!==null){disposed=true;provider.available=false;quarantine=false;return {cleanup:'confirmed',applicationClosed:true,ownership:'created'};}
      // Never kill a PID from a cached receipt. Reinspect its actual creation generation first.
      try{await inspect(resource,resource.generation);}
      catch(error){quarantine=true;provider.available=false;throw error;}
      try{
        if(!child.kill('SIGTERM')){quarantine=true;provider.available=false;return {cleanup:'unknown',applicationClosed:false,ownership:'created'};}
      }catch{quarantine=true;provider.available=false;return {cleanup:'unknown',applicationClosed:false,ownership:'created'};}
      let onExit;
      const exited=new Promise(resolve=>{onExit=resolve;child.once('exit',onExit);});
      try{await deadline(exited,timeoutMs);disposed=true;provider.available=false;quarantine=false;
        return {cleanup:'confirmed',applicationClosed:true,ownership:'created'};
      }catch{quarantine=true;provider.available=false;return {cleanup:'unknown',applicationClosed:false,ownership:'created'};}
      finally{child.off('exit',onExit);}
      }finally{busy=false;}
    }
  };
  return provider;
}
module.exports={createApplicationProvider};
