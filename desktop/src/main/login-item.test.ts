import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autostartEntry, autostartFile, execArgument, launchCommand, loginItem, type LoginItemApi, type LoginItemContext } from './login-item.ts';

const noApi: LoginItemApi = {
  getLoginItemSettings: () => assert.fail('not on Linux'),
  setLoginItemSettings: () => assert.fail('not on Linux'),
};

function linux(env: NodeJS.ProcessEnv, over: Partial<LoginItemContext> = {}): LoginItemContext {
  return { platform: 'linux', env, execPath: '/opt/kainos/kainos-talk', isPackaged: false, appPath: '/home/me/Code/Kainos Talk/desktop', api: noApi, ...over };
}

test('runs the AppImage, the portable exe, the installed binary or the checkout launcher', () => {
  const base = { execPath: '/tmp/.mount_x/kainos-talk', appPath: '/home/me/k/desktop' };
  assert.equal(launchCommand({ ...base, platform: 'linux', env: { APPIMAGE: '/home/me/Kainos-Talk-0.3.6.AppImage' }, isPackaged: true }), '/home/me/Kainos-Talk-0.3.6.AppImage');
  assert.equal(launchCommand({ ...base, platform: 'linux', env: {}, isPackaged: true }), '/tmp/.mount_x/kainos-talk');
  assert.equal(launchCommand({ ...base, platform: 'linux', env: {}, isPackaged: false }), '/home/me/k/desktop/bin/kainos-talk');
  assert.equal(launchCommand({ ...base, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Kainos.exe' }, isPackaged: true }), 'D:\\Kainos.exe');
});

test('quotes the command for Exec, spaces and special characters included', () => {
  assert.equal(execArgument('/home/me/Code/Kainos Talk/desktop/bin/kainos-talk'), '"/home/me/Code/Kainos Talk/desktop/bin/kainos-talk"');
  assert.equal(execArgument('/a/$b"c`d'), '"/a/\\\\$b\\\\"c\\\\`d"');
  assert.equal(execArgument('/a\\b'), '"/a\\\\\\\\b"');
  assert.equal(execArgument('/100%/k'), '"/100%%/k"');
  assert.match(autostartEntry('/x y/k'), /^Exec="\/x y\/k"$/m);
});

test('the entry goes in the XDG config autostart folder', () => {
  assert.equal(autostartFile({ XDG_CONFIG_HOME: '/c' }, '/home/me'), '/c/autostart/kainos-talk.desktop');
  assert.equal(autostartFile({}, '/home/me'), '/home/me/.config/autostart/kainos-talk.desktop');
});

test('on Linux, turning it on writes the autostart entry and off removes it', () => {
  const config = mkdtempSync(join(tmpdir(), 'kainos-login-'));
  try {
    const item = loginItem(linux({ XDG_CONFIG_HOME: config }));
    const file = join(config, 'autostart', 'kainos-talk.desktop');
    assert.equal(item.enabled(), false);
    item.set(true);
    assert.equal(item.enabled(), true);
    assert.match(readFileSync(file, 'utf8'), /^Exec="\/home\/me\/Code\/Kainos Talk\/desktop\/bin\/kainos-talk"$/m);
    item.set(false);
    assert.equal(existsSync(file), false);
    item.set(false);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('a new AppImage repoints an entry left by the old one, and adds none', () => {
  const config = mkdtempSync(join(tmpdir(), 'kainos-login-'));
  try {
    const file = join(config, 'autostart', 'kainos-talk.desktop');
    loginItem(linux({ XDG_CONFIG_HOME: config, APPIMAGE: '/apps/Kainos-Talk-0.3.6.AppImage' }, { isPackaged: true }));
    assert.equal(existsSync(file), false);
    mkdirSync(join(config, 'autostart'));
    writeFileSync(file, autostartEntry('/apps/Kainos-Talk-0.3.5.AppImage'));
    loginItem(linux({ XDG_CONFIG_HOME: config, APPIMAGE: '/apps/Kainos-Talk-0.3.6.AppImage' }, { isPackaged: true }));
    assert.match(readFileSync(file, 'utf8'), /Kainos-Talk-0\.3\.6\.AppImage/);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('elsewhere, Electron keeps the setting for the command', () => {
  const calls: unknown[] = [];
  let on = false;
  const api: LoginItemApi = {
    getLoginItemSettings: ({ path }) => (calls.push(['get', path]), { openAtLogin: on }),
    setLoginItemSettings: (settings) => {
      calls.push(['set', settings]);
      on = settings.openAtLogin;
    },
  };
  const item = loginItem({ platform: 'win32', env: {}, execPath: 'C:\\Kainos\\kainos-talk.exe', isPackaged: true, appPath: '', api });
  item.set(true);
  assert.equal(item.enabled(), true);
  assert.deepEqual(calls, [['set', { openAtLogin: true, path: 'C:\\Kainos\\kainos-talk.exe' }], ['get', 'C:\\Kainos\\kainos-talk.exe']]);
});
