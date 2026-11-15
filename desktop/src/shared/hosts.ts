/** Host patterns are exact hostnames, or "*.example.com" for any subdomain of example.com. */
export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
  return h === pattern;
}
