// Preload for each service page. It routes the page's web notifications through Kainos Talk,
// so muting works and clicking one opens the right service (Electron gives the main process no
// other hook into a page's notifications), reads the page's own unread counter for services
// that have one, and reports the pointer at the bottom edge for the auto-hiding dock.
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

/** Main passes the service id as --kainos-service=<id>. */
const serviceId = process.argv.find((arg) => arg.startsWith('--kainos-service='))?.slice('--kainos-service='.length);
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

reportBottomEdge();
