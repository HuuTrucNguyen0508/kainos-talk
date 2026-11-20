// Boots the built app off screen and checks it end to end against the live services.
// Nothing reaches the user's desktop: Electron runs with the headless Ozone platform and no
// DISPLAY or WAYLAND_DISPLAY, on a private D-Bus session that can activate nothing and whose
// only tray host and notification server is test/fake-desktop-host.py, and links never open a
// browser. Screenshots land in desktop/.verify/ (or KAINOS_VERIFY_DIR).
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPaired, conversation, startPairing, type FakePhoneLink } from './fake-phone.ts';
import { markPng } from '../src/main/app-icon.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
// KAINOS_VERIFY_DIR moves the screenshots elsewhere, for example to keep an earlier set.
const verify = process.env.KAINOS_VERIFY_DIR ?? join(desktop, '.verify');
const electronPath = createRequire(import.meta.url)('electron') as string;
const SERVICE_IDS = ['inbox', 'proton-mail', 'discord', 'whatsapp', 'messenger', 'streamroom'] as const;
/** The services that run from startup; Streamroom starts hibernated. */
const AWAKE_IDS = SERVICE_IDS.filter((id) => id !== 'streamroom');
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

/** KAINOS_SMOKE_APP runs a packaged build (release/linux-unpacked/kainos-talk) instead of this checkout. */
const packaged = process.env.KAINOS_SMOKE_APP;

function launch(profile: string): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: packaged ?? electronPath,
    args: ['--ozone-platform=headless', '--ozone-override-screen-size=1400,900', '--disable-gpu', '--mute-audio', ...(packaged ? [] : [desktop])],
    env: offDesktop({
      KAINOS_USER_DATA: profile,
      KAINOS_BLOCK_EXTERNAL: '1',
      KAINOS_SYNC_PORT: String(syncPort),
      KAINOS_SYNC_MDNS: '0',
      DBUS_SESSION_BUS_ADDRESS: bus!.address,
    }),
    timeout: 60_000,
  });
}

async function dockPage(app: ElectronApplication): Promise<Page> {
  const page = await poll(
    async () => app.windows().find((candidate) => candidate.url().endsWith('/renderer/index.html')),
    Boolean,
    20_000,
  );
  if (!page) throw new Error('dock page never opened');
  check(await app.evaluate(({ BaseWindow, BrowserWindow }) => !(BaseWindow.getAllWindows()[0] instanceof BrowserWindow)), 'the main window has no renderer of its own');
  page.setDefaultTimeout(20_000);
  await page.waitForSelector('#tabs li:nth-child(3) .tab');
  return page;
}

/**
 * The main window is the one with views in it (an incoming-call window has none). Its views are
 * found by place, leaving out the call strip, which is no service's page.
 */
/** Runs JavaScript in one service page from the main process; `gesture` counts it as a user action. */
function inService<T>(app: ElectronApplication, id: ServiceId, code: string, gesture = false): Promise<T> {
  return app.evaluate(
    ({ BaseWindow }, { index, code, gesture }) =>
      (BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html'))[index] as Electron.WebContentsView).webContents.executeJavaScript(code, gesture),
    { index: SERVICE_IDS.indexOf(id), code, gesture },
  ) as Promise<T>;
}

/** Sends a key through Electron's input pipeline (before-input-event sees it), to the dock or a service. */
function sendKey(app: ElectronApplication, target: 'dock' | ServiceId, keyCode: string, modifiers: string[] = []): Promise<void> {
  return app.evaluate(
    ({ BaseWindow }, { index, keyCode, modifiers }) => {
      const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!;
      const contents = (win.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')).at(index) as Electron.WebContentsView).webContents;
      const mods = modifiers as NonNullable<Electron.KeyboardInputEvent['modifiers']>;
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    },
    { index: target === 'dock' ? -1 : SERVICE_IDS.indexOf(target), keyCode, modifiers },
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
/** Clicks the item whose label starts with `label` in the last recorded menu; 'Theme > Carbon' goes through a submenu. */
function clickMenuItem(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate((_electron, path) => {
    const all = (globalThis as Record<string, unknown>).__menus as { menu: Electron.Menu }[];
    let item: Electron.MenuItem | undefined;
    let items = all.at(-1)?.menu.items ?? [];
    for (const step of path.split(' > ')) {
      item = items.find((candidate) => candidate.label.startsWith(step));
      items = item?.submenu?.items ?? [];
    }
    item?.click();
    return Boolean(item);
  }, label);
}
/** The last recorded menu's items, a disabled one in brackets. */
const menuItems = (app: ElectronApplication) =>
  app.evaluate(() => {
    const all = (globalThis as Record<string, unknown>).__menus as { menu: Electron.Menu }[];
    return (all.at(-1)?.menu.items ?? []).filter((item) => item.type !== 'separator').map((item) => (item.enabled ? item.label : `(${item.label})`));
  });
/** The items of a submenu of the last recorded menu, the checked one marked with a *. */
const submenuLabels = (app: ElectronApplication, label: string) =>
  app.evaluate((_electron, label) => {
    const all = (globalThis as Record<string, unknown>).__menus as { menu: Electron.Menu }[];
    const submenu = all.at(-1)?.menu.items.find((item) => item.label === label)?.submenu;
    return (submenu?.items ?? []).map((item) => `${item.checked ? '*' : ''}${item.label}`);
  }, label);

/** The theme names in the dock's Theme menu, in order (shared/theme.ts). */
const THEME_NAMES = ['Switchboard', 'Daylight', 'Bakelite', 'Carbon', 'Aubergine'] as const;
const themeId = (name: string) => name.toLowerCase();
/** Picks a theme the way a user does: the Kainos mark's menu, then Theme. */
async function pickTheme(app: ElectronApplication, page: Page, name: string): Promise<boolean> {
  const before = (await menus(app)).length;
  await page.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
  await poll(() => menus(app), (all) => all.length > before && all.at(-1)?.labels[0] === 'Always show the dock', 5000);
  return clickMenuItem(app, `Theme > ${name}`);
}
/** `data-theme` on the root of the dock page and of the Texts page; 'none' when unset. */
async function themeAttributes(app: ElectronApplication, page: Page): Promise<string> {
  const dock = await page.evaluate(() => document.documentElement.dataset.theme ?? 'none');
  const texts = await inService<string>(app, 'inbox', `document.documentElement.dataset.theme ?? 'none'`);
  return `dock ${dock}, texts ${texts}`;
}

interface Measured {
  readonly text: string;
  readonly kind: 'text' | 'large' | 'icon';
  readonly ratio: number;
  readonly fg: string;
  readonly bg: string;
  /** A disabled control: WCAG sets it no minimum. */
  readonly exempt: boolean;
}
/**
 * Runs in a page: every visible piece of text (and every line icon and brand glyph) with its
 * colour composited over the backgrounds of its ancestors, and the WCAG 2 ratio between them.
 * Under the last translucent layer lies the theme's --surface (what main paints behind pages).
 */
const CONTRAST_WALK = `(() => {
  const parse = (value) => {
    let m = value.match(/^rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = value.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = (c) => c.slice(0, 3).reduce((sum, v, i) => { const s = v / 255; return sum + [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4); }, 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const surface = parse(getComputedStyle(document.body).getPropertyValue('--surface').trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => 'rgb(' + [r, g, b].map((h) => parseInt(h, 16)).join(' ') + ')'));
  const backdrop = (el) => {
    const layers = [];
    let opacity = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      const bg = parse(style.backgroundColor);
      if (bg && bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break; }
    }
    let base = surface;
    for (const layer of layers.reverse()) base = over(layer, base);
    return { base, opacity };
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    return getComputedStyle(el).visibility === 'visible';
  };
  const out = [];
  const measure = (el, colour, text, kind) => {
    const fg = parse(colour);
    if (!fg) return;
    const { base, opacity } = backdrop(el);
    if (opacity <= 0) return;
    const ink = over([fg[0], fg[1], fg[2], fg[3] * opacity], base);
    out.push({ text: text.slice(0, 40), kind, ratio: Math.round(ratio(ink, base) * 100) / 100, fg: hex(ink), bg: hex(base), exempt: !!el.closest(':disabled') });
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!shown(el) || el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    if (el.tagName === 'svg') {
      if (el.matches('svg.ic, .tile > svg')) measure(el, style.stroke !== 'none' ? (style.stroke.startsWith('rgb') ? style.stroke : style.color) : style.fill.startsWith('rgb') ? style.fill : style.color, el.closest('[aria-label], [title]')?.getAttribute('aria-label') || el.closest('[class]')?.getAttribute('class') || 'icon', 'icon');
      continue;
    }
    if (el.matches('input, textarea')) {
      if (el.value) measure(el, style.color, el.value, large ? 'large' : 'text');
      else if (el.placeholder) measure(el, getComputedStyle(el, '::placeholder').color, el.placeholder, 'text');
      continue;
    }
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) measure(el, style.color, own, large ? 'large' : 'text');
  }
  return out;
})()`;
/** Measures one Kainos page in the current theme; checks each floor and returns the lowest text and icon. */
async function measureContrast(label: string, run: () => Promise<Measured[]>): Promise<string> {
  const all = await run();
  const floor = (m: Measured) => (m.kind === 'text' ? 4.5 : 3);
  const misses = all.filter((m) => !m.exempt && m.ratio < floor(m));
  const lowest = (kind: Measured['kind'][]) => {
    const found = all.filter((m) => !m.exempt && kind.includes(m.kind)).sort((a, b) => a.ratio - b.ratio)[0];
    return found ? `${found.ratio.toFixed(2)}:1 "${found.text}" ${found.fg} on ${found.bg}` : 'none';
  };
  const exempt = all.filter((m) => m.exempt).map((m) => `${m.text} ${m.ratio.toFixed(2)}:1`);
  const summary = `${all.length} measured; text ${lowest(['text', 'large'])}; icons ${lowest(['icon'])}${exempt.length ? `; disabled (exempt) ${exempt.join(', ')}` : ''}`;
  check(all.length > 0 && misses.length === 0, `${label}: every text reaches 4.5:1 (large text and icons 3:1)`, misses.length ? misses.map((m) => `${m.ratio}:1 "${m.text}" ${m.fg} on ${m.bg}`).join('; ') : summary);
  contrastLog.push({ label, summary, all });
  return summary;
}
const contrastLog: { label: string; summary: string; all: Measured[] }[] = [];

/** The active service's bounds inside the window. */
const viewBounds = (app: ElectronApplication, id: ServiceId) =>
  app.evaluate(({ BaseWindow }, index) => (BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html'))[index] as Electron.WebContentsView).getBounds(), SERVICE_IDS.indexOf(id));
const serviceFocused = (app: ElectronApplication, id: ServiceId) =>
  app.evaluate(({ BaseWindow }, index) => (BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html'))[index] as Electron.WebContentsView).webContents.isFocused(), SERVICE_IDS.indexOf(id));
/** Index of the dock tab that has keyboard focus, or -1. */
const dockFocus = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.tab')].indexOf(document.activeElement as Element));
/** The dock page's bounds in the window, or null while it is hidden. */
const dockBounds = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => {
    const view = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')).at(-1) as Electron.WebContentsView;
    return view.getVisible() ? view.getBounds() : null;
  });
const contentSize = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.getContentSize() as [number, number]);
/** The always-shown dock's strip, in pixels (shared/ipc.ts DOCK_HEIGHT). */
const DOCK = 64;
/** The floating dock's view: the group, 16px each side and above, 8px below (shared/ipc.ts DOCK_FLOAT). */
const FLOAT = { margin: 16, bottom: 8 };

/** Sends a pointer event through Electron's input pipeline to the dock page or a service page. */
function pointer(app: ElectronApplication, target: 'dock' | ServiceId, type: 'mouseMove' | 'mouseLeave', x: number, y: number): Promise<void> {
  return app.evaluate(
    ({ BaseWindow }, { index, type, x, y }) => {
      const view = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')).at(index) as Electron.WebContentsView;
      view.webContents.sendInputEvent({ type: type as 'mouseMove', x: Math.round(x), y: Math.round(y) });
    },
    { index: target === 'dock' ? -1 : SERVICE_IDS.indexOf(target), type, x, y },
  );
}
const raisedDock = (page: Page) => page.evaluate(() => document.body.dataset.frame === 'float' && document.body.hasAttribute('data-raised'));
/** Brings the auto-hiding dock up the way a user does, with the pointer against the active page's bottom edge. */
async function revealDock(app: ElectronApplication, page: Page, id: ServiceId): Promise<Electron.Rectangle | null> {
  const [w, h] = await contentSize(app);
  await pointer(app, id, 'mouseMove', w / 3, h - 1);
  const shown = await poll(async () => ((await raisedDock(page)) ? dockBounds(app) : null), (b) => b !== null, 3000);
  await sleep(300); // the slide up
  return shown;
}
/** Sends the pointer up into the middle of the page, off the dock, and waits for the dock to go. */
async function lowerDock(app: ElectronApplication, id: ServiceId): Promise<boolean> {
  const [w, h] = await contentSize(app);
  await pointer(app, 'dock', 'mouseLeave', 0, 0);
  await pointer(app, id, 'mouseMove', w / 2, h / 2);
  return (await poll(() => dockBounds(app), (b) => b === null, 3000)) === null;
}
/** The centre of the dock's group of islands, in window coordinates. */
async function groupCentre(app: ElectronApplication, page: Page): Promise<number> {
  const at = await dockBounds(app);
  const box = await page.evaluate(() => document.querySelector('#group')!.getBoundingClientRect().toJSON() as DOMRect);
  return (at?.x ?? 0) + box.left + box.width / 2;
}

function serviceUrl(app: ElectronApplication, id: ServiceId): Promise<string> {
  return app.evaluate(
    ({ BaseWindow }, index) => (BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html'))[index] as Electron.WebContentsView).webContents.getURL(),
    SERVICE_IDS.indexOf(id),
  );
}

/**
 * Presses Ctrl+<digit> through Electron's own input pipeline. Playwright's keyboard goes
 * through DevTools, which skips the before-input-event hook the shortcut listens on.
 * `target` is the dock or a service page, to prove the shortcut works with focus in either.
 */
async function pressShortcut(app: ElectronApplication, page: Page, target: 'dock' | ServiceId, digit: number): Promise<number> {
  await app.evaluate(
    ({ BaseWindow }, { index, key }) => {
      const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!;
      const contents = (win.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')).at(index) as Electron.WebContentsView).webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] });
    },
    { index: target === 'dock' ? -1 : SERVICE_IDS.indexOf(target), key: String(digit) },
  );
  return poll(() => activeIndex(page), (index) => index === digit - 1, 5000);
}

const tab = (page: Page, id: ServiceId) => page.locator(`.tab[data-id="${id}"]`);
/** The dock's tabs, left to right, by service id. */
const tabOrder = (page: Page) => page.locator('.tab').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.id).join(' '));
const activeTab = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>('.tab[aria-current="page"]')?.dataset.id ?? 'none');
/** What the dock last said to screen readers. */
const announced = (page: Page) => page.evaluate(() => document.getElementById('announce')!.textContent ?? '');
const status = (page: Page, id: ServiceId) => tab(page, id).getAttribute('data-status');
const activeIndex = (page: Page) => page.locator('.tab').evaluateAll((items) => items.findIndex((item) => item.getAttribute('aria-current') === 'page'));
/** What a dock tab shows after its name: "count:4", "dot:", "muted:", "failed:", "offline:" or ":" for nothing. */
const tabState = (page: Page, id: ServiceId) => tab(page, id).locator('.state').evaluate((node) => `${(node as HTMLElement).dataset.kind ?? ''}:${node.querySelector('.count')?.textContent ?? ''}`);

/** Screenshot of the whole window: every visible view (service, then the dock page) in order, each at its place. */
async function screenshot(app: ElectronApplication, name: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BaseWindow, BrowserWindow }) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!;
    const [width, height] = win.getContentSize();
    const background = win.getBackgroundColor();
    const layers: { url: string; x: number; y: number }[] = [];
    for (const view of win.contentView.children as Electron.WebContentsView[]) {
      const { x, y } = view.getBounds();
      if (view.getVisible()) layers.push({ url: (await view.webContents.capturePage()).toDataURL(), x, y });
    }
    const canvas = new BrowserWindow({ show: false, width: 200, height: 200 });
    await canvas.loadURL('about:blank');
    const result: string = await canvas.webContents.executeJavaScript(`(async () => {
      const load = (src) => { const img = new Image(); img.src = src; return img.decode().then(() => img); };
      const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height};
      const g = c.getContext('2d'); g.fillStyle = ${JSON.stringify(background)}; g.fillRect(0, 0, c.width, c.height);
      for (const layer of ${JSON.stringify(layers)}) g.drawImage(await load(layer.url), layer.x, layer.y);
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

/**
 * A stand-in Streamroom server on this computer, so the run never depends on anyone's real
 * deployment: every path answers a page titled `title`. Resolves to its origin.
 */
async function standInRoom(title: string, servers: Server[]): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}
/** The stand-in Streamroom the run starts on, a second added from its Server menu, and a third that This PC's port is moved to. */
let room = '';
let otherRoom = '';
let pcRoom = '';

async function main(): Promise<void> {
  mkdirSync(verify, { recursive: true });
  bus = await privateBus();
  const servers: Server[] = [];
  const profile = mkdtempSync(join(tmpdir(), 'kainos-smoke-'));
  try {
    room = await standInRoom('Streamroom stand-in', servers);
    otherRoom = await standInRoom('Second Streamroom', servers);
    pcRoom = await standInRoom('Streamroom on this PC', servers);
    await run(profile);
  } finally {
    for (const server of servers) server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  const fresh = mkdtempSync(join(tmpdir(), 'kainos-smoke-welcome-'));
  try {
    await welcome(fresh);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

/** Whether something accepts TCP connections on this PC's `port` (the phone sync, while Texts is on). */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * First launch on a new profile: Kainos opens on Choose your apps with nothing on and nothing
 * loaded; the choice makes the dock, survives a restart, and can be changed from the dock's menu.
 */
async function welcome(profile: string): Promise<void> {
  const stateFile = join(profile, 'kainos-state.json');
  const saved = () => JSON.parse(readFileSync(stateFile, 'utf8')) as { enabledServiceIds?: string[]; welcomed?: boolean };
  const findPage = (app: ElectronApplication, part: string) => poll(async () => app.windows().find((w) => w.url().includes(part)), Boolean, 20_000);
  const views = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')).length);
  // The main run ends with no tray host; with none at startup Electron's tray falls back to GTK and crashes off screen.
  bus!.setTrayHost(true);
  let app = await launch(profile);
  try {
    await stubMenusAndDialogs(app);
    const choose = await findPage(app, '/renderer/apps.html');
    check(choose !== undefined, 'first launch opens on Choose your apps');
    if (!choose) return;
    await choose.waitForSelector('.app');
    const first = {
      title: await choose.locator('h1').innerText(),
      cancel: await choose.locator('#cancel').isVisible(),
      start: await choose.locator('#save').isDisabled(),
      status: await choose.locator('#status').innerText(),
      on: await choose.locator('.switch:checked').count(),
    };
    check(JSON.stringify(first) === JSON.stringify({ title: 'Choose your apps', cancel: false, start: true, status: 'Pick at least one app.', on: 0 }), '... with nothing on, no Cancel, and Start waiting for a choice', JSON.stringify(first));
    const names = await choose.locator('.name').allInnerTexts();
    check(JSON.stringify(names) === JSON.stringify(['Texts', 'Proton Mail', 'Discord', 'WhatsApp', 'Messenger', 'Streamroom', 'Gmail']), '... listing every app, Gmail included', JSON.stringify(names));
    check((await views(app)) === 2, '... while no service page loads behind it (only the dock and this page)', String(await views(app)));
    check(!(await listening(syncPort)), '... and nothing listens for the phone yet');
    await choose.locator('.app', { hasText: 'Texts' }).click();
    await choose.locator('.app', { hasText: 'Proton Mail' }).click();
    const ready = { button: await choose.locator('#save').innerText(), dock: await choose.locator('#dock .tile').count() };
    check(JSON.stringify(ready) === JSON.stringify({ button: 'Start with 2 apps', dock: 2 }), 'switching apps on fills the dock preview and names the count on Start', JSON.stringify(ready));
    await choose.screenshot({ path: join(verify, '09-choose-your-apps.png') });
    await choose.locator('#save').click();
    const gone = await poll(async () => choose.isClosed() || !(await choose.locator('#save').isVisible().catch(() => false)), Boolean, 5000);
    check(gone, 'Start closes Choose your apps');
    const dock = await findPage(app, '/renderer/index.html');
    const order = dock ? await poll(() => tabOrder(dock), (o) => o === 'inbox proton-mail', 10_000) : '';
    check(order === 'inbox proton-mail', '... and the dock has exactly the apps chosen', order);
    check(JSON.stringify(saved().enabledServiceIds) === '["inbox","proton-mail"]' && saved().welcomed === true, '... saved as chosen', JSON.stringify(saved()));
    check(await poll(() => listening(syncPort), Boolean, 10_000), 'Texts on starts listening for the phone');

    // Later: Choose apps… in the dock options menu, with Cancel, switching Texts off and Messenger on.
    if (dock) {
      await dock.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
      await poll(() => menus(app), (all) => all.length > 0, 5000);
      check(await clickMenuItem(app, 'Choose apps…'), 'the dock options menu has Choose apps…');
      const again = await findPage(app, '/renderer/apps.html');
      if (again) {
        await again.waitForSelector('.app');
        const later = { title: await again.locator('h1').innerText(), cancel: await again.locator('#cancel').isVisible(), on: await again.locator('.switch:checked').count() };
        check(JSON.stringify(later) === JSON.stringify({ title: 'Your apps', cancel: true, on: 2 }), '... which opens Your apps, with the current choice and a Cancel', JSON.stringify(later));
        await again.locator('.app', { hasText: 'Texts' }).click();
        await again.locator('.app', { hasText: 'Messenger' }).click();
        await again.locator('#save').click();
        const changed = await poll(() => tabOrder(dock), (o) => o === 'proton-mail messenger', 10_000);
        check(changed === 'proton-mail messenger', 'saving switches Texts off and Messenger on in the dock', changed);
        check(await dock.locator('#phone').isHidden(), '... with no phone island once Texts is off');
        check(!(await poll(() => listening(syncPort), (on) => !on, 10_000)), '... and nothing listening for the phone any more');
      }
    }
  } finally {
    await shutdown(app);
  }

  app = await launch(profile);
  try {
    const dock = await findPage(app, '/renderer/index.html');
    const order = dock ? await poll(() => tabOrder(dock), (o) => o === 'proton-mail messenger', 20_000) : '';
    check(order === 'proton-mail messenger', 'the next launch keeps the chosen apps and skips the welcome', order);
    check(app.windows().every((w) => !w.url().includes('/renderer/apps.html')), '... with no Choose your apps page');
  } finally {
    await shutdown(app);
  }
}

async function run(profile: string): Promise<void> {
  const stateFile = join(profile, 'kainos-state.json');
  if (process.env.KAINOS_PSS_ONLY === '1') {
    writeFileSync(stateFile, JSON.stringify({ activeServiceId: 'inbox' }));
    const app = await launch(profile);
    try {
      await dockPage(app);
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
  // Saved state from a "previous session" of older versions: WhatsApp was open, Discord was
  // muted, the side bar sat on the right, auto-hidden, and the dock's services on the right.
  // Streamroom points at the stand-in server, as if the user had added it from its menu.
  writeFileSync(stateFile, JSON.stringify({ activeServiceId: 'whatsapp', mutedServiceIds: ['discord'], barSide: 'right', barAutoHide: true, dockAlign: 'end', streamroom: { current: room } }));

  let app = await launch(profile);
  let quitByKey = false;
  try {
    const page = await dockPage(app);
    await stubMenusAndDialogs(app);
    check((await activeIndex(page)) === nth('whatsapp'), 'restores the last active service (WhatsApp)');
    check((await tab(page, 'discord').getAttribute('data-muted')) !== null, 'restores muted state (Discord)');
    if ((await status(page, 'whatsapp')) === 'loading') {
      const [w, h] = await contentSize(app);
      const cover = await dockBounds(app);
      check(cover?.y === 0 && cover.height === h && cover.width === w, 'while the active service loads, the dock page covers the whole window to say so', JSON.stringify(cover));
      await screenshot(app, '01-loading-light');
    }

    // Every service loads at startup, the ones not on screen too, except Streamroom, which
    // starts hibernated (checked with its own section below).
    for (const id of AWAKE_IDS) {
      const final = await poll(() => status(page, id), (value) => value !== 'loading', 90_000);
      check(final === 'ready', `${id} loads at startup`, `status ${final}`);
    }
    const startupFocus = await poll(() => serviceFocused(app, 'whatsapp'), Boolean, 3000);
    if (startupFocus) check(true, 'the active service (WhatsApp) has keyboard focus once it is ready');
    else skip('the active service has keyboard focus once it is ready', 'the off-screen window never reports focus, so the app waits for it');

    for (const id of AWAKE_IDS) {
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

    check((await pressShortcut(app, page, 'dock', digit('discord'))) === nth('discord'), `Ctrl+${digit('discord')} in the dock switches to Discord`);
    const discord = await poll(
      () => inService<boolean>(app, 'discord', `location.pathname.startsWith('/login') && !!document.querySelector('input[name="email"]')`),
      Boolean,
      45_000,
    );
    live(discord, 'Discord reaches its login page (live site)', await serviceUrl(app, 'discord'));
    await sleep(2000);
    await screenshot(app, '03-discord-login');

    // The dock hides until the pointer reaches the bottom edge, then slides up over the page.
    check(await lowerDock(app, 'discord'), 'the dock hides once the pointer is up in the page');
    {
      const [w, h] = await contentSize(app);
      const view = await viewBounds(app, 'discord');
      check(JSON.stringify(view) === JSON.stringify({ x: 0, y: 0, width: w, height: h }), 'with the dock hidden, the page fills the whole window', JSON.stringify(view));
      for (const type of ['mousemove', 'mouseout']) {
        await inService(app, 'discord', `document.dispatchEvent(new MouseEvent('${type}', { bubbles: true, clientX: innerWidth / 3, clientY: innerHeight - 1, relatedTarget: null }))`);
        await sleep(350);
        check((await dockBounds(app)) === null, `a synthetic ${type} cannot reveal the dock`);
      }
      await pointer(app, 'discord', 'mouseMove', w / 2, h - 1);
      await sleep(60);
      check((await dockBounds(app)) === null, 'the dock waits a moment at the edge, so passing by does not flash it');
      await pointer(app, 'discord', 'mouseMove', w / 2, h - 30);
      await sleep(400);
      check((await dockBounds(app)) === null, 'overshooting the edge on the way to a message box does not bring the dock up');
      const shown = await revealDock(app, page, 'discord');
      const group = await page.evaluate(() => document.querySelector('#group')!.getBoundingClientRect().toJSON() as DOMRect);
      check(
        shown !== null && shown.y + shown.height === h && shown.height === Math.ceil(group.height) + FLOAT.margin + FLOAT.bottom && shown.width === Math.ceil(group.width) + 2 * FLOAT.margin && shown.width < w,
        'the pointer at the bottom edge brings the dock up: a view no bigger than the islands and their shadow, at the bottom',
        `${JSON.stringify(shown)} for a ${group.width}×${group.height} group in ${w}x${h}`,
      );
      check(Math.abs((await groupCentre(app, page)) - w / 2) <= 1, 'the services and the phone sit together in the middle of the window', `${await groupCentre(app, page)} of ${w}`);
      check(JSON.stringify(await viewBounds(app, 'discord')) === JSON.stringify({ x: 0, y: 0, width: w, height: h }), '... over the page, which keeps the whole window');
      await pointer(app, 'discord', 'mouseMove', w / 3, h - 20);
      await sleep(700);
      check((await dockBounds(app)) !== null, 'it stays while the pointer is beside it near the bottom');
      check(await lowerDock(app, 'discord'), 'it slides away once the pointer goes up into the page');
      await revealDock(app, page, 'discord');
      await pointer(app, 'discord', 'mouseMove', w / 2, h / 2);
      await inService(app, 'discord', `
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: innerWidth / 3, clientY: innerHeight - 1 }));
        document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: innerWidth / 3, clientY: innerHeight - 1, relatedTarget: null }));
      `);
      check((await poll(() => dockBounds(app), (b) => b === null, 3000)) === null, 'synthetic edge events cannot hold the dock shown');
      // A tiled window with gaps (Hyprland): the pointer slammed down ends outside the window.
      await pointer(app, 'discord', 'mouseMove', w / 2, h - 12);
      await pointer(app, 'discord', 'mouseLeave', w / 2, h - 12);
      check((await poll(() => dockBounds(app), (b) => b !== null, 3000)) !== null, 'leaving the window through its bottom edge brings the dock up too');
      check(await lowerDock(app, 'discord'), '... and coming back up into the page sends it away');
    }
    // B already reported away. A reports edge, then switching back to B must drop A's hold.
    await pressShortcut(app, page, 'discord', digit('inbox'));
    check(await lowerDock(app, 'inbox'), 'Texts reports away before the service-switch regression');
    await pressShortcut(app, page, 'inbox', digit('discord'));
    await revealDock(app, page, 'discord');
    await pressShortcut(app, page, 'discord', digit('inbox'));
    check((await poll(() => dockBounds(app), (b) => b === null, 3000)) === null, 'switching from Discord at the edge to Texts last away hides the dock after the delay');
    check((await revealDock(app, page, 'inbox')) !== null, 'the newly active Texts preload reports trusted edge movement again');
    await pressShortcut(app, page, 'inbox', digit('discord'));
    check(await lowerDock(app, 'discord'), 'switching back clears Texts pointer state too');
    await revealDock(app, page, 'discord');
    await tab(page, 'whatsapp').click();
    check((await activeIndex(page)) === nth('whatsapp'), 'clicking the WhatsApp tab switches to it');
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

    check((await pressShortcut(app, page, 'dock', digit('inbox'))) === nth('inbox'), `Ctrl+${digit('inbox')} switches to the Inbox`);
    // SMS: the phone's texts arrive from the Kainos phone app (a fake one here) over TLS.
    const smsText = () => inService<string>(app, 'inbox', 'document.body.innerText');
    check(/Connect your phone/.test(await poll(smsText, (t) => /Connect your phone/.test(t), 10_000)), 'with no phone paired, SMS explains how to connect one');
    await screenshot(app, '04c-sms-setup');
    for (const name of THEME_NAMES) {
      await pickTheme(app, page, name);
      await poll(() => themeAttributes(app, page), (t) => t === `dock ${themeId(name)}, texts ${themeId(name)}`, 3000);
      await measureContrast(`${name}: the Texts setup screen`, () => inService<Measured[]>(app, 'inbox', CONTRAST_WALK));
    }
    await pickTheme(app, page, 'Match system');
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
    check((await poll(() => tabState(page, 'inbox'), (t) => t === 'count:2', 5000)) === 'count:2', 'the Texts tab counts unread texts');
    const phoneIsland = await poll(() => page.locator('#phone').innerText(), (t) => /Pixel 9/.test(t) && /\bconnected/.test(t), 5000);
    check(/Pixel 9\s*connected/.test(phoneIsland), "the dock's phone island names the phone and says it is connected", phoneIsland.replace(/\s+/g, ' '));
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
    check((await poll(() => tabState(page, 'inbox'), (t) => t === ':', 5000)) === ':', 'reading every text clears the Texts count');
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
      (BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')) as Electron.WebContentsView[]).slice(0, 5).map((view) => view.webContents.session.protocol.isProtocolHandled('kainos-image')),
    );
    check(websiteTries === 'refused refused' && JSON.stringify(handledIn) === JSON.stringify([true, false, false, false, false]), 'a website cannot read the inbox pictures (only the inbox session serves kainos-image:)', `${websiteTries}; handled ${JSON.stringify(handledIn)}`);
    await inService(app, 'inbox', `(() => { const f = document.querySelector('.search input'); f.value = 'tyres'; f.dispatchEvent(new Event('input')); return 1; })()`, true);
    const found = await poll(() => inService<string[]>(app, 'inbox', `[...document.querySelectorAll('.row .row-title')].map((t) => t.textContent)`), (t) => t.length === 1, 3000);
    check(found.length === 1 && found[0] === 'Garage Delaunay', 'search finds a conversation by its text', JSON.stringify(found));

    // Leave the Texts page: a text arriving in its open conversation stays unread until it is seen again.
    await pressShortcut(app, page, 'dock', digit('discord'));
    
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
    check((await pressShortcut(app, page, 'discord', digit('inbox'))) === nth('inbox'), `Ctrl+${digit('inbox')} from the Discord page switches to the Texts page`);
    if (readWhileHidden < 0) check((await smsPhone.next('read')).key === 'sms|0|s:garage', 'showing the Inbox again marks the open conversation read');
    await inService(app, 'inbox', `(() => { const f = document.querySelector('.search input'); f.value = ''; f.dispatchEvent(new Event('input')); return 1; })()`, true);
    await inService(app, 'inbox', `document.querySelector('.bubbles').dataset.kept = ''; 1`);
    smsPhone.send({ t: 'conversation', conversation: conversation('sms|0|s:pavlo', 'Pavlo', [{ id: 'd2', text: 'merged it', timeMs: Date.now() }], 1) });
    await poll(smsText, (t) => t.includes('merged it'), 5000);
    check(await inService<boolean>(app, 'inbox', `document.querySelector('.bubbles').dataset.kept === ''`), 'news in another conversation leaves the open thread as it is');

    // Notices: texts from services (the phone marks short codes and sender IDs) get their own feed.
    const [narrowWidth, narrowHeight] = await contentSize(app);
    const layoutOf = () =>
      inService<{ aside: string; seg: string; tab: string; inAside: boolean }>(
        app,
        'inbox',
        `({ aside: getComputedStyle(document.querySelector('.notices')).display, seg: getComputedStyle(document.querySelector('.seg [data-tab="notices"]')).display, tab: document.querySelector('.texts').dataset.tab, inAside: !!document.querySelector('.notices .notice-item') })`,
      );
    const noticeRaised = nextAppEvent<{ serviceId: string; shown: boolean }>(app, 'kainos-notification');
    const stripe = { ...conversation('sms|0|s:stripe', 'StripeLink', [{ id: 's1', text: '248677 is your Link verification code.', timeMs: Date.now() }], 1), sender: 'service' as const };
    smsPhone.send({ t: 'conversation', conversation: stripe });
    check((await noticeRaised).shown, 'a new notice raises a desktop notification like any text');
    const placed = await poll(
      () => inService<{ people: boolean; notice: boolean }>(app, 'inbox', `({ people: !!document.querySelector('.people-rows [data-key="sms|0|s:stripe"]'), notice: !!document.querySelector('.notice-item[data-key="sms|0|s:stripe"]') })`),
      (where) => where.notice,
      5000,
    );
    check(placed.notice && !placed.people, 'a text from a service is listed under Notices, not People', JSON.stringify(placed));
    const narrowLayout = await layoutOf();
    check(narrowWidth < 1500 && narrowLayout.aside === 'none' && narrowLayout.seg === 'flex', 'under 1500px the notices are a second tab beside People', `${narrowWidth}px ${JSON.stringify(narrowLayout)}`);
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(1600, 820));
    const wideLayout = await poll(layoutOf, (l) => l.aside !== 'none' && l.inAside, 3000);
    check(wideLayout.aside === 'flex' && wideLayout.seg === 'none' && wideLayout.inAside, 'from 1500px the notices have their own column on the right', JSON.stringify(wideLayout));
    await sleep(500);
    await screenshot(app, '04h-texts-wide');
    // Real ultrawide and portrait tiles: the page fills the window, and the dock comes up centred.
    for (const [width, height] of [[3440, 1440], [1720, 1440], [1418, 2488], [1418, 1244], [709, 2488]] as const) {
      await app.evaluate(({ BaseWindow }, { width, height }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(width, height), { width, height });
      await lowerDock(app, 'inbox');
      const service = await poll(() => viewBounds(app, 'inbox'), (b) => b.height === height && b.width === width, 3000);
      const shown = await revealDock(app, page, 'inbox');
      const centre = await groupCentre(app, page);
      check(service.height === height && service.width === width && shown !== null && shown.y + shown.height === height && Math.abs(centre - width / 2) <= 1,
        `${width}×${height}: the page fills the window and the dock comes up centred at its bottom`, `${JSON.stringify(shown)} centre ${centre}`);
      await lowerDock(app, 'inbox');
      const fits = await inService<boolean>(app, 'inbox', `(() => {
        const composer = document.querySelector('.composer');
        const header = document.querySelector('.thread-head');
        const people = document.querySelector('.people');
        return !!composer && !!header && !!people && document.body.scrollWidth === innerWidth && document.body.scrollHeight === innerHeight
          && composer.getBoundingClientRect().bottom === innerHeight
          && people.getBoundingClientRect().height === innerHeight
          && getComputedStyle(header).paddingLeft === getComputedStyle(composer).paddingLeft;
      })()`);
      check(fits, `${width}×${height}: the full-height panes fit and the header follows the composer column`);
    }
    await app.evaluate(({ BaseWindow }, [w, h]) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(w!, h!), [narrowWidth, narrowHeight]);
    await poll(layoutOf, (l) => l.aside === 'none', 3000);
    // Clicking the notification opens the notice in the middle and its tab in the narrow layout.
    await pressShortcut(app, page, 'dock', digit('discord'));
    await app.evaluate(() => ((globalThis as Record<string, unknown>).__kainosLast as { notification: Electron.Notification }).notification.emit('click'));
    await poll(() => activeIndex(page), (index) => index === nth('inbox'), 5000);
    const routed = await poll(
      () => inService<{ open: boolean; tab: string }>(app, 'inbox', `({ open: document.querySelector('.notice-item[data-key="sms|0|s:stripe"]')?.getAttribute('aria-current') === 'true' && document.querySelector('.thread-head h1')?.textContent === 'StripeLink', tab: document.querySelector('.texts').dataset.tab })`),
      (r) => r.open,
      5000,
    );
    check(routed.open && routed.tab === 'notices', "clicking a notice's notification opens it in the middle, with the Notices tab selected", JSON.stringify(routed));
    check((await smsPhone.next('read')).key === 'sms|0|s:stripe', '... and marks it read on the phone');
    const inlineCode = await inService<string | null>(app, 'inbox', `document.querySelector('.bubble .code-inline')?.textContent ?? null`);
    check(inlineCode === '248 677', "the code inside the notice's bubble is a Copy button", String(inlineCode));
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
    await inService(app, 'inbox', `document.querySelector('.notice-item[data-key="sms|0|s:stripe"] .chip').click(); 1`, true);
    const copied = await poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), (text) => text === '248677', 3000);
    check(copied === '248677', "Copy on a notice's code puts the code on the clipboard (the headless app's, not yours)", copied);
    const parcel = { ...conversation('sms|0|s:36679', '36679', [{ id: 'p1', text: 'Livraison terminée. Votre colis a été déposé dans votre boîte aux lettres.', timeMs: Date.now() - 60_000 }], 2), sender: 'service' as const };
    smsPhone.send({ t: 'conversation', conversation: parcel });
    await poll(() => inService<boolean>(app, 'inbox', `!!document.querySelector('.notice-item[data-unread][data-key="sms|0|s:36679"]')`), Boolean, 5000);
    await inService(app, 'inbox', `document.querySelector('.notices-body .quiet').click(); 1`, true);
    check((await smsPhone.next('read')).key === 'sms|0|s:36679', 'Mark all read marks each unread notice read on the phone');
    await inService(app, 'inbox', `document.querySelector('.seg [data-tab="people"]').click(); 1`, true);

    // Calls: what rings on the phone rings here; Answer, End and Call reach the phone.
    const callNow = Date.now();
    smsPhone.send({ t: 'callLog', calls: [
      { id: 'l2', kind: 'missed', number: '+33 6 98 76 54 32', name: null, key: null, timeMs: callNow - 7_200_000, seconds: 0 },
      { id: 'l1', kind: 'incoming', number: '+33 6 12 34 56 78', name: 'Mum', key: 'sms|0|s:mum', timeMs: callNow - 60_000, seconds: 95 },
    ].reverse() });
    const ringing = { id: 'call-1', phase: 'ringing' as const, direction: 'incoming' as const, number: '+33 6 12 34 56 78', name: 'Mum', key: 'sms|0|s:mum', sinceMs: callNow };
    const ringWindow = () => app.windows().find((candidate) => candidate.url().endsWith('/renderer/call-popup.html'));
    const mainWindowIs = (event: 'focus' | 'blur') => app.evaluate(({ BaseWindow }, e) => void BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.emit(e), event);
    // Away from Kainos Talk (in a game, say), a call rings as a notification: a window would pull
    // Kainos Talk's workspace up. The number and name can come after the call: the notification follows.
    await mainWindowIs('blur');
    const away = { ...ringing, id: 'call-0' };
    smsPhone.send({ t: 'call', call: { ...away, number: null, name: null, key: null } });
    await poll(async () => bus?.notifications.find((n) => n.summary === 'Unknown number is calling'), Boolean, 5000);
    smsPhone.send({ t: 'call', call: away });
    const awayNote = await poll(async () => bus?.notifications.find((n) => n.summary === 'Mum is calling'), Boolean, 5000);
    check(awayNote !== undefined && ringWindow() === undefined, 'away from Kainos Talk, a ringing call is a notification and opens no window', awayNote?.summary ?? 'none');
    smsPhone.send({ t: 'call', call: null });
    check(await poll(async () => awayNote !== undefined && bus!.closed.includes(awayNote.id), Boolean, 3000), '... which goes once the call stops ringing');
    const notesBefore = bus?.notifications.length ?? 0;

    // In Kainos Talk, it opens the incoming-call window in the middle of the screen.
    await mainWindowIs('focus');
    smsPhone.send({ t: 'call', call: { ...ringing, number: null, name: null, key: null } });
    const ringText = async () => (await ringWindow()?.evaluate(() => document.querySelector('main')?.innerText ?? '').catch(() => '')) ?? '';
    const unnamed = await poll(ringText, (t) => /Unknown number/.test(t), 5000);
    check(/Unknown number/.test(unnamed), 'a ringing call opens the incoming-call window', unnamed.replace(/\s+/g, ' '));
    smsPhone.send({ t: 'call', call: ringing });
    const named = await poll(ringText, (t) => /Mum/.test(t), 5000);
    check(/^Mum\s+\+33 6 12 34 56 78 is calling your phone\s+Decline\s+Answer/.test(named), '... which names the caller once the phone knows them, with Decline and Answer', named.replace(/\s+/g, ' '));
    const ringPlace = await app.evaluate(({ BrowserWindow, screen }) => {
      const ring = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/call-popup.html'))!;
      const b = ring.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      return { dx: b.x + b.width / 2 - (area.x + area.width / 2), dy: b.y + b.height / 2 - (area.y + area.height / 2), title: ring.getTitle(), onTop: ring.isAlwaysOnTop() };
    });
    check(Math.abs(ringPlace.dx) <= 1 && Math.abs(ringPlace.dy) <= 1, '... in the middle of the screen', JSON.stringify(ringPlace));
    if (!ringPlace.onTop) skip('... kept over other windows', 'this headless display has no always-on-top; Wayland compositors decide it themselves');
    check(ringPlace.title === 'Mum is calling', '... titled with the caller', ringPlace.title);
    check(!bus?.notifications.slice(notesBefore).some((n) => / is calling$/.test(n.summary)), '... instead of a desktop notification');
    const bar = () => inService<string>(app, 'inbox', `document.querySelector('.call-bar')?.innerText ?? ''`);
    const ringingBar = await poll(bar, (t) => /Mum/.test(t) && /Answer/.test(t), 5000);
    check(/Mum/.test(ringingBar) && /Decline/.test(ringingBar) && /Answer/.test(ringingBar), 'the Texts page shows the ringing call too, with Decline and Answer', ringingBar.replace(/\s+/g, ' '));
    for (const name of THEME_NAMES) {
      await pickTheme(app, page, name);
      await poll(() => themeAttributes(app, page), (t) => t === `dock ${themeId(name)}, texts ${themeId(name)}`, 3000);
      await poll(async () => (await ringWindow()?.evaluate(() => document.documentElement.dataset.theme ?? 'none')) ?? '', (t) => t === themeId(name), 3000);
      await measureContrast(`${name}: the incoming-call window`, async () => (await ringWindow()!.evaluate(CONTRAST_WALK)) as Measured[]);
      await ringWindow()!.screenshot({ path: join(verify, `04j-call-window-${themeId(name)}.png`) });
    }
    await pickTheme(app, page, 'Match system');
    await screenshot(app, '04j-call-ringing');
    await ringWindow()!.click('#answer');
    const answer = await smsPhone.next('answer');
    check(answer.call === 'call-1', 'Answer in the incoming-call window asks the phone to answer that call', JSON.stringify(answer));
    smsPhone.send({ t: 'replyResult', id: answer.id, ok: true, error: null });
    smsPhone.send({ t: 'call', call: { ...ringing, phase: 'active', sinceMs: Date.now() - 65_000 } });
    const activeBar = await poll(bar, (t) => /End call/.test(t), 5000);
    check(/1:0\d/.test(activeBar) && /End call/.test(activeBar), 'an answered call shows its running time and End call', activeBar.replace(/\s+/g, ' '));
    check((await poll(async () => ringWindow() === undefined, Boolean, 3000)) === true, '... and the incoming-call window closes');
    for (const name of THEME_NAMES) {
      await pickTheme(app, page, name);
      await poll(() => themeAttributes(app, page), (t) => t === `dock ${themeId(name)}, texts ${themeId(name)}`, 3000);
      await measureContrast(`${name}: Texts with a call on`, () => inService<Measured[]>(app, 'inbox', CONTRAST_WALK));
    }
    await pickTheme(app, page, 'Match system');
    await screenshot(app, '04k-call-active');
    await inService(app, 'inbox', `document.querySelector('.call-end').click(); 1`, true);
    const hangUp = await smsPhone.next('hangUp');
    smsPhone.send({ t: 'replyResult', id: hangUp.id, ok: true, error: null });
    smsPhone.send({ t: 'call', call: null });
    check((await poll(bar, (t) => t === '', 5000)) === '', 'End call asks the phone to hang up, and the bar goes once the call ends');

    await inService(app, 'inbox', `document.querySelector('.seg [data-tab="calls"]').click(); 1`, true);
    const callList = await poll(() => inService<string>(app, 'inbox', `document.querySelector('.call-rows').innerText`), (t) => /Missed call/.test(t), 5000);
    check(/Mum[\s\S]*Incoming call, 1 min 35 s[\s\S]*\+33 6 98 76 54 32[\s\S]*Missed call/.test(callList), 'Calls lists the call log, newest first, with how long each call lasted', callList.replace(/\s+/g, ' '));
    const compose = await inService<string>(app, 'inbox', `document.querySelector('.new-text').title`);
    await inService(app, 'inbox', `document.querySelector('.new-text').click(); 1`, true);
    const dialForm = await poll(() => inService<boolean>(app, 'inbox', `document.activeElement?.id === 'dial-to'`), Boolean, 3000);
    check(compose === 'Call a number' && dialForm, '... and its new button is Call a number, which opens the call form ready to type', compose);
    await screenshot(app, '04l-calls');
    await inService(app, 'inbox', `(() => { const to = document.querySelector('#dial-to'); to.value = '12'; to.form.requestSubmit(); return 1; })()`, true);
    const tooShort = await inService<string>(app, 'inbox', `document.querySelector('.new-form .composer-note').textContent`);
    check(/Type a phone number/.test(tooShort), 'a number too short to dial is caught in the form', tooShort);
    await inService(app, 'inbox', `document.querySelector('.call-rows .row[data-call="l2"]').click(); 1`, true);
    const prefilled = await poll(() => inService<string>(app, 'inbox', `document.querySelector('#dial-to')?.value ?? ''`), (v) => v !== '', 3000);
    check(prefilled === '+33 6 98 76 54 32', 'a call with no conversation puts its number in the call form', prefilled);
    await inService(app, 'inbox', `document.querySelector('#dial-to').form.requestSubmit(); 1`, true);
    const dialled = await smsPhone.next('dial');
    check(dialled.number === '+33 6 98 76 54 32' && dialled.key === null, 'Call on the form asks the phone to dial that number', JSON.stringify(dialled));
    smsPhone.send({ t: 'replyResult', id: dialled.id, ok: false, error: 'no permission to make calls' });
    const refused = await poll(bar, (t) => /no permission/.test(t), 5000);
    check(/no permission to make calls/.test(refused), "the phone's refusal shows across the top", refused.replace(/\s+/g, ' '));
    await inService(app, 'inbox', `document.querySelector('.call-bar .quiet').click(); 1`, true);
    check((await poll(bar, (t) => t === '', 3000)) === '', '... until it is dismissed');

    await inService(app, 'inbox', `document.querySelector('.call-rows .row[data-call="l1"]').click(); 1`, true);
    const thread = await poll(() => inService<{ tab: string; head: string; line: string }>(app, 'inbox', `({ tab: document.querySelector('.texts').dataset.tab, head: document.querySelector('.thread-head h1')?.textContent ?? '', line: document.querySelector('.call-line')?.textContent ?? '' })`), (t) => t.head === 'Mum', 5000);
    check(thread.head === 'Mum' && thread.tab === 'calls' && /^Incoming call, 1 min 35 s, /.test(thread.line), "a call with a conversation opens it, its calls among its texts, and Calls stays selected", JSON.stringify(thread));
    await screenshot(app, '04m-call-in-thread');
    await inService(app, 'inbox', `(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.value = 'On my w'; t.dispatchEvent(new Event('input')); return 1; })()`, true);
    smsPhone.send({ t: 'callLog', calls: [{ id: 'l3', kind: 'outgoing', number: '+33 6 12 34 56 78', name: 'Mum', key: 'sms|0|s:mum', timeMs: Date.now(), seconds: 12 }] });
    const kept = await poll(
      () => inService<{ line: string; focused: boolean; draft: string }>(app, 'inbox', `({ line: document.querySelector('.call-line')?.textContent ?? '', focused: document.activeElement?.matches('.composer textarea') ?? false, draft: document.querySelector('.composer textarea').value })`),
      (k) => k.line.startsWith('Outgoing call'),
      5000,
    );
    check(kept.focused && kept.draft === 'On my w', 'a call arriving in the open thread leaves the draft being typed focused', JSON.stringify(kept));
    await inService(app, 'inbox', `document.querySelector('.call-button').click(); 1`, true);
    const dialByKey = await smsPhone.next('dial');
    check(dialByKey.key === 'sms|0|s:mum' && dialByKey.number === null, "Call in a conversation's header dials that conversation's number", JSON.stringify(dialByKey));
    smsPhone.send({ t: 'replyResult', id: dialByKey.id, ok: true, error: null });
    await inService(app, 'inbox', `document.querySelector('.seg [data-tab="people"]').click(); 1`, true);

    // Unread counts come from page titles.
    await inService(app, 'proton-mail', `document.title = '(4) Inbox | Proton Mail'`);
    await inService(app, 'discord', `document.title = '• Discord | #general'`);
    check((await poll(() => tabState(page, 'proton-mail'), (text) => text === 'count:4', 5000)) === 'count:4', 'the Proton tab shows 4');
    check((await poll(() => tabState(page, 'discord'), (text) => text === 'dot:', 5000)) === 'dot:', 'the Discord tab shows a dot for new activity');
    // The window title counts every service: the texts' unread plus Proton's 4 (Discord's marker adds no number).
    const textsUnread = Number((await inService<string>(app, 'inbox', 'document.title')).match(/^\((\d+)\)/)?.[1] ?? 0);
    const expectedTitle = `(${textsUnread + 4}) Kainos Talk`;
    const title = await poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.getTitle()), (value) => value === expectedTitle, 5000);
    check(title === expectedTitle, "window title adds up the texts and the websites' unread", title);
    await inService(app, 'whatsapp', `document.title = '(99+) WhatsApp'`);
    check((await poll(() => tabState(page, 'whatsapp'), (text) => text === 'count:99+', 5000)) === 'count:99+', 'a capped "(99+)" title shows 99+');
    await inService(app, 'whatsapp', `document.title = 'WhatsApp'`);
    await screenshot(app, '05-unread-badges');

    // Proton's Inbox counter, read from the page. The real selector is unverified (it needs a
    // signed-in page), so this plants a stand-in element to prove the preload-to-badge path.
    await inService(app, 'proton-mail', `document.body.insertAdjacentHTML('beforeend', '<nav id="kainos-smoke-inbox" data-testid="navigation-link:inbox"><span data-testid="navigation-link:unread-count">12</span></nav>'); 1`);
    check((await poll(() => tabState(page, 'proton-mail'), (text) => text === 'count:12', 6000)) === 'count:12', 'the Proton tab follows the Inbox counter in the page over the title (stand-in element)');
    await inService(app, 'proton-mail', `document.querySelector('#kainos-smoke-inbox span').remove(); 1`);
    check((await poll(() => tabState(page, 'proton-mail'), (text) => text === ':', 6000)) === ':', 'the Proton count clears when the Inbox counter disappears');
    await inService(app, 'proton-mail', `document.querySelector('#kainos-smoke-inbox').remove(); 1`);
    check((await poll(() => tabState(page, 'proton-mail'), (text) => text === 'count:4', 6000)) === 'count:4', 'without the Inbox link, Proton falls back to the title');

    // The phone brings texts only, so a website's own notification still shows while it is connected.
    const own = nextAppEvent<{ serviceId: string; muted: boolean; shown: boolean }>(app, 'kainos-notification');
    await inService(app, 'whatsapp', `new Notification('Own'); 1`);
    const ownShown = await own;
    check(ownShown.serviceId === 'whatsapp' && !ownShown.muted && ownShown.shown, "with the phone connected, a website's own notification is shown", JSON.stringify(ownShown));
    smsPhone?.close();
    smsPhone = undefined;
    await poll(() => inService<string>(app, 'inbox', 'document.body.innerText'), (t) => /not connected/.test(t), 5000);
    check((await poll(() => tabState(page, 'inbox'), (t) => t === 'offline:', 5000)) === 'offline:', 'with the phone gone, the Texts tab shows it is not connected');
    const offlineIsland = await page.locator('#phone').innerText();
    check(/Pixel 9\s*not connected/.test(offlineIsland), '... and so does the phone island', offlineIsland.replace(/\s+/g, ' '));

    // Notifications: forwarded when unmuted, clicking focuses the service; dropped when muted.
    await pressShortcut(app, page, 'dock', digit('proton-mail'));
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
    await pressShortcut(app, page, 'dock', digit('whatsapp'));
    // Copy is allowed and reading the clipboard stays denied. A site's own Permissions-Policy
    // (WhatsApp sometimes sends one) or a missing focus can refuse first, which proves nothing
    // about Kainos, so each service page is tried and only answers from Kainos count.
    const clipboard = async (call: string) => {
      const results: string[] = [];
      for (const [index, id] of AWAKE_IDS.entries()) {
        // The SMS view is Kainos' own page; it never copies to the clipboard.
        if (id === 'inbox') continue;
        await pressShortcut(app, page, 'dock', index + 1);
        await app.evaluate(({ BaseWindow }, i) => (BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html'))[i] as Electron.WebContentsView).webContents.focus(), index);
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
    await pressShortcut(app, page, 'dock', digit('whatsapp'));
    const persisted = await inService<boolean>(app, 'whatsapp', `navigator.storage.persist()`);
    check(persisted, "a service page's storage is marked persistent");
    const [width] = await contentSize(app);
    const entered = await inService<string>(app, 'whatsapp', `document.documentElement.requestFullscreen().then(() => 'ok', (e) => e.name)`, true);
    const covered = async () => {
      const [w, h] = await contentSize(app);
      const b = await viewBounds(app, 'whatsapp');
      return b.y === 0 && b.width === w && b.height === h && (await dockBounds(app)) === null;
    };
    const full = await poll(covered, Boolean, 5000);
    check(entered === 'ok' && full, 'a page in fullscreen covers the whole window, dock included', `${entered} ${JSON.stringify(await viewBounds(app, 'whatsapp'))}`);
    info('the window itself went fullscreen with the page', String(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.isFullScreen())));
    await inService(app, 'whatsapp', `document.exitFullscreen().then(() => 1, () => 0)`, true);
    await pointer(app, 'whatsapp', 'mouseMove', 300, 300);
    const back = async () => {
      const [, h] = await contentSize(app);
      return (await viewBounds(app, 'whatsapp')).height === h && (await dockBounds(app)) === null;
    };
    check(await poll(back, Boolean, 5000), 'after fullscreen the page fills the window and the dock stays hidden', JSON.stringify(await viewBounds(app, 'whatsapp')));
    await poll(async () => (await contentSize(app))[0], (w) => w === width, 5000);

    // Failed load, light and dark, then retry.
    await pressShortcut(app, page, 'dock', digit('discord'));
    await app.evaluate(({ BaseWindow }) => {
      const view = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html'))[2] as Electron.WebContentsView;
      view.webContents.loadURL('https://kainos-smoke.invalid/').catch(() => undefined);
    });
    check((await poll(() => status(page, 'discord'), (value) => value === 'failed', 20_000)) === 'failed', 'an unreachable page shows the failed state');
    await page.waitForSelector('.notice[data-state="failed"]');
    {
      const [w, h] = await contentSize(app);
      const cover = await dockBounds(app);
      check(cover?.y === 0 && cover.height === h && cover.width === w, 'a failed service: the dock page covers the whole window to say why', JSON.stringify(cover));
      const facts = await page.locator('.facts').innerText();
      check(/kainos-smoke\.invalid/.test(facts) && /ERR_NAME_NOT_RESOLVED/.test(facts), 'the failed screen names the address and the error', facts.replace(/\s+/g, ' '));
    }
    await screenshot(app, '06-failed-light');
    for (const name of THEME_NAMES) {
      await pickTheme(app, page, name);
      await poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''), (t) => t === themeId(name), 3000);
      await measureContrast(`${name}: the failed notice and the dock`, () => page.evaluate(CONTRAST_WALK) as Promise<Measured[]>);
    }
    await pickTheme(app, page, 'Match system');
    await poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? 'none'), (t) => t === 'none', 3000);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    const followsSystem = await poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), Boolean, 3000);
    // Bakelite: the islands are --rail #1f1814 on the --strip #0e0a08.
    const darkDock = () => page.evaluate(() => `${getComputedStyle(document.querySelector('.island')!).backgroundColor} on ${getComputedStyle(document.querySelector('.dock')!).backgroundColor}`);
    const bakelite = 'rgb(31, 24, 20) on rgb(14, 10, 8)';
    if (followsSystem) {
      check((await darkDock()) === bakelite, 'the dock follows the system dark theme (Bakelite)');
    } else {
      skip('the dock follows the system dark theme', 'headless Ozone does not pass nativeTheme to the page');
      await page.emulateMedia({ colorScheme: 'dark' });
      const colours = await darkDock();
      check(colours === bakelite, 'the Bakelite palette applies under an emulated prefers-color-scheme: dark', colours);
    }
      skip('service views paint the theme colour before their page', 'WebContentsView has no getter for its background colour; set in code only');
    await screenshot(app, '07-failed-dark');
    await page.locator('.retry').click();
    check((await poll(() => status(page, 'discord'), (value) => value === 'ready', 60_000)) === 'ready', 'Retry loads Discord again');
    const isWinFocused = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.isFocused());
    if (isWinFocused) check(await poll(() => serviceFocused(app, 'discord'), Boolean, 3000), 'after Retry, keyboard focus is in Discord');
    else skip('after Retry, keyboard focus is in Discord', 'the off-screen window never reports focus, so the app waits for it');

    // Keyboard: F6 from inside the page to its dock tab, then the arrows along the dock.
    await lowerDock(app, 'discord');
    await sendKey(app, 'discord', 'F6');
    check((await poll(() => dockFocus(page), (index) => index === nth('discord'), 5000)) === nth('discord'), 'F6 inside Discord moves focus to its tab in the dock');
    check((await poll(() => raisedDock(page), Boolean, 3000)) && (await dockBounds(app)) !== null, '... and brings the hidden dock up');
    await pointer(app, 'discord', 'mouseMove', 300, 300);
    await sleep(800);
    check((await dockBounds(app)) !== null, 'with keyboard focus in it, the dock stays up whatever the pointer does');
    await page.keyboard.press('ArrowRight');
    check((await dockFocus(page)) === nth('discord') + 1, 'the right arrow moves to the next tab in the dock');
    await page.keyboard.press('ArrowLeft');
    check((await dockFocus(page)) === nth('discord'), '... and the left arrow back');

    // The service menu: by mouse at the pointer, by keyboard at the tab.
    await tab(page, 'discord').click({ button: 'right' });
    const byMouse = (await poll(() => menus(app), (all) => all.length > 0, 5000)).at(-1);
    check(byMouse !== undefined && byMouse.x === undefined && byMouse.labels[0] === 'Reload Discord', 'a right-click opens the Discord menu at the pointer', JSON.stringify(byMouse));
    check(
      JSON.stringify(byMouse?.labels.filter(Boolean)) === '["Reload Discord","Hibernate","Unmute notifications","Move left","Move right","Hide from dock","Sign out of Discord…"]',
      "a website's menu offers Reload, Hibernate, mute, moving and hiding its tab, and Sign out",
      JSON.stringify(byMouse?.labels),
    );
    const box = await tab(page, 'discord').boundingBox();
    await tab(page, 'discord').focus();
    const count = (await menus(app)).length;
    await sendKey(app, 'dock', 'F10', ['shift']);
    let byKey = (await poll(() => menus(app), (all) => all.length > count, 3000)).at(-1);
    let how = 'Shift+F10';
    if ((await menus(app)).length === count) {
      // Chromium did not turn the synthetic Shift+F10 into a contextmenu event here; fire the
      // event the key would have produced, which still has no pointer press before it.
      how = 'a contextmenu event with no pointer press (Shift+F10 not delivered off screen)';
      await tab(page, 'discord').dispatchEvent('contextmenu');
      byKey = (await poll(() => menus(app), (all) => all.length > count, 3000)).at(-1);
    }
    // The dock page sits at the bottom of the window, so its y offset is added to the tab's place.
    const dockAt = await dockBounds(app);
    const expected = box && dockAt ? { x: Math.round(box.x) + dockAt.x, y: Math.round(box.y) + dockAt.y } : undefined;
    check(byKey?.x === expected?.x && byKey?.y === expected?.y, 'a keyboard-opened menu appears at the focused tab, in window coordinates', `${how}: ${JSON.stringify(byKey)} expected ${JSON.stringify(expected)}`);

    // Escape leaves the dock for the page and sends the dock away.
    await tab(page, 'discord').focus();
    await pointer(app, 'dock', 'mouseLeave', 0, 0);
    await sendKey(app, 'dock', 'Escape');
    check((await poll(() => dockBounds(app), (b) => b === null, 3000)) === null, 'Escape in the dock sends it away');
    check(await poll(() => serviceFocused(app, 'discord'), Boolean, 3000), '... and puts keyboard focus back in the page');
    await revealDock(app, page, 'discord');
    await tab(page, 'discord').click({ button: 'right' });
    await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Discord', 5000);

    // Reload is not blocked by a page's "leave site?" prompt.
    await inService(app, 'discord', `window.__kainosMark = 1; addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }); 1`, true);
    check(await clickMenuItem(app, 'Reload'), 'the menu has Reload');
    const reloaded = await poll(() => inService<boolean>(app, 'discord', 'window.__kainosMark === undefined').catch(() => false), Boolean, 20_000);
    check(reloaded, 'Reload goes through despite a beforeunload prompt');

    // Sign out: a page that writes its login back while unloading, behind a "leave site?"
    // prompt, still ends up signed out.
    await pressShortcut(app, page, 'dock', digit('whatsapp'));
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
    await revealDock(app, page, 'whatsapp');
    await tab(page, 'whatsapp').click({ button: 'right' });
    await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload WhatsApp', 5000);
    check(await clickMenuItem(app, 'Sign out'), 'the menu has Sign out');
    await poll(() => status(page, 'whatsapp'), (value) => value === 'loading', 10_000);
    // The temporary about:blank page also reports ready, before storage has been cleared.
    // Wait for WhatsApp to return before inspecting its storage.
    const signedOutReady = await poll(async () => {
      const url = await inService<string>(app, 'whatsapp', 'location.href').catch(() => '');
      return url.startsWith('https://web.whatsapp.com/') && (await status(page, 'whatsapp')) === 'ready';
    }, Boolean, 60_000);
    check(signedOutReady, 'WhatsApp loads again after Sign out');
    const stored = await inService<string | null>(app, 'whatsapp', `localStorage.getItem('kainosSmoke')`);
    const cookies = await app.evaluate(({ session }) => session.fromPartition('persist:service-whatsapp').cookies.get({ name: 'kainosSmoke' }));
    check(stored === null && cookies.length === 0, 'Sign out leaves no login behind, even one written back at unload', `localStorage ${stored}, cookies ${cookies.length}`);
    check((await boxes(app)).some((b) => b.message === 'Sign out of WhatsApp?'), 'Sign out asks first');

    // A failed sign-out is reported and the service comes back.
    await app.evaluate(({ session }) => {
      const ses = session.fromPartition('persist:service-proton-mail');
      ses.clearStorageData = () => Promise.reject(new Error('smoke: disk is read-only'));
    });
    await revealDock(app, page, (SERVICE_IDS[await activeIndex(page)] ?? 'whatsapp') as ServiceId);
    await tab(page, 'proton-mail').click({ button: 'right' });
    await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Proton Mail', 5000);
    await clickMenuItem(app, 'Sign out');
    const report = await poll(() => boxes(app), (all) => all.some((b) => b.type === 'error'), 10_000);
    check(report.some((b) => b.type === 'error' && b.message === 'Could not sign out of Proton Mail'), 'a failed sign-out is reported to the user', JSON.stringify(report.at(-1)));
    const afterFailedSignOut = await poll(() => status(page, 'proton-mail'), (value) => value === 'ready', 60_000);
    check(afterFailedSignOut === 'ready', 'Proton Mail loads again after the failed sign-out', `${afterFailedSignOut} at ${await serviceUrl(app, 'proton-mail')}`);
    await page.evaluate(() => undefined);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system';
    });
    await page.emulateMedia({ colorScheme: null });

    await pressShortcut(app, page, 'dock', digit('whatsapp'));
    await sleep(2500);
    await lowerDock(app, 'whatsapp');
    await screenshot(app, '08-whatsapp');

    // The dock at the user's window sizes, light and dark: hidden and up over WhatsApp, up over
    // Texts, and always shown. In desktop/.verify/reveal/.
    {
      mkdirSync(join(verify, 'reveal'), { recursive: true });
      const [w0, h0] = await contentSize(app);
      const pages = [page, ...app.windows().filter((candidate) => /\/renderer\/inbox\.html|web\.whatsapp\.com/.test(candidate.url()))];
      const toggleAlways = async () => {
        await page.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
        await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Always show the dock', 5000);
        await clickMenuItem(app, 'Always show the dock');
      };
      for (const scheme of ['light', 'dark'] as const) {
        await app.evaluate(({ nativeTheme }, source) => {
          nativeTheme.themeSource = source;
        }, scheme);
        for (const candidate of pages) await candidate.emulateMedia({ colorScheme: scheme });
        for (const [width, height] of [[3440, 1440], [1418, 2488]] as const) {
          const shot = (name: string) => screenshot(app, `reveal/${width}x${height}-${scheme}-${name}`);
          await app.evaluate(({ BaseWindow }, { width, height }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(width, height), { width, height });
          await pressShortcut(app, page, 'whatsapp', digit('whatsapp'));
          await lowerDock(app, 'whatsapp');
          await sleep(800);
          await shot('1-whatsapp-hidden');
          await revealDock(app, page, 'whatsapp');
          await shot('2-whatsapp-revealed');
          await pressShortcut(app, page, 'whatsapp', digit('inbox'));
          await lowerDock(app, 'inbox');
          await revealDock(app, page, 'inbox');
          await shot('3-texts-revealed');
          await pressShortcut(app, page, 'inbox', digit('whatsapp'));
          await toggleAlways();
          await poll(() => dockBounds(app), (b) => b?.height === DOCK, 3000);
          await lowerDock(app, 'whatsapp').catch(() => false);
          await sleep(500);
          await shot('4-whatsapp-always-shown');
          await toggleAlways();
          await lowerDock(app, 'whatsapp');
        }
      }
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'system';
      });
      for (const candidate of pages) await candidate.emulateMedia({ colorScheme: null });
      await app.evaluate(({ BaseWindow }, [w, h]) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(w!, h!), [w0, h0]);
      await sleep(500);
    }

    // The dock options: keep the dock shown in its own strip, saved with the window state.
    await revealDock(app, page, 'whatsapp');
    await page.locator('#dock-options').click();
    const dockMenu = (await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Always show the dock', 5000)).at(-1);
    check(JSON.stringify(dockMenu?.labels) === '["Always show the dock","Hidden services","Choose apps…","Theme"]', 'the Kainos mark opens the dock options: Always show the dock, Hidden services, Choose apps…, Theme', JSON.stringify(dockMenu?.labels));
    const themeItems = await submenuLabels(app, 'Theme');
    check(JSON.stringify(themeItems) === '["*Match system","Switchboard","Daylight","Bakelite","Carbon","Aubergine"]', 'Theme offers Match system (picked) and the five themes', JSON.stringify(themeItems));
    await clickMenuItem(app, 'Always show the dock');
    {
      const [w, h] = await contentSize(app);
      const strip = await poll(() => dockBounds(app), (b) => b?.height === DOCK, 3000);
      const view = await viewBounds(app, 'whatsapp');
      check(JSON.stringify(strip) === JSON.stringify({ x: 0, y: h - DOCK, width: w, height: DOCK }), 'Always show the dock: a 64px strip along the bottom of the window', `${JSON.stringify(strip)} in ${w}x${h}`);
      check(JSON.stringify(view) === JSON.stringify({ x: 0, y: 0, width: w, height: h - DOCK }), "... and the page ends above it, so the dock never covers the page's composer", JSON.stringify(view));
      check(Math.abs((await groupCentre(app, page)) - w / 2) <= 1, '... with the services and the phone together in the middle', String(await groupCentre(app, page)));
      await lowerDock(app, 'whatsapp').catch(() => false);
      await sleep(800);
      check(JSON.stringify(await dockBounds(app)) === JSON.stringify(strip), '... which stays when the pointer goes up into the page');
    }
    await sleep(300);
    await screenshot(app, '09-dock-always');

    // Themes: each one applies at once to the dock and the Texts page and the window behind
    // them, with every text readable. In desktop/.verify/themes/, Texts at 1720×1440.
    {
      mkdirSync(join(verify, 'themes'), { recursive: true });
      const [w0, h0] = await contentSize(app);
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(1720, 1440));
      await pressShortcut(app, page, 'dock', digit('inbox'));
      const background = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.getBackgroundColor().toLowerCase());
      // With the phone gone: the disconnected bar and the dock's "not connected".
      for (const name of THEME_NAMES) {
        await pickTheme(app, page, name);
        const id = themeId(name);
        const applied = await poll(() => themeAttributes(app, page), (t) => t === `dock ${id}, texts ${id}`, 3000);
        check(applied === `dock ${id}, texts ${id}`, `${name} applies to the dock and the Texts page without a restart`, applied);
        const paints = await background();
        check(paints === { switchboard: '#0b1316', daylight: '#ffffff', bakelite: '#15100d', carbon: '#000000', aubergine: '#21152b' }[id], `... and the window behind the pages paints its page colour`, paints);
        await measureContrast(`${name}: the Texts page, phone not connected`, () => inService<Measured[]>(app, 'inbox', CONTRAST_WALK));
        await measureContrast(`${name}: the dock, phone not connected`, () => page.evaluate(CONTRAST_WALK) as Promise<Measured[]>);
      }
      // With the phone back: a thread with a sent reply and a code, for the screenshots.
      smsPhone = await connectPaired(syncPort, deviceId);
      smsPhone.send({
        t: 'conversation',
        conversation: conversation('sms|0|s:garage', 'Garage Delaunay', [
          { id: 'g1', text: 'Your car is ready. We close at 18:30.', timeMs: Date.now() - 3_600_000 },
          { id: 'g2', text: 'Coming at 18:00', timeMs: Date.now() - 3_000_000, outgoing: true },
          { id: 'g4', text: 'Your pickup code is 482913. Keys are at the desk.', timeMs: Date.now() - 60_000 },
        ], 0),
      });
      await poll(() => tabState(page, 'inbox'), (t) => !t.startsWith('offline'), 5000);
      await inService(app, 'inbox', `document.querySelector('.row[data-key="sms|0|s:garage"]').click(); 1`, true);
      await poll(smsText, (t) => t.includes('Coming at 18:00') && t.includes('482'), 5000);
      for (const [i, name] of THEME_NAMES.entries()) {
        await pickTheme(app, page, name);
        await poll(() => themeAttributes(app, page), (t) => t === `dock ${themeId(name)}, texts ${themeId(name)}`, 3000);
        await measureContrast(`${name}: the Texts page`, () => inService<Measured[]>(app, 'inbox', CONTRAST_WALK));
        await measureContrast(`${name}: the dock`, () => page.evaluate(CONTRAST_WALK) as Promise<Measured[]>);
        await sleep(300);
        await screenshot(app, `themes/${i + 1}-${themeId(name)}`);
      }
      smsPhone.close();
      smsPhone = undefined;
      await poll(() => tabState(page, 'inbox'), (t) => t === 'offline:', 5000);
      await pickTheme(app, page, 'Match system');
      const system = await poll(() => themeAttributes(app, page), (t) => t === 'dock none, texts none', 3000);
      check(system === 'dock none, texts none', 'Match system takes the forced theme off both pages', system);
      // Kept for the second launch.
      await pickTheme(app, page, 'Carbon');
      await poll(() => themeAttributes(app, page), (t) => t === 'dock carbon, texts carbon', 3000);
      writeFileSync(join(verify, 'themes', 'contrast.json'), JSON.stringify(contrastLog, null, 2));
      await app.evaluate(({ BaseWindow }, [w, h]) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(w!, h!), [w0, h0]);
      await pressShortcut(app, page, 'dock', digit('whatsapp'));
    }

    // The phone island: forgetting the phone is one menu away from any service.
    await page.locator('#phone').click();
    const phoneMenu = (await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Open Texts', 5000)).at(-1);
    check(JSON.stringify(phoneMenu?.labels.filter(Boolean)) === '["Open Texts","Forget Pixel 9…"]', 'the phone island opens Open Texts and Forget this phone', JSON.stringify(phoneMenu?.labels));
    check(await clickMenuItem(app, 'Forget'), 'the phone menu has Forget');
    check((await boxes(app)).some((b) => b.message === 'Forget Pixel 9?'), 'Forget asks first');
    check(/No phone/.test(await poll(() => page.locator('#phone').innerText(), (t) => /No phone/.test(t), 5000)), 'after Forget, the phone island says there is no phone');
    await page.locator('#phone').click();
    check((await poll(() => activeIndex(page), (index) => index === nth('inbox'), 3000)) === nth('inbox'), 'with no phone, the phone island opens the Texts page to connect one');
    const forgotten = await poll(() => inService<string>(app, 'inbox', 'document.body.innerText'), (t) => /Connect your phone/.test(t), 5000);
    check(/Connect your phone/.test(forgotten), '... where Texts asks to connect a phone again');
    await pressShortcut(app, page, 'dock', digit('whatsapp'));

    // Streamroom starts hibernated: no page, a moon on its tab. Opening its tab wakes it,
    // Hibernate in its menu closes its page again (and its renderer process with it), Wake
    // brings it back without opening it, and an invite link sent in another service opens in
    // its tab instead of the browser.
    {
      const pageViews = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.contentView.children.filter((v) => !(v as Electron.WebContentsView).webContents.getURL().endsWith('/call-strip.html')).length - 1);
      const roomPages = () =>
        app.evaluate(({ webContents, session }) => webContents.getAllWebContents().filter((c) => !c.isDestroyed() && c.session === session.fromPartition('persist:service-streamroom')).length);
      const savedAsleep = () => (JSON.parse(readFileSync(stateFile, 'utf8')) as { hibernatedServiceIds?: string[] }).hibernatedServiceIds?.join(' ') ?? '';
      const openMenu = async (label: string) => {
        await tab(page, 'streamroom').click({ button: 'right' });
        return (await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === label, 5000)).at(-1)?.labels[0] === label;
      };
      check((await status(page, 'streamroom')) === 'hibernated' && (await tabState(page, 'streamroom')) === 'asleep:', 'Streamroom starts hibernated, with a moon on its tab', `${await status(page, 'streamroom')} ${await tabState(page, 'streamroom')}`);
      check((await pageViews()) === AWAKE_IDS.length && (await roomPages()) === 0, '... and has no page while it sleeps', `${await pageViews()} views, ${await roomPages()} Streamroom pages`);
      check(/hibernating/.test((await tab(page, 'streamroom').getAttribute('aria-label')) ?? ''), '... which its tab says to screen readers', String(await tab(page, 'streamroom').getAttribute('aria-label')));
      await lowerDock(app, 'whatsapp');
      await revealDock(app, page, 'whatsapp');
      await page.mouse.move(2, 2);
      await screenshot(app, '05-streamroom-hibernating');

      await tab(page, 'streamroom').click();
      const woke = await poll(() => status(page, 'streamroom'), (value) => value === 'ready', 60_000);
      check(woke === 'ready' && (await activeTab(page)) === 'streamroom', 'opening its tab wakes Streamroom and shows it', `${woke}, active ${await activeTab(page)}`);
      check((await pageViews()) === SERVICE_IDS.length && (await tabState(page, 'streamroom')) === ':', '... with a page of its own again and no moon', `${await pageViews()} views`);
      check(!savedAsleep().includes('streamroom'), '... and is saved as awake', savedAsleep());
      check((await inService<string>(app, 'streamroom', 'document.title')) === 'Streamroom stand-in', 'Streamroom shows its server, on this PC over plain http', await serviceUrl(app, 'streamroom'));
      await sleep(1500);
      await screenshot(app, '06-streamroom-awake');

      // Screen sharing: Streamroom's request reaches the picker (stubbed here to offer nothing,
      // which the page sees as a cancelled share); Discord's never does.
      await app.evaluate(({ desktopCapturer }) => {
        const g = globalThis as Record<string, unknown>;
        g.__pickerAsked = 0;
        desktopCapturer.getSources = async () => {
          g.__pickerAsked = (g.__pickerAsked as number) + 1;
          return [];
        };
      });
      const share = (id: ServiceId) => inService<string>(app, id, `navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'shared', (e) => e.name)`, true);
      const roomShare = await share('streamroom');
      const asked = await app.evaluate(() => (globalThis as Record<string, unknown>).__pickerAsked as number);
      // Electron reports a picker closed without a choice as AbortError, a refusal as NotAllowedError.
      check(asked === 1 && roomShare === 'AbortError', 'Streamroom may share the screen: its request opens the picker, and closing it cancels', `${asked} picker, page got ${roomShare}`);
      const discordShare = await share('discord');
      const askedAfter = await app.evaluate(() => (globalThis as Record<string, unknown>).__pickerAsked as number);
      check(askedAfter === 1 && discordShare === 'NotAllowedError', 'Discord may not: its request is refused without reaching a picker', `${askedAfter} picker, page got ${discordShare}`);

      check(await openMenu('Reload Streamroom'), "Streamroom's menu opens");
      check(
        JSON.stringify(await menuItems(app)) === '["Reload Streamroom","Hibernate","Mute notifications","Server","Move left","(Move right)","Hide from dock","Sign out of Streamroom…"]',
        "an awake website's menu offers Hibernate",
        JSON.stringify(await menuItems(app)),
      );
      await clickMenuItem(app, 'Hibernate');
      check((await poll(() => status(page, 'streamroom'), (value) => value === 'hibernated', 5000)) === 'hibernated', 'Hibernate puts Streamroom back to sleep');
      check((await poll(() => activeTab(page), (id) => id === 'messenger', 3000)) === 'messenger', '... and, as it was open, opens Messenger, the tab before it', await activeTab(page));
      check((await poll(roomPages, (n) => n === 0, 5000)) === 0 && (await pageViews()) === AWAKE_IDS.length, '... closing its page and renderer process', `${await roomPages()} Streamroom pages`);
      check((await poll(async () => savedAsleep(), (ids) => ids === 'streamroom', 3000)) === 'streamroom', '... and is saved at once', savedAsleep());

      check(await openMenu('Wake Streamroom'), 'a hibernating service offers Wake instead of Reload', JSON.stringify((await menus(app)).at(-1)?.labels));
      check(!(await menuItems(app)).includes('Hibernate'), '... and no Hibernate', JSON.stringify(await menuItems(app)));
      await clickMenuItem(app, 'Wake');
      check((await poll(() => status(page, 'streamroom'), (value) => value === 'ready', 60_000)) === 'ready' && (await activeTab(page)) === 'messenger', 'Wake loads Streamroom where it is, without opening its tab', await activeTab(page));
      await openMenu('Reload Streamroom');
      await clickMenuItem(app, 'Hibernate');
      await poll(() => status(page, 'streamroom'), (value) => value === 'hibernated', 5000);

      // An invite sent in WhatsApp: the link wakes Streamroom straight onto it.
      await pressShortcut(app, page, 'dock', digit('whatsapp'));
      await app.evaluate(({ app: electronApp }) => {
        const g = globalThis as Record<string, unknown>;
        g.__external = [];
        electronApp.on('kainos-external' as 'ready', (url: unknown) => (g.__external as unknown[]).push(url));
      });
      await inService(app, 'whatsapp', `window.open(${JSON.stringify(`${room}/?invite=smoke`)}, '_blank'); 0`, true);
      const joined = await poll(() => activeTab(page), (id) => id === 'streamroom', 5000);
      const at = await poll(() => serviceUrl(app, 'streamroom'), (url) => url.includes('invite=smoke'), 30_000);
      const external = await app.evaluate(() => (globalThis as Record<string, unknown>).__external as string[]);
      check(joined === 'streamroom' && at.startsWith(`${room}/?invite=smoke`) && external.length === 0, 'a Streamroom link opened in WhatsApp wakes Streamroom on that link, not the browser', JSON.stringify({ joined, at, external }));
      await poll(() => status(page, 'streamroom'), (value) => value === 'ready', 60_000);
      await inService(app, 'whatsapp', `window.open('https://example.com/kainos-smoke', '_blank'); 0`, true);
      const others = await poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__external as string[]), (list) => list.length > 0, 5000);
      check(JSON.stringify(others) === '["https://example.com/kainos-smoke"]', '... while other links still go to the browser', JSON.stringify(others));

      // The Server submenu lists this PC and the added addresses. Add an address… opens a window
      // that reads back what will open, refuses plain http off this PC, and switches the tab.
      {
        const host = new URL(room).host;
        const otherHost = new URL(otherRoom).host;
        const savedRooms = () => JSON.stringify((JSON.parse(readFileSync(stateFile, 'utf8')) as { streamroom?: unknown }).streamroom);
        await pressShortcut(app, page, 'dock', digit('streamroom'));
        check(await openMenu('Reload Streamroom'), "Streamroom's menu opens with its server list");
        const listed = JSON.stringify(await submenuLabels(app, 'Server'));
        const guides = ['', 'Run Streamroom on this PC…', 'Deploy your own on Cloudflare…'];
        check(listed === JSON.stringify(['This PC (localhost:8080)', `*${host}`, '', 'Add an address…', "Change this PC's port…", `Forget ${host}`, ...guides]), '... this PC, then the added address, checked', listed);
        await clickMenuItem(app, 'Server > Add an address…');
        const dialog = await poll(async () => app.windows().find((w) => w.url().includes('/renderer/server.html?mode=address')), Boolean, 10_000);
        check(dialog !== undefined, 'Add an address… opens its window');
        if (dialog) {
          await dialog.waitForSelector('#address');
          const theme = (JSON.parse(readFileSync(stateFile, 'utf8')) as { theme?: string }).theme;
          const shown = await poll(() => dialog.evaluate(() => document.documentElement.getAttribute('data-theme')), (t) => t === (theme === 'system' ? null : theme), 3000);
          check(shown === (theme === 'system' ? null : theme), '... in the theme of the dock', `${shown} for ${theme}`);
          check(await dialog.locator('#submit').isDisabled(), '... and Add and open waits for an address');
          await dialog.fill('#address', 'http://192.168.1.20:8080');
          await dialog.press('#address', 'Enter');
          const refused = await poll(() => dialog.locator('#reading').innerText(), (t) => /this PC/.test(t), 3000);
          check(/only works for a server on this PC/.test(refused) && !dialog.isClosed(), 'plain http on another computer is refused, with the reason', refused);
          await dialog.fill('#address', `localhost:${new URL(otherRoom).port}`);
          const reads = await dialog.locator('#reading').innerText();
          check(reads === `Opens ${otherRoom}`, '... and a typed address reads back what will open', reads);
          await dialog.screenshot({ path: join(verify, '07-add-streamroom-address.png') });
          // The window closes while the key is still being pressed, which is the point.
          await dialog.press('#address', 'Enter').catch(() => {});
          const gone = await poll(async () => dialog.isClosed(), Boolean, 5000);
          const moved = await poll(() => serviceUrl(app, 'streamroom'), (url) => url.startsWith(otherRoom), 15_000);
          check(gone && moved.startsWith(otherRoom), 'Add and open closes the window and opens the new server in the tab', moved);
          check(savedRooms() === JSON.stringify({ current: otherRoom, saved: [room, otherRoom], localPort: 8080 }), '... and saves it after the first', savedRooms());
        }
        check(await openMenu('Reload Streamroom'), "Streamroom's menu lists the new server");
        const relisted = JSON.stringify(await submenuLabels(app, 'Server'));
        check(relisted === JSON.stringify(['This PC (localhost:8080)', host, `*${otherHost}`, '', 'Add an address…', "Change this PC's port…", `Forget ${otherHost}`, ...guides]), '... checked, after the first', relisted);
        // The guides open in the browser (reported, not opened, in this run): the invite check's
        // listener records them, into a fresh list.
        await app.evaluate(() => ((globalThis as Record<string, unknown>).__external = []));
        await clickMenuItem(app, 'Server > Run Streamroom on this PC…');
        const guide = await poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__external as string[]), (list) => list.length > 0, 5000);
        check(JSON.stringify(guide) === '["https://github.com/HuuTrucNguyen0508/streamroom/blob/main/docs/local.md"]', 'Run Streamroom on this PC… opens the Streamroom guide in the browser', JSON.stringify(guide));
        check(await openMenu('Reload Streamroom'), "Streamroom's menu opens again");
        await clickMenuItem(app, `Server > ${host}`);
        const back = await poll(() => serviceUrl(app, 'streamroom'), (url) => url.startsWith(room), 15_000);
        const backTitle = await poll(() => inService<string>(app, 'streamroom', 'document.title'), (t) => t === 'Streamroom stand-in', 10_000);
        check(back.startsWith(room) && backTitle === 'Streamroom stand-in', 'picking a server in the menu reloads the tab on it', back);
        check(savedRooms() === JSON.stringify({ current: room, saved: [room, otherRoom], localPort: 8080 }), '... and saves the choice', savedRooms());

        // Change this PC's port…: the same window for a port, which moves This PC and opens it.
        const pcPort = new URL(pcRoom).port;
        check(await openMenu('Reload Streamroom'), "Streamroom's menu opens for the port");
        await clickMenuItem(app, "Server > Change this PC's port…");
        const portDialog = await poll(async () => app.windows().find((w) => w.url().includes('/renderer/server.html') && w.url().includes('mode=port')), Boolean, 10_000);
        check(portDialog !== undefined, "Change this PC's port… opens the window for a port");
        if (portDialog) {
          await portDialog.waitForSelector('#address');
          const opened = { title: await portDialog.locator('h1').innerText(), value: await portDialog.inputValue('#address'), button: await portDialog.locator('#submit').innerText() };
          check(JSON.stringify(opened) === JSON.stringify({ title: "Change this PC's port", value: '8080', button: 'Use this port' }), '... titled for it, holding the current port', JSON.stringify(opened));
          await portDialog.fill('#address', '99999');
          await portDialog.press('#address', 'Enter');
          const refused = await poll(() => portDialog.locator('#reading').innerText(), (t) => /65535/.test(t), 3000);
          check(/from 1 to 65535/.test(refused), '... refuses a port out of range, with the reason', refused);
          await portDialog.fill('#address', pcPort);
          const reads = await portDialog.locator('#reading').innerText();
          check(reads === `Opens ${pcRoom}`, '... and reads back the address it will open', reads);
          await portDialog.screenshot({ path: join(verify, '08-change-this-pc-port.png') });
          await portDialog.press('#address', 'Enter').catch(() => {});
          await poll(async () => portDialog.isClosed(), Boolean, 5000);
          const onPc = await poll(() => inService<string>(app, 'streamroom', 'document.title'), (t) => t === 'Streamroom on this PC', 15_000);
          check(onPc === 'Streamroom on this PC', 'Use this port opens This PC on the new port', await serviceUrl(app, 'streamroom'));
          check(savedRooms() === JSON.stringify({ current: pcRoom, saved: [room, otherRoom], localPort: Number(pcPort) }), '... and saves the port', savedRooms());
          check(await openMenu('Reload Streamroom'), "Streamroom's menu shows the new port");
          const moved = JSON.stringify((await submenuLabels(app, 'Server')).slice(0, 3));
          check(moved === JSON.stringify([`*This PC (localhost:${pcPort})`, host, otherHost]), '... as This PC, checked', moved);
          await clickMenuItem(app, `Server > ${host}`);
          await poll(() => serviceUrl(app, 'streamroom'), (url) => url.startsWith(room), 15_000);
        }
        await pressShortcut(app, page, 'dock', digit('whatsapp'));
      }

      // Asleep again for the rest of the run.
      await openMenu('Reload Streamroom');
      await clickMenuItem(app, 'Hibernate');
      await poll(() => status(page, 'streamroom'), (value) => value === 'hibernated', 5000);
      await pressShortcut(app, page, 'dock', digit('whatsapp'));
    }

    // Rearranging the dock: dragging a tab, Alt+arrows, Move left and right, Hide from dock and
    // back. On the floating dock at 1720×1440, dark (Bakelite); shots in desktop/.verify/dock-order/.
    {
      mkdirSync(join(verify, 'dock-order'), { recursive: true });
      const [w0, h0] = await contentSize(app);
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(1720, 1440));
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark';
      });
      await page.emulateMedia({ colorScheme: 'dark' });
      await pickTheme(app, page, 'Match system');
      const toggleAlways = async () => {
        await page.evaluate(() => (window as unknown as { kainos: { openBarMenu(): void } }).kainos.openBarMenu());
        await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Always show the dock', 5000);
        await clickMenuItem(app, 'Always show the dock');
      };
      await toggleAlways();
      const [w, h] = await contentSize(app);
      check((await tabOrder(page)) === 'inbox proton-mail discord whatsapp messenger streamroom', 'the dock starts in the services’ own order', await tabOrder(page));
      await pressShortcut(app, page, 'dock', digit('whatsapp'));
      await lowerDock(app, 'whatsapp');
      await revealDock(app, page, 'whatsapp');

      // A release outside the renderer may never deliver pointerup. Returning without the
      // primary button must cancel both a pending press and an already active drag.
      for (const started of [false, true]) {
        await revealDock(app, page, 'whatsapp');
        await page.evaluate((started) => {
          const button = document.querySelector<HTMLButtonElement>('.tab[data-id="discord"]')!;
          const box = button.getBoundingClientRect();
          const init = { bubbles: true, pointerId: 71, isPrimary: true, button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
          button.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
          if (started) document.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1, clientX: init.clientX + 15 }));
          document.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 0, clientX: init.clientX + 30 }));
          // Later movement with the same pointer must not revive the cancelled press.
          document.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1, clientX: init.clientX + 40 }));
        }, started);
        check(!(await page.evaluate(() => 'dragging' in document.getElementById('dock')!.dataset)), `a buttonless return cancels a ${started ? 'started drag' : 'pending press'}`);
        check((await activeTab(page)) === 'whatsapp', 'a missed pointerup does not select the dragged service', await activeTab(page));
        check(await lowerDock(app, 'whatsapp'), 'a missed pointerup does not hold the dock open');
        await revealDock(app, page, 'whatsapp');
        await tab(page, 'discord').click();
        check((await poll(() => activeTab(page), (id) => id === 'discord', 3000)) === 'discord', 'a deliberate click after a missed pointerup still selects');
        await pressShortcut(app, page, 'dock', digit('whatsapp'));
      }
      await revealDock(app, page, 'whatsapp');

      // Escape cancels while the mouse is still held. Its later release still clicks the
      // captured button in Chromium, but must not select it, even after the next task.
      const cancelled = (await tab(page, 'discord').boundingBox())!;
      await page.mouse.move(cancelled.x + cancelled.width / 2, cancelled.y + cancelled.height / 2);
      await page.mouse.down();
      check(await tab(page, 'discord').evaluate((button) => button.hasPointerCapture(1)), 'the tab captures the pointer on press, before a drag starts');
      await page.mouse.move(cancelled.x + cancelled.width / 2 + 15, cancelled.y + cancelled.height / 2);
      check(await page.evaluate(() => 'dragging' in document.getElementById('dock')!.dataset), 'the Escape regression starts with an active drag');
      await page.keyboard.press('Escape');
      await sleep(100);
      check(!(await page.evaluate(() => 'dragging' in document.getElementById('dock')!.dataset)), 'Escape cancels the drag while the mouse is held');
      await page.mouse.up();
      await sleep(300);
      check((await activeTab(page)) === 'whatsapp', 'releasing after Escape does not select the dragged service', await activeTab(page));
      check((await tabOrder(page)) === 'inbox proton-mail discord whatsapp messenger streamroom', 'Escape leaves the service order unchanged');
      // Escape counts as keyboard use. Click empty dock space to return to pointer use
      // before checking that a stale drag hold cannot keep the dock open.
      await page.mouse.click(1, 1);
      check(await lowerDock(app, 'whatsapp'), 'Escape cancellation does not hold the dock open');
      await revealDock(app, page, 'whatsapp');
      await tab(page, 'discord').click();
      check((await poll(() => activeTab(page), (id) => id === 'discord', 3000)) === 'discord', 'a deliberate click after Escape and release still selects');
      await pressShortcut(app, page, 'dock', digit('whatsapp'));
      await revealDock(app, page, 'whatsapp');

      // Drag Discord along the dock, past WhatsApp.
      const from = (await tab(page, 'discord').boundingBox())!;
      const past = (await tab(page, 'whatsapp').boundingBox())!;
      const y = from.y + from.height / 2;
      await page.mouse.move(from.x + from.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 3, y);
      check(!(await page.evaluate(() => 'dragging' in document.getElementById('dock')!.dataset)), 'a press that moves 3px is not a drag yet');
      await page.mouse.move(past.x + past.width * 0.7, y, { steps: 8 });
      const mid = await page.evaluate(() => {
        const slot = document.querySelector<HTMLElement>('.tabs > .slot')!;
        const whatsapp = document.querySelector<HTMLElement>('.tab[data-id="whatsapp"]')!.parentElement!;
        return { dragging: 'dragging' in document.getElementById('dock')!.dataset, slot: !slot.hidden && slot.getBoundingClientRect().width > 0, whatsapp: whatsapp.style.transform };
      });
      check(mid.dragging && mid.slot && /^translateX\(-\d/.test(mid.whatsapp), 'dragging Discord past WhatsApp: a dashed slot shows where it lands and WhatsApp steps aside', JSON.stringify(mid));
      // The dock loses the pointer and the page reports it up and away: the drag holds the dock
      // up. (A synthetic mouseLeave would cancel the drag's pointer capture, which a real
      // pressed pointer keeps, so the dock page reports the pointer gone itself.)
      await page.evaluate(() => {
        const g = window as unknown as { __dragEnds: string[] };
        g.__dragEnds = [];
        for (const type of ['pointercancel', 'lostpointercapture', 'blur']) addEventListener(type, () => g.__dragEnds.push(type), true);
      });
      await page.evaluate(() => (window as unknown as { kainos: { reportPointer(over: boolean): void } }).kainos.reportPointer(false));
      await pointer(app, 'whatsapp', 'mouseMove', w / 2, h / 2);
      await sleep(1200);
      const held = await page.evaluate(() => ({ dragging: 'dragging' in document.getElementById('dock')!.dataset, ends: (window as unknown as { __dragEnds: string[] }).__dragEnds }));
      check(held.dragging && (await raisedDock(page)) && (await dockBounds(app)) !== null, 'while a tab is dragged, the floating dock stays up with the pointer off it and the page reporting it away', JSON.stringify(held));
      await screenshot(app, 'dock-order/1-dragging-dark');
      await page.mouse.move(past.x + past.width * 0.75, y);
      await page.mouse.up();
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp discord messenger streamroom', 3000)) === 'inbox proton-mail whatsapp discord messenger streamroom', 'dropping Discord after WhatsApp moves its tab there', await tabOrder(page));
      await sleep(300);
      check((await activeTab(page)) === 'whatsapp', 'dropping a tab does not select it', await activeTab(page));
      const savedOrder = () => (JSON.parse(readFileSync(stateFile, 'utf8')) as { serviceOrder?: string[] }).serviceOrder?.join(' ');
      check((await poll(async () => savedOrder(), (o) => o === 'inbox proton-mail whatsapp discord messenger streamroom gmail', 3000)) === 'inbox proton-mail whatsapp discord messenger streamroom gmail', '... and the new order is saved at once, Gmail (off) still last', savedOrder());
      check(/Discord moved to tab 4 of 6/.test(await announced(page)), '... and screen readers hear where it went', await announced(page));

      // A click with no movement still selects.
      await revealDock(app, page, 'whatsapp');
      await tab(page, 'messenger').click();
      check((await poll(() => activeTab(page), (id) => id === 'messenger', 3000)) === 'messenger' && (await tabOrder(page)) === 'inbox proton-mail whatsapp discord messenger streamroom', 'a click without movement still selects the service', await activeTab(page));

      // Ctrl+digits follow the dock as it is now.
      await pressShortcut(app, page, 'dock', 4);
      check((await activeTab(page)) === 'discord', 'after the move, Ctrl+4 opens Discord, the fourth tab', await activeTab(page));
      await pressShortcut(app, page, 'discord', 3);
      check((await activeTab(page)) === 'whatsapp', '... and Ctrl+3 WhatsApp', await activeTab(page));

      // Alt+Right and Alt+Left move the focused tab; plain arrows still only move focus.
      await revealDock(app, page, 'whatsapp');
      await tab(page, 'discord').focus();
      await page.keyboard.press('Alt+ArrowRight');
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp messenger discord streamroom', 3000)) === 'inbox proton-mail whatsapp messenger discord streamroom', 'Alt+Right moves the focused Discord tab one place right', await tabOrder(page));
      check((await dockFocus(page)) === 4, '... keeping keyboard focus on it', String(await dockFocus(page)));
      check(/Discord moved to tab 5 of 6/.test(await poll(() => announced(page), (t) => /tab 5 of 6/.test(t), 2000)), '... and says its new place to screen readers', await announced(page));
      await page.keyboard.press('Alt+ArrowRight');
      await poll(() => tabOrder(page), (o) => o.endsWith('streamroom discord'), 3000);
      await page.keyboard.press('Alt+ArrowRight');
      check(/already the last tab/.test(await poll(() => announced(page), (t) => /last tab/.test(t), 2000)), 'Alt+Right on the last tab says it is already last', await announced(page));
      await page.keyboard.press('Alt+ArrowLeft');
      await poll(() => tabOrder(page), (o) => o.endsWith('discord streamroom'), 3000);
      await page.keyboard.press('Alt+ArrowLeft');
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp discord messenger streamroom', 3000)) === 'inbox proton-mail whatsapp discord messenger streamroom', 'Alt+Left moves it back', await tabOrder(page));
      await page.keyboard.press('ArrowLeft');
      check((await dockFocus(page)) === 2 && (await tabOrder(page)) === 'inbox proton-mail whatsapp discord messenger streamroom', 'Left alone moves focus, not the tab', String(await dockFocus(page)));

      // Move left and right from the tab's menu.
      await tab(page, 'discord').click({ button: 'right' });
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Discord', 5000);
      check(JSON.stringify(await menuItems(app)) === '["Reload Discord","Hibernate","Unmute notifications","Move left","Move right","Hide from dock","Sign out of Discord…"]', "Discord's menu has Hibernate, Move left, Move right and Hide from dock", JSON.stringify(await menuItems(app)));
      await clickMenuItem(app, 'Move left');
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail discord whatsapp messenger streamroom', 3000)) === 'inbox proton-mail discord whatsapp messenger streamroom', 'Move left moves Discord one place left', await tabOrder(page));
      await tab(page, 'discord').click({ button: 'right' });
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Discord', 5000);
      await clickMenuItem(app, 'Move right');
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp discord messenger streamroom', 3000)) === 'inbox proton-mail whatsapp discord messenger streamroom', 'Move right moves it back', await tabOrder(page));
      await tab(page, 'inbox').click({ button: 'right' });
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Texts', 5000);
      check(JSON.stringify(await menuItems(app)) === '["Reload Texts","Mute notifications","(Move left)","Move right","Sign out of Texts…"]', 'the first tab cannot move left, and Texts cannot be hidden', JSON.stringify(await menuItems(app)));

      // Hide from dock: the active Messenger hands over to Discord before it, not to the
      // hibernating Streamroom after it.
      await tab(page, 'messenger').click();
      await poll(() => activeTab(page), (id) => id === 'messenger', 3000);
      await lowerDock(app, 'messenger');
      const full = (await revealDock(app, page, 'messenger'))!;
      await page.locator('#dock-options').click();
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Always show the dock', 5000);
      check(JSON.stringify(await menuItems(app)) === '["Always show the dock","(Hidden services)","Choose apps…","Theme"]', 'with nothing hidden, Hidden services is there but greyed out', JSON.stringify(await menuItems(app)));
      await tab(page, 'messenger').click({ button: 'right' });
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Messenger', 5000);
      await clickMenuItem(app, 'Hide from dock');
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp discord streamroom', 3000)) === 'inbox proton-mail whatsapp discord streamroom', 'Hide from dock takes the Messenger tab out', await tabOrder(page));
      check((await poll(() => activeTab(page), (id) => id === 'discord', 3000)) === 'discord', '... and, as Messenger was open, opens Discord, the awake tab before it', await activeTab(page));
      check((await status(page, 'streamroom')) === 'hibernated', '... leaving the hibernating Streamroom asleep', String(await status(page, 'streamroom')));
      check((await serviceUrl(app, 'messenger')).startsWith('https://'), '... while Messenger keeps running', await serviceUrl(app, 'messenger'));
      await revealDock(app, page, 'discord');
      const narrow = await poll(() => dockBounds(app), (b) => b !== null && b.width < full.width - 20, 3000);
      check(narrow !== null && narrow.width < full.width - 20 && Math.abs(narrow.x + narrow.width / 2 - w / 2) <= 1, 'the floating dock narrows to the five tabs left, still centred', `${full.width} → ${narrow?.width}`);
      // Off the islands, so no hover shows in the shot.
      await page.mouse.move(2, 2);
      await sleep(300);
      await screenshot(app, 'dock-order/2-messenger-hidden-dark');
      await pressShortcut(app, page, 'dock', 4);
      check((await activeTab(page)) === 'discord', 'with Messenger hidden, Ctrl+4 is Discord, the fourth tab', await activeTab(page));

      // Hidden services brings it back in its old place.
      await page.locator('#dock-options').click();
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Always show the dock', 5000);
      const hiddenItems = await submenuLabels(app, 'Hidden services');
      check(JSON.stringify(hiddenItems) === '["Show Messenger"]', 'Hidden services lists Messenger', JSON.stringify(hiddenItems));
      await clickMenuItem(app, 'Hidden services > Show Messenger');
      check((await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp discord messenger streamroom', 3000)) === 'inbox proton-mail whatsapp discord messenger streamroom', 'Show Messenger puts its tab back where it was', await tabOrder(page));
      await revealDock(app, page, 'discord');
      const widened = await poll(() => dockBounds(app), (b) => b !== null && Math.abs(b.width - full.width) <= 1, 3000);
      check(widened !== null && Math.abs(widened.width - full.width) <= 1, '... and the floating dock grows back to its full width (within a pixel of rounding)', `${widened?.width} (was ${full.width})`);

      // Hidden again for the second launch.
      await tab(page, 'messenger').click({ button: 'right' });
      await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Reload Messenger', 5000);
      await clickMenuItem(app, 'Hide from dock');
      await poll(() => tabOrder(page), (o) => o === 'inbox proton-mail whatsapp discord streamroom', 3000);

      await toggleAlways();
      await pickTheme(app, page, 'Carbon');
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'system';
      });
      await page.emulateMedia({ colorScheme: null });
      await app.evaluate(({ BaseWindow }, [w1, h1]) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.setContentSize(w1!, h1!), [w0, h0]);
      await sleep(500);
    }

    // With a tray host, closing the window hides it to the tray instead of quitting.
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.close());
    const hidden = await poll(() => app.evaluate(({ BaseWindow }) => !BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.isVisible()), Boolean, 5000);
    check(hidden, 'with a tray host, closing the window hides it to the tray');
    check(bus!.trayItems.length > 0, 'the tray icon registers with the tray host', bus!.trayItems.join('; '));

    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!;
      win.show();
      win.setBounds({ x: 120, y: 90, width: 1100, height: 720 });
    });
    check((await pressShortcut(app, page, 'dock', digit('proton-mail'))) === nth('proton-mail'), `Ctrl+${digit('proton-mail')} switches back to Proton Mail before quitting`);
    await sleep(800);
    await sendKey(app, 'dock', 'Q', ['control']);
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
  check(saved.theme === 'carbon', 'saves the picked theme', String(saved.theme));
  check(JSON.stringify(saved.serviceOrder) === '["inbox","proton-mail","whatsapp","discord","messenger","streamroom","gmail"]' && JSON.stringify(saved.hiddenServiceIds) === '["messenger"]', 'saves the dock order and the hidden Messenger', JSON.stringify({ serviceOrder: saved.serviceOrder, hiddenServiceIds: saved.hiddenServiceIds }));
  check(JSON.stringify(saved.hibernatedServiceIds) === '["streamroom"]', 'saves Streamroom as hibernating', JSON.stringify(saved.hibernatedServiceIds));
  check(saved.dockAlwaysShown === true && !('dockAlign' in saved) && !('barSide' in saved) && !('barAutoHide' in saved), 'saves Always show the dock, and nothing of the old alignment or side bar', JSON.stringify({ dockAlwaysShown: saved.dockAlwaysShown, dockAlign: saved.dockAlign, barSide: saved.barSide }));

  // Second launch, then the tray host goes away (a desktop with no tray): closing quits.
  // The host is only switched off after launch: without one at startup, Electron's tray falls
  // back to GTK, which crashes with no display. The app asks the session again at close time.
  app = await launch(profile);
  try {
    const page = await dockPage(app);
    bus!.setTrayHost(false);
    check((await activeIndex(page)) === nth('proton-mail'), 'second launch opens on Proton Mail');
    check((await tabOrder(page)) === 'inbox proton-mail whatsapp discord streamroom', 'second launch keeps the dragged order, with Messenger still hidden', await tabOrder(page));
    check((await status(page, 'streamroom')) === 'hibernated', 'second launch keeps Streamroom hibernating', String(await status(page, 'streamroom')));
    await stubMenusAndDialogs(app);
    await poll(() => status(page, 'proton-mail'), (value) => value === 'ready', 60_000);
    const [w, h] = await contentSize(app);
    const kept = await poll(() => dockBounds(app), (b) => b?.height === DOCK, 5000);
    check(JSON.stringify(kept) === JSON.stringify({ x: 0, y: h - DOCK, width: w, height: DOCK }), 'second launch keeps the dock shown in its strip', JSON.stringify(kept));
    const relaunched = await poll(() => themeAttributes(app, page), (t) => t === 'dock carbon, texts carbon', 5000);
    check(relaunched === 'dock carbon, texts carbon', 'second launch keeps Carbon on the dock and the Texts page', relaunched);
    const relaunchedBackground = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.getBackgroundColor().toLowerCase());
    check(relaunchedBackground === '#000000', "... and paints the window in Carbon's black from the start", relaunchedBackground);
    await page.locator('#dock-options').click();
    await poll(() => menus(app), (all) => all.at(-1)?.labels[0] === 'Always show the dock', 5000);
    await clickMenuItem(app, 'Always show the dock');
    await pointer(app, 'dock', 'mouseLeave', 0, 0);
    await pointer(app, 'proton-mail', 'mouseMove', w / 2, h / 2);
    const gone = await poll(() => dockBounds(app), (b) => b === null, 3000);
    check(gone === null && (await viewBounds(app, 'proton-mail')).height === h, 'switching it off again hides the dock and gives the page the whole window');
    const bounds = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.getBounds());
    check(bounds.width === 1100 && bounds.height === 720, 'second launch restores the window size', JSON.stringify(bounds));
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!.close()).catch(() => undefined);
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
