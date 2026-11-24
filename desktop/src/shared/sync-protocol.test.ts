import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { frameHash, isLocalAddress, isTailnetAddress, pairingCode, tailnetAddresses, parsePhoneFrame, safeFileName, type PcFrame } from './sync-protocol.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/sms-sync-vectors.json', import.meta.url), 'utf8')) as {
  pairing: { pcFingerprint: string; phoneFingerprint: string; phoneNonce: string; pcNonce: string; code: string }[];
  addresses: { local: string[]; remote: string[]; tailnet: string[]; notTailnet: string[] };
  frameHash: { frame: string; hash: string }[];
  conversationFrames: { frame: string; sender: string }[];
  callFrames: { frame: string; call: unknown }[];
  callLogFrames: { frame: string; calls: unknown[] }[];
  transferFrames: { frame: string; from: 'either' | 'phone'; parsed: PcFrame }[];
  invalidTransferFrames: string[];
  fileNames: { offered: string; saved: string }[];
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

test('Tailscale addresses are told apart from the rest', () => {
  for (const address of vectors.addresses.tailnet) assert.equal(isTailnetAddress(address), true, address);
  for (const address of vectors.addresses.notTailnet) assert.equal(isTailnetAddress(address), false, address);
});

test('the welcome lists only Tailscale addresses, IPv4 first', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', internal: true }],
    wlan0: [{ address: '192.168.1.20', internal: false }, { address: 'fe80::1', internal: false }],
    tailscale0: [{ address: 'fd7a:115c:a1e0::1234', internal: false }, { address: '100.101.102.103', internal: false }],
    docker0: [{ address: '172.17.0.1', internal: false }],
  };
  assert.deepEqual(tailnetAddresses(interfaces), ['100.101.102.103', 'fd7a:115c:a1e0::1234']);
  assert.deepEqual(tailnetAddresses({ wlan0: [{ address: '192.168.1.20', internal: false }] }), []);
  // A carrier's 100.64/10 addresses on another interface don't push Tailscale's out.
  const crowded = {
    wwan0: ['100.64.0.1', '100.64.0.2', '100.64.0.3', '100.64.0.4'].map((address) => ({ address, internal: false })),
    Tailscale: [{ address: 'fd7a:115c:a1e0::1234', internal: false }, { address: '100.101.102.103', internal: false }],
  };
  assert.deepEqual(tailnetAddresses(crowded).slice(0, 2), ['100.101.102.103', 'fd7a:115c:a1e0::1234']);
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

test('call frames parse to the calls the vectors name', () => {
  assert.equal(vectors.callFrames.length, 3);
  for (const v of vectors.callFrames) assert.deepEqual(parsePhoneFrame(v.frame), { t: 'call', call: v.call }, v.frame);
  assert.equal(vectors.callLogFrames.length, 2);
  for (const v of vectors.callLogFrames) assert.deepEqual(parsePhoneFrame(v.frame), { t: 'callLog', calls: v.calls }, v.frame);
});

test('a call frame with a field out of range is refused', () => {
  const call = { id: 'c', phase: 'ringing', direction: 'incoming', number: null, name: null, key: null, sinceMs: 1 };
  const frame = (patch: object) => JSON.stringify({ t: 'call', call: { ...call, ...patch } });
  assert.equal(parsePhoneFrame(frame({}))?.t, 'call');
  assert.equal(parsePhoneFrame(frame({ phase: 'held' })), undefined);
  assert.equal(parsePhoneFrame(frame({ direction: 'sideways' })), undefined);
  assert.equal(parsePhoneFrame(frame({ number: '1'.repeat(41) })), undefined);
  assert.equal(parsePhoneFrame(frame({ sinceMs: '1' })), undefined);
  assert.equal(parsePhoneFrame(frame({ sinceMs: 1e300 })), undefined, 'a time no Date can show');
  assert.equal(parsePhoneFrame('{"t":"call"}'), undefined);

  const entry = { id: 'e', kind: 'missed', number: null, name: null, key: null, timeMs: 1, seconds: 2.9 };
  const log = (entries: object[]) => JSON.stringify({ t: 'callLog', calls: entries });
  assert.deepEqual(parsePhoneFrame(log([entry])), { t: 'callLog', calls: [{ ...entry, seconds: 2 }] });
  assert.equal(parsePhoneFrame(log([{ ...entry, kind: 'voicemail' }])), undefined);
  assert.equal(parsePhoneFrame(log([{ ...entry, timeMs: -1e17 }])), undefined);
  assert.equal(parsePhoneFrame(log(Array.from({ length: 101 }, () => entry))), undefined);
});

test('transfer frames parse to what the vectors name, and the PC builds those it sends exactly', () => {
  assert.equal(vectors.transferFrames.length, 9);
  for (const v of vectors.transferFrames) {
    assert.deepEqual(parsePhoneFrame(v.frame), v.parsed, v.frame);
    // Only the phone shares text; every other frame the PC sends too, keys in the order given.
    if (v.from === 'either') assert.equal(JSON.stringify(v.parsed), v.frame);
  }
});

test('transfer frames out of range are refused', () => {
  assert.equal(vectors.invalidTransferFrames.length, 17);
  for (const frame of vectors.invalidTransferFrames) assert.equal(parsePhoneFrame(frame), undefined, frame.slice(0, 120));
  assert.equal(parsePhoneFrame('{"t":"fileChunk","id":"f1","data":"not base64!"}'), undefined);
  assert.equal(parsePhoneFrame(`{"t":"clip","text":"${'x'.repeat(100_000)}"}`)?.t, 'clip', 'the longest text');
  assert.equal(parsePhoneFrame(`{"t":"fileChunk","id":"f1","data":"${'A'.repeat(349_528)}"}`)?.t, 'fileChunk', 'a full 256 KiB chunk');
});

test('an offered file name is saved under the name the vectors give', () => {
  for (const v of vectors.fileNames) assert.equal(safeFileName(v.offered), v.saved, JSON.stringify(v.offered));
});
