import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { connectPaired, startPairing, type FakePhoneLink } from '../../test/fake-phone.ts';
import { createTransfers, localFileName, type FileFrame, type FileOutcome } from './file-transfer.ts';
import { startSmsSync, type SmsSync } from './sms-sync.ts';
import { MAX_CHUNK_BYTES } from '../shared/sync-protocol.ts';

const dir = mkdtempSync(join(tmpdir(), 'kainos-transfer-'));
const downloads = join(dir, 'Downloads');
const port = 48_900 + Math.floor(Math.random() * 400);
const clips: string[] = [];
const shared: string[] = [];
const received: FileOutcome[] = [];
const sent: FileOutcome[] = [];
let server: SmsSync;
let deviceId = '';

before(async () => {
  server = await startSmsSync({
    dir,
    port,
    advertise: false,
    downloads,
    onChange: () => undefined,
    onIncoming: () => undefined,
    onClip: (text) => clips.push(text),
    onShareText: (text) => shared.push(text),
    onFileReceived: (outcome) => received.push(outcome),
    onFileSent: (outcome) => sent.push(outcome),
  });
  const { phone, confirm, paired } = await startPairing(port, 'Pixel 9');
  await until(() => server.state().pairing !== null);
  server.answerPairing(true);
  confirm();
  deviceId = (await paired()).deviceId;
  await phone.closed;
});
after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function until(probe: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!probe() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return probe();
}

async function connect(): Promise<FakePhoneLink> {
  const phone = await connectPaired(port, deviceId);
  assert.ok(await until(() => server.state().phone?.connected === true));
  return phone;
}

async function disconnect(phone: FakePhoneLink): Promise<void> {
  phone.close();
  assert.ok(await until(() => server.state().phone?.connected === false));
}

/** The phone's side of sending a file: offer, chunks of at most 256 KiB, end. */
function sendFromPhone(phone: FakePhoneLink, id: string, name: string, bytes: Buffer, { end = true, upTo = bytes.length } = {}): void {
  const frames: unknown[] = [{ t: 'fileOffer', id, name, size: bytes.length, mime: null }];
  for (let at = 0; at < upTo; at += MAX_CHUNK_BYTES) frames.push({ t: 'fileChunk', id, data: bytes.subarray(at, Math.min(at + MAX_CHUNK_BYTES, upTo)).toString('base64') });
  if (end) frames.push({ t: 'fileEnd', id });
  for (const frame of frames) phone.send(frame);
}

/** The phone's side of receiving a file: the offer, then its chunks, put back together. */
async function receiveOnPhone(phone: FakePhoneLink) {
  const offer = await phone.next('fileOffer');
  const parts: Buffer[] = [];
  let size = 0;
  while (size < offer.size) {
    const chunk = await phone.next('fileChunk');
    assert.equal(chunk.id, offer.id);
    const part = Buffer.from(chunk.data, 'base64');
    assert.ok(part.length <= MAX_CHUNK_BYTES);
    parts.push(part);
    size += part.length;
  }
  assert.equal((await phone.next('fileEnd')).id, offer.id);
  return { offer, bytes: Buffer.concat(parts) };
}

const partials = () => readdirSync(downloads).filter((name) => name.endsWith('.part'));

test('clipboard text goes both ways, and shared text reaches the PC', async () => {
  const phone = await connect();
  phone.send({ t: 'clip', text: 'Dîner dimanche ? 🍲\nhttps://example.com/a?b=1' });
  phone.send({ t: 'shareText', text: 'https://example.com/watch?v=42' });
  assert.ok(await until(() => clips.length === 1 && shared.length === 1));
  assert.deepEqual([clips[0], shared[0]], ['Dîner dimanche ? 🍲\nhttps://example.com/a?b=1', 'https://example.com/watch?v=42']);

  assert.equal(server.sendClip('Code: 4821'), true);
  assert.equal((await phone.next('clip')).text, 'Code: 4821');
  assert.equal(server.sendClip(''), false, 'nothing to send');
  assert.equal(server.sendClip('x'.repeat(100_001)), false, 'longer than the protocol takes');
  await disconnect(phone);
  assert.equal(server.sendClip('Code: 4821'), false, 'no phone');
  assert.equal(server.sendFiles([join(dir, 'tls.json')]), false, 'no phone');
});

test('a file from the phone larger than several chunks lands in Downloads, byte for byte, while other frames still pass', async () => {
  const phone = await connect();
  const bytes = randomBytes(5 * MAX_CHUNK_BYTES + 123);
  const before = received.length;
  sendFromPhone(phone, 'f1', '../../Photo été 🌞.jpg', bytes, { end: false });
  phone.send({ t: 'clip', text: 'between chunks' });
  phone.send({ t: 'fileEnd', id: 'f1' });
  const result = await phone.next('fileResult');
  assert.deepEqual(result, { t: 'fileResult', id: 'f1', ok: true, error: null });
  assert.ok(await until(() => received.length === before + 1));
  const path = join(downloads, 'Photo été 🌞.jpg');
  assert.deepEqual(received.at(-1), { ok: true, name: 'Photo été 🌞.jpg', path }, 'only the last part of the name, inside Downloads');
  assert.ok(readFileSync(path).equals(bytes));
  assert.equal(clips.at(-1), 'between chunks');
  assert.deepEqual(partials(), []);

  // An empty file is a file too.
  sendFromPhone(phone, 'f2', 'notes', Buffer.alloc(0));
  assert.equal((await phone.next('fileResult')).ok, true);
  assert.equal(readFileSync(join(downloads, 'notes')).length, 0);
  await disconnect(phone);
});

test('a name already taken gets a number before its extension, and nothing is overwritten', async () => {
  const phone = await connect();
  writeFileSync(join(downloads, 'report.pdf'), 'mine');
  writeFileSync(join(downloads, 'report (1).pdf'), 'mine too');
  sendFromPhone(phone, 'r1', 'C:\\Users\\me\\report.pdf', Buffer.from('from the phone'));
  assert.equal((await phone.next('fileResult')).ok, true);
  sendFromPhone(phone, 'r2', 'report.pdf', Buffer.from('again'));
  assert.equal((await phone.next('fileResult')).ok, true);
  assert.equal(readFileSync(join(downloads, 'report.pdf'), 'utf8'), 'mine');
  assert.equal(readFileSync(join(downloads, 'report (1).pdf'), 'utf8'), 'mine too');
  assert.equal(readFileSync(join(downloads, 'report (2).pdf'), 'utf8'), 'from the phone');
  assert.equal(readFileSync(join(downloads, 'report (3).pdf'), 'utf8'), 'again');
  await disconnect(phone);
});

test('a connection dropped mid-file deletes the partial file, and the PC says the file failed', async () => {
  const phone = await connect();
  const bytes = randomBytes(4 * MAX_CHUNK_BYTES);
  const before = received.length;
  sendFromPhone(phone, 'd1', 'video.mp4', bytes, { end: false, upTo: 2 * MAX_CHUNK_BYTES });
  assert.ok(await until(() => partials().length === 1), 'the partial file is written under a hidden name');
  assert.ok(partials()[0]!.startsWith('.'));
  await disconnect(phone);
  assert.ok(await until(() => received.length === before + 1 && partials().length === 0));
  assert.deepEqual(received.at(-1), { ok: false, name: 'video.mp4', error: 'phone disconnected' });
  assert.equal(readdirSync(downloads).includes('video.mp4'), false);
});

test('a file that arrives short or long is refused and not kept', async () => {
  const phone = await connect();
  phone.send({ t: 'fileOffer', id: 's1', name: 'short.txt', size: 10, mime: 'text/plain' });
  phone.send({ t: 'fileChunk', id: 's1', data: Buffer.from('12345').toString('base64') });
  phone.send({ t: 'fileEnd', id: 's1' });
  assert.deepEqual(await phone.next('fileResult'), { t: 'fileResult', id: 's1', ok: false, error: 'not all bytes arrived' });

  phone.send({ t: 'fileOffer', id: 'l1', name: 'long.txt', size: 2, mime: null });
  phone.send({ t: 'fileChunk', id: 'l1', data: Buffer.from('12345').toString('base64') });
  assert.equal((await phone.next('fileCancel')).id, 'l1');
  assert.ok(await until(() => partials().length === 0));
  assert.deepEqual(readdirSync(downloads).filter((name) => name.startsWith('short') || name.startsWith('long')), []);
  await disconnect(phone);
});

test('files to the phone go one at a time, each after the phone answers the last, while texts still get through', async () => {
  const phone = await connect();
  const big = randomBytes(24 * MAX_CHUNK_BYTES + 7);
  const bigPath = join(dir, 'holiday.mp4');
  const smallPath = join(dir, 'ticket.pdf');
  writeFileSync(bigPath, big);
  writeFileSync(smallPath, 'boarding pass');
  const before = sent.length;
  assert.equal(server.sendFiles([bigPath, smallPath]), true);
  assert.ok(await until(() => phone.frames.some((frame) => frame.t === 'fileChunk')));
  assert.equal(server.sendClip('sent mid-file'), true);
  assert.equal((await phone.next('clip')).text, 'sent mid-file');
  assert.equal(phone.frames.some((frame) => frame.t === 'fileEnd'), false, 'the text did not wait for the file');

  const first = await receiveOnPhone(phone);
  assert.deepEqual({ name: first.offer.name, size: first.offer.size, mime: first.offer.mime }, { name: 'holiday.mp4', size: big.length, mime: 'video/mp4' });
  assert.ok(first.bytes.equals(big));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(phone.frames.some((frame) => frame.t === 'fileOffer'), false, 'the next file waits for the answer');
  phone.send({ t: 'fileResult', id: first.offer.id, ok: true, error: null });

  const second = await receiveOnPhone(phone);
  assert.equal(second.bytes.toString(), 'boarding pass');
  phone.send({ t: 'fileResult', id: second.offer.id, ok: false, error: 'disk full' });
  assert.ok(await until(() => sent.length === before + 2));
  assert.deepEqual(sent.slice(before), [
    { ok: true, name: 'holiday.mp4', path: bigPath },
    { ok: false, name: 'ticket.pdf', error: 'disk full' },
  ]);
  await disconnect(phone);
});

test('a send the phone cancels stops, and a dropped connection fails the file in flight and the ones queued', async () => {
  const phone = await connect();
  const bigPath = join(dir, 'big.bin');
  writeFileSync(bigPath, randomBytes(40 * MAX_CHUNK_BYTES));
  const before = sent.length;
  server.sendFiles([bigPath]);
  const offer = await phone.next('fileOffer');
  await phone.next('fileChunk');
  phone.send({ t: 'fileCancel', id: offer.id });
  assert.ok(await until(() => sent.length === before + 1));
  assert.deepEqual(sent.at(-1), { ok: false, name: 'big.bin', error: 'cancelled on the phone' });
  await new Promise((r) => setTimeout(r, 50));
  phone.frames.length = 0;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(phone.frames.some((frame) => frame.t === 'fileChunk' || frame.t === 'fileEnd'), false, 'no more chunks for it');

  server.sendFiles([bigPath, join(dir, 'missing.txt'), bigPath]);
  await phone.next('fileOffer');
  await disconnect(phone);
  assert.ok(await until(() => sent.length === before + 4));
  assert.deepEqual(sent.slice(before + 1).map((outcome) => !outcome.ok && outcome.error), ['phone disconnected', 'phone disconnected', 'phone disconnected']);
});

test('a file that cannot be read fails without reaching the phone', async () => {
  const phone = await connect();
  const before = sent.length;
  server.sendFiles([join(dir, 'missing.txt')]);
  assert.ok(await until(() => sent.length === before + 1));
  const outcome = sent.at(-1)!;
  assert.equal(outcome.ok, false);
  assert.equal(phone.frames.some((frame) => frame.t === 'fileOffer'), false);
  await disconnect(phone);
});

test('a received name fits the file system it lands on', () => {
  assert.equal(localFileName('report.pdf', 0, 'linux'), 'report.pdf');
  assert.equal(localFileName('report.pdf', 2, 'linux'), 'report (2).pdf');
  assert.equal(localFileName('.bashrc', 1, 'linux'), '.bashrc (1)');
  assert.equal(localFileName('a:b?.txt', 0, 'linux'), 'a:b?.txt');
  assert.equal(localFileName('a:b?.txt', 0, 'win32'), 'a_b_.txt', 'no alternate data stream on Windows');
  assert.equal(localFileName('CON.txt', 0, 'win32'), '_CON.txt');
  assert.equal(localFileName('notes. ', 0, 'win32'), 'notes');
  const long = localFileName(`${'🌞'.repeat(200)}.jpg`, 12, 'linux');
  assert.ok(Buffer.byteLength(long) <= 255);
  assert.ok(long.endsWith('🌞 (12).jpg'), 'whole characters only, the number and extension kept');
});

/** A connection whose buffer is always full until the test lets it drain. */
function stuckWire() {
  const frames: FileFrame[] = [];
  const calls: string[] = [];
  let release = () => {};
  return {
    frames,
    calls,
    release: () => release(),
    wire: {
      send: (frame: FileFrame) => (frames.push(frame), false),
      drained: () => new Promise<void>((resolve) => (release = resolve)),
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
    },
  };
}

test('sending waits for the socket to drain before each next chunk', async () => {
  const path = join(dir, 'three-chunks.bin');
  writeFileSync(path, randomBytes(3 * MAX_CHUNK_BYTES));
  const { wire, frames, release } = stuckWire();
  const transfers = createTransfers({ wire, dir: join(dir, 'unused'), onReceived: () => undefined, onSent: () => undefined });
  transfers.send([path]);
  const kinds = () => frames.map((frame) => frame.t).join(' ');
  assert.ok(await until(() => kinds() === 'fileOffer fileChunk'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(kinds(), 'fileOffer fileChunk', 'nothing more until the socket drains');
  release();
  assert.ok(await until(() => kinds() === 'fileOffer fileChunk fileChunk'));
  release();
  assert.ok(await until(() => kinds() === 'fileOffer fileChunk fileChunk fileChunk'));
  release();
  assert.ok(await until(() => kinds().endsWith('fileEnd')));
  transfers.close();
});

test('receiving faster than the disk writes pauses reading from the phone until it catches up', async () => {
  const { wire, frames, calls } = stuckWire();
  const outcomes: FileOutcome[] = [];
  const target = join(dir, 'fast');
  const transfers = createTransfers({ wire, dir: target, onReceived: (outcome) => outcomes.push(outcome), onSent: () => undefined });
  const chunk = randomBytes(MAX_CHUNK_BYTES).toString('base64');
  transfers.receive({ t: 'fileOffer', id: 'x', name: 'burst.bin', size: 40 * MAX_CHUNK_BYTES, mime: null });
  for (let i = 0; i < 40; i++) transfers.receive({ t: 'fileChunk', id: 'x', data: chunk });
  assert.deepEqual(calls, ['pause'], '10 MiB waiting for the disk');
  transfers.receive({ t: 'fileEnd', id: 'x' });
  assert.ok(await until(() => outcomes.length === 1));
  assert.deepEqual(calls, ['pause', 'resume']);
  assert.deepEqual(frames, [{ t: 'fileResult', id: 'x', ok: true, error: null }]);
  assert.equal(readFileSync(join(target, 'burst.bin')).length, 40 * MAX_CHUNK_BYTES);
});

function startIncomingFile(t: TestContext, subdir: string, text: string) {
  const dirPath = join(dir, subdir);
  const { wire, frames } = stuckWire();
  const outcomes: FileOutcome[] = [];
  const transfers = createTransfers({ wire, dir: dirPath, onReceived: (outcome) => outcomes.push(outcome), onSent: () => undefined });
  t.after(() => transfers.close());
  transfers.receive({ t: 'fileOffer', id: 'id', name: 'report.txt', size: Buffer.byteLength(text), mime: null });
  transfers.receive({ t: 'fileChunk', id: 'id', data: Buffer.from(text).toString('base64') });
  transfers.receive({ t: 'fileEnd', id: 'id' });
  return { transfers, dirPath, frames, outcomes };
}

test('disconnect and cancellation after fileEnd discard the pending file', async (t) => {
  for (const end of ['disconnect', 'cancel']) {
    const { transfers, dirPath, frames, outcomes } = startIncomingFile(t, end, 'from the phone');
    if (end === 'disconnect') transfers.close();
    else transfers.receive({ t: 'fileCancel', id: 'id' });
    assert.ok(await until(() => outcomes.length > 0));
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [false]);
    assert.deepEqual(frames, []);
    assert.ok(await until(() => existsSync(dirPath) && readdirSync(dirPath).length === 0));
  }
});

test('cancellation while placement is pending keeps the published file but sends no success', { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const link = fs.link;
  const override = t.mock.method(fs, 'link', async (...args: Parameters<typeof link>) => {
    started.resolve();
    await ready.promise;
    return link(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    override.mock.restore();
    syncBuiltinESMExports();
  });

  const { transfers, dirPath, frames, outcomes } = startIncomingFile(t, 'cancel-placement', 'from the phone');
  await started.promise;
  transfers.receive({ t: 'fileCancel', id: 'id' });
  ready.resolve();
  assert.ok(await until(() => readdirSync(dirPath).join() === 'report.txt'));
  assert.equal(readFileSync(join(dirPath, 'report.txt'), 'utf8'), 'from the phone');
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [false]);
  assert.deepEqual(frames, []);
});

test('a cancel after publishing never deletes a file that took the published name', { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const unlink = fs.unlink;
  const override = t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
    const path = String(args[0]);
    if (path.startsWith(join(dir, 'cancel-after-publish')) && path.endsWith('.part')) {
      started.resolve();
      await ready.promise;
    }
    return unlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    override.mock.restore();
    syncBuiltinESMExports();
  });

  const { transfers, dirPath, frames } = startIncomingFile(t, 'cancel-after-publish', 'from the phone');
  await started.promise;
  // The user moves the received file away and saves another under the same name.
  const published = join(dirPath, 'report.txt');
  renameSync(published, join(dirPath, 'moved.txt'));
  writeFileSync(published, 'mine');
  transfers.receive({ t: 'fileCancel', id: 'id' });
  ready.resolve();
  assert.ok(await until(() => !readdirSync(dirPath).some((name) => name.endsWith('.part'))));
  assert.equal(readFileSync(published, 'utf8'), 'mine');
  assert.equal(readFileSync(join(dirPath, 'moved.txt'), 'utf8'), 'from the phone');
  assert.deepEqual(frames, []);
});

test('a short disk write is retried until all bytes are saved', async (t) => {
  const open = fs.open;
  const override = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const write = handle.write.bind(handle);
    t.mock.method(handle, 'write', (buffer: Buffer, offset = 0, length = buffer.length) => write(buffer, offset, Math.min(2, length)));
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    override.mock.restore();
    syncBuiltinESMExports();
  });
  const text = 'from the phone';
  const { dirPath, outcomes } = startIncomingFile(t, 'short-write', text);
  assert.ok(await until(() => outcomes.length === 1));
  assert.equal(outcomes[0]?.ok, true);
  assert.equal(readFileSync(join(dirPath, 'report.txt'), 'utf8'), text);
});

test('without hard links a file that takes the destination name is preserved', async (t) => {
  const target = join(dir, 'no-hard-links');
  await fs.mkdir(target);
  const original = join(target, 'report.txt');
  await fs.writeFile(original, 'mine');

  const fsError = (code: string) => Object.assign(new Error(code), { code });
  const link = t.mock.method(fs, 'link', async () => { throw fsError('EPERM'); });
  // Simulate a name that looked free just before the other writer created it.
  const stat = t.mock.method(fs, 'stat', async () => { throw fsError('ENOENT'); });
  syncBuiltinESMExports();
  t.after(() => {
    link.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
  });
  const { outcomes } = startIncomingFile(t, 'no-hard-links', 'from the phone');
  assert.ok(await until(() => outcomes.length === 1));
  assert.equal(outcomes[0]?.ok, true);
  assert.equal(readFileSync(original, 'utf8'), 'mine');
  assert.equal(readFileSync(join(target, 'report (1).txt'), 'utf8'), 'from the phone');
});
