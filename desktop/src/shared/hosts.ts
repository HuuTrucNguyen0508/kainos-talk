/** Host patterns are exact hostnames, or "*.example.com" for any subdomain of example.com. */
export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
  return h === pattern;
}

/** Names of this computer. Browsers treat plain http on them as secure, like https. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * One of a service's own pages: https on one of its hosts, or plain http when that host is this
 * computer (a server run locally, such as Streamroom's).
 */
export function isOwnPage(url: URL, patterns: readonly string[]): boolean {
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  return secure && patterns.some((pattern) => hostMatches(pattern, url.hostname));
}
