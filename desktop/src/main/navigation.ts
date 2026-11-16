import { hostMatches } from '../shared/hosts.ts';
import type { ServiceDefinition } from '../shared/services.ts';

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function onHosts(url: URL, patterns: readonly string[]): boolean {
  return url.protocol === 'https:' && patterns.some((pattern) => hostMatches(pattern, url.hostname));
}

/** Schemes we hand to the operating system. Everything else is dropped. */
export function isExternalSafe(url: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
}

export type PageNavigation = 'stay' | 'external' | 'block';

/** A top-level navigation inside a service view: its own pages stay, anything else goes to the browser. */
export function decideNavigation(service: ServiceDefinition, url: string): PageNavigation {
  const parsed = parse(url);
  if (!parsed) return 'block';
  if (onHosts(parsed, service.hosts)) return 'stay';
  return isExternalSafe(url) ? 'external' : 'block';
}

export type WindowOpen = 'popup' | 'external' | 'block';

/**
 * A window.open() or target=_blank link from a service. Captcha and sign-in steps on the
 * service's popup hosts open as a popup that shares its login; links to anywhere else open in
 * the system browser. Blank popups are refused: none of the services' sign-in flows needs one,
 * and the opener could fill a blank window with any content under no visible address.
 */
export function decideWindowOpen(service: ServiceDefinition, url: string): WindowOpen {
  const parsed = parse(url);
  if (!parsed) return 'block';
  if (onHosts(parsed, service.popupHosts)) return 'popup';
  return isExternalSafe(url) ? 'external' : 'block';
}

/** Navigation inside a popup: it stays on the service and its popup hosts, or leaves for the browser. */
export function decidePopupNavigation(service: ServiceDefinition, url: string): PageNavigation {
  const parsed = parse(url);
  if (!parsed) return 'block';
  if (onHosts(parsed, service.popupHosts) || onHosts(parsed, service.hosts)) return 'stay';
  return isExternalSafe(url) ? 'external' : 'block';
}

/**
 * The service that opens `url` in its own tab instead of the system browser: one that claims
 * links (`claimsLinks`) and has the link's host among its own.
 */
export function claimingService<S extends ServiceDefinition>(services: readonly S[], url: string): S | undefined {
  const parsed = parse(url);
  return parsed ? services.find((service) => service.claimsLinks && onHosts(parsed, service.hosts)) : undefined;
}

/** A popup has no address bar, so its title names the host it shows. */
export function popupTitle(url: string, pageTitle: string): string {
  const parsed = parse(url);
  const host = parsed?.host || url;
  return pageTitle ? `${host} — ${pageTitle}` : host;
}
