// The PC's clipboard and the phone's. Text copied on the PC goes to the phone (unless the user
// turned that off, or a password manager marked it secret); text from the phone goes onto the PC's
// clipboard. Under Wayland, Electron cannot read or write the clipboard while its window lacks
// focus, so there the wl-clipboard tools do it; elsewhere Electron's clipboard is polled.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface ClipboardBackend {
  /** The text on the clipboard now; undefined when it holds no text, or text marked secret. */
  read(): Promise<string | undefined>;
  /** Calls back whenever the clipboard may have changed; returns the way to stop. */
  watch(onChange: () => void): () => void;
  write(text: string): Promise<void> | void;
}

export interface ClipboardSync {
  /** Text from the phone: onto the PC's clipboard, and never sent back. */
  apply(text: string): void;
  stop(): void;
}

export interface ClipboardSyncOptions {
  /** Sends text to the phone; false when it could not go. */
  readonly send: (text: string) => boolean;
  /** The user's "Send copied text to the phone". */
  readonly enabled: () => boolean;
}

/**
 * Sends each new clipboard text once. The text on the clipboard when it starts is not new, and
 * neither is text that came from the phone, so the two clipboards never echo.
 */
export async function startClipboardSync(backend: ClipboardBackend, { send, enabled }: ClipboardSyncOptions): Promise<ClipboardSync> {
  /** The text last seen on the clipboard or put there from the phone. */
  let last = await backend.read();
  /** Bumped by text from the phone, so a read that began before it cannot send the old text. */
  let generation = 0;
  let writing: Promise<void> | undefined;
  let stopped = false;
  let reading = false;
  let again = false;

  async function check(): Promise<void> {
    if (stopped || writing) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const started = generation;
        const text = await backend.read().catch(() => undefined);
        if (stopped || writing || started !== generation || text === undefined || text === last) continue;
        last = text;
        if (enabled()) send(text);
      } while (again && !writing && !stopped);
    } finally {
      reading = false;
    }
  }

  const unwatch = backend.watch(() => void check());
  return {
    apply(text) {
      generation++;
      const write = async () => {
        try {
          await backend.write(text);
          last = text;
        } catch (error) {
          console.warn('Clipboard: could not write', error);
        }
      };
      const pending = writing ? writing.then(write) : write();
      writing = pending;
      void pending.then(() => {
        if (writing !== pending) return;
        writing = undefined;
        void check();
      });
    },
    stop() {
      stopped = true;
      unwatch();
    },
  };
}

/** The type to read text as, from what the copying app offers; UTF-8 first. */
export function textType(types: readonly string[]): string | undefined {
  return ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'TEXT', 'STRING'].find((type) => types.includes(type));
}

/** KDE's convention, which KeePassXC and other password managers follow. */
export const SECRET_HINT = 'x-kde-passwordManagerHint';

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

/** wl-paste and wl-copy, through the compositor's data-control protocol: no window focus needed. */
export function waylandClipboard(): ClipboardBackend {
  return {
    async read() {
      const offered = await run('wl-paste', ['--list-types']).catch(() => '');
      const types = offered.split('\n');
      const type = textType(types);
      if (!type) return undefined;
      const isPublic = async () => {
        if (!types.includes(SECRET_HINT)) return true;
        const hint = await run('wl-paste', ['--no-newline', '--type', SECRET_HINT]).catch(() => undefined);
        return hint !== undefined && hint.trim() !== 'secret';
      };
      if (!(await isPublic())) return undefined;
      const text = await run('wl-paste', ['--no-newline', '--type', type]).catch(() => '');
      if (!text || (await run('wl-paste', ['--list-types']).catch(() => '')) !== offered) return undefined;
      return (await isPublic()) ? text : undefined;
    },
    watch(onChange) {
      let stopped = false;
      let child: ChildProcess | undefined;
      let retry: NodeJS.Timeout | undefined;
      const start = () => {
        // wl-paste pipes each new selection into the command, which drops it and prints a line.
        child = spawn('wl-paste', ['--watch', 'sh', '-c', 'cat >/dev/null; echo'], { stdio: ['ignore', 'pipe', 'ignore'] });
        createInterface({ input: child.stdout! }).on('line', onChange);
        child.on('error', () => undefined);
        child.on('exit', () => {
          // The compositor went away or restarted: watch again once it may be back.
          if (!stopped) retry = setTimeout(start, 5000);
        });
      };
      start();
      return () => {
        stopped = true;
        clearTimeout(retry);
        child?.kill();
      };
    },
    write(text) {
      // wl-copy stays behind to serve the text; with pipes of ours open it would keep this process waiting.
      return new Promise<void>((resolve, reject) => {
        const child = spawn('wl-copy', ['--type', 'text/plain;charset=utf-8'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`wl-copy exited with code ${code}`)));
        child.stdin.on('error', reject);
        child.stdin.end(text);
      });
    },
  };
}

/** What polling needs of Electron's clipboard, which is asynchronous since Electron 45. */
export interface TextClipboard {
  has(format: string): Promise<boolean>;
  readText(): Promise<string> | string;
  writeText(text: string): Promise<void> | void;
}

/** Electron's clipboard, read once a second. */
export function polledClipboard(clipboard: TextClipboard, everyMs = 1000, platform = process.platform): ClipboardBackend {
  const marker = platform === 'linux' ? SECRET_HINT : platform === 'win32' ? 'ExcludeClipboardContentFromMonitorProcessing' : undefined;
  const isPrivate = () => marker !== undefined && clipboard.has(`electron application/osclipboard;format="${marker}"`);
  return {
    async read() {
      try {
        if (await isPrivate()) return undefined;
        const text = await clipboard.readText();
        return text && !(await isPrivate()) ? text : undefined;
      } catch {
        return undefined;
      }
    },
    watch(onChange) {
      const timer = setInterval(onChange, everyMs);
      return () => clearInterval(timer);
    },
    write: (text) => clipboard.writeText(text),
  };
}

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** wl-clipboard on a Wayland session that has it; Electron's clipboard everywhere else. */
export function systemClipboard(clipboard: TextClipboard): ClipboardBackend {
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    if (onPath('wl-paste') && onPath('wl-copy')) return waylandClipboard();
    console.info('Clipboard: wl-clipboard is not installed, so only text copied while Kainos Talk has focus reaches the phone');
  }
  return polledClipboard(clipboard);
}
