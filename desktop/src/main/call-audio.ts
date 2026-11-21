// Call sound goes from the phone to this PC over Bluetooth hands-free, and the phone forgets to
// connect when the PC was off or away. So the PC connects to the phone itself, through BlueZ,
// whenever sound may be needed: the phone joins over the LAN, a call rings or starts, or the PC
// wakes. It never retries on a timer, so a phone that moved its calls to earbuds keeps them there.

import type { CallAudio } from '../shared/sms.ts';

const BLUEZ = 'org.bluez';
/** The phone's side of hands-free: "Handsfree Audio Gateway". */
export const HANDSFREE_GATEWAY = '0000111f-0000-1000-8000-00805f9b34fb';

/** What the PC knows of a paired Bluetooth device. */
export interface BluetoothDevice {
  readonly path: string;
  readonly name: string;
  readonly paired: boolean;
  readonly connected: boolean;
  readonly uuids: readonly string[];
}

/**
 * The phone to connect: a paired device that can carry calls, preferring the one whose name the
 * Kainos phone gave ("Google Pixel 8" for Bluetooth's "Pixel 8"), then one already connected.
 * Some phones give only a model code ("samsung SM-S921B" for the "Galaxy S24"), so the
 * name is a hint, not a requirement.
 */
export function pickPhone(devices: readonly BluetoothDevice[], phoneName: string | undefined): BluetoothDevice | undefined {
  const phones = devices.filter((device) => device.paired && device.uuids.includes(HANDSFREE_GATEWAY));
  const wanted = phoneName?.trim().toLowerCase();
  const named = wanted
    ? phones.find((device) => {
        const name = device.name.trim().toLowerCase();
        return name !== '' && (wanted.includes(name) || name.includes(wanted));
      })
    : undefined;
  return named ?? phones.find((device) => device.connected) ?? phones[0];
}

/** What a failed BlueZ connect means to the person on the call. */
export function failureOf(errorName: string | undefined): CallAudio['kind'] {
  if (errorName === 'org.bluez.Error.AlreadyConnected') return 'connected';
  if (errorName === 'org.bluez.Error.InProgress') return 'connecting';
  if (errorName === 'org.bluez.Error.NotReady') return 'pc-off';
  return 'unreachable';
}

export interface CallAudioLink {
  /** Connects the phone for call sound now, unless it is connected or connecting. */
  ensure(phoneName: string | undefined): void;
  state(): CallAudio | null;
  stop(): void;
}

interface Bus {
  getProxyObject(name: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  disconnect(): void;
}
interface ObjectManager {
  GetManagedObjects(): Promise<Record<string, Record<string, Record<string, { value: unknown }>>>>;
}
interface Device1 {
  ConnectProfile(uuid: string): Promise<void>;
}

/** BlueZ on Linux. Elsewhere, or with KAINOS_CALL_AUDIO=0 (the smoke test), the state stays null. */
export async function startCallAudio(onChange: () => void): Promise<CallAudioLink> {
  if (process.platform !== 'linux' || process.env.KAINOS_CALL_AUDIO === '0') return { ensure() {}, state: () => null, stop() {} };
  const { systemBus } = await import('dbus-next');
  let bus: Bus | undefined;
  let current: CallAudio | null = null;
  let busy = false;
  const set = (next: CallAudio | null) => {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    onChange();
  };

  async function devices(): Promise<BluetoothDevice[]> {
    bus ??= systemBus() as unknown as Bus;
    const manager = (await bus.getProxyObject(BLUEZ, '/')).getInterface('org.freedesktop.DBus.ObjectManager') as ObjectManager;
    return Object.entries(await manager.GetManagedObjects()).flatMap(([path, interfaces]) => {
      const device = interfaces['org.bluez.Device1'];
      if (!device) return [];
      return [
        {
          path,
          name: String(device.Alias?.value ?? device.Name?.value ?? ''),
          paired: device.Paired?.value === true,
          connected: device.Connected?.value === true,
          uuids: (device.UUIDs?.value as string[] | undefined)?.map((uuid) => uuid.toLowerCase()) ?? [],
        },
      ];
    });
  }

  async function connect(phoneName: string | undefined): Promise<void> {
    let phone: BluetoothDevice | undefined;
    try {
      phone = pickPhone(await devices(), phoneName);
    } catch (error) {
      // No BlueZ on this PC (or no system bus): nothing Kainos can do about the sound.
      console.warn('Call audio: BlueZ unavailable', (error as Error).message);
      bus?.disconnect();
      bus = undefined;
      return set({ kind: 'no-bluetooth', device: null });
    }
    if (!phone) return set({ kind: 'not-paired', device: null });
    set({ kind: 'connecting', device: phone.name });
    try {
      const device = (await bus!.getProxyObject(BLUEZ, phone.path)).getInterface('org.bluez.Device1') as Device1;
      // Connecting a profile that is up already answers AlreadyConnected at once.
      await device.ConnectProfile(HANDSFREE_GATEWAY);
      set({ kind: 'connected', device: phone.name });
    } catch (error) {
      const kind = failureOf((error as { type?: string }).type);
      if (kind !== 'connected') console.info(`Call audio: could not connect ${phone.name}:`, (error as Error).message);
      set({ kind, device: phone.name });
    }
  }

  return {
    ensure(phoneName) {
      if (busy) return;
      busy = true;
      void connect(phoneName).finally(() => (busy = false));
    },
    state: () => current,
    stop() {
      bus?.disconnect();
      bus = undefined;
    },
  };
}
