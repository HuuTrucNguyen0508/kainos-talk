import type { NotificationRequest } from './ipc.ts';
import { hostMatches } from './hosts.ts';

const MAX_ICON_URL = 2048;

function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > MAX_ICON_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Page payloads are untrusted: keep only the fields we use, with sane sizes. */
export function parseNotificationRequest(raw: unknown): NotificationRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, title, body, icon, tag, silent } = raw as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof title !== 'string') return undefined;
  return {
    id,
    title: title.slice(0, 256),
    body: typeof body === 'string' ? body.slice(0, 1024) : '',
    icon: httpsUrl(icon) ? (icon as string) : '',
    tag: typeof tag === 'string' ? tag.slice(0, 256) : '',
    silent: silent === true,
  };
}

/** Whether a notification icon may be fetched: https, on one of the service's image hosts. */
export function iconAllowed(iconHosts: readonly string[], icon: string): boolean {
  const url = httpsUrl(icon);
  return url !== undefined && iconHosts.some((pattern) => hostMatches(pattern, url.hostname));
}
