import { screen, type BaseWindow } from 'electron';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { BarSide } from '../shared/ipc.ts';
import { outerSide } from './bar.ts';
import { hyprMonitorRects, hyprWindowMonitor } from './hyprland.ts';

/**
 * Keeps track of which side is the outer edge of the screen the window is on, and calls
 * `onChange` when it changes. On Hyprland, a Wayland compositor that never tells a window
 * where it is, the compositor's own socket answers; elsewhere Electron's window bounds do.
 */
export function watchScreenSide(win: BaseWindow, onChange: (side: BarSide) => void): () => BarSide {
  let side: BarSide = 'left';
  let timer: NodeJS.Timeout | undefined;
  const set = (next: BarSide | undefined) => {
    if (!next || next === side) return;
    side = next;
    onChange(side);
  };
  const fromElectron = (): BarSide => {
    const displays = screen.getAllDisplays().map((display) => display.bounds);
    return outerSide(screen.getDisplayMatching(win.getBounds()).bounds, displays);
  };

  const hypr = hyprlandSockets();
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed()) return;
      if (!hypr) return set(fromElectron());
      void hyprSide(hypr.request, win.getTitle()).then(set, () => set(fromElectron()));
    }, 150);
  };

  if (hypr) {
    // Window moves, workspace moves and monitor changes all arrive on the event socket.
    const events = connect(hypr.events);
    events.on('error', () => undefined);
    let buffered = '';
    events.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      if (lines.some((line) => HYPR_EVENTS.has(line.slice(0, line.indexOf('>>'))))) refresh();
    });
    win.once('closed', () => events.destroy());
  } else {
    win.on('move', refresh);
  }
  win.on('show', refresh);
  win.on('focus', refresh);
  screen.on('display-added', refresh);
  screen.on('display-removed', refresh);
  screen.on('display-metrics-changed', refresh);
  refresh();
  return () => side;
}

const HYPR_EVENTS = new Set([
  'movewindow',
  'movewindowv2',
  'moveworkspace',
  'moveworkspacev2',
  'workspace',
  'workspacev2',
  'focusedmon',
  'focusedmonv2',
  'monitoradded',
  'monitoraddedv2',
  'monitorremoved',
  'monitorremovedv2',
  'openwindow',
  'changefloatingmode',
]);

interface HyprSockets {
  readonly events: string;
  readonly request: (command: string) => Promise<string>;
}

function hyprlandSockets(): HyprSockets | undefined {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!signature || !process.env.WAYLAND_DISPLAY) return undefined;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const dir = [runtime && join(runtime, 'hypr', signature), join('/tmp/hypr', signature)].find(
    (candidate): candidate is string => Boolean(candidate) && existsSync(join(candidate as string, '.socket.sock')),
  );
  if (!dir) return undefined;
  const request = (command: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(join(dir, '.socket.sock'));
      let reply = '';
      socket.setTimeout(2000, () => socket.destroy(new Error('hyprland socket timed out')));
      socket.on('connect', () => socket.write(command));
      socket.on('data', (chunk) => (reply += chunk.toString()));
      socket.on('end', () => resolve(reply));
      socket.on('error', reject);
    });
  return { events: join(dir, '.socket2.sock'), request };
}

async function hyprSide(request: (command: string) => Promise<string>, title: string): Promise<BarSide | undefined> {
  const [clients, monitors] = await Promise.all([request('j/clients'), request('j/monitors')]);
  const monitorId = hyprWindowMonitor(JSON.parse(clients), process.pid, title);
  if (monitorId === undefined) return undefined;
  const rects = hyprMonitorRects(JSON.parse(monitors));
  const current = rects.get(monitorId);
  return current ? outerSide(current, [...rects.values()]) : undefined;
}
