import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fitToDisplays, loadAppState, parseAppState, saveAppState, type AppState } from './app-state.ts';

const ids = ['proton-mail', 'discord', 'whatsapp'];

test('round-trips through the state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kainos-state-'));
  try {
    const file = join(dir, 'nested', 'state.json');
    const state: AppState = {
      bounds: { x: 40, y: 30, width: 1100, height: 700 },
      maximized: true,
      activeServiceId: 'whatsapp',
      mutedServiceIds: ['discord'],
      barSide: 'right',
      barAutoHide: true,
      keepAwakeServiceIds: ['whatsapp'],
    };
    saveAppState(file, state);
    assert.deepEqual(loadAppState(file, ids), state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or broken file gives defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kainos-state-'));
  try {
    const file = join(dir, 'state.json');
    assert.deepEqual(loadAppState(file, ids), {
      bounds: undefined,
      maximized: false,
      activeServiceId: 'proton-mail',
      mutedServiceIds: [],
      barSide: 'auto',
      barAutoHide: false,
      keepAwakeServiceIds: [],
    });
    writeFileSync(file, '{ not json');
    assert.equal(loadAppState(file, ids).activeServiceId, 'proton-mail');
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drops unknown services and bad fields one by one', () => {
  const state = parseAppState(
    {
      bounds: { x: 0, y: 0, width: 'wide', height: 700 },
      activeServiceId: 'myspace',
      mutedServiceIds: ['discord', 'icq', 'discord', 4],
      barSide: 'top',
      barAutoHide: 'yes',
    },
    ids,
  );
  assert.deepEqual(state, {
    bounds: undefined,
    maximized: false,
    activeServiceId: 'proton-mail',
    mutedServiceIds: ['discord'],
    barSide: 'auto',
    barAutoHide: false,
    keepAwakeServiceIds: [],
  });
  assert.equal(parseAppState({ bounds: { x: 0, y: 0, width: 100, height: 100 } }, ids).bounds, undefined, 'too small');
});

test('keeps a window that is on screen where it was', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const bounds = { x: 100, y: 80, width: 1200, height: 800 };
  assert.deepEqual(fitToDisplays(bounds, [screen]), bounds);
});

test('brings back a window left on an unplugged monitor', () => {
  const laptop = { x: 0, y: 0, width: 1366, height: 768 };
  assert.deepEqual(fitToDisplays({ x: 2200, y: 100, width: 1200, height: 800 }, [laptop]), { x: 166, y: 0, width: 1200, height: 768 });
});

test('picks the display the window mostly covers', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1080 };
  const right = { x: 1920, y: 0, width: 2560, height: 1440 };
  const bounds = { x: 2000, y: 100, width: 1200, height: 800 };
  assert.deepEqual(fitToDisplays(bounds, [left, right]), bounds);
});
