'use strict';
// Host supplies an actual Playwright Page. This module never launches/downloads a browser.
const { randomUUID } = require('node:crypto');
const { fail, text, digest } = require('./shared.cjs');
function createBrowserProvider({ page, pageId, environment = 'local', app = 'browser', id = `browser:${environment}:${pageId}`,
  allowedUrls = [], allowedOrigins = [], ownership = 'attached', timeoutMs = 5000,
  generation = randomUUID() } = {}) {
  if (!page || !['url','isClosed','screenshot','locator','getByRole','getByLabel','getByText','goto','on','off'].every(k => typeof page[k] === 'function')
    || !text(pageId) || !text(environment) || !text(app) || !text(id) || !['attached','created'].includes(ownership)
    || !Array.isArray(allowedUrls) || !Array.isArray(allowedOrigins) || (!allowedUrls.length && !allowedOrigins.length)
    || !allowedUrls.every(text) || !allowedOrigins.every(o => text(o) && o !== 'null')
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    fail('browser-config', 'Supply a real page, stable tab identity, explicit URL/origin scope and bounded timeout.');
  }
  let capture = null, navigation = 0, readback = null, disposed = false;
  const diagnostics = [], handlers = [];
  const note = entry => { diagnostics.push(entry); if (diagnostics.length > 50) diagnostics.shift(); };
  const on = (event, fn) => { page.on(event, fn); handlers.push([event, fn]); };
  on('framenavigated', frame => { if (frame === page.mainFrame()) { navigation++; capture = null; readback = null; } });
  on('console', message => note({ type:'console', level:message.type(), text:message.text().slice(0,1000) }));
  on('pageerror', error => note({ type:'pageerror', text:String(error.message).slice(0,1000) }));
  on('requestfailed', request => note({ type:'requestfailed', url:request.url(), error:request.failure()?.errorText || 'unknown' }));
  on('response', response => { if (response.status() >= 400) note({ type:'response', status:response.status(), url:response.url() }); });
  const allowed = url => {
    try { return allowedUrls.includes(url) || allowedOrigins.includes(new URL(url).origin); } catch { return false; }
  };
  const assertPage = () => {
    if (disposed || page.isClosed()) { provider.available = false; fail('page-closed', 'The supplied browser page is closed.'); }
    if (!allowed(page.url())) fail('page-out-of-scope', 'The actual page URL/origin is outside the explicitly supplied scope.');
  };
  const ref = () => ({ environment, app, windowId:pageId, ownership,
    identity:{ generation }, url:page.url(), origin:new URL(page.url()).origin });
  const assertTarget = target => {
    assertPage();
    if (target.environment !== environment || target.app !== app || target.windowId !== pageId
      || target.identity?.generation !== generation) fail('target-mismatch', 'Use this exact supplied page lifetime.');
  };
  const assertCapture = (target, observationId) => {
    assertTarget(target);
    if (!capture || capture.id !== observationId || capture.url !== page.url() || capture.version !== navigation) {
      fail('stale-page', 'Page navigation invalidated the prior observation.');
    }
  };
  const locator = descriptor => {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) fail('invalid-locator', 'Supply one semantic locator.');
    if (text(descriptor.role) && text(descriptor.name) && Object.keys(descriptor).every(k=>['role','name'].includes(k))) {
      return page.getByRole(descriptor.role,{name:descriptor.name,exact:true});
    }
    if (text(descriptor.label) && Object.keys(descriptor).length === 1) return page.getByLabel(descriptor.label,{exact:true});
    if (text(descriptor.text) && Object.keys(descriptor).length === 1) return page.getByText(descriptor.text,{exact:true});
    fail('invalid-locator', 'Use exact role/name, label, or text; arbitrary selectors/scripts are unsupported.');
  };
  const validPayload = payload => {
    const fields={read:['locator','property'],fill:['locator','value'],click:['locator'],press:['locator','key'],
      check:['locator','checked'],select:['locator','value'],navigate:['url']}[payload?.type];
    if (!fields || Object.keys(payload).some(k=>k!=='type'&&!fields.includes(k))) fail('invalid-browser-action', 'Unsupported browser action or extra fields.');
    if (payload.type === 'navigate') { if (!text(payload.url) || !allowed(payload.url)) fail('navigation-out-of-scope', 'Destination must be explicitly scoped.'); }
    else locator(payload.locator);
    if (['fill','select'].includes(payload.type) && typeof payload.value !== 'string') fail('invalid-browser-action', 'A literal value is required.');
    if (payload.type === 'press' && (!text(payload.key) || payload.key.length > 100)) fail('invalid-browser-action', 'Use one bounded named key/chord.');
    if (payload.type === 'check' && typeof payload.checked !== 'boolean') fail('invalid-browser-action', 'Declare the desired checked state.');
    if (payload.type === 'read' && !['text','value','checked'].includes(payload.property)) fail('invalid-browser-action', 'Read text, value or checked state explicitly.');
    return payload;
  };
  const provider = { id, channel:'browser',usesDesktop:false,available:false,environments:[environment],apps:[app],windowIds:[pageId],
    capabilities:['browser-read','browser-action'],
    async doctor() {
      try { assertPage(); await page.title(); provider.available = true; return {ready:true,mode:'supplied-playwright-page',ownership}; }
      catch(error) {provider.available=false;return {ready:false,code:error.code||'browser-unavailable'};}
    },
    async discover(target) {
      if (!provider.available) fail('provider-unavailable', 'Validate the supplied browser connection first.');
      assertPage();
      return target.environment===environment&&target.app===app&&target.kind==='web'
        &&(!target.windowId||target.windowId===pageId)?[ref()]:[];
    },
    async observe({target}) {
      capture=null;assertTarget(target);const url=page.url(),version=navigation;
      const aria=await page.locator('body').ariaSnapshot({timeout:timeoutMs});
      const screenshot=await page.screenshot({type:'png',timeout:timeoutMs});
      const title=await page.title();assertTarget(target);
      if (url!==page.url()||version!==navigation) fail('page-changed','The page navigated during capture; observe again.');
      const observation={id:randomUUID(),target:ref(),evidenceKey:digest([url,aria,readback]),
        evidence:{url,origin:new URL(url).origin,title,aria,screenshot:{mimeType:'image/png',data:screenshot.toString('base64')},
          readback,diagnostics:[...diagnostics]}};
      capture={id:observation.id,url,version};return observation;
    },
    async validateAction({target,observationId,capability,payload}) {
      assertCapture(target,observationId);
      validPayload(payload);
      if (capability!==(payload.type==='read'?'browser-read':'browser-action')) fail('unsupported-capability','Use the matching read/action browser capability.');
      if (payload.type!=='navigate') {
        const control=locator(payload.locator);
        if (await control.count()!==1) fail('ambiguous-control','Exactly one current semantic control must match.');
        if (!(await control.isVisible())) fail('control-hidden','The semantic control must be visible.');
        if (payload.type!=='read'&&!(await control.isEnabled())) fail('control-disabled','The semantic control is disabled.');
      }
      // Semantic checks yield to the real browser. Revalidate their source page
      // after every awaited check has finished, including same-URL navigation.
      assertCapture(target,observationId);
      return payload;
    },
    async act({target,observationId,capability,payload}) {
      await provider.validateAction({target,observationId,capability,payload});
      assertCapture(target,observationId);capture=null;
      if(payload.type!=='read')readback=null;
      try {
        if (payload.type==='navigate') await page.goto(payload.url,{waitUntil:'domcontentloaded',timeout:timeoutMs});
        else {
          const control=locator(payload.locator),options={timeout:timeoutMs};
          if(payload.type==='read') readback={property:payload.property,value:await control[
            {text:'innerText',value:'inputValue',checked:'isChecked'}[payload.property]](options)};
          if(payload.type==='fill') await control.fill(payload.value,options);
          if(payload.type==='click') await control.click(options);
          if(payload.type==='press') await control.press(payload.key,options);
          if(payload.type==='check') await control.setChecked(payload.checked,options);
          if(payload.type==='select') await control.selectOption(payload.value,options);
        }
        return {delivery:'delivered',preparation:[],resultingUrl:page.url()};
      } catch {return {delivery:'unknown',errorCode:'browser-operation-uncertain'};}
    },
    async close({target}) {
      if(target.environment!==environment||target.app!==app||target.windowId!==pageId
        ||target.identity?.generation!==generation)fail('target-mismatch','Release only this exact supplied page.');
      capture=null;return {cleanup:'confirmed',applicationClosed:false,ownership};
    },
    async dispose() {
      capture=null;disposed=true;provider.available=false;
      for(const [event,fn] of handlers)page.off(event,fn);
      if(ownership==='created'&&!page.isClosed()){await page.close({runBeforeUnload:false});return {closed:true,ownership};}
      return {closed:false,ownership};
    }
  };
  return provider;
}
module.exports={createBrowserProvider};
