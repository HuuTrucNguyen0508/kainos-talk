import type { Rect } from './app-state.ts';
import { DOCK_FLOAT, DOCK_HEIGHT, type DockFrame, type DockSize } from '../shared/ipc.ts';

export interface BarLayoutInput {
  /** Window content size. */
  readonly width: number;
  readonly height: number;
  /** The active service's page is on screen (loaded and not failed). */
  readonly activeReady: boolean;
  /** The active page is in HTML fullscreen, so it covers everything. */
  readonly activeFullscreen: boolean;
  /** Always show the dock: it keeps a reserved strip and the page ends above it. */
  readonly pinned: boolean;
  /** Auto-hide only: the dock is on screen (shown, or sliding away). */
  readonly onScreen: boolean;
  /** The centred group of islands as the dock page measured it; undefined until it reports. */
  readonly group: DockSize | undefined;
}

export interface BarLayout {
  /** Where the dock page sits; undefined hides it. */
  readonly chrome: Rect | undefined;
  /** Where the active service page sits. */
  readonly service: Rect;
  readonly frame: DockFrame['kind'];
}

/**
 * Places the dock page and the active service. By default the page fills the window and the
 * dock floats over its bottom edge only while it is on screen, its view no bigger than the
 * centred group and its shadow, so the rest of the page keeps its clicks. Always shown, the
 * window is two rows instead: the page, then the dock's strip. While the service is loading or
 * failed the dock page covers the whole window to show why; a page in HTML fullscreen covers
 * everything.
 */
export function layoutBar(input: BarLayoutInput): BarLayout {
  const { width, height } = input;
  const full = { x: 0, y: 0, width, height };
  if (!input.activeReady) return { chrome: full, service: full, frame: 'cover' };
  const frame = input.pinned ? 'strip' : 'float';
  if (input.activeFullscreen) return { chrome: undefined, service: full, frame };
  if (input.pinned) {
    const dock = Math.min(DOCK_HEIGHT, height);
    return { chrome: { x: 0, y: height - dock, width, height: dock }, service: { x: 0, y: 0, width, height: height - dock }, frame };
  }
  if (!input.onScreen) return { chrome: undefined, service: full, frame };
  // Until then, the whole width at an island's height (styles.css .island).
  const group = input.group ?? { width, height: 40 };
  const w = Math.min(width, group.width + 2 * DOCK_FLOAT.margin);
  const h = Math.min(height, group.height + DOCK_FLOAT.margin + DOCK_FLOAT.bottom);
  return { chrome: { x: Math.floor((width - w) / 2), y: height - h, width: w, height: h }, service: full, frame };
}
