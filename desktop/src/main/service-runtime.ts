import { BrowserWindow, Menu, WebContentsView, clipboard, session, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { join } from 'node:path';
import { Channel, type ServiceStatus } from '../shared/ipc.ts';
import { partitionFor, type ServiceDefinition } from '../shared/services.ts';
import { NO_UNREAD, parseCounterReading, sameUnread, unreadFromPage, type CounterReading, type Unread } from '../shared/unread.ts';
import { decideNavigation, decidePopupNavigation, decideWindowOpen, isExternalSafe, popupTitle, type PageNavigation } from './navigation.ts';
import { openExternal } from './open-external.ts';
import { allowPermission } from './permissions.ts';
import { handleScreenShare } from './screen-share.ts';
import { firefoxUserAgent } from './user-agent.ts';
import { nextStatus, type PageEvent } from './service-status.ts';

export interface ServiceRuntime {
  /** The service as it is now: Streamroom's address follows the server chosen in its menu. */
  readonly service: ServiceDefinition;
  /** The page's view; none while the service hibernates. */
  view(): WebContentsView | undefined;
  /** The call a call-window service (`callWindow`) has open, shown over its page until it ends. */
  call(): WebContentsView | undefined;
  /** Whether the call shows rather than the page. A new call shows. */
  callInFront(): boolean;
  /** Shows the call, or the page under it. Does nothing without a call. */
  setCallInFront(inFront: boolean): void;
  status(): ServiceStatus;
  unread(): Unread;
  /** Whether the page is in HTML fullscreen (a video or stream), so the view should cover the window. */
  fullscreen(): boolean;
  /** Loads the start page again, from scratch. Does nothing while hibernating. */
  restart(): void;
  /** Does nothing while hibernating. `ignoreCache` fetches every file again (a hard reload). */
  reload(ignoreCache?: boolean): void;
  /** Closes the page and its popups, ending its renderer process; the login stays. */
  hibernate(): void;
  /** A new page on the start page. Does nothing unless hibernating. */
  wake(): void;
  /** Shows `url`, one of the service's own pages, waking the service first if needed. */
  open(url: string): void;
  /**
   * Stops the page, closes its popups, clears its login, cookies, storage and cache, then
   * restarts it. A hibernating service is wiped and stays asleep.
   */
  signOut(): Promise<void>;
  /**
   * Points the service at a new definition with the same id (Streamroom on another server). Its
   * rules apply at once; the page keeps what it shows until it loads again (restart, wake).
   */
  retarget(next: ServiceDefinition): void;
  /** The colour behind the page while it paints: the sidebar's, so a dark theme never flashes white. */
  setBackground(color: string): void;
}

export interface RuntimeOptions {
  readonly userAgent: string;
  readonly preload: string;
  /** Folder of the built local pages and their preloads (dist/). */
  readonly localDir: string;
  readonly background: string;
  /** Start without a page; the service wakes when asked. */
  readonly hibernated: boolean;
  readonly onChange: () => void;
  /**
   * A new view to place in the window: the page at startup and each time the service wakes, and
   * a call when one starts. A call goes over its page.
   */
  readonly onViewCreated: (view: WebContentsView) => void;
  /** The view is closing (the service hibernates, or its call ended); take it out of the window. */
  readonly onViewClosed: (view: WebContentsView) => void;
  /** A link leaving the service: another service may claim it, else it goes to the browser. */
  readonly openLink: (url: string) => void;
}

/** One service page: its own login partition, browser rules and load status. */
export function createServiceRuntime(initial: ServiceDefinition, options: RuntimeOptions): ServiceRuntime {
  let service = initial;
  const partition = partitionFor(service);
  const ses = session.fromPartition(partition);
  ses.setUserAgent(options.userAgent);
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const origin = 'securityOrigin' in details && details.securityOrigin ? details.securityOrigin : details.requestingUrl;
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(allowPermission(service, { permission, origin, mediaTypes }));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin, details) =>
    allowPermission(service, {
      permission,
      origin,
      mediaTypes: details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [],
    }),
  );
  // Google refuses to sign in inside an app it takes for an embedded Chrome. Its sign-in pages
  // get Firefox's user agent, without Chrome's client hints; the preload does the same in the page.
  if (service.googleSignIn) {
    const firefox = firefoxUserAgent(process.platform, new Date());
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, callback) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(details.requestHeaders)) if (!/^sec-ch-ua/i.test(name)) headers[name] = value;
      headers['User-Agent'] = firefox;
      callback({ requestHeaders: headers });
    });
  }
  if (service.calls) handleScreenShare(ses, (origin) => allowPermission(service, { permission: 'display-capture', origin, mediaTypes: [] }));

  let status: ServiceStatus = options.hibernated ? { kind: 'hibernated' } : { kind: 'loading' };
  let titleUnread: Unread = NO_UNREAD;
  let counter: CounterReading | undefined;
  let unread: Unread = NO_UNREAD;
  let fullscreen = false;
  /** Recomputes the unread count; a page that is not running has none. */
  const refreshUnread = () => {
    const next = status.kind === 'failed' || status.kind === 'hibernated' ? NO_UNREAD : unreadFromPage(titleUnread, counter);
    if (sameUnread(next, unread)) return false;
    unread = next;
    return true;
  };
  const apply = (event: PageEvent) => {
    const next = nextStatus(status, event);
    if (next === status) return;
    status = next;
    refreshUnread();
    options.onChange();
  };

  const popups = new Set<BrowserWindow>();
  let background = options.background;
  let view: WebContentsView | undefined;
  let call: WebContentsView | undefined;
  let callInFront = true;

  const pagePreferences = (): Electron.WebPreferences => ({
    partition,
    preload: service.localPage ? join(options.localDir, `preload-${service.localPage}.cjs`) : options.preload,
    // Tells the preload which service it is in (for its unread counter).
    additionalArguments: [`--kainos-service=${service.id}`, ...(service.googleSignIn ? [`--kainos-firefox=${firefoxUserAgent(process.platform, new Date())}`] : [])],
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // Hidden services must keep their connections alive so notifications keep arriving, and a
    // call keeps going while another tab is open.
    backgroundThrottling: false,
    spellcheck: true,
  });

  /** A page view with the service's rules. Its events count only while it is the service's view. */
  const createView = (): WebContentsView => {
    const created = new WebContentsView({ webPreferences: pagePreferences() });
    created.setBackgroundColor(background);
    const contents = created.webContents;
    const live = () => view === created;
    const applyLive = (event: PageEvent) => {
      if (live()) apply(event);
    };
    contents.on('did-start-navigation', (details) => {
      // A new document brings its own counter; until its preload reports, the title decides.
      if (live() && details.isMainFrame && !details.isSameDocument) counter = undefined;
      applyLive({ kind: 'start-navigation', url: details.url, isMainFrame: details.isMainFrame, isSameDocument: details.isSameDocument });
    });
    contents.on('dom-ready', () => applyLive({ kind: 'dom-ready' }));
    contents.on('did-stop-loading', () => applyLive({ kind: 'stop-loading' }));
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => applyLive({ kind: 'fail-load', code, description, url, isMainFrame }));
    contents.on('render-process-gone', (_event, details) => applyLive({ kind: 'gone', reason: details.reason, host: new URL(service.url).host }));
    contents.on('page-title-updated', (_event, title) => {
      if (!live()) return;
      titleUnread = service.unread(title);
      if (refreshUnread()) options.onChange();
    });
    contents.ipc.on(Channel.unreadCounter, (_event, raw: unknown) => {
      if (!live()) return;
      counter = parseCounterReading(raw);
      if (refreshUnread()) options.onChange();
    });
    // A page's "unsaved changes" prompt must not block Reload, Sign out or Hibernate; the app has no way to show it.
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    const setFullscreen = (on: boolean) => {
      if (!live()) return;
      fullscreen = on;
      options.onChange();
    };
    contents.on('enter-html-full-screen', () => setFullscreen(true));
    contents.on('leave-html-full-screen', () => setFullscreen(false));

    guardNavigation(contents, (url) => decideNavigation(service, url));

    contents.setWindowOpenHandler(({ url, frameName }) => {
      // Vencord's QuickCSS editor: a blank popup it fills itself, with its editor from the extension.
      if (service.clientMod === 'vencord' && url === 'about:blank' && frameName === 'VencordQuickCss') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1000,
            height: 760,
            autoHideMenuBar: true,
            backgroundColor: '#1e1e1e',
            webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false },
          },
        };
      }
      const decision = decideWindowOpen(service, url);
      if (decision === 'external') options.openLink(url);
      // One call at a time, and only from the page on screen.
      if (decision === 'call' && live() && !call) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { backgroundColor: background, webPreferences: pagePreferences() },
          // Electron hands over the new page in `webContents`, which its types leave out.
          createWindow: (created) => openCall(new WebContentsView({ webContents: (created as { webContents: WebContents }).webContents, webPreferences: pagePreferences() })),
        };
      }
      if (decision !== 'popup') return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: options.background,
          webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    });
    contents.on('did-create-window', (popup: BrowserWindow) => {
      popups.add(popup);
      popup.once('closed', () => popups.delete(popup));
      popup.setMenu(null);
      const popupContents = popup.webContents;
      const showHost = (title = popupContents.getTitle()) => popup.setTitle(popupTitle(popupContents.getURL(), title));
      popupContents.on('page-title-updated', (event, title) => {
        event.preventDefault();
        showHost(title);
      });
      popupContents.on('did-navigate', () => showHost());
      popupContents.on('will-prevent-unload', (event) => event.preventDefault());
      // A popup that heads anywhere else has done its job: the page opens in the browser instead.
      guardNavigation(popupContents, (url) => decidePopupNavigation(service, url), () => setImmediate(() => popup.close()));
      popupContents.setWindowOpenHandler(({ url }) => {
        if (decideWindowOpen(service, url) !== 'block') options.openLink(url);
        return { action: 'deny' };
      });
    });
    contents.on('context-menu', (_event, params) => showPageMenu(contents, params));
    return created;
  };

  /**
   * A call the page opened in a window of its own, shown over the page instead. It ends when its
   * page closes itself (hanging up), or with the page (hibernate, sign out).
   */
  const openCall = (created: WebContentsView): WebContents => {
    call = created;
    callInFront = true;
    created.setBackgroundColor(background);
    const contents = created.webContents;
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('enter-html-full-screen', () => {
      fullscreen = true;
      options.onChange();
    });
    contents.on('leave-html-full-screen', () => {
      fullscreen = false;
      options.onChange();
    });
    // A call that heads anywhere else is over: the page opens in the browser instead.
    guardNavigation(contents, (url) => decidePopupNavigation(service, url), () => setImmediate(endCall));
    contents.setWindowOpenHandler(({ url }) => {
      if (decideWindowOpen(service, url) !== 'block') options.openLink(url);
      return { action: 'deny' };
    });
    contents.on('context-menu', (_event, params) => showPageMenu(contents, params));
    contents.once('destroyed', () => {
      if (call !== created) return;
      call = undefined;
      fullscreen = false;
      options.onViewClosed(created);
      options.onChange();
    });
    options.onViewCreated(created);
    options.onChange();
    return contents;
  };
  const endCall = () => {
    if (call && !call.webContents.isDestroyed()) call.webContents.close({ waitForBeforeUnload: false });
  };

  const guardNavigation = (target: WebContents, decide: (url: string) => PageNavigation, onExternal = () => {}) => {
    const onNavigate = (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
      if (!event.isMainFrame) return;
      const decision = decide(event.url);
      if (decision === 'stay') return;
      event.preventDefault();
      if (decision === 'external') {
        options.openLink(event.url);
        onExternal();
      }
    };
    target.on('will-navigate', onNavigate);
    target.on('will-redirect', onNavigate);
  };

  /** Loads `url` (a website's start page by default) into the page there is. */
  const load = (url?: string) => {
    const contents = view?.webContents;
    if (!contents) return;
    apply({ kind: 'restart' });
    const loading = service.localPage ? contents.loadFile(join(options.localDir, 'renderer', `${service.localPage}.html`)) : contents.loadURL(url ?? service.url);
    loading.catch(() => {
      // did-fail-load already reported it.
    });
  };
  const restart = () => load();
  /** Set while sign-out wipes the login; a page asked for meanwhile opens once it is done. */
  let wiping = false;
  let afterWipe: { url: string | undefined } | undefined;
  const wake = (url?: string) => {
    if (view) return;
    if (wiping) {
      afterWipe = { url };
      return;
    }
    view = createView();
    options.onViewCreated(view);
    load(url);
  };
  if (!options.hibernated) wake();

  return {
    get service() {
      return service;
    },
    view: () => view,
    call: () => call,
    callInFront: () => call !== undefined && callInFront,
    setCallInFront(inFront) {
      if (!call || inFront === callInFront) return;
      callInFront = inFront;
      options.onChange();
    },
    status: () => status,
    unread: () => unread,
    fullscreen: () => fullscreen,
    restart,
    reload: (ignoreCache = false) => {
      if (!view) return;
      if (status.kind !== 'ready') restart();
      else if (ignoreCache) view.webContents.reloadIgnoringCache();
      else view.webContents.reload();
    },
    hibernate() {
      const closing = view;
      if (!closing) return;
      view = undefined;
      for (const popup of popups) popup.destroy();
      endCall();
      options.onViewClosed(closing);
      // Closing the page ends its renderer process, which is where nearly all its memory is.
      if (!closing.webContents.isDestroyed()) closing.webContents.close({ waitForBeforeUnload: false });
      status = { kind: 'hibernated' };
      titleUnread = NO_UNREAD;
      counter = undefined;
      fullscreen = false;
      refreshUnread();
      options.onChange();
    },
    wake: () => wake(),
    open(url) {
      if (wiping) afterWipe = { url };
      else if (view) load(url);
      else wake(url);
    },
    async signOut() {
      wiping = true;
      // Stop everything that could write the login back (unload handlers, timers, popups)
      // before wiping, or a page can restore its token after the wipe.
      for (const popup of popups) popup.destroy();
      endCall();
      const page = view;
      if (page) await page.webContents.loadURL('about:blank').catch(() => {});
      titleUnread = NO_UNREAD;
      counter = undefined;
      refreshUnread();
      try {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.clearAuthCache();
      } finally {
        wiping = false;
        const next = afterWipe;
        afterWipe = undefined;
        // Even after a failed wipe, bring the service back rather than leave a blank page; a
        // service asked to wake or open a link during the wipe does so now, signed out.
        if (view && (view === page || next)) load(next?.url);
        else if (!view && next) wake(next.url);
      }
    },
    retarget(next) {
      if (next.id !== service.id) throw new Error(`retarget: ${next.id} is not ${service.id}`);
      service = next;
    },
    setBackground: (color) => {
      background = color;
      view?.setBackgroundColor(color);
      call?.setBackgroundColor(color);
    },
  };
}

/** Right-click inside a service page: edit actions and links. */
function showPageMenu(contents: WebContents, params: Electron.ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  if (params.linkURL && isExternalSafe(params.linkURL)) {
    items.push(
      { label: 'Open link in browser', click: () => openExternal(params.linkURL) },
      { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  for (const suggestion of params.dictionarySuggestions.slice(0, 4)) {
    items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
  }
  if (params.dictionarySuggestions.length) items.push({ type: 'separator' });
  const can = params.editFlags;
  if (params.isEditable) {
    items.push(
      { label: 'Cut', enabled: can.canCut, click: () => contents.cut() },
      { label: 'Copy', enabled: can.canCopy, click: () => contents.copy() },
      { label: 'Paste', enabled: can.canPaste, click: () => contents.paste() },
      { label: 'Select all', enabled: can.canSelectAll, click: () => contents.selectAll() },
    );
  } else if (params.selectionText) {
    items.push({ label: 'Copy', click: () => contents.copy() });
  }
  while (items.at(-1)?.type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup();
}
