import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SIDE_PREFERENCES, type SidePreference } from './bar.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What Kainos Talk remembers between launches. */
export interface AppState {
  /** Unset until the window has been placed once; the OS picks the first position. */
  readonly bounds: Rect | undefined;
  readonly maximized: boolean;
  readonly activeServiceId: string;
  readonly mutedServiceIds: readonly string[];
  /** Which side the bar sits on: the screen's outer edge, or always left or right. */
  readonly barSide: SidePreference;
  /** The bar hides until the pointer reaches its edge of the window. */
  readonly barAutoHide: boolean;
  /** Websites that never go to sleep (they keep their own notifications and unread counts). */
  readonly keepAwakeServiceIds: readonly string[];
}

export const DEFAULT_SIZE = { width: 1280, height: 820 } as const;
export const MIN_SIZE = { width: 640, height: 480 } as const;

export function defaultState(serviceIds: readonly string[]): AppState {
  return { bounds: undefined, maximized: false, activeServiceId: serviceIds[0] ?? '', mutedServiceIds: [], barSide: 'auto', barAutoHide: false, keepAwakeServiceIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const rect = { x: x as number, y: y as number, width: width as number, height: height as number };
  return rect.width >= MIN_SIZE.width && rect.height >= MIN_SIZE.height ? rect : undefined;
}

/**
 * Reads a saved state file. Bad or missing fields fall back to defaults one by one, and ids
 * of services that no longer exist are dropped.
 */
export function parseAppState(raw: unknown, serviceIds: readonly string[]): AppState {
  const fallback = defaultState(serviceIds);
  if (!isRecord(raw)) return fallback;
  const known = (id: unknown): id is string => typeof id === 'string' && serviceIds.includes(id);
  return {
    bounds: parseRect(raw.bounds),
    maximized: raw.maximized === true,
    activeServiceId: known(raw.activeServiceId) ? raw.activeServiceId : fallback.activeServiceId,
    mutedServiceIds: Array.isArray(raw.mutedServiceIds) ? [...new Set(raw.mutedServiceIds.filter(known))] : [],
    barSide: SIDE_PREFERENCES.find((side) => side === raw.barSide) ?? fallback.barSide,
    barAutoHide: raw.barAutoHide === true,
    keepAwakeServiceIds: Array.isArray(raw.keepAwakeServiceIds) ? [...new Set(raw.keepAwakeServiceIds.filter(known))] : [],
  };
}

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Puts saved bounds back on a screen that still exists. If the window would sit mostly off
 * every display (a monitor was unplugged), it moves onto the display it overlaps most, or
 * the first one, shrinking to fit.
 */
export function fitToDisplays(bounds: Rect, workAreas: readonly Rect[]): Rect {
  if (workAreas.length === 0) return bounds;
  const ranked = [...workAreas].sort((a, b) => overlap(bounds, b) - overlap(bounds, a));
  const area = ranked[0]!;
  const visible = overlap(bounds, area) / (bounds.width * bounds.height);
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  if (visible >= 0.5 && width === bounds.width && height === bounds.height) return bounds;
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

export function loadAppState(file: string, serviceIds: readonly string[]): AppState {
  try {
    return parseAppState(JSON.parse(readFileSync(file, 'utf8')), serviceIds);
  } catch {
    return defaultState(serviceIds);
  }
}

/** Writes through a temporary file so a crash mid-write never leaves half a file. */
export function saveAppState(file: string, state: AppState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}
