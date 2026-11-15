import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionFiles, vencordHeaders } from './vencord.ts';

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
