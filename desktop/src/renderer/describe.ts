import type { ServiceSnapshot } from '../shared/ipc.ts';

/** The dock tab's accessible name: the service and every state its tab shows. */
export function describe(service: ServiceSnapshot, phoneOffline = false): string {
  const parts = [service.name];
  if (service.unread.kind === 'count') parts.push(`${service.unread.count} unread`);
  if (service.unread.kind === 'marker') parts.push('new activity');
  if (service.status.kind === 'loading') parts.push('loading');
  if (service.status.kind === 'failed') parts.push('failed to load');
  if (service.status.kind === 'hibernated') parts.push('hibernating, opens when selected');
  if (phoneOffline) parts.push('phone not connected');
  if (service.muted) parts.push('notifications muted');
  return parts.join(', ');
}
