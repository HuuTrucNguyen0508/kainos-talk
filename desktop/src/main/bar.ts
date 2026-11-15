import type { Rect } from './app-state.ts';
import { RAIL_WIDTH, type BarSide } from '../shared/ipc.ts';

/** What the user picked for the bar's side: follow the screen, or always one side. */
export type SidePreference = 'auto' | BarSide;

export const SIDE_PREFERENCES: readonly SidePreference[] = ['auto', 'left', 'right'];

function overlapsVertically(a: Rect, b: Rect): boolean {
  return Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

/**
 * The bar goes on the screen's outer edge, where the pointer stops against the edge of the
 * desktop instead of sliding onto the next screen. On a screen with a neighbour only to its
 * right that is the left edge, and the other way round. A lone screen, or one with neighbours
 * on both sides, keeps the left edge.
 */
export function outerSide(current: Rect, displays: readonly Rect[]): BarSide {
  const others = displays.filter((d) => !(d.x === current.x && d.y === current.y && d.width === current.width && d.height === current.height));
  const beside = others.filter((d) => overlapsVertically(d, current));
  const right = beside.some((d) => d.x >= current.x + current.width - 1);
  const left = beside.some((d) => d.x + d.width <= current.x + 1);
  return left && !right ? 'right' : 'left';
}

export function resolveSide(preference: SidePreference, screenSide: BarSide): BarSide {
  return preference === 'auto' ? screenSide : preference;
}

export interface BarLayoutInput {
  /** Window content size. */
  readonly width: number;
  readonly height: number;
  readonly side: BarSide;
  readonly autoHide: boolean;
  /** Auto-hide only: the pointer or keyboard focus brought the bar out. */
  readonly revealed: boolean;
  /** The active service's page is on screen (loaded and not failed). */
  readonly activeReady: boolean;
  /** The active page is in HTML fullscreen, so it covers everything. */
  readonly activeFullscreen: boolean;
}

export interface BarLayout {
  /** Where the sidebar page sits, on top of the service; undefined hides it. */
  readonly chrome: Rect | undefined;
  /** Where the active service page sits. */
  readonly service: Rect;
}

/**
 * Places the sidebar page and the active service. The sidebar page sits above the service:
 * the whole window while the service is loading or failed (it shows why), a strip on the bar's
 * side otherwise. A docked bar takes its strip from the page; an auto-hidden one covers the
 * page's edge only while it is revealed.
 */
export function layoutBar(input: BarLayoutInput): BarLayout {
  const { width, height, side } = input;
  const full = { x: 0, y: 0, width, height };
  if (!input.activeReady) return { chrome: full, service: full };
  if (input.activeFullscreen) return { chrome: undefined, service: full };
  const rail = Math.min(RAIL_WIDTH, width);
  const strip = { x: side === 'left' ? 0 : width - rail, y: 0, width: rail, height };
  if (input.autoHide) return { chrome: input.revealed ? strip : undefined, service: full };
  return { chrome: strip, service: { x: side === 'left' ? rail : 0, y: 0, width: width - rail, height } };
}

/** Where a service page last saw the pointer: against one of its side edges, or inside. */
export type PointerEdge = BarSide | 'inside';

export function parsePointerEdge(raw: unknown): PointerEdge | undefined {
  return raw === 'left' || raw === 'right' || raw === 'inside' ? raw : undefined;
}
