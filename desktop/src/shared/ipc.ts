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
  /** Main to sidebar: put keyboard focus on the active service's rail button. */
  focusRail: 'kainos:focus-rail',
  /** Sidebar to main: the pointer entered (true) or left (false) the bar. */
  railPointer: 'kainos:rail-pointer',
  /** Sidebar to main: open the bar options menu. */
  openBarMenu: 'kainos:open-bar-menu',
  /** Service preload to main: the pointer reached a side edge of the page, or moved back inside. */
  pointerEdge: 'kainos:pointer-edge',
} as const;

export const RAIL_WIDTH = 68;

export type ServiceStatus =
  /** Not loaded: never opened yet, or put to sleep to free its memory. Opening it wakes it. */
  | { readonly kind: 'asleep' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly reason: string; readonly host: string };

/** Everything the sidebar needs to draw one service. */
export interface ServiceSnapshot {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly glyph: string;
  readonly status: ServiceStatus;
  readonly unread: Unread;
  readonly muted: boolean;
}

export type BarSide = 'left' | 'right';

/** How the bar is drawn: on which side, and whether it hides until the pointer reaches it. */
export interface BarSnapshot {
  readonly side: BarSide;
  readonly autoHide: boolean;
}

export interface Snapshot {
  readonly activeId: string;
  readonly services: readonly ServiceSnapshot[];
  readonly bar: BarSnapshot;
}

/** The only API the sidebar page gets, exposed as window.kainos. */
export interface KainosApi {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  activate(serviceId: string): void;
  retry(serviceId: string): void;
  /** `at` places the menu (window coordinates); without it the menu opens at the pointer. */
  openServiceMenu(serviceId: string, at?: MenuPoint): void;
  onFocusRail(listener: () => void): void;
  /** The pointer entered (true) or left (false) the bar. */
  railPointer(over: boolean): void;
  /** Auto-hide and side options. `at` as for openServiceMenu. */
  openBarMenu(at?: MenuPoint): void;
}

export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

/** The sidebar's menu position is untrusted input: two sane, non-negative numbers. */
export function parseMenuPoint(raw: unknown): MenuPoint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y } = raw as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000;
  return ok(x) && ok(y) ? { x: Math.round(x), y: Math.round(y) } : undefined;
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
