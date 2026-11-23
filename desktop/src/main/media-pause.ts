// Music and videos pause while the phone rings or a call is on, and the ones paused for the call
// play again when it ends. Players are reached through MPRIS on the session D-Bus, so this works
// on Linux only. A player the user touched during the call is theirs again and stays as it is.

export type PlaybackStatus = 'Playing' | 'Paused' | 'Stopped';

/** The media players on the session bus, by bus name (`org.mpris.MediaPlayer2.*`). */
export interface MediaBus {
  players(): Promise<readonly { readonly name: string; readonly status: PlaybackStatus }[]>;
  /** Undefined once the player has gone. */
  status(name: string): Promise<PlaybackStatus | undefined>;
  pause(name: string): Promise<void>;
  play(name: string): Promise<void>;
  /** Calls back on each change of the player's status; resolves to the way to stop. */
  watch(name: string, onStatus: (status: PlaybackStatus) => void): Promise<() => void>;
  close(): void;
}

export interface MediaPause {
  /** Whether a call rings or is on; called on every change of the phone's state. */
  update(inCall: boolean): void;
  /** Settles once every change asked for so far is done; for tests. */
  idle(): Promise<void>;
  stop(): void;
}

/** A player paused for the call. `touched` once the user played or stopped it since. */
interface Paused {
  touched: boolean;
  unwatch: () => void;
}

type State = { readonly kind: 'idle' } | { readonly kind: 'call'; readonly paused: Map<string, Paused> };

const quiet = (what: string) => (error: unknown) => console.info(`Media pause: could not ${what}:`, (error as Error).message);

export function createMediaPause(bus: MediaBus): MediaPause {
  let state: State = { kind: 'idle' };
  /** Changes run one after another, each from the state the last one left. */
  let work = Promise.resolve();

  async function callStarted(): Promise<void> {
    const paused = new Map<string, Paused>();
    state = { kind: 'call', paused };
    for (const player of await bus.players().catch(() => [])) {
      if (player.status !== 'Playing') continue;
      const entry: Paused = { touched: false, unwatch: () => {} };
      // Watched before the pause, so no change of the user's is missed. Paused is the one change
      // the call makes itself.
      entry.unwatch = await bus
        .watch(player.name, (status) => {
          if (status !== 'Paused') entry.touched = true;
        })
        .catch(() => () => {});
      try {
        await bus.pause(player.name);
        paused.set(player.name, entry);
      } catch (error) {
        entry.unwatch();
        quiet(`pause ${player.name}`)(error);
      }
    }
  }

  async function callEnded(paused: Map<string, Paused>): Promise<void> {
    state = { kind: 'idle' };
    for (const [name, entry] of paused) {
      entry.unwatch();
      if (entry.touched || (await bus.status(name).catch(() => undefined)) !== 'Paused') continue;
      await bus.play(name).catch(quiet(`resume ${name}`));
    }
  }

  return {
    update(inCall) {
      work = work.then(() => {
        if (inCall && state.kind === 'idle') return callStarted();
        if (!inCall && state.kind === 'call') return callEnded(state.paused);
        return undefined;
      });
    },
    idle: () => work,
    stop() {
      if (state.kind === 'call') for (const entry of state.paused.values()) entry.unwatch();
      bus.close();
    },
  };
}

const MPRIS = 'org.mpris.MediaPlayer2.';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const OBJECT = '/org/mpris/MediaPlayer2';

interface Variant {
  readonly value: unknown;
}
interface Properties {
  Get(iface: string, name: string): Promise<Variant>;
  on(event: 'PropertiesChanged', listener: (iface: string, changed: Record<string, Variant>) => void): void;
  off(event: 'PropertiesChanged', listener: (iface: string, changed: Record<string, Variant>) => void): void;
}
interface Bus {
  getProxyObject(name: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  on(event: 'error', listener: (error: Error) => void): void;
  disconnect(): void;
}

/**
 * A player of its own. playerctld is a stand-in that passes Play and Pause on to whichever player
 * was used last, so pausing and playing it as well could start a player the call never paused.
 */
export const isOwnPlayer = (busName: string) => busName.startsWith(MPRIS) && !busName.startsWith(`${MPRIS}playerctld`);

const statusOf = (value: unknown): PlaybackStatus | undefined => (value === 'Playing' || value === 'Paused' || value === 'Stopped' ? value : undefined);

/** MPRIS over the session bus, through dbus-next. */
export async function sessionMediaBus(): Promise<MediaBus> {
  const { sessionBus } = await import('dbus-next');
  const bus = sessionBus() as unknown as Bus;
  // A bus that goes away fails the calls in flight; unheard, its error would end the app.
  bus.on('error', quiet('stay on the session bus'));
  const iface = async <T>(name: string, path: string, of: string) => (await bus.getProxyObject(name, path)).getInterface(of) as T;
  const status = async (name: string) =>
    statusOf((await (await iface<Properties>(name, OBJECT, 'org.freedesktop.DBus.Properties')).Get(PLAYER, 'PlaybackStatus')).value);
  const call = async (name: string, method: 'Pause' | 'Play') => (await iface<Record<typeof method, () => Promise<void>>>(name, OBJECT, PLAYER))[method]();
  return {
    async players() {
      const dbus = await iface<{ ListNames(): Promise<string[]> }>('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus');
      const names = (await dbus.ListNames()).filter(isOwnPlayer);
      const found = await Promise.all(names.map(async (name) => ({ name, status: await status(name).catch(() => undefined) })));
      return found.filter((player): player is { name: string; status: PlaybackStatus } => player.status !== undefined);
    },
    status: (name) => status(name).catch(() => undefined),
    pause: (name) => call(name, 'Pause'),
    play: (name) => call(name, 'Play'),
    async watch(name, onStatus) {
      const props = await iface<Properties>(name, OBJECT, 'org.freedesktop.DBus.Properties');
      const listener = (changedIface: string, changed: Record<string, Variant>) => {
        const next = changedIface === PLAYER ? statusOf(changed.PlaybackStatus?.value) : undefined;
        if (next) onStatus(next);
      };
      props.on('PropertiesChanged', listener);
      return () => props.off('PropertiesChanged', listener);
    },
    close: () => bus.disconnect(),
  };
}

/** Pausing for calls where MPRIS exists (Linux), and nothing elsewhere. */
export async function startMediaPause(): Promise<MediaPause> {
  if (process.platform !== 'linux') return { update() {}, idle: () => Promise.resolve(), stop() {} };
  try {
    return createMediaPause(await sessionMediaBus());
  } catch (error) {
    quiet('reach the session bus')(error);
    return { update() {}, idle: () => Promise.resolve(), stop() {} };
  }
}
