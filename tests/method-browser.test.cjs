'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const {ComputerMethod,createBrowserProvider}=require('../src/method/index.cjs');
const configured=!!process.env.TRACE_PLAYWRIGHT_MODULE&&!!process.env.TRACE_BROWSER_EXECUTABLE;
const live={skip:configured?false:'Supply TRACE_PLAYWRIGHT_MODULE and TRACE_BROWSER_EXECUTABLE for owned headless browser acceptance.',timeout:30000};
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

async function ownedBrowser(t) {
  const playwright=require(process.env.TRACE_PLAYWRIGHT_MODULE);
  let saves=0;
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url,'http://fixture');response.setHeader('Content-Type','text/html; charset=utf-8');
    if(url.pathname==='/result') {saves++;response.end(`<!doctype html><title>Saved</title><h1>Saved report</h1><p role="status" aria-label="Saved report">Saved: ${escape(url.searchParams.get('name')||'')}</p>`);return;}
    if(url.pathname==='/other') {response.end('<!doctype html><title>Other</title><h1>Other page</h1>');return;}
    response.end('<!doctype html><html><head><title>Owned report fixture</title></head><body><h1>Report</h1><form action="/result" method="get"><label>Report name<input name="name"></label><button>Save report</button></form><button disabled>Disabled</button><button hidden>Hidden</button><script>console.error("owned-fixture-message")</script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await playwright.chromium.launch({executablePath:process.env.TRACE_BROWSER_EXECUTABLE,headless:true,timeout:20000});
  const context=await browser.newContext({viewport:{width:1000,height:700}}),page=await context.newPage();
  t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));});
  return {browser,page,origin,get saves(){return saves;}};
}

test('METHOD-BROWSER actual headless Edge fills, submits, reads and verifies once after lost reply',live,async t=>{
  const f=await ownedBrowser(t);
  const provider=createBrowserProvider({page:f.page,pageId:'owned-report-tab',ownership:'created',allowedOrigins:[f.origin],environment:'headless-worker'});
  await f.page.goto(f.origin);assert.equal((await provider.doctor()).ready,true);
  const originalAct=provider.act.bind(provider);
  provider.act=async request=>{const receipt=await originalAct(request);return request.payload.type==='click'?{delivery:'unknown'}:receipt;};
  const expected='Résumé 日本語';
  const method=new ComputerMethod({providers:[provider],ttlMs:10000,
    verifyStep:async({checkId,after})=>{
      if(checkId==='fill')return await f.page.getByLabel('Report name',{exact:true}).inputValue()===expected?'confirmed':'absent';
      if(checkId==='submit')return new URL(f.page.url()).pathname==='/result'?'confirmed':'unknown';
      return after.evidence.readback?.value===`Saved: ${expected}`?'confirmed':'absent';
    },verifyEffect:async()=>await f.page.getByRole('status',{name:'Saved report',exact:true}).innerText()===`Saved: ${expected}`&&f.saves===1?'confirmed':'absent'});
  const target={environment:'headless-worker',app:'browser',kind:'web',windowId:'owned-report-tab'};
  method.start({goalId:'save-browser-report',effects:[{id:'report',checkId:'saved-once',steps:[
    {id:'fill',checkId:'fill',capability:'browser-action',target},
    {id:'submit',checkId:'submit',capability:'browser-action',target},
    {id:'read',checkId:'read',capability:'browser-read',target}]}]});
  const actions=[{type:'fill',locator:{label:'Report name'},value:expected},
    {type:'click',locator:{role:'button',name:'Save report'}},
    {type:'read',locator:{role:'status',name:'Saved report'},property:'text'}];
  for(const [index,id] of ['fill','submit','read'].entries()) {
    await method.discover('report',id);const capture=await method.observe('report',id);
    assert.equal(capture.evidence.screenshot.mimeType,'image/png');assert.ok(capture.evidence.screenshot.data.length>100);
    if(id==='fill')assert.ok(capture.evidence.diagnostics.some(d=>d.text==='owned-fixture-message'));
    const receipt=await method.execute('report',id,actions[index]);
    if(id==='submit') {assert.equal(receipt.delivery,'unknown');await assert.rejects(method.execute('report',id,actions[index]),{code:'delivery-unknown'});}
    assert.equal((await method.verifyStep('report',id)).verdict,'confirmed');
  }
  assert.equal((await method.verifyEffect('report')).complete,true);assert.equal(f.saves,1);
  await method.close();assert.equal(f.page.isClosed(),false);assert.equal((await provider.dispose()).closed,true);
  t.diagnostic(JSON.stringify({scope:'real-owned-loopback-page',browser:f.browser.version(),playwright:require(path.join(process.env.TRACE_PLAYWRIGHT_MODULE,'package.json')).version,
    headless:true,desktopInput:false,saveCount:f.saves,verifiedResult:`Saved: ${expected}`,ownedTabClosed:f.page.isClosed()}));
});

test('METHOD-BROWSER actual navigation invalidates captures and disabled controls never dispatch',live,async t=>{
  const f=await ownedBrowser(t);await f.page.goto(f.origin);
  const p=createBrowserProvider({page:f.page,pageId:'scope-tab',ownership:'created',allowedOrigins:[f.origin]});await p.doctor();
  const [target]=await p.discover({environment:'local',app:'browser',kind:'web'}),before=await p.observe({target});
  await assert.rejects(p.validateAction({target,observationId:before.id,capability:'browser-action',payload:{type:'click',locator:{role:'button',name:'Disabled'}}}),{code:'control-disabled'});
  await f.page.goto(`${f.origin}/other`);
  await assert.rejects(p.act({target,observationId:before.id,capability:'browser-action',payload:{type:'navigate',url:f.origin}}),{code:'stale-page'});
  assert.equal(new URL(f.page.url()).pathname,'/other');
  const current=await p.observe({target});
  assert.equal((await p.act({target,observationId:current.id,capability:'browser-action',payload:{type:'navigate',url:f.origin}})).delivery,'delivered');
  assert.equal(new URL(f.page.url()).pathname,'/');
  await f.page.goto('about:blank');assert.equal((await p.doctor()).ready,false);
  assert.equal((await p.close({target})).cleanup,'confirmed');await p.dispose();
});

test('METHOD-BROWSER attached pages remain open and owned tab disposal is explicit',live,async t=>{
  const f=await ownedBrowser(t);await f.page.goto(f.origin);
  const attached=createBrowserProvider({page:f.page,pageId:'attached',allowedOrigins:[f.origin]});await attached.doctor();
  assert.equal((await attached.dispose()).closed,false);assert.equal(f.page.isClosed(),false);
  const owned=await f.page.context().newPage();await owned.goto(f.origin);
  const p=createBrowserProvider({page:owned,pageId:'created',ownership:'created',allowedOrigins:[f.origin]});await p.doctor();
  assert.equal((await p.dispose()).closed,true);assert.equal(owned.isClosed(),true);assert.equal(f.page.isClosed(),false);
});

for (const scope of ['allowed', 'outside']) {
  test(`METHOD-BROWSER navigation during final semantic check blocks ${scope} replacement before mutation`,live,async t=>{
    const f=await ownedBrowser(t);await f.page.goto(f.origin);
    let enabledChecks=0,mutations=0;
    const destination=scope==='allowed'?`${f.origin}/replacement`:'about:blank';
    // Every operation still uses the actual Page/Locator. Trigger actual navigation
    // in the last awaited check of act's second validation, after coordinator validation.
    const page=new Proxy(f.page,{get(target,key){
      if(key==='getByRole')return (...args)=>{
        const control=target.getByRole(...args);
        return new Proxy(control,{get(actual,field){
          if(field==='isEnabled')return async (...options)=>{
            const value=await actual.isEnabled(...options);
            if(++enabledChecks===2)await target.goto(destination);
            return value;
          };
          if(field==='click')return async (...options)=>{mutations++;return actual.click(...options);};
          const value=Reflect.get(actual,field,actual);return typeof value==='function'?value.bind(actual):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const provider=createBrowserProvider({page,pageId:`final-check-${scope}`,ownership:'created',
      allowedOrigins:[f.origin],timeoutMs:1000});
    assert.equal((await provider.doctor()).ready,true);
    const method=new ComputerMethod({providers:[provider],ttlMs:10000,
      verifyStep:async()=> 'unknown',verifyEffect:async()=> 'unknown'});
    method.start({goalId:`navigation-race-${scope}`,effects:[{id:'report',checkId:'saved-once',steps:[{
      id:'save',checkId:'saved',capability:'browser-action',
      target:{environment:'local',app:'browser',kind:'web',windowId:`final-check-${scope}`}}]}]});
    await method.discover('report','save');await method.observe('report','save');
    const receipt=await method.execute('report','save',{type:'click',locator:{role:'button',name:'Save report'}});
    assert.equal(enabledChecks,2);assert.equal(f.page.url(),destination);
    assert.equal(mutations,0,'No mutating Playwright method may be called after navigation invalidates capture.');
    assert.equal(f.saves,0,'The owned fixture must receive no save.');
    assert.equal(receipt.delivery,'unknown');
    await method.close();assert.equal((await provider.dispose()).closed,true);
    t.diagnostic(JSON.stringify({scope:'real-navigation-during-final-validation',destination:scope,
      headless:true,desktopInput:false,semanticChecks:enabledChecks,mutatorCalls:mutations,serverSaveCount:f.saves,
      browser:f.browser.version(),ownedTabClosed:f.page.isClosed()}));
  });
}
