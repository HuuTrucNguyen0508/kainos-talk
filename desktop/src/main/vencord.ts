import { net, session, type Session, type WebContents } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { partitionFor, type ServiceDefinition } from '../shared/services.ts';
import { VENCORD_BUILD, VENCORD_URL, checkPinned, extensionFiles, refreshThemesScript, vencordHeaders } from '../shared/vencord.ts';

/** Marks which download a folder holds. */
const SOURCE_FILE = '.kainos-source-sha256';

export interface VencordOptions {
  /** Where the extension is kept between launches. */
  readonly dir: string;
  /** The services that run Vencord. */
  readonly services: readonly ServiceDefinition[];
  /** Called once Vencord is installed, to reload pages that started without it. */
  readonly onFirstInstall: () => void;
}

/**
 * Loads the pinned Vencord build into its services' sessions. Await it before those pages
 * start loading, or their first load runs without it.
 *
 * A kept copy of the pinned build loads with no download. Otherwise (a first launch, or a Kainos
 * build that moved the pin) the build is downloaded and loaded only if it is the pinned one.
 */
export async function startVencord(options: VencordOptions): Promise<void> {
  const current = join(options.dir, 'extension');
  // Left by earlier versions, which took newer builds as they came.
  rmSync(join(options.dir, 'extension-next'), { recursive: true, force: true });

  const sessions = options.services.map((service) => session.fromPartition(partitionFor(service)));
  for (const ses of sessions) {
    ses.webRequest.onHeadersReceived((details, callback) =>
      callback({ responseHeaders: vencordHeaders(details, details.responseHeaders ?? {}) }),
    );
  }

  if (readSource(current) === VENCORD_BUILD.sha256 && existsSync(join(current, 'manifest.json')) && (await loadInto(sessions, current))) return;

  void (async () => {
    try {
      const response = await net.fetch(VENCORD_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const zip = new Uint8Array(await response.arrayBuffer());
      checkPinned(zip);
      writeExtension(current, extensionFiles(unzipSync(zip)), VENCORD_BUILD.sha256);
      if (await loadInto(sessions, current)) options.onFirstInstall();
    } catch (error) {
      console.warn('Could not install Vencord:', error);
    }
  })();
}

async function loadInto(sessions: readonly Session[], dir: string): Promise<boolean> {
  try {
    for (const ses of sessions) await ses.extensions.loadExtension(dir);
    return true;
  } catch (error) {
    console.warn('Could not load Vencord:', error);
    return false;
  }
}

/** Writes the whole folder beside the target, then swaps it in, so a crash never leaves half a build. */
function writeExtension(target: string, files: ReadonlyMap<string, Uint8Array>, source: string): void {
  const staging = `${target}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const file = join(staging, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  writeFileSync(join(staging, SOURCE_FILE), source);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
}

function readSource(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, SOURCE_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

export interface ThemeMirror {
  /** Brings a Discord page's themes up to date on each load, and whenever the folder changes. */
  attach(contents: WebContents): void;
}

/**
 * Keeps the themes uploaded to Vencord in the Discord tab in step with desktop Vencord's themes
 * folder, which other tools may rewrite (a theme that follows the desktop's colours, say). Only
 * themes the page already has are updated; see `refreshThemesScript`. Without the folder at
 * startup, nothing is mirrored.
 */
export function mirrorVencordThemes(dir: string): ThemeMirror {
  const pages = new Set<WebContents>();
  const refresh = (contents: WebContents) => {
    const files = readThemes(dir);
    if (Object.keys(files).length === 0 || contents.isDestroyed()) return;
    contents.executeJavaScript(refreshThemesScript(files)).catch((error: unknown) => console.warn('Could not refresh Vencord themes:', error));
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    // Themes are often written beside their file and renamed over it, so the folder is watched.
    watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => pages.forEach(refresh), 250);
    }).on('error', (error) => console.warn('Stopped watching Vencord themes:', error));
  } catch {
    // No themes folder.
  }
  return {
    attach(contents) {
      pages.add(contents);
      contents.on('dom-ready', () => refresh(contents));
      contents.once('destroyed', () => pages.delete(contents));
    },
  };
}

/** The folder's CSS files by name. */
function readThemes(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.css') || name.startsWith('.')) continue;
      try {
        files[name] = readFileSync(join(dir, name), 'utf8');
      } catch {
        // Gone or unreadable since the listing.
      }
    }
  } catch {
    // No themes folder.
  }
  return files;
}
