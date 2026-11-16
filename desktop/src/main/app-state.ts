import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeHidden, normalizeOrder, visibleServices } from '../shared/dock-order.ts';
import { parseThemeChoice, type ThemeChoice } from '../shared/theme.ts';

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
  /** The dock keeps its strip instead of hiding until the pointer reaches the bottom edge. */
  readonly dockAlwaysShown: boolean;
  /** The colour theme of the dock and the Texts page. */
  readonly theme: ThemeChoice;
  /** Every service once, in the dock's order, hidden ones included. */
  readonly serviceOrder: readonly string[];
  /** Services with no tab in the dock; they keep running. */
  readonly hiddenServiceIds: readonly string[];
  /** Services whose page is closed to save memory until their tab is opened. Never the active one. */
  readonly hibernatedServiceIds: readonly string[];
}

/** What the registry says about the services, for reading and defaulting the state. */
export interface StateRules {
  /** Services that always keep their tab (Texts). */
  readonly unhideable?: readonly string[];
  /** Services that never hibernate (Kainos' own pages). */
  readonly sleepless?: readonly string[];
  /** Services that start hibernated the first time the state knows them. */
  readonly startHibernated?: readonly string[];
}

export const DEFAULT_SIZE = { width: 1280, height: 820 } as const;
export const MIN_SIZE = { width: 640, height: 480 } as const;

export function defaultState(serviceIds: readonly string[], rules: StateRules = {}): AppState {
  const activeServiceId = serviceIds[0] ?? '';
  return {
    bounds: undefined,
    maximized: false,
    activeServiceId,
    mutedServiceIds: [],
    dockAlwaysShown: false,
    theme: 'system',
    serviceOrder: [...serviceIds],
    hiddenServiceIds: [],
    hibernatedServiceIds: normalizeHibernated(rules.startHibernated, serviceIds, rules, activeServiceId),
  };
}

/** Known ids, once each, that may hibernate and are not the active service. */
function normalizeHibernated(stored: unknown, serviceIds: readonly string[], rules: StateRules, activeServiceId: string): string[] {
  if (!Array.isArray(stored)) return [];
  const sleepless = rules.sleepless ?? [];
  return [...new Set(stored.filter((id): id is string => typeof id === 'string' && serviceIds.includes(id) && !sleepless.includes(id) && id !== activeServiceId))];
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
 * of services that no longer exist are dropped, as are fields from older versions (the side
 * bar's `barSide` and `barAutoHide`, the dock's `dockAlign`). `unhideable` services (Texts)
 * always keep their tab; a hidden service is not opened at launch, the first tab is. A service the
 * saved order does not know yet (added in a later version) hibernates if it starts hibernated;
 * the service opened at launch is always awake.
 */
export function parseAppState(raw: unknown, serviceIds: readonly string[], rules: StateRules = {}): AppState {
  const fallback = defaultState(serviceIds, rules);
  if (!isRecord(raw)) return fallback;
  const serviceOrder = normalizeOrder(raw.serviceOrder, serviceIds);
  const hiddenServiceIds = normalizeHidden(raw.hiddenServiceIds, serviceIds, rules.unhideable);
  const known = (id: unknown): id is string => typeof id === 'string' && serviceIds.includes(id);
  const shown = (id: unknown): id is string => known(id) && !hiddenServiceIds.includes(id);
  const activeServiceId = shown(raw.activeServiceId) ? raw.activeServiceId : (visibleServices(serviceOrder, hiddenServiceIds)[0] ?? fallback.activeServiceId);
  const savedOrder = Array.isArray(raw.serviceOrder) ? raw.serviceOrder : [];
  const newcomers = (rules.startHibernated ?? []).filter((id) => !savedOrder.includes(id));
  const savedHibernated = Array.isArray(raw.hibernatedServiceIds) ? raw.hibernatedServiceIds : [];
  return {
    bounds: parseRect(raw.bounds),
    maximized: raw.maximized === true,
    activeServiceId,
    mutedServiceIds: Array.isArray(raw.mutedServiceIds) ? [...new Set(raw.mutedServiceIds.filter(known))] : [],
    dockAlwaysShown: raw.dockAlwaysShown === true,
    theme: parseThemeChoice(raw.theme),
    serviceOrder,
    hiddenServiceIds,
    hibernatedServiceIds: normalizeHibernated([...savedHibernated, ...newcomers], serviceIds, rules, activeServiceId),
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

export function loadAppState(file: string, serviceIds: readonly string[], rules: StateRules = {}): AppState {
  try {
    return parseAppState(JSON.parse(readFileSync(file, 'utf8')), serviceIds, rules);
  } catch {
    return defaultState(serviceIds, rules);
  }
}

/** Writes through a temporary file so a crash mid-write never leaves half a file. */
export function saveAppState(file: string, state: AppState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}
