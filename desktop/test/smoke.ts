// Boots the built app off screen and checks it end to end against the live services.
// Nothing reaches the user's desktop: Electron runs with the headless Ozone platform and no
// DISPLAY or WAYLAND_DISPLAY, on a private D-Bus session that can activate nothing and whose
// only tray host and notification server is test/fake-desktop-host.py, and links never open a
// browser. Screenshots land in desktop/.verify/ (or KAINOS_VERIFY_DIR).
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPaired, conversation, startPairing, type FakePhoneLink } from './fake-phone.ts';
import { markPng } from '../src/main/app-icon.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
// KAINOS_VERIFY_DIR moves the screenshots elsewhere, for example to keep an earlier set.
const verify = process.env.KAINOS_VERIFY_DIR ?? join(desktop, '.verify');
const electronPath = createRequire(import.meta.url)('electron') as string;
const SERVICE_IDS = ['inbox', 'proton-mail', 'discord', 'whatsapp', 'messenger'] as const;
/** The SMS sync server's port in the smoke run, away from a real Kainos Talk's. */
const syncPort = 49_000 + Math.floor(Math.random() * 500);
let smsPhone: FakePhoneLink | undefined;
type ServiceId = (typeof SERVICE_IDS)[number];
/** A service's place in the bar, and its Ctrl+digit. */
const nth = (id: ServiceId) => SERVICE_IDS.indexOf(id);
const digit = (id: ServiceId) => nth(id) + 1;

const failures: string[] = [];
const warnings: string[] = [];
const say = (word: string, label: string, detail: string) => console.log(`${word.padEnd(4)}  ${label}${detail ? `  (${detail})` : ''}`);
/** A check of Kainos Talk itself: a failure fails the run. */
function check(ok: boolean, label: string, detail = ''): void {
  say(ok ? 'PASS' : 'FAIL', label, detail);
  if (!ok) failures.push(label);
}
/** A check that depends on a live site's own markup: a miss is a warning, not a Kainos failure. */
function live(ok: boolean, label: string, detail = ''): void {
  say(ok ? 'PASS' : 'WARN', label, detail);
  if (!ok) warnings.push(label);
}
/** Something this environment cannot prove; reported, never counted as a pass. */
function skip(label: string, detail = ''): void {
  say('SKIP', label, detail);
}
function info(label: string, detail = ''): void {
  say('INFO', label, detail);
}

async function poll<T>(probe: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await probe();
  while (!done(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await probe();
  }
  return value;
}

interface FakeNotification {
  readonly id: number;
  readonly app: string;
  readonly replaces: number;
  readonly summary: string;
  readonly body: string;
}

interface PrivateBus {
  readonly address: string;
  readonly trayItems: string[];
  /** Every Notify call the fake notification server received, in order. */
  readonly notifications: FakeNotification[];
  /** Server ids of notifications the app closed (CloseNotification). */
  readonly closed: number[];
  /** Sends a command to the fake notification server's stdin ("closed <id> <reason>", "action <id> <key>"). */
  serverCommand(line: string): void;
  /** Plays a desktop with or without a tray host (StatusNotifierHost). */
  setTrayHost(registered: boolean): void;
  stop(): void;
}

/** The environment minus anything that leads to the user's real desktop session. */
function offDesktop(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'DBUS_SESSION_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE']) delete env[name];
  return { ...env, ...extra };
}

/** Rejects if `child` exits or fails to spawn before `ready` settles, or after `ms`. */
function startup<T>(child: ChildProcess, what: string, ms: number, ready: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} not ready after ${ms / 1000} s`)), ms);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`${what} exited early (${signal ?? code})`)));
    ready((value) => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve(value);
    });
  });
}

/**
 * A throwaway D-Bus session with stand-in tray and notification servers on it.
 * Its config lists no service directories, so nothing on it can be D-Bus-activated: no real
 * notification daemon, portal, keyring or accessibility bus can start against the user's
 * display. The daemon and the stand-ins also run without DISPLAY or WAYLAND_DISPLAY.
 */
async function privateBus(): Promise<PrivateBus> {
  const dir = mkdtempSync(join(tmpdir(), 'kainos-bus-'));
  const config = join(dir, 'bus.conf');
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${dir}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const daemon = spawn('dbus-daemon', [`--config-file=${config}`, '--nofork', '--print-address=1'], {
    env: offDesktop(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let host: ChildProcess | undefined;
  const stop = () => {
    host?.kill();
    daemon.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const address = await startup<string>(daemon, 'dbus-daemon', 10_000, (resolve) =>
      daemon.stdout!.once('data', (chunk: Buffer) => resolve(chunk.toString().trim())),
    );
    const trayItems: string[] = [];
    const notifications: FakeNotification[] = [];
    const closed: number[] = [];
    const started = spawn('python3', [join(desktop, 'test', 'fake-desktop-host.py')], {
      env: offDesktop({ DBUS_SESSION_BUS_ADDRESS: address }),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    host = started;
    await startup<void>(started, 'fake desktop host', 10_000, (resolve) => {
      started.stdout!.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line === 'ready') resolve();
          if (line.startsWith('registered ')) trayItems.push(line);
          if (line.startsWith('notify ')) notifications.push(JSON.parse(line.slice('notify '.length)) as FakeNotification);
          if (line.startsWith('close ')) closed.push(Number(line.slice('close '.length)));
        }
      });
    });
    const setTrayHost = (registered: boolean) => {
      execFileSync(
        'dbus-send',
        ['--print-reply', `--bus=${address}`, '--dest=org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher.SetHostRegistered', `boolean:${registered}`],
        { env: offDesktop(), stdio: 'ignore' },
      );
    };
    const serverCommand = (line: string) => void started.stdin!.write(`${line}\n`);
    return { address, trayItems, notifications, closed, serverCommand, setTrayHost, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

let bus: PrivateBus | undefined;

function launch(profile: string): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: electronPath,
    args: ['--ozone-platform=headless', '--ozone-override-screen-size=1400,900', '--disable-gpu', '--mute-audio', desktop],
    env: offDesktop({
      KAINOS_USER_DATA: profile,
      KAINOS_BLOCK_EXTERNAL: '1',
      KAINOS_SYNC_PORT: String(syncPort),
      KAINOS_SYNC_MDNS: '0',
      // Websites that start asleep load nothing; Playwright needs every view to load a page.
      KAINOS_BLANK_WHEN_ASLEEP: '1',
      DBUS_SESSION_BUS_ADDRESS: bus!.address,
    }),
    timeout: 60_000,
  });
}

async function sidebar(app: ElectronApplication): Promise<Page> {
  const page = await poll(
    async () => app.windows().find((candidate) => candidate.url().endsWith('/renderer/index.html')),
    Boolean,
    20_000,
  );
  if (!page) throw new Error('sidebar page never opened');
  check(await app.evaluate(({ BaseWindow, BrowserWindow }) => !(BaseWindow.getAllWindows()[0] instanceof BrowserWindow)), 'the main window has no renderer of its own');
  page.setDefaultTimeout(20_000);
  await page.waitForSelector('.socket:nth-child(3)');
  return page;
}

/** Runs JavaScript in one service page from the main process. */
/** Runs JavaScript in one service page from the main process; `gesture` counts it as a user action. */
function inService<T>(app: ElectronApplication, id: ServiceId, code: string, gesture = false): Promise<T> {
  return app.evaluate(
    ({ BaseWindow }, { index, code, gesture }) =>
      (BaseWindow.getAllWindows()[0]!.contentView.children[index] as Electron.WebContentsView).webContents.executeJavaScript(code, gesture),
    { index: SERVICE_IDS.indexOf(id), code, gesture },
  ) as Promise<T>;
}

/** Sends a key through Electron's input pipeline (before-input-event sees it), to the sidebar or a service. */
function sendKey(app: ElectronApplication, target: 'sidebar' | ServiceId, keyCode: string, modifiers: string[] = []): Promise<void> {
  return app.evaluate(
    ({ BaseWindow }, { index, keyCode, modifiers }) => {
      const win = BaseWindow.getAllWindows()[0]!;
      const contents = (win.contentView.children.at(index) as Electron.WebContentsView).webContents;
      const mods = modifiers as NonNullable<Electron.KeyboardInputEvent['modifiers']>;
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    },
    { index: target === 'sidebar' ? -1 : SERVICE_IDS.indexOf(target), keyCode, modifiers },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Records every Menu.popup() call instead of showing the menu, and answers every message box
 * with its first button. Clicks on a recorded menu go through clickMenuItem().
 */
function stubMenusAndDialogs(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ Menu, dialog }) => {
    const g = globalThis as Record<string, unknown>;
    g.__menus = [] as unknown[];
    g.__boxes = [] as unknown[];
    Menu.prototype.popup = function popup(this: Electron.Menu, options?: Electron.PopupOptions) {
      (g.__menus as unknown[]).push({ menu: this, x: options?.x, y: options?.y, labels: this.items.map((item) => item.label) });
      // A real menu closes after its click; the recorded one counts as closed straight away.
      setTimeout(() => options?.callback?.(), 0);
    };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((arg) => typeof arg === 'object' && arg !== null && 'message' in arg) as Electron.MessageBoxOptions;
      (g.__boxes as unknown[]).push({ type: options.type, message: options.message });
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}

interface MenuRecord {
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly labels: string[];
}
const menus = (app: ElectronApplication) =>
  app.evaluate(() => ((globalThis as Record<string, unknown>).__menus as (MenuRecord & { menu: unknown })[]).map(({ x, y, labels }) => ({ x, y, labels })));
const boxes = (app: ElectronApplication) => app.evaluate(() => (globalThis as Record<string, unknown>).__boxes as { type: string; message: string }[]);
/** Clicks the item whose label starts with `label` in the last recorded menu. */
function clickMenuItem(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate((_electron, label) => {
    const all = (globalThis as Record<string, unknown>).__menus as { menu: Electron.Menu }[];
    const item = all.at(-1)?.menu.items.find((candidate) => candidate.label.startsWith(label));
    item?.click();
    return Boolean(item);
  }, label);
}

/** The active service's bounds inside the window. */
const viewBounds = (app: ElectronApplication, id: ServiceId) =>
  app.evaluate(({ BaseWindow }, index) => (BaseWindow.getAllWindows()[0]!.contentView.children[index] as Electron.WebContentsView).getBounds(), SERVICE_IDS.indexOf(id));
const serviceFocused = (app: ElectronApplication, id: ServiceId) =>
  app.evaluate(({ BaseWindow }, index) => (BaseWindow.getAllWindows()[0]!.contentView.children[index] as Electron.WebContentsView).webContents.isFocused(), SERVICE_IDS.indexOf(id));
/** Index of the rail socket whose button has keyboard focus in the sidebar, or -1. */
const railFocus = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.socket')].findIndex((socket) => socket.contains(document.activeElement)));

function serviceUrl(app: ElectronApplication, id: ServiceId): Promise<string> {
  return app.evaluate(
    ({ BaseWindow }, index) => (BaseWindow.getAllWindows()[0]!.contentView.children[index] as Electron.WebContentsView).webContents.getURL(),
    SERVICE_IDS.indexOf(id),
  );
}

/**
 * Presses Ctrl+<digit> through Electron's own input pipeline. Playwright's keyboard goes
 * through DevTools, which skips the before-input-event hook the shortcut listens on.
 * `target` is the sidebar or a service page, to prove the shortcut works with focus in either.
 */
async function pressShortcut(app: ElectronApplication, page: Page, target: 'sidebar' | ServiceId, digit: number): Promise<number> {
  await app.evaluate(
    ({ BaseWindow }, { index, key }) => {
      const win = BaseWindow.getAllWindows()[0]!;
      const contents = (win.contentView.children.at(index) as Electron.WebContentsView).webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] });
    },
    { index: target === 'sidebar' ? -1 : SERVICE_IDS.indexOf(target), key: String(digit) },
  );
  return poll(() => activeIndex(page), (index) => index === digit - 1, 5000);
}

/** Proportional set size of a process and all its descendants, from /proc (Linux). */
function processTreePssMb(root: number): number {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch {
      // The process ended meanwhile.
    }
  }
  let kb = 0;
  const pending = [root];
  while (pending.length) {
    const pid = pending.pop()!;
    try {
      kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
    } catch {
      // The process ended meanwhile.
    }
    pending.push(...(children.get(pid) ?? []));
  }
  return Math.round(kb / 1024);
}

const status = (page: Page, id: ServiceId) => page.locator('.socket').nth(SERVICE_IDS.indexOf(id)).getAttribute('data-status');
const activeIndex = (page: Page) => page.locator('.socket').evaluateAll((items) => items.findIndex((item) => item.hasAttribute('data-active')));

/** Screenshot of the whole window: every visible view (service, then the sidebar page above it) in order. */
async function screenshot(app: ElectronApplication, name: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BaseWindow, BrowserWindow }) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!;
    const [width, height] = win.getContentSize();
    const background = win.getBackgroundColor();
    const layers: { url: string; x: number }[] = [];
    for (const view of win.contentView.children as Electron.WebContentsView[]) {
      if (view.getVisible()) layers.push({ url: (await view.webContents.capturePage()).toDataURL(), x: view.getBounds().x });
    }
    const canvas = new BrowserWindow({ show: false, width: 200, height: 200 });
    await canvas.loadURL('about:blank');
    const result: string = await canvas.webContents.executeJavaScript(`(async () => {
      const load = (src) => { const img = new Image(); img.src = src; return img.decode().then(() => img); };
      const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height};
      const g = c.getContext('2d'); g.fillStyle = ${JSON.stringify(background)}; g.fillRect(0, 0, c.width, c.height);
      for (const layer of ${JSON.stringify(layers)}) g.drawImage(await load(layer.url), layer.x, 0);
      return c.toDataURL('image/png');
    })()`);
    canvas.destroy();
    return result;
  });
  const file = join(verify, `${name}.png`);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
  console.log(`      screenshot ${file}`);
}

/** Quits through the app's own quit path unless it already exited, then makes sure the process is gone. */
async function shutdown(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = exits(app, 10_000);
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    if (!(await exited)) proc.kill('SIGKILL');
  }
  await app.close().catch(() => undefined);
}

/** Waits for the app process to exit; true if it did within `ms`. */
function exits(app: ElectronApplication, ms: number): Promise<boolean> {
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return Promise.race([new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true))), sleep(ms).then(() => false)]);
}

function nextAppEvent<T>(app: ElectronApplication, event: string): Promise<T> {
  return app.evaluate(
    ({ app: electronApp }, name) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${name} event`)), 10_000);
        electronApp.once(name as 'ready', (payload: unknown) => {
          clearTimeout(timer);
          const record = payload as { serviceId?: string; muted?: boolean; notification?: unknown };
          (globalThis as Record<string, unknown>).__kainosLast = payload;
          resolve(typeof payload === 'string' ? payload : { serviceId: record.serviceId, muted: record.muted, shown: Boolean(record.notification) });
        });
      }),
    event,
  ) as Promise<T>;
}

async function main(): Promise<void> {
  mkdirSync(verify, { recursive: true });
  bus = await privateBus();
  const profile = mkdtempSync(join(tmpdir(), 'kainos-smoke-'));
  try {
    await run(profile);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

async function run(profile: string): Promise<void> {
  const stateFile = join(profile, 'kainos-state.json');
  if (process.env.KAINOS_PSS_ONLY === '1') {
    writeFileSync(stateFile, JSON.stringify({ activeServiceId: 'inbox' }));
    const app = await launch(profile);
    try {
      await sidebar(app);
      await sleep(5000);
      const root = app.process().pid!;
      const tree = (pid: number): number[] => {
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
        return [pid, ...children.flatMap(tree)];
      };
      const samples = [];
      for (let i = 0; i < 3; i++) {
        samples.push(tree(root).map((pid) => ({ pid, pssKiB: Number(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)![1]) })));
        await sleep(1000);
      }
      console.log('PSS', JSON.stringify({ samples, totalsKiB: samples.map((sample) => sample.reduce((total, process) => total + process.pssKiB, 0)) }));
    } finally { await shutdown(app); }
    return;
  }
  // Saved state from a "previous session": WhatsApp was open and Discord was muted.
  writeFileSync(stateFile, JSON.stringify({ activeServiceId: 'whatsapp', mutedServiceIds: ['discord'] }));

  let app = await launch(profile);
  let quitByKey = false;
  try {
    const page = await sidebar(app);
    await stubMenusAndDialogs(app);
    check((await activeIndex(page)) === nth('whatsapp'), 'restores the last active service (WhatsApp)');
    check((await page.locator('.socket').nth(nth('discord')).getAttribute('data-muted')) !== null, 'restores muted state (Discord)');
    if ((await status(page, 'whatsapp')) === 'loading') await screenshot(app, '01-loading-light');

    const asleepAtStart = await Promise.all((['proton-mail', 'discord', 'messenger'] as const).map((id) => status(page, id)));
    check(asleepAtStart.every((value) => value === 'asleep'), 'websites stay asleep until opened, except the one open at quit', asleepAtStart.join(', '));
    for (const id of ['inbox', 'whatsapp'] as const) {
      const final = await poll(() => status(page, id), (value) => value !== 'loading', 90_000);
      check(final === 'ready', `${id} loads at startup`, `status ${final}`);
    }
    // Open each website once, so the checks below can use all of them, then go back to WhatsApp.
    for (const id of ['proton-mail', 'discord', 'messenger'] as const) {
      await pressShortcut(app, page, 'sidebar', digit(id));
      const final = await poll(() => status(page, id), (value) => value === 'ready' || value === 'failed', 90_000);
      check(final === 'ready', `${id} loads when opened`, `status ${final}`);
    }
    await pressShortcut(app, page, 'sidebar', digit('whatsapp'));
    const startupFocus = await poll(() => serviceFocused(app, 'whatsapp'), Boolean, 3000);
    if (startupFocus) check(true, 'the active service (WhatsApp) has keyboard focus once it is ready');
    else skip('the active service has keyboard focus once it is ready', 'the off-screen window never reports focus, so the app waits for it');

    for (const id of SERVICE_IDS) {
      const ua = await inService<string>(app, id, 'navigator.userAgent');
      check(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua) && !/Electron|Kainos/i.test(ua), `${id} sees a plain Chrome user agent`, ua);
    }

    // Signed-out screens. Ctrl+1 / Ctrl+2 exercise the shortcut, WhatsApp uses a click.
    // These read each site's own markup, so a miss is a warning, not a Kainos failure.
    check((await pressShortcut(app, page, 'whatsapp', digit('proton-mail'))) === nth('proton-mail'), `Ctrl+${digit('proton-mail')} inside WhatsApp switches to Proton Mail`);
    const proton = await poll(
      () => inService<boolean>(app, 'proton-mail', `location.host === 'account.proton.me' && !!document.querySelector('#username')`),
      Boolean,
      45_000,
    );
    live(proton, 'Proton Mail reaches its sign-in page on account.proton.me (live site)', await serviceUrl(app, 'proton-mail'));
    await sleep(2000);
    await screenshot(app, '02-proton-signin');

    check((await pressShortcut(app, page, 'sidebar', digit('discord'))) === nth('discord'), `Ctrl+${digit('discord')} in the sidebar switches to Discord`);
    const discord = await poll(
      () => inService<boolean>(app, 'discord', `location.pathname.startsWith('/login') && !!document.querySelector('input[name="email"]')`),
      Boolean,
      45_000,
    );
    live(discord, 'Discord reaches its login page (live site)', await serviceUrl(app, 'discord'));
    await sleep(2000);
    await screenshot(app, '03-discord-login');

    await page.locator('.socket').nth(nth('whatsapp')).locator('.tile').click();
    check((await activeIndex(page)) === nth('whatsapp'), 'clicking the WhatsApp tile switches to it');
    const whatsappText = await poll(
      () => inService<string>(app, 'whatsapp', `document.querySelector('canvas') ? 'QR ' + document.body.innerText : document.body.innerText`),
      (text) => text.startsWith('QR '),
      60_000,
    );
    const unsupported = /update (your )?(browser|chrome)|works with google chrome|browser (is not|isn't) supported|unsupported browser/i.test(whatsappText);
    check(!unsupported, 'WhatsApp does not show its unsupported-browser page', whatsappText.slice(0, 160).replace(/\s+/g, ' '));
    live(whatsappText.startsWith('QR '), 'WhatsApp shows its QR link screen (live site)');
    await sleep(2000);
    await screenshot(app, '04-whatsapp-qr');

    check((await pressShortcut(app, page, 'whatsapp', digit('messenger'))) === nth('messenger'), `Ctrl+${digit('messenger')} switches to Messenger`);
    const messenger = await poll(
      () => inService<boolean>(app, 'messenger', `!!document.querySelector('input[name="email"], input#email') && !!document.querySelector('input[type="password"]')`),
      Boolean,
      45_000,
    );
    live(messenger, 'Messenger reaches its sign-in form (live site)', await serviceUrl(app, 'messenger'));
    await sleep(2000);
    await screenshot(app, '04b-messenger-signin');

    check((await pressShortcut(app, page, 'sidebar', digit('inbox'))) === nth('inbox'), `Ctrl+${digit('inbox')} switches to the Inbox`);
    // SMS: the phone's texts arrive from the Kainos phone app (a fake one here) over TLS.
    const smsText = () => inService<string>(app, 'inbox', 'document.body.innerText');
    check(/Connect your phone/.test(await poll(smsText, (t) => /Connect your phone/.test(t), 10_000)), 'with no phone paired, SMS explains how to connect one');
    await screenshot(app, '04c-sms-setup');
    const pairing = await startPairing(syncPort, 'Pixel 9');
    const shownCode = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`;
    check((await poll(smsText, (t) => t.includes(shownCode), 5000)).includes(shownCode), 'a phone asking to pair shows the same code on the PC', shownCode);
    await screenshot(app, '04d-sms-pairing');
    await inService(app, 'inbox', `document.querySelector('.primary').click(); 1`, true);
    check((await poll(smsText, (t) => /waiting for the phone/i.test(t), 5000)).match(/waiting for the phone/i) !== null, 'after Connect, the PC waits for the phone to confirm the code too');
    pairing.confirm();
    const { deviceId } = await pairing.paired();
    smsPhone = await connectPaired(syncPort, deviceId);
    check(true, 'with the code confirmed on both screens, the phone is paired and signs in with its own certificate');
    const smsNotified = nextAppEvent<{ serviceId: string; muted: boolean; shown: boolean }>(app, 'kainos-notification');
    const hourAgo = Date.now() - 3_600_000;
    smsPhone.send({ t: 'conversation', conversation: conversation('sms|0|s:garage', 'Garage Delaunay', [{ id: 'g1', text: 'Your car is ready. We close at 18:30.', timeMs: hourAgo }]) });
    smsPhone.send({ t: 'conversation', conversation: conversation('sms|0|s:mum', 'Mum', [{ id: 'm1', text: 'Dinner on Sunday?', timeMs: Date.now() }]) });
    const notified = await smsNotified;
    check(notified.serviceId === 'inbox' && notified.shown, 'a new text raises a desktop notification', JSON.stringify(notified));
    check((await poll(() => page.locator('.socket').nth(nth('inbox')).locator('.badge').textContent(), (t) => t === '2', 5000)) === '2', 'the SMS badge counts unread texts');
    await sleep(500);
    await screenshot(app, '04e-sms-inbox');
    await inService(app, 'inbox', `document.querySelector('.row[data-key="sms|0|s:garage"]').click(); 1`, true);
    check((await smsPhone.next('read')).key === 'sms|0|s:garage', 'opening a conversation marks it read on the phone');
    await inService(app, 'inbox', `(() => { const t = document.querySelector('textarea'); t.value = 'Coming at 18:00'; t.dispatchEvent(new Event('input')); t.form.requestSubmit(); return 1; })()`, true);
    const reply = await smsPhone.next('reply');
    check(reply.key === 'sms|0|s:garage' && reply.text === 'Coming at 18:00', 'a reply typed on the PC reaches the phone', JSON.stringify(reply));
    smsPhone.send({ t: 'replyResult', id: reply.id, ok: true, error: null });
    smsPhone.send({
      t: 'conversation',
      conversation: conversation('sms|0|s:garage', 'Garage Delaunay', [
        { id: 'g1', text: 'Your car is ready. We close at 18:30.', timeMs: hourAgo },
        { id: 'g2', text: 'Coming at 18:00', timeMs: Date.now(), outgoing: true },
      ], 0),
    });
    check((await poll(smsText, (t) => t.includes('Coming at 18:00'), 5000)).includes('Coming at 18:00'), 'the sent reply shows in the thread');
    await inService(app, 'inbox', `document.querySelector('.row[data-key="sms|0|s:mum"]').click(); 1`, true);
    await smsPhone.next('read');
    check((await poll(() => page.locator('.socket').nth(nth('inbox')).locator('.badge').textContent(), (t) => t === '', 5000)) === '', 'reading every text clears the SMS badge');
    await inService(app, 'inbox', `document.querySelector('.row[data-key="sms|0|s:garage"]').click(); 1`, true);
    // A picture message: the view asks the phone for the picture when it shows it.
    const withPicture = conversation('sms|0|s:garage', 'Garage Delaunay', [
      { id: 'g1', text: 'Your car is ready. We close at 18:30.', timeMs: hourAgo },
      { id: 'g2', text: 'Coming at 18:00', timeMs: Date.now() - 60_000, outgoing: true },
      { id: 'g3', text: 'The new tyres', timeMs: Date.now() },
    ], 0);
    smsPhone.send({ t: 'conversation', conversation: { ...withPicture, messages: withPicture.messages.map((m) => (m.id === 'g3' ? { ...m, media: 'image', image: 'mms-part:1' } : m)) } });
    const asked = await smsPhone.next('getImage');
    smsPhone.send({ t: 'image', id: asked.id, mime: 'image/jpeg', data: markPng(240, false).toString('base64'), error: null });
    const pictureShown = await poll(() => inService<boolean>(app, 'inbox', `!!document.querySelector('.bubble-image')?.src?.startsWith('kainos-image://') && document.querySelector('.bubble-image').naturalWidth > 0`), Boolean, 5000);
    check(pictureShown && asked.id === 'mms-part:1', 'a picture in a text is fetched from the phone and shown in the thread');
    await sleep(500);
    await screenshot(app, '04f-sms-thread');
    await inService(app, 'inbox', `document.querySelector('.bubble-image').click(); 1`, true);
    check(await poll(() => inService<boolean>(app, 'inbox', `!!document.querySelector('dialog.lightbox[open] img')`), Boolean, 3000), 'clicking a picture opens it full size');
    await sleep(300);
    await screenshot(app, '04g-sms-picture');
    check((await inService<string>(app, 'inbox', `document.querySelector('dialog.lightbox img').src`)).startsWith('kainos-image://'), 'the full-size picture is the same picture URL, not a copy of its bytes');
    await inService(app, 'inbox', `document.querySelector('dialog.lightbox').close(); 1`, true);
    const gallery = conversation('sms|0|s:garage', 'Garage Delaunay', Array.from({ length: 80 }, (_, i) => ({ id: `lazy-${i}`, text: `Picture ${i}`, timeMs: hourAgo + i })), 0);
    smsPhone.send({ t: 'conversation', conversation: { ...gallery, messages: gallery.messages.map((m, i) => ({ ...m, media: 'image', image: `lazy:${i}` })) } });
    await poll(() => inService<number>(app, 'inbox', `document.querySelectorAll('.bubble-image').length`), count => count === 80, 5000);
    await sleep(1500);
    const initiallyRequested = smsPhone.frames.filter(frame => frame.t === 'getImage' && frame.id.startsWith('lazy:')).length;
    check(initiallyRequested > 0 && initiallyRequested < 40, 'a long picture thread fetches only pictures near the viewport at first', `${initiallyRequested}/80`);
    for (let i = 79; i >= 0; i -= 2) {
      await inService(app, 'inbox', `document.querySelectorAll('.bubble-image')[${i}].scrollIntoView(); 1`);
      await sleep(60);
    }
    await sleep(1000);
    const afterScrolling = smsPhone.frames.filter(frame => frame.t === 'getImage' && frame.id.startsWith('lazy:')).length;
    check(afterScrolling === 80, 'scrolling the picture thread fetches the remaining pictures', `${afterScrolling}/80`);
    smsPhone.send({ t: 'conversation', conversation: withPicture });
    await poll(() => inService<number>(app, 'inbox', `document.querySelectorAll('.bubble-image').length`), count => count === 0, 5000);
    // Pictures are the inbox's alone: a website can neither load nor fetch one.
    const websiteTries = await inService<string>(
      app,
      'whatsapp',
      `(async () => {
        const url = 'kainos-image://picture/mms-part%3A1';
        const img = await new Promise((done) => { const i = new Image(); i.onload = () => done('loaded'); i.onerror = () => done('refused'); i.src = url; });
        const got = await fetch(url).then(() => 'fetched', () => 'refused');
        return img + ' ' + got;
      })()`,
    );
    const handledIn = await app.evaluate(({ BaseWindow }) =>
      (BaseWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[]).slice(0, 5).map((view) => view.webContents.session.protocol.isProtocolHandled('kainos-image')),
    );
    check(websiteTries === 'refused refused' && JSON.stringify(handledIn) === JSON.stringify([true, false, false, false, false]), 'a website cannot read the inbox pictures (only the inbox session serves kainos-image:)', `${websiteTries}; handled ${JSON.stringify(handledIn)}`);
    await inService(app, 'inbox', `(() => { const f = document.querySelector('.search input'); f.value = 'tyres'; f.dispatchEvent(new Event('input')); return 1; })()`, true);
    const found = await poll(() => inService<string[]>(app, 'inbox', `[...document.querySelectorAll('.row .row-title')].map((t) => t.textContent)`), (t) => t.length === 1, 3000);
    check(found.length === 1 && found[0] === 'Garage Delaunay', 'search finds a conversation by its text', JSON.stringify(found));

    // Sleep: a website can sleep to free its memory; its badge then comes from the inbox.
    const rendererOf = (id: ServiceId) =>
      app.evaluate(({ BaseWindow, app: electronApp }, index) => {
        const pid = (BaseWindow.getAllWindows()[0]!.contentView.children[index] as Electron.WebContentsView).webContents.getOSProcessId();
        const metric = electronApp.getAppMetrics().find((m) => m.pid === pid);
        return metric ? { pid, mb: Math.round(metric.memory.workingSetSize / 1024) } : null;
      }, nth(id));
    const running = (pid: number) => app.evaluate(({ app: electronApp }, pid) => electronApp.getAppMetrics().some((m) => m.pid === pid), pid);
    const awake = await rendererOf('discord');
    await page.locator('.socket').nth(nth('discord')).locator('.tile').click({ button: 'right' });
    const discordMenu = (await poll(() => menus(app), (all) => all.at(-1)?.labels.includes('Sleep now') === true, 5000)).at(-1);
    check(discordMenu?.labels.includes('Keep running in the background') === true, "a website's menu offers Keep running and Sleep now", JSON.stringify(discordMenu?.labels));
    await clickMenuItem(app, 'Sleep now');
    check((await poll(() => status(page, 'discord'), (value) => value === 'asleep', 5000)) === 'asleep', 'Sleep now puts Discord to sleep');
    await sleep(3000);
    const asleep = await rendererOf('discord');
    info('Discord page renderer memory, awake then asleep (MB)', `${awake?.mb} → ${asleep?.mb ?? 'no renderer'}`);
    check(awake !== null && asleep === null && !(await running(awake.pid)), "sleeping closes the page's renderer process", JSON.stringify({ awake, asleep }));
    smsPhone.send({ t: 'conversation', conversation: conversation('discord|0|s:pavlo', 'pavlo.k', [{ id: 'd1', text: 'did the fix land?', timeMs: Date.now() }], 2, 'discord') });
    const discordBadge = () => page.locator('.socket').nth(nth('discord')).locator('.badge').textContent();
    check((await poll(discordBadge, (t) => t === '2', 5000)) === '2', "an asleep website's badge shows what the inbox has unread for it");
    await screenshot(app, '04h-discord-asleep');
    await pressShortcut(app, page, 'sidebar', digit('discord'));
    check((await poll(() => status(page, 'discord'), (value) => value === 'ready', 60_000)) === 'ready', 'opening an asleep website wakes it');
    const wokenNotified = nextAppEvent<{ serviceId: string }>(app, 'kainos-notification');
    await inService(app, 'discord', `new Notification('From the woken page'); 1`);
    check((await wokenNotified).serviceId === 'discord', 'a notification from the woken Discord page is routed to Discord');
    // The Inbox is out of sight now, with Garage Delaunay still open in it: a new text there stays unread until the Inbox is seen.
    smsPhone.send({
      t: 'conversation',
      conversation: conversation('sms|0|s:garage', 'Garage Delaunay', [
        { id: 'g1', text: 'Your car is ready. We close at 18:30.', timeMs: hourAgo },
        { id: 'g4', text: 'Keys are at the desk', timeMs: Date.now() },
      ]),
    });
    await sleep(2000);
    const readWhileHidden = smsPhone.frames.findIndex((frame) => frame.t === 'read');
    if (readWhileHidden >= 0) smsPhone.frames.splice(readWhileHidden, 1);
    check(readWhileHidden < 0, 'a text arriving in the open conversation while the Inbox is hidden is not marked read');
    check((await pressShortcut(app, page, 'discord', digit('inbox'))) === nth('inbox'), `Ctrl+${digit('inbox')} from the woken Discord page switches to the Inbox`);
    if (readWhileHidden < 0) check((await smsPhone.next('read')).key === 'sms|0|s:garage', 'showing the Inbox again marks the open conversation read');
    await inService(app, 'inbox', `(() => { const f = document.querySelector('.search input'); f.value = ''; f.dispatchEvent(new Event('input')); return 1; })()`, true);
    await inService(app, 'inbox', `document.querySelector('.bubbles').dataset.kept = ''; 1`);
    smsPhone.send({ t: 'conversation', conversation: conversation('discord|0|s:pavlo', 'pavlo.k', [{ id: 'd2', text: 'merged it', timeMs: Date.now() }], 1, 'discord') });
    await poll(smsText, (t) => t.includes('merged it'), 5000);
    check(await inService<boolean>(app, 'inbox', `document.querySelector('.bubbles').dataset.kept === ''`), 'news in another conversation leaves the open thread as it is');

    // Unread counts come from page titles.
    const badge = (index: number) => page.locator('.socket').nth(index + 1).locator('.badge');
    await inService(app, 'proton-mail', `document.title = '(4) Inbox | Proton Mail'`);
    await inService(app, 'discord', `document.title = '• Discord | #general'`);
    check((await poll(() => badge(0).textContent(), (text) => text === '4', 5000)) === '4', 'Proton badge shows 4');
    const marker = await poll(() => badge(1).getAttribute('data-marker'), (value) => value !== null, 5000);
    check(marker !== null, 'Discord badge shows an unread marker');
    // With the phone connected the inbox counts every source, so the title follows the inbox alone.
    const inboxCount = (await inService<string>(app, 'inbox', 'document.title')).match(/^\((\d+)\)/)?.[1];
    const expectedTitle = inboxCount ? `(${inboxCount}) Kainos Talk` : 'Kainos Talk';
    const title = await poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getTitle()), (value) => value === expectedTitle, 5000);
    check(title === expectedTitle, "window title carries the inbox's unread total, not the websites' again", title);
    await inService(app, 'whatsapp', `document.title = '(99+) WhatsApp'`);
    check((await poll(() => badge(2).textContent(), (text) => text === '99+', 5000)) === '99+', 'a capped "(99+)" title shows 99+');
    await inService(app, 'whatsapp', `document.title = 'WhatsApp'`);
    await screenshot(app, '05-unread-badges');

    // Proton's Inbox counter, read from the page. The real selector is unverified (it needs a
    // signed-in page), so this plants a stand-in element to prove the preload-to-badge path.
    await inService(app, 'proton-mail', `document.body.insertAdjacentHTML('beforeend', '<nav id="kainos-smoke-inbox" data-testid="navigation-link:inbox"><span data-testid="navigation-link:unread-count">12</span></nav>'); 1`);
    check((await poll(() => badge(0).textContent(), (text) => text === '12', 6000)) === '12', 'Proton badge follows the Inbox counter in the page over the title (stand-in element)');
    await inService(app, 'proton-mail', `document.querySelector('#kainos-smoke-inbox span').remove(); 1`);
    check((await poll(() => badge(0).textContent(), (text) => text === '', 6000)) === '', 'Proton badge clears when the Inbox counter disappears');
    await inService(app, 'proton-mail', `document.querySelector('#kainos-smoke-inbox').remove(); 1`);
    check((await poll(() => badge(0).textContent(), (text) => text === '4', 6000)) === '4', 'without the Inbox link, Proton falls back to the title');

    // While the phone is connected, the inbox notifies for the websites; their own would be doubles.
    const doubled = nextAppEvent<{ serviceId: string; muted: boolean; shown: boolean }>(app, 'kainos-notification');
    await inService(app, 'whatsapp', `new Notification('Double'); 1`);
    const twice = await doubled;
    check(twice.serviceId === 'whatsapp' && twice.muted && !twice.shown, "with the phone connected, a website's own notification is dropped", JSON.stringify(twice));
    smsPhone?.close();
    smsPhone = undefined;
    await poll(() => inService<string>(app, 'inbox', 'document.body.innerText'), (t) => /not connected/.test(t), 5000);

    // Notifications: forwarded when unmuted, clicking focuses the service; dropped when muted.
    await pressShortcut(app, page, 'sidebar', digit('proton-mail'));
    const shownPromise = nextAppEvent<{ serviceId: string; muted: boolean; shown: boolean }>(app, 'kainos-notification');
    await inService(app, 'whatsapp', `window.__clicked = false; new Notification('Smoke test', { body: 'hello' }).onclick = () => { window.__clicked = true; }; Notification.permission`);
    const shown = await shownPromise;
    check(shown.serviceId === 'whatsapp' && !shown.muted && shown.shown, 'WhatsApp notification becomes a native notification', JSON.stringify(shown));
    const delivered = await poll(async () => bus!.notifications.find((n) => n.summary === 'Smoke test'), Boolean, 5000);
    check(delivered?.body === 'hello', 'the notification reaches the (fake) desktop notification server over D-Bus', JSON.stringify(delivered));
    await app.evaluate(() => ((globalThis as Record<string, unknown>).__kainosLast as { notification: Electron.Notification }).notification.emit('click'));
    await poll(() => activeIndex(page), (index) => index === nth('whatsapp'), 5000);
    check((await activeIndex(page)) === nth('whatsapp'), 'clicking the notification switches to WhatsApp');
    check(await poll(() => inService<boolean>(app, 'whatsapp', 'window.__clicked'), Boolean, 5000), 'the page receives the notification click');
    const mutedPromise = nextAppEvent<{ serviceId: string; muted: boolean; shown: boolean }>(app, 'kainos-notification');
    await inService(app, 'discord', `new Notification('Muted test'); 1`);
    const muted = await mutedPromise;
    check(muted.serviceId === 'discord' && muted.muted && !muted.shown, 'muted Discord notification is not shown', JSON.stringify(muted));
    await sleep(1000);
    check(!bus!.notifications.some((n) => n.summary === 'Muted test'), 'the muted notification never reaches the notification server');
    // A tag replaces the earlier notification with the same tag.
    await inService(app, 'whatsapp', `new Notification('Tagged one', { tag: 'kainos-smoke' }); 1`);
    const first = await poll(async () => bus!.notifications.find((n) => n.summary === 'Tagged one'), Boolean, 5000);
    await inService(app, 'whatsapp', `new Notification('Tagged two', { tag: 'kainos-smoke' }); 1`);
    const second = await poll(async () => bus!.notifications.find((n) => n.summary === 'Tagged two'), Boolean, 5000);
    const replaced = await poll(async () => first !== undefined && bus!.closed.includes(first.id), Boolean, 5000);
    check(Boolean(second) && replaced, 'a second notification with the same tag closes the first', `first ${first?.id}, closed [${bus!.closed.join(', ')}]`);

    // A notification the server expired (NotificationClosed, reason 1) and that is then clicked from the
    // server's history (ActionInvoked "default"): measured on real Electron, the click does not arrive,
    // even with the main-process Notification object still referenced. So the page must not keep it.
    const raised = nextAppEvent<{ serviceId: string }>(app, 'kainos-notification');
    await inService(app, 'whatsapp', `window.__expired = { clicked: 0, closed: 0, before: Notification.live.size }; const n = new Notification('Expires', { body: 'x' }); n.onclick = () => window.__expired.clicked++; n.onclose = () => window.__expired.closed++; 1`);
    await raised;
    await app.evaluate(() => {
      const g = globalThis as unknown as { __kainosLast: { notification: Electron.Notification }; __mainClicks: number };
      g.__mainClicks = 0;
      g.__kainosLast.notification.on('click', () => g.__mainClicks++); // keeps the object alive, too
    });
    const expiring = await poll(async () => bus!.notifications.find((n) => n.summary === 'Expires'), Boolean, 5000);
    bus!.serverCommand(`closed ${expiring!.id} 1`);
    await sleep(500);
    bus!.serverCommand(`action ${expiring!.id} default`);
    await sleep(1500);
    const expired = await inService<{ clicked: number; closed: number; before: number; live: number }>(app, 'whatsapp', `({ ...window.__expired, live: Notification.live.size })`);
    const mainClicks = await app.evaluate(() => (globalThis as unknown as { __mainClicks: number }).__mainClicks);
    check(expired.closed === 1 && expired.clicked === 0 && mainClicks === 0, 'a click on a notification the server already expired does not reach Electron or the page', JSON.stringify({ ...expired, mainClicks }));
    check(expired.live === expired.before, 'and the page has let go of it', JSON.stringify(expired));

    // Links leave for the system browser (intercepted here) and the page stays put.
    const popupPromise = nextAppEvent<string>(app, 'kainos-external');
    await inService(app, 'whatsapp', `window.open('https://example.com/from-whatsapp', '_blank'); 1`);
    check((await popupPromise) === 'https://example.com/from-whatsapp', 'window.open to another site goes to the system browser');
    const before = await serviceUrl(app, 'discord');
    const navPromise = nextAppEvent<string>(app, 'kainos-external');
    await inService(app, 'discord', `location.href = 'https://example.com/from-discord'; 1`);
    check((await navPromise) === 'https://example.com/from-discord', 'a link that navigates away goes to the system browser');
    await sleep(1000);
    check((await serviceUrl(app, 'discord')) === before, 'Discord stays on its own page');
    const windowCount = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    check((await windowCount()) === 1, 'no popup window was opened for an outside link', `${await windowCount()} windows`);
    const sameSite = nextAppEvent<string>(app, 'kainos-external');
    await inService(app, 'discord', `window.open('https://discord.com/blog', '_blank'); 1`);
    check((await sameSite) === 'https://discord.com/blog', 'a same-site Discord link opens in the browser, not a bare popup');
    const blank = await inService<boolean>(app, 'discord', `window.open('about:blank', '_blank') === null`);
    await sleep(500);
    check(blank && (await windowCount()) === 1, 'a blank popup is refused');

    // A captcha host opens as a popup titled with its host; heading elsewhere closes it.
    await inService(app, 'discord', `window.open('https://hcaptcha.com/', '_blank'); 1`);
    check((await poll(windowCount, (count) => count === 2, 10_000)) === 2, 'an hCaptcha link opens as a popup');
    const popupTitle = await poll(
      () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length === 0)?.getTitle() ?? ''),
      (value) => /^(www\.)?hcaptcha\.com — /.test(value),
      20_000,
    );
    check(/^(www\.)?hcaptcha\.com — /.test(popupTitle), "the popup's title names its host", popupTitle);
    const leave = nextAppEvent<string>(app, 'kainos-external');
    await app.evaluate(({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length === 0);
      void popup?.webContents.executeJavaScript(`location.href = 'https://example.com/from-popup'; 1`);
    });
    check((await leave) === 'https://example.com/from-popup', 'a popup heading to another site sends it to the browser');
    check((await poll(windowCount, (count) => count === 1, 5000)) === 1, '... and the popup closes');

    // Permissions the services' own pages now get, and one they still do not.
    await pressShortcut(app, page, 'sidebar', digit('whatsapp'));
    // Copy is allowed and reading the clipboard stays denied. A site's own Permissions-Policy
    // (WhatsApp sometimes sends one) or a missing focus can refuse first, which proves nothing
    // about Kainos, so each service page is tried and only answers from Kainos count.
    const clipboard = async (call: string) => {
      const results: string[] = [];
      for (const [index, id] of SERVICE_IDS.entries()) {
        // The SMS view is Kainos' own page; it never copies to the clipboard.
        if (id === 'inbox') continue;
        await pressShortcut(app, page, 'sidebar', index + 1);
        await app.evaluate(({ BaseWindow }, i) => (BaseWindow.getAllWindows()[0]!.contentView.children[i] as Electron.WebContentsView).webContents.focus(), index);
        results.push(`${id}: ${await inService<string>(app, id, `${call}.then(() => 'ok', (e) => e.name + ': ' + e.message)`, true)}`);
      }
      return results;
    };
    const writes = await clipboard(`navigator.clipboard.writeText('kainos smoke')`);
    if (writes.some((w) => /permission denied/i.test(w))) check(false, 'a service page may copy to the clipboard', writes.join(' | '));
    else if (writes.some((w) => w.endsWith(': ok'))) check(true, 'a service page may copy to the clipboard (headless clipboard, not yours)', writes.find((w) => w.endsWith(': ok')));
    else skip('a service page may copy to the clipboard', `no page reached the app's handler: ${writes.join(' | ')}`);
    const reads = await clipboard(`navigator.clipboard.readText()`);
    const denied = reads.find((read) => /NotAllowedError: .*permission denied/i.test(read));
    if (reads.some((read) => read.endsWith(': ok'))) check(false, 'a service page may not read the clipboard', reads.join(' | '));
    else if (denied) check(true, 'a service page may not read the clipboard (denied by Kainos)', denied);
    else skip('a service page may not read the clipboard', `no page reached the app's handler: ${reads.join(' | ')}`);
    await pressShortcut(app, page, 'sidebar', digit('whatsapp'));
    const persisted = await inService<boolean>(app, 'whatsapp', `navigator.storage.persist()`);
    check(persisted, "a service page's storage is marked persistent");
    const [width] = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentSize());
    const entered = await inService<string>(app, 'whatsapp', `document.documentElement.requestFullscreen().then(() => 'ok', (e) => e.name)`, true);
    const full = await poll(() => viewBounds(app, 'whatsapp'), (b) => b.x === 0, 5000);
    check(entered === 'ok' && full.x === 0 && full.width === (await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentSize()[0])), 'a page in fullscreen covers the whole window, sidebar included', `${entered} ${JSON.stringify(full)}`);
    info('the window itself went fullscreen with the page', String(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isFullScreen())));
    await inService(app, 'whatsapp', `document.exitFullscreen().then(() => 1, () => 0)`, true);
    const back = await poll(() => viewBounds(app, 'whatsapp'), (b) => b.x === 68, 5000);
    check(back.x === 68, 'leaving fullscreen puts the page back beside the sidebar', JSON.stringify(back));
    await poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentSize()[0]), (w) => w === width, 5000);

    // Failed load, light and dark, then retry.
    await pressShortcut(app, page, 'sidebar', digit('discord'));
    await app.evaluate(({ BaseWindow }) => {
      const view = BaseWindow.getAllWindows()[0]!.contentView.children[2] as Electron.WebContentsView;
      view.webContents.loadURL('https://kainos-smoke.invalid/').catch(() => undefined);
    });
    check((await poll(() => status(page, 'discord'), (value) => value === 'failed', 20_000)) === 'failed', 'an unreachable page shows the failed state');
    await page.waitForSelector('.notice[data-state="failed"]');
    await screenshot(app, '06-failed-light');
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    const followsSystem = await poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), Boolean, 3000);
    const darkRail = () => page.evaluate(() => getComputedStyle(document.querySelector('.rail')!).backgroundColor);
    if (followsSystem) {
      check((await darkRail()) === 'rgb(22, 32, 36)', 'the sidebar follows the system dark theme');
    } else {
      skip('the sidebar follows the system dark theme', 'headless Ozone does not pass nativeTheme to the page');
      await page.emulateMedia({ colorScheme: 'dark' });
      const rail = await darkRail();
      check(rail === 'rgb(22, 32, 36)', 'the dark palette applies under an emulated prefers-color-scheme: dark', rail);
    }
      skip('service views paint the theme colour before their page', 'WebContentsView has no getter for its background colour; set in code only');
    await screenshot(app, '07-failed-dark');
    await page.locator('.retry').click();
    check((await poll(() => status(page, 'discord'), (value) => value === 'ready', 60_000)) === 'ready', 'Retry loads Discord again');
    const isWinFocused = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isFocused());
    if (isWinFocused) check(await poll(() => serviceFocused(app, 'discord'), Boolean, 3000), 'after Retry, keyboard focus is in Discord');
    else skip('after Retry, keyboard focus is in Discord', 'the off-screen window never reports focus, so the app waits for it');

    // Keyboard: F6 from inside the page to its rail button.
    await sendKey(app, 'discord', 'F6');
    check((await poll(() => railFocus(page), (index) => index === nth('discord'), 5000)) === nth('discord'), 'F6 inside Discord moves focus to its button in the sidebar');

    // The service menu: by mouse at the pointer, by keyboard beside the button.
    await page.locator('.socket').nth(nth('discord')).locator('.tile').click({ button: 'right' });
    const byMouse = (await poll(() => menus(app), (all) => all.length > 0, 5000)).at(-1);
    check(byMouse !== undefined && byMouse.x === undefined && byMouse.labels[0] === 'Reload Discord', 'a right-click opens the Discord menu at the pointer', JSON.stringify(byMouse));
    const box = await page.locator('.socket').nth(nth('discord')).locator('.tile').boundingBox();
    await page.locator('.socket').nth(nth('discord')).locator('.tile').focus();
    const count = (await menus(app)).length;
    await sendKey(app, 'sidebar', 'F10', ['shift']);
    let byKey = (await poll(() => menus(app), (all) => all.length > count, 3000)).at(-1);
    let how = 'Shift+F10';
    if ((await menus(app)).length === count) {
      // Chromium did not turn the synthetic Shift+F10 into a contextmenu event here; fire the
      // event the key would have produced, which still has no pointer press before it.
      how = 'a contextmenu event with no pointer press (Shift+F10 not delivered off screen)';
      await page.locator('.socket').nth(nth('discord')).locator('.tile').dispatchEvent('contextmenu');
      byKey = (await poll(() => menus(app), (all) => all.length > count, 3000)).at(-1);
    }
    const expected = box ? { x: Math.round(box.x + box.width), y: Math.round(box.y) } : undefined;
    check(byKey?.x === expected?.x && byKey?.y === expected?.y, 'a keyboard-opened menu appears beside the focused button', `${how}: ${JSON.stringify(byKey)} expected ${JSON.stringify(expected)}`);

    // Reload is not blocked by a page's "leave site?" prompt.
    await inService(app, 'discord', `window.__kainosMark = 1; addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }); 1`, true);
    check(await clickMenuItem(app, 'Reload'), 'the menu has Reload');
    const reloaded = await poll(() => inService<boolean>(app, 'discord', 'window.__kainosMark === undefined').catch(() => false), Boolean, 20_000);
    check(reloaded, 'Reload goes through despite a beforeunload prompt');

    // Sign out: a page that writes its login back while unloading, behind a "leave site?"
    // prompt, still ends up signed out.
    await pressShortcut(app, page, 'sidebar', digit('whatsapp'));
    await inService(
      app,
      'whatsapp',
      `localStorage.setItem('kainosSmoke', 'live');
       document.cookie = 'kainosSmoke=live; max-age=3600; secure';
       addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
       addEventListener('pagehide', () => { localStorage.setItem('kainosSmoke', 'written-back'); document.cookie = 'kainosSmoke=written-back; max-age=3600; secure'; });
       1`,
      true,
    );
    await page.locator('.socket').nth(nth('whatsapp')).locator('.tile').click({ button: 'right' });
    await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload WhatsApp', 5000);
    check(await clickMenuItem(app, 'Sign out'), 'the menu has Sign out');
    await poll(() => status(page, 'whatsapp'), (value) => value === 'loading', 10_000);
    check((await poll(() => status(page, 'whatsapp'), (value) => value === 'ready', 60_000)) === 'ready', 'WhatsApp loads again after Sign out');
    const stored = await inService<string | null>(app, 'whatsapp', `localStorage.getItem('kainosSmoke')`);
    const cookies = await app.evaluate(({ session }) => session.fromPartition('persist:service-whatsapp').cookies.get({ name: 'kainosSmoke' }));
    check(stored === null && cookies.length === 0, 'Sign out leaves no login behind, even one written back at unload', `localStorage ${stored}, cookies ${cookies.length}`);
    check((await boxes(app)).some((b) => b.message === 'Sign out of WhatsApp?'), 'Sign out asks first');

    // A failed sign-out is reported and the service comes back.
    await app.evaluate(({ session }) => {
      const ses = session.fromPartition('persist:service-proton-mail');
      ses.clearStorageData = () => Promise.reject(new Error('smoke: disk is read-only'));
    });
    await page.locator('.socket').nth(nth('proton-mail')).locator('.tile').click({ button: 'right' });
    await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Proton Mail', 5000);
    await clickMenuItem(app, 'Sign out');
    const report = await poll(() => boxes(app), (all) => all.some((b) => b.type === 'error'), 10_000);
    check(report.some((b) => b.type === 'error' && b.message === 'Could not sign out of Proton Mail'), 'a failed sign-out is reported to the user', JSON.stringify(report.at(-1)));
    check((await poll(() => status(page, 'proton-mail'), (value) => value === 'ready', 60_000)) === 'ready', 'Proton Mail loads again after the failed sign-out');
    await page.evaluate(() => undefined);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system';
    });
    await page.emulateMedia({ colorScheme: null });

    await pressShortcut(app, page, 'sidebar', digit('whatsapp'));
    await sleep(2500);
    await screenshot(app, '08-whatsapp');

    // The bar: hidden until the pointer reaches the page's edge or F6 asks for it, then docked
    // on the right.
    const sidebarBounds = () =>
      app.evaluate(({ BaseWindow }) => {
        const view = BaseWindow.getAllWindows()[0]!.contentView.children.at(-1) as Electron.WebContentsView;
        return view.getVisible() ? view.getBounds() : null;
      });
    const pointerAt = (x: number) =>
      app.evaluate(({ BaseWindow }, x) => {
        const contents = (BaseWindow.getAllWindows()[0]!.contentView.children[3] as Electron.WebContentsView).webContents;
        contents.sendInputEvent({ type: 'mouseMove', x, y: 300 });
      }, x);
    const contentWidth = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentSize()[0]!);
    const leaveRail = () => page.evaluate(() => document.querySelector('.rail')!.dispatchEvent(new PointerEvent('pointerleave')));
    await page.locator('#bar-options').click();
    const barMenu = (await poll(() => menus(app), (all) => all.at(-1)?.labels[0]?.startsWith('Hide the bar') === true, 5000)).at(-1);
    check(barMenu?.labels.includes('Bar always on the right') === true, 'the Kainos mark opens the bar options', JSON.stringify(barMenu?.labels));
    await clickMenuItem(app, 'Hide the bar');
    await leaveRail();
    check((await poll(sidebarBounds, (b) => b === null, 3000)) === null, 'with auto-hide on, the bar hides once the pointer leaves it');
    const whole = await viewBounds(app, 'whatsapp');
    check(whole.x === 0 && whole.width === contentWidth, 'the page takes the whole window while the bar is hidden', JSON.stringify(whole));
    await pointerAt(400);
    await pointerAt(0);
    const out = await poll(sidebarBounds, (b) => b !== null, 3000);
    check(out?.x === 0 && out.width === 68, 'the pointer at the left edge brings the bar out', JSON.stringify(out));
    check((await viewBounds(app, 'whatsapp')).width === contentWidth, '... over the page, without squeezing it');
    await sleep(300);
    await screenshot(app, '09-bar-revealed');
    await pointerAt(500);
    check((await poll(sidebarBounds, (b) => b === null, 3000)) === null, 'moving the pointer back into the page hides the bar');
    await pointerAt(contentWidth - 1);
    check((await poll(sidebarBounds, (b) => b !== null, 1500)) === null, 'the right edge does nothing while the bar is on the left');
    await pointerAt(500);
    // The SMS view is Kainos' own page, not a website: the bar must come out from it too.
    const smsPointerAt = (x: number) =>
      app.evaluate(({ BaseWindow }, x) => {
        const contents = (BaseWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).webContents;
        contents.sendInputEvent({ type: 'mouseMove', x, y: 300 });
      }, x);
    await pressShortcut(app, page, 'whatsapp', digit('inbox'));
    await smsPointerAt(400);
    await smsPointerAt(0);
    check((await poll(sidebarBounds, (b) => b !== null, 3000)) !== null, 'the pointer at the edge of the SMS view brings the bar out too');
    await smsPointerAt(500);
    check((await poll(sidebarBounds, (b) => b === null, 3000)) === null, '... and it hides again over the SMS view');
    // Discord's view was made new when it woke from sleep: the bar comes out from it too.
    const discordPointerAt = (x: number) =>
      app.evaluate(({ BaseWindow }, { x, index }) => {
        const contents = (BaseWindow.getAllWindows()[0]!.contentView.children[index] as Electron.WebContentsView).webContents;
        contents.sendInputEvent({ type: 'mouseMove', x, y: 300 });
      }, { x, index: nth('discord') });
    await pressShortcut(app, page, 'inbox', digit('discord'));
    await poll(() => status(page, 'discord'), (value) => value === 'ready', 30_000);
    await discordPointerAt(400);
    await discordPointerAt(0);
    check((await poll(sidebarBounds, (b) => b !== null, 3000)) !== null, 'the pointer at the edge of the woken Discord page brings the bar out');
    await discordPointerAt(500);
    check((await poll(sidebarBounds, (b) => b === null, 3000)) === null, '... and it hides again over Discord');
    await pressShortcut(app, page, 'inbox', digit('whatsapp'));
    await sendKey(app, 'whatsapp', 'F6');
    check((await poll(sidebarBounds, (b) => b !== null, 3000)) !== null, 'F6 brings the hidden bar out');
    check((await poll(() => railFocus(page), (index) => index === nth('whatsapp'), 3000)) === nth('whatsapp'), '... with focus on the active service');
    await page.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
    await clickMenuItem(app, 'Hide the bar');
    check((await poll(sidebarBounds, (b) => b?.x === 0, 3000))?.x === 0, 'turning auto-hide off docks the bar again');
    await page.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
    await clickMenuItem(app, 'Bar always on the right');
    const right = await poll(sidebarBounds, (b) => b?.x === contentWidth - 68, 3000);
    check(right?.x === contentWidth - 68, 'the bar can sit on the right', JSON.stringify(right));
    const left = await viewBounds(app, 'whatsapp');
    check(left.x === 0 && left.width === contentWidth - 68, '... with the page beside it on the left', JSON.stringify(left));
    check((await page.evaluate(() => document.body.dataset.side)) === 'right', '... and the bar drawn mirrored');
    await sleep(300);
    await screenshot(app, '10-bar-right');
    await page.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
    const outer = (await menus(app)).at(-1)?.labels.find((label) => label.startsWith("Bar on the screen's outer edge"));
    info('screen side the app sees off screen', outer ?? '');
    await clickMenuItem(app, "Bar on the screen's outer edge");
    check((await poll(sidebarBounds, (b) => b?.x === 0, 3000))?.x === 0, "the screen's outer edge on a single screen is the left");

    // With a tray host, closing the window hides it to the tray instead of quitting.
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close());
    const hidden = await poll(() => app.evaluate(({ BaseWindow }) => !BaseWindow.getAllWindows()[0]!.isVisible()), Boolean, 5000);
    check(hidden, 'with a tray host, closing the window hides it to the tray');
    check(bus!.trayItems.length > 0, 'the tray icon registers with the tray host', bus!.trayItems.join('; '));

    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0]!;
      win.show();
      win.setBounds({ x: 120, y: 90, width: 1100, height: 720 });
    });
    // Memory: every website was woken earlier; put them all to sleep.
    await pressShortcut(app, page, 'sidebar', digit('inbox'));
    const treeBefore = processTreePssMb(app.process().pid!);
    for (const id of ['proton-mail', 'discord', 'whatsapp', 'messenger'] as const) {
      if ((await status(page, id)) === 'asleep') continue;
      await page.locator('.socket').nth(nth(id)).locator('.tile').click({ button: 'right' });
      await poll(() => menus(app), (all) => all.at(-1)?.labels.includes('Sleep now') === true, 5000);
      await clickMenuItem(app, 'Sleep now');
      await poll(() => status(page, id), (value) => value === 'asleep', 5000);
    }
    await sleep(3000);
    const asleepStatuses = await Promise.all((['proton-mail', 'discord', 'whatsapp', 'messenger'] as const).map((id) => status(page, id)));
    info("PSS of the app's process tree, websites awake then all asleep (MB)", `${treeBefore} → ${processTreePssMb(app.process().pid!)} (${asleepStatuses.join(', ')})`);
    check((await pressShortcut(app, page, 'sidebar', digit('proton-mail'))) === nth('proton-mail'), `Ctrl+${digit('proton-mail')} switches back to Proton Mail before quitting`);
    await sleep(800);
    await sendKey(app, 'sidebar', 'Q', ['control']);
    quitByKey = await exits(app, 10_000);
    check(quitByKey, 'Ctrl+Q quits the app');
  } finally {
    smsPhone?.close();
    await shutdown(app);
  }

  const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  check(saved.activeServiceId === 'proton-mail', 'saves the last active service on quit', String(saved.activeServiceId));
  check(JSON.stringify(saved.bounds) === JSON.stringify({ x: 120, y: 90, width: 1100, height: 720 }), 'saves window size and position', JSON.stringify(saved.bounds));
  check(JSON.stringify(saved.mutedServiceIds) === '["discord"]', 'keeps the muted list', JSON.stringify(saved.mutedServiceIds));

  // Second launch, then the tray host goes away (a desktop with no tray): closing quits.
  // The host is only switched off after launch: without one at startup, Electron's tray falls
  // back to GTK, which crashes with no display. The app asks the session again at close time.
  app = await launch(profile);
  try {
    const page = await sidebar(app);
    bus!.setTrayHost(false);
    check((await activeIndex(page)) === nth('proton-mail'), 'second launch opens on Proton Mail');
    const bounds = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getBounds());
    check(bounds.width === 1100 && bounds.height === 720, 'second launch restores the window size', JSON.stringify(bounds));
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close()).catch(() => undefined);
    check(await exits(app, 10_000), 'with no tray host, closing the window quits');
  } finally {
    await shutdown(app);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  failures.push('smoke test crashed');
} finally {
  bus?.stop();
}
if (warnings.length) console.log(`\n${warnings.length} live-site warning(s):\n- ${warnings.join('\n- ')}`);
console.log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}` : '\nAll smoke checks passed.');
process.exit(failures.length ? 1 : 0);
