/**
 * Vencord, the Discord client mod, runs in the Discord page as its official Chrome extension
 * build ("Vencord Web"), loaded into the Discord session with Electron's extension support.
 */

/** The official build, rebuilt by Vencord's CI on every commit. */
export const VENCORD_URL = 'https://github.com/Vendicated/Vencord/releases/download/devbuild/extension-chrome.zip';

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
