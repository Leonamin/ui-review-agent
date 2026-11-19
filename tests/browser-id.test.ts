import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createBrowserId} from '../viewer/shared/browser/id.js';

test('browser IDs use getRandomValues without requiring secure-context randomUUID', () => {
  let calls = 0;
  const source = {getRandomValues(bytes: Uint8Array) {calls++; assert.equal(bytes.length, 16); return bytes.fill(0xff);}};
  assert.equal(createBrowserId(source), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
  assert.equal(createBrowserId({getRandomValues: bytes => bytes.fill(0)}), '00000000-0000-4000-8000-000000000000');
});

test('fresh browser IDs remain distinct UUID v4 values with actual cryptographic random bytes', () => {
  const source = {getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes)};
  const ids = Array.from({length: 256}, () => createBrowserId(source));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
