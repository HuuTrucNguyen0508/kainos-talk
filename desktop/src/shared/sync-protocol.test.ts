import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { frameHash, isLocalAddress, pairingCode, parsePhoneFrame } from './sync-protocol.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/sms-sync-vectors.json', import.meta.url), 'utf8')) as {
  pairing: { pcFingerprint: string; phoneFingerprint: string; phoneNonce: string; pcNonce: string; code: string }[];
  addresses: { local: string[]; remote: string[] };
  frameHash: { frame: string; hash: string }[];
};

test('pairing codes match the shared vectors', () => {
  for (const v of vectors.pairing) assert.equal(pairingCode(v.pcFingerprint, v.phoneFingerprint, v.phoneNonce, v.pcNonce), v.code);
});

test('frame hashes match the shared vectors', () => {
  for (const v of vectors.frameHash) assert.equal(frameHash(v.frame), v.hash, v.frame);
});

test('only local addresses count as local', () => {
  for (const address of vectors.addresses.local) assert.equal(isLocalAddress(address), true, address);
  for (const address of vectors.addresses.remote) assert.equal(isLocalAddress(address), false, address);
});

test('phone frames are checked field by field', () => {
  assert.deepEqual(parsePhoneFrame('{"t":"pong"}'), { t: 'pong' });
  assert.equal(parsePhoneFrame('{"t":"hello","v":2}'), undefined);
  assert.deepEqual(parsePhoneFrame('{"t":"hello","v":2,"deviceId":"d"}'), { t: 'hello', v: 2, deviceId: 'd' });
  assert.equal(parsePhoneFrame('not json'), undefined);
  assert.equal(parsePhoneFrame('{"t":"conversation","conversation":{"key":"k","title":"T","isGroup":false,"unread":1,"lastActivityMs":1,"canReply":true,"messages":[{"id":1}]}}'), undefined);
  const ok = parsePhoneFrame('{"t":"conversation","conversation":{"key":"k","title":"T","isGroup":false,"unread":2.7,"lastActivityMs":1,"canReply":true,"messages":[{"id":"a","sender":null,"text":"hi","timeMs":1,"outgoing":true,"status":"sent","media":null}]}}');
  assert.equal(ok?.t === 'conversation' && ok.conversation.unread, 2);
});
