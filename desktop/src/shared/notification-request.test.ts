import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findService } from './services.ts';
import { iconAllowed, parseNotificationRequest } from './notification-request.ts';

test('keeps the fields the app uses, with page strings cut to size', () => {
  assert.deepEqual(
    parseNotificationRequest({ id: 7, title: 'Alice', body: 'hi', icon: 'https://cdn.discordapp.com/a.png', tag: 'chat-1', silent: true, extra: 1 }),
    { id: 7, title: 'Alice', body: 'hi', icon: 'https://cdn.discordapp.com/a.png', tag: 'chat-1', silent: true },
  );
  const long = parseNotificationRequest({ id: 1, title: 't'.repeat(300), body: 'b'.repeat(2000), tag: 'g'.repeat(300) })!;
  assert.equal(long.title.length, 256);
  assert.equal(long.body.length, 1024);
  assert.equal(long.tag.length, 256);
  assert.deepEqual(parseNotificationRequest({ id: 2, title: 'x' }), { id: 2, title: 'x', body: '', icon: '', tag: '', silent: false });
});

test('rejects payloads without a safe integer id or a string title', () => {
  for (const raw of [null, undefined, 'x', 5, [], { title: 'x' }, { id: 1.5, title: 'x' }, { id: 2 ** 60, title: 'x' }, { id: '1', title: 'x' }, { id: 1, title: 3 }]) {
    assert.equal(parseNotificationRequest(raw), undefined, JSON.stringify(raw) ?? String(raw));
  }
});

test('only https icon URLs survive parsing', () => {
  for (const icon of ['http://example.com/a.png', 'file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:https://discord.com/x', 'not a url']) {
    assert.equal(parseNotificationRequest({ id: 1, title: 'x', icon })!.icon, '', icon);
  }
  assert.equal(parseNotificationRequest({ id: 1, title: 'x', icon: `https://a.example/${'x'.repeat(3000)}` })!.icon, '');
  assert.equal(parseNotificationRequest({ id: 1, title: 'x', silent: 'yes' })!.silent, false);
});

test("icons load only from each service's own image hosts", () => {
  const discord = findService('discord')!.iconHosts;
  const whatsapp = findService('whatsapp')!.iconHosts;
  const proton = findService('proton-mail')!.iconHosts;
  assert.equal(iconAllowed(discord, 'https://cdn.discordapp.com/avatars/1/2.webp?size=128'), true);
  assert.equal(iconAllowed(discord, 'https://discord.com/assets/icon.png'), true);
  assert.equal(iconAllowed(discord, 'https://evil.example/cdn.discordapp.com.png'), false);
  assert.equal(iconAllowed(discord, 'https://cdn.discordapp.com.evil.example/a.png'), false);
  assert.equal(iconAllowed(discord, 'http://cdn.discordapp.com/a.png'), false);
  assert.equal(iconAllowed(discord, 'https://pps.whatsapp.net/v/t61/x.jpg'), false);
  assert.equal(iconAllowed(whatsapp, 'https://pps.whatsapp.net/v/t61/x.jpg'), true);
  assert.equal(iconAllowed(proton, 'https://mail.proton.me/assets/favicon.png'), true);
  assert.equal(iconAllowed(proton, 'https://192.168.1.1/a.png'), false);
  assert.equal(iconAllowed(proton, ''), false);
});
