import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropIndex, makeRoom, moveService, normalizeHidden, normalizeOrder, successor, visibleServices } from './dock-order.ts';

const registry = ['inbox', 'proton-mail', 'discord', 'whatsapp', 'messenger'];

test('a saved order keeps its order, drops unknown and repeated ids, and appends new services in registry order', () => {
  assert.deepEqual(normalizeOrder(['whatsapp', 'icq', 'inbox', 'whatsapp', 7, 'discord'], registry), ['whatsapp', 'inbox', 'discord', 'proton-mail', 'messenger']);
  assert.deepEqual(normalizeOrder(['messenger', 'discord', 'whatsapp', 'proton-mail', 'inbox'], registry), ['messenger', 'discord', 'whatsapp', 'proton-mail', 'inbox']);
});

test('no saved order, or not a list, is the registry order', () => {
  for (const stored of [undefined, null, 'discord', { 0: 'discord' }, []]) assert.deepEqual(normalizeOrder(stored, registry), registry);
});

test('hidden ids are known, once each, and never one that cannot be hidden', () => {
  assert.deepEqual(normalizeHidden(['discord', 'inbox', 'icq', 'discord', 3, 'messenger'], registry, ['inbox']), ['discord', 'messenger']);
  assert.deepEqual(normalizeHidden('discord', registry, ['inbox']), []);
  assert.deepEqual(normalizeHidden(undefined, registry), []);
});

test('hiding every service hides none', () => {
  assert.deepEqual(normalizeHidden(['discord', 'whatsapp'], ['discord', 'whatsapp']), []);
});

test('the visible services follow the dock order', () => {
  assert.deepEqual(visibleServices(['whatsapp', 'inbox', 'discord', 'messenger'], ['inbox', 'messenger']), ['whatsapp', 'discord']);
});

test('moves a tab right and left', () => {
  assert.deepEqual(moveService(registry, 'proton-mail', 3), ['inbox', 'discord', 'whatsapp', 'proton-mail', 'messenger']);
  assert.deepEqual(moveService(registry, 'whatsapp', 1), ['inbox', 'whatsapp', 'proton-mail', 'discord', 'messenger']);
  assert.deepEqual(moveService(registry, 'inbox', 4), ['proton-mail', 'discord', 'whatsapp', 'messenger', 'inbox']);
  assert.deepEqual(moveService(registry, 'messenger', 0), ['messenger', 'inbox', 'proton-mail', 'discord', 'whatsapp']);
  assert.deepEqual(moveService(registry, 'discord', 2), registry);
});

test('a place past either end is clamped to the dock', () => {
  assert.deepEqual(moveService(registry, 'discord', 99), ['inbox', 'proton-mail', 'whatsapp', 'messenger', 'discord']);
  assert.deepEqual(moveService(registry, 'discord', -3), ['discord', 'inbox', 'proton-mail', 'whatsapp', 'messenger']);
});

test('the place counts visible tabs only, and hidden services keep their neighbours', () => {
  // Visible: inbox, proton-mail, whatsapp, messenger. Proton to the third tab lands after WhatsApp.
  assert.deepEqual(moveService(registry, 'proton-mail', 2, ['discord']), ['inbox', 'discord', 'whatsapp', 'proton-mail', 'messenger']);
  // To the last tab: after the last visible one, ahead of a hidden one behind it.
  assert.deepEqual(moveService(registry, 'inbox', 3, ['messenger']), ['proton-mail', 'discord', 'whatsapp', 'inbox', 'messenger']);
});

test('an unknown or hidden id leaves the order as it is', () => {
  assert.deepEqual(moveService(registry, 'icq', 0), registry);
  assert.deepEqual(moveService(registry, 'discord', 0, ['discord']), registry);
});

test('hiding a tab hands over to the next one, or the one before at the end', () => {
  assert.equal(successor(registry, [], 'discord'), 'whatsapp');
  assert.equal(successor(registry, ['whatsapp'], 'discord'), 'messenger');
  assert.equal(successor(registry, [], 'messenger'), 'whatsapp');
  assert.equal(successor(registry, ['whatsapp'], 'messenger'), 'discord');
  assert.equal(successor(['inbox'], [], 'inbox'), undefined);
  assert.equal(successor(registry, ['discord'], 'discord'), undefined);
});

test('a dragged tab lands after every tab whose centre it has passed', () => {
  // The other tabs' centres, with the dragged tab taken out.
  const centres = [40, 120, 200, 280];
  assert.equal(dropIndex(centres, 10), 0);
  assert.equal(dropIndex(centres, 41), 1);
  assert.equal(dropIndex(centres, 200), 2);
  assert.equal(dropIndex(centres, 201), 3);
  assert.equal(dropIndex(centres, 900), 4);
});

test('the tabs between the old and new place step aside, the rest stay', () => {
  // A B C D E, B dragged to the fourth place: C and D step left.
  assert.deepEqual([0, 1, 2, 3].map((k) => makeRoom(k, 1, 3)), [0, -1, -1, 0]);
  // D dragged to the second place: B and C step right.
  assert.deepEqual([0, 1, 2, 3].map((k) => makeRoom(k, 3, 1)), [0, 1, 1, 0]);
  assert.deepEqual([0, 1, 2, 3].map((k) => makeRoom(k, 2, 2)), [0, 0, 0, 0]);
});
