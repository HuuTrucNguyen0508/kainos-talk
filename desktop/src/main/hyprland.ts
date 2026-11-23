import { connect } from 'node:net';
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

/** Hyprland events after which a window may have come on screen or left it. */
const SHOWING_EVENTS = new Set(['workspace', 'workspacev2', 'activespecial', 'activespecialv2', 'movewindow', 'movewindowv2', 'openwindow', 'moveworkspace', 'moveworkspacev2']);

/**
 * On Hyprland, calls `onShown` each time the app's window, titled `title()`, comes onto a screen:
 * its special workspace opened, its workspace switched to, or the window moved or mapped there.
 * Elsewhere it does nothing. Wayland tells an app none of this; Hyprland's own sockets do.
 */
export function watchHyprland(title: () => string, onShown: () => void): void {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!signature || !runtime) return;
  const dir = join(runtime, 'hypr', signature);

  const ask = (request: string) =>
    new Promise<unknown>((resolve) => {
      let answer = '';
      const socket = connect(join(dir, '.socket.sock'), () => socket.end(request));
      socket.setEncoding('utf8');
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
      socket.on('close', () => resolve(undefined));
      socket.on('data', (chunk: string) => (answer += chunk));
      socket.on('end', () => {
        try {
          resolve(JSON.parse(answer));
        } catch {
          resolve(undefined);
        }
      });
      socket.on('error', () => resolve(undefined));
    });

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

  const events = connect(join(dir, '.socket2.sock'));
  events.setEncoding('utf8');
  let buffer = '';
  events.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    // Hyprland may give a closed window's address to the next window.
    if (address !== undefined && lines.includes(`closewindow>>${address.replace(/^0x/, '')}`)) address = undefined;
    if (lines.some((line) => SHOWING_EVENTS.has(line.slice(0, line.indexOf('>>'))))) void look();
  });
  events.on('error', (error) => console.warn('Hyprland events unavailable:', error.message));
  void look();
}
