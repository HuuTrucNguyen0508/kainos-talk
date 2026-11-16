import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServiceSnapshot } from '../shared/ipc.ts';
import { describe as describeService } from './describe.ts';

const base: ServiceSnapshot = { id: 'discord', name: 'Discord', color: '#5865F2', glyph: '', paint: 'fill', host: 'discord.com', status: { kind: 'ready' }, unread: { kind: 'none' }, muted: false };

test('names the service and every state a sighted user sees on its tile', () => {
  assert.equal(describeService(base), 'Discord');
  assert.equal(describeService({ ...base, unread: { kind: 'count', count: 4 } }), 'Discord, 4 unread');
  assert.equal(describeService({ ...base, unread: { kind: 'marker' }, muted: true }), 'Discord, new activity, notifications muted');
  assert.equal(describeService({ ...base, status: { kind: 'loading' } }), 'Discord, loading');
  assert.equal(describeService({ ...base, status: { kind: 'hibernated' }, muted: true }), 'Discord, hibernating, opens when selected, notifications muted');
  assert.equal(
    describeService({ ...base, status: { kind: 'failed', reason: 'x', host: 'discord.com' }, unread: { kind: 'count', count: 2 }, muted: true }),
    'Discord, 2 unread, failed to load, notifications muted',
  );
});

test('Texts says when the phone is not connected', () => {
  assert.equal(describeService({ ...base, id: 'inbox', name: 'Texts', host: '', unread: { kind: 'count', count: 3 } }, true), 'Texts, 3 unread, phone not connected');
});
