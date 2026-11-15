import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { frameHash, isLocalAddress, pairingCode, parsePhoneFrame } from './sync-protocol.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/sms-sync-vectors.json', import.meta.url), 'utf8')) as {
  pairing: { pcFingerprint: string; phoneFingerprint: string; phoneNonce: string; pcNonce: string; code: string }[];
  addresses: { local: string[]; remote: string[] };
  frameHash: { frame: string; hash: string }[];
  conversationFrames: { frame: string; sender: string }[];
};

test('pairing codes match the shared vectors', () => {
  for (const v of vectors.pairing) assert.equal(pairingCode(v.pcFingerprint, v.phoneFingerprint, v.phoneNonce, v.pcNonce), v.code);
});

test('frame hashes match the shared vectors', () => {
  for (const v of vectors.frameHash) assert.equal(frameHash(v.frame), v.hash, v.frame);
});

test('a conversation frame parses to the sender kind the vectors name', () => {
  assert.deepEqual(vectors.conversationFrames.map((v) => v.sender), ['service', 'person', 'person', 'person', 'person']);
  for (const v of vectors.conversationFrames) {
    const parsed = parsePhoneFrame(v.frame);
    assert.equal(parsed?.t === 'conversation' && parsed.conversation.sender, v.sender, v.frame);
  }
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

test('mail frames and chats of other apps parse to an ignored frame, not to a refusal', () => {
  assert.deepEqual(parsePhoneFrame('{"t":"mail","mail":{"key":"protonmail|0|a","subject":"Hi"}}'), { t: 'ignored' });
  assert.deepEqual(parsePhoneFrame('{"t":"mailRemoved","key":"protonmail|0|a"}'), { t: 'ignored' });
  const chat = (source: string) =>
    `{"t":"conversation","conversation":{"source":"${source}","key":"k","title":"T","isGroup":false,"unread":1,"lastActivityMs":1,"canReply":true,"messages":[]}}`;
  for (const source of ['whatsapp', 'whatsapp-business', 'discord', 'messenger', 'protonmail', 'signal']) {
    assert.deepEqual(parsePhoneFrame(chat(source)), { t: 'ignored' }, source);
  }
  assert.equal(parsePhoneFrame(chat('sms'))?.t, 'conversation');
  assert.equal(parsePhoneFrame(chat('sms').replace('"source":"sms",', ''))?.t, 'conversation', 'a phone from before sources named none');
  assert.equal(parsePhoneFrame('{"t":"conversation","conversation":{"key":"k","messages":[]}}'), undefined, 'a malformed text is still refused');
});
