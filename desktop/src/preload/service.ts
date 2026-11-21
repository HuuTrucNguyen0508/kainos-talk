// Preload for each service page. It routes the page's web notifications through Kainos Talk,
// so muting works and clicking one opens the right service (Electron gives the main process no
// other hook into a page's notifications), reads the page's own unread counter for services
// that have one, says whether the page has a call going (so it is never hibernated mid-call), and
// reports the pointer at the bottom edge for the auto-hiding dock.
import { contextBridge, ipcRenderer } from 'electron';
import { Channel, type NotificationRequest } from '../shared/ipc.ts';
import { findService } from '../shared/services.ts';
import type { CounterReading } from '../shared/unread.ts';
import { reportBottomEdge } from './bottom-edge.ts';

interface Bridge {
  show(request: Omit<NotificationRequest, 'id'>): number;
  close(id: number): void;
  onClose(listener: (id: number) => void): void;
  onClick(listener: (id: number) => void): void;
}

// Ids start at a random point for each page load, so a notification from before a reload is
// never mistaken for a new one with the same number. 2^40 leaves room under 2^53.
let nextId = Math.floor(Math.random() * 2 ** 40);
const bridge: Bridge = {
  show(request) {
    const id = ++nextId;
    ipcRenderer.send(Channel.notificationShow, { ...request, id });
    return id;
  },
  close: (id) => ipcRenderer.send(Channel.notificationClose, id),
  onClose: (listener) => ipcRenderer.on(Channel.notificationClose, (_event, id: number) => listener(id)),
  onClick: (listener) => ipcRenderer.on(Channel.notificationClick, (_event, id: number) => listener(id)),
};

/**
 * Runs in the page's own world, so it must not use anything from this module's scope.
 * Replaces window.Notification and ServiceWorkerRegistration.showNotification with versions
 * that hand the notification to Kainos Talk. Permission still comes from the real API.
 */
function installNotificationShim(bridge: Bridge): void {
  const Native = window.Notification;
  type Handler = ((this: KainosNotification, event: Event) => unknown) | null;

  class KainosNotification extends EventTarget {
    static readonly maxActions = 0;
    static get permission(): NotificationPermission {
      return Native ? Native.permission : 'denied';
    }
    static requestPermission(callback?: NotificationPermissionCallback): Promise<NotificationPermission> {
      const result = Native ? Native.requestPermission() : Promise.resolve<NotificationPermission>('denied');
      if (callback) void result.then(callback);
      return result;
    }
    static readonly live = new Map<number, KainosNotification>();
    static ended(id: number): void {
      const item = KainosNotification.live.get(id);
      if (!item) return;
      KainosNotification.live.delete(id);
      item.fire('close');
    }
    static click(id: number): void {
      KainosNotification.live.get(id)?.fire('click');
    }

    onclick: Handler = null;
    onshow: Handler = null;
    onclose: Handler = null;
    onerror: Handler = null;
    readonly title: string;
    readonly body: string;
    readonly icon: string;
    readonly tag: string;
    readonly data: unknown;
    readonly silent: boolean;
    private readonly id: number = 0;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = String(title);
      this.body = String(options.body ?? '');
      this.tag = String(options.tag ?? '');
      this.data = options.data;
      this.silent = options.silent === true;
      let icon = '';
      try {
        icon = options.icon ? new URL(options.icon, location.href).href : '';
      } catch {
        // Unreadable icon: show the notification without one.
      }
      this.icon = icon;
      if (KainosNotification.permission !== 'granted') {
        queueMicrotask(() => this.fire('error'));
        return;
      }
      this.id = bridge.show({ title: this.title, body: this.body, icon, tag: this.tag, silent: this.silent });
      KainosNotification.live.set(this.id, this);
      queueMicrotask(() => this.fire('show'));
    }

    close(): void {
      if (!KainosNotification.live.delete(this.id)) return;
      bridge.close(this.id);
      this.fire('close');
    }

    private fire(type: 'show' | 'click' | 'close' | 'error'): void {
      const event = new Event(type, { cancelable: true });
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
      this.dispatchEvent(event);
    }
  }

  bridge.onClose((id) => KainosNotification.ended(id));
  bridge.onClick((id) => KainosNotification.click(id));
  Object.defineProperty(window, 'Notification', { value: KainosNotification, writable: true, configurable: true });
  const registration = window.ServiceWorkerRegistration?.prototype;
  if (registration) {
    registration.showNotification = function showNotification(title: string, options?: NotificationOptions) {
      new KainosNotification(title, options);
      return Promise.resolve();
    };
  }
}

contextBridge.executeInMainWorld({ func: installNotificationShim, args: [bridge] });

/** Main passes the service id as --kainos-service=<id>, and Firefox's user agent for Google's sign-in. */
const serviceId = process.argv.find((arg) => arg.startsWith('--kainos-service='))?.slice('--kainos-service='.length);
const firefox = process.argv.find((arg) => arg.startsWith('--kainos-firefox='))?.slice('--kainos-firefox='.length);

/**
 * Runs in the page's own world. Makes Google's sign-in page see Firefox, as its requests already
 * do (main rewrites their headers): the user agent, and no Chrome-only userAgentData.
 */
function presentAsFirefox(userAgent: string): void {
  const nav = Navigator.prototype;
  const define = (name: string, value: unknown) => Object.defineProperty(nav, name, { get: () => value, configurable: true });
  define('userAgent', userAgent);
  define('appVersion', userAgent.slice('Mozilla/'.length));
  define('vendor', '');
  define('userAgentData', undefined);
}
if (firefox && findService(serviceId)?.googleSignIn && location.hostname === 'accounts.google.com') {
  contextBridge.executeInMainWorld({ func: presentAsFirefox, args: [firefox] });
}

const counter = findService(serviceId)?.unreadCounter;
if (counter) {
  let last = '';
  setInterval(() => {
    const reading: CounterReading = {
      scope: document.querySelector(counter.scope) !== null,
      text: document.querySelector(counter.count)?.textContent ?? null,
    };
    const key = JSON.stringify(reading);
    if (key === last) return;
    last = key;
    ipcRenderer.send(Channel.unreadCounter, reading);
  }, 1500);
}

/**
 * Runs in the page's own world, so it must not use anything from this module's scope. Keeps the
 * camera, microphone and screen tracks the page opens and the peer connections it makes, and
 * says whether any is going: a page in a call or sharing its screen must stay awake. Busy is
 * reported at once (a request for a capture, a peer connecting); idle on the next check, since
 * a stopped track tells nobody.
 */
function watchCalls(report: (busy: boolean) => void, everyMs: number): void {
  const tracks = new Set<MediaStreamTrack>();
  const peers = new Set<RTCPeerConnection>();
  /** Capture requests still waiting for an answer, such as an open screen picker. */
  let asking = 0;
  let last = false;
  const check = () => {
    for (const track of tracks) if (track.readyState === 'ended') tracks.delete(track);
    for (const peer of peers) if (peer.connectionState === 'closed') peers.delete(peer);
    // A failed peer may still restart; a disconnected one is reconnecting, so it counts.
    const busy = asking > 0 || tracks.size > 0 || [...peers].some((peer) => ['connecting', 'connected', 'disconnected'].includes(peer.connectionState));
    if (busy === last) return;
    last = busy;
    report(busy);
  };
  const devices = window.MediaDevices?.prototype;
  for (const name of ['getUserMedia', 'getDisplayMedia'] as const) {
    const native = devices?.[name];
    if (!devices || typeof native !== 'function') continue;
    devices[name] = function (this: MediaDevices, ...args: Parameters<typeof native>) {
      asking++;
      check();
      return native.apply(this, args).then(
        (stream: MediaStream) => {
          for (const track of stream.getTracks()) tracks.add(track);
          asking--;
          check();
          return stream;
        },
        (error: unknown) => {
          asking--;
          check();
          throw error;
        },
      );
    } as typeof native;
  }
  const Peer = window.RTCPeerConnection;
  if (Peer) {
    // A proxy, not a subclass: instanceof, the prototype and the static methods stay the page's own.
    window.RTCPeerConnection = new Proxy(Peer, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        peers.add(peer);
        peer.addEventListener('connectionstatechange', check);
        return peer;
      },
    });
  }
  setInterval(check, everyMs);
}

contextBridge.executeInMainWorld({ func: watchCalls, args: [(busy: boolean) => ipcRenderer.send(Channel.pageBusy, busy), 2000] });

reportBottomEdge();
