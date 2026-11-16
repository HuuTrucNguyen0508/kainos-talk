/**
 * The order of the services in the dock, and which of them it hides. Main owns both and saves
 * them; the dock page asks for moves by position among the tabs it shows.
 */

/**
 * Every registered service exactly once: the saved ids first, in their saved order (unknown and
 * repeated ids dropped), then any service missing from them in registry order, so a service
 * added in a later version appears at the end of the dock.
 */
export function normalizeOrder(stored: unknown, registryIds: readonly string[]): string[] {
  const saved = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && registryIds.includes(id)) : [];
  return [...new Set([...saved, ...registryIds])];
}

/**
 * The saved hidden ids that may be hidden: known, once each, never one of `unhideable`. If that
 * would hide every service, nothing is hidden, so the dock always has a tab.
 */
export function normalizeHidden(stored: unknown, registryIds: readonly string[], unhideable: readonly string[] = []): string[] {
  if (!Array.isArray(stored)) return [];
  const hidden = [...new Set(stored.filter((id): id is string => typeof id === 'string' && registryIds.includes(id) && !unhideable.includes(id)))];
  return hidden.length < registryIds.length ? hidden : [];
}

/** The services that have a tab, in dock order. */
export function visibleServices(order: readonly string[], hidden: readonly string[]): string[] {
  return order.filter((id) => !hidden.includes(id));
}

/**
 * Moves `id` so it becomes the tab at `toIndex` among the visible services (clamped to the
 * dock). Hidden services keep their place relative to the visible ones around them. An unknown
 * or hidden id leaves the order as it is.
 */
export function moveService(order: readonly string[], id: string, toIndex: number, hidden: readonly string[] = []): string[] {
  if (!order.includes(id) || hidden.includes(id)) return [...order];
  const rest = order.filter((other) => other !== id);
  const shown = visibleServices(rest, hidden);
  const to = Math.min(Math.max(Math.trunc(toIndex), 0), shown.length);
  const at = to < shown.length ? rest.indexOf(shown[to]!) : shown.length > 0 ? rest.indexOf(shown.at(-1)!) + 1 : rest.length;
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The tab that takes over when `id` is hidden: the next one along the dock, else the one before. */
export function successor(order: readonly string[], hidden: readonly string[], id: string): string | undefined {
  const shown = visibleServices(order, hidden);
  const index = shown.indexOf(id);
  if (index < 0) return undefined;
  return shown[index + 1] ?? shown[index - 1];
}

/**
 * Where a dragged tab lands: its place among the other tabs, from the other tabs' centres (left
 * to right) and the dragged tab's centre now. It goes after every tab whose centre it has passed.
 */
export function dropIndex(otherCentres: readonly number[], draggedCentre: number): number {
  return otherCentres.filter((centre) => centre < draggedCentre).length;
}

/**
 * How far another tab steps aside while a tab is dragged from `from` to `to`, in tab widths:
 * +1 to the right, -1 to the left, 0 in place. `index` is its place among the other tabs.
 */
export function makeRoom(index: number, from: number, to: number): -1 | 0 | 1 {
  return ((index >= to ? 1 : 0) - (index >= from ? 1 : 0)) as -1 | 0 | 1;
}
