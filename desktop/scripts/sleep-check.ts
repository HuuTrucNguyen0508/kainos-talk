// Checks that In the background's Sleep really puts pages to sleep, from inside a page, on this
// platform: Windows in CI, Linux on a desktop session. Playwright cannot (it keeps every page it
// drives visible and at full speed), so this talks plain DevTools: the pages over
// --remote-debugging-port, the main process over --inspect.
//
// Streamroom is pointed at a test page served here, which counts its animation frames, its timer
// ticks and the messages the server pushes. Then: Streamroom in the background sleeps and still
// gets messages at once; opened, it is drawn; the window minimised, it sleeps; on Windows, the
// window covered by another, it sleeps.
//
//   node scripts/sleep-check.ts [path to kainos-talk(.exe)]   (from desktop/; default: this checkout's build)
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from '../src/shared/services.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const SLEEP_AFTER = 3000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const failures: string[] = [];
function check(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
  if (!ok) failures.push(label);
}

// The test page, and the stream of messages it listens to.
const listeners = new Set<ServerResponse>();
const server = createServer((request, response) => {
  if (request.url === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(':open\n\n');
    listeners.add(response);
    request.on('close', () => listeners.delete(response));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Sleep check</title>
<style>div{width:120px;height:120px;background:#c33;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}</style><div></div>
<script>
  window.frames_ = 0; window.ticks = 0; window.lag = -1;
  (function frame() { window.frames_++; requestAnimationFrame(frame); })();
  setInterval(() => window.ticks++, 100);
  new EventSource('/events').onmessage = (event) => { window.lag = Date.now() - Number(event.data); };
</script>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const room = `http://localhost:${port}`;

// A profile with Texts open and Streamroom in the background, set to sleep (not hibernate).
const profile = mkdtempSync(join(tmpdir(), 'kainos-sleep-check-'));
const ids = SERVICES.map((service) => service.id);
writeFileSync(
  join(profile, 'kainos-state.json'),
  JSON.stringify({
    activeServiceId: 'inbox',
    serviceOrder: ids,
    enabledServiceIds: ['inbox', 'streamroom'],
    welcomed: true,
    hibernatedServiceIds: [],
    awayModes: { streamroom: 'sleep' },
    streamroom: { current: room, localPort: port },
  }),
);

const pagesPort = 9300 + Math.floor(Math.random() * 300);
const mainPort = pagesPort + 400;
const exe = process.argv[2];
const command = exe ?? (createRequire(import.meta.url)('electron') as unknown as string);
const args = [`--remote-debugging-port=${pagesPort}`, `--inspect=${mainPort}`, ...(exe ? [] : [desktop])];
const app = spawn(command, args, {
  env: {
    ...process.env,
    KAINOS_USER_DATA: profile,
    KAINOS_BLOCK_EXTERNAL: '1',
    KAINOS_SYNC_MDNS: '0',
    KAINOS_SYNC_PORT: String(49_600 + Math.floor(Math.random() * 300)),
    KAINOS_SLEEP_AFTER_MS: String(SLEEP_AFTER),
    KAINOS_HIBERNATE_AFTER_MS: String(60 * 60_000),
  },
  stdio: 'ignore',
});

/** A DevTools connection: send a method, get its result. */
async function devtools(url: string): Promise<{ call(method: string, params?: object): Promise<any>; close(): void }> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const waiting = new Map<number, (message: any) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}
async function targets(port: number): Promise<{ url: string; webSocketDebuggerUrl: string }[]> {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { url: string; webSocketDebuggerUrl: string }[];
  } catch {
    return [];
  }
}
async function find(port: number, match: (url: string) => boolean, what: string) {
  for (let i = 0; i < 120; i++) {
    const target = (await targets(port)).find((t) => match(t.url));
    if (target) return devtools(target.webSocketDebuggerUrl);
    await sleep(500);
  }
  throw new Error(`${what} never showed up`);
}
const evaluate = async (connection: Awaited<ReturnType<typeof devtools>>, expression: string) =>
  (await connection.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

try {
  const main = await find(mainPort, () => true, 'The main process');
  const inMain = (code: string) => evaluate(main, `(() => { const { BaseWindow } = process.mainModule.require('electron'); const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0); ${code} })()`);
  const dock = await find(pagesPort, (url) => url.endsWith('/renderer/index.html'), 'The dock page');
  const page = await find(pagesPort, (url) => url.startsWith(room), 'Streamroom');

  /** The page's visibility, and its frames and timer ticks per second over two seconds. */
  const measure = async () => {
    const before = await evaluate(page, '[frames_, ticks]');
    await sleep(2000);
    const after = await evaluate(page, '[document.visibilityState, frames_, ticks]');
    return { seen: after[0] as string, frames: (after[1] - before[0]) / 2, ticks: (after[2] - before[1]) / 2 };
  };
  const show = (m: { seen: string; frames: number; ticks: number }) => `${m.seen}, ${m.frames} frames/s, ${m.ticks} ticks/s`;
  const asleep = (m: { seen: string; frames: number; ticks: number }) => m.seen === 'hidden' && m.frames === 0 && m.ticks <= 2;
  const awake = (m: { seen: string; frames: number; ticks: number }) => m.seen === 'visible' && m.frames > 10 && m.ticks >= 8;
  const until = async (done: (m: { seen: string; frames: number; ticks: number }) => boolean, tries = 6) => {
    let m = await measure();
    for (let i = 1; i < tries && !done(m); i++) m = await measure();
    return m;
  };

  console.log(`${process.platform}, ${exe ?? 'this checkout'}`);
  await sleep(SLEEP_AFTER + 1000);
  const background = await until(asleep);
  check(asleep(background), 'Streamroom in the background sleeps: hidden, no frames, timers once a second', show(background));
  for (const listener of listeners) listener.write(`data: ${Date.now()}\n\n`);
  await sleep(1000);
  const lag = await evaluate(page, 'lag');
  check(lag >= 0 && lag < 500, '... and still gets a pushed message at once', `${lag} ms`);

  await evaluate(dock, `document.querySelector('.tab[data-id="streamroom"]').click(); 0`);
  const opened = await until(awake);
  check(awake(opened), 'opened, it is drawn at full speed', show(opened));

  await inMain('win.minimize(); return 0;');
  const minimised = await until(asleep);
  check(asleep(minimised), 'the window minimised, the open tab sleeps', show(minimised));
  await inMain('win.restore(); win.show(); return 0;');
  const restored = await until(awake);
  check(awake(restored), '... and is drawn again when the window comes back', show(restored));

  // Another window over the whole of Kainos Talk. Windows tells Chromium the window is covered;
  // Linux compositors do not, so there it is only reported.
  await inMain(`const b = win.getBounds(); globalThis.__cover = new BaseWindow({ ...b, x: b.x - 20, y: b.y - 20, width: b.width + 40, height: b.height + 40, frame: false, alwaysOnTop: true, backgroundColor: '#202020' }); globalThis.__cover.show(); return 0;`);
  const covered = await until(asleep);
  if (process.platform === 'win32') check(asleep(covered), 'the window covered by another, the open tab sleeps', show(covered));
  else console.log(`INFO  the window covered by another: ${show(covered)} (only Windows and macOS report covered windows)`);
  await inMain('globalThis.__cover.close(); win.focus(); return 0;');
  const uncovered = await until(awake);
  check(awake(uncovered), '... and is drawn again once uncovered', show(uncovered));
  main.close();
  dock.close();
  page.close();
} catch (error) {
  console.error(error);
  failures.push(String(error));
} finally {
  app.kill();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  server.close();
  for (const listener of listeners) listener.end();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll sleep checks passed.');
process.exit(failures.length ? 1 : 0);
