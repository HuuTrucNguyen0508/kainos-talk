import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findService } from './services.ts';
import { parseCounterReading, totalUnread, unreadFromPage, unreadFromTitlePrefix, unreadLabel, windowTitle } from './unread.ts';

test('reads counts from real service titles', () => {
  const cases: [string, string, unknown][] = [
    ['whatsapp', '(3) WhatsApp', { kind: 'count', count: 3 }],
    ['whatsapp', 'WhatsApp', { kind: 'none' }],
    ['discord', '(12) Discord | #general | Kainos', { kind: 'count', count: 12 }],
    ['discord', '• Discord | #general | Kainos', { kind: 'marker' }],
    ['discord', 'Discord | Friends', { kind: 'none' }],
    ['proton-mail', '(7) Inbox | someone@proton.me | Proton Mail', { kind: 'count', count: 7 }],
    ['proton-mail', 'Inbox | someone@proton.me | Proton Mail', { kind: 'none' }],
    ['proton-mail', 'Proton Account', { kind: 'none' }],
  ];
  for (const [id, title, expected] of cases) {
    assert.deepEqual(findService(id)!.unread(title), expected, `${id}: ${title}`);
  }
});

test('ignores zero counts and numbers that are not a prefix', () => {
  assert.deepEqual(unreadFromTitlePrefix('(0) WhatsApp'), { kind: 'none' });
  assert.deepEqual(unreadFromTitlePrefix('Meeting at (3) pm'), { kind: 'none' });
  assert.deepEqual(unreadFromTitlePrefix('  (4) Inbox'), { kind: 'count', count: 4 });
});

test('totals counts, and falls back to a marker only when nothing is counted', () => {
  assert.deepEqual(totalUnread([{ kind: 'count', count: 2 }, { kind: 'marker' }, { kind: 'count', count: 5 }]), { kind: 'count', count: 7 });
  assert.deepEqual(totalUnread([{ kind: 'none' }, { kind: 'marker' }]), { kind: 'marker' });
  assert.deepEqual(totalUnread([{ kind: 'none' }]), { kind: 'none' });
  assert.deepEqual(totalUnread([]), { kind: 'none' });
});

test('labels badges and the window title', () => {
  assert.equal(unreadLabel({ kind: 'count', count: 150 }), '99+');
  assert.equal(windowTitle('Kainos Talk', { kind: 'count', count: 4 }), '(4) Kainos Talk');
  assert.equal(windowTitle('Kainos Talk', { kind: 'marker' }), '(•) Kainos Talk');
  assert.equal(windowTitle('Kainos Talk', { kind: 'none' }), 'Kainos Talk');
});

test('reads capped and separated counts', () => {
  // "(99+)" means more than 99, counted as 100 so the badge still says "99+".
  assert.deepEqual(unreadFromTitlePrefix('(99+) Discord'), { kind: 'count', count: 100 });
  assert.deepEqual(unreadFromTitlePrefix('(9+) WhatsApp'), { kind: 'count', count: 10 });
  assert.deepEqual(unreadFromTitlePrefix('(1,234) Inbox | Proton Mail'), { kind: 'count', count: 1234 });
  assert.deepEqual(unreadFromTitlePrefix('(1.234) Inbox'), { kind: 'count', count: 1234 });
  assert.deepEqual(unreadFromTitlePrefix('(1 234) Inbox'), { kind: 'count', count: 1234 });
  assert.deepEqual(unreadFromTitlePrefix('(1 234) Inbox'), { kind: 'count', count: 1234 });
  assert.deepEqual(unreadFromTitlePrefix('(1234567) Inbox'), { kind: 'count', count: 1234567 });
  assert.equal(unreadLabel(unreadFromTitlePrefix('(99+) Discord')), '99+');
});

test('rejects malformed counts', () => {
  assert.deepEqual(unreadFromTitlePrefix('(1,23) Inbox'), { kind: 'none' });
  assert.deepEqual(unreadFromTitlePrefix('(,5) Inbox'), { kind: 'none' });
  assert.deepEqual(unreadFromTitlePrefix('(+) Inbox'), { kind: 'none' });
  assert.deepEqual(unreadFromTitlePrefix('(0+) Inbox'), { kind: 'count', count: 1 });
});

test('a page counter wins over the title while its scope is on the page', () => {
  const title = { kind: 'count', count: 3 } as const;
  assert.deepEqual(unreadFromPage(title, { scope: true, text: '7' }), { kind: 'count', count: 7 });
  assert.deepEqual(unreadFromPage(title, { scope: true, text: ' 1,204 ' }), { kind: 'count', count: 1204 });
  assert.deepEqual(unreadFromPage(title, { scope: true, text: '99+' }), { kind: 'count', count: 100 });
  // The scope is there but its counter is not: nothing unread there, whatever the title says.
  assert.deepEqual(unreadFromPage(title, { scope: true, text: null }), { kind: 'none' });
  assert.deepEqual(unreadFromPage(title, { scope: true, text: '0' }), { kind: 'none' });
  assert.deepEqual(unreadFromPage(title, { scope: true, text: 'new' }), { kind: 'none' });
});

test('without the page counter the title decides', () => {
  const title = { kind: 'count', count: 3 } as const;
  assert.deepEqual(unreadFromPage(title, undefined), { kind: 'count', count: 3 });
  assert.deepEqual(unreadFromPage(title, { scope: false, text: null }), { kind: 'count', count: 3 });
  assert.deepEqual(unreadFromPage({ kind: 'marker' }, { scope: false, text: '5' }), { kind: 'marker' });
});

test('Proton reads its Inbox counter; the others have none', () => {
  assert.deepEqual(findService('proton-mail')!.unreadCounter, {
    scope: '[data-testid="navigation-link:inbox"]',
    count: '[data-testid="navigation-link:inbox"] [data-testid="navigation-link:unread-count"]',
  });
  assert.equal(findService('discord')!.unreadCounter, undefined);
  assert.equal(findService('whatsapp')!.unreadCounter, undefined);
});

test('counter readings from the page are checked before use', () => {
  assert.deepEqual(parseCounterReading({ scope: true, text: '4' }), { scope: true, text: '4' });
  assert.deepEqual(parseCounterReading({ scope: false, text: null }), { scope: false, text: null });
  assert.deepEqual(parseCounterReading({ scope: true, text: '9'.repeat(40) }), { scope: true, text: '9'.repeat(32) });
  for (const raw of [null, 'x', { scope: 'yes', text: '4' }, { scope: true, text: 4 }, { scope: true }]) {
    assert.equal(parseCounterReading(raw), undefined, JSON.stringify(raw));
  }
});
