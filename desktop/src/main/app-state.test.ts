import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SERVERS } from '../shared/streamroom.ts';
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
      dockAlwaysShown: true,
      theme: 'carbon',
      serviceOrder: ['whatsapp', 'proton-mail', 'discord'],
      hiddenServiceIds: ['discord'],
      hibernatedServiceIds: ['proton-mail'],
      awayModes: { whatsapp: 'sleep', 'proton-mail': 'run' },
      streamroom: { current: 'https://rooms.example.org', saved: ['https://rooms.example.org', 'http://localhost:8090'], localPort: 8081 },
      enabledServiceIds: ['proton-mail', 'whatsapp'],
      welcomed: true,
      sendClipboard: false,
      driveBackupFolders: ['/home/me/Documents'],
      driveBackupLast: { at: 1_700_000_000_000, ok: true, sentBytes: 17, failed: 0 },
    };
    saveAppState(file, state);
    assert.deepEqual(loadAppState(file, ids), state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Streamroom server choice keeps good addresses and falls back to this PC', () => {
  const read = (streamroom: unknown) => parseAppState({ streamroom }, ids).streamroom;
  assert.deepEqual(read({ current: 'https://rooms.example.org/r/abc', saved: ['rooms.example.org', 'http://192.168.1.20:8080', 7, 'http://localhost:8080'] }), {
    current: 'https://rooms.example.org',
    saved: ['https://rooms.example.org'],
    localPort: 8080,
  });
  assert.deepEqual(read({ current: 'ftp://rooms.example.org', saved: [] }), DEFAULT_SERVERS);
  assert.deepEqual(read('https://rooms.example.org'), DEFAULT_SERVERS);
});

test('apps: a new state has none on until chosen; an old one keeps everything but opt-in services', () => {
  assert.deepEqual(parseAppState({ enabledServiceIds: ['whatsapp', 'icq', 'proton-mail'], welcomed: true }, ids).enabledServiceIds, ['proton-mail', 'whatsapp']);
  const old = parseAppState({ activeServiceId: 'discord' }, [...ids, 'gmail'], { optIn: ['gmail'] });
  assert.deepEqual({ on: old.enabledServiceIds, welcomed: old.welcomed }, { on: ids, welcomed: true });
  assert.equal(parseAppState({ enabledServiceIds: ['discord'] }, ids).welcomed, false, 'chosen but never saved as welcomed');
  const off = parseAppState({ activeServiceId: 'discord', enabledServiceIds: ['proton-mail', 'whatsapp'], welcomed: true }, ids);
  assert.equal(off.activeServiceId, 'proton-mail', 'a service switched off is not opened at launch');
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
      dockAlwaysShown: false,
      theme: 'system',
      serviceOrder: ids,
      hiddenServiceIds: [],
      hibernatedServiceIds: [],
      awayModes: {},
      streamroom: DEFAULT_SERVERS,
      enabledServiceIds: [],
      welcomed: false,
      sendClipboard: true,
      driveBackupFolders: [],
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
      dockAlwaysShown: 'yes',
      theme: 'solarized',
    },
    ids,
  );
  assert.deepEqual(state, {
    bounds: undefined,
    maximized: false,
    activeServiceId: 'proton-mail',
    mutedServiceIds: ['discord'],
    dockAlwaysShown: false,
    theme: 'system',
    serviceOrder: ids,
    hiddenServiceIds: [],
    hibernatedServiceIds: [],
    awayModes: {},
    streamroom: DEFAULT_SERVERS,
    enabledServiceIds: ids,
    welcomed: true,
    sendClipboard: true,
    driveBackupFolders: [],
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

test('a state file from before the websites stayed awake still loads, and drops the old field', () => {
  const state = parseAppState({ activeServiceId: 'discord', mutedServiceIds: ['whatsapp'], keepAwakeServiceIds: ['discord'] }, ids);
  assert.equal(state.activeServiceId, 'discord');
  assert.deepEqual(state.mutedServiceIds, ['whatsapp']);
  assert.equal('keepAwakeServiceIds' in state, false);
});

test('a state file from the side bar still loads bounds, active service and muting, and drops the side and auto-hide', () => {
  const bounds = { x: 40, y: 30, width: 1100, height: 700 };
  const state = parseAppState({ bounds, maximized: true, activeServiceId: 'whatsapp', mutedServiceIds: ['discord'], barSide: 'right', barAutoHide: true }, ids);
  assert.deepEqual(state, { bounds, maximized: true, activeServiceId: 'whatsapp', mutedServiceIds: ['discord'], dockAlwaysShown: false, theme: 'system', serviceOrder: ids, hiddenServiceIds: [], hibernatedServiceIds: [], awayModes: {}, streamroom: DEFAULT_SERVERS, enabledServiceIds: ids, welcomed: true, sendClipboard: true, driveBackupFolders: [] });
});

test('a state file from the aligned dock still loads bounds, active service and muting, drops the alignment and hides the dock', () => {
  const bounds = { x: 40, y: 30, width: 1100, height: 700 };
  const state = parseAppState({ bounds, maximized: false, activeServiceId: 'discord', mutedServiceIds: ['whatsapp'], dockAlign: 'end' }, ids);
  assert.deepEqual(state, { bounds, maximized: false, activeServiceId: 'discord', mutedServiceIds: ['whatsapp'], dockAlwaysShown: false, theme: 'system', serviceOrder: ids, hiddenServiceIds: [], hibernatedServiceIds: [], awayModes: {}, streamroom: DEFAULT_SERVERS, enabledServiceIds: ids, welcomed: true, sendClipboard: true, driveBackupFolders: [] });
});

test('a state file from before themes still loads everything else and matches the system', () => {
  const bounds = { x: 40, y: 30, width: 1100, height: 700 };
  const state = parseAppState({ bounds, maximized: false, activeServiceId: 'discord', mutedServiceIds: ['whatsapp'], dockAlwaysShown: true }, ids);
  assert.deepEqual(state, { bounds, maximized: false, activeServiceId: 'discord', mutedServiceIds: ['whatsapp'], dockAlwaysShown: true, theme: 'system', serviceOrder: ids, hiddenServiceIds: [], hibernatedServiceIds: [], awayModes: {}, streamroom: DEFAULT_SERVERS, enabledServiceIds: ids, welcomed: true, sendClipboard: true, driveBackupFolders: [] });
});

test('keeps each named theme, and anything else matches the system', () => {
  for (const theme of ['switchboard', 'daylight', 'bakelite', 'carbon', 'aubergine']) assert.equal(parseAppState({ theme }, ids).theme, theme);
  for (const theme of ['system', 'Carbon', 'dark', '', 3, null, { id: 'carbon' }]) assert.equal(parseAppState({ theme }, ids).theme, 'system');
});

test('a state file from before the dock could be rearranged still loads everything else, in registry order with nothing hidden', () => {
  const bounds = { x: 40, y: 30, width: 1100, height: 700 };
  const state = parseAppState({ bounds, maximized: true, activeServiceId: 'discord', mutedServiceIds: ['whatsapp'], dockAlwaysShown: true, theme: 'carbon' }, ids);
  assert.deepEqual(state, {
    bounds,
    maximized: true,
    activeServiceId: 'discord',
    mutedServiceIds: ['whatsapp'],
    dockAlwaysShown: true,
    theme: 'carbon',
    serviceOrder: ids,
    hiddenServiceIds: [],
    hibernatedServiceIds: [],
    awayModes: {},
    streamroom: DEFAULT_SERVERS,
    enabledServiceIds: ids,
    welcomed: true,
    sendClipboard: true,
    driveBackupFolders: [],
  });
});

test('the saved dock order and hidden services are checked one by one', () => {
  const state = parseAppState({ serviceOrder: ['whatsapp', 'icq', 'whatsapp', 'proton-mail'], hiddenServiceIds: ['discord', 'proton-mail', 'myspace', 'discord'] }, ids, { unhideable: ['proton-mail'] });
  assert.deepEqual(state.serviceOrder, ['whatsapp', 'proton-mail', 'discord']);
  assert.deepEqual(state.hiddenServiceIds, ['discord']);
});

test('a hidden service is not opened at launch; the first tab in the dock is', () => {
  const state = parseAppState({ activeServiceId: 'discord', serviceOrder: ['whatsapp', 'discord', 'proton-mail'], hiddenServiceIds: ['discord'] }, ids);
  assert.equal(state.activeServiceId, 'whatsapp');
  assert.equal(parseAppState({ serviceOrder: ['discord', 'whatsapp', 'proton-mail'], hiddenServiceIds: ['discord'] }, ids).activeServiceId, 'whatsapp');
});

const rules = { sleepless: ['proton-mail'], startHibernated: ['whatsapp'] };

test('hibernating services are kept, checked one by one, and never include the one opened at launch', () => {
  const state = parseAppState({ activeServiceId: 'discord', serviceOrder: ids, hibernatedServiceIds: ['discord', 'whatsapp', 'icq', 'whatsapp', 'proton-mail', 7] }, ids, rules);
  assert.deepEqual(state.hibernatedServiceIds, ['whatsapp'], 'the active Discord wakes, and Proton never hibernates');
});

test('a service that starts hibernated does so the first time the state knows it, and only then', () => {
  assert.deepEqual(loadAppState('/nonexistent/kainos-state.json', ids, rules).hibernatedServiceIds, ['whatsapp'], 'a first launch');
  assert.deepEqual(parseAppState({ serviceOrder: ['proton-mail', 'discord'] }, ids, rules).hibernatedServiceIds, ['whatsapp'], 'added in a later version');
  assert.deepEqual(parseAppState({ serviceOrder: ids, hibernatedServiceIds: [] }, ids, rules).hibernatedServiceIds, [], 'woken by the user before');
  assert.deepEqual(parseAppState({ activeServiceId: 'whatsapp', serviceOrder: ['whatsapp'] }, ids, rules).hibernatedServiceIds, [], 'unless it is the one opened');
});

test('background picks are kept for known websites with a real mode, and only those', () => {
  const state = parseAppState({ awayModes: { whatsapp: 'sleep', discord: 'hibernate', 'proton-mail': 'run', icq: 'run' } }, ids, rules);
  assert.deepEqual(state.awayModes, { whatsapp: 'sleep', discord: 'hibernate' }, "Proton never hibernates here, so it has no pick; ICQ is gone");
  assert.deepEqual(parseAppState({ awayModes: { whatsapp: 'nap', discord: 3 } }, ids).awayModes, {});
  assert.deepEqual(parseAppState({ awayModes: ['whatsapp'] }, ids).awayModes, {});
});

test('sending copied text to the phone is on unless the user turned it off', () => {
  assert.equal(parseAppState({}, ids).sendClipboard, true);
  assert.equal(parseAppState({ sendClipboard: 'no' }, ids).sendClipboard, true);
  assert.equal(parseAppState({ sendClipboard: false }, ids).sendClipboard, false);
});

test('a chosen folder for phone files is kept only as an absolute path', () => {
  assert.equal(parseAppState({ receiveFolder: '/home/me/Phone files' }, ids).receiveFolder, '/home/me/Phone files');
  assert.equal('receiveFolder' in parseAppState({}, ids), false);
  assert.equal('receiveFolder' in parseAppState({ receiveFolder: 'relative/dir' }, ids), false);
  assert.equal('receiveFolder' in parseAppState({ receiveFolder: 42 }, ids), false);
});

test('Drive backup folders are kept as absolute paths once each, and a bad last result is dropped', () => {
  const state = parseAppState({ driveBackupFolders: ['/home/me/Documents', 'relative', 7, '/home/me/Documents', '/mnt/data'] }, ids);
  assert.deepEqual(state.driveBackupFolders, ['/home/me/Documents', '/mnt/data']);
  assert.deepEqual(parseAppState({}, ids).driveBackupFolders, []);
  assert.deepEqual(parseAppState({ driveBackupSkipped: ['/home/me/Documents/Code', 'Code', 3] }, ids).driveBackupSkipped, ['/home/me/Documents/Code']);
  assert.equal('driveBackupSkipped' in parseAppState({ driveBackupSkipped: [] }, ids), false);
  const last = { at: 1_700_000_000_000, ok: false, sentBytes: 0, failed: 0, error: 'Failed to load session', signIn: true, missing: ['/mnt/data'] };
  assert.deepEqual(parseAppState({ driveBackupLast: last }, ids).driveBackupLast, last);
  assert.equal('driveBackupLast' in parseAppState({ driveBackupLast: { at: 'yesterday', ok: true } }, ids), false);
  const details = { at: 1, ok: false, sentBytes: 4, failed: 1, error: 'a: x', failures: [{ name: 'a', error: 'x' }], links: 2, lowSpace: true };
  assert.deepEqual(parseAppState({ driveBackupLast: details }, ids).driveBackupLast, details);
});

test("this PC's Drive folder name is kept once given, and never as a path", () => {
  assert.equal(parseAppState({ drivePc: 'desk' }, ids).drivePc, 'desk');
  assert.equal('drivePc' in parseAppState({}, ids), false);
  assert.equal('drivePc' in parseAppState({ drivePc: '  ' }, ids), false);
  assert.equal('drivePc' in parseAppState({ drivePc: '../x' }, ids), false);
});
