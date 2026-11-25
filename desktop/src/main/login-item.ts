import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Turns starting Kainos Talk at login on and off; the OS keeps the setting, not the app state. */
export interface LoginItem {
  enabled(): boolean;
  set(on: boolean): void;
}

/** What Electron offers for login items; it does nothing on Linux. */
export interface LoginItemApi {
  getLoginItemSettings(options: { path: string }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; path: string }): void;
}

export interface LoginItemContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly isPackaged: boolean;
  /** The `desktop` folder when running from a checkout. */
  readonly appPath: string;
  readonly api: LoginItemApi;
}

/**
 * What to run at login: the AppImage itself (not its temporary mount), the portable .exe (not its
 * unpacked copy), the installed binary, or the checkout's bin/kainos-talk launcher.
 */
export function launchCommand(context: Pick<LoginItemContext, 'platform' | 'env' | 'execPath' | 'isPackaged' | 'appPath'>): string {
  const { env } = context;
  if (context.platform === 'linux' && env.APPIMAGE) return env.APPIMAGE;
  if (context.platform === 'win32' && env.PORTABLE_EXECUTABLE_FILE) return env.PORTABLE_EXECUTABLE_FILE;
  if (context.isPackaged || context.platform !== 'linux') return context.execPath;
  return join(context.appPath, 'bin', 'kainos-talk');
}

/** One Exec argument, quoted and escaped as the Desktop Entry spec asks. */
export function execArgument(path: string): string {
  const quoted = `"${path.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
  // The value is a string too: its backslashes are escaped again, and % is a field code.
  return quoted.replaceAll('\\', '\\\\').replaceAll('%', '%%');
}

export function autostartEntry(command: string): string {
  return `[Desktop Entry]
Type=Application
Name=Kainos Talk
Comment=Starts Kainos Talk when you log in, so your phone can reach this PC
Exec=${execArgument(command)}
Icon=kainos-talk
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

/** The XDG autostart entry, which GNOME, KDE and most desktops start at login. */
export function autostartFile(env: NodeJS.ProcessEnv, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', 'kainos-talk.desktop');
}

export function loginItem(context: LoginItemContext): LoginItem {
  const command = launchCommand(context);
  if (context.platform !== 'linux') {
    return {
      enabled: () => context.api.getLoginItemSettings({ path: command }).openAtLogin,
      set: (on) => context.api.setLoginItemSettings({ openAtLogin: on, path: command }),
    };
  }
  const file = autostartFile(context.env);
  const entry = autostartEntry(command);
  // A new AppImage has a new name: an entry left by the old one is pointed at this one.
  try {
    if (context.env.APPIMAGE && existsSync(file) && readFileSync(file, 'utf8') !== entry) writeFileSync(file, entry);
  } catch (error) {
    console.warn('could not update the autostart entry', error);
  }
  return {
    enabled: () => existsSync(file),
    set: (on) => {
      if (!on) return rmSync(file, { force: true });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entry);
    },
  };
}
