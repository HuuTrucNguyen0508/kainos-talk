import type { ServiceDefinition } from '../shared/services.ts';
import { hostMatches } from '../shared/hosts.ts';

export interface PermissionAsk {
  readonly permission: string;
  /** The origin or URL that asked. */
  readonly origin: string;
  /** For "media": which devices. Empty means unknown. */
  readonly mediaTypes: readonly string[];
}

/** Granted to the service's own https pages without asking. */
const OWN_PAGE_PERMISSIONS = new Set([
  'notifications',
  // navigator.clipboard.writeText behind the page's Copy buttons. Reading stays denied.
  'clipboard-sanitized-write',
  // Video and stream fullscreen buttons. The view then covers the whole window.
  'fullscreen',
  // Keeps WhatsApp's and Proton's local data from being evicted under disk pressure.
  'persistent-storage',
]);

/**
 * Notifications, copy, fullscreen, persistent storage and microphone/camera are allowed for
 * the service's own https pages. Every other permission, and any request from another origin,
 * is denied.
 */
export function allowPermission(service: ServiceDefinition, ask: PermissionAsk): boolean {
  let origin: URL;
  try {
    origin = new URL(ask.origin);
  } catch {
    return false;
  }
  const own = origin.protocol === 'https:' && service.hosts.some((pattern) => hostMatches(pattern, origin.hostname));
  if (!own) return false;
  if (OWN_PAGE_PERMISSIONS.has(ask.permission)) return true;
  if (ask.permission === 'media') return ask.mediaTypes.every((type) => type === 'audio' || type === 'video');
  return false;
}
