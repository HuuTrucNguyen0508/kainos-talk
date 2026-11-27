import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { VENCORD_BUILD, checkPinned, extensionFiles, refreshThemesScript, sha256, vencordHeaders } from './vencord.ts';

const text = (value: string) => new TextEncoder().encode(value);
const manifest = {
  manifest_version: 3,
  name: 'Vencord Web',
  version: '1.15.17',
  content_scripts: [{ matches: ['*://*.discord.com/*'], js: ['content.js'] }],
  background: { service_worker: 'service-worker.js' },
  commands: { TOGGLE_MUTE: {} },
  declarative_net_request: { rule_resources: [] },
};
const download = (overrides: Record<string, Uint8Array> = {}) => ({
  'manifest.json': text(JSON.stringify(manifest)),
  'content.js': text('content'),
  'dist/': new Uint8Array(),
  'dist/Vencord.js': text('vencord'),
  'dist/Vencord.css': text('css'),
  'vendor/monaco/index.js': text('monaco'),
  ...overrides,
});

test('keeps every file of a Vencord Web download, minus what Electron cannot run', () => {
  const files = extensionFiles(download());
  assert.deepEqual([...files.keys()].sort(), ['content.js', 'dist/Vencord.css', 'dist/Vencord.js', 'manifest.json', 'vendor/monaco/index.js']);
  const written = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  assert.equal(written.name, 'Vencord Web');
  assert.deepEqual(written.content_scripts, manifest.content_scripts);
  assert.equal(written.background, undefined);
  assert.equal(written.commands, undefined);
  assert.equal(written.declarative_net_request, undefined);
});

test('refuses paths that leave the extension folder', () => {
  for (const path of ['../evil.js', 'dist/../../evil.js', '/etc/evil', 'dist\\evil.js', 'dist//x.js']) {
    assert.throws(() => extensionFiles(download({ [path]: text('x') })), /unsafe path/, path);
  }
});

test('refuses a download that is not a complete Vencord Web', () => {
  const { 'dist/Vencord.js': _js, ...partial } = download();
  assert.throws(() => extensionFiles(partial), /missing dist\/Vencord.js/);
  assert.throws(() => extensionFiles(download({ 'manifest.json': text(JSON.stringify({ ...manifest, name: 'Other' })) })), /not Vencord Web/);
  assert.throws(() => extensionFiles(download({ 'manifest.json': text('<html>') })));
});

test("drops Discord's content security policy", () => {
  const headers = vencordHeaders(
    { url: 'https://discord.com/app', resourceType: 'mainFrame' },
    { 'Content-Security-Policy': ['default-src self'], 'content-security-policy-report-only': ['x'], 'Content-Type': ['text/html'] },
  );
  assert.deepEqual(headers, { 'Content-Type': ['text/html'] });
});

test('serves GitHub raw stylesheets as CSS, and nothing else', () => {
  const raw = 'https://raw.githubusercontent.com/user/theme/main/theme.css';
  assert.deepEqual(vencordHeaders({ url: raw, resourceType: 'stylesheet' }, { 'Content-Type': ['text/plain'] }), { 'content-type': ['text/css'] });
  assert.deepEqual(vencordHeaders({ url: raw, resourceType: 'script' }, { 'Content-Type': ['text/plain'] }), { 'Content-Type': ['text/plain'] });
  assert.deepEqual(
    vencordHeaders({ url: 'https://raw.githubusercontent.com.evil.example/x.css', resourceType: 'stylesheet' }, { 'Content-Type': ['text/plain'] }),
    { 'Content-Type': ['text/plain'] },
  );
});

test('only the pinned Vencord build gets through', () => {
  assert.match(VENCORD_BUILD.sha256, /^[0-9a-f]{64}$/);
  assert.match(VENCORD_BUILD.version, /^\d+\.\d+\.\d+$/);
  const newer = text('a build Vencord published after the pin');
  assert.throws(() => checkPinned(newer), new RegExp(sha256(newer)));
  assert.equal(sha256(text('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

/** Vencord Web's theme store and settings, as far as the page script uses them. */
function fakeVencord(stored: Record<string, string>, enabled: string[]) {
  const store = new Map(Object.entries(stored));
  const settings = { enabledThemes: enabled, writes: 0 };
  const window = {
    VencordNative: {
      themes: {
        getThemesList: async () => [...store.keys()].map((fileName) => ({ fileName })),
        getThemeData: async (name: string) => store.get(name),
        uploadTheme: async (name: string, css: string) => void store.set(name, css),
      },
    },
    Vencord: {
      Settings: new Proxy(settings, {
        set(target, key, value) {
          if (key === 'enabledThemes') target.writes++;
          return Reflect.set(target, key, value);
        },
      }),
    },
  };
  return { window, store, settings };
}

/** Arrays made in the script's context are copied out, as they would cross from the page. */
const run = async (window: object, files: Record<string, string>): Promise<string[] | null> => {
  const replaced: string[] | null = await runInNewContext(refreshThemesScript(files), { window });
  return replaced && Array.from(replaced);
};

test('replaces only the themes the page has whose text changed, and re-applies an enabled one', async () => {
  const page = fakeVencord({ 'frost.theme.css': 'frost', 'folio.theme.css': 'folio' }, ['frost.theme.css']);
  const replaced = await run(page.window, { 'frost.theme.css': 'nyx', 'folio.theme.css': 'folio', 'new.theme.css': 'new' });
  assert.deepEqual(replaced, ['frost.theme.css']);
  assert.deepEqual(Object.fromEntries(page.store), { 'frost.theme.css': 'nyx', 'folio.theme.css': 'folio' });
  assert.equal(page.settings.writes, 1);
  assert.deepEqual(Array.from(page.settings.enabledThemes), ['frost.theme.css']);
});

test('leaves the settings alone when only a disabled theme changed, or nothing did', async () => {
  const page = fakeVencord({ 'frost.theme.css': 'frost', 'folio.theme.css': 'folio' }, ['frost.theme.css']);
  assert.deepEqual(await run(page.window, { 'folio.theme.css': 'folio 2' }), ['folio.theme.css']);
  assert.deepEqual(await run(page.window, { 'frost.theme.css': 'frost', 'folio.theme.css': 'folio 2' }), []);
  assert.equal(page.settings.writes, 0);
});

test('waits for Vencord, and takes theme text as data', async () => {
  assert.equal(await run({}, { 'frost.theme.css': 'nyx' }), null);
  const css = '`${globalThis.hacked = 1}` */ })(); globalThis.hacked = 2; (() => { /* \u2028\u2029 </script>';
  const page = fakeVencord({ 'x.css': 'old' }, []);
  await run(page.window, { 'x.css': css, '__proto__': 'proto' });
  assert.equal(page.store.get('x.css'), css);
  assert.equal((page.window as { hacked?: number }).hacked, undefined);
});
