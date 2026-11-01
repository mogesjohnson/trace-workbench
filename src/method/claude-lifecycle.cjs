'use strict';
const METHODS = ['doctor', 'listWindows', 'openSession', 'observe', 'act', 'closeSession'];
const KEYS = ['sessionId', 'agentId', 'turnId', 'generation'];
const error = code => Object.assign(new Error(code), { code,
  details: { outcome: 'not_dispatched', cleanup: 'unknown', inputRecoveryRequired: true } });
function createClaudeLifecycle({ controller, scope, timeoutMs = 1000, settleClipboard } = {}) {
  if (!scope || !KEYS.every(key => typeof scope[key] === 'string' && scope[key].length > 0 && scope[key].length <= 256)
    || ![...METHODS, 'close'].every(key => typeof controller?.[key] === 'function')
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
    || (settleClipboard !== undefined && typeof settleClipboard !== 'function')) throw new TypeError('Invalid lifecycle binding');
  const binding = Object.freeze(Object.fromEntries(KEYS.map(key => [key, scope[key]])));
  const abort = new AbortController(), pending = new Set();
  let completion, receipt;
  const same = value => value && KEYS.every(key => value[key] === binding[key]);
  function stop(identity) {
    if (!same(identity)) return Promise.resolve({ matched: false });
    if (completion) return completion;
    let resolve;
    completion = new Promise(done => { resolve = done; });
    const unknown = Object.freeze({ matched: true, cleanup: 'unknown', inputRecoveryRequired: true });
    // Publish completion before abort listeners can reenter this lifecycle.
    abort.abort(Object.assign(new Error('Host stopped'), { code: 'host_stopped' }));
    const finish = value => { if (!receipt) { receipt = value; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(unknown), timeoutMs);
    Promise.resolve().then(async () => {
      const closed = await controller.close(); // Production controller aborts and drains native work.
      if (closed?.cleanup === 'unknown' || closed?.inputRecoveryRequired === true) throw error('native_cleanup_unknown');
      await Promise.allSettled([...pending]);
      if (receipt) return; // A timed-out generation cannot restore clipboard later.
      // An armed clipboard transaction needs independent input-quiescence proof.
      // The trusted host callback must obtain it before attempting restoration.
      if (settleClipboard && (await settleClipboard())?.cleanup !== 'confirmed') throw error('clipboard_cleanup_unknown');
      finish(Object.freeze({ matched: true, cleanup: 'confirmed', inputRecoveryRequired: false }));
    }).catch(() => finish(unknown));
    return completion;
  }
  const wrapped = Object.fromEntries(METHODS.map(method => [method, (...args) => {
    if (abort.signal.aborted) return Promise.reject(error('host_stopped'));
    const index = ['doctor', 'listWindows'].includes(method) ? 0 : 1;
    const options = args[index] || {};
    args[index] = { ...options, signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal };
    const work = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw error('host_stopped');
      return controller[method](...args);
    });
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }]));
  wrapped.close = async () => {
    if ((await stop(binding)).cleanup !== 'confirmed') throw error('host_cleanup_unknown');
  };
  async function hook(input) {
    if (input?.session_id !== binding.sessionId) return {};
    const event = input.hook_event_name;
    const agent = input.agent_id ?? 'main';
    if ((event !== 'Stop' && event !== 'SubagentStop') || agent !== binding.agentId
      || (event === 'SubagentStop' && binding.agentId === 'main')) return {};
    const result = await stop(binding);
    return result.cleanup === 'confirmed' ? {} : { systemMessage: 'TRACE cleanup is unknown; input recovery is required.' };
  }
  return { controller: wrapped, interrupt: stop, hook,
    hooks: { Stop: [{ hooks: [hook] }], SubagentStop: [{ hooks: [hook] }] },
    status: () => receipt ? { ...receipt } : { stopped: abort.signal.aborted, cleanup: 'pending' } };
}
module.exports = { createClaudeLifecycle };
