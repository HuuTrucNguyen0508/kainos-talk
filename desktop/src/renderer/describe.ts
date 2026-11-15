import type { ServiceSnapshot } from '../shared/ipc.ts';

/** The rail button's accessible name: the service and every state its tile shows. */
export function describe(service: ServiceSnapshot): string {
  const parts = [service.name];
  if (service.unread.kind === 'count') parts.push(`${service.unread.count} unread`);
  if (service.unread.kind === 'marker') parts.push('new activity');
  if (service.status.kind === 'loading') parts.push('loading');
  if (service.status.kind === 'asleep') parts.push('asleep');
  if (service.status.kind === 'failed') parts.push('failed to load');
  if (service.muted) parts.push('notifications muted');
  return parts.join(', ');
}
