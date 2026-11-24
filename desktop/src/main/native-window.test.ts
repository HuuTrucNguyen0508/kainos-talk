import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appWindow, findProgram, luaString, shellLine, sitsOn, targetRect } from './native-window.ts';

const THUNDERBIRD = { command: ['thunderbird'], windowClass: 'org.mozilla.Thunderbird', mainTitle: 'Mozilla Thunderbird' };
const main = { address: '0xa', class: 'org.mozilla.Thunderbird', initialTitle: 'Mozilla Thunderbird', title: 'Inbox - Mozilla Thunderbird' };
const compose = { address: '0xb', class: 'org.mozilla.Thunderbird', initialTitle: 'Write: (no subject)', title: 'Write: Hello - Thunderbird' };
const firefox = { address: '0xc', class: 'firefox', initialTitle: 'Mozilla Thunderbird', title: 'Mozilla Thunderbird' };

test('the main window is the one that opened with the main title, never a message being written or another app', () => {
  assert.equal(appWindow([compose, firefox, main], THUNDERBIRD, undefined), main);
  assert.equal(appWindow([compose, firefox], THUNDERBIRD, undefined), undefined);
});

test('once found, the main window is followed by its address, whatever it is titled since', () => {
  const renamed = { ...main, initialTitle: 'Thunderbird' };
  assert.equal(appWindow([compose, renamed], THUNDERBIRD, '0xa'), renamed);
  // Gone: another main window takes its place.
  assert.equal(appWindow([compose, { ...main, address: '0xd' }], THUNDERBIRD, '0xa')?.address, '0xd');
});

test("the app's window goes on the tab's place in Kainos' content, below any frame Electron draws", () => {
  const area = { x: 0, y: 0, width: 1200, height: 748 };
  // No frame: the content is the window.
  assert.deepEqual(targetRect([100, 50], [1200, 800], { width: 1200, height: 800 }, area), { x: 100, y: 50, width: 1200, height: 748 });
  // A 37px title bar on top.
  assert.deepEqual(targetRect([100, 50], [1200, 837], { width: 1200, height: 800 }, area), { x: 100, y: 87, width: 1200, height: 748 });
  // The tab below a call strip.
  assert.deepEqual(targetRect([0, 0], [1200, 800], { width: 1200, height: 800 }, { x: 0, y: 40, width: 1200, height: 708 }), { x: 0, y: 40, width: 1200, height: 708 });
});

test('a window already on its place needs no move', () => {
  const rect = { x: 10, y: 20, width: 300, height: 200 };
  assert.equal(sitsOn({ at: [10, 20], size: [300, 200] }, rect), true);
  assert.equal(sitsOn({ at: [10, 21], size: [300, 200] }, rect), false);
  assert.equal(sitsOn({ at: [10, 20] }, rect), false);
});

test('dispatcher arguments are quoted for Lua and the command for the shell', () => {
  assert.equal(luaString('special:kainos silent'), '"special:kainos silent"');
  assert.equal(luaString('a "b" \\ c\n'), '"a \\"b\\" \\\\ c\\n"');
  assert.equal(shellLine(['thunderbird']), 'thunderbird');
  assert.equal(shellLine(['thunderbird', '-P', "Bob's mail"]), `thunderbird -P 'Bob'\\''s mail'`);
});

// The Thunderbird tab runs on Linux (Hyprland) only; this test uses POSIX PATH and exec bits.
test('the program is looked up on the PATH; one that is not there is missing', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kainos-path-'));
  try {
    const program = join(dir, 'thunderbird');
    writeFileSync(program, '#!/bin/sh\n');
    chmodSync(program, 0o755);
    writeFileSync(join(dir, 'not-runnable'), '');
    assert.equal(findProgram('thunderbird', `/nowhere:${dir}`, ['']), program);
    assert.equal(findProgram('not-runnable', dir, ['']), undefined);
    assert.equal(findProgram('betterbird', dir, ['']), undefined);
    assert.equal(findProgram(program, '', ['']), program);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
