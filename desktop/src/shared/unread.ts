/** What a service's page title says about unread messages. */
export type Unread =
  | { readonly kind: 'none' }
  /** Something is unread but the page gives no number (Discord's "• Discord"). */
  | { readonly kind: 'marker' }
  | { readonly kind: 'count'; readonly count: number };

export const NO_UNREAD: Unread = { kind: 'none' };

/** "1234", or digits grouped in threes by a comma, dot, space or narrow space ("1,234", "1 234"). */
const COUNT = /^\s*\((\d{1,3}(?:[,. \u00a0\u202f]\d{3})+|\d{1,7})(\+)?\)/;

/**
 * Reads the "(3) Title" or "• Title" prefix most web apps put in front of their title.
 * A capped count such as "(99+)" means more than 99, so it counts as 100.
 * Anything else, including "(0)", means nothing is unread.
 */
export function unreadFromTitlePrefix(title: string): Unread {
  const counted = COUNT.exec(title);
  if (counted) {
    const count = Number(counted[1]!.replace(/\D/g, '')) + (counted[2] ? 1 : 0);
    return count > 0 ? { kind: 'count', count } : NO_UNREAD;
  }
  if (/^\s*\(?[•●]\)?/.test(title)) return { kind: 'marker' };
  return NO_UNREAD;
}

/** What the service preload saw of the page's own unread counter. */
export interface CounterReading {
  /** Whether the element the counter belongs to (Proton's Inbox link) is on the page. */
  readonly scope: boolean;
  /** The counter's text, or null when it is not on the page. */
  readonly text: string | null;
}

/** The preload's message is untrusted: a boolean and a short string or null. */
export function parseCounterReading(raw: unknown): CounterReading | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { scope, text } = raw as Record<string, unknown>;
  if (typeof scope !== 'boolean' || (text !== null && typeof text !== 'string')) return undefined;
  return { scope, text: text === null ? null : text.slice(0, 32) };
}

/**
 * Combines the title with the page's counter. While the counter's scope is on the page the
 * counter decides, and a missing counter means nothing is unread; otherwise the title decides.
 */
export function unreadFromPage(fromTitle: Unread, counter: CounterReading | undefined): Unread {
  if (!counter?.scope) return fromTitle;
  return counter.text === null ? NO_UNREAD : unreadFromTitlePrefix(`(${counter.text.trim()})`);
}

/** Adds up every service: numbers win, a marker only shows when no service has a number. */
export function totalUnread(all: readonly Unread[]): Unread {
  let count = 0;
  let marker = false;
  for (const unread of all) {
    if (unread.kind === 'count') count += unread.count;
    if (unread.kind === 'marker') marker = true;
  }
  if (count > 0) return { kind: 'count', count };
  return marker ? { kind: 'marker' } : NO_UNREAD;
}

export function sameUnread(a: Unread, b: Unread): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'count' || a.count === (b as { count: number }).count;
}

/** The short label a badge shows: "", "•", "7" or "99+". */
export function unreadLabel(unread: Unread): string {
  switch (unread.kind) {
    case 'none':
      return '';
    case 'marker':
      return '•';
    case 'count':
      return unread.count > 99 ? '99+' : String(unread.count);
  }
}

export function windowTitle(appName: string, total: Unread): string {
  const label = unreadLabel(total);
  return label ? `(${label}) ${appName}` : appName;
}
