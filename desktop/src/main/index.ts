import { BaseWindow, Menu, Notification, Tray, WebContentsView, app, dialog, ipcMain, nativeImage, nativeTheme, protocol, screen, session, type IpcMainEvent, type WebContents } from 'electron';
import { join } from 'node:path';
import { Channel, parseMenuPoint, type MenuPoint, type Snapshot } from '../shared/ipc.ts';
import { SERVICES, findService, partitionFor } from '../shared/services.ts';
import { NO_UNREAD, totalUnread, unreadLabel, windowTitle, type Unread } from '../shared/unread.ts';
import { markPng } from './app-icon.ts';
import { DEFAULT_SIZE, MIN_SIZE, fitToDisplays, loadAppState, saveAppState, type AppState } from './app-state.ts';
import { layoutBar, parsePointerEdge, resolveSide, type SidePreference } from './bar.ts';
import { forwardNotifications } from './notifications.ts';
import { startVencord } from './vencord.ts';
import { watchScreenSide } from './screen-side.ts';
import { startSmsSync } from './sms-sync.ts';
import { IMAGE_SCHEME, SmsChannel } from '../shared/sms.ts';
import type { SourceId } from '../shared/sync-protocol.ts';

/** How long a website may stay out of sight before it sleeps (KAINOS_SLEEP_AFTER_MS for tests). */
const SLEEP_AFTER_MS = Number(process.env.KAINOS_SLEEP_AFTER_MS) || 15 * 60_000;

const isMirroredWebsite = (id: string) => Object.values(WEBSITE_FOR_SOURCE).includes(id);

/** The website each phone source has in the bar, if any. */
const WEBSITE_FOR_SOURCE: Record<SourceId, string | null> = {
  whatsapp: 'whatsapp',
  'whatsapp-business': null,
  discord: 'discord',
  messenger: 'messenger',
  sms: null,
  protonmail: 'proton-mail',
};
import { createServiceRuntime, type ServiceRuntime } from './service-runtime.ts';
import { shortcutFor } from './shortcuts.ts';
import { trayHostPresent } from './tray-host.ts';
import { chromeUserAgent } from './user-agent.ts';

const APP_NAME = 'Kainos Talk';
/** The sidebar's --rail colour, so the window never flashes white while it loads. */
const RAIL_BACKGROUND = { light: '#DDE4E1', dark: '#162024' };
/** The sidebar's --surface colour, behind a service page until it paints. */
const SURFACE_BACKGROUND = { light: '#F6F8F7', dark: '#0E1619' };

app.setName(APP_NAME);
if (process.env.KAINOS_USER_DATA) app.setPath('userData', process.env.KAINOS_USER_DATA);
// Popups and workers use this too, so nothing a service sees names Electron.
app.userAgentFallback = chromeUserAgent(process.platform, process.versions.chrome);
if (process.platform === 'win32') app.setAppUserModelId('app.kainos.talk');
// Never hand a TLS client certificate to a site: none of the services needs one, and without
// this handler Electron sends the first matching certificate without asking.
app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
  event.preventDefault();
  callback();
});

// The inbox page's pictures; only the inbox's session gets a handler for it.
protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } }]);

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(start, (error: unknown) => {
    console.error(error);
    app.exit(1);
  });
} else {
  app.quit();
}

function themeBackground(colors = RAIL_BACKGROUND): string {
  return nativeTheme.shouldUseDarkColors ? colors.dark : colors.light;
}

async function start(): Promise<void> {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const serviceIds = SERVICES.map((service) => service.id);
  const statePath = join(app.getPath('userData'), 'kainos-state.json');
  let state: AppState = loadAppState(statePath, serviceIds);
  const icons = { plain: nativeImage.createFromBuffer(markPng(64, false)), lamp: nativeImage.createFromBuffer(markPng(64, true)) };

  const saved = state.bounds && fitToDisplays(state.bounds, screen.getAllDisplays().map((display) => display.workArea));
  const win = new BaseWindow({
    ...(saved ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: APP_NAME,
    icon: nativeImage.createFromBuffer(markPng(256, false)),
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
  });

  // The sidebar page (the bar, plus the notice while a service loads or fails) is a view above
  // the services, so an auto-hidden bar can slide out over the page's edge.
  const chrome = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'preload-app.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // Transparent, so the bar can slide in over the page beneath it.
  chrome.setBackgroundColor('#00000000');
  const sidebarContents = chrome.webContents;
  // The sidebar is local and never navigates or opens windows.
  sidebarContents.on('will-navigate', (event) => event.preventDefault());
  sidebarContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Before the service pages start loading, or Discord's first load runs without Vencord.
  await startVencord({
    dir: join(app.getPath('userData'), 'vencord'),
    services: SERVICES.filter((service) => service.clientMod === 'vencord'),
    onFirstInstall: () => {
      // An asleep Discord picks Vencord up when it wakes; reloading it would wake it now.
      for (const runtime of runtimes) if (runtime.service.clientMod === 'vencord' && runtime.status().kind !== 'asleep') runtime.reload();
    },
  });

  let runtimesReady = false;
  // The inbox: every conversation and mail from the phone, over the local network. It starts
  // before the service views, so the inbox page's first request finds it ready.
  const smsView = () => runtimes.find((runtime) => runtime.service.localPage === 'inbox')?.view.webContents;
  /** Shows a desktop notification for the inbox; a click opens that conversation or mail. */
  function notifyFromInbox(source: SourceId, key: string, title: string, body: string): void {
    const website = WEBSITE_FOR_SOURCE[source];
    // Muting the Inbox, or the source's own website, silences it.
    const muted = state.mutedServiceIds.includes('inbox') || (website !== null && state.mutedServiceIds.includes(website));
    if (muted || !Notification.isSupported()) {
      app.emit('kainos-notification', { serviceId: 'inbox', muted, notification: undefined });
      return;
    }
    const notification = new Notification({ title, body, icon: icons.plain });
    notification.on('click', () => {
      showWindow();
      activate('inbox');
      smsView()?.send(SmsChannel.openKey, key);
    });
    notification.show();
    app.emit('kainos-notification', { serviceId: 'inbox', muted, notification });
  }
  const sms = await startSmsSync({
    dir: join(app.getPath('userData'), 'sms-sync'),
    ...(process.env.KAINOS_SYNC_PORT && { port: Number(process.env.KAINOS_SYNC_PORT) }),
    advertise: process.env.KAINOS_SYNC_MDNS !== '0',
    onChange: () => {
      smsView()?.send(SmsChannel.state, sms.state());
      // Badges of asleep websites and the window title follow the inbox.
      if (runtimesReady) render();
    },
    onIncoming: (conversation, message) => {
      const who = conversation.isGroup && message.sender ? `${message.sender} in ${conversation.title}` : conversation.title;
      notifyFromInbox(conversation.source, conversation.key, `${who} · ${conversation.sourceLabel}`, message.text || 'Picture or attachment');
    },
    onMail: (mail) => notifyFromInbox(mail.source, mail.key, `${mail.sender ?? 'New mail'} · ${mail.sourceLabel}`, mail.subject),
  });
  // Pictures stay as bytes in main; the inbox page shows them by URL, and no other session can.
  session.fromPartition(partitionFor(SERVICES.find((service) => service.localPage === 'inbox')!)).protocol.handle(IMAGE_SCHEME, async (request) => {
    const picture = await sms.image(decodeURIComponent(new URL(request.url).pathname.slice(1)));
    return picture ? new Response(new Uint8Array(picture), { headers: { 'content-type': 'image/jpeg' } }) : new Response(null, { status: 404 });
  });
  const runtimes: ServiceRuntime[] = SERVICES.map((service) =>
    createServiceRuntime(service, {
      userAgent: app.userAgentFallback,
      preload: join(__dirname, 'preload-service.cjs'),
      localDir: __dirname,
      background: themeBackground(SURFACE_BACKGROUND),
      onChange: render,
      // Websites load when first opened, except the one open at last quit and those kept running.
      asleep: !service.localPage && service.id !== state.activeServiceId && !state.keepAwakeServiceIds.includes(service.id),
    }),
  );
  const runtimeById = (id: string) => runtimes.find((runtime) => runtime.service.id === id);
  runtimesReady = true;
  for (const runtime of runtimes) win.contentView.addChildView(runtime.view);
  win.contentView.addChildView(chrome);
  const screenSide = watchScreenSide(win, () => render());
  nativeTheme.on('updated', () => {
    win.setBackgroundColor(themeBackground());
    for (const runtime of runtimes) runtime.setBackground(themeBackground(SURFACE_BACKGROUND));
  });

  let tray: Tray | undefined;
  let quitting = false;

  const barSide = () => resolveSide(state.barSide, screenSide());

  /**
   * A website's badge: its page's own count while awake; while asleep, what the phone's inbox
   * has unread for it.
   */
  function unreadFor(runtime: ServiceRuntime): Unread {
    if (runtime.status().kind !== 'asleep') return runtime.unread();
    const inbox = sms.state();
    const mine = (source: SourceId) => WEBSITE_FOR_SOURCE[source] === runtime.service.id;
    const count =
      inbox.conversations.filter((c) => mine(c.source)).reduce((n, c) => n + c.unread, 0) +
      inbox.mails.filter((m) => mine(m.source) && !m.read).length;
    return count > 0 ? { kind: 'count', count } : NO_UNREAD;
  }

  /** The phone is paired and connected, so the inbox has every source's messages. */
  const mirrored = () => sms.state().phone?.connected === true;

  function snapshot(): Snapshot {
    return {
      activeId: state.activeServiceId,
      bar: { side: barSide(), autoHide: state.barAutoHide },
      services: runtimes.map((runtime) => ({
        id: runtime.service.id,
        name: runtime.service.name,
        color: runtime.service.icon.color,
        glyph: runtime.service.icon.glyph,
        status: runtime.status(),
        unread: unreadFor(runtime),
        muted: state.mutedServiceIds.includes(runtime.service.id),
      })),
    };
  }

  // Auto-hide: the bar comes out while the pointer is against its edge of the page or on the
  // bar itself, while it has keyboard focus (F6) and while one of its menus is open.
  let revealed = false;
  let pointerOnRail = false;
  let railFocused = false;
  let menuOpen = false;
  let hideTimer: NodeJS.Timeout | undefined;
  function reveal(): void {
    clearTimeout(hideTimer);
    if (!state.barAutoHide || revealed) return;
    revealed = true;
    render();
  }
  function hideSoon(delay = 300): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!revealed || pointerOnRail || railFocused || menuOpen) return;
      revealed = false;
      render();
    }, delay);
  }

  function layout(): void {
    const [width = 0, height = 0] = win.getContentSize();
    const active = runtimeById(state.activeServiceId);
    const placed = layoutBar({
      width,
      height,
      side: barSide(),
      autoHide: state.barAutoHide,
      revealed,
      // A service that is loading or failed stays hidden, so the sidebar page can show why.
      activeReady: active?.status().kind === 'ready',
      // A page in HTML fullscreen (a video, a stream) covers the bar too.
      activeFullscreen: active?.fullscreen() === true,
    });
    for (const runtime of runtimes) {
      runtime.view.setBounds(placed.service);
      runtime.view.setVisible(runtime === active && runtime.status().kind === 'ready');
    }
    if (placed.chrome) chrome.setBounds(placed.chrome);
    chrome.setVisible(placed.chrome !== undefined);
    tellInboxShown();
  }

  /** Last told to the inbox page; it only marks the open conversation read while in sight. */
  let inboxShown: boolean | undefined;
  function tellInboxShown(): void {
    const view = runtimes.find((runtime) => runtime.service.localPage === 'inbox')?.view;
    const shown = view !== undefined && view.getVisible() && win.isVisible() && !win.isMinimized();
    if (shown === inboxShown) return;
    inboxShown = shown;
    view?.webContents.send(SmsChannel.shown, shown);
  }
  win.on('show', tellInboxShown);
  win.on('hide', tellInboxShown);
  win.on('minimize', tellInboxShown);
  win.on('restore', tellInboxShown);
  smsView()?.on('did-finish-load', () => {
    inboxShown = undefined;
    tellInboxShown();
  });

  // Keyboard focus follows the active service when it becomes ready (at startup, after Retry,
  // Reload or a switch to a service that was still loading). Electron's webContents.focus()
  // also raises the window on Linux, so while the window is in the background this waits
  // for the window to get focus back instead of stealing it.
  let readyActiveId: string | undefined;
  let focusOnWindowFocus = false;
  function focusActiveService(): void {
    const runtime = runtimeById(state.activeServiceId);
    if (runtime?.status().kind !== 'ready') return;
    if (win.isFocused()) runtime.view.webContents.focus();
    else focusOnWindowFocus = true;
  }
  win.on('focus', () => {
    if (!focusOnWindowFocus) return;
    focusOnWindowFocus = false;
    focusActiveService();
  });

  function render(): void {
    if (win.isDestroyed()) return;
    layout();
    const activeReady = runtimeById(state.activeServiceId)?.status().kind === 'ready';
    if (activeReady && readyActiveId !== state.activeServiceId) focusActiveService();
    readyActiveId = activeReady ? state.activeServiceId : undefined;
    // With the phone connected the inbox already counts every source, so the websites'
    // own counts would count the same messages twice.
    const total = totalUnread(
      runtimes.filter((runtime) => !mirrored() || !isMirroredWebsite(runtime.service.id)).map((runtime) => unreadFor(runtime)),
    );
    win.setTitle(windowTitle(APP_NAME, total));
    const label = unreadLabel(total);
    tray?.setImage(label ? icons.lamp : icons.plain);
    tray?.setToolTip(label ? `${APP_NAME}: ${label === '•' ? 'new' : label} unread` : APP_NAME);
    sidebarContents.send(Channel.snapshot, snapshot());
  }

  let saveTimer: NodeJS.Timeout | undefined;
  function updateState(patch: Partial<AppState>, delay = 400): void {
    state = { ...state, ...patch };
    clearTimeout(saveTimer);
    const write = () => {
      try {
        saveAppState(statePath, state);
      } catch (error) {
        console.error('Could not save window state', error);
      }
    };
    if (delay === 0) write();
    else saveTimer = setTimeout(write, delay);
  }
  const rememberBounds = () => {
    if (win.isMinimized() || win.isFullScreen()) return;
    updateState({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };

  // Sleep: a website out of sight for SLEEP_AFTER_MS is unloaded to free its memory, unless it is
  // kept running. Opening it wakes it.
  const sleepTimers = new Map<string, NodeJS.Timeout>();
  const keptAwake = (id: string) => state.keepAwakeServiceIds.includes(id);
  function scheduleSleep(runtime: ServiceRuntime): void {
    const { id } = runtime.service;
    clearTimeout(sleepTimers.get(id));
    sleepTimers.delete(id);
    if (runtime.service.localPage || keptAwake(id) || id === state.activeServiceId || runtime.status().kind === 'asleep') return;
    sleepTimers.set(
      id,
      setTimeout(() => {
        sleepTimers.delete(id);
        if (id !== state.activeServiceId && !keptAwake(id)) runtime.sleep();
      }, SLEEP_AFTER_MS),
    );
  }

  function activate(serviceId: string): void {
    const runtime = runtimeById(serviceId);
    if (!runtime) return;
    const previous = runtimeById(state.activeServiceId);
    if (state.activeServiceId !== serviceId) updateState({ activeServiceId: serviceId });
    runtime.wake();
    scheduleSleep(runtime);
    if (previous && previous !== runtime) scheduleSleep(previous);
    render();
    focusActiveService();
  }

  // Awake websites that are not on screen start their sleep timers.
  for (const runtime of runtimes) scheduleSleep(runtime);

  function setKeepAwake(runtime: ServiceRuntime, keep: boolean): void {
    const { id } = runtime.service;
    const others = state.keepAwakeServiceIds.filter((other) => other !== id);
    updateState({ keepAwakeServiceIds: keep ? [...others, id] : others }, 0);
    if (keep) runtime.wake();
    scheduleSleep(runtime);
    render();
  }

  function showWindow(): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function setMuted(serviceId: string, muted: boolean): void {
    const others = state.mutedServiceIds.filter((id) => id !== serviceId);
    updateState({ mutedServiceIds: muted ? [...others, serviceId] : others }, 0);
    render();
  }

  async function confirmSignOut(runtime: ServiceRuntime): Promise<void> {
    const { name } = runtime.service;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Sign out', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Sign out of ${name}?`,
      detail: `This removes your ${name} login and everything ${name} saved in Kainos Talk. You will need to sign in again.`,
    });
    if (response !== 0) return;
    try {
      await runtime.signOut();
    } catch (error) {
      await dialog.showMessageBox(win, {
        type: 'error',
        message: `Could not sign out of ${name}`,
        detail: `Your ${name} login may still be saved. Try again, or quit Kainos Talk and try again.\n\n${String(error)}`,
      });
    }
  }

  /** Without `at` the menu opens at the pointer; a keyboard-opened menu passes its button's place. */
  function openServiceMenu(runtime: ServiceRuntime, at: MenuPoint | undefined): void {
    const { id, name } = runtime.service;
    const muted = state.mutedServiceIds.includes(id);
    const website: Electron.MenuItemConstructorOptions[] = runtime.service.localPage
      ? []
      : [
          {
            label: 'Keep running in the background',
            type: 'checkbox',
            checked: keptAwake(id),
            click: () => setKeepAwake(runtime, !keptAwake(id)),
          },
          { label: 'Sleep now', enabled: runtime.status().kind !== 'asleep' && id !== state.activeServiceId, click: () => runtime.sleep() },
        ];
    Menu.buildFromTemplate([
      { label: `Reload ${name}`, click: () => runtime.reload() },
      { label: muted ? 'Unmute notifications' : 'Mute notifications', click: () => setMuted(id, !muted) },
      ...(website.length ? [{ type: 'separator' as const }, ...website] : []),
      { type: 'separator' },
      { label: `Sign out of ${name}…`, click: () => void confirmSignOut(runtime) },
    ]).popup(menuOptions(at));
  }

  /** A menu opened from the bar keeps an auto-hidden bar out until it closes. */
  function menuOptions(at: MenuPoint | undefined): Electron.PopupOptions {
    menuOpen = true;
    return {
      window: win,
      ...(at && { x: at.x + chrome.getBounds().x, y: at.y }),
      callback: () => {
        menuOpen = false;
        hideSoon();
      },
    };
  }

  function setBar(patch: { barSide?: SidePreference; barAutoHide?: boolean }): void {
    updateState(patch, 0);
    if (!state.barAutoHide) revealed = false;
    render();
  }

  function openBarMenu(at: MenuPoint | undefined): void {
    const side = (value: SidePreference, label: string): Electron.MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: state.barSide === value,
      click: () => setBar({ barSide: value }),
    });
    Menu.buildFromTemplate([
      {
        label: 'Hide the bar until the pointer reaches it',
        type: 'checkbox',
        checked: state.barAutoHide,
        click: () => setBar({ barAutoHide: !state.barAutoHide }),
      },
      { type: 'separator' },
      side('auto', `Bar on the screen's outer edge (now ${screenSide()})`),
      side('left', 'Bar always on the left'),
      side('right', 'Bar always on the right'),
    ]).popup(menuOptions(at));
  }

  /** F6: from a service page to its rail button, and from the sidebar back into the page. */
  function switchPane(from: WebContents): void {
    if (from !== sidebarContents) {
      railFocused = true;
      reveal();
      sidebarContents.focus();
      sidebarContents.send(Channel.focusRail);
      return;
    }
    const runtime = runtimeById(state.activeServiceId);
    if (runtime?.status().kind === 'ready') runtime.view.webContents.focus();
  }

  // Ctrl+1..9, Ctrl+Q and F6 work wherever focus is: the sidebar or any service page.
  const handleShortcuts = (contents: WebContents) =>
    contents.on('before-input-event', (event, input) => {
      const shortcut = shortcutFor(input, process.platform, runtimes.length);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.kind === 'quit') app.quit();
      else if (shortcut.kind === 'switch-pane') switchPane(contents);
      else activate(runtimes[shortcut.index]!.service.id);
    });
  handleShortcuts(sidebarContents);
  const hookPage = (runtime: ServiceRuntime) => {
    const contents = runtime.view.webContents;
    handleShortcuts(contents);
    // Each page reports when the pointer reaches its side edges; the active one may bring the bar out.
    contents.ipc.on(Channel.pointerEdge, (_event, raw: unknown) => {
      const edge = parsePointerEdge(raw);
      if (!edge || !state.barAutoHide || runtime.service.id !== state.activeServiceId) return;
      if (edge === barSide()) reveal();
      else hideSoon();
    });
  };
  runtimes.forEach((runtime, index) => {
    hookPage(runtime);
    // A website that went to sleep has a new, empty view: it takes the old one's place.
    runtime.onNewView((view, previous) => {
      win.contentView.removeChildView(previous);
      win.contentView.addChildView(view, index);
      hookPage(runtime);
    });
  });
  sidebarContents.on('focus', () => {
    railFocused = true;
  });
  sidebarContents.on('blur', () => {
    railFocused = false;
    hideSoon();
  });

  // Sidebar IPC. Only the sidebar page may call it, and only with known service ids.
  const fromSidebar = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === sidebarContents;
  ipcMain.handle(Channel.getSnapshot, (event) => (fromSidebar(event) ? snapshot() : undefined));
  const onSidebar = (channel: string, act: (runtime: ServiceRuntime, extra: unknown) => void) =>
    ipcMain.on(channel, (event, id: unknown, extra: unknown) => {
      const runtime = fromSidebar(event) && findService(id) ? runtimeById(id as string) : undefined;
      if (runtime) act(runtime, extra);
    });
  onSidebar(Channel.activate, (runtime) => activate(runtime.service.id));
  onSidebar(Channel.retry, (runtime) => runtime.restart());
  onSidebar(Channel.openServiceMenu, (runtime, at) => openServiceMenu(runtime, parseMenuPoint(at)));
  ipcMain.on(Channel.railPointer, (event, over: unknown) => {
    if (!fromSidebar(event)) return;
    pointerOnRail = over === true;
    if (pointerOnRail) reveal();
    else hideSoon();
  });
  ipcMain.on(Channel.openBarMenu, (event, at: unknown) => {
    if (fromSidebar(event)) openBarMenu(parseMenuPoint(at));
  });

  const smsContents = smsView();
  const fromSms = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) => smsContents !== undefined && event.sender === smsContents;
  ipcMain.handle(SmsChannel.getState, (event) => (fromSms(event) ? sms.state() : undefined));
  ipcMain.on(SmsChannel.reply, (event, key: unknown, text: unknown) => {
    if (fromSms(event) && typeof key === 'string' && typeof text === 'string' && text.trim() && text.length <= 5000) sms.reply(key, text);
  });
  ipcMain.on(SmsChannel.markRead, (event, key: unknown) => {
    if (fromSms(event) && typeof key === 'string') sms.markRead(key);
  });
  ipcMain.on(SmsChannel.answerPairing, (event, accept: unknown) => {
    if (fromSms(event)) sms.answerPairing(accept === true);
  });
  ipcMain.on(SmsChannel.forgetPhone, (event) => {
    if (fromSms(event)) sms.forgetPhone();
  });
  ipcMain.on(SmsChannel.mailAction, (event, key: unknown, action: unknown) => {
    if (fromSms(event) && typeof key === 'string' && (action === 'archive' || action === 'trash' || action === 'markRead')) sms.mailAction(key, action);
  });
  ipcMain.on(SmsChannel.openService, (event, id: unknown) => {
    const service = fromSms(event) ? findService(id) : undefined;
    if (service && !service.localPage) activate(service.id);
  });
  ipcMain.on(SmsChannel.send, (event, to: unknown, text: unknown) => {
    if (fromSms(event) && typeof to === 'string' && typeof text === 'string' && text.length <= 5000) sms.send(to, text);
  });

  forwardNotifications({
    runtimeFor: (contents) => runtimes.find((runtime) => runtime.view.webContents === contents),
    // While the phone is connected, the inbox notifies for these websites; their own would be doubles.
    isMuted: (id) => state.mutedServiceIds.includes(id) || (mirrored() && isMirroredWebsite(id)),
    focusService: (id) => {
      showWindow();
      activate(id);
    },
    fallbackIcon: icons.plain,
  });

  try {
    tray = new Tray(icons.plain);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Show ${APP_NAME}`, click: showWindow },
        { type: 'separator' },
        { label: `Quit ${APP_NAME}`, click: () => app.quit() },
      ]),
    );
    tray.on('click', showWindow);
  } catch (error) {
    console.warn('No system tray; closing the window will quit.', error);
  }

  win.on('closed', () => {
    for (const runtime of runtimes) if (!runtime.view.webContents.isDestroyed()) runtime.view.webContents.close();
    if (!sidebarContents.isDestroyed()) sidebarContents.close();
  });
  win.on('resize', () => {
    layout();
    rememberBounds();
  });
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);
  // Close hides to the tray only when a tray is there to bring the window back. On Linux a
  // Tray object exists even with no tray host running (common on Wayland compositors), so
  // ask the session; without one, closing quits.
  win.on('close', (event) => {
    rememberBounds();
    if (quitting || !tray) return;
    event.preventDefault();
    const hasTray = process.platform === 'linux' ? trayHostPresent() : Promise.resolve(true);
    void hasTray.then((yes) => (yes ? win.hide() : app.quit()));
  });
  sidebarContents.once('did-finish-load', () => {
    if (state.maximized) win.maximize();
    win.show();
  });

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    updateState({}, 0);
  });

  sidebarContents.loadFile(join(__dirname, 'renderer', 'index.html')).catch((error: unknown) => console.error(error));
  render();
}
