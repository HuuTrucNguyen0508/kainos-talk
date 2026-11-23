import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { polledClipboard, startClipboardSync, textType, waylandClipboard, type ClipboardBackend } from './clipboard-sync.ts';

/** A clipboard the test copies to, as another app would. */
function fakeClipboard(initial: string | undefined) {
  let text = initial;
  let changed = () => {};
  let hold: Promise<void> | undefined;
  const written: string[] = [];
  const backend: ClipboardBackend = {
    read: async () => {
      const now = text;
      await hold;
      return now;
    },
    watch: (onChange) => {
      changed = onChange;
      return () => (changed = () => {});
    },
    write: (value) => {
      written.push(value);
      text = value;
      changed();
    },
  };
  return {
    backend,
    written,
    copy(value: string) {
      text = value;
      changed();
    },
    /** Reads wait until the returned function is called. */
    stall() {
      let release = () => {};
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('each new copy goes to the phone once; what was on the clipboard before does not', async () => {
  const clipboard = fakeClipboard('copied yesterday');
  const sent: string[] = [];
  await startClipboardSync(clipboard.backend, { send: (text) => (sent.push(text), true), enabled: () => true });
  clipboard.copy('copied yesterday');
  await settle();
  assert.deepEqual(sent, []);
  clipboard.copy('flat 3, 12 rue Oberkampf');
  await settle();
  clipboard.copy('flat 3, 12 rue Oberkampf');
  await settle();
  assert.deepEqual(sent, ['flat 3, 12 rue Oberkampf']);
});

test('text from the phone lands on the clipboard and is not sent back, but copying it again later is', async () => {
  const clipboard = fakeClipboard(undefined);
  const sent: string[] = [];
  const sync = await startClipboardSync(clipboard.backend, { send: (text) => (sent.push(text), true), enabled: () => true });
  sync.apply('from the phone');
  await settle();
  assert.deepEqual(clipboard.written, ['from the phone']);
  assert.deepEqual(sent, [], 'no echo');
  clipboard.copy('something else');
  await settle();
  clipboard.copy('from the phone');
  await settle();
  assert.deepEqual(sent, ['something else', 'from the phone']);
});

test('a read that started before the phone\'s text arrived does not send the old text', async () => {
  const clipboard = fakeClipboard(undefined);
  const sent: string[] = [];
  const sync = await startClipboardSync(clipboard.backend, { send: (text) => (sent.push(text), true), enabled: () => true });
  const release = clipboard.stall();
  clipboard.copy('old');
  sync.apply('from the phone');
  release();
  await settle();
  assert.deepEqual(sent, []);
});

test('clipboard changes while the phone write is pending do not send old text or echo the write', async () => {
  const clipboard = fakeClipboard(undefined);
  const sent: string[] = [];
  const write = clipboard.backend.write;
  const { promise, resolve } = Promise.withResolvers<void>();
  clipboard.backend.write = async (text) => {
    await promise;
    write(text);
  };
  const sync = await startClipboardSync(clipboard.backend, { send: (text) => (sent.push(text), true), enabled: () => true });
  sync.apply('from the phone');
  clipboard.copy('old');
  await settle();
  resolve();
  await settle();
  assert.deepEqual(sent, []);
  clipboard.copy('new local text');
  await settle();
  assert.deepEqual(sent, ['new local text']);
});

test('with sending turned off nothing goes to the phone, and the phone\'s text still applies', async () => {
  const clipboard = fakeClipboard(undefined);
  const sent: string[] = [];
  let enabled = false;
  const sync = await startClipboardSync(clipboard.backend, { send: (text) => (sent.push(text), true), enabled: () => enabled });
  clipboard.copy('private');
  await settle();
  sync.apply('from the phone');
  assert.deepEqual(clipboard.written, ['from the phone']);
  enabled = true;
  clipboard.copy('public');
  await settle();
  assert.deepEqual(sent, ['public']);
});

test('text is read as UTF-8 when the app offers it', () => {
  assert.equal(textType(['text/html', 'text/plain', 'text/plain;charset=utf-8', 'STRING']), 'text/plain;charset=utf-8');
  assert.equal(textType(['STRING', 'UTF8_STRING']), 'UTF8_STRING');
  assert.equal(textType(['image/png']), undefined, 'a picture is not text');
});

test('under Wayland, text a password manager marks secret is not read', async (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'kainos-wl-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // A stand-in for wl-paste that serves what the test puts beside it.
  writeFileSync(
    join(bin, 'wl-paste'),
    '#!/bin/sh\nd="$(dirname "$0")"\ncase "$1" in\n  --list-types) cat "$d/types" ;;\n  --no-newline) case "$3" in x-kde-passwordManagerHint) cat "$d/hint" ;; *) if [ -f "$d/next-types" ]; then mv "$d/next-types" "$d/types"; fi; cat "$d/text" ;; esac ;;\nesac\n',
  );
  chmodSync(join(bin, 'wl-paste'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => (process.env.PATH = path));
  const offer = (types: string[], text: string, hint = '') => {
    writeFileSync(join(bin, 'types'), `${types.join('\n')}\n`);
    writeFileSync(join(bin, 'text'), text);
    writeFileSync(join(bin, 'hint'), hint);
  };
  const clipboard = waylandClipboard();
  offer(['text/plain;charset=utf-8', 'x-kde-passwordManagerHint'], 'hunter2', 'secret');
  assert.equal(await clipboard.read(), undefined);
  offer(['text/plain;charset=utf-8', 'x-kde-passwordManagerHint'], 'my username', 'public');
  assert.equal(await clipboard.read(), 'my username');
  offer(['text/plain;charset=utf-8'], 'line one\nline two\n');
  assert.equal(await clipboard.read(), 'line one\nline two\n', 'exactly as copied');
  offer(['text/plain;charset=utf-8', 'x-kde-passwordManagerHint'], 'unreadable hint');
  unlinkSync(join(bin, 'hint'));
  assert.equal(await clipboard.read(), undefined, 'a failed hint read must withhold the text');

  offer(['text/plain;charset=utf-8'], 'replacement text');
  writeFileSync(join(bin, 'next-types'), 'text/plain;charset=utf-8\nx-kde-passwordManagerHint\n');
  assert.equal(await clipboard.read(), undefined, 'the offer changed while reading the text');

  offer(['image/png'], 'PNG…');
  assert.equal(await clipboard.read(), undefined);
});

test('elsewhere, Electron\'s clipboard is polled, and the phone\'s text is written to it', async (t) => {
  let text = 'before';
  const electron = { has: async () => false, readText: async () => text, writeText: async (value: string) => void (text = value) };
  const sent: string[] = [];
  const sync = await startClipboardSync(polledClipboard(electron, 10), { send: (value) => (sent.push(value), true), enabled: () => true });
  t.after(() => sync.stop());
  text = 'copied';
  await new Promise((resolve) => setTimeout(resolve, 40));
  sync.apply('from the phone');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(text, 'from the phone');
  assert.deepEqual(sent, ['copied']);
});

test('polling withholds clipboard text marked private by Linux or Windows', async () => {
  const cases = [
    ['linux', 'x-kde-passwordManagerHint'],
    ['win32', 'ExcludeClipboardContentFromMonitorProcessing'],
  ] as const;
  for (const [platform, marker] of cases) {
    let isPrivate = true;
    const clipboard = polledClipboard({
      has: async (format: string) => isPrivate && format === `electron application/osclipboard;format="${marker}"`,
      readText: async () => 'clipboard text',
      writeText: () => {},
    }, 1000, platform);
    assert.equal(await clipboard.read(), undefined, platform);
    isPrivate = false;
    assert.equal(await clipboard.read(), 'clipboard text', platform);
  }
});
