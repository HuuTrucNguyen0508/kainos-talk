import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServiceStatus } from '../shared/ipc.ts';
import { nextStatus, type PageEvent } from './service-status.ts';

const loading: ServiceStatus = { kind: 'loading' };
const ready: ServiceStatus = { kind: 'ready' };
const failed: ServiceStatus = { kind: 'failed', reason: 'ERR_NAME_NOT_RESOLVED', host: 'x.invalid' };
const run = (start: ServiceStatus, ...events: PageEvent[]) => events.reduce(nextStatus, start);
const nav = (url: string, more: Partial<Extract<PageEvent, { kind: 'start-navigation' }>> = {}): PageEvent => ({
  kind: 'start-navigation', url, isMainFrame: true, isSameDocument: false, ...more,
});

test('a page load goes loading, then ready at dom-ready or when loading stops', () => {
  assert.deepEqual(run(ready, nav('https://discord.com/app')), loading);
  assert.deepEqual(run(loading, { kind: 'dom-ready' }), ready);
  assert.deepEqual(run(loading, { kind: 'stop-loading' }), ready);
  assert.deepEqual(run(failed, { kind: 'restart' }), loading);
});

test('in-page and subframe navigations, and error pages, do not count as loading', () => {
  assert.deepEqual(run(ready, nav('https://discord.com/app#x', { isSameDocument: true })), ready);
  assert.deepEqual(run(ready, nav('https://discord.com/embed', { isMainFrame: false })), ready);
  assert.deepEqual(run(failed, nav('chrome-error://chromewebdata/')), failed);
});

test('a failed main-frame load fails with its host; cancelled loads do not', () => {
  const fail = (code: number, isMainFrame = true): PageEvent => ({ kind: 'fail-load', code, description: 'ERR_X', url: 'https://kainos-smoke.invalid/a', isMainFrame });
  assert.deepEqual(run(loading, fail(-105)), { kind: 'failed', reason: 'ERR_X', host: 'kainos-smoke.invalid' });
  assert.deepEqual(run(loading, fail(-3)), loading);
  assert.deepEqual(run(ready, fail(-105, false)), ready);
  // Once failed, dom-ready or stop-loading of the error page leave it failed.
  assert.deepEqual(run(loading, fail(-105), { kind: 'dom-ready' }, { kind: 'stop-loading' }), { kind: 'failed', reason: 'ERR_X', host: 'kainos-smoke.invalid' });
});

test('a crashed page fails, a clean exit does not', () => {
  assert.deepEqual(run(ready, { kind: 'gone', reason: 'crashed', host: 'web.whatsapp.com' }), { kind: 'failed', reason: 'page stopped (crashed)', host: 'web.whatsapp.com' });
  assert.deepEqual(run(ready, { kind: 'gone', reason: 'clean-exit', host: 'web.whatsapp.com' }), ready);
});

test('an unchanged status is the same object, so callers can skip a redraw', () => {
  assert.equal(nextStatus(ready, { kind: 'dom-ready' }), ready);
  assert.equal(nextStatus(loading, nav('https://discord.com/x')), loading);
});
