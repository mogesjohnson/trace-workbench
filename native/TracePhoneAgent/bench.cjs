'use strict';
const net = require('node:net');
const fs = require('node:fs');
const port = Number(process.argv[2] || 27183);
const sock = net.connect(port, '127.0.0.1');
let buf = Buffer.alloc(0); const waiters = [];
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
function pump() {
  while (waiters.length && buf.length >= 4) {
    const hl = buf.readUInt32BE(0); if (buf.length < 8 + hl) return;
    const pl = buf.readUInt32BE(4 + hl); if (buf.length < 8 + hl + pl) return;
    const header = JSON.parse(buf.subarray(4, 4 + hl)); const payload = buf.subarray(8 + hl, 8 + hl + pl);
    buf = buf.subarray(8 + hl + pl); waiters.shift()({ header, payload });
  }
}
function call(req) {
  const body = Buffer.from(JSON.stringify(req)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
  sock.write(Buffer.concat([head, body]));
  return new Promise((r) => { waiters.push(r); pump(); });
}
(async () => {
  const t = async (label, req) => { const s = performance.now(); const r = await call(req); const ms = performance.now() - s;
    console.log(label.padEnd(28), ms.toFixed(0).padStart(5), 'ms', 'bytes', String(r.payload.length).padStart(7), JSON.stringify(r.header)); return r; };
  await t('hello', { op: 'hello' });
  let r;
  for (let i = 0; i < 3; i++) r = await t('screen jpeg 1280 q75', { op: 'screen' });
  fs.writeFileSync(__dirname + '/shot.jpg', r.payload);
  await t('screen unchanged', { op: 'screen', ifChangedFrom: r.header.hash });
  await t('screen jpeg 960 q60', { op: 'screen', maxSide: 960, quality: 60 });
  await t('screen webp 1280 q70', { op: 'screen', format: 'webp', quality: 70 });
  await t('screen png 1280', { op: 'screen', format: 'png' });
  await t('screen region 1440x400', { op: 'screen', region: { x: 0, y: 0, width: 1440, height: 400 } });
  await t('wait stable 300ms', { op: 'wait', until: 'stable', stableMs: 300, timeoutMs: 3000 });
  await t('key 0 (noop)', { op: 'key', code: 0 });
  sock.end();
})();
