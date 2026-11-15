import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEMES, parseThemeChoice, resolveTheme } from './theme.ts';

test('the menu lists five themes in order, with their names', () => {
  assert.deepEqual(
    THEMES.map((theme) => `${theme.id}:${theme.name}:${theme.kind}`),
    ['switchboard:Switchboard:dark', 'daylight:Daylight:light', 'bakelite:Bakelite:dark', 'carbon:Carbon:dark', 'aubergine:Aubergine:dark'],
  );
});

test('a sent or saved choice is a known theme id or else the system', () => {
  assert.equal(parseThemeChoice('aubergine'), 'aubergine');
  assert.equal(parseThemeChoice('system'), 'system');
  for (const raw of [undefined, null, 'Aubergine', 'toString', '__proto__', 1, ['carbon']]) assert.equal(parseThemeChoice(raw), 'system', String(raw));
});

test('the system choice is Daylight when light and Bakelite when dark; a named theme ignores the system', () => {
  assert.equal(resolveTheme('system', false).surface, '#ffffff');
  assert.equal(resolveTheme('system', true).surface, '#15100d');
  assert.equal(resolveTheme('carbon', false).surface, '#000000');
  assert.equal(resolveTheme('daylight', true).surface, '#ffffff');
  assert.equal(resolveTheme('switchboard', true).surface, '#0b1316');
  assert.equal(resolveTheme('aubergine', false).surface, '#21152b');
});
