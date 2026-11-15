import { execFile } from 'node:child_process';

/** The `boolean true|false` in `dbus-send --print-reply` output; undefined when there is none. */
export function dbusBoolean(stdout: string): boolean | undefined {
  const match = /\bboolean (true|false)\b/.exec(stdout);
  return match ? match[1] === 'true' : undefined;
}

function dbusSend(args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('dbus-send', ['--session', '--print-reply', ...args], { timeout: 2000 }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

/**
 * Whether a tray (a StatusNotifierItem host such as a panel or waybar) is running on this
 * Linux session. It asks the bus whether the watcher has an owner before talking to it, so the
 * check never starts a watcher. False when dbus-send is missing or anything fails.
 */
export async function trayHostPresent(): Promise<boolean> {
  const owned = await dbusSend(['--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher']);
  if (dbusBoolean(owned) !== true) return false;
  const host = await dbusSend([
    '--dest=org.kde.StatusNotifierWatcher',
    '/StatusNotifierWatcher',
    'org.freedesktop.DBus.Properties.Get',
    'string:org.kde.StatusNotifierWatcher',
    'string:IsStatusNotifierHostRegistered',
  ]);
  return dbusBoolean(host) === true;
}
