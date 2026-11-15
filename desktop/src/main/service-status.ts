import type { ServiceStatus } from '../shared/ipc.ts';

/** Chromium's code for a navigation that was cancelled on purpose (redirects, preventDefault). */
const ERR_ABORTED = -3;

/** What the service's WebContents reported, reduced to what the load status needs. */
export type PageEvent =
  | { readonly kind: 'restart' }
  | { readonly kind: 'start-navigation'; readonly url: string; readonly isMainFrame: boolean; readonly isSameDocument: boolean }
  | { readonly kind: 'dom-ready' }
  /** A cancelled navigation never reaches dom-ready; the old page is still there. */
  | { readonly kind: 'stop-loading' }
  | { readonly kind: 'fail-load'; readonly code: number; readonly description: string; readonly url: string; readonly isMainFrame: boolean }
  | { readonly kind: 'gone'; readonly reason: string; readonly host: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The load status after `event`. Returns `status` itself when nothing changed. */
export function nextStatus(status: ServiceStatus, event: PageEvent): ServiceStatus {
  // An asleep page shows about:blank; only a restart (waking it) changes that.
  if (status.kind === 'asleep' && event.kind !== 'restart') return status;
  const to = (next: ServiceStatus) => (next.kind === status.kind && next.kind !== 'failed' ? status : next);
  switch (event.kind) {
    case 'restart':
      return to({ kind: 'loading' });
    case 'start-navigation':
      return event.isMainFrame && !event.isSameDocument && !event.url.startsWith('chrome-error:') ? to({ kind: 'loading' }) : status;
    case 'dom-ready':
    case 'stop-loading':
      return status.kind === 'loading' ? { kind: 'ready' } : status;
    case 'fail-load':
      return event.isMainFrame && event.code !== ERR_ABORTED ? { kind: 'failed', reason: event.description, host: hostOf(event.url) } : status;
    case 'gone':
      return event.reason === 'clean-exit' ? status : { kind: 'failed', reason: `page stopped (${event.reason})`, host: event.host };
  }
}
