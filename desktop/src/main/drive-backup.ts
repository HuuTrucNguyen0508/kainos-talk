// Backs up the folders the user picked to Proton Drive, through Proton's own command-line tool
// (proton-drive, signed in once with `proton-drive auth login`). The tool has no sync: each upload
// keeps the earlier version of an edited file as a revision, and deletes nothing on Drive.
//
// Proton asks clients to upload only what changed, so Kainos keeps a list of what went up (each
// file's size, modification time and inode), with the Drive folder they went into. A run reads the folders, and when nothing changed it ends
// there, without starting the tool. Otherwise it copies only the changed files into a folder of
// its own and uploads that: the tool refuses a whole folder if a symbolic link is anywhere inside,
// and the copy has none. Copies are copy-on-write clones where the disk can make them, else hard
// links, else plain copies, which must leave the disk some free space.

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

/** The folder in Drive's My files that holds every PC's backups. */
export const DRIVE_FOLDER = 'Kainos Talk backups';
export const CLI_DOWNLOAD = 'https://proton.me/download/drive/cli/index.html';
/** Longest a run may take before it is stopped; a first upload of a large folder can take hours. */
const RUN_LIMIT_MS = 6 * 60 * 60_000;
/** Longest the tool may take to say whether this PC's folder is on Drive. */
const ASK_LIMIT_MS = 2 * 60_000;
/** After asking the tool to stop, the wait before it is killed. */
const KILL_GRACE_MS = 10_000;
/** Free space a plain copy must leave on the disk that holds the copy. */
const KEEP_FREE_BYTES = 2 * 1024 ** 3;
/** At most this many of Drive's refusals are kept for the menu. */
const FAILURES_KEPT = 5;

/** Caches, installed packages and build caches: rebuilt from elsewhere, and often thousands of small files. */
const SKIPPED = new Set(['node_modules', '__pycache__', '.cache', '.venv', 'venv', '.pnpm-store', '.gradle']);

export function skipped(name: string): boolean {
  return SKIPPED.has(name) || name.startsWith('.Trash');
}

/** A file Drive refused, with the tool's reason. */
export interface Refusal {
  readonly name: string;
  readonly error: string;
}

/** One run's result, as the menu and the saved state keep it. */
export interface BackupOutcome {
  /** When the run ended (ms since the epoch). */
  readonly at: number;
  /** Every file went up, or was already there. */
  readonly ok: boolean;
  /** Bytes uploaded: changed and new files. */
  readonly sentBytes: number;
  /** Files that did not go up. */
  readonly failed: number;
  /** Why the run failed, or the first file that did. */
  readonly error?: string;
  /** The tool has no session: the user must run `proton-drive auth login`. */
  readonly signIn?: true;
  /** The first files Drive refused. */
  readonly failures?: readonly Refusal[];
  /** Picked folders that are gone (an unplugged disk). They stay picked; Drive keeps their copy. */
  readonly missing?: readonly string[];
  /** Files and folders that could not be read or copied, so are not in this backup. */
  readonly unstaged?: number;
  /** Symbolic links left out: Drive takes none. */
  readonly links?: number;
  /** The disk that holds the copy was nearly full, so some changed files wait for a later run. */
  readonly lowSpace?: true;
}

export function parseOutcome(raw: unknown): BackupOutcome | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { at, ok, sentBytes, failed, error, signIn, failures, missing, unstaged, links, lowSpace } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || typeof ok !== 'boolean' || typeof sentBytes !== 'number' || typeof failed !== 'number') return undefined;
  const gone = Array.isArray(missing) ? missing.filter((path): path is string => typeof path === 'string') : [];
  const refused = refusals(failures);
  return {
    at,
    ok,
    sentBytes,
    failed,
    ...(typeof error === 'string' && { error }),
    ...(signIn === true && { signIn: true as const }),
    ...(refused.length > 0 && { failures: refused }),
    ...(gone.length > 0 && { missing: gone }),
    ...(typeof unstaged === 'number' && unstaged > 0 && { unstaged }),
    ...(typeof links === 'number' && links > 0 && { links }),
    ...(lowSpace === true && { lowSpace: true as const }),
  };
}

function refusals(raw: unknown): Refusal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Refusal => typeof f?.name === 'string' && typeof f?.error === 'string')
    .slice(0, FAILURES_KEPT)
    .map(({ name, error }) => ({ name, error }));
}

/** Absolute folders, once each, in the order given. */
export function parseFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((path): path is string => typeof path === 'string' && isAbsolute(path)))];
}

/**
 * Where a folder goes under this PC's folder in Drive: `Home/…` for a folder in the home folder,
 * `Network/<server>/<share>/…` for a Windows network share, `Computer/…` (with the drive letter on
 * Windows) for any other.
 */
export function drivePlace(folder: string, home: string): string[] {
  const inHome = relative(home, folder);
  if (inHome === '') return ['Home'];
  if (!escapes(inHome)) return ['Home', ...inHome.split(sep)];
  // The drive letter, or a network share's server and share, as folders of their own.
  const { root } = parse(folder);
  const rootParts = root.split(/[\\/:]+/).filter(Boolean);
  const network = /^[\\/]{2}[^\\/]/.test(root);
  return [network ? 'Network' : 'Computer', ...rootParts, ...folder.slice(root.length).split(sep).filter(Boolean)];
}

/** A relative path that leaves its folder; a name such as `..notes` does not. */
const escapes = (rest: string) => rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest);

/** Whether `path` is `folder` or inside it; case-insensitive where the system's paths are. */
export const inside = (path: string, folder: string) => !escapes(relative(folder, path));

/** The path with every link resolved, so a link cannot dodge a comparison; the path itself if it is gone. */
const real = (path: string) => realpath(path).catch(() => path);

/** A file in the picked folders. */
export interface FoundFile {
  /** Where it goes, relative to this PC's folder in Drive. */
  readonly place: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** A restore or sync tool that sets the modification time back usually writes a new file (a new inode). */
  readonly ino: number;
}

export interface ScanReport {
  /** Regular files, by real path. */
  readonly files: Map<string, FoundFile>;
  /** Picked folders that do not exist. */
  readonly missing: string[];
  /** Files and folders that could not be read. */
  readonly unread: number;
  /** Symbolic links left out. */
  readonly links: number;
}

/**
 * Lists the regular files in the picked folders, each once. Symbolic links (counted), sockets,
 * caches (`skipped`) and everything inside `exclude` are left out; links in the picked folders' own
 * paths are resolved first, so a link to an excluded folder is still left out. The user's `skip`
 * folders are left out of the picked folders around them, but a folder picked inside one is still
 * read. A saved folder that now resolves elsewhere counts as missing. Stops early once `cancelled`
 * says so.
 */
export async function scanFolders(
  folders: readonly string[],
  place: { home: string; exclude: readonly string[]; skip?: readonly string[]; cancelled?: () => boolean; found?: (file: FoundFile) => void },
): Promise<ScanReport> {
  const home = await real(place.home);
  const exclude = await Promise.all(place.exclude.map(real));
  const skip = await Promise.all((place.skip ?? []).map(real));
  const cancelled = place.cancelled ?? (() => false);
  const files = new Map<string, FoundFile>();
  const missing: string[] = [];
  // Sets, as a folder picked inside another is read twice.
  const unread = new Set<string>();
  const links = new Set<string>();

  async function walk(from: string, to: string, left: readonly string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(from, { withFileTypes: true });
    } catch {
      unread.add(from);
      return;
    }
    for (const entry of entries) {
      if (cancelled()) return;
      const source = join(from, entry.name);
      if (skipped(entry.name) || [...exclude, ...left].some((folder) => inside(source, folder))) continue;
      const target = join(to, entry.name);
      if (entry.isSymbolicLink()) links.add(source);
      else if (entry.isDirectory()) await walk(source, target, left);
      else if (entry.isFile()) {
        const info = await lstat(source).catch(() => undefined);
        if (info?.isFile()) {
          const file = { place: target, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
          if (!files.has(source)) place.found?.(file);
          files.set(source, file);
        }
        else if (!info) unread.add(source);
      }
    }
  }

  const found: string[] = [];
  for (const picked of folders) {
    const folder = await real(picked);
    // Folders are saved by real path; one that now resolves elsewhere (replaced by a link, say)
    // is not the folder the user picked.
    if (folder !== picked || !(await stat(folder).catch(() => undefined))?.isDirectory()) missing.push(picked);
    else if (!exclude.some((excluded) => inside(folder, excluded))) found.push(folder);
  }
  // A folder inside another picked folder is read again on its own: the outer walk may skip it
  // (picking ~/.cache/project and ~). Each file is listed once.
  for (const folder of found) {
    if (cancelled()) break;
    const left = skip.filter((path) => path !== folder && inside(path, folder));
    await walk(folder, join(...drivePlace(folder, home)), left);
  }
  return { files, missing, unread: unread.size, links: links.size };
}

/** How much a first backup of some folders would send; counting stops past the limits. */
export interface FolderSize {
  readonly bytes: number;
  readonly files: number;
  /** Counting stopped at a limit: there is more. */
  readonly more: boolean;
}

/** Sums the files a backup of `folders` would send, as the backup reads them, up to `limit`. */
export async function sizeUpTo(folders: readonly string[], place: { home: string; exclude: readonly string[]; skip?: readonly string[] }, limit: { bytes: number; files: number }): Promise<FolderSize> {
  let bytes = 0;
  let files = 0;
  const over = () => bytes > limit.bytes || files > limit.files;
  await scanFolders(folders, {
    ...place,
    cancelled: over,
    found: (file) => {
      bytes += file.size;
      files += 1;
    },
  });
  return { bytes, files, more: over() };
}

/**
 * A file as it was when it went up: size, modification time and inode. Not the change time: the
 * hard links a run's copy may make change it.
 */
export type Sent = readonly [size: number, mtimeMs: number, ino: number];

/** What went up, by real path, and the uid of this PC's folder in Drive it went into. */
export interface Uploaded {
  readonly destination?: string;
  readonly files: Map<string, Sent>;
}
const UPLOADED = 'uploaded.json';

export async function readUploaded(workDir: string): Promise<Uploaded> {
  try {
    const raw = JSON.parse(await readFile(join(workDir, UPLOADED), 'utf8')) as { destination?: unknown; files?: unknown };
    if (typeof raw.files !== 'object' || raw.files === null) return { files: new Map() };
    const files = new Map(Object.entries(raw.files).filter((entry): entry is [string, Sent] => Array.isArray(entry[1]) && entry[1].length === 3 && entry[1].every((n) => typeof n === 'number')));
    return { ...(typeof raw.destination === 'string' && { destination: raw.destination }), files };
  } catch {
    return { files: new Map() };
  }
}

/** Writes the list into `workDir`, which `realFolder` has checked. */
async function writeUploaded(workDir: string, uploaded: Uploaded): Promise<void> {
  const temp = join(workDir, `${UPLOADED}.new`);
  await rm(temp, { force: true });
  await writeFile(temp, JSON.stringify({ destination: uploaded.destination, files: Object.fromEntries(uploaded.files) }), { flag: 'wx' });
  await rename(temp, join(workDir, UPLOADED));
}

/** Makes `folder` if needed; it must be a real folder, not a link that could lead writes to another disk. */
async function realFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`);
}

export const unchanged = (was: Sent | undefined, file: FoundFile) => was !== undefined && was[0] === file.size && was[1] === file.mtimeMs && was[2] === file.ino;

/**
 * The files after a run that uploaded every file in `sent`: those files as they were read, files
 * already up and unchanged, and files on a picked folder that is gone (an unplugged disk), which
 * stay on Drive and are not sent again when it is back. Files no longer in a picked folder drop out.
 */
export function nextUploaded(before: Map<string, Sent>, scan: ScanReport, sent: ReadonlyMap<string, Sent>): Map<string, Sent> {
  const next = new Map<string, Sent>();
  for (const [source, was] of before) if (scan.missing.some((folder) => inside(source, folder))) next.set(source, was);
  for (const [source, file] of scan.files) {
    const was = before.get(source);
    const fresh = sent.get(source);
    if (fresh) next.set(source, fresh);
    else if (was && unchanged(was, file)) next.set(source, was);
  }
  return next;
}

/** Written into each copy Kainos makes; only folders holding it are ever removed. */
const STAGE_MARK = '.kainos-backup-copy';

/**
 * Removes copies left by runs that never finished (Kainos quit or crashed): the `stage-*` folders
 * in `workDir` that hold Kainos' mark, nothing else. `workDir` must be a real folder, not a link:
 * removing copies through a link could reach another disk. A missing `workDir` has nothing to remove.
 */
export async function removeLeftovers(workDir: string): Promise<void> {
  const info = await lstat(workDir).catch(() => undefined);
  if (!info) return;
  if (!info.isDirectory()) throw new Error(`${workDir} is not a folder`);
  for (const name of await readdir(workDir)) {
    const folder = join(workDir, name);
    if (name.startsWith('stage-') && (await lstat(join(folder, STAGE_MARK)).catch(() => undefined))?.isFile()) await removeStage(folder);
  }
}

/**
 * Removes one run's copy: the files first, Kainos' mark last, so a removal cut short (Kainos quit)
 * leaves a marked folder that the next start removes.
 */
async function removeStage(stage: string): Promise<void> {
  await rm(join(stage, DRIVE_FOLDER), { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
}

/** A new, empty folder for one run's copy, inside `workDir`, after removing leftovers. */
export async function freshStage(workDir: string): Promise<string> {
  await realFolder(workDir);
  await removeLeftovers(workDir);
  const stage = await mkdtemp(join(workDir, 'stage-'));
  await writeFile(join(stage, STAGE_MARK), '');
  return stage;
}

export interface StageReport {
  /** Files in the copy, by real path, as the list of what went up will keep them. */
  readonly placed: Map<string, Sent>;
  /** Files that could not be copied. */
  readonly unread: number;
  /** Some files were not copied: a plain copy would have left the disk nearly full. */
  readonly lowSpace: boolean;
}

/** Whether a plain copy of `bytes` leaves the disk holding `folder` enough free space. */
export const roomOn = (folder: string) => async (bytes: number) => {
  const disk = await statfs(folder);
  return disk.bavail * disk.bsize - bytes >= KEEP_FREE_BYTES;
};

/**
 * Copies `files` to their places under `top` (this PC's folder in the copy). A file that is no
 * longer the one the scan found (replaced, or its folder replaced by a link) is left out.
 */
export async function stageFiles(
  files: Iterable<readonly [string, FoundFile]>,
  top: string,
  options: { cancelled?: () => boolean; room: (bytes: number) => Promise<boolean> },
): Promise<StageReport> {
  const made = new Set<string>();
  const placed = new Map<string, Sent>();
  let unread = 0;
  let lowSpace = false;
  for (const [source, file] of files) {
    if (options.cancelled?.()) break;
    const target = join(top, file.place);
    const folder = dirname(target);
    if (!made.has(folder)) {
      await mkdir(folder, { recursive: true });
      made.add(folder);
    }
    const now = await lstat(source).catch(() => undefined);
    const same = now?.isFile() && now.ino === file.ino && (await real(dirname(source))) === dirname(source);
    const result = same ? await placeFile(source, target, file.size, options.room) : 'failed';
    if (result === 'no-room') lowSpace = true;
    else if (result === 'failed') unread += 1;
    else placed.set(source, [file.size, file.mtimeMs, file.ino]);
  }
  return { placed, unread, lowSpace };
}

export type PlaceWay = 'clone' | 'link' | 'copy';

/**
 * A copy-on-write clone (a snapshot: later edits to the file do not reach it), else a hard link,
 * else a plain copy if the disk has room. A hard link, like uploading the file itself, can catch an
 * edit made during the upload; the next run sees the new modification time and sends it again.
 */
export async function placeFile(source: string, target: string, size: number, room: (bytes: number) => Promise<boolean>, ways: readonly PlaceWay[] = ['clone', 'link', 'copy']): Promise<PlaceWay | 'no-room' | 'failed'> {
  for (const way of ways) {
    try {
      if (way === 'clone') await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
      else if (way === 'link') await link(source, target);
      else if (await room(size)) await copyFile(source, target, constants.COPYFILE_EXCL);
      else return 'no-room';
      return way;
    } catch {
      // The next way.
    }
  }
  return 'failed';
}

/** The tool's summary of an upload (`--json`). */
interface UploadSummary {
  readonly transferredBytes: number;
  readonly failedItems: number;
  readonly failures: readonly Refusal[];
}

/** The summary is JSON, on one line or spread over several; the tool may print plain lines around it. */
function parseSummary(stdout: string): UploadSummary | undefined {
  const line = stdout.split('\n').find((text) => text.trimStart().startsWith('{'));
  const block = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
  for (const text of [line, block]) {
    const summary = text ? summaryFrom(text) : undefined;
    if (summary) return summary;
  }
  return undefined;
}

function summaryFrom(text: string): UploadSummary | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.transferredBytes !== 'number' || typeof raw.failedItems !== 'number') return undefined;
    return { transferredBytes: raw.transferredBytes, failedItems: raw.failedItems, failures: refusals(raw.failures) };
  } catch {
    return undefined;
  }
}

/** What this PC left out of a run: missing folders, unreadable items, links, a full disk. */
export interface LeftOut {
  readonly missing: readonly string[];
  readonly unstaged: number;
  readonly links?: number;
  readonly lowSpace?: boolean;
}

const NOTHING_LEFT_OUT: LeftOut = { missing: [], unstaged: 0 };

/** The tool's message when it has no session (`proton-drive auth login` was never run, or expired). */
const SIGNED_OUT = /failed to load session|no session|not (?:logged|signed) in|auth login|unauthori[sz]ed/i;

/** A run that left out folders or files it could not find, read or copy is not ok; links don't count. */
const complete = ({ missing, unstaged, lowSpace }: LeftOut) => missing.length === 0 && unstaged === 0 && !lowSpace;

function leftOutFields({ missing, unstaged, links = 0, lowSpace }: LeftOut) {
  return {
    ...(missing.length > 0 && { missing: [...missing] }),
    ...(unstaged > 0 && { unstaged }),
    ...(links > 0 && { links }),
    ...(lowSpace && { lowSpace: true as const }),
  };
}

/** A run that had nothing to upload (nothing changed, or nothing changed could be copied). */
export function nothingSent(at: number, leftOut: LeftOut = NOTHING_LEFT_OUT): BackupOutcome {
  return { at, ok: complete(leftOut), sentBytes: 0, failed: 0, ...leftOutFields(leftOut) };
}

/**
 * Reads the end of an upload into an outcome. `stoppedBecause` explains a run Kainos stopped
 * (it ran too long), in place of the tool's last words.
 */
export function outcomeOf(code: number | null, stdout: string, stderr: string, at: number, leftOut: LeftOut = NOTHING_LEFT_OUT, stoppedBecause?: string): BackupOutcome {
  const summary = stoppedBecause === undefined ? parseSummary(stdout) : undefined;
  if (summary) {
    const first = summary.failures[0];
    return {
      at,
      ok: summary.failedItems === 0 && code === 0 && complete(leftOut),
      sentBytes: summary.transferredBytes,
      failed: summary.failedItems,
      ...(first && { error: `${first.name}: ${first.error}`, failures: summary.failures }),
      ...leftOutFields(leftOut),
    };
  }
  const message = stoppedBecause ?? ((stderr.trim() || stdout.trim()).split('\n').pop()?.trim() || `proton-drive stopped (exit ${code})`);
  return {
    at,
    ok: false,
    sentBytes: 0,
    failed: 0,
    error: message,
    ...(stoppedBecause === undefined && SIGNED_OUT.test(message) && { signIn: true as const }),
    ...leftOutFields(leftOut),
  };
}

/** The tool on PATH, or in ~/.local/bin, where Proton's instructions put it. */
export function findCli(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.KAINOS_PROTON_DRIVE) return env.KAINOS_PROTON_DRIVE;
  const name = platform === 'win32' ? 'proton-drive.exe' : 'proton-drive';
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin')];
  for (const dir of dirs) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export interface DriveBackupOptions {
  readonly folders: () => readonly string[];
  /** Backups run only while the Proton Drive tab is on. */
  readonly enabled: () => boolean;
  readonly cli: () => string | undefined;
  /** Holds each run's copy (see `freshStage`), removed after the run, and the list of what went up. */
  readonly workDir: string;
  readonly home: string;
  /** This PC's folder in Drive. */
  readonly pc: string;
  /** Never uploaded, even inside a picked folder: Kainos' own data, with its logins. */
  readonly exclude: readonly string[];
  /** Folders the user left out of the picked folders around them. */
  readonly skip?: () => readonly string[];
  /** The wait from the end of one run to the next. */
  readonly everyMs: number;
  /** The wait before the first run, and before a run that came due while the PC slept. */
  readonly firstAfterMs: number;
  /** After each run; `asked` when the user chose Back up now or added a folder. */
  readonly onDone: (outcome: BackupOutcome, asked: boolean) => void;
  /** Whenever a run starts or ends, for the menu. */
  readonly onChange?: () => void;
}

export interface DriveBackup {
  /** Starts a run now unless one is on; resolves when it ends. */
  backUpNow(): Promise<void>;
  /** A folder was added: runs now, or again once the run that is on ends. */
  foldersChanged(): void;
  /** A folder was removed: the run that is on ends, and runs again without it. */
  folderRemoved(): void;
  running(): boolean;
  /** Ends the run that is on; the last outcome stays, and what went up stays on Drive. */
  cancel(): void;
  /** The PC woke up: a run that is due waits `firstAfterMs`, for the network to come back. */
  woke(): void;
  /** Stops the schedule and any run (quitting). */
  stop(): void;
}

/** How a run of the tool ended. */
interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why Kainos stopped it, when it ran past its limit. */
  readonly stoppedBecause?: string;
}

/** The uid in the tool's `filesystem info --json` answer. */
function uidOf(stdout: string): string | undefined {
  try {
    const { uid } = JSON.parse(stdout) as { uid?: unknown };
    return typeof uid === 'string' && uid !== '' ? uid : undefined;
  } catch {
    return undefined;
  }
}

export function startDriveBackup(options: DriveBackupOptions): DriveBackup {
  const { workDir } = options;
  const destinationPath = `/my-files/${DRIVE_FOLDER}/${options.pc}`;
  // A copy left by a run cut short at the last quit goes now, even with the Drive tab off; runs
  // wait for this, so it never removes the copy of a run that has begun.
  const leftovers = removeLeftovers(workDir).catch((error: unknown) => console.error('Could not remove an old backup copy', error));
  let current: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  let stopped = false;
  let cancelled = false;
  /** A run to start once the one on ends: 'asked' to report it, 'quiet' not to. */
  let again: 'asked' | 'quiet' | undefined;
  let timer: NodeJS.Timeout | undefined;
  let dueAt = 0;

  function schedule(ms: number): void {
    clearTimeout(timer);
    dueAt = Date.now() + ms;
    timer = setTimeout(() => (options.enabled() ? void start(false) : schedule(options.everyMs)), ms);
    // The schedule alone never keeps the process alive.
    timer.unref();
  }

  /**
   * Runs the tool; resolves when it has exited, never rejects. It is stopped once `ended` says so
   * (checked each second) or after `limitMs`, and killed if it does not stop.
   */
  function runCli(cli: string, args: readonly string[], limitMs: number, ended: () => boolean): Promise<CliResult> {
    return new Promise((resolve) => {
      const proc = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child = proc;
      let stdout = '';
      let stderr = '';
      let stoppedBecause: string | undefined;
      let ending = false;
      const end = () => {
        if (ending) return;
        ending = true;
        proc.kill();
        setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS).unref();
      };
      const limit = setTimeout(() => {
        stoppedBecause = `Stopped after ${formatDuration(limitMs)}; the next run sends the rest`;
        end();
      }, limitMs);
      const watch = setInterval(() => ended() && end(), 1_000);
      const finish = (result: CliResult) => {
        clearTimeout(limit);
        clearInterval(watch);
        if (child === proc) child = undefined;
        resolve(result);
      };
      proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      proc.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
      // Only a tool that never started ends here; otherwise 'close' follows.
      proc.on('error', (error) => proc.pid === undefined && finish({ code: null, signal: null, stdout: '', stderr: error.message }));
      proc.on('close', (code, signal) => finish({ code, signal, stdout, stderr, ...(stoppedBecause && { stoppedBecause }) }));
    });
  }

  /** The outcome of an upload, and whether every file went up. */
  function readUpload(result: CliResult, leftOut: LeftOut): { outcome: BackupOutcome; clean: boolean } {
    const why = result.stoppedBecause ?? (result.code === null && result.signal ? `proton-drive was stopped (${result.signal})` : undefined);
    const outcome = outcomeOf(result.code, result.stdout, result.stderr, Date.now(), leftOut, why);
    return { outcome, clean: result.code === 0 && outcome.failed === 0 && outcome.error === undefined };
  }

  /**
   * The uid of this PC's folder in Drive: undefined when there is none (never backed up, or
   * trashed), a failed outcome when the tool could not tell.
   */
  async function destination(cli: string, ended: () => boolean): Promise<{ uid?: string; failed?: BackupOutcome }> {
    const result = await runCli(cli, ['filesystem', 'info', '--json', destinationPath], ASK_LIMIT_MS, ended);
    const uid = result.code === 0 ? uidOf(result.stdout) : undefined;
    if (uid) return { uid };
    if (/node not found/i.test(result.stderr)) return {};
    return { failed: outcomeOf(result.code, '', result.stderr || 'proton-drive could not find this PC\'s backup folder in Drive', Date.now(), NOTHING_LEFT_OUT, result.stoppedBecause) };
  }

  async function run(asked: boolean): Promise<void> {
    const cli = options.cli();
    const folders = options.folders();
    if (!cli || folders.length === 0) return;
    cancelled = false;
    options.onChange?.();
    await leftovers;
    // Quitting, Cancel, a removed folder, or turning the Drive tab off ends a run; its outcome is dropped.
    const ended = () => stopped || cancelled || !options.enabled();
    let stage: string | undefined;

    /** One run, up to its outcome; undefined when it ended early. */
    async function attempt(): Promise<BackupOutcome | undefined> {
      await realFolder(workDir);
      const uploaded = await readUploaded(workDir);
      // The list holds only for the Drive folder it was made with: another account, or the folder
      // trashed, and everything goes up again.
      let trusted = uploaded.files;
      if (trusted.size > 0) {
        const { uid, failed } = await destination(cli!, ended);
        if (ended()) return undefined;
        if (failed) return failed;
        if (uid !== uploaded.destination) trusted = new Map();
      }
      const scan = await scanFolders(folders, { home: options.home, exclude: [workDir, ...options.exclude], skip: options.skip?.() ?? [], cancelled: ended });
      const changed = [...scan.files].filter(([source, file]) => !unchanged(trusted.get(source), file));
      let staged: StageReport = { placed: new Map(), unread: 0, lowSpace: false };
      if (changed.length > 0 && !ended()) {
        stage = await freshStage(workDir);
        staged = await stageFiles(changed, join(stage, DRIVE_FOLDER, options.pc), { cancelled: ended, room: roomOn(stage) });
      }
      if (ended()) return undefined;
      const leftOut: LeftOut = { missing: scan.missing, unstaged: scan.unread + staged.unread, links: scan.links, lowSpace: staged.lowSpace };
      if (!stage || staged.placed.size === 0) {
        const next = nextUploaded(trusted, scan, new Map());
        if (next.size !== uploaded.files.size) await saveUploaded({ ...(uploaded.destination && trusted === uploaded.files && { destination: uploaded.destination }), files: next });
        return nothingSent(Date.now(), leftOut);
      }
      const args = ['filesystem', 'upload', '--json', '-f', 'create-new-revision', '-d', 'merge', '-t', join(stage, DRIVE_FOLDER), '/my-files'];
      const sent = readUpload(await runCli(cli!, args, RUN_LIMIT_MS, ended), leftOut);
      if (ended()) return undefined;
      // After a failed upload the list stays as it was, so the next run sends the changed files again.
      if (sent.clean) {
        const { uid } = await destination(cli!, ended);
        await saveUploaded({ ...(uid && { destination: uid }), files: nextUploaded(trusted, scan, staged.placed) });
      }
      return sent.outcome;
    }

    let outcome: BackupOutcome | undefined;
    try {
      outcome = await attempt();
    } catch (error) {
      outcome = { at: Date.now(), ok: false, sentBytes: 0, failed: 0, error: `Could not prepare the backup: ${(error as Error).message}` };
    } finally {
      if (stage) await removeStage(stage).catch(() => undefined);
    }
    if (outcome && !ended()) options.onDone(outcome, asked);
  }

  const saveUploaded = (uploaded: Uploaded) => writeUploaded(workDir, uploaded).catch((error: unknown) => console.error('Could not save the list of backed-up files', error));

  function start(asked: boolean): Promise<void> {
    if (stopped) return Promise.resolve();
    current ??= run(asked).finally(() => {
      current = undefined;
      if (!stopped) schedule(options.everyMs);
      options.onChange?.();
      const next = again;
      again = undefined;
      if (next) void start(next === 'asked');
    });
    return current;
  }

  /** Ends the run that is on, if any; its outcome is dropped. */
  function endRun(): void {
    cancelled = true;
    child?.kill();
  }

  schedule(options.firstAfterMs);

  return {
    backUpNow: () => start(true),
    foldersChanged() {
      if (current) again = 'asked';
      else void start(true);
    },
    folderRemoved() {
      if (!current) return;
      endRun();
      again ??= 'quiet';
    },
    running: () => current !== undefined,
    cancel() {
      if (!current) return;
      endRun();
      again = undefined;
    },
    woke() {
      if (!stopped && !current && dueAt - Date.now() < options.firstAfterMs) schedule(options.firstAfterMs);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
    },
  };
}

function formatDuration(ms: number): string {
  return ms >= 3_600_000 ? `${ms / 3_600_000} hours` : `${Math.round(ms / 60_000)} minutes`;
}

/** Nothing went up: the tool did not run, or ended without a summary. */
export function uploadFailed(outcome: BackupOutcome): boolean {
  return outcome.error !== undefined && outcome.failed === 0;
}

/** What kind of result a run had; a notification shows when this changes. */
export type OutcomeKind = 'ok' | 'signed-out' | 'failed' | 'refused' | 'low-space' | 'missing' | 'unread';

export function outcomeKind(outcome: BackupOutcome): OutcomeKind {
  if (outcome.signIn) return 'signed-out';
  if (uploadFailed(outcome)) return 'failed';
  if (outcome.failed > 0) return 'refused';
  if (outcome.lowSpace) return 'low-space';
  if (outcome.missing?.length) return 'missing';
  if (outcome.unstaged) return 'unread';
  return outcome.ok ? 'ok' : 'failed';
}

/** One line for the menu: how the last run went. */
export function outcomeLabel(outcome: BackupOutcome | undefined, now: Date, locale?: string): string {
  if (!outcome) return 'Not backed up yet';
  const when = new Date(outcome.at);
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const at = sameDay ? time : `${when.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
  switch (outcomeKind(outcome)) {
    case 'signed-out':
      return `Not backed up (${at}): sign in to proton-drive`;
    case 'failed':
      return `Backup failed ${at}`;
    case 'refused':
      return `Backed up ${at}, ${outcome.failed} file(s) failed`;
    case 'low-space':
      return `Backed up ${at} in part: the disk is nearly full`;
    case 'missing':
      return `Backed up ${at}, ${outcome.missing!.length} folder(s) not found`;
    case 'unread':
      return `Backed up ${at}, ${outcome.unstaged} item(s) could not be read`;
    case 'ok':
      return outcome.sentBytes > 0 ? `Backed up ${at}, ${formatBytes(outcome.sentBytes)} sent` : `Backed up ${at}, nothing changed`;
  }
}

/** The menu's and the notification's details: what went wrong and what was left out. */
export function outcomeDetails(outcome: BackupOutcome, show: (path: string) => string = (path) => path): string[] {
  const lines: string[] = [];
  if (outcome.signIn) lines.push('Run proton-drive auth login in a terminal, then Back up now.');
  else if (outcome.error) lines.push(outcome.error);
  const refused = outcome.failures ?? [];
  for (const { name, error } of refused.slice(1)) lines.push(`${name}: ${error}`);
  const more = outcome.failed - Math.max(refused.length, outcome.error ? 1 : 0);
  if (more > 0) lines.push(`${more} more file(s) failed`);
  if (outcome.lowSpace) lines.push('The disk holding the backup copy is nearly full, so some changed files wait for a later run.');
  for (const path of outcome.missing ?? []) lines.push(`Not found: ${show(path)}`);
  if (outcome.unstaged) lines.push(`${outcome.unstaged} item(s) could not be read`);
  if (outcome.links) lines.push(`${outcome.links} symbolic link(s) left out: Drive takes no links`);
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
