import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findService } from '../shared/services.ts';
import { withServers } from '../shared/streamroom.ts';
import { allowPermission } from './permissions.ts';

const discord = findService('discord')!;
const ask = (permission: string, origin = 'https://discord.com', mediaTypes: string[] = []) => allowPermission(discord, { permission, origin, mediaTypes });

test('allows notifications and calls for the service itself', () => {
  assert.equal(ask('notifications'), true);
  assert.equal(ask('media', 'https://discord.com/channels/1', ['audio']), true);
  assert.equal(ask('media', 'https://discord.com', ['audio', 'video']), true);
});

test('allows copy, fullscreen and persistent storage for the service itself', () => {
  assert.equal(ask('clipboard-sanitized-write'), true);
  assert.equal(ask('fullscreen', 'https://discord.com/channels/1/2'), true);
  assert.equal(ask('persistent-storage'), true);
});

test('those three are still denied to any other origin', () => {
  for (const permission of ['clipboard-sanitized-write', 'fullscreen', 'persistent-storage']) {
    assert.equal(ask(permission, 'https://newassets.hcaptcha.com'), false, permission);
    assert.equal(ask(permission, 'http://discord.com'), false, permission);
  }
});

test('denies other origins, other permissions and unknown media types', () => {
  assert.equal(ask('media', 'https://newassets.hcaptcha.com', ['video']), false);
  assert.equal(ask('notifications', 'http://discord.com'), false);
  assert.equal(ask('media', 'https://discord.com', ['screen']), false);
  for (const permission of ['geolocation', 'clipboard-read', 'automatic-fullscreen', 'display-capture', 'midi', 'openExternal', 'hid']) {
    assert.equal(ask(permission), false, permission);
  }
  assert.equal(ask('notifications', ''), false);
});

const room = withServers(findService('streamroom')!, { current: 'https://rooms.example.org', saved: ['https://rooms.example.org'], localPort: 8080 });
const askRoom = (permission: string, origin = 'https://rooms.example.org') => allowPermission(room, { permission, origin, mediaTypes: [] });

test('a call app may also share the screen and pick the speaker, on its own pages only', () => {
  assert.equal(askRoom('display-capture'), true);
  assert.equal(askRoom('speaker-selection'), true);
  assert.equal(allowPermission(room, { permission: 'media', origin: 'https://rooms.example.org/r/abc', mediaTypes: ['audio'] }), true);
  assert.equal(askRoom('display-capture', 'https://evil.workers.dev'), false);
  assert.equal(askRoom('display-capture', 'http://rooms.example.org'), false);
  for (const permission of ['geolocation', 'clipboard-read', 'midi', 'hid']) assert.equal(askRoom(permission), false, permission);
});

test('Streamroom on this PC gets the same permissions over plain http, and only there', () => {
  const local = findService('streamroom')!;
  const ask = (origin: string, permission = 'display-capture') => allowPermission(local, { permission, origin, mediaTypes: [] });
  assert.equal(ask('http://localhost:8080'), true);
  assert.equal(ask('http://localhost:8080', 'speaker-selection'), true);
  assert.equal(ask('http://192.168.1.20:8080'), false, 'a LAN address is not this PC');
  assert.equal(ask('http://localhost.evil.com:8080'), false);
  assert.equal(allowPermission(findService('discord')!, { permission: 'notifications', origin: 'http://localhost', mediaTypes: [] }), false);
});
