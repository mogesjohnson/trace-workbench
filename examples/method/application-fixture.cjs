'use strict';
// Source-owned, non-GUI fixture for recipe acceptance. It reads a document and answers actual process-identity challenges.
const fs=require('node:fs/promises');
const {randomUUID,createHash}=require('node:crypto');
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
const generation=randomUUID();
const identity=(async()=>{
  const documentPath=await fs.realpath(value('--document')),bytes=await fs.readFile(documentPath);
  return {exists:true,pid:process.pid,generation,executable:await fs.realpath(process.execPath),
    environment:value('--environment'),profileId:value('--profile-id'),profileRoot:await fs.realpath(value('--profile-root')),
    root:await fs.realpath(value('--root')),documentPath,
    documentProof:{opened:true,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}};
})();
process.on('message',async message=>{
  if(message?.type!=='inspect'||typeof message.nonce!=='string')return;
  try{process.send?.({type:'identity',nonce:message.nonce,identity:await identity});}
  catch{process.send?.({type:'identity',nonce:message.nonce,identity:{exists:false,pid:process.pid}});}
});
setInterval(()=>{},1000);
