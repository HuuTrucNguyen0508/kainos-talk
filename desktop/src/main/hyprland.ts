import type { Rect } from './app-state.ts';

/** Untrusted JSON from Hyprland's socket: read only the fields we need, defensively. */
function records(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [];
}
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The monitor id our main window is on, from `hyprctl clients -j`. Popups belong to the same
 * process, so a client whose title ends with the window title wins; the title may carry an
 * unread prefix such as "(3) ".
 */
export function hyprWindowMonitor(clients: unknown, pid: number, title: string): number | undefined {
  const ours = records(clients).filter((client) => client.pid === pid && client.mapped !== false && client.hidden !== true && num(client.monitor));
  const main = ours.find((client) => typeof client.title === 'string' && client.title === title) ?? ours.find((client) => typeof client.title === 'string' && client.title.endsWith('Kainos Talk'));
  const pick = main ?? (ours.length === 1 ? ours[0] : undefined);
  return pick ? (pick.monitor as number) : undefined;
}

/**
 * Monitor rectangles in layout coordinates, from `hyprctl monitors -j`. Width and height are
 * in pixels before scaling and rotation, so a rotated monitor swaps them.
 */
export function hyprMonitorRects(monitors: unknown): Map<number, Rect> {
  const rects = new Map<number, Rect>();
  for (const monitor of records(monitors)) {
    const { id, x, y, width, height } = monitor;
    if (![id, x, y, width, height].every(num)) continue;
    const scale = num(monitor.scale) && monitor.scale > 0 ? monitor.scale : 1;
    const rotated = num(monitor.transform) && monitor.transform % 2 === 1;
    const w = Math.round((width as number) / scale);
    const h = Math.round((height as number) / scale);
    rects.set(id as number, { x: x as number, y: y as number, width: rotated ? h : w, height: rotated ? w : h });
  }
  return rects;
}
