import { isLoopback } from './hosts.ts';
import type { ServiceDefinition } from './services.ts';

/** The Streamroom tab's service id. */
export const STREAMROOM_ID = 'streamroom';

/** The Streamroom project's guides: running it on this PC, and deploying your own to Cloudflare. */
export const STREAMROOM_REPO = 'https://github.com/HuuTrucNguyen0508/streamroom';
export const LOCAL_GUIDE = `${STREAMROOM_REPO}/blob/main/docs/local.md`;
export const CLOUDFLARE_GUIDE = `${STREAMROOM_REPO}/blob/main/docs/cloudflare.md`;

/** The port Streamroom's `pnpm start` listens on unless PORT says otherwise (its docs/local.md). */
export const DEFAULT_LOCAL_PORT = 8080;

/** Streamroom run on this computer, on `port`, as an origin (port 80 drops out, as in any origin). */
export function localServer(port: number): string {
  return new URL(`http://localhost:${port}`).origin;
}

/**
 * Which Streamroom server the tab uses, the other addresses the user has added (their own
 * Cloudflare deployment, a Tailscale address), and the port of the one on this PC. Addresses
 * are origins: scheme, host and port.
 */
export interface StreamroomServers {
  readonly current: string;
  /** Added addresses, oldest first, the current one included unless it is this PC's. */
  readonly saved: readonly string[];
  /** The port of Streamroom on this PC, the menu's This PC. */
  readonly localPort: number;
}

export const DEFAULT_SERVERS: StreamroomServers = { current: localServer(DEFAULT_LOCAL_PORT), saved: [], localPort: DEFAULT_LOCAL_PORT };

/**
 * A Streamroom address as its origin, or undefined. Https anywhere, plain http only on this
 * computer, where browsers still allow the microphone and screen sharing. Without a scheme,
 * localhost means http and any other host https. A room or invite link gives its server.
 */
export function parseServer(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const text = input.trim();
  if (!text || /\s/.test(text)) return undefined;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/i.test(text);
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `${local ? 'http' : 'https'}://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.username || url.password || !url.hostname) return undefined;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) return url.origin;
  return undefined;
}

/** What a typed address would open, or why it cannot be used: for the Add an address window. */
export type ServerReading = { readonly origin: string } | { readonly problem: string } | undefined;

export function readServerInput(input: string): ServerReading {
  if (!input.trim()) return undefined;
  const origin = parseServer(input);
  if (origin) return { origin };
  if (/^\s*http:\/\//i.test(input)) return { problem: 'Plain http only works for a server on this PC. Use its https address.' };
  if (/^\s*[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^\s*https:\/\//i.test(input)) return { problem: 'Use an https:// address.' };
  return { problem: 'Enter an address such as streamroom.example.workers.dev.' };
}

/** A port number from 1 to 65535, or undefined. */
export function parsePort(input: unknown): number | undefined {
  const text = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** What a typed port would open, or why it cannot be used: for the Change this PC's port window. */
export function readPortInput(input: string): ServerReading {
  if (!input.trim()) return undefined;
  const port = parsePort(input);
  return port === undefined ? { problem: 'Enter a port from 1 to 65535, such as 8080.' } : { origin: localServer(port) };
}

/** Reads the saved choice: bad entries are dropped, and a bad current address falls back to this PC. */
export function parseServers(raw: { current?: unknown; saved?: unknown; localPort?: unknown }): StreamroomServers {
  const localPort = parsePort(raw.localPort) ?? DEFAULT_LOCAL_PORT;
  const list = Array.isArray(raw.saved) ? raw.saved.map(parseServer).filter((origin): origin is string => origin !== undefined) : [];
  const base = { current: localServer(localPort), saved: [...new Set(list)], localPort };
  return withCurrent(base, parseServer(raw.current) ?? base.current);
}

/** This PC's address, for the menu and the tab. */
export function thisPc(servers: StreamroomServers): string {
  return localServer(servers.localPort);
}

/** Makes `origin` the current server, adding it to the saved addresses if it is new. */
export function withCurrent(servers: StreamroomServers, origin: string): StreamroomServers {
  const local = thisPc(servers);
  const saved = servers.saved.filter((other) => other !== local);
  return { ...servers, current: origin, saved: origin === local || saved.includes(origin) ? saved : [...saved, origin] };
}

/** Drops a saved address; if it was the current one, the tab goes back to this PC. */
export function withoutServer(servers: StreamroomServers, origin: string): StreamroomServers {
  return { ...servers, current: servers.current === origin ? thisPc(servers) : servers.current, saved: servers.saved.filter((other) => other !== origin) };
}

/**
 * Moves This PC to another port. If the tab was on this PC it follows; an added address on
 * that port becomes This PC instead of being listed twice.
 */
export function withLocalPort(servers: StreamroomServers, port: number): StreamroomServers {
  const wasHere = servers.current === thisPc(servers);
  const moved = { ...servers, localPort: port };
  return withCurrent(moved, wasHere ? thisPc(moved) : servers.current);
}

/** The menu's choices: this PC first, then the added addresses. */
export function serverChoices(servers: StreamroomServers): string[] {
  return [thisPc(servers), ...servers.saved];
}

/** A short name for an address in the menu: its host and port, without the scheme. */
export function serverLabel(origin: string, servers: StreamroomServers): string {
  const { host } = new URL(origin);
  return origin === thisPc(servers) ? `This PC (${host})` : host;
}

/**
 * The Streamroom service pointed at the current server. Every saved server's host counts as its
 * own, so an invite from any of them opens in the tab; this PC only while it is chosen.
 */
export function withServers(service: ServiceDefinition, servers: StreamroomServers): ServiceDefinition {
  const origins = [servers.current, ...servers.saved];
  return { ...service, url: `${servers.current}/`, hosts: [...new Set(origins.map((origin) => new URL(origin).hostname))] };
}
