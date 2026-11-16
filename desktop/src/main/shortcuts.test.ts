import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortcutFor, type KeyInput } from './shortcuts.ts';

const press = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: 'keyDown', key, code, control: false, meta: false, alt: false, shift: false, ...mods,
});
const ctrl = { control: true };

test('Ctrl+1..3 picks the service in that slot', () => {
  assert.deepEqual(shortcutFor(press('1', 'Digit1', ctrl), 'linux', 3), { kind: 'service', index: 0 });
  assert.deepEqual(shortcutFor(press('3', 'Digit3', ctrl), 'win32', 3), { kind: 'service', index: 2 });
  assert.deepEqual(shortcutFor(press('2', 'Digit2', { meta: true }), 'darwin', 3), { kind: 'service', index: 1 });
  assert.deepEqual(shortcutFor(press('2', 'Numpad2', ctrl), 'linux', 3), { kind: 'service', index: 1 });
});

test('the digit is the physical key, so AZERTY works without Shift', () => {
  assert.deepEqual(shortcutFor(press('&', 'Digit1', ctrl), 'linux', 3), { kind: 'service', index: 0 });
  assert.deepEqual(shortcutFor(press('é', 'Digit2', ctrl), 'linux', 3), { kind: 'service', index: 1 });
  assert.deepEqual(shortcutFor(press('"', 'Digit3', ctrl), 'linux', 3), { kind: 'service', index: 2 });
  // The character alone is not enough: Ctrl+1 typed on another key does nothing.
  assert.equal(shortcutFor(press('1', 'KeyQ', ctrl), 'linux', 3), undefined);
});

test('with no physical key reported, the character decides', () => {
  assert.deepEqual(shortcutFor(press('2', '', ctrl), 'linux', 3), { kind: 'service', index: 1 });
  assert.equal(shortcutFor(press('&', '', ctrl), 'linux', 3), undefined);
});

test('ignores slots past the last service, other modifiers and key-up', () => {
  assert.equal(shortcutFor(press('4', 'Digit4', ctrl), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('1', 'Digit1'), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('1', 'Digit1', { control: true, shift: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('1', 'Digit1', { control: true, alt: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('1', 'Digit1', { control: true, type: 'keyUp' }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('1', 'Digit1', { meta: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('0', 'Digit0', ctrl), 'linux', 3), undefined);
});

test('Ctrl+Q quits, by the letter on the keyboard', () => {
  assert.deepEqual(shortcutFor(press('q', 'KeyQ', ctrl), 'linux', 3), { kind: 'quit' });
  assert.deepEqual(shortcutFor(press('Q', 'KeyQ', ctrl), 'win32', 3), { kind: 'quit' });
  // AZERTY: the Q key sits where QWERTY has A.
  assert.deepEqual(shortcutFor(press('q', 'KeyA', ctrl), 'linux', 3), { kind: 'quit' });
  assert.deepEqual(shortcutFor(press('q', 'KeyQ', { meta: true }), 'darwin', 3), { kind: 'quit' });
  assert.equal(shortcutFor(press('a', 'KeyQ', ctrl), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('q', 'KeyQ', { control: true, shift: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('q', 'KeyQ'), 'linux', 3), undefined);
});

test('F6 moves between the sidebar and the service', () => {
  assert.deepEqual(shortcutFor(press('F6', 'F6'), 'linux', 3), { kind: 'switch-pane' });
  assert.equal(shortcutFor(press('F6', 'F6', ctrl), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('F6', 'F6', { shift: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('F6', 'F6', { type: 'keyUp' }), 'linux', 3), undefined);
});

test('F5 and Ctrl+R reload the open service; Shift or Ctrl+F5 skips the cache', () => {
  const reload = { kind: 'reload', ignoreCache: false };
  const hard = { kind: 'reload', ignoreCache: true };
  assert.deepEqual(shortcutFor(press('F5', 'F5'), 'linux', 3), reload);
  assert.deepEqual(shortcutFor(press('F5', 'F5', { shift: true }), 'linux', 3), hard);
  assert.deepEqual(shortcutFor(press('F5', 'F5', ctrl), 'linux', 3), hard);
  assert.deepEqual(shortcutFor(press('r', 'KeyR', ctrl), 'linux', 3), reload);
  assert.deepEqual(shortcutFor(press('R', 'KeyR', { control: true, shift: true }), 'linux', 3), hard);
  assert.deepEqual(shortcutFor(press('r', 'KeyR', { meta: true }), 'darwin', 3), reload);
  assert.equal(shortcutFor(press('r', 'KeyR'), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('r', 'KeyR', { control: true, alt: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('F5', 'F5', { alt: true }), 'linux', 3), undefined);
  assert.equal(shortcutFor(press('F5', 'F5', { type: 'keyUp' }), 'linux', 3), undefined);
});
