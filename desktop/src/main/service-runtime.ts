import { BrowserWindow, Menu, WebContentsView, clipboard, session, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { join } from 'node:path';
import { Channel, type ServiceStatus } from '../shared/ipc.ts';
import { partitionFor, type ServiceDefinition } from '../shared/services.ts';
import { NO_UNREAD, parseCounterReading, sameUnread, unreadFromPage, type CounterReading, type Unread } from '../shared/unread.ts';
import { decideNavigation, decidePopupNavigation, decideWindowOpen, isExternalSafe, popupTitle, type PageNavigation } from './navigation.ts';
import { openExternal } from './open-external.ts';
import { allowPermission } from './permissions.ts';
import { nextStatus, type PageEvent } from './service-status.ts';

export interface ServiceRuntime {
  readonly service: ServiceDefinition;
  readonly view: WebContentsView;
  status(): ServiceStatus;
  unread(): Unread;
  /** Whether the page is in HTML fullscreen (a video or stream), so the view should cover the window. */
  fullscreen(): boolean;
  /** Loads the start page again, from scratch. */
  restart(): void;
  reload(): void;
  /** Stops the page, closes its popups, clears its login, cookies, storage and cache, then restarts it. */
  signOut(): Promise<void>;
  /** The colour behind the page while it paints: the sidebar's, so a dark theme never flashes white. */
  setBackground(color: string): void;
}

export interface RuntimeOptions {
  readonly userAgent: string;
  readonly preload: string;
  /** Folder of the built local pages and their preloads (dist/). */
  readonly localDir: string;
  readonly background: string;
  readonly onChange: () => void;
}

/** One service page: its own login partition, browser rules and load status. */
export function createServiceRuntime(service: ServiceDefinition, options: RuntimeOptions): ServiceRuntime {
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

  let status: ServiceStatus = { kind: 'loading' };
  let titleUnread: Unread = NO_UNREAD;
  let counter: CounterReading | undefined;
  let unread: Unread = NO_UNREAD;
  let fullscreen = false;
  /** Recomputes the unread count; a page that is not running has none. */
  const refreshUnread = () => {
    const next = status.kind === 'failed' ? NO_UNREAD : unreadFromPage(titleUnread, counter);
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

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: service.localPage ? join(options.localDir, `preload-${service.localPage}.cjs`) : options.preload,
      // Tells the preload which service it is in (for its unread counter).
      additionalArguments: [`--kainos-service=${service.id}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Hidden services must keep their connections alive so notifications keep arriving.
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  view.setBackgroundColor(background);
  const contents = view.webContents;
  contents.on('did-start-navigation', (details) => {
    // A new document brings its own counter; until its preload reports, the title decides.
    if (details.isMainFrame && !details.isSameDocument) counter = undefined;
    apply({ kind: 'start-navigation', url: details.url, isMainFrame: details.isMainFrame, isSameDocument: details.isSameDocument });
  });
  contents.on('dom-ready', () => apply({ kind: 'dom-ready' }));
  contents.on('did-stop-loading', () => apply({ kind: 'stop-loading' }));
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => apply({ kind: 'fail-load', code, description, url, isMainFrame }));
  contents.on('render-process-gone', (_event, details) => apply({ kind: 'gone', reason: details.reason, host: new URL(service.url).host }));
  contents.on('page-title-updated', (_event, title) => {
    titleUnread = service.unread(title);
    if (refreshUnread()) options.onChange();
  });
  contents.ipc.on(Channel.unreadCounter, (_event, raw: unknown) => {
    counter = parseCounterReading(raw);
    if (refreshUnread()) options.onChange();
  });
  // A page's "unsaved changes" prompt must not block Reload or Sign out; the app has no way to show it.
  contents.on('will-prevent-unload', (event) => event.preventDefault());
  const setFullscreen = (on: boolean) => {
    fullscreen = on;
    options.onChange();
  };
  contents.on('enter-html-full-screen', () => setFullscreen(true));
  contents.on('leave-html-full-screen', () => setFullscreen(false));

  const guardNavigation = (target: WebContents, decide: (url: string) => PageNavigation, onExternal = () => {}) => {
    const onNavigate = (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
      if (!event.isMainFrame) return;
      const decision = decide(event.url);
      if (decision === 'stay') return;
      event.preventDefault();
      if (decision === 'external') {
        openExternal(event.url);
        onExternal();
      }
    };
    target.on('will-navigate', onNavigate);
    target.on('will-redirect', onNavigate);
  };
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
    if (decision === 'external') openExternal(url);
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
      if (decideWindowOpen(service, url) !== 'block') openExternal(url);
      return { action: 'deny' };
    });
  });
  contents.on('context-menu', (_event, params) => showPageMenu(contents, params));
  const restart = () => {
    apply({ kind: 'restart' });
    const load = service.localPage ? contents.loadFile(join(options.localDir, 'renderer', `${service.localPage}.html`)) : contents.loadURL(service.url);
    load.catch(() => {
      // did-fail-load already reported it.
    });
  };
  restart();

  return {
    service,
    view,
    status: () => status,
    unread: () => unread,
    fullscreen: () => fullscreen,
    restart,
    reload: () => (status.kind === 'ready' ? contents.reload() : restart()),
    async signOut() {
      // Stop everything that could write the login back (unload handlers, timers, popups)
      // before wiping, or a page can restore its token after the wipe.
      for (const popup of popups) popup.destroy();
      await contents.loadURL('about:blank').catch(() => {});
      titleUnread = NO_UNREAD;
      counter = undefined;
      refreshUnread();
      try {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.clearAuthCache();
      } finally {
        // Even after a failed wipe, bring the service back rather than leave a blank page.
        restart();
      }
    },
    setBackground: (color) => {
      background = color;
      view.setBackgroundColor(color);
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
