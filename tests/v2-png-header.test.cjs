'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPngHeader, pngSize } = require('../src/computer/winapp-backend.cjs');

function header() {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(300, 16);
  bytes.writeUInt32BE(400, 20);
  return bytes;
}

function fakeOpen(bytes, { chunk = 33, readError, closeError } = {}) {
  const calls = [];
  let closed = 0;
  const open = async (file, flags) => {
    assert.equal(file, 'frame.png');
    assert.equal(flags, 'r');
    return {
      async read(buffer, offset, length, position) {
        calls.push({ offset, length, position });
        if (readError) throw readError;
        const count = Math.min(chunk, length, Math.max(0, bytes.length - position));
        bytes.copy(buffer, offset, position, position + count);
        return { bytesRead: count, buffer };
      },
      async close() {
        closed++;
        if (closeError) throw closeError;
      },
    };
  };
  return { open, calls, get closed() { return closed; } };
}

test('header reader handles short reads and never reads beyond 33 bytes', async () => {
  const expected = header();
  const source = fakeOpen(Buffer.concat([expected, Buffer.alloc(100)]), { chunk: 7 });
  const actual = await readPngHeader('frame.png', source.open);
  assert.deepEqual(actual, expected);
  assert.deepEqual(pngSize(actual), { width: 300, height: 400 });
  assert.deepEqual(source.calls.map(call => call.position), [0, 7, 14, 21, 28]);
  assert.equal(source.calls.at(-1).length, 5);
  assert.equal(source.closed, 1);
});

test('EOF returns only bytes read and malformed headers retain parser errors', async () => {
  for (const bytes of [header().subarray(0, 32), Buffer.alloc(33)]) {
    const source = fakeOpen(bytes, { chunk: 8 });
    const actual = await readPngHeader('frame.png', source.open);
    assert.deepEqual(actual, bytes);
    assert.throws(() => pngSize(actual), { code: 'invalid_screenshot' });
    assert.equal(source.closed, 1);
  }
});

test('read errors take precedence over close errors and still close the handle', async () => {
  const readError = new Error('read failed');
  const source = fakeOpen(header(), { readError, closeError: new Error('close failed') });
  await assert.rejects(readPngHeader('frame.png', source.open), error => error === readError);
  assert.equal(source.closed, 1);
});

test('a close error after a successful read is reported', async () => {
  const closeError = new Error('close failed');
  const source = fakeOpen(header(), { closeError });
  await assert.rejects(readPngHeader('frame.png', source.open), error => error === closeError);
  assert.equal(source.closed, 1);
});
