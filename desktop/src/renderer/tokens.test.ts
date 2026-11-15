// tokens.css against the theme table, and the WCAG 2 contrast of every theme's token pairs,
// including the 50% hover mix and the lightbox scrim, which no rendered walk sees.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SYSTEM_THEME, THEMES, type ThemeId } from '../shared/theme.ts';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const inboxCss = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8');

/** Every innermost rule: its selector and its declarations by property. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector!.replace(/\/\*[^]*?\*\//g, '').split(';').at(-1)!.trim(),
  props: new Map([...body!.replace(/\/\*[^]*?\*\//g, '').matchAll(/([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()])),
}));
const block = (selector: string) => {
  const found = rules.filter((rule) => rule.selector.split(/,\s*/).includes(selector));
  assert.equal(found.length, 1, `one rule for ${selector}`);
  return found[0]!.props;
};
const themeBlock = (id: ThemeId) => block(`:root[data-theme='${id}']`);

test('every theme in the table has one token block, with the same tokens as the others', () => {
  const names = (id: ThemeId) => [...themeBlock(id).keys()].sort().join(' ');
  for (const theme of THEMES) assert.equal(names(theme.id), names('daylight'), theme.id);
  assert.equal(themeBlock('carbon').size, 28);
});

test("each block's --surface and color-scheme match the table main paints with", () => {
  for (const theme of THEMES) {
    assert.equal(themeBlock(theme.id).get('--surface'), theme.surface, theme.id);
    assert.equal(themeBlock(theme.id).get('color-scheme'), theme.kind, theme.id);
  }
});

test('with no theme picked, the page is Daylight, or Bakelite under a dark system', () => {
  const light = rules.find((rule) => rule.selector.split(/,\s*/).includes(`:root[data-theme='${SYSTEM_THEME.light}']`))!;
  assert.deepEqual(light.selector.split(/,\s*/), [':root', ":root[data-theme='daylight']"]);
  assert.deepEqual(block(':root:not([data-theme])'), themeBlock(SYSTEM_THEME.dark));
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\)/);
});

const rgb = (hex: string): number[] => hex.match(/[a-f\d]{2}/gi)!.map((channel) => parseInt(channel, 16));
const luminance = (channels: readonly number[]): number =>
  channels.reduce((sum, channel, i) => {
    const s = channel / 255;
    return sum + [0.2126, 0.7152, 0.0722][i]! * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  }, 0);
const ratio = (a: readonly number[], b: readonly number[]): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('the Texts page still paints hover and the lightbox from the tokens this test measures', () => {
  assert.match(inboxCss, /background: color-mix\(in srgb, var\(--surface\) 50%, var\(--rail\)\);/);
  assert.match(inboxCss, /\.lightbox \{[^}]*color: #ffffff;/);
  assert.match(inboxCss, /\.lightbox::backdrop \{\s*background: var\(--scrim\);/);
});

test('every theme reaches 4.5:1 for text and 3:1 for controls and marks', () => {
  for (const theme of THEMES) {
    const props = themeBlock(theme.id);
    const token = (name: string) => rgb(props.get(`--${name}`) ?? assert.fail(`${theme.id} has no --${name}`));
    const hover = token('surface').map((v, i) => (v + token('rail')[i]!) / 2);
    const [, r, g, b, alpha] = props.get('--scrim')!.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/)!.map(Number);
    // A white photo under the scrim is the worst case for the lightbox's white fallback text.
    const scrim = [r!, g!, b!].map((v) => v * alpha! + 255 * (1 - alpha!));
    const text: [string, number[], number[]][] = [
      ['ink on page', token('ink'), token('surface')],
      ['ink on pane and island', token('ink'), token('rail')],
      ['ink on received bubble and fields', token('ink'), token('raised')],
      ['ink on active tab and avatar', token('ink'), token('well')],
      ['ink on hovered row', token('ink'), hover],
      ['secondary on page', token('ink-soft'), token('surface')],
      ['secondary on pane and island', token('ink-soft'), token('rail')],
      ['secondary on received bubble, placeholder, disabled Send', token('ink-soft'), token('raised')],
      ['secondary on hovered row', token('ink-soft'), hover],
      ['sent bubble text', token('sent-ink'), token('sent')],
      ['sent bubble time', token('sent-meta'), token('sent')],
      ['unread count', token('unread-ink'), token('unread')],
      ['buttons', token('accent-ink'), token('accent')],
      ['accent text on page', token('accent'), token('surface')],
      ['code digits', token('chip-ink'), token('chip')],
      ['Copy on the code chip', token('accent'), token('chip')],
      ['alert on island', token('alert'), token('rail')],
      ['alert on page', token('alert'), token('surface')],
      ['alert badge icon', token('alert-ink'), token('alert')],
      ['disconnected bar text', token('ink'), token('alert-wash')],
      ['disconnected bar hint', token('ink-soft'), token('alert-wash')],
      ['lightbox fallback text (white photo)', rgb('#ffffff'), scrim],
    ];
    const marks: [string, number[], number[]][] = [
      ['field border on page', token('outline'), token('surface')],
      ['field border on pane', token('outline'), token('rail')],
      ['chip border', token('chip-edge'), token('chip')],
      ['unread pill on island', token('unread'), token('rail')],
      ['unread pill by the active tab', token('unread'), token('well')],
      ['focus ring and selection bar on pane', token('accent'), token('rail')],
      ['Kainos mark on island', token('mark'), token('rail')],
    ];
    for (const [use, fg, bg] of text) assert.ok(ratio(fg, bg) >= 4.5, `${theme.name}: ${use} ${ratio(fg, bg).toFixed(2)}:1`);
    for (const [use, fg, bg] of marks) assert.ok(ratio(fg, bg) >= 3, `${theme.name}: ${use} ${ratio(fg, bg).toFixed(2)}:1`);
  }
});
