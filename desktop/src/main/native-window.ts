import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { NativeApp } from '../shared/services.ts';
import type { NativeAppState } from '../shared/native-app.ts';
import type { Rect } from './app-state.ts';
import { eventName, mainWindow, type Hyprland } from './hyprland.ts';

/** Where the app's window waits while its tab is not on screen. */
export const AWAY_WORKSPACE = 'special:kainos';

/** A start that shows no window by then has failed or was refused. */
const START_TIMEOUT_MS = 30_000;
/** While Kainos floats, Hyprland says nothing when it is dragged: look this often instead. */
const FLOATING_CHECK_MS = 500;

/** Hyprland events after which Kainos' window or the app's may have moved, changed or gone. */
const PLACING_EVENTS = new Set([
  'openwindow',
  'closewindow',
  'movewindow',
  'movewindowv2',
  'changefloatingmode',
  'fullscreen',
  'workspace',
  'workspacev2',
  'activespecial',
  'activespecialv2',
  'moveworkspace',
  'moveworkspacev2',
  'monitoradded',
  'monitoraddedv2',
  'monitorremoved',
  'monitorremovedv2',
  'activewindowv2',
]);

type Client = Record<string, unknown>;
const isRecord = (value: unknown): value is Client => typeof value === 'object' && value !== null;
const pair = (value: unknown): readonly [number, number] | undefined =>
  Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number' ? [value[0], value[1]] : undefined;
const workspaceOf = (client: Client) => (isRecord(client.workspace) && typeof client.workspace.name === 'string' ? client.workspace.name : undefined);

/**
 * The app's main window among Hyprland's `clients`: the one at `address` while it lasts, else one
 * of its class that opened with its main title. A message being written or a dialog never is.
 */
export function appWindow(clients: readonly unknown[], app: NativeApp, address: string | undefined): Client | undefined {
  const windows = clients.filter((client): client is Client => isRecord(client) && client.class === app.windowClass);
  return windows.find((client) => address !== undefined && client.address === address) ?? windows.find((client) => client.initialTitle === app.mainTitle);
}

/**
 * Where the app's window goes, in Hyprland's layout coordinates: the tab's `area` (in the
 * content's coordinates) on Kainos' window at `at` and `size`. The content fills the window's
 * width and ends at its bottom; any frame Electron draws sits above it.
 */
export function targetRect(at: readonly [number, number], size: readonly [number, number], content: { readonly width: number; readonly height: number }, area: Rect): Rect {
  const top = Math.max(0, size[1] - content.height);
  const left = Math.max(0, Math.round((size[0] - content.width) / 2));
  return { x: at[0] + left + area.x, y: at[1] + top + area.y, width: area.width, height: area.height };
}

/** Whether the app's window already sits exactly on `rect`. */
export function sitsOn(client: Client, rect: Rect): boolean {
  const at = pair(client.at);
  const size = pair(client.size);
  return at !== undefined && size !== undefined && at[0] === rect.x && at[1] === rect.y && size[0] === rect.width && size[1] === rect.height;
}

/** A Lua string literal, for a dispatcher's argument. */
export function luaString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')}"`;
}

/** The command as one line for a shell, each argument quoted unless it is plain. */
export function shellLine(command: readonly string[]): string {
  return command.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The program's path on the PATH, or undefined when it is not installed there. */
export function findProgram(program: string, path = process.env.PATH ?? '', extensions: readonly string[] = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']): string | undefined {
  const candidates = isAbsolute(program) ? [program] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, program));
  for (const base of candidates) {
    for (const extension of extensions) {
      try {
        accessSync(base + extension, constants.X_OK);
        return base + extension;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

export interface NativeWindowOptions {
  readonly app: NativeApp;
  /** Hyprland's sockets; without them the app opens as a window of its own. */
  readonly hyprland: Hyprland | undefined;
  /** Kainos' own window, to find it among Hyprland's. */
  readonly title: () => string;
  /** The tab's state changed: its page shows it. */
  readonly onChange: () => void;
}

/** Where the tab is now: its place in the window's content, or undefined while it is not on screen. */
export interface NativePlace {
  readonly area: Rect | undefined;
  readonly content: { readonly width: number; readonly height: number };
}

export interface NativeWindow {
  state(): NativeAppState;
  /**
   * Whether the app has its tab (on, and not hidden from the dock). Only then does Kainos move
   * its window; turned off, the window becomes an ordinary one again.
   */
  setEnabled(enabled: boolean): void;
  /** Kainos laid out: the app's window follows the tab, or leaves while the tab is not on screen. */
  place(place: NativePlace): void;
  /** Starts the app, or brings its window back over the tab. */
  open(): void;
  /** Starts the app out of sight, unless it runs already or has no tab. */
  startInBackground(): void;
  /** Gives the app's window keyboard focus, when it sits over the tab. */
  focus(): void;
  /** Kainos is quitting: the app's window becomes an ordinary one again, on Kainos' workspace. */
  release(): Promise<void>;
}

/**
 * Keeps a desktop app's own window over its Kainos tab on Hyprland. Electron cannot hold
 * another program's window, so the window floats, without border or rounding, on exactly the
 * tab's place, follows Kainos' window as it moves or changes workspace, and waits on a hidden
 * special workspace while another tab is open. Elsewhere the app simply opens beside Kainos.
 */
export function createNativeWindow(options: NativeWindowOptions): NativeWindow {
  const { app, hyprland } = options;
  let state: NativeAppState = hyprland ? { kind: 'closed' } : { kind: 'separate' };
  let wanted: NativePlace = { area: undefined, content: { width: 0, height: 0 } };
  /** The app's window once found; Kainos takes it over for the tab from then on. */
  let address: string | undefined;
  let kainosAddress: string | undefined;
  /** When Kainos last started the app, to tell a slow start from a failed one. */
  let startedAt: number | undefined;
  /** Windows whose border, rounding and shadow are already off. */
  const bare = new Set<string>();
  let focusWanted = false;
  let enabled = false;
  let floatingTimer: NodeJS.Timeout | undefined;

  const setState = (next: NativeAppState) => {
    if (next.kind === state.kind) return;
    state = next;
    options.onChange();
  };

  function start(): void {
    const program = app.command[0];
    if (program === undefined || findProgram(program) === undefined) {
      setState({ kind: 'missing' });
      return;
    }
    startedAt = Date.now();
    if (!hyprland) {
      // Its own process group, so it outlives Kainos.
      spawn(program, app.command.slice(1), { detached: true, stdio: 'ignore' }).on('error', () => setState({ kind: 'missing' })).unref();
      return;
    }
    // Hyprland starts it, so it belongs to the session rather than to Kainos, and maps it
    // straight onto the hidden workspace: it never flashes on screen before it is placed.
    const rules = `{ workspace = ${luaString(`${AWAY_WORKSPACE} silent`)}, float = true }`;
    void hyprland.dispatch(`hl.dsp.exec_cmd(${luaString(shellLine(app.command))}, ${rules})`);
    setState({ kind: 'starting' });
    setTimeout(() => void fit(), START_TIMEOUT_MS + 100);
  }

  /** A hl.dsp.window dispatcher aimed at the app's window. */
  const onApp = (name: string, fields: string) => `hl.dsp.window.${name}({ ${fields}, window = ${luaString(`address:${address}`)} })`;
  /** Several dispatchers in one request, so Hyprland applies them in one go. */
  const batch = (dispatchers: readonly string[]) => hyprland!.dispatch(`function() ${dispatchers.map((d) => `hl.dispatch(${d})`).join('; ')} end`);

  /** The look under way; a change meanwhile makes it look again before it settles. */
  let fitting: Promise<void> | undefined;
  let again = false;
  /** Brings the app's window in line with where the tab is. Settles once the app's state is known. */
  function fit(): Promise<void> {
    if (!hyprland || !enabled) return Promise.resolve();
    if (fitting) {
      again = true;
      return fitting;
    }
    const hypr = hyprland;
    fitting = (async () => {
      do {
        again = false;
        if (enabled) await fitOnce(hypr);
      } while (again);
    })().finally(() => {
      fitting = undefined;
    });
    return fitting;
  }

  async function fitOnce(hypr: Hyprland): Promise<void> {
    const clients = await hypr.ask('j/clients');
    if (!Array.isArray(clients)) return;
    const window = appWindow(clients, app, address);
    const kainos = mainWindow(clients, process.pid, options.title(), kainosAddress);
    kainosAddress = typeof kainos?.address === 'string' ? kainos.address : kainosAddress;
    watchFloating(kainos?.floating === true && wanted.area !== undefined);
    if (!window) {
      if (address !== undefined) bare.delete(address);
      address = undefined;
      const starting = startedAt !== undefined && Date.now() - startedAt < START_TIMEOUT_MS;
      setState(starting ? { kind: 'starting' } : { kind: 'closed' });
      return;
    }
    address = typeof window.address === 'string' ? window.address : undefined;
    if (address === undefined) return;
    startedAt = undefined;
    setState({ kind: 'placed' });

    const at = kainos && pair(kainos.at);
    const size = kainos && pair(kainos.size);
    const workspace = kainos && workspaceOf(kainos);
    const onScreen = kainos !== undefined && kainos.mapped === true && kainos.hidden !== true;
    const steps: string[] = [];
    if (wanted.area && wanted.area.width > 0 && wanted.area.height > 0 && onScreen && at && size && workspace) {
      const rect = targetRect(at, size, wanted.content, wanted.area);
      if (window.floating !== true) steps.push(onApp('float', 'action = "enable"'));
      if (!bare.has(address)) {
        bare.add(address);
        steps.push(
          onApp('set_prop', 'prop = "border_size", value = "0"'),
          onApp('set_prop', 'prop = "rounding", value = "0"'),
          onApp('set_prop', 'prop = "no_shadow", value = "true"'),
        );
      }
      if (workspaceOf(window) !== workspace) steps.push(onApp('move', `workspace = ${luaString(workspace)}, follow = false`));
      // Resizing a floating window re-centres it, so it moves after.
      if (!sitsOn(window, rect) || steps.length > 0) {
        steps.push(
          onApp('resize', `x = ${rect.width}, y = ${rect.height}, relative = false`),
          onApp('move', `x = ${rect.x}, y = ${rect.y}, relative = false`),
        );
      }
      // Over Kainos' window even when that one floats and was just clicked.
      steps.push(onApp('alter_zorder', 'mode = "top"'));
      if (focusWanted) {
        focusWanted = false;
        steps.push(`hl.dsp.focus({ window = ${luaString(`address:${address}`)} })`);
      }
    } else if (workspaceOf(window) !== AWAY_WORKSPACE) {
      steps.push(onApp('move', `workspace = ${luaString(AWAY_WORKSPACE)}, follow = false`));
    }
    // Turned off while Hyprland answered: the window is no longer Kainos' to move.
    if (steps.length > 0 && enabled) await batch(steps);
  }

  /** Hyprland reports no drag of a floating window, so while Kainos floats with the tab open, look often. */
  function watchFloating(on: boolean): void {
    if (on && !floatingTimer) floatingTimer = setInterval(() => void fit(), FLOATING_CHECK_MS);
    if (!on && floatingTimer) {
      clearInterval(floatingTimer);
      floatingTimer = undefined;
    }
  }

  /** The app's window back to an ordinary one, on Kainos' workspace. */
  async function release(): Promise<void> {
    watchFloating(false);
    if (!hyprland || address === undefined) return;
    const clients = await hyprland.ask('j/clients');
    if (!Array.isArray(clients)) return;
    const window = appWindow(clients, app, address);
    if (!window) return;
    const kainos = mainWindow(clients, process.pid, options.title(), kainosAddress);
    const workspace = (kainos && workspaceOf(kainos)) ?? 'e+0';
    await batch([
      onApp('move', `workspace = ${luaString(workspace)}, follow = false`),
      onApp('float', 'action = "disable"'),
      onApp('set_prop', 'prop = "border_size", value = "unset"'),
      onApp('set_prop', 'prop = "rounding", value = "unset"'),
      onApp('set_prop', 'prop = "no_shadow", value = "unset"'),
    ]);
    bare.delete(address);
    address = undefined;
  }

  hyprland?.onEvents((lines) => {
    // Only Kainos' own focus changes matter among focus events: the app goes back on top.
    const relevant = lines.some((line) => {
      const name = eventName(line);
      if (name !== 'activewindowv2') return PLACING_EVENTS.has(name);
      return kainosAddress !== undefined && line === `activewindowv2>>${kainosAddress.replace(/^0x/, '')}`;
    });
    if (relevant) void fit();
  });
  return {
    state: () => state,
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      if (enabled) void fit();
      else void release();
    },
    place(place) {
      const before = JSON.stringify(wanted);
      wanted = place;
      if (JSON.stringify(wanted) !== before) void fit();
    },
    open() {
      if (state.kind === 'placed') {
        focusWanted = true;
        void fit();
      } else if (state.kind !== 'starting') {
        focusWanted = true;
        start();
      }
    },
    startInBackground() {
      if (!hyprland || !enabled) return;
      void (async () => {
        await fit();
        if (enabled && state.kind === 'closed') start();
      })();
    },
    focus() {
      if (state.kind !== 'placed') return;
      focusWanted = true;
      void fit();
    },
    async release() {
      enabled = false;
      await release();
    },
  };
}
