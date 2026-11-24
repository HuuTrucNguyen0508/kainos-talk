import { connect, type Socket } from 'node:net';
import { join } from 'node:path';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const workspaceName = (value: unknown) => (isRecord(value) && typeof value.name === 'string' ? value.name : undefined);

/**
 * The app's main window among `clients` (what Hyprland answers to j/clients): the one at `address`,
 * once known, else the window of process `pid` titled `title`. Its other windows (a popup, the
 * incoming-call window) are not it. The address outlives title changes (the unread count).
 */
export function mainWindow(clients: readonly unknown[], pid: number, title: string, address: string | undefined): Record<string, unknown> | undefined {
  const windows = clients.filter((client) => isRecord(client) && client.pid === pid) as Record<string, unknown>[];
  return windows.find((client) => address !== undefined && client.address === address) ?? windows.find((client) => client.title === title);
}

/**
 * Whether `window` is on a workspace a screen shows: its monitor's, or the special one open over
 * it. Undefined when its monitor is not in `monitors` (a screen unplugged between the two answers).
 */
export function onScreen(window: Record<string, unknown>, monitors: readonly unknown[]): boolean | undefined {
  if (window.mapped !== true || window.hidden === true) return false;
  const name = workspaceName(window.workspace);
  const monitor = monitors.find((m) => isRecord(m) && m.id === window.monitor);
  if (!isRecord(monitor)) return undefined;
  return name !== undefined && (name === workspaceName(monitor.activeWorkspace) || name === workspaceName(monitor.specialWorkspace));
}

/** Hyprland answers at once; one that does not is taken as no answer. */
const REQUEST_TIMEOUT_MS = 2_000;

export interface Hyprland {
  /** Asks Hyprland's request socket; `j/clients` and the like answer JSON. Undefined when no answer came. */
  ask(request: string): Promise<unknown>;
  /** Runs a dispatcher, written in Lua as Hyprland 0.57 takes them (`hl.dsp.window.float({...})`). */
  dispatch(lua: string): Promise<boolean>;
  /** Calls `listener` with each batch of event lines (`name>>data`) from the event socket. */
  onEvents(listener: (lines: readonly string[]) => void): void;
}

/** The event's name: what comes before `>>`. */
export const eventName = (line: string) => line.slice(0, line.indexOf('>>'));

/** Hyprland's sockets, when Kainos runs on Hyprland; undefined elsewhere. */
export function connectHyprland(): Hyprland | undefined {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!signature || !runtime) return undefined;
  const dir = join(runtime, 'hypr', signature);

  const send = (request: string) =>
    new Promise<string | undefined>((resolve) => {
      let answer = '';
      const socket = connect(join(dir, '.socket.sock'), () => socket.end(request));
      socket.setEncoding('utf8');
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
      socket.on('close', () => resolve(undefined));
      socket.on('data', (chunk: string) => (answer += chunk));
      socket.on('end', () => resolve(answer));
      socket.on('error', () => resolve(undefined));
    });
  const ask = async (request: string) => {
    const answer = await send(request);
    try {
      return answer === undefined ? undefined : (JSON.parse(answer) as unknown);
    } catch {
      return undefined;
    }
  };
  const dispatch = async (lua: string) => (await send(`dispatch ${lua}`))?.trim() === 'ok';

  const listeners: ((lines: readonly string[]) => void)[] = [];
  let events: Socket | undefined;
  const onEvents = (listener: (lines: readonly string[]) => void) => {
    listeners.push(listener);
    if (events) return;
    events = connect(join(dir, '.socket2.sock'));
    events.setEncoding('utf8');
    let buffer = '';
    events.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const each of listeners) each(lines);
    });
    events.on('error', (error) => console.warn('Hyprland events unavailable:', error.message));
  };
  return { ask, dispatch, onEvents };
}

/** Hyprland events after which a window may have come on screen or left it. */
const SHOWING_EVENTS = new Set(['workspace', 'workspacev2', 'activespecial', 'activespecialv2', 'movewindow', 'movewindowv2', 'openwindow', 'moveworkspace', 'moveworkspacev2']);

/**
 * On Hyprland (`hyprland` given), calls `onShown` each time the app's window, titled `title()`, comes onto a screen:
 * its special workspace opened, its workspace switched to, or the window moved or mapped there.
 * Elsewhere it does nothing. Wayland tells an app none of this; Hyprland's own sockets do.
 */
export function watchHyprland(hyprland: Hyprland | undefined, title: () => string, onShown: () => void): void {
  if (!hyprland) return;
  const { ask } = hyprland;

  /** Unknown until the first look, so a window already on screen at startup is not news. */
  let shown: boolean | undefined;
  let address: string | undefined;
  let looking = false;
  let again = false;
  async function look(): Promise<void> {
    if (looking) {
      again = true;
      return;
    }
    looking = true;
    do {
      again = false;
      const [clients, monitors] = await Promise.all([ask('j/clients'), ask('j/monitors')]);
      // An unreadable answer says nothing either way.
      if (!Array.isArray(clients) || !Array.isArray(monitors)) continue;
      const main = mainWindow(clients, process.pid, title(), address);
      // Not found: hidden to the tray (its 'show' event covers coming back), or its title changed.
      if (main === undefined) continue;
      address = typeof main.address === 'string' ? main.address : undefined;
      const now = onScreen(main, monitors);
      if (now === undefined) continue;
      if (shown === false && now) onShown();
      shown = now;
    } while (again);
    looking = false;
  }

  hyprland.onEvents((lines) => {
    // Hyprland may give a closed window's address to the next window.
    if (address !== undefined && lines.includes(`closewindow>>${address.replace(/^0x/, '')}`)) address = undefined;
    if (lines.some((line) => SHOWING_EVENTS.has(eventName(line)))) void look();
  });
  void look();
}
