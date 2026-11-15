import { Notification, app, ipcMain, nativeImage, type NativeImage, type Session, type WebContents } from 'electron';
import { Channel } from '../shared/ipc.ts';
import { iconAllowed, parseNotificationRequest } from '../shared/notification-request.ts';
import { IconCache } from './icon-cache.ts';
import { NotificationBook } from './notification-book.ts';
import type { ServiceRuntime } from './service-runtime.ts';

const MAX_ICON_BYTES = 512 * 1024;

export interface NotificationHost {
  runtimeFor(contents: WebContents): ServiceRuntime | undefined;
  isMuted(serviceId: string): boolean;
  /** Brings the window forward on the service. */
  focusService(serviceId: string): void;
  readonly fallbackIcon: NativeImage;
}

/** Reads at most `limit` bytes; undefined if the body is longer. */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

/**
 * A sender's avatar, fetched only from the service's own image hosts: no cookies, no redirects,
 * at most 512 KB, within 3 s. Anything else gets the app icon.
 */
async function fetchIcon(ses: Session, iconHosts: readonly string[], url: string): Promise<NativeImage | undefined> {
  if (!iconAllowed(iconHosts, url)) return undefined;
  try {
    const response = await ses.fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(3000) });
    if (!response.ok || !response.body) return undefined;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_ICON_BYTES) return undefined;
    const bytes = await readCapped(response.body, MAX_ICON_BYTES);
    if (!bytes) return undefined;
    const image = nativeImage.createFromBuffer(bytes);
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
}

const iconCaches = new WeakMap<Session, IconCache<NativeImage>>();
function loadIcon(ses: Session, hosts: readonly string[], url: string): Promise<NativeImage | undefined> {
  if (!iconAllowed(hosts, url)) return Promise.resolve(undefined);
  let cache = iconCaches.get(ses);
  if (!cache) {
    cache = new IconCache<NativeImage>();
    iconCaches.set(ses, cache);
  }
  return cache.get(url, () => fetchIcon(ses, hosts, url));
}

/**
 * Shows page notifications as native ones, unless the service is muted. Clicking one opens
 * the service and passes the click back to the page, so it can open the right chat.
 * Each one emits an app 'kainos-notification' event, which the smoke test listens to.
 */
export function forwardNotifications(host: NotificationHost): void {
  const book = new NotificationBook<{ close(): void }>();

  ipcMain.on(Channel.notificationShow, async (event, raw: unknown) => {
    const runtime = host.runtimeFor(event.sender);
    const request = parseNotificationRequest(raw);
    if (!runtime || !request) return;
    const serviceId = runtime.service.id;
    const muted = host.isMuted(serviceId);
    const contents = event.sender;
    let ended = false;
    const closePage = () => {
      if (ended) return;
      ended = true;
      if (!contents.isDestroyed()) contents.send(Channel.notificationClose, request.id);
    };
    if (muted || !Notification.isSupported()) {
      closePage();
      app.emit('kainos-notification', { serviceId, muted, notification: undefined });
      return;
    }
    const sender = contents.id;
    book.begin(sender, request.id);
    const icon = (await loadIcon(contents.session, runtime.service.iconHosts, request.icon)) ?? host.fallbackIcon;
    const notification = new Notification({ title: request.title, body: request.body, silent: request.silent, icon });
    const item = {
      close: () => {
        notification.close();
        book.ended(sender, request.id, item);
        closePage();
      },
    };
    notification.on('close', () => {
      book.ended(sender, request.id, item);
      closePage();
    });
    if (!book.show(sender, request.id, request.tag, item)) {
      closePage();
      return;
    }
    notification.on('click', () => {
      host.focusService(serviceId);
      if (!contents.isDestroyed()) contents.send(Channel.notificationClick, request.id);
    });
    notification.show();
    app.emit('kainos-notification', { serviceId, muted, notification });
  });

  ipcMain.on(Channel.notificationClose, (event, id: unknown) => {
    if (typeof id === 'number') book.close(event.sender.id, id);
  });
}
