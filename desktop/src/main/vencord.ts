import { net, session, type Session } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { partitionFor, type ServiceDefinition } from '../shared/services.ts';
import { VENCORD_BUILD, VENCORD_URL, checkPinned, extensionFiles, vencordHeaders } from '../shared/vencord.ts';

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
