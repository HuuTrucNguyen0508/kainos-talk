/**
 * Vencord, the Discord client mod, runs in the Discord page as its official Chrome extension
 * build ("Vencord Web"), loaded into the Discord session with Electron's extension support.
 */

import { createHash } from 'node:crypto';

/** The official build, rebuilt by Vencord's CI on every commit and replaced in place. */
export const VENCORD_URL = 'https://github.com/Vendicated/Vencord/releases/download/devbuild/extension-chrome.zip';

/**
 * The one build Kainos loads: code that runs in the signed-in Discord page changes only with a
 * Kainos build. Vencord publishes no fixed versions, only `devbuild` replaced in place, so a
 * newer download is refused until this is moved on. To move it: download VENCORD_URL, check
 * it, and put its `sha256sum` and its manifest's version here.
 */
export const VENCORD_BUILD = {
  version: '1.15.18',
  sha256: 'a11ebfd94b7bc4b89297f0943e5e3af93c226cc597c0979f1c107f9cc5ec85b7',
} as const;

/** SHA-256 of a download, lower-case hex, as `sha256sum` prints it. */
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Throws unless the download is the pinned build. */
export function checkPinned(zip: Uint8Array): void {
  const got = sha256(zip);
  if (got !== VENCORD_BUILD.sha256) {
    throw new Error(`Vencord's download (sha256 ${got}) is not the build Kainos is pinned to (${VENCORD_BUILD.version}, ${VENCORD_BUILD.sha256}); Kainos goes on without a newer one until the pin moves`);
  }
}

const REQUIRED = ['manifest.json', 'content.js', 'dist/Vencord.js', 'dist/Vencord.css'];

/**
 * Checks an unzipped download and returns the files to write, or throws.
 *
 * Only Vencord Web with all its parts gets through, and no path may leave the extension folder.
 * The manifest loses what Electron cannot run: its service worker (keyboard shortcut commands)
 * and its header rules, which main applies itself (see `vencordHeaders`).
 */
export function extensionFiles(zip: Readonly<Record<string, Uint8Array>>): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(zip)) {
    if (path.endsWith('/')) continue;
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Error(`unsafe path in download: ${path}`);
    }
    files.set(path, bytes);
  }
  for (const path of REQUIRED) if (!files.has(path)) throw new Error(`download is missing ${path}`);

  const manifest: unknown = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  if (typeof manifest !== 'object' || manifest === null || (manifest as { name?: unknown }).name !== 'Vencord Web') {
    throw new Error('download is not Vencord Web');
  }
  const { background: _worker, commands: _commands, declarative_net_request: _rules, ...rest } = manifest as Record<string, unknown>;
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(rest)));
  return files;
}

export interface ResponseInfo {
  readonly url: string;
  readonly resourceType: string;
}

/**
 * The extension's own header rules, which Electron does not run. Discord's content security
 * policy goes, so themes and plugins can pull styles, fonts and images from any host, and
 * stylesheets from GitHub's raw file host are served as CSS (it labels them text/plain).
 */
export function vencordHeaders(info: ResponseInfo, headers: Record<string, string[]>): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^content-security-policy(-report-only)?$/i.test(name)) continue;
    if (/^content-type$/i.test(name) && info.resourceType === 'stylesheet' && isRawGitHub(info.url)) continue;
    next[name] = value;
  }
  if (info.resourceType === 'stylesheet' && isRawGitHub(info.url)) next['content-type'] = ['text/css'];
  return next;
}

function isRawGitHub(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname === 'raw.githubusercontent.com';
  } catch {
    return false;
  }
}
