import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync, transformSync } from 'esbuild';

function harness() {
  return runInNewContext(`(() => {
    const mainListeners = new Map(), pageListeners = new Map(), natives = [], requests = [];
    let release, destroyed = false;
    const loading = new Promise(resolve => release = resolve);
    class NativeNotification extends EventTarget {
      static isSupported() { return true; }
      constructor() { super(); natives.push(this); }
      on(type, callback) { this.addEventListener(type, callback); }
      close() { this.dispatchEvent(new Event('close')); }
      show() { this.shown = true; }
    }
    const contents = { id: 1, session: { fetch: async () => {
      requests.push(1); await loading;
      return new Response(new Uint8Array([1]));
    } }, isDestroyed: () => destroyed, send: (channel, id) => pageListeners.get(channel)?.({}, id) };
    let muted = false;
    const electron = {
      Notification: NativeNotification,
      app: { emit() {} },
      ipcMain: { on: (channel, callback) => mainListeners.set(channel, callback) },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
      ipcRenderer: {
        on: (channel, callback) => pageListeners.set(channel, callback),
        send: (channel, payload) => queueMicrotask(() => mainListeners.get(channel)?.({ sender: contents }, payload)),
      },
      contextBridge: { executeInMainWorld: ({ func, args }) => func(...args) },
    };
    const { contextBridge, ipcRenderer } = electron;
    const require = () => electron;
    const module = { exports: {} };
    ${buildSync({entryPoints: [fileURLToPath(new URL('./notifications.ts', import.meta.url))], bundle:true, write:false, platform:'node', format:'cjs', external:['electron']}).outputFiles[0]!.text}
    module.exports.forwardNotifications({ runtimeFor: () => ({ service: { id: 'test', iconHosts: ['example.org'] } }), isMuted: () => muted, fallbackIcon: {}, focusService() {} });
    ${transformSync(readFileSync(new URL('../preload/service.ts', import.meta.url), 'utf8').split('/** Main passes')[0]!.replace(/^import .*;$/gm, '').replace("import type { CounterReading } from '../shared/unread.ts';", ''), {loader:'ts'}).code}
    return { create: (options = {}) => new window.Notification('hello', options), live: () => window.Notification.live.size,
      dismiss: () => natives.at(-1).close(), release, requests, natives, mute: () => muted = true, destroy: () => destroyed = true };
  })()`, {
    EventTarget, Event, URL, queueMicrotask, Response, Uint8Array, Buffer, AbortSignal,
    window: { Notification: { permission: 'granted' } }, location: { href: 'https://example.org/' },
    Channel: { notificationShow:'show', notificationClick:'click', notificationClose:'close' },
  });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native dismissal, tag replacement, muted rejection and close during icon loading release the shim', async () => {
  const h = harness();
  let closed = 0;
  for (let i = 0; i < 1000; i++) {
    h.create({ tag: 'same-chat' }).onclose = () => closed++;
  }
  await tick();
  assert.equal(h.live(), 1);
  assert.equal(closed, 999);
  h.dismiss();
  assert.equal(h.live(), 0);
  assert.equal(closed, 1000);
  h.mute(); h.create(); await tick();
  assert.equal(h.live(), 0);
  const pending = harness();
  pending.create({ icon:'https://example.org/avatar' }).close();
  pending.release(); await tick();
  assert.equal(pending.live(), 0);
  assert.equal(pending.natives.length, 1);
  assert.equal(pending.natives[0].shown, undefined);
});

test('twenty notifications share one avatar fetch and decoded icon', async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) h.create({ icon:'https://example.org/avatar' });
  await tick();
  assert.equal(h.requests.length, 1);
  h.release(); await tick();
  h.create({ icon:'https://example.org/avatar' }); await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.natives.length, 21);
});

test('a page closed while its icon loads (its service hibernated) shows no notification', async () => {
  const h = harness();
  h.create({ icon: 'https://example.org/avatar' });
  await tick();
  h.destroy();
  h.release(); await tick();
  assert.equal(h.natives.length, 0);
});
