import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findService } from '../shared/services.ts';
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
