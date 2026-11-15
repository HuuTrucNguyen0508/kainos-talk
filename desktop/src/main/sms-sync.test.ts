import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { connectPaired, conversation, link, mail, newIdentity, phoneIdentity, startPairing } from '../../test/fake-phone.ts';
import { startSmsSync, type SmsSync } from './sms-sync.ts';
import { SYNC_VERSION, frameHash, type SyncConversation, type SyncMessage } from '../shared/sync-protocol.ts';

const dir = mkdtempSync(join(tmpdir(), 'kainos-sync-'));
const port = 48_500 + Math.floor(Math.random() * 400);
const incoming: [SyncConversation, SyncMessage][] = [];
let changes = 0;
const sync: Promise<SmsSync> = startSmsSync({
  dir,
  port,
  advertise: false,
  onChange: () => changes++,
  onIncoming: (c, m) => incoming.push([c, m]),
});
after(async () => {
  await (await sync).stop();
  rmSync(dir, { recursive: true, force: true });
});
const until = async (probe: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!probe() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return probe();
};

let deviceId = '';

test('pairing needs the same code confirmed on both screens, and keeps only certificates', async () => {
  const server = await sync;
  assert.deepEqual(server.state().phone, null);
  const { phone, code, confirm, paired } = await startPairing(port, 'Pixel 9');
  assert.ok(await until(() => server.state().pairing !== null));
  assert.deepEqual(server.state().pairing, { device: 'Pixel 9', code, pcAccepted: false, phoneConfirmed: false });
  server.answerPairing(true);
  assert.ok(await until(() => server.state().pairing?.pcAccepted === true));
  assert.equal(server.state().phone, null, 'not paired until the phone confirms too');
  confirm();
  deviceId = (await paired()).deviceId;
  await phone.closed;
  assert.deepEqual(server.state().phone, { name: 'Pixel 9', connected: false });
  const stored = JSON.parse(readFileSync(join(dir, 'phone.json'), 'utf8'));
  assert.equal(stored.fingerprint, phoneIdentity.fingerprint);
  assert.deepEqual(Object.keys(stored).sort(), ['fingerprint', 'id', 'name'], 'no secret of any kind');
});

test('a refused pairing and a second request while one is pending are turned away', async () => {
  const server = await sync;
  const first = await startPairing(port, 'Stranger');
  const second = await link(port);
  second.send({ t: 'pair', v: SYNC_VERSION, device: 'Another', nonce: 'x' });
  await second.next('pairRefused');
  first.confirm();
  server.answerPairing(false);
  await first.phone.next('pairRefused');
  assert.equal(server.state().phone?.name, 'Pixel 9', 'the paired phone is kept');
});

test('another device using the paired phone id is denied, and so is one with no certificate', async () => {
  const impostor = await newIdentity('Impostor');
  const phone = await link(port, impostor);
  phone.send({ t: 'hello', v: SYNC_VERSION, deviceId });
  assert.equal((await phone.next('denied')).reason, 'unknown phone');
  await phone.closed;
  const bare = await link(port, null).catch(() => undefined);
  if (bare) await bare.closed;
});

test('texts flow from the phone, replies and reads go back', async () => {
  const server = await sync;
  const phone = await connectPaired(port, deviceId);
  assert.ok(await until(() => server.state().phone?.connected === true));
  const old = Date.now() - 3_600_000;
  phone.send({ t: 'conversation', conversation: conversation('sms|0|s:garage', 'Garage', [{ id: 'm1', text: 'Car ready', timeMs: old }]) });
  assert.ok(await until(() => server.state().conversations.length === 1));
  assert.equal(incoming.length, 0, 'a text from before the connection does not notify');

  const now = Date.now();
  phone.send({
    t: 'conversation',
    conversation: conversation('sms|0|s:garage', 'Garage', [
      { id: 'm1', text: 'Car ready', timeMs: old },
      { id: 'm2', text: 'We close at 18:30', timeMs: now },
    ], 2),
  });
  assert.ok(await until(() => incoming.length === 1));
  assert.equal(incoming[0]![1].text, 'We close at 18:30');

  assert.equal(server.reply('sms|0|s:garage', 'Coming at 18:00'), true);
  const reply = await phone.next('reply');
  assert.deepEqual({ key: reply.key, text: reply.text }, { key: 'sms|0|s:garage', text: 'Coming at 18:00' });
  assert.deepEqual(server.state().sending, ['sms|0|s:garage']);
  phone.send({ t: 'replyResult', id: reply.id, ok: false, error: 'notification gone' });
  assert.ok(await until(() => server.state().failures['sms|0|s:garage'] === 'notification gone'));
  assert.deepEqual(server.state().sending, []);

  server.markRead('sms|0|s:garage');
  assert.equal((await phone.next('read')).key, 'sms|0|s:garage');
  assert.equal(server.state().conversations[0]!.unread, 0);
  assert.equal(server.reply('sms|0|s:unknown', 'x'), false, 'no reply to a conversation the phone never sent');

  // Pictures are fetched on demand, once, then cached.
  const picture = server.image('mms-part:7');
  const ask = await phone.next('getImage');
  assert.equal(ask.id, 'mms-part:7');
  phone.send({ t: 'image', id: 'mms-part:7', mime: 'image/jpeg', data: 'AAEC', error: null });
  assert.deepEqual(await picture, Buffer.from([0, 1, 2]));
  assert.deepEqual(await server.image('mms-part:7'), Buffer.from([0, 1, 2]));
  const missing = server.image('mms-part:8');
  await phone.next('getImage');
  phone.send({ t: 'image', id: 'mms-part:8', mime: null, data: null, error: 'not available' });
  assert.equal(await missing, null);

  assert.equal(server.send('+33 6 12 34 56 78', 'New number, who dis'), true);
  const send = await phone.next('send');
  assert.deepEqual({ to: send.to, text: send.text }, { to: '+33 6 12 34 56 78', text: 'New number, who dis' });
  assert.equal(server.state().newText.sending, true);
  phone.send({ t: 'replyResult', id: send.id, ok: false, error: 'no permission to send texts' });
  assert.ok(await until(() => server.state().newText.failure === 'no permission to send texts'));
  assert.equal(server.send('call me', 'x'), false, 'not a phone number');

  // Protocol 3: chats from other apps and mail come too, and mail actions go back.
  phone.send({ t: 'conversation', conversation: conversation('whatsapp|0|s:allot', 'Allotment crew', [{ id: 'w1', text: 'Shed key?', timeMs: Date.now() }], 1, 'whatsapp') });
  phone.send({ t: 'mail', mail: mail('protonmail|0|halden', 'Halden Housing', 'Minutes from Tuesday') });
  assert.ok(await until(() => server.state().mails.length === 1 && server.state().conversations.some((c) => c.source === 'whatsapp')));
  assert.equal(server.mailAction('protonmail|0|halden', 'archive'), true);
  const action = await phone.next('mailAction');
  assert.deepEqual({ key: action.key, action: action.action }, { key: 'protonmail|0|halden', action: 'archive' });
  assert.equal(server.state().mails[0]!.requested, 'archive');
  assert.equal(server.mailAction('protonmail|0|halden', 'delete' as never), false, 'only actions the mail app offers');
  phone.send({ t: 'mailRemoved', key: 'protonmail|0|halden' });
  assert.ok(await until(() => server.state().mails.length === 0));

  phone.send({ t: 'removed', key: 'sms|0|s:garage' });
  assert.ok(await until(() => !server.state().conversations.some((c) => c.key === 'sms|0|s:garage')));
  phone.close();
  assert.ok(await until(() => server.state().phone?.connected === false));
});

test('a burst of frames is one change, but every new text still notifies', async () => {
  const server = await sync;
  const phone = await connectPaired(port, deviceId);
  assert.ok(await until(() => server.state().phone?.connected === true));
  await new Promise((r) => setImmediate(r));
  const [changesBefore, incomingBefore] = [changes, incoming.length];
  phone.sendAll(Array.from({ length: 20 }, (_, i) => ({ t: 'conversation', conversation: conversation(`sms|0|s:burst${i}`, `Burst ${i}`, [{ id: `b${i}`, text: 'hi', timeMs: Date.now() }]) })));
  assert.ok(await until(() => server.state().conversations.filter((c) => c.key.startsWith('sms|0|s:burst')).length === 20));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(changes - changesBefore, 1);
  assert.equal(incoming.length - incomingBefore, 20);
  phone.close();
  assert.ok(await until(() => server.state().phone?.connected === false));
});

test('a reconnect is welcomed with the hash of every frame the PC still holds', async () => {
  const server = await sync;
  const first = await connectPaired(port, deviceId);
  const chat = { t: 'conversation', conversation: conversation('sms|0|s:held', 'Held', [{ id: 'h1', text: 'Still here', timeMs: 1 }]) };
  const read = { t: 'conversation', conversation: conversation('sms|0|s:readhere', 'Read here', [{ id: 'h2', text: 'Seen on the PC', timeMs: 1 }]) };
  const letter = { t: 'mail', mail: mail('protonmail|0|held', 'Halden', 'Kept', 1) };
  first.sendAll([chat, read, letter]);
  assert.ok(await until(() => server.state().mails.some((m) => m.key === 'protonmail|0|held') && server.state().conversations.some((c) => c.key === 'sms|0|s:readhere')));
  server.markRead('sms|0|s:readhere');
  await first.next('read');
  first.close();
  assert.ok(await until(() => server.state().phone?.connected === false));

  const again = await link(port);
  again.send({ t: 'hello', v: SYNC_VERSION, deviceId });
  const welcome = await again.next('welcome');
  assert.equal(welcome.conversations['sms|0|s:held'], frameHash(JSON.stringify(chat)), 'the hash of the line as it came in');
  assert.equal(welcome.conversations['sms|0|s:readhere'], '', 'changed on the PC since: the phone sends it again');
  assert.equal(welcome.mails['protonmail|0|held'], frameHash(JSON.stringify(letter)));
  assert.deepEqual(Object.keys(welcome.conversations).sort(), server.state().conversations.map((c) => c.key).sort(), 'every key the PC holds');

  again.sendAll([{ t: 'removed', key: 'sms|0|s:held' }, { t: 'mailRemoved', key: 'protonmail|0|held' }]);
  assert.ok(await until(() => !server.state().conversations.some((c) => c.key === 'sms|0|s:held')));
  again.close();
  assert.ok(await until(() => server.state().phone?.connected === false));
});

test('a ping with no reply drops the phone after the grace period; an answered one keeps it', async () => {
  const server = await sync;
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const phone = await connectPaired(port, deviceId);
    assert.equal(server.state().phone?.connected, true);

    mock.timers.tick(60_000);
    await phone.next('ping');
    await new Promise<void>((r) => setImmediate(r)); // the pong travels over the real socket
    await new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(30_000);
    assert.equal(server.state().phone?.connected, true, 'it answered: still connected');

    phone.answerPings = false;
    mock.timers.tick(30_000); // the next ping goes out
    await phone.next('ping');
    mock.timers.tick(19_000);
    assert.equal(server.state().phone?.connected, true, 'inside the grace period');
    mock.timers.tick(1_000);
    for (let turn = 0; turn < 20 && server.state().phone?.connected; turn++) await new Promise<void>((r) => setImmediate(r));
    assert.equal(server.state().phone?.connected, false, 'no reply: dropped 80 s after its last answer');
  } finally {
    mock.timers.reset();
  }
});

test('a phone still sending data is not dropped for a late pong; silence still is', async () => {
  const server = await sync;
  // Real time on the socket: the mocked clock stays where the test put it.
  const settle = async () => {
    const end = performance.now() + 40;
    while (performance.now() < end) await new Promise<void>((r) => setImmediate(r));
  };
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const phone = await connectPaired(port, deviceId);
    phone.answerPings = false;
    mock.timers.tick(60_000);
    await phone.next('ping');
    // A large picture on a slow link: chunks keep coming for 45 s, each inside the grace period.
    for (let chunk = 0; chunk < 3; chunk++) {
      phone.sendRaw('{"t":"conversation","padding":"xxxxxxxx');
      await settle();
      mock.timers.tick(15_000);
      assert.equal(server.state().phone?.connected, true, `chunk ${chunk}: data is still arriving`);
    }
    // The last chunk came at 90 s and the clock is at 105 s: 109 s is still inside its 20 s grace.
    mock.timers.tick(4_000);
    await settle();
    assert.equal(server.state().phone?.connected, true, 'inside the grace since the last chunk');
    mock.timers.tick(1_000);
    for (let turn = 0; turn < 20 && server.state().phone?.connected; turn++) await new Promise<void>((r) => setImmediate(r));
    assert.equal(server.state().phone?.connected, false, 'then silence for 20 s drops it');
  } finally {
    mock.timers.reset();
  }
});

test('one frame still arriving after 150 s is not taken for a dead connection', async () => {
  const server = await sync;
  const settle = async () => {
    const end = performance.now() + 40;
    while (performance.now() < end) await new Promise<void>((r) => setImmediate(r));
  };
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const phone = await connectPaired(port, deviceId);
    phone.answerPings = false;
    // A picture under 8 KB/s: one frame trickling in for 210 s, past the 150 s check, with pings
    // going out at 60, 120 and 180 s while it does.
    phone.sendRaw('{"t":"conversation","padding":"');
    for (let chunk = 0; chunk < 14; chunk++) {
      await settle();
      mock.timers.tick(15_000);
      assert.equal(server.state().phone?.connected, true, `${(chunk + 1) * 15} s: data is still arriving`);
      phone.sendRaw('xxxxxxxx');
    }
  } finally {
    mock.timers.reset();
  }
});

test('another protocol version is told apart from a forgotten phone', async () => {
  const phone = await link(port);
  phone.send({ t: 'hello', v: SYNC_VERSION - 1, deviceId });
  assert.equal((await phone.next('denied')).reason, 'version');
  await phone.closed;
});

test('a malformed frame closes the connection', async () => {
  const phone = await link(port);
  phone.send({ t: 'hello', v: SYNC_VERSION });
  await phone.closed;
});

test('forgetting the phone locks it out', async () => {
  const server = await sync;
  server.forgetPhone();
  assert.equal(server.state().phone, null);
  const phone = await link(port);
  phone.send({ t: 'hello', v: SYNC_VERSION, deviceId });
  await phone.next('denied');
  assert.ok(changes > 0);
});
