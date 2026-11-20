import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVICES, canHibernate, findService, partitionFor } from './services.ts';

test('registry has the inbox and six websites, with unique ids and secure start pages', () => {
  assert.deepEqual(SERVICES.map((s) => s.id), ['inbox', 'proton-mail', 'discord', 'whatsapp', 'messenger', 'streamroom', 'gmail']);
  for (const service of SERVICES.filter((s) => !s.localPage)) {
    const start = new URL(service.url);
    // Streamroom starts on a server on this computer, which browsers treat as secure.
    assert.equal(start.protocol, service.id === 'streamroom' ? 'http:' : 'https:');
    assert.ok(service.hosts.includes(start.hostname), `${service.id} start page must be one of its hosts`);
  }
});

test('the phone texts page is the Texts service, drawn as a line icon among filled brand logos', () => {
  const texts = SERVICES[0]!;
  assert.deepEqual({ id: texts.id, name: texts.name, localPage: texts.localPage, paint: texts.icon.paint }, { id: 'inbox', name: 'Texts', localPage: 'inbox', paint: 'stroke' });
  assert.deepEqual(SERVICES.slice(1, 5).map((s) => s.icon.paint), ['fill', 'fill', 'fill', 'fill']);
});

test('Streamroom, which has no brand logo to borrow, is a line icon; it alone claims its links and starts hibernated', () => {
  const room = findService('streamroom')!;
  assert.equal(room.icon.paint, 'stroke');
  assert.deepEqual(SERVICES.filter((s) => s.calls).map((s) => s.id), ['messenger', 'streamroom']);
  // Messenger alone opens its calls in a blank window of their own.
  assert.deepEqual(SERVICES.filter((s) => s.callWindow).map((s) => s.id), ['messenger']);
  assert.deepEqual(SERVICES.filter((s) => s.claimsLinks).map((s) => s.id), ['streamroom']);
  assert.deepEqual(SERVICES.filter((s) => s.startsHibernated).map((s) => s.id), ['streamroom']);
});

test('every website can hibernate; Texts, kept in the app itself, cannot', () => {
  assert.deepEqual(SERVICES.filter((s) => !canHibernate(s)).map((s) => s.id), ['inbox']);
});

test('each service gets its own persistent login partition', () => {
  const partitions = SERVICES.map(partitionFor);
  assert.deepEqual(partitions, [
    'persist:service-inbox',
    'persist:service-proton-mail',
    'persist:service-discord',
    'persist:service-whatsapp',
    'persist:service-messenger',
    'persist:service-streamroom',
    'persist:service-gmail',
  ]);
});

test('tile colours keep white glyphs at 3:1 contrast or better', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const service of SERVICES) {
    const ratio = 1.05 / (luminance(service.icon.color) + 0.05);
    assert.ok(ratio >= 3, `${service.id} contrast ${ratio.toFixed(2)}`);
  }
});

test('Gmail is opt-in: an update never turns it on; it signs in to Google as Firefox and owns its sign-in hosts', () => {
  const gmail = findService('gmail')!;
  assert.deepEqual(SERVICES.filter((s) => s.optIn).map((s) => s.id), ['gmail']);
  assert.deepEqual(SERVICES.filter((s) => s.googleSignIn).map((s) => s.id), ['gmail']);
  assert.ok(gmail.hosts.includes('accounts.google.com') && gmail.hosts.includes('mail.google.com'));
  assert.deepEqual(gmail.unread('Inbox (12) - someone@gmail.com - Gmail'), { kind: 'count', count: 12 });
  assert.deepEqual(gmail.unread('Inbox - someone@gmail.com - Gmail'), { kind: 'none' });
  assert.deepEqual(gmail.unread('Sent Mail - someone@gmail.com - Gmail'), { kind: 'none' });
});

test('every service says in one line what it is, for Choose your apps', () => {
  for (const service of SERVICES) assert.ok(service.about.length > 10 && service.about.length < 90, service.id);
});
