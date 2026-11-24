import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isLocalAddress, isTailnetAddress } from '../shared/sync-protocol.ts';

/** A Wi-Fi or Ethernet address worth announcing: Tailscale's go to the phone in the welcome instead. */
const isLanAddress = (address: string) => isLocalAddress(address) && !isTailnetAddress(address);

/** What the PC announces on the local network. */
export interface Announcement {
  /** Instance name, such as "Kainos Talk on <hostname>". */
  readonly name: string;
  /** Service type without the leading underscore or protocol, such as "kainos-talk". */
  readonly type: string;
  readonly port: number;
  readonly txt: Readonly<Record<string, string>>;
}

/** Container, VM and VPN interfaces: a phone on the Wi-Fi can't reach the PC through them. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|tailscale|zt|lxc|podman|cni)/;

/**
 * The interfaces worth announcing on: up, not loopback, not virtual, with a private IPv4
 * address. Sorted, so two readings of the same set compare equal.
 */
export function eligibleInterfaces(interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>): string[] {
  return Object.entries(interfaces)
    .filter(([name, infos]) => !VIRTUAL_INTERFACE.test(name) && (infos ?? []).some((info) => !info.internal && info.family === 'IPv4' && isLanAddress(info.address)))
    .map(([name]) => name)
    .sort();
}

const RECHECK_MS = 30_000;

/**
 * Announces the service and keeps the announcement in step with the PC's interfaces, checking
 * every 30 s. Uses the system's Avahi daemon when it runs (Linux), so the service sits on
 * Avahi's own host name and is published only on real LAN interfaces; otherwise an mDNS
 * responder inside the app. Returns a function that withdraws it.
 */
export async function announce(announcement: Announcement): Promise<() => Promise<void>> {
  try {
    return await announceWithAvahi(announcement);
  } catch (error) {
    console.info('mDNS: Avahi unavailable, announcing from the app', (error as Error).message);
    return announceInApp(announcement);
  }
}

const AVAHI = 'org.freedesktop.Avahi';
const AVAHI_PROTO_INET = 0;

interface AvahiServer {
  EntryGroupNew(): Promise<string>;
  GetNetworkInterfaceIndexByName(name: string): Promise<number>;
}

interface AvahiEntryGroup {
  AddService(iface: number, protocol: number, flags: number, name: string, type: string, domain: string, host: string, port: number, txt: Buffer[]): Promise<void>;
  Commit(): Promise<void>;
  Reset(): Promise<void>;
  Free(): Promise<void>;
}

async function announceWithAvahi(announcement: Announcement): Promise<() => Promise<void>> {
  const { systemBus } = await import('dbus-next');
  const bus = systemBus();
  try {
    const server = (await bus.getProxyObject(AVAHI, '/')).getInterface('org.freedesktop.Avahi.Server') as unknown as AvahiServer;
    const groupPath = await server.EntryGroupNew();
    const group = (await bus.getProxyObject(AVAHI, groupPath)).getInterface('org.freedesktop.Avahi.EntryGroup') as unknown as AvahiEntryGroup;
    const type = `_${announcement.type}._tcp`;
    const txt = Object.entries(announcement.txt).map(([key, value]) => Buffer.from(`${key}=${value}`, 'utf8'));
    let published = '';
    const reconcile = async () => {
      const names = eligibleInterfaces(networkInterfaces());
      const key = names.join(',');
      if (key === published) return;
      await group.Reset();
      for (const name of names) {
        const index = await server.GetNetworkInterfaceIndexByName(name);
        // An empty host lets Avahi answer with that interface's own address.
        await group.AddService(index, AVAHI_PROTO_INET, 0, announcement.name, type, '', '', announcement.port, txt);
      }
      if (names.length) await group.Commit();
      published = key;
      console.info(`mDNS: announced ${type} on ${names.join(', ') || 'no interface'} through Avahi`);
    };
    await reconcile();
    const timer = setInterval(() => reconcile().catch((error) => console.warn('mDNS: Avahi update failed', error)), RECHECK_MS);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await group.Free().catch(() => undefined);
      bus.disconnect();
    };
  } catch (error) {
    bus.disconnect();
    throw error;
  }
}

async function announceInApp(announcement: Announcement): Promise<() => Promise<void>> {
  const { Bonjour } = await import('bonjour-service');
  const { hostname } = await import('node:os');
  const mdns = new Bonjour();
  const service = mdns.publish({
    name: announcement.name,
    // Its own host name: the machine's lists every interface.
    host: `kainos-talk-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}.local`,
    type: announcement.type,
    protocol: 'tcp',
    port: announcement.port,
    txt: { ...announcement.txt },
  });
  // bonjour-service announces every interface's address, Docker bridges included.
  const allRecords = service.records.bind(service);
  service.records = () => {
    const lan = new Set(
      eligibleInterfaces(networkInterfaces()).flatMap((name) => (networkInterfaces()[name] ?? []).filter((info) => isLanAddress(info.address)).map((info) => info.address)),
    );
    return allRecords().filter((record) => (record.type !== 'A' && record.type !== 'AAAA') || lan.has(String(record.data)));
  };
  // Re-announce when the addresses change, so phones that cached the old one learn the new.
  let last = eligibleInterfaces(networkInterfaces()).join(',');
  const timer = setInterval(() => {
    const now = eligibleInterfaces(networkInterfaces()).join(',');
    if (now === last) return;
    last = now;
    service.stop?.(() => service.start?.());
  }, RECHECK_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await new Promise<void>((resolve) => mdns.destroy(() => resolve()));
  };
}
