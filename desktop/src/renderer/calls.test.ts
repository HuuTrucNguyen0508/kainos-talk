import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallEntry, SyncMessage } from '../shared/sync-protocol.ts';
import { isPhoneNumber } from '../shared/sms.ts';
import { callLabel, caller, clock, duration, matchingCalls, timeline } from './calls.ts';

const call = (patch: Partial<CallEntry>): CallEntry => ({ id: '1', kind: 'incoming', number: '+33 6 12 34 56 78', name: null, key: null, timeMs: 0, seconds: 0, ...patch });
const message = (id: string, timeMs: number): SyncMessage => ({ id, sender: null, text: id, timeMs, outgoing: false, status: 'incoming', media: null, image: null });

test('a call reads as what happened and, once answered, how long it lasted', () => {
  assert.equal(callLabel(call({ kind: 'missed' })), 'Missed call');
  assert.equal(callLabel(call({ kind: 'declined', seconds: 3 })), 'Declined call');
  assert.equal(callLabel(call({ kind: 'incoming', seconds: 95 })), 'Incoming call, 1 min 35 s');
  assert.equal(callLabel(call({ kind: 'outgoing', seconds: 0 })), 'Outgoing call');
  assert.deepEqual([45, 60, 3600, 3720, 4000.4].map(duration), ['45 s', '1 min', '1 h', '1 h 2 min', '1 h 6 min']);
  assert.deepEqual([0, 42_900, 723_000, 3_723_000].map(clock), ['0:00', '0:42', '12:03', '1:02:03']);
});

test('a phone number is digits with the usual separators, 3 to 20 of them', () => {
  assert.deepEqual(['+33 6 12 34 56 78', '(555) 010-9999', '112', ' 0612345678 '].map(isPhoneNumber), [true, true, true, true]);
  assert.deepEqual(['12', 'call me', '+33 6 12 34 56 78 ext', '1'.repeat(21), ''].map(isPhoneNumber), [false, false, false, false, false]);
});

test('a caller is their name, else their number, else hidden', () => {
  assert.equal(caller({ name: 'Maman', number: '06' }), 'Maman');
  assert.equal(caller({ name: null, number: '06' }), '06');
  assert.equal(caller({ name: null, number: null }), 'Hidden number');
});

test('calls match by name, or by number however it is spaced', () => {
  const calls = [call({ id: 'a', name: 'Maman' }), call({ id: 'b', number: '0612345678' }), call({ id: 'c', number: null })];
  assert.deepEqual(matchingCalls(calls, 'mam').map((c) => c.id), ['a']);
  assert.deepEqual(matchingCalls(calls, '12 34 5').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(matchingCalls(calls, ' ').map((c) => c.id), ['a', 'b', 'c']);
});

test('a thread holds its own calls among its texts', () => {
  const calls = [call({ id: 'early', key: 'k', timeMs: 50 }), call({ id: 'mid', key: 'k', timeMs: 200 }), call({ id: 'other', key: 'x', timeMs: 250 }), call({ id: 'same', key: 'k', timeMs: 300 })];
  const ids = (items: ReturnType<typeof timeline>) => items.map((item) => (item.kind === 'message' ? item.message.id : item.call.id));
  assert.deepEqual(ids(timeline([message('m1', 100), message('m2', 300)], calls, 'k')), ['early', 'm1', 'mid', 'm2', 'same']);
  assert.deepEqual(ids(timeline([], calls, 'k')), ['early', 'mid', 'same'], 'a conversation with no texts left still shows its calls');
});

test('a thread cut to its last 200 texts starts where they do, calls included', () => {
  const texts = Array.from({ length: 200 }, (_, i) => message(`m${i}`, 100 + i));
  const items = timeline(texts, [call({ id: 'before', key: 'k', timeMs: 99 }), call({ id: 'during', key: 'k', timeMs: 150 })], 'k');
  assert.equal(items.length, 201);
  assert.deepEqual(items.filter((item) => item.kind === 'call').map((item) => item.kind === 'call' && item.call.id), ['during']);
});
