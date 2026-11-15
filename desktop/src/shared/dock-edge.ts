import { DOCK_HEIGHT } from './ipc.ts';

/**
 * Where the active page last saw the pointer: above the dock's band, in the band, against the
 * bottom edge, or gone out of the window through its bottom edge (into a compositor's gap).
 */
export type PagePointer = 'away' | 'band' | 'edge' | 'below';
export const PAGE_POINTERS: readonly PagePointer[] = ['away', 'band', 'edge', 'below'];

/** Within this many pixels of the bottom, the pointer is against the edge. */
const EDGE = 3;
/**
 * The pointer left the window through its bottom edge if the bottom is the nearest edge and
 * this close. Compositors with gaps (Hyprland) leave the pointer outside the window, and the
 * last position the page saw can be short of the edge when the pointer moves fast.
 */
const LEAVE_BOTTOM = 40;

/** Where a pointer inside the page is, `y` from the page's top. */
export function pointerZone(y: number, height: number): PagePointer {
  const fromBottom = height - y;
  return fromBottom <= EDGE ? 'edge' : fromBottom <= DOCK_HEIGHT ? 'band' : 'away';
}

/** Where a pointer that left the page went, from the last place the page saw it. */
export function exitZone(x: number, y: number, width: number, height: number): PagePointer {
  const fromBottom = height - y;
  const nearestOther = Math.min(x, width - x, y);
  return fromBottom <= LEAVE_BOTTOM && fromBottom <= nearestOther ? 'below' : 'away';
}

export function parsePagePointer(raw: unknown): PagePointer | undefined {
  return PAGE_POINTERS.find((zone) => zone === raw);
}
