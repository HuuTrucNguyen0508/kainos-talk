import type { Unread } from './unread.ts';

/** IPC channel names shared by main and both preloads. */
export const Channel = {
  getSnapshot: 'kainos:get-snapshot',
  snapshot: 'kainos:snapshot',
  activate: 'kainos:activate',
  retry: 'kainos:retry',
  openServiceMenu: 'kainos:open-service-menu',
  notificationShow: 'kainos:notification-show',
  notificationClose: 'kainos:notification-close',
  notificationClick: 'kainos:notification-click',
  /** Service preload to main: what the page's own unread counter says. */
  unreadCounter: 'kainos:unread-counter',
  /** Main to the dock: put keyboard focus on the active service's tab. */
  focusDock: 'kainos:focus-dock',
  /** Dock to main: open the dock options menu. */
  openBarMenu: 'kainos:open-bar-menu',
  /** Dock to main: open the phone island's menu (Open Texts, Forget this phone). */
  openPhoneMenu: 'kainos:open-phone-menu',
  /** Main to the dock: how the dock page is placed (DockFrame). */
  dockFrame: 'kainos:dock-frame',
  /** Dock to main: the size of the centred group of islands (DockSize). */
  dockSize: 'kainos:dock-size',
  /** Dock to main: the pointer came onto the dock page (true) or left it (false). */
  dockPointer: 'kainos:dock-pointer',
  /** Dock to main: keyboard focus came into the dock (true) or left it (false). */
  dockKeyboard: 'kainos:dock-keyboard',
  /** Dock to main: Escape in the dock; back to the page. */
  dismissDock: 'kainos:dismiss-dock',
  /** Service and inbox pages to main: where the pointer is against the bottom edge (PagePointer). */
  pagePointer: 'kainos:page-pointer',
  /** Main to an activated page: forget deduplication so its next trusted movement reports again. */
  resetPagePointer: 'kainos:reset-page-pointer',
  /** Kainos' own pages (dock, Texts) to main: the theme choice now (ThemeChoice). */
  getTheme: 'kainos:get-theme',
  /** Main to Kainos' own pages: the theme choice changed (ThemeChoice). */
  theme: 'kainos:theme',
  /** Dock to main: move a service to a place among the dock's tabs (id, index from parseDockIndex). */
  moveService: 'kainos:move-service',
  /** Dock to main: a tab drag started (true) or ended (false). */
  dockDrag: 'kainos:dock-drag',
} as const;

/** The dock's reserved strip along the bottom of the window, in pixels, when it is always shown. */
export const DOCK_HEIGHT = 64;

/**
 * The auto-hiding dock floats over the page. Its view is the centred group plus this much
 * transparent room: `margin` on the sides and above for the islands' shadow, `bottom` below.
 */
export const DOCK_FLOAT = { margin: 16, bottom: 8 } as const;

/**
 * How main places the dock page. `cover`: the whole window, a notice above the strip (the
 * active service is loading or failed). `strip`: the always-shown strip. `float`: the group
 * alone over the page, `raised` while shown and sliding away otherwise. `room` is the
 * window's width, which the group may not exceed.
 */
export interface DockFrame {
  readonly kind: 'cover' | 'strip' | 'float';
  readonly raised: boolean;
  readonly room: number;
}

export interface DockSize {
  readonly width: number;
  readonly height: number;
}

/** The dock page's measured group is untrusted input: a sane positive size, rounded up. */
export function parseDockSize(raw: unknown): DockSize | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { width, height } = raw as Record<string, unknown>;
  const ok = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max;
  return ok(width, 100_000) && ok(height, DOCK_HEIGHT * 4) ? { width: Math.ceil(width), height: Math.ceil(height) } : undefined;
}

export type ServiceStatus =
  /** Its page is closed to free memory; opening its tab wakes it. */
  | { readonly kind: 'hibernated' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly reason: string; readonly host: string };

/** Everything the dock needs to draw one service. */
export interface ServiceSnapshot {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly glyph: string;
  readonly paint: 'stroke' | 'fill';
  /** The website's host, for the loading screen; empty for Kainos' own pages. */
  readonly host: string;
  readonly status: ServiceStatus;
  readonly unread: Unread;
  readonly muted: boolean;
}

/** The paired phone as the dock shows it: its name and whether it is connected, nothing else. */
export interface PhoneLink {
  readonly name: string;
  readonly connected: boolean;
}

export interface Snapshot {
  readonly activeId: string;
  /** Every service, in the dock's order, hidden ones included. */
  readonly services: readonly ServiceSnapshot[];
  /** Services with no tab in the dock. */
  readonly hiddenIds: readonly string[];
  /** Null until a phone is paired. */
  readonly phone: PhoneLink | null;
}

/** The only API the dock page gets, exposed as window.kainos. */
export interface KainosApi {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  activate(serviceId: string): void;
  retry(serviceId: string): void;
  /** `at` places the menu (window coordinates); without it the menu opens at the pointer. */
  openServiceMenu(serviceId: string, at?: MenuPoint): void;
  onFocusDock(listener: () => void): void;
  /** Dock options (Always show the dock). `at` as for openServiceMenu. */
  openBarMenu(at?: MenuPoint): void;
  /** The phone island: its menu once a phone is paired, else the Texts page. `at` as above. */
  openPhoneMenu(at?: MenuPoint): void;
  onFrame(listener: (frame: DockFrame) => void): void;
  reportSize(size: DockSize): void;
  reportPointer(over: boolean): void;
  reportKeyboard(focused: boolean): void;
  dismiss(): void;
  /** Asks main to make the service the tab at `index` among the dock's tabs. */
  moveService(serviceId: string, index: number): void;
  /** A tab drag started or ended; an auto-hiding dock stays shown in between. */
  reportDrag(active: boolean): void;
}

export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

/** The dock's menu position is untrusted input: two sane, non-negative numbers. */
export function parseMenuPoint(raw: unknown): MenuPoint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y } = raw as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000;
  return ok(x) && ok(y) ? { x: Math.round(x), y: Math.round(y) } : undefined;
}

/** A place among the dock's tabs from the dock page is untrusted input: a whole number, 0 or more. */
export function parseDockIndex(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < 1000 ? raw : undefined;
}

/** A page notification forwarded by a service view. */
export interface NotificationRequest {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly icon: string;
  /** A later notification with the same tag from the same page replaces this one. */
  readonly tag: string;
  readonly silent: boolean;
}
