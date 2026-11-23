import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainWindow, onScreen } from './hyprland.ts';

// As hyprctl -j prints them (Hyprland 0.57), trimmed to the fields that matter.
const monitors = [
  { id: 0, name: 'DP-2', activeWorkspace: { id: 1, name: '1' }, specialWorkspace: { id: 0, name: '' } },
  { id: 1, name: 'DP-3', activeWorkspace: { id: 2, name: '2' }, specialWorkspace: { id: -98, name: 'special:communication' } },
];
const window = (workspace: string, more: Record<string, unknown> = {}) => ({ address: '0xa1', pid: 42, title: 'Kainos Talk', mapped: true, hidden: false, monitor: 0, workspace: { name: workspace }, ...more });

test('a window on a workspace a screen shows is on screen', () => {
  assert.equal(onScreen(window('1'), monitors), true);
  assert.equal(onScreen(window('special:communication', { monitor: 1 }), monitors), true);
});

test('a window on a hidden special workspace, another workspace, unmapped or hidden is not', () => {
  assert.equal(onScreen(window('special:communication', { monitor: 0 }), monitors), false);
  assert.equal(onScreen(window('3'), monitors), false);
  assert.equal(onScreen(window('1', { mapped: false }), monitors), false);
  assert.equal(onScreen(window('1', { hidden: true }), monitors), false);
  assert.equal(onScreen({ pid: 42 }, monitors), false);
});

test('a window on a monitor the answer does not list says nothing either way', () => {
  assert.equal(onScreen(window('1', { monitor: 2 }), monitors), undefined);
});

test("the main window is this app's window with the window's title, not its popups or another app's", () => {
  const popup = window('1', { address: '0xb2', title: 'mail.google.com: New message' });
  const other = window('1', { address: '0xc3', pid: 7 });
  assert.equal(mainWindow([popup, other, window('3')], 42, 'Kainos Talk', undefined)?.address, '0xa1');
  assert.equal(mainWindow([popup, other], 42, 'Kainos Talk', undefined), undefined);
});

test('once found, the main window is followed by its address while its title changes', () => {
  assert.equal(mainWindow([window('3', { title: '(4) Kainos Talk' })], 42, '(5) Kainos Talk', '0xa1')?.title, '(4) Kainos Talk');
  // A window shown again from the tray comes back as a new one, found by its title.
  assert.equal(mainWindow([window('3', { address: '0xd4' })], 42, 'Kainos Talk', '0xa1')?.address, '0xd4');
  // Another app's window given the old address is not it.
  assert.equal(mainWindow([window('1', { pid: 7 }), window('3', { address: '0xd4' })], 42, 'Kainos Talk', '0xa1')?.address, '0xd4');
});
