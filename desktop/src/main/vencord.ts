import { net, session, type Session } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { partitionFor, type ServiceDefinition } from '../shared/services.ts';
import { VENCORD_URL, extensionFiles, vencordHeaders } from '../shared/vencord.ts';

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Marks which download a folder holds, so an unchanged build is not written again. */
const SOURCE_FILE = '.kainos-source-sha256';

export interface VencordOptions {
  /** Where the extension is kept between launches. */
  readonly dir: string;
  /** The services that run Vencord. */
  readonly services: readonly ServiceDefinition[];
  /** Called once Vencord is installed for the first time, to reload pages that started without it. */
  readonly onFirstInstall: () => void;
}

/**
 * Loads Vencord into its services' sessions and keeps it up to date. Await it before those
 * pages start loading, or their first load runs without it.
 *
 * An update is downloaded in the background and takes over at the next launch, because a
 * loaded extension cannot be swapped under a running page.
 */
export async function startVencord(options: VencordOptions): Promise<void> {
  const current = join(options.dir, 'extension');
  const next = join(options.dir, 'extension-next');
  if (existsSync(join(next, 'manifest.json'))) {
    rmSync(current, { recursive: true, force: true });
    renameSync(next, current);
  }

  const sessions = options.services.map((service) => session.fromPartition(partitionFor(service)));
  for (const ses of sessions) {
    ses.webRequest.onHeadersReceived((details, callback) =>
      callback({ responseHeaders: vencordHeaders(details, details.responseHeaders ?? {}) }),
    );
  }

  let loaded = existsSync(join(current, 'manifest.json')) && (await loadInto(sessions, current));

  const update = async () => {
    try {
      const response = await net.fetch(VENCORD_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const zip = new Uint8Array(await response.arrayBuffer());
      const source = createHash('sha256').update(zip).digest('hex');
      const target = loaded ? next : current;
      if (readSource(current) === source || readSource(next) === source) return;
      writeExtension(target, extensionFiles(unzipSync(zip)), source);
      if (loaded) {
        console.info('A Vencord update is downloaded; it takes over at the next launch.');
        return;
      }
      loaded = await loadInto(sessions, current);
      if (loaded) options.onFirstInstall();
    } catch (error) {
      console.warn('Could not update Vencord:', error);
    }
  };
  void update();
  setInterval(() => void update(), UPDATE_EVERY_MS).unref();
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
