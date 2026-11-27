import { BaseWindow, Menu, powerMonitor, clipboard, type MenuItemConstructorOptions, Notification, Tray, WebContentsView, app, dialog, ipcMain, nativeImage, nativeTheme, protocol, screen, session, shell, type IpcMainEvent, type WebContents } from 'electron';
import { realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, parse, relative, sep } from 'node:path';
import { Channel, parseDockIndex, parseDockSize, parseMenuPoint, type DockFrame, type DockSize, type MenuPoint, type Snapshot } from '../shared/ipc.ts';
import { parsePagePointer, type PagePointer } from '../shared/dock-edge.ts';
import { moveService, successor, visibleServices } from '../shared/dock-order.ts';
import { SERVICES, canHibernate, defaultAwayMode, findService, partitionFor, type AwayMode } from '../shared/services.ts';
import { totalUnread, unreadLabel, windowTitle } from '../shared/unread.ts';
import { markPng } from './app-icon.ts';
import { DEFAULT_SIZE, MIN_SIZE, fitToDisplays, loadAppState, saveAppState, type AppState } from './app-state.ts';
import { keepAway } from './away.ts';
import { layoutBar } from './bar.ts';
import { REVEAL_TIMING, initialReveal, onScreen, raised, stepReveal, type RevealEvent, type RevealPhase, type RevealState } from './dock-reveal.ts';
import { forwardNotifications } from './notifications.ts';
import { mirrorVencordThemes, startVencord } from './vencord.ts';
import { startSmsSync, type SmsSync } from './sms-sync.ts';
import { startCallAudio } from './call-audio.ts';
import { startClipboardSync, systemClipboard, type ClipboardSync } from './clipboard-sync.ts';
import { startMediaPause } from './media-pause.ts';
import { CLI_DOWNLOAD, DRIVE_FOLDER, findCli, formatBytes, inside, sizeUpTo, outcomeDetails, outcomeKind, outcomeLabel, startDriveBackup, type BackupOutcome, type OutcomeKind } from './drive-backup.ts';
import { openAppsPage, type AppsPage } from './apps-page.ts';
import { IMAGE_SCHEME, MAX_SMS_TEXT, SmsChannel, isCopyableCode } from '../shared/sms.ts';
import { THEMES, resolveTheme, type ThemeChoice } from '../shared/theme.ts';
import { CLOUDFLARE_GUIDE, LOCAL_GUIDE, STREAMROOM_ID, parseServer, serverChoices, serverLabel, thisPc, withCurrent, withLocalPort, withServers, withoutServer, type StreamroomServers } from '../shared/streamroom.ts';
import { askServerAddress, type ServerDialogMode } from './server-dialog.ts';
import { createCallPopup } from './call-popup.ts';
import { callTab } from './call-tab.ts';
import { connectHyprland, watchHyprland } from './hyprland.ts';
import { createNativeWindow, type NativeWindow } from './native-window.ts';
import { NativeChannel, type NativeAppView } from '../shared/native-app.ts';

import { claimingService, sharedLink } from './navigation.ts';
import { openExternal } from './open-external.ts';
import { createServiceRuntime, type ServiceRuntime } from './service-runtime.ts';
import { shortcutFor } from './shortcuts.ts';
import { trayHostPresent } from './tray-host.ts';
import { loginItem } from './login-item.ts';
import { chromeUserAgent } from './user-agent.ts';

const APP_NAME = 'Kainos Talk';
/** Longest phone name the dock shows; the name comes from the phone. */
const PHONE_NAME_MAX = 60;
/** Height of the strip over a tab with a call on (call-strip.css fills it). */
const CALL_STRIP_HEIGHT = 40;
/** How long a page in the background stays drawn before it sleeps; the smoke test shortens it. */
const SLEEP_AFTER_MS = Number(process.env.KAINOS_SLEEP_AFTER_MS) || 60_000;
/** How long a page set to hibernate stays in the background before its page closes. */
const HIBERNATE_AFTER_MS = Number(process.env.KAINOS_HIBERNATE_AFTER_MS) || 10 * 60_000;
/** A window brought up this soon after the user picked a tab (a notification, a link) keeps that tab. */
const PICKED_MS = 2_000;

app.setName(APP_NAME);
if (process.env.KAINOS_USER_DATA) app.setPath('userData', process.env.KAINOS_USER_DATA);
// Popups and workers use this too, so nothing a service sees names Electron.
app.userAgentFallback = chromeUserAgent(process.platform, process.versions.chrome);
if (process.platform === 'win32') app.setAppUserModelId('app.kainos.talk');
// With Wayland colour management, Hyprland's HDR mode shows the whole window greyish (blacks
// raised, colours faded) while other windows look right. Without it the window is treated as
// plain SDR and converted like the rest. Kept alongside any --disable-features on the command line.
if (process.platform === 'linux') {
  const disabled = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch('disable-features', [disabled, 'WaylandWpColorManagerV1'].filter(Boolean).join(','));
}
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

async function start(): Promise<void> {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const serviceIds = SERVICES.map((service) => service.id);
  /** Kainos' own page (Texts) always keeps its tab. */
  const unhideable = SERVICES.filter((service) => service.localPage === 'inbox').map((service) => service.id);
  const statePath = join(app.getPath('userData'), 'kainos-state.json');
  let state: AppState = loadAppState(statePath, serviceIds, {
    unhideable,
    sleepless: SERVICES.filter((service) => !canHibernate(service)).map((service) => service.id),
    startHibernated: SERVICES.filter((service) => service.startsHibernated).map((service) => service.id),
    optIn: SERVICES.filter((service) => service.optIn).map((service) => service.id),
  });
  /** A service the user chose on Choose your apps. One that is off has no tab and no page. */
  const isOn = (serviceId: string) => state.enabledServiceIds.includes(serviceId);
  /** Services with no tab: hidden ones, and the ones switched off. */
  const offDock = () => [...state.hiddenServiceIds, ...state.serviceOrder.filter((id) => !isOn(id))];
  /** The theme's --surface: behind the pages until they paint, so nothing flashes in another colour. */
  const themeBackground = () => resolveTheme(state.theme, nativeTheme.shouldUseDarkColors).surface;
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

  // The dock page: the dock floating over the page's bottom edge (or its strip, when always
  // shown), plus the notice over the whole window while the active service loads or fails.
  const chrome = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'preload-app.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // Transparent, so the floating islands and their shadow sit over the page beneath.
  chrome.setBackgroundColor('#00000000');
  const dockContents = chrome.webContents;
  // The dock page is local and never navigates or opens windows.
  dockContents.on('will-navigate', (event) => event.preventDefault());
  dockContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  /** The strip at the top of a tab with a call on, to switch between the call and the chats. */
  const callStrip = new WebContentsView({
    webPreferences: { preload: join(__dirname, 'preload-call-strip.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  callStrip.setVisible(false);
  callStrip.webContents.on('will-navigate', (event) => event.preventDefault());
  callStrip.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  /** Last told to the call strip; a reloaded strip page starts on 'call', as does a new call. */
  let sentShowing: 'call' | 'chats' | undefined;
  callStrip.webContents.on('did-finish-load', () => (sentShowing = undefined));
  ipcMain.on(Channel.callToggle, (event) => {
    if (event.sender !== callStrip.webContents) return;
    const runtime = runtimeById(state.activeServiceId);
    if (!runtime?.call()) return;
    runtime.setCallInFront(!runtime.callInFront());
    shownContents(runtime)?.focus();
  });

  /** Set once every service runtime exists; callbacks that arrive earlier have nothing to update. */
  let runtimesReady = false;
  /** Choose your apps, while it is open over the window. */
  let apps: AppsPage | undefined;
  // Before the service pages start loading, or Discord's first load runs without Vencord.
  await startVencord({
    dir: join(app.getPath('userData'), 'vencord'),
    services: SERVICES.filter((service) => service.clientMod === 'vencord'),
    onFirstInstall: () => {
      // Pages made after this already load with Vencord. A hibernating Discord stays asleep;
      // it gets Vencord when it wakes.
      if (!runtimesReady) return;
      for (const runtime of runtimes) if (runtime.service.clientMod === 'vencord') runtime.reload();
    },
  });
  // Desktop Vencord's themes folder: themes uploaded in the Discord tab follow their files there.
  const vencordThemes = mirrorVencordThemes(join(app.getPath('appData'), 'Vencord', 'themes'));

  // The Texts page: the phone's SMS and RCS conversations, over the local network. It starts
  // before the service views, so the page's first request finds it ready. A change from the phone
  // can come before the views exist; the page asks for the state once it loads.
  const smsView = () => (runtimesReady ? runtimes.find((runtime) => runtime.service.localPage === 'inbox')?.view()?.webContents : undefined);
  /** Shows a desktop notification for a new text; a click opens that conversation. */
  function notifyFromInbox(key: string, title: string, body: string): void {
    const muted = state.mutedServiceIds.includes('inbox');
    if (muted || !Notification.isSupported()) {
      app.emit('kainos-notification', { serviceId: 'inbox', muted, notification: undefined });
      return;
    }
    const notification = new Notification({ title, body, icon: icons.plain });
    notification.on('click', () => {
      showOnTab('inbox');
      smsView()?.send(SmsChannel.openKey, key);
    });
    notification.show();
    app.emit('kainos-notification', { serviceId: 'inbox', muted, notification });
  }
  /**
   * A ringing call, unless Texts is muted. While Kainos Talk is the window in use it opens a
   * window of its own in the middle of the screen. Otherwise it is a desktop notification: a new
   * window would pull Kainos Talk's workspace over whatever is open, a game say.
   */
  let callPopupContents: WebContents | undefined;
  /** Kainos Talk is the window in use. Tracked from its events, which the off-screen test can send. */
  let inUse = false;
  win.on('focus', () => (inUse = true));
  win.on('blur', () => (inUse = false));
  /** How the ringing call shows, chosen when it starts to ring and kept until it stops. */
  let ringingAs: { id: string; way: 'window' } | { id: string; way: 'notification'; who: string; notification: Notification | undefined } | undefined;
  function notifyCall(who: string): Notification | undefined {
    if (!Notification.isSupported()) return undefined;
    const notification = new Notification({ title: `${who} is calling`, body: 'Answer on the Texts page or on your phone.', icon: icons.plain, urgency: 'critical' });
    notification.on('click', () => showOnTab('inbox'));
    notification.show();
    return notification;
  }
  const callPopup = createCallPopup({
    localDir: __dirname,
    background: themeBackground,
    answer: () => sms?.answer(),
    decline: () => sms?.hangUp(),
    onOpen: (contents) => (callPopupContents = contents),
    onClose: () => (callPopupContents = undefined),
  });
  function showRinging(): void {
    const s = sms?.state();
    const ringing = s?.call?.phase === 'ringing' && !state.mutedServiceIds.includes('inbox') ? s.call : undefined;
    if (ringingAs && ringingAs.id !== ringing?.id) {
      if (ringingAs.way === 'notification') ringingAs.notification?.close();
      ringingAs = undefined;
    }
    if (!ringing) return callPopup.show(undefined);
    if (!ringingAs) ringingAs = inUse ? { id: ringing.id, way: 'window' } : { id: ringing.id, way: 'notification', who: '', notification: undefined };
    if (ringingAs.way === 'window') return callPopup.show({ call: ringing, pending: s!.callAction.pending, failure: s!.callAction.failure });
    // The caller's number and name can come after the call: the notification is shown again with them.
    const who = ringing.name ?? ringing.number ?? 'Unknown number';
    if (who === ringingAs.who) return;
    ringingAs.notification?.close();
    ringingAs.who = who;
    ringingAs.notification = notifyCall(who);
  }
  /** The phone sync, running only while Texts is on: off, nothing listens on the network. */
  let sms: SmsSync | undefined;
  const sendSmsState = () => {
    if (sms) smsView()?.send(SmsChannel.state, sms.state());
  };
  // Call sound comes over Bluetooth, which the phone forgets to connect: the PC connects it
  // whenever the phone joins over the LAN, a call rings or starts, or the PC wakes up.
  const callAudio = await startCallAudio(sendSmsState);
  const connectCallAudio = () => callAudio.ensure(sms?.state().phone?.name);
  /** What the last change showed, to connect only on a new phone link or a new call. */
  let seen: { linked: boolean; call: string | null } = { linked: false, call: null };
  powerMonitor.on('resume', () => {
    if (sms?.state().phone?.connected) connectCallAudio();
  });
  // Music and videos on this PC pause while a call rings or is on.
  const mediaPause = await startMediaPause();
  /** The PC's clipboard and the phone's, while the phone sync runs. */
  let clipboardSync: ClipboardSync | undefined;
  const phoneName = () => sms?.state().phone?.name.slice(0, PHONE_NAME_MAX) ?? 'your phone';
  /**
   * What the phone sent or a file sent to it came to. Shown even while Texts is muted: the user
   * asked for each of these on the phone or the PC.
   */
  function notifyPhone(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, icon: icons.plain });
    if (onClick) notification.on('click', onClick);
    notification.show();
  }
  const toClipboard = (text: string) => (clipboardSync ? clipboardSync.apply(text) : void clipboard.writeText(text));
  let smsStarting: Promise<void> | undefined;
  function startSms(): Promise<void> {
    if (sms) return Promise.resolve();
    smsStarting ??= startSmsSync({
      dir: join(app.getPath('userData'), 'sms-sync'),
      downloads: receiveFolder,
      onClip: (text) => {
        toClipboard(text);
        notifyPhone(`Copied from ${phoneName()}`, 'Paste it anywhere on this PC.');
      },
      onShareText: (text) => {
        const link = sharedLink(text);
        if (link) return openLink(link);
        toClipboard(text);
        notifyPhone(`Text from ${phoneName()} copied`, text.length > 120 ? `${text.slice(0, 120)}…` : text);
      },
      onFileReceived: (outcome) =>
        outcome.ok
          ? notifyPhone(`Received ${outcome.name}`, `From ${phoneName()}, in ${basename(dirname(outcome.path))}. Click to open it.`, () => void shell.openPath(outcome.path))
          : notifyPhone(`Could not receive ${outcome.name}`, outcome.error),
      // A new page drops the drafts and pictures it held of the phone before.
      onPaired: () => smsView()?.reloadIgnoringCache(),
      onFileSent: (outcome) =>
        outcome.ok ? notifyPhone(`Sent ${outcome.name}`, `It is on ${phoneName()}.`) : notifyPhone(`Could not send ${outcome.name}`, outcome.error),
      ...(process.env.KAINOS_SYNC_PORT && { port: Number(process.env.KAINOS_SYNC_PORT) }),
      advertise: process.env.KAINOS_SYNC_MDNS !== '0',
      callAudio: () => callAudio.state(),
      onChange: () => {
        const now = sms?.state();
        const linked = now?.phone?.connected === true;
        const callId = now?.call?.id ?? null;
        if (linked && (!seen.linked || (callId !== null && callId !== seen.call))) connectCallAudio();
        const relink = linked !== seen.linked;
        seen = { linked, call: callId };
        mediaPause.update(callId !== null);
        sendSmsState();
        showRinging();
        // The window title and tray lamp follow the inbox; the tray's Send files follows the link.
        if (runtimesReady) {
          render();
          if (relink) tray?.setContextMenu(trayMenu());
        }
      },
      onIncoming: (conversation, message) => {
        const who = conversation.isGroup && message.sender ? `${message.sender} in ${conversation.title}` : conversation.title;
        notifyFromInbox(conversation.key, who, message.text || 'Picture or attachment');
      },
    })
      .then(async (started) => {
        sms = started;
        clipboardSync = await startClipboardSync(systemClipboard(clipboard), {
          send: (text) => sms?.sendClip(text) ?? false,
          enabled: () => state.sendClipboard,
        });
      })
      .finally(() => {
        smsStarting = undefined;
      });
    return smsStarting;
  }
  async function stopSms(): Promise<void> {
    await smsStarting?.catch(() => {});
    const running = sms;
    sms = undefined;
    clipboardSync?.stop();
    clipboardSync = undefined;
    mediaPause.update(false);
    tray?.setContextMenu(trayMenu());
    showRinging();
    await running?.stop();
  }
  if (isOn('inbox')) await startSms();

  // Folders backed up to Proton Drive through Proton's command-line tool, while the Drive tab is on.
  // Not on Windows: Proton's own Windows app backs up folders there, and the copy each run makes
  // would push long paths past Windows' limit.
  const DRIVE_ID = 'proton-drive';
  const backupsHere = process.platform !== 'win32';
  const home = app.getPath('home');
  const driveCli = () => findCli(home);
  // This PC's folder in Drive keeps the name it got with the first folder, even if the PC is renamed.
  const drivePc = state.drivePc ?? hostname();
  if (!state.drivePc && state.driveBackupFolders.length > 0) updateState({ drivePc }, 0);
  /** Never backed up, even inside a picked folder. */
  const driveExclude = [
    // Kainos' own data holds every service's login.
    app.getPath('userData'),
    // Games and the trash: large, and nothing a backup should bring back.
    join(home, '.local', 'share', 'Steam'),
    join(home, '.steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam'),
    join(home, '.local', 'share', 'Trash'),
    // The system's live views of processes and devices, if someone picks a folder above them.
    ...(process.platform === 'linux' ? ['/proc', '/sys', '/dev', '/run'] : []),
  ];
  const driveBackup = startDriveBackup({
    folders: () => state.driveBackupFolders,
    skip: () => state.driveBackupSkipped ?? [],
    enabled: () => backupsHere && isOn(DRIVE_ID),
    cli: driveCli,
    workDir: join(app.getPath('userData'), 'drive-backup'),
    home,
    pc: drivePc,
    exclude: driveExclude,
    everyMs: 60 * 60_000,
    firstAfterMs: 2 * 60_000,
    onDone: (outcome, asked) => {
      const was: OutcomeKind = state.driveBackupLast ? outcomeKind(state.driveBackupLast) : 'ok';
      updateState({ driveBackupLast: outcome }, 0);
      // A scheduled run speaks up when its kind of result changes (failing, a new problem, working
      // again), not every hour after.
      if (asked || outcomeKind(outcome) !== was) notifyBackup(outcome, was);
    },
  });
  // After sleep, the network takes a moment to come back.
  powerMonitor.on('resume', () => driveBackup.woke());
  function notifyBackup(outcome: BackupOutcome, was: OutcomeKind): void {
    if (!Notification.isSupported()) return;
    const kind = outcomeKind(outcome);
    const title =
      kind === 'ok'
        ? was === 'ok'
          ? 'Backed up to Proton Drive'
          : 'Proton Drive backups work again'
        : kind === 'signed-out' || kind === 'failed' || kind === 'refused'
          ? 'Proton Drive backup failed'
          : 'Proton Drive backup incomplete';
    const body = [`${outcomeLabel(outcome, new Date())}.`, ...outcomeDetails(outcome, homeRelative)].join(' ');
    const notification = new Notification({ title, body, icon: icons.plain });
    notification.on('click', () => showOnTab(DRIVE_ID));
    notification.show();
  }
  const homeRelative = (path: string) => (path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);
  // Pictures stay as bytes in main; the inbox page shows them by URL, and no other session can.
  session.fromPartition(partitionFor(SERVICES.find((service) => service.localPage === 'inbox')!)).protocol.handle(IMAGE_SCHEME, async (request) => {
    const picture = (await sms?.image(decodeURIComponent(new URL(request.url).pathname.slice(1)))) ?? null;
    return picture ? new Response(new Uint8Array(picture), { headers: { 'content-type': 'image/jpeg' } }) : new Response(null, { status: 404 });
  });
  win.contentView.addChildView(callStrip);
  win.contentView.addChildView(chrome);
  /** Pages made while the runtimes are being created; wired once everything they use exists. */
  let unwiredPages: WebContents[] | undefined = [];
  /** Streamroom points at the server chosen in its menu; the other services are as registered. */
  const configured = (service: (typeof SERVICES)[number]) => (service.id === STREAMROOM_ID ? withServers(service, state.streamroom) : service);
  const runtimes: ServiceRuntime[] = SERVICES.map((service) =>
    createServiceRuntime(configured(service), {
      userAgent: app.userAgentFallback,
      preload: join(__dirname, 'preload-service.cjs'),
      localDir: __dirname,
      background: themeBackground(),
      hibernated: !isOn(service.id) || state.hibernatedServiceIds.includes(service.id),
      onChange: render,
      // Each page view goes into the window at startup and on every wake. Adding the dock page
      // again moves it back on top. (Inserting at an index crashes Electron 45 on start.)
      onViewCreated: (view) => {
        view.setVisible(false);
        win.contentView.addChildView(view);
        win.contentView.addChildView(chrome);
        // Choose your apps stays over everything while it is open.
        if (apps) win.contentView.addChildView(apps.view);
        if (unwiredPages) unwiredPages.push(view.webContents);
        else wirePage(view.webContents);
        if (service.clientMod === 'vencord') vencordThemes.attach(view.webContents);
      },
      onViewClosed: (view) => win.contentView.removeChildView(view),
      openLink,
    }),
  );
  const runtimeById = (id: string) => runtimes.find((runtime) => runtime.service.id === id);
  // Desktop apps on a tab (Thunderbird): on Hyprland their own window sits over the tab.
  const hyprland = connectHyprland();
  const natives = new Map<string, NativeWindow>();
  for (const service of SERVICES) {
    const nativeApp = service.nativeApp;
    if (!nativeApp) continue;
    natives.set(service.id, createNativeWindow({ app: nativeApp, hyprland, title: () => win.getTitle(), onChange: () => sendNativeView(service.id) }));
  }
  const nativePage = (id: string) => (natives.has(id) ? runtimeById(id)?.view()?.webContents : undefined);
  function nativeView(id: string): NativeAppView | undefined {
    const service = findService(id);
    const native = natives.get(id);
    return service && native ? { name: service.name, icon: service.icon, state: native.state() } : undefined;
  }
  function sendNativeView(id: string): void {
    const page = nativePage(id);
    const view = nativeView(id);
    if (page && !page.isDestroyed() && view) page.send(NativeChannel.view, view);
  }
  /** The page a service shows: its call while that is in front, else its page. */
  const shownContents = (runtime: ServiceRuntime | undefined) => (runtime?.callInFront() ? runtime.call() : runtime?.view())?.webContents;
  const runtimeOf = (contents: WebContents) =>
    runtimes.find((runtime) => runtime.view()?.webContents === contents || runtime.call()?.webContents === contents);
  runtimesReady = true;

  /** What the service does in the background: the user's pick in its menu, else its own default. */
  const awayMode = (runtime: ServiceRuntime): AwayMode => state.awayModes[runtime.service.id] ?? defaultAwayMode(runtime.service);
  const away = keepAway({
    pages: () => runtimes,
    mode: awayMode,
    open: (runtime) => runtime.service.id === state.activeServiceId,
    mayHibernate: ({ service }) => canHibernate(service) && isOn(service.id) && service.id !== state.activeServiceId && !state.hiddenServiceIds.includes(service.id),
    hibernate: ({ service }) => hibernate(service.id),
    sleepAfterMs: SLEEP_AFTER_MS,
    hibernateAfterMs: HIBERNATE_AFTER_MS,
  });

  /** A link leaving a service: a service that claims its host (Streamroom's invites) opens it, else the browser. */
  function openLink(url: string): void {
    const claimer = claimingService(runtimes.filter((runtime) => isOn(runtime.service.id)).map((runtime) => runtime.service), url);
    const runtime = claimer && runtimeById(claimer.id);
    if (!runtime) {
      openExternal(url);
      return;
    }
    const { id } = runtime.service;
    // An invite from another of the user's Streamroom servers switches the tab to that server.
    const server = id === STREAMROOM_ID ? parseServer(url) : undefined;
    if (server && server !== state.streamroom.current) useServers(withCurrent(state.streamroom, server), false);
    if (state.hiddenServiceIds.includes(id)) showInDock(id);
    // Woken straight onto the link, not its start page first.
    if (state.hibernatedServiceIds.includes(id)) updateState({ hibernatedServiceIds: state.hibernatedServiceIds.filter((other) => other !== id) }, 0);
    runtime.open(url);
    showOnTab(id);
  }
  function paintThemeBackground(): void {
    win.setBackgroundColor(themeBackground());
    for (const runtime of runtimes) runtime.setBackground(themeBackground());
  }
  nativeTheme.on('updated', paintThemeBackground);

  let tray: Tray | undefined;
  let quitting = false;
  function trayMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: `Show ${APP_NAME}`, click: showWindow },
      sendFilesItem(),
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => app.quit() },
    ]);
  }

  function snapshot(): Snapshot {
    const phone = sms?.state().phone;
    return {
      activeId: state.activeServiceId,
      phone: phone ? { name: phone.name.slice(0, PHONE_NAME_MAX), connected: phone.connected === true } : null,
      hiddenIds: state.hiddenServiceIds,
      texts: isOn('inbox'),
      // Services switched off are left out altogether: they have no tab to hide or show.
      services: state.serviceOrder.filter(isOn).map(runtimeById).filter((runtime) => runtime !== undefined).map((runtime) => ({
        id: runtime.service.id,
        name: runtime.service.name,
        color: runtime.service.icon.color,
        glyph: runtime.service.icon.glyph,
        paint: runtime.service.icon.paint,
        host: runtime.service.localPage ? '' : new URL(runtime.service.url).host,
        status: runtime.status(),
        unread: runtime.unread(),
        muted: state.mutedServiceIds.includes(runtime.service.id),
      })),
    };
  }

  // The auto-hiding dock: dock-reveal.ts decides, this runs its timers and lays out on change.
  let reveal: RevealState = initialReveal;
  let revealTimer: NodeJS.Timeout | undefined;
  const pagePointers = new Map<WebContents, PagePointer>();
  function clearPagePointer(contents: WebContents): void {
    pagePointers.delete(contents);
    if (contents === shownContents(runtimeById(state.activeServiceId))) revealBy({ kind: 'page', at: 'away' });
  }
  /** The dock page's centred group, as it last measured it. */
  let group: DockSize | undefined;
  /** Last DockFrame sent to the dock page, as JSON. */
  let sentFrame = '';
  const waits: Partial<Record<RevealPhase, number>> = REVEAL_TIMING;
  /** Steps the reveal state; true if the phase changed, so the caller lays out again. */
  function feed(event: RevealEvent): boolean {
    const before = reveal.phase;
    reveal = stepReveal(reveal, event);
    if (reveal.phase === before) return false;
    clearTimeout(revealTimer);
    const wait = waits[reveal.phase];
    if (wait !== undefined) revealTimer = setTimeout(() => revealBy({ kind: 'timer' }), wait);
    return true;
  }
  function revealBy(event: RevealEvent): void {
    if (feed(event) && !win.isDestroyed()) layout();
  }

  function layout(): void {
    const [width = 0, height = 0] = win.getContentSize();
    const active = runtimeById(state.activeServiceId);
    const activeContents = shownContents(active);
    // A desktop app's window covers whatever is under it, the dock too, and takes the pointer
    // that would bring an auto-hiding dock up; so on its tab the dock keeps its strip.
    const nativeActive = active?.service.nativeApp !== undefined;
    feed({ kind: 'page', at: activeContents ? pagePointers.get(activeContents) ?? 'away' : 'away' });
    // A service that is loading or failed stays hidden, so the dock page can show why.
    const activeReady = active?.status().kind === 'ready';
    // A page in HTML fullscreen (a video, a stream) covers the dock too.
    const activeFullscreen = active?.fullscreen() === true;
    feed({ kind: 'active', active: !state.dockAlwaysShown && !nativeActive && activeReady && !activeFullscreen });
    const placed = layoutBar({ width, height, activeReady, activeFullscreen, pinned: state.dockAlwaysShown || nativeActive, onScreen: onScreen(reveal.phase), group });
    // While the tab on screen has a call on, the call strip sits at the top of the page's place
    // (not over a fullscreen video), and the call or the page fills the rest.
    const activeCall = activeReady && !activeFullscreen && active?.call() !== undefined;
    const area = placed.service;
    const stripHeight = activeCall ? Math.min(CALL_STRIP_HEIGHT, area.height) : 0;
    const below = { ...area, y: area.y + stripHeight, height: area.height - stripHeight };
    for (const runtime of runtimes) {
      const view = runtime.view();
      if (!view) continue;
      const shown = runtime === active && runtime.status().kind === 'ready';
      const bounds = runtime === active ? below : area;
      const call = runtime.call();
      call?.setBounds(bounds);
      call?.setVisible(shown && runtime.callInFront());
      view.setBounds(bounds);
      view.setVisible(shown && !runtime.callInFront());
    }
    // The app's window goes on its tab while the tab is on screen, and out of sight otherwise.
    const windowShown = win.isVisible() && !win.isMinimized() && apps === undefined;
    for (const [id, native] of natives) {
      native.setEnabled(isOn(id) && !state.hiddenServiceIds.includes(id));
      const tabShown = windowShown && id === state.activeServiceId && activeReady;
      native.place({ area: tabShown ? below : undefined, content: { width, height } });
    }
    callStrip.setBounds({ ...area, height: stripHeight });
    callStrip.setVisible(activeCall);
    const showing = active?.callInFront() ? 'call' : 'chats';
    if (activeCall && showing !== sentShowing) {
      sentShowing = showing;
      callStrip.webContents.send(Channel.callShowing, showing);
    }
    // Bounds first, then the frame: the view is in place before the dock slides up into it,
    // and keeps its bounds (onScreen while leaving) until it has slid away.
    if (placed.chrome) chrome.setBounds(placed.chrome);
    chrome.setVisible(placed.chrome !== undefined);
    apps?.view.setBounds({ x: 0, y: 0, width, height });
    const frame: DockFrame = { kind: placed.frame, raised: placed.frame !== 'float' || raised(reveal.phase), room: width };
    const key = JSON.stringify(frame);
    if (key !== sentFrame) {
      sentFrame = key;
      dockContents.send(Channel.dockFrame, frame);
    }
    tellInboxShown();
  }

  /** Last told to the inbox page; it only marks the open conversation read while in sight. */
  let inboxShown: boolean | undefined;
  function tellInboxShown(): void {
    const view = runtimes.find((runtime) => runtime.service.localPage === 'inbox')?.view();
    const shown = view !== undefined && view.getVisible() && win.isVisible() && !win.isMinimized();
    if (shown === inboxShown) return;
    inboxShown = shown;
    view?.webContents.send(SmsChannel.shown, shown);
  }
  // layout() also moves a desktop app's window away with the window, and back.
  win.on('show', layout);
  win.on('hide', layout);
  win.on('minimize', layout);
  win.on('restore', layout);

  // Keyboard focus follows the active service when it becomes ready (at startup, after Retry,
  // Reload or a switch to a service that was still loading). Electron's webContents.focus()
  // also raises the window on Linux, so while the window is in the background this waits
  // for the window to get focus back instead of stealing it.
  let readyActiveId: string | undefined;
  let focusOnWindowFocus = false;
  function focusActiveService(): void {
    const runtime = runtimeById(state.activeServiceId);
    if (runtime?.status().kind !== 'ready') return;
    const native = natives.get(runtime.service.id);
    if (native && win.isFocused()) native.focus();
    else if (win.isFocused()) shownContents(runtime)?.focus();
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
    const total = totalUnread(runtimes.map((runtime) => runtime.unread()));
    win.setTitle(windowTitle(APP_NAME, total));
    const label = unreadLabel(total);
    tray?.setImage(label ? icons.lamp : icons.plain);
    tray?.setToolTip(label ? `${APP_NAME}: ${label === '•' ? 'new' : label} unread` : APP_NAME);
    dockContents.send(Channel.snapshot, snapshot());
    away.update();
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

  /** Opens the service's tab, waking it if it hibernates: the active service is always awake. */
  function activate(serviceId: string): void {
    const runtime = runtimeById(serviceId);
    if (!runtime || !isOn(serviceId)) return;
    if (state.hibernatedServiceIds.includes(serviceId)) {
      updateState({ hibernatedServiceIds: state.hibernatedServiceIds.filter((id) => id !== serviceId) }, 0);
      runtime.wake();
    }
    if (state.activeServiceId !== serviceId) {
      const previous = shownContents(runtimeById(state.activeServiceId));
      if (previous) clearPagePointer(previous);
      updateState({ activeServiceId: serviceId });
      const contents = shownContents(runtime);
      if (contents) {
        clearPagePointer(contents);
        contents.send(Channel.resetPagePointer);
      }
    }
    render();
    focusActiveService();
  }

  /**
   * Closes the service's page to free its memory; it stops notifying until it wakes. The
   * active service hands over to the next tab first.
   */
  function hibernate(serviceId: string): void {
    const runtime = runtimeById(serviceId);
    if (!runtime || !canHibernate(runtime.service) || state.hibernatedServiceIds.includes(serviceId)) return;
    if (state.activeServiceId === serviceId) {
      const next = handOver(serviceId);
      if (!next) return;
      activate(next);
    }
    updateState({ hibernatedServiceIds: [...state.hibernatedServiceIds, serviceId] }, 0);
    runtime.hibernate();
  }

  /** Wakes the service where it is, without opening its tab. */
  function wake(serviceId: string): void {
    if (!state.hibernatedServiceIds.includes(serviceId) || !isOn(serviceId)) return;
    updateState({ hibernatedServiceIds: state.hibernatedServiceIds.filter((id) => id !== serviceId) }, 0);
    runtimeById(serviceId)?.wake();
    render();
  }

  function showWindow(): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  let pickedAt = 0;
  /** Brings the window up on a tab the user picked; a call does not take its place. */
  function showOnTab(serviceId: string): void {
    pickedAt = Date.now();
    showWindow();
    activate(serviceId);
  }

  /**
   * As the window comes on screen, a tab with a call opens, the call in front: a website ringing
   * or in a call, or Texts with the phone's call. Websites come first, so a Messenger call wins
   * over the unknown number an older phone app rings for it.
   */
  function openCall(): void {
    if (Date.now() - pickedAt < PICKED_MS) return;
    const websites = state.serviceOrder.filter(isOn).map(runtimeById).filter((runtime): runtime is ServiceRuntime => runtime !== undefined && !runtime.service.localPage);
    // The phone sync runs only while Texts is on.
    const phone = sms?.state().call;
    const id = callTab([
      ...websites.map((runtime) => ({ id: runtime.service.id, phase: runtime.callPhase() })),
      { id: 'inbox', phase: !phone ? undefined : phone.phase === 'ringing' ? 'ringing' : 'call' },
    ]);
    if (!id) return;
    runtimeById(id)?.setCallInFront(true);
    activate(id);
  }
  watchHyprland(hyprland, () => win.getTitle(), openCall);
  win.on('show', openCall);
  win.on('restore', openCall);

  function setAwayMode(serviceId: string, mode: AwayMode): void {
    updateState({ awayModes: { ...state.awayModes, [serviceId]: mode } }, 0);
    render();
  }

  /** A website's In the background submenu: keep it running, let it sleep, or let it hibernate. */
  function awayMenu(runtime: ServiceRuntime): MenuItemConstructorOptions[] {
    const current = awayMode(runtime);
    const minutes = Math.round(HIBERNATE_AFTER_MS / 60_000);
    const choice = (mode: AwayMode, label: string): MenuItemConstructorOptions => ({ label, type: 'radio', checked: mode === current, click: () => setAwayMode(runtime.service.id, mode) });
    return [
      choice('run', 'Keep running'),
      choice('sleep', 'Sleep, still notifying'),
      choice('hibernate', minutes >= 1 ? `Hibernate after ${minutes} minute${minutes === 1 ? '' : 's'}` : `Hibernate after ${Math.round(HIBERNATE_AFTER_MS / 1000)} seconds`),
    ];
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

  /** The services with a tab, in dock order; Ctrl+1..9 counts these. */
  const dockTabs = () => visibleServices(state.serviceOrder, offDock());

  /** Makes the service the tab at `index` among the dock's tabs, and saves the order. */
  function moveInDock(serviceId: string, index: number): void {
    const order = moveService(state.serviceOrder, serviceId, index, offDock());
    if (order.join() !== state.serviceOrder.join()) updateState({ serviceOrder: order }, 0);
    // Rendered even when nothing moved, so a dock page that moved the tab ahead of main is put right.
    render();
  }

  /**
   * The tab that opens when the open `serviceId` leaves: its neighbour along the dock, preferring
   * one that is awake, so hiding or hibernating a service does not wake another.
   */
  function handOver(serviceId: string): string | undefined {
    const asleep = state.hibernatedServiceIds.filter((id) => id !== serviceId);
    return successor(state.serviceOrder, [...offDock(), ...asleep], serviceId) ?? successor(state.serviceOrder, offDock(), serviceId);
  }

  /** Takes the tab out of the dock; the service keeps running. The active one hands over to its neighbour. */
  function hideFromDock(serviceId: string): void {
    if (unhideable.includes(serviceId) || state.hiddenServiceIds.includes(serviceId) || dockTabs().length < 2) return;
    const next = state.activeServiceId === serviceId ? handOver(serviceId) : undefined;
    updateState({ hiddenServiceIds: [...state.hiddenServiceIds, serviceId] }, 0);
    if (next) activate(next);
    else render();
  }

  /** Gives a hidden service its tab back, in its old place. */
  function showInDock(serviceId: string): void {
    updateState({ hiddenServiceIds: state.hiddenServiceIds.filter((id) => id !== serviceId) }, 0);
    render();
  }

  /**
   * Saves Streamroom's server choice and points the tab at it. `reload` loads the new server's
   * start page if the tab is awake; a link being opened passes false, since it loads the link.
   */
  function useServers(servers: StreamroomServers, reload = true): void {
    updateState({ streamroom: servers }, 0);
    const runtime = runtimeById(STREAMROOM_ID);
    if (!runtime) return;
    runtime.retarget(withServers(runtime.service, servers));
    if (reload) runtime.restart();
    render();
  }

  /** Streamroom's Server submenu: this PC, the added addresses, adding another and this PC's port. */
  function serverMenu(): MenuItemConstructorOptions[] {
    const servers = state.streamroom;
    const ask = (mode: ServerDialogMode) =>
      askServerAddress({
        mode,
        parent: win,
        localDir: __dirname,
        background: themeBackground(),
        onOpen: (contents) => (serverDialog = contents),
        onClose: () => (serverDialog = undefined),
      });
    /** Switches the tab to `next` and shows it, as the window's button says. */
    const openOn = (next: StreamroomServers) => {
      useServers(next);
      activate(STREAMROOM_ID);
    };
    return [
      ...serverChoices(servers).map(
        (origin): MenuItemConstructorOptions => ({
          label: serverLabel(origin, servers),
          type: 'radio',
          checked: origin === servers.current,
          click: () => {
            if (origin !== state.streamroom.current) useServers(withCurrent(state.streamroom, origin));
          },
        }),
      ),
      { type: 'separator' },
      { label: 'Add an address…', click: () => ask({ kind: 'address', onChoose: (origin) => openOn(withCurrent(state.streamroom, origin)) }) },
      {
        label: "Change this PC's port…",
        click: () =>
          ask({
            kind: 'port',
            port: state.streamroom.localPort,
            onChoose: (port) => {
              const moved = withLocalPort(state.streamroom, port);
              openOn(withCurrent(moved, thisPc(moved)));
            },
          }),
      },
      ...(servers.current === thisPc(servers)
        ? []
        : [{ label: `Forget ${serverLabel(servers.current, servers)}`, click: () => useServers(withoutServer(state.streamroom, servers.current)) }]),
      { type: 'separator' },
      // The Streamroom project's guides, in the browser: Kainos only opens a server, it runs none.
      { label: 'Run Streamroom on this PC…', click: () => openExternal(LOCAL_GUIDE) },
      { label: 'Deploy your own on Cloudflare…', click: () => openExternal(CLOUDFLARE_GUIDE) },
    ];
  }
  function showApps(): void {
    if (apps) {
      apps.view.webContents.focus();
      return;
    }
    apps = openAppsPage({
      win,
      localDir: __dirname,
      background: themeBackground(),
      choices: () => ({
        firstRun: !state.welcomed || state.enabledServiceIds.length === 0,
        services: state.serviceOrder.map(runtimeById).filter((runtime) => runtime !== undefined).map(({ service }) => ({
          id: service.id,
          name: service.name,
          about: service.about,
          icon: service.icon,
          on: isOn(service.id),
        })),
      }),
      onSave: chooseApps,
      onClose: () => {
        apps = undefined;
        render();
        focusActiveService();
      },
    });
    layout();
  }

  /**
   * Turns on the chosen services and off the rest. One turned off closes its page (and Texts
   * stops the phone sync); one turned on gets its tab back and wakes, unless it was hibernating.
   */
  function chooseApps(ids: readonly string[]): void {
    const turnedOn = ids.filter((id) => !isOn(id));
    const turnedOff = state.enabledServiceIds.filter((id) => !ids.includes(id));
    updateState({ enabledServiceIds: [...ids], welcomed: true, hiddenServiceIds: state.hiddenServiceIds.filter((id) => !turnedOn.includes(id)) }, 0);
    for (const id of turnedOff) runtimeById(id)?.hibernate();
    if (turnedOff.includes('inbox')) void stopSms();
    void (async () => {
      if (turnedOn.includes('inbox')) await startSms().catch((error: unknown) => console.warn('Could not start the phone sync:', error));
      for (const id of turnedOn) if (!state.hibernatedServiceIds.includes(id)) runtimeById(id)?.wake();
      if (!dockTabs().includes(state.activeServiceId)) {
        const tabs = dockTabs();
        const next = tabs.find((id) => !state.hibernatedServiceIds.includes(id)) ?? tabs[0];
        if (next) activate(next);
      }
      render();
      // After render, which turns a desktop app on; one still off does not start.
      for (const id of turnedOn) natives.get(id)?.startInBackground();
    })();
  }

  /** The open Add an address window, themed like Kainos' other pages. */
  let serverDialog: WebContents | undefined;

  /** Without `at` the menu opens at the pointer; a keyboard-opened menu passes its button's place. */
  function openServiceMenu(runtime: ServiceRuntime, at: MenuPoint | undefined): void {
    const { id, name } = runtime.service;
    const muted = state.mutedServiceIds.includes(id);
    const tabs = dockTabs();
    const place = tabs.indexOf(id);
    const asleep = state.hibernatedServiceIds.includes(id);
    const native = natives.get(id);
    if (native) {
      // The app is a program of its own: no page to reload, notifications or login of Kainos' to manage.
      Menu.buildFromTemplate([
        { label: native.state().kind === 'placed' ? `Bring ${name} here` : `Open ${name}`, click: () => native.open() },
        { type: 'separator' },
        { label: 'Move left', enabled: place > 0, click: () => moveInDock(id, place - 1) },
        { label: 'Move right', enabled: place >= 0 && place < tabs.length - 1, click: () => moveInDock(id, place + 1) },
        { label: 'Hide from dock', click: () => hideFromDock(id) },
      ]).popup(menuOptions(at));
      return;
    }
    Menu.buildFromTemplate([
      asleep
        ? { label: `Wake ${name}`, click: () => wake(id) }
        : {
            label: `Reload ${name}`,
            // The key reloads the open service, so it is shown only on that one's menu.
            ...(id === state.activeServiceId && { accelerator: 'CmdOrCtrl+R', registerAccelerator: false }),
            click: () => runtime.reload(),
          },
      ...(canHibernate(runtime.service) && !asleep ? [{ label: 'Hibernate', click: () => hibernate(id) }] : []),
      ...(canHibernate(runtime.service) ? [{ label: 'In the background', submenu: awayMenu(runtime) }] : []),
      { label: muted ? 'Unmute notifications' : 'Mute notifications', click: () => setMuted(id, !muted) },
      ...(id === STREAMROOM_ID ? [{ label: 'Server', submenu: serverMenu() }] : []),
      ...(id === DRIVE_ID && backupsHere ? [{ label: 'Back up folders', submenu: backupMenu() }] : []),
      { type: 'separator' },
      { label: 'Move left', enabled: place > 0, click: () => moveInDock(id, place - 1) },
      { label: 'Move right', enabled: place >= 0 && place < tabs.length - 1, click: () => moveInDock(id, place + 1) },
      ...(unhideable.includes(id) ? [] : [{ label: 'Hide from dock', click: () => hideFromDock(id) }]),
      { type: 'separator' },
      { label: `Sign out of ${name}…`, click: () => void confirmSignOut(runtime) },
    ]).popup(menuOptions(at));
  }

  /**
   * `at` is in the dock page's coordinates, so the view's place is added. A dock menu keeps an
   * auto-hiding dock shown until it closes.
   */
  function menuOptions(at: MenuPoint | undefined): Electron.PopupOptions {
    const view = chrome.getBounds();
    revealBy({ kind: 'menu', open: true });
    return { window: win, ...(at && { x: at.x + view.x, y: at.y + view.y }), callback: () => revealBy({ kind: 'menu', open: false }) };
  }

  /** Kainos' own pages: the dock, the Texts page and the call strip. Service pages keep their own colours. */
  const themedPages = () => [dockContents, smsView(), ...[...natives.keys()].map(nativePage), serverDialog, apps?.view.webContents, callStrip.webContents, callPopupContents].filter((contents): contents is WebContents => contents !== undefined && !contents.isDestroyed());
  function chooseTheme(theme: ThemeChoice): void {
    updateState({ theme }, 0);
    paintThemeBackground();
    for (const contents of themedPages()) contents.send(Channel.theme, theme);
  }

  function openBarMenu(at: MenuPoint | undefined): void {
    const choices: { id: ThemeChoice; name: string }[] = [{ id: 'system', name: 'Match system' }, ...THEMES];
    const hidden = state.serviceOrder.filter((id) => state.hiddenServiceIds.includes(id) && isOn(id)).map(runtimeById).filter((runtime) => runtime !== undefined);
    Menu.buildFromTemplate([
      {
        label: 'Always show the dock',
        type: 'checkbox',
        checked: state.dockAlwaysShown,
        click: () => {
          updateState({ dockAlwaysShown: !state.dockAlwaysShown }, 0);
          render();
        },
      },
      {
        label: 'Hidden services',
        enabled: hidden.length > 0,
        submenu: hidden.map(({ service }) => ({ label: `Show ${service.name}`, click: () => showInDock(service.id) })),
      },
      { label: 'Choose apps…', click: () => showApps() },
      {
        label: 'Theme',
        submenu: choices.map(({ id, name }) => ({ label: name, type: 'radio', checked: state.theme === id, click: () => chooseTheme(id) })),
      },
      startAtLoginItem(),
      { type: 'separator' },
      sendFilesItem(),
      {
        label: 'Send copied text to the phone',
        type: 'checkbox',
        checked: state.sendClipboard,
        click: () => updateState({ sendClipboard: !state.sendClipboard }, 0),
      },
      { label: `Folder for phone files (${basename(receiveFolder())})…`, click: () => void chooseReceiveFolder() },
    ]).popup(menuOptions(at));
  }

  const atLogin = loginItem({ platform: process.platform, env: process.env, execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath(), api: app });
  /** Starting at login keeps the phone's link up after a restart, with no window to open first. */
  function startAtLoginItem(): MenuItemConstructorOptions {
    let on = false;
    try {
      on = atLogin.enabled();
    } catch (error) {
      console.warn('could not read the login item', error);
    }
    return {
      label: 'Start at login',
      type: 'checkbox',
      checked: on,
      click: () => {
        try {
          atLogin.set(!on);
        } catch (error) {
          dialog.showErrorBox(APP_NAME, `Could not ${on ? 'stop' : 'start'} Kainos Talk at login: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  /** The Drive tab's Back up folders: how the last run went and why, the folders, and Back up now. */
  function backupMenu(): MenuItemConstructorOptions[] {
    const cli = driveCli();
    const folders = state.driveBackupFolders;
    const running = driveBackup.running();
    const last = state.driveBackupLast;
    const status = !cli ? 'Needs the Proton Drive CLI' : running ? 'Backing up…' : outcomeLabel(last, new Date());
    const details = last && !running ? outcomeDetails(last, homeRelative) : [];
    return [
      { label: status, enabled: false },
      ...(details.length > 0 ? [{ label: 'Details', submenu: details.map((line) => ({ label: shorten(line), enabled: false })) }] : []),
      ...(cli ? [] : [{ label: 'Get the Proton Drive CLI…', click: () => openExternal(CLI_DOWNLOAD) }]),
      running
        ? { label: 'Cancel backup', click: () => driveBackup.cancel() }
        : { label: 'Back up now', enabled: cli !== undefined && folders.length > 0, click: () => void driveBackup.backUpNow() },
      { type: 'separator' },
      ...folders.map((folder) => ({
        label: homeRelative(folder),
        submenu: [
          {
            label: 'Stop backing up',
            click: () => {
              const left = state.driveBackupFolders.filter((path) => path !== folder);
              updateState({ driveBackupFolders: left, driveBackupSkipped: skipsInside(left, skipped()) }, 0);
              driveBackup.folderRemoved();
            },
          },
          { type: 'separator' as const },
          // Ticked: left out. Unticking backs it up again, starting now.
          ...skipsInside([folder], skipped()).map((skip) => ({
            label: `Skip ${relative(folder, skip)}`,
            type: 'checkbox' as const,
            checked: true,
            click: () => {
              updateState({ driveBackupSkipped: skipped().filter((path) => path !== skip) }, 0);
              if (isOn(DRIVE_ID)) driveBackup.foldersChanged();
            },
          })),
          {
            label: 'Skip a folder inside…',
            click: async () => {
              const skip = await chooseSkip([folder]);
              if (!skip) return;
              updateState({ driveBackupSkipped: [...skipped(), skip] }, 0);
              // A run that is on may be uploading it: it ends and runs again without it.
              driveBackup.folderRemoved();
            },
          },
        ],
      })),
      { label: 'Add a folder…', click: () => void addBackupFolders() },
      { type: 'separator' },
      // Without a tray icon (most Wayland desktops), closing the window quits Kainos.
      { label: `Every hour while Kainos is open, into ${DRIVE_FOLDER} in Drive`, enabled: false },
    ];
  }
  const shorten = (line: string) => (line.length > 100 ? `${line.slice(0, 99)}…` : line);
  const skipped = () => state.driveBackupSkipped ?? [];
  /** The skipped folders inside one of `folders`, not one of them itself. */
  const skipsInside = (folders: readonly string[], skips: readonly string[]) =>
    skips.filter((skip) => folders.some((folder) => skip !== folder && inside(skip, folder)));

  /** Asks for a folder inside one of `folders` to leave out of the backup. */
  async function chooseSkip(folders: readonly string[]): Promise<string | undefined> {
    const options: Electron.OpenDialogOptions = { title: 'Leave out of the backup', buttonLabel: 'Skip', defaultPath: folders[0] ?? home, properties: ['openDirectory'] };
    const { canceled, filePaths } = win.isVisible() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const path = filePaths[0];
    if (canceled || !path) return undefined;
    let skip: string;
    try {
      skip = realpathSync(path);
    } catch {
      return undefined;
    }
    if (skipsInside(folders, [skip]).length > 0) return skip;
    const names = folders.map(homeRelative).join(', ');
    await dialog.showMessageBox(win, { type: 'error', message: `Could not skip ${homeRelative(path)}`, detail: `Pick a folder inside ${names}.` });
    return undefined;
  }

  async function addBackupFolders(): Promise<void> {
    const options: Electron.OpenDialogOptions = { title: 'Back up to Proton Drive', buttonLabel: 'Back up', defaultPath: home, properties: ['openDirectory', 'multiSelections'] };
    const { canceled, filePaths } = win.isVisible() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return;
    // Saved by real path, so a link that later points elsewhere cannot change what is uploaded.
    let picked: string[] = [];
    for (const path of filePaths) {
      try {
        picked.push(realpathSync(path));
      } catch {
        await dialog.showMessageBox(win, { type: 'error', message: `Could not add ${homeRelative(path)}`, detail: 'The folder can no longer be found. Is its disk still connected?' });
      }
    }
    // A whole disk holds the system itself, and every other user's files.
    const disks = picked.filter((path) => parse(path).root === path);
    if (disks.length > 0) {
      await dialog.showMessageBox(win, { type: 'error', message: `Could not add ${disks.join(', ')}`, detail: 'That is a whole disk. Pick the folders on it you want backed up.' });
    }
    picked = picked.filter((path) => !disks.includes(path));
    if (picked.length === 0) return;
    // Picking a skipped folder backs it up again.
    let skips: readonly string[] = skipped().filter((skip) => !picked.includes(skip));
    // The whole home folder holds SSH keys, browser profiles and every app's data.
    const realHome = realpathSync(home);
    if (picked.some((path) => inside(realHome, path))) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Back up', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Back up your whole home folder?',
        detail: 'It includes SSH keys, browser profiles and every app’s data and caches, so the first backup can be very large. Picking folders such as Documents is faster.',
      });
      if (response !== 0) return;
    } else {
      const confirmed = await bigBackupConfirmed(picked, skips);
      if (!confirmed) return;
      skips = confirmed;
    }
    updateState({ driveBackupFolders: [...new Set([...state.driveBackupFolders, ...picked])], driveBackupSkipped: skips, drivePc }, 0);
    // The first backup of a new folder starts now, not within the hour.
    if (isOn(DRIVE_ID)) driveBackup.foldersChanged();
  }

  /**
   * Past 10 GB or 100,000 files, a first backup takes hours and Proton slows it down: the user
   * confirms it, or skips folders inside until it fits. Counting stops at the limit, so even a huge
   * folder answers in seconds. Resolves to the skipped folders, or nothing if the user cancelled.
   */
  async function bigBackupConfirmed(folders: readonly string[], skips: readonly string[]): Promise<readonly string[] | undefined> {
    const limit = { bytes: 10 * 1024 ** 3, files: 100_000 };
    for (;;) {
      const size = await sizeUpTo(folders, { home, exclude: driveExclude, skip: skips }, limit);
      if (!size.more) return skips;
      const names = folders.map(homeRelative).join(', ');
      const amount = size.bytes > limit.bytes ? `more than ${formatBytes(limit.bytes)}` : `more than ${limit.files.toLocaleString()} files`;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Back up', 'Skip a folder inside…', 'Cancel'],
        defaultId: 1,
        cancelId: 2,
        message: `Back up ${amount}?`,
        detail: `${names} holds ${amount}, even leaving out caches such as node_modules and the folders you skipped. The first backup would take hours, and Proton slows down large uploads. Skip the folders inside it that you could get back elsewhere; code in Git repositories is usually already backed up.`,
      });
      if (response === 0) return skips;
      if (response !== 1) return undefined;
      const skip = await chooseSkip(folders);
      if (skip) skips = [...skips, skip];
    }
  }

  /**
   * Where files from the phone go: the folder the user chose while it still exists, else
   * ~/Downloads, whatever the system's downloads setting says (on some PCs that is the home folder).
   */
  function receiveFolder(): string {
    if (process.env.KAINOS_DOWNLOADS) return process.env.KAINOS_DOWNLOADS;
    const chosen = state.receiveFolder;
    if (chosen && statSync(chosen, { throwIfNoEntry: false })?.isDirectory()) return chosen;
    return join(app.getPath('home'), 'Downloads');
  }

  async function chooseReceiveFolder(): Promise<void> {
    const options: Electron.OpenDialogOptions = {
      title: 'Save files from the phone to',
      buttonLabel: 'Choose',
      defaultPath: receiveFolder(),
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } = win.isVisible() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (!canceled && filePaths[0]) updateState({ receiveFolder: filePaths[0] }, 0);
  }

  /** Picks files and sends them to the phone's chosen folder, one at a time. */
  async function sendFilesToPhone(): Promise<void> {
    const options: Electron.OpenDialogOptions = { title: 'Send files to phone', buttonLabel: 'Send', properties: ['openFile', 'multiSelections'] };
    const { canceled, filePaths } = win.isVisible() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return;
    if (!sms?.sendFiles(filePaths)) notifyPhone('Files not sent', 'The phone is not connected.');
  }
  /** Only while the phone is connected. */
  function sendFilesItem(): MenuItemConstructorOptions {
    return { label: 'Send files to phone…', enabled: sms?.state().phone?.connected === true, click: () => void sendFilesToPhone() };
  }

  async function confirmForgetPhone(name: string): Promise<void> {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Forget', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Forget ${name}?`,
      detail: 'Its texts leave this computer, and you will need to connect it again.',
    });
    if (response === 0) sms?.forgetPhone();
  }

  /** Only after this may another phone ask to pair while one is paired: it would take that one's place. */
  async function confirmConnectAnother(name: string): Promise<void> {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Connect another phone', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Connect another phone?',
      detail: `For the next two minutes, another phone can ask to connect: in Kainos Talk on that phone, choose Connect to PC. If you connect it, it takes the place of ${name}, and ${name}'s texts leave this computer.`,
    });
    if (response !== 0) return;
    sms?.allowPairing();
    showOnTab('inbox');
  }

  /** The phone island: a menu once a phone is paired; before that it leads to the Texts page's setup. */
  function openPhoneMenu(at: MenuPoint | undefined): void {
    const inbox = runtimes.find((runtime) => runtime.service.localPage === 'inbox')!;
    const phone = sms?.state().phone;
    if (!phone) {
      activate(inbox.service.id);
      return;
    }
    const name = phone.name.slice(0, PHONE_NAME_MAX);
    Menu.buildFromTemplate([
      { label: 'Open Texts', click: () => activate(inbox.service.id) },
      sendFilesItem(),
      { type: 'separator' },
      { label: 'Connect another phone…', click: () => void confirmConnectAnother(name) },
      { label: `Forget ${name}…`, click: () => void confirmForgetPhone(name) },
    ]).popup(menuOptions(at));
  }

  /** F6: from a service page to its tab in the dock, and from the dock back into the page. */
  function switchPane(from: WebContents): void {
    if (from !== dockContents) {
      // On screen before it takes focus; the dock page then confirms keyboard focus itself.
      revealBy({ kind: 'keyboard', focused: true });
      dockContents.focus();
      dockContents.send(Channel.focusDock);
      return;
    }
    const runtime = runtimeById(state.activeServiceId);
    if (runtime?.status().kind === 'ready') shownContents(runtime)?.focus();
  }

  // Ctrl+1..9, Ctrl+Q, F5/Ctrl+R and F6 work wherever focus is: the dock or any service page.
  // The digits follow the tabs as the dock shows them.
  function handleShortcuts(contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      const tabs = dockTabs();
      const shortcut = shortcutFor(input, process.platform, tabs.length);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.kind === 'quit') app.quit();
      else if (shortcut.kind === 'switch-pane') switchPane(contents);
      else if (shortcut.kind === 'reload') runtimeById(state.activeServiceId)?.reload(shortcut.ignoreCache);
      else activate(tabs[shortcut.index]!);
    });
  }
  handleShortcuts(dockContents);
  handleShortcuts(callStrip.webContents);

  /** Hooks for each service page, set when its view is made (at startup and on each wake). */
  function wirePage(contents: WebContents): void {
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) clearPagePointer(contents);
    });
    contents.on('render-process-gone', () => clearPagePointer(contents));
    contents.on('destroyed', () => clearPagePointer(contents));
    // A Texts page that (re)loads is told whether it is in sight, as the one before it was.
    contents.on('did-finish-load', () => {
      if (contents !== smsView()) return;
      inboxShown = undefined;
      tellInboxShown();
    });
    handleShortcuts(contents);
  }
  for (const contents of unwiredPages) wirePage(contents);
  unwiredPages = undefined;

  // Dock IPC. Only the dock page may call it, and only with known service ids.
  const fromDock = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === dockContents;
  ipcMain.handle(Channel.getSnapshot, (event) => (fromDock(event) ? snapshot() : undefined));
  ipcMain.handle(Channel.getTheme, (event) => (themedPages().includes(event.sender) ? state.theme : undefined));
  const onDock = (channel: string, act: (runtime: ServiceRuntime, extra: unknown) => void) =>
    ipcMain.on(channel, (event, id: unknown, extra: unknown) => {
      const runtime = fromDock(event) && findService(id) ? runtimeById(id as string) : undefined;
      if (runtime) act(runtime, extra);
    });
  onDock(Channel.activate, (runtime) => activate(runtime.service.id));
  onDock(Channel.retry, (runtime) => runtime.restart());
  onDock(Channel.openServiceMenu, (runtime, at) => openServiceMenu(runtime, parseMenuPoint(at)));
  onDock(Channel.moveService, (runtime, raw) => {
    const index = parseDockIndex(raw);
    if (index !== undefined) moveInDock(runtime.service.id, index);
  });
  ipcMain.on(Channel.dockDrag, (event, active: unknown) => {
    if (fromDock(event)) revealBy({ kind: 'drag', active: active === true });
  });
  ipcMain.on(Channel.openBarMenu, (event, at: unknown) => {
    if (fromDock(event)) openBarMenu(parseMenuPoint(at));
  });
  ipcMain.on(Channel.openPhoneMenu, (event, at: unknown) => {
    if (fromDock(event)) openPhoneMenu(parseMenuPoint(at));
  });
  ipcMain.on(Channel.dockSize, (event, raw: unknown) => {
    const size = fromDock(event) ? parseDockSize(raw) : undefined;
    if (!size || (size.width === group?.width && size.height === group.height)) return;
    group = size;
    layout();
  });
  ipcMain.on(Channel.dockPointer, (event, over: unknown) => {
    if (fromDock(event)) revealBy({ kind: 'dock-pointer', over: over === true });
  });
  ipcMain.on(Channel.dockKeyboard, (event, focused: unknown) => {
    if (fromDock(event)) revealBy({ kind: 'keyboard', focused: focused === true });
  });
  ipcMain.on(Channel.dismissDock, (event) => {
    if (!fromDock(event)) return;
    revealBy({ kind: 'dismiss' });
    switchPane(dockContents);
  });
  // Only the page on screen moves the dock; the others are hidden and see no pointer.
  ipcMain.on(Channel.pagePointer, (event, raw: unknown) => {
    const at = parsePagePointer(raw);
    if (!at || !runtimeOf(event.sender)) return;
    pagePointers.set(event.sender, at);
    if (event.sender === shownContents(runtimeById(state.activeServiceId))) revealBy({ kind: 'page', at });
  });

  // The Texts page now: it has none while Texts is off, and a new one each time it is turned on.
  const fromSms = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const contents = smsView();
    return contents !== undefined && event.sender === contents;
  };
  // The page behind a desktop app's window asks about its own app only.
  const nativeOf = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) => [...natives.keys()].find((id) => nativePage(id) === event.sender);
  ipcMain.handle(NativeChannel.getView, (event) => {
    const id = nativeOf(event);
    return id ? nativeView(id) : undefined;
  });
  ipcMain.on(NativeChannel.open, (event) => {
    const id = nativeOf(event);
    if (id) natives.get(id)?.open();
  });
  ipcMain.handle(SmsChannel.getState, (event) => (fromSms(event) ? sms?.state() : undefined));
  ipcMain.on(SmsChannel.reply, (event, key: unknown, text: unknown) => {
    if (fromSms(event) && typeof key === 'string' && typeof text === 'string' && text.trim() && text.length <= MAX_SMS_TEXT) sms?.reply(key, text);
  });
  ipcMain.on(SmsChannel.markRead, (event, key: unknown) => {
    if (fromSms(event) && typeof key === 'string') sms?.markRead(key);
  });
  ipcMain.on(SmsChannel.answerPairing, (event, accept: unknown, code: unknown) => {
    if (fromSms(event) && typeof code === 'string') sms?.answerPairing(accept === true, code);
  });
  ipcMain.on(SmsChannel.forgetPhone, (event) => {
    if (fromSms(event)) sms?.forgetPhone();
  });
  ipcMain.on(SmsChannel.copyCode, (event, code: unknown) => {
    if (fromSms(event) && isCopyableCode(code)) clipboard.writeText(code);
  });
  ipcMain.on(SmsChannel.answer, (event) => {
    if (fromSms(event)) sms?.answer();
  });
  ipcMain.on(SmsChannel.hangUp, (event) => {
    if (fromSms(event)) sms?.hangUp();
  });
  ipcMain.on(SmsChannel.connectCallAudio, (event) => {
    if (fromSms(event)) connectCallAudio();
  });
  ipcMain.on(SmsChannel.dial, (event, to: unknown) => {
    if (!fromSms(event) || typeof to !== 'object' || to === null) return;
    const { number, key } = to as Record<string, unknown>;
    // Connecting takes a fraction of a second, well before the other phone picks up.
    connectCallAudio();
    if (typeof number === 'string' && number.length <= 40) sms?.dial({ number });
    else if (typeof key === 'string' && key.length <= 500) sms?.dial({ key });
  });
  ipcMain.on(SmsChannel.send, (event, to: unknown, text: unknown) => {
    if (fromSms(event) && typeof to === 'string' && typeof text === 'string' && text.length <= MAX_SMS_TEXT) sms?.send(to, text);
  });

  forwardNotifications({
    runtimeFor: runtimeOf,
    isMuted: (id) => state.mutedServiceIds.includes(id),
    focusService: showOnTab,
    fallbackIcon: icons.plain,
  });

  try {
    tray = new Tray(icons.plain);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(trayMenu());
    tray.on('click', showWindow);
  } catch (error) {
    console.warn('No system tray; closing the window will quit.', error);
  }

  win.on('closed', () => {
    clearTimeout(revealTimer);
    for (const runtime of runtimes) {
      for (const contents of [runtime.call()?.webContents, runtime.view()?.webContents]) if (contents && !contents.isDestroyed()) contents.close();
    }
    if (!dockContents.isDestroyed()) dockContents.close();
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
  dockContents.once('did-finish-load', () => {
    if (state.maximized) win.maximize();
    win.show();
  });
  // A dock page that crashed or reloaded drops any drag it had in progress.
  dockContents.on('render-process-gone', () => revealBy({ kind: 'drag', active: false }));
  // A fresh dock page has missed the frames sent while it loaded, and has no drag in progress.
  dockContents.on('did-finish-load', () => {
    sentFrame = '';
    feed({ kind: 'drag', active: false });
    layout();
  });

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  /** Desktop apps on a tab go back to ordinary windows before Kainos goes. */
  let released = false;
  app.on('before-quit', (event) => {
    quitting = true;
    updateState({}, 0);
    if (released || natives.size === 0) return;
    event.preventDefault();
    void Promise.allSettled([...natives.values()].map((native) => native.release())).then(() => {
      released = true;
      app.quit();
    });
  });
  // Stopping Texts stops the clipboard watcher; quitting has to as well, or wl-paste outlives Kainos.
  // A backup in progress stops too; the next run uploads what it missed.
  app.on('will-quit', () => {
    clipboardSync?.stop();
    driveBackup.stop();
  });

  // The local pages load once their IPC handlers exist: a page that asks for its theme earlier
  // gets no answer and stays on the system theme.
  dockContents.loadFile(join(__dirname, 'renderer', 'index.html')).catch((error: unknown) => console.error(error));
  callStrip.webContents.loadFile(join(__dirname, 'renderer', 'call-strip.html')).catch((error: unknown) => console.error(error));
  // First launch, or nothing left on: Kainos opens on Choose your apps.
  if (!state.welcomed || state.enabledServiceIds.length === 0) showApps();
  render();
  // A desktop app on a tab starts with Kainos, out of sight, as the websites load with it.
  for (const [id, native] of natives) if (isOn(id)) native.startInBackground();
}
