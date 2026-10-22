'use strict';
// This portable example is an in-memory simulation, not native/browser acceptance.
const { ComputerMethod } = require('../../src/method/index.cjs');
async function main() {
  const report = { focused: false, text: '', saved: false }; let capture = 0;
  const provider = { id:'simulation',channel:'app-connector',usesDesktop:false,available:true,
    environments:['simulation'],apps:['writer'],capabilities:['edit'],
    async discover(target){return [{...target,windowId:'document-1'}];},
    async observe({target}){return {id:`capture-${++capture}`,target,evidenceKey:JSON.stringify(report),evidence:{...report}};},
    async act({payload}){
      if(payload.type==='focus')report.focused=true;
      if(payload.type==='type')report.text=payload.text;
      if(payload.type==='save')report.saved=true;
      return {delivery:'delivered'};
    },async close(){return {cleanup:'confirmed'};}
  };
  const method = new ComputerMethod({providers:[provider],
    verifyStep:({checkId,after})=>({focus:after.evidence.focused,type:after.evidence.text==='Report ready.',save:after.evidence.saved})[checkId]?'confirmed':'absent',
    verifyEffect:({after})=>after.evidence.saved&&after.evidence.text==='Report ready.'?'confirmed':'absent'});
  method.start({goalId:'prepare-report',effects:[{id:'report',checkId:'saved-report',steps:['focus','type','save'].map(id=>({
    id,checkId:id,capability:'edit',target:{environment:'simulation',app:'writer',kind:'app'}
  }))}]});
  try {
    for(const id of ['focus','type','save']) {
      await method.discover('report',id);await method.observe('report',id);
      await method.execute('report',id,{type:id,...(id==='type'?{text:'Report ready.'}:{})});
      await method.verifyStep('report',id);
    }
    await method.verifyEffect('report');
    process.stdout.write(JSON.stringify({scope:'simulation',...method.status()},null,2)+'\n');
  } finally {await method.close();}
}
main().catch(error=>{process.stderr.write(`${error.code||'error'}: ${error.message}\n`);process.exitCode=1;});
