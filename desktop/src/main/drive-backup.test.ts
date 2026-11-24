import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DRIVE_FOLDER,
  drivePlace,
  findCli,
  formatBytes,
  freshStage,
  nextUploaded,
  nothingSent,
  outcomeDetails,
  outcomeKind,
  outcomeLabel,
  outcomeOf,
  placeFile,
  readUploaded,
  scanFolders,
  sizeUpTo,
  startDriveBackup,
  type BackupOutcome,
  type DriveBackupOptions,
  type ScanReport,
  type Sent,
} from './drive-backup.ts';

const posix = process.platform !== 'win32';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'kainos-backup-'));
}

/** Resolves once `ready` holds, checking every few milliseconds. */
async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A stand-in proton-drive. `filesystem info` answers with the uid in `<record>.uid`, or "Node not
 * found" before the first upload. An upload appends its files to `<record>.files` (one block per
 * upload), notes its arguments, and reports `bytes` sent; the first `fails` uploads fail instead.
 */
function fakeCli(root: string, record: string, { bytes = 5, fails = 0 } = {}): string {
  const cli = join(root, 'proton-drive');
  writeFileSync(
    cli,
    `#!/bin/sh
if [ "$2" = info ]; then
  [ -f '${record}.uid' ] && { printf '{"uid":"%s"}\\n' "$(cat '${record}.uid')"; exit 0; }
  echo 'Node not found: ${DRIVE_FOLDER}' >&2; exit 1
fi
echo x >> '${record}.calls'
[ "$(wc -l < '${record}.calls')" -le ${fails} ] && { echo 'network down' >&2; exit 1; }
printf '%s\\n' "$@" > '${record}.args'
(cd "$9" && find . -type f | sort; echo --) >> '${record}.files'
[ -f '${record}.uid' ] || echo folder-1 > '${record}.uid'
echo '{"transferredItems":1,"transferredBytes":${bytes},"skippedItems":0,"failedItems":0,"failures":[]}'
`,
  );
  chmodSync(cli, 0o755);
  return cli;
}

const uploads = (record: string) => (existsSync(`${record}.files`) ? readFileSync(`${record}.files`, 'utf8').split('--\n').filter(Boolean).map((block) => block.trim().split('\n')) : []);

const hourly = { everyMs: 3_600_000, firstAfterMs: 3_600_000 };

test('a folder goes under Home in Drive when it is in the home folder, else under Computer', { skip: !posix }, () => {
  assert.deepEqual(drivePlace('/home/me/.config/hypr', '/home/me'), ['Home', '.config', 'hypr']);
  assert.deepEqual(drivePlace('/home/me', '/home/me'), ['Home']);
  assert.deepEqual(drivePlace('/mnt/data/photos', '/home/me'), ['Computer', 'mnt', 'data', 'photos']);
  assert.deepEqual(drivePlace('/home/meadow/x', '/home/me'), ['Computer', 'home', 'meadow', 'x']);
  // A name that starts with two dots is still inside the home folder.
  assert.deepEqual(drivePlace('/home/me/..archive', '/home/me'), ['Home', '..archive']);
});

test('the scan finds each file once, counts links, and leaves out caches and Kainos data', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const home = join(root, 'home');
    const rice = join(home, '.config', 'hypr');
    mkdirSync(join(rice, 'scripts'), { recursive: true });
    writeFileSync(join(rice, 'hyprland.lua'), 'config');
    writeFileSync(join(rice, 'scripts', 'run.sh'), '#!/bin/sh\n');
    symlinkSync('hyprland.lua', join(rice, 'link.lua'));
    for (const cache of ['node_modules', '__pycache__', 'venv', '.gradle']) {
      mkdirSync(join(rice, cache));
      writeFileSync(join(rice, cache, 'x'), '');
    }
    const kainosData = join(home, '.config', 'Kainos Talk');
    mkdirSync(kainosData, { recursive: true });
    writeFileSync(join(kainosData, 'Cookies'), 'secret');

    // ~/.config holds both the rice and Kainos' own data; hypr is also picked on its own.
    const scan = await scanFolders([join(home, '.config'), rice, join(root, 'gone')], { home, exclude: [kainosData] });
    assert.deepEqual([...scan.files.keys()].sort(), [join(rice, 'hyprland.lua'), join(rice, 'scripts', 'run.sh')]);
    assert.deepEqual(scan.files.get(join(rice, 'hyprland.lua'))!.place, join('Home', '.config', 'hypr', 'hyprland.lua'));
    assert.equal(scan.files.get(join(rice, 'hyprland.lua'))!.size, 6);
    assert.equal(scan.links, 1);
    assert.deepEqual(scan.missing, [join(root, 'gone')]);
    assert.equal(scan.unread, 0);

    // A folder picked inside one the outer walk skips is still read.
    mkdirSync(join(home, '.cache', 'project'), { recursive: true });
    writeFileSync(join(home, '.cache', 'project', 'keep.txt'), 'k');
    const nested = await scanFolders([join(home, '.cache', 'project'), home], { home, exclude: [kainosData] });
    assert.equal(nested.files.get(join(home, '.cache', 'project', 'keep.txt'))?.place, join('Home', '.cache', 'project', 'keep.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a skipped folder is left out of the folder around it, but a folder picked inside it is still read', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const home = join(root, 'home');
    const docs = join(home, 'Documents');
    const code = join(docs, 'Code');
    mkdirSync(join(code, 'notes'), { recursive: true });
    writeFileSync(join(docs, 'cv.pdf'), 'cv');
    writeFileSync(join(code, 'big.bin'), 'bin');
    writeFileSync(join(code, 'notes', 'todo.md'), 'todo');
    // A file whose name only starts like the skipped folder is kept.
    writeFileSync(join(docs, 'Code.txt'), 'c');
    // Reached through a link, the skipped folder is still left out.
    symlinkSync(docs, join(root, 'docs-link'));
    const skip = [join(root, 'docs-link', 'Code')];

    const scan = await scanFolders([docs], { home, exclude: [], skip });
    assert.deepEqual([...scan.files.keys()].sort(), [join(docs, 'Code.txt'), join(docs, 'cv.pdf')]);
    // Skipping the picked folder itself leaves nothing out.
    assert.equal((await scanFolders([code], { home, exclude: [], skip: [code] })).files.size, 2);
    const picked = await scanFolders([docs, join(code, 'notes')], { home, exclude: [], skip });
    assert.deepEqual([...picked.files.keys()].sort(), [join(docs, 'Code.txt'), join(code, 'notes', 'todo.md'), join(docs, 'cv.pdf')]);
    assert.deepEqual(await sizeUpTo([docs], { home, exclude: [], skip }, { bytes: 100, files: 100 }), { bytes: 3, files: 2, more: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kainos data is left out even when picked, a saved folder that became a link is not followed, and unreadable folders are counted', { skip: !posix || process.getuid?.() === 0 }, async () => {
  const root = scratch();
  try {
    const home = join(root, 'home');
    const kainosData = join(home, '.config', 'Kainos Talk');
    mkdirSync(kainosData, { recursive: true });
    writeFileSync(join(kainosData, 'Cookies'), 'secret');
    symlinkSync(kainosData, join(home, 'alias'));
    const locked = join(home, 'Documents', 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(home, 'Documents', 'ok.txt'), 'ok');
    chmodSync(locked, 0o000);
    const scan = await scanFolders([kainosData, join(home, 'alias'), join(home, 'Documents')], { home, exclude: [kainosData] });
    chmodSync(locked, 0o755);
    assert.deepEqual([...scan.files.keys()], [join(home, 'Documents', 'ok.txt')]);
    assert.equal(scan.unread, 1);
    assert.deepEqual(scan.missing, [join(home, 'alias')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the list of what went up keeps unchanged files and an unplugged disk, and drops the rest', () => {
  const found = (size: number, mtimeMs: number) => ({ place: 'x', size, mtimeMs, ino: mtimeMs });
  const before = new Map<string, Sent>([
    ['/home/me/a', [1, 10, 10]],
    ['/home/me/b', [2, 20, 20]],
    ['/home/me/c', [3, 30, 30]],
    ['/mnt/usb/d', [4, 40, 40]],
    ['/home/me/unpicked', [5, 50, 50]],
  ]);
  const scan: ScanReport = {
    files: new Map([
      ['/home/me/a', found(1, 10)], // unchanged
      ['/home/me/b', found(2, 21)], // edited and sent
      ['/home/me/c', found(9, 30)], // edited, not sent (could not be copied)
      ['/home/me/e', found(6, 60)], // new and sent
    ]),
    missing: ['/mnt/usb'],
    unread: 0,
    links: 0,
  };
  const next = nextUploaded(before, scan, new Map<string, Sent>([['/home/me/b', [2, 21, 21]], ['/home/me/e', [6, 60, 60]]]));
  assert.deepEqual(Object.fromEntries(next), { '/mnt/usb/d': [4, 40, 40], '/home/me/a': [1, 10, 10], '/home/me/b': [2, 21, 21], '/home/me/e': [6, 60, 60] });
});

test('a plain copy happens only if the disk keeps room; clones and links need none', { skip: !posix }, async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'big'), 'data');
    const full = () => Promise.resolve(false);
    assert.equal(await placeFile(join(root, 'big'), join(root, 'copy'), 4, full, ['copy']), 'no-room');
    assert.equal(existsSync(join(root, 'copy')), false);
    assert.equal(await placeFile(join(root, 'big'), join(root, 'copy'), 4, () => Promise.resolve(true), ['copy']), 'copy');
    assert.equal(readFileSync(join(root, 'copy'), 'utf8'), 'data');
    assert.equal(await placeFile(join(root, 'big'), join(root, 'linked'), 4, full, ['link', 'copy']), 'link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run reads the tool summary; a failed file, a missing session or a stop is reported', () => {
  const sent = outcomeOf(0, '{"transferredItems":3,"transferredBytes":17,"skippedItems":2,"failedItems":0,"failures":[]}', '', 5);
  assert.deepEqual(sent, { at: 5, ok: true, sentBytes: 17, failed: 0 });
  const failed = outcomeOf(1, '{"transferredItems":0,"transferredBytes":0,"skippedItems":0,"failedItems":1,"failures":[{"name":"a.txt","error":"Too big"}]}\n1 item(s) failed to upload', '', 5, { missing: ['/mnt/x'], unstaged: 0 });
  assert.deepEqual(failed, { at: 5, ok: false, sentBytes: 0, failed: 1, error: 'a.txt: Too big', failures: [{ name: 'a.txt', error: 'Too big' }], missing: ['/mnt/x'] });
  const partial = outcomeOf(0, '{"transferredItems":1,"transferredBytes":4,"skippedItems":0,"failedItems":0,"failures":[]}', '', 5, { missing: [], unstaged: 2, links: 3 });
  assert.deepEqual(partial, { at: 5, ok: false, sentBytes: 4, failed: 0, unstaged: 2, links: 3 }, 'Drive took all it got, but two items were left out');
  const linksOnly = outcomeOf(0, '{"transferredItems":1,"transferredBytes":4,"skippedItems":0,"failedItems":0,"failures":[]}', '', 5, { missing: [], unstaged: 0, links: 3 });
  assert.equal(linksOnly.ok, true, 'left-out links do not make a backup fail');
  const session = outcomeOf(1, '', 'Failed to load session from secrets (ensure you have secrets available): Could not connect\n', 5);
  assert.equal(session.signIn, true);
  assert.equal(session.ok, false);
  assert.equal(outcomeOf(1, '', 'Could not read folder authors\n', 5).signIn, undefined, 'a word such as "authors" is not a missing session');
  assert.equal(outcomeOf(2, '', '', 5).error, 'proton-drive stopped (exit 2)');
  assert.equal(outcomeOf(null, '', 'Uploading…', 5, undefined, 'Stopped after 6 hours').error, 'Stopped after 6 hours');
  assert.deepEqual(nothingSent(5, { missing: [], unstaged: 0, lowSpace: true }), { at: 5, ok: false, sentBytes: 0, failed: 0, lowSpace: true });
});

test('the menu line says when the last backup ran and what it sent', () => {
  const now = new Date(2026, 10, 23, 22, 30);
  const at = new Date(2026, 10, 23, 22, 14).getTime();
  const label = (outcome: BackupOutcome) => outcomeLabel(outcome, now, 'en-GB');
  assert.equal(outcomeLabel(undefined, now), 'Not backed up yet');
  assert.equal(label({ at, ok: true, sentBytes: 0, failed: 0 }), 'Backed up 22:14, nothing changed');
  assert.equal(label({ at, ok: true, sentBytes: 3 * 1024 * 1024, failed: 0 }), 'Backed up 22:14, 3.0 MB sent');
  assert.equal(label({ at, ok: true, sentBytes: 0, failed: 0, links: 4 }), 'Backed up 22:14, nothing changed');
  assert.equal(label({ at, ok: false, sentBytes: 0, failed: 2 }), 'Backed up 22:14, 2 file(s) failed');
  assert.equal(label({ at, ok: false, sentBytes: 0, failed: 0, error: 'spawn ENOENT', missing: ['/mnt/x'] }), 'Backup failed 22:14', 'the tool not running wins over a missing folder');
  assert.equal(label({ at, ok: false, sentBytes: 9, failed: 0, missing: ['/mnt/x'] }), 'Backed up 22:14, 1 folder(s) not found');
  assert.equal(label({ at, ok: false, sentBytes: 9, failed: 0, unstaged: 3 }), 'Backed up 22:14, 3 item(s) could not be read');
  assert.equal(label({ at, ok: false, sentBytes: 9, failed: 0, lowSpace: true, missing: ['/mnt/x'] }), 'Backed up 22:14 in part: the disk is nearly full');
  assert.equal(label({ at, ok: false, sentBytes: 0, failed: 0, error: 'x', signIn: true }), 'Not backed up (22:14): sign in to proton-drive');
  assert.equal(label({ at: new Date(2026, 10, 21, 9, 5).getTime(), ok: false, sentBytes: 0, failed: 0 }), 'Backup failed 21 Nov 09:05');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB');
});

test('the details say what failed and what was left out; each kind of problem is told apart', () => {
  const refused: BackupOutcome = {
    at: 1,
    ok: false,
    sentBytes: 0,
    failed: 4,
    error: 'a: Too big',
    failures: [
      { name: 'a', error: 'Too big' },
      { name: 'b', error: 'Bad name' },
    ],
    missing: ['/home/me/usb'],
    unstaged: 1,
    links: 2,
  };
  assert.deepEqual(outcomeDetails(refused, (path) => path.replace('/home/me', '~')), [
    'a: Too big',
    'b: Bad name',
    '2 more file(s) failed',
    'Not found: ~/usb',
    '1 item(s) could not be read',
    '2 symbolic link(s) left out: Drive takes no links',
  ]);
  assert.deepEqual(outcomeDetails({ at: 1, ok: false, sentBytes: 0, failed: 0, error: 'Failed to load session', signIn: true }), ['Run proton-drive auth login in a terminal, then Back up now.']);
  assert.deepEqual(outcomeDetails({ at: 1, ok: true, sentBytes: 0, failed: 0 }), []);
  const kinds = [
    outcomeKind({ at: 1, ok: true, sentBytes: 0, failed: 0, links: 1 }),
    outcomeKind({ at: 1, ok: false, sentBytes: 0, failed: 0, error: 'x', signIn: true }),
    outcomeKind({ at: 1, ok: false, sentBytes: 0, failed: 0, error: 'x' }),
    outcomeKind(refused),
    outcomeKind({ at: 1, ok: false, sentBytes: 0, failed: 0, lowSpace: true }),
    outcomeKind({ at: 1, ok: false, sentBytes: 0, failed: 0, missing: ['/x'] }),
    outcomeKind({ at: 1, ok: false, sentBytes: 0, failed: 0, unstaged: 1 }),
  ];
  assert.deepEqual(kinds, ['ok', 'signed-out', 'failed', 'refused', 'low-space', 'missing', 'unread']);
});

test('the tool is found on PATH or in ~/.local/bin', { skip: !posix }, () => {
  const root = scratch();
  try {
    const bin = join(root, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    assert.equal(findCli(root, { PATH: '/nonexistent' }), undefined);
    writeFileSync(join(bin, 'proton-drive'), '#!/bin/sh\n');
    chmodSync(join(bin, 'proton-drive'), 0o755);
    assert.equal(findCli(root, { PATH: '/nonexistent' }), join(bin, 'proton-drive'));
    assert.equal(findCli(root, { KAINOS_PROTON_DRIVE: '/opt/pd' }), '/opt/pd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Back up now uploads only what changed since the last run, and skips the tool when nothing did', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const home = join(root, 'home');
    const docs = join(home, 'Documents');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'note.txt'), 'hello');
    writeFileSync(join(docs, 'other.txt'), 'same');
    const record = join(root, 'record');
    const cli = fakeCli(root, record);
    const workDir = join(root, 'data', 'drive-backup');
    const outcomes: [BackupOutcome, boolean][] = [];
    const backup = startDriveBackup({ folders: () => [docs], enabled: () => true, cli: () => cli, workDir, home, pc: 'desk', exclude: [], ...hourly, onDone: (outcome, asked) => outcomes.push([outcome, asked]) });
    const run = backup.backUpNow();
    assert.equal(backup.running(), true);
    assert.equal(backup.backUpNow(), run, 'a second press joins the run already on');
    await run;
    const args = readFileSync(`${record}.args`, 'utf8').trim().split('\n');
    assert.deepEqual([...args.slice(0, 8), args[9]], ['filesystem', 'upload', '--json', '-f', 'create-new-revision', '-d', 'merge', '-t', '/my-files']);
    assert.match(args[8]!, new RegExp(`^${workDir}/stage-[^/]+/${DRIVE_FOLDER}$`));
    assert.deepEqual(outcomes.map(([outcome, asked]) => [outcome.ok, outcome.sentBytes, asked]), [[true, 5, true]]);
    assert.deepEqual(readdirSync(workDir), ['uploaded.json'], 'the copy is removed after the run; the list of what went up stays');
    assert.deepEqual([(await readUploaded(workDir)).files.size, (await readUploaded(workDir)).destination], [2, 'folder-1']);

    // Nothing changed: the tool does not run.
    await backup.backUpNow();
    assert.equal(uploads(record).length, 1);
    assert.deepEqual(outcomes[1]![0], { at: outcomes[1]![0].at, ok: true, sentBytes: 0, failed: 0 });

    // One file edited, one added: only those two go up.
    writeFileSync(join(docs, 'note.txt'), 'hello again');
    writeFileSync(join(docs, 'new.txt'), 'new');
    await backup.backUpNow();
    assert.deepEqual(uploads(record), [
      ['./desk/Home/Documents/note.txt', './desk/Home/Documents/other.txt'],
      ['./desk/Home/Documents/new.txt', './desk/Home/Documents/note.txt'],
    ]);

    // Same size, modification time set back by a restore that wrote a new file: its inode tells.
    const before = statSync(join(docs, 'other.txt'));
    writeFileSync(join(docs, 'restored.tmp'), 'SAME');
    utimesSync(join(docs, 'restored.tmp'), before.atime, before.mtime);
    renameSync(join(docs, 'restored.tmp'), join(docs, 'other.txt'));
    await backup.backUpNow();
    assert.deepEqual(uploads(record)[2], ['./desk/Home/Documents/other.txt']);

    // Another account, or the PC's folder trashed: a new folder uid, and everything goes up again.
    writeFileSync(`${record}.uid`, 'folder-2');
    await backup.backUpNow();
    backup.stop();
    assert.equal(uploads(record)[3]!.length, 3);
    assert.equal((await readUploaded(workDir)).destination, 'folder-2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each run reads the skipped folders afresh', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const docs = join(root, 'Documents');
    mkdirSync(join(docs, 'Code'), { recursive: true });
    writeFileSync(join(docs, 'a.txt'), 'a');
    writeFileSync(join(docs, 'Code', 'b.txt'), 'b');
    const record = join(root, 'record');
    const cli = fakeCli(root, record);
    let skip: string[] = [join(docs, 'Code')];
    const backup = startDriveBackup({ folders: () => [docs], skip: () => skip, enabled: () => true, cli: () => cli, workDir: join(root, 'work'), home: root, pc: 'desk', exclude: [], ...hourly, onDone: () => {} });
    await backup.backUpNow();
    skip = [];
    await backup.backUpNow();
    backup.stop();
    assert.deepEqual(uploads(record), [['./desk/Home/Documents/a.txt'], ['./desk/Home/Documents/Code/b.txt']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('after a failed upload, the next run sends the changed files again', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    writeFileSync(join(docs, 'a.txt'), 'a');
    const record = join(root, 'record');
    const cli = fakeCli(root, record, { fails: 1 });
    const outcomes: BackupOutcome[] = [];
    const backup = startDriveBackup({ folders: () => [docs], enabled: () => true, cli: () => cli, workDir: join(root, 'work'), home: root, pc: 'desk', exclude: [], ...hourly, onDone: (outcome) => outcomes.push(outcome) });
    await backup.backUpNow();
    await backup.backUpNow();
    await backup.backUpNow();
    backup.stop();
    assert.deepEqual(outcomes.map((outcome) => [outcome.ok, outcome.error]), [
      [false, 'network down'],
      [true, undefined],
      [true, undefined],
    ]);
    assert.equal(uploads(record).length, 1, 'the third run had nothing new to send');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run stops when the Drive tab is turned off during its upload, and a linked work folder is never written', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    writeFileSync(join(docs, 'a.txt'), 'a');
    const started = join(root, 'started');
    const cli = join(root, 'proton-drive');
    writeFileSync(cli, `#!/bin/sh\necho x >> '${started}'\nexec sleep 30\n`);
    chmodSync(cli, 0o755);
    let on = true;
    const outcomes: BackupOutcome[] = [];
    const base = { folders: () => [docs], enabled: () => on, cli: () => cli, home: root, pc: 'desk', exclude: [], ...hourly, onDone: (outcome: BackupOutcome) => outcomes.push(outcome) };
    const backup = startDriveBackup({ ...base, workDir: join(root, 'work') });
    const run = backup.backUpNow();
    await until(() => existsSync(started));
    on = false;
    const begun = Date.now();
    await run;
    backup.stop();
    assert.ok(Date.now() - begun < 5_000, 'the upload was stopped, not waited out');
    assert.deepEqual(outcomes, []);

    // A work folder that is a link: the run fails, and the list behind the link is untouched.
    on = true;
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'uploaded.json'), 'theirs');
    symlinkSync(elsewhere, join(root, 'linked'));
    const results: BackupOutcome[] = [];
    const linked = startDriveBackup({ ...base, workDir: join(root, 'linked'), onDone: (outcome) => results.push(outcome) });
    await linked.backUpNow();
    linked.stop();
    assert.match(results[0]?.error ?? '', /^Could not prepare the backup/);
    assert.equal(readFileSync(join(elsewhere, 'uploaded.json'), 'utf8'), 'theirs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs repeat on their own, each counted from the end of the last', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    writeFileSync(join(docs, 'a.txt'), 'a');
    const record = join(root, 'record');
    const cli = fakeCli(root, record);
    const outcomes: [BackupOutcome, boolean][] = [];
    const backup = startDriveBackup({ folders: () => [docs], enabled: () => true, cli: () => cli, workDir: join(root, 'work'), home: root, pc: 'desk', exclude: [], everyMs: 30, firstAfterMs: 10, onDone: (outcome, asked) => outcomes.push([outcome, asked]) });
    await until(() => outcomes.length >= 3);
    backup.stop();
    assert.deepEqual(outcomes.slice(0, 3).map(([outcome, asked]) => [outcome.sentBytes, asked]), [[5, false], [0, false], [0, false]]);
    assert.equal(uploads(record).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cancel ends an upload without a result, and a folder added during a run gets a run of its own', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    writeFileSync(join(docs, 'a.txt'), 'a');
    const started = join(root, 'started');
    const cli = join(root, 'proton-drive');
    writeFileSync(cli, `#!/bin/sh\necho x >> '${started}'\nexec sleep 30\n`);
    chmodSync(cli, 0o755);
    const workDir = join(root, 'work');
    const outcomes: BackupOutcome[] = [];
    const options: DriveBackupOptions = { folders: () => [docs], enabled: () => true, cli: () => cli, workDir, home: root, pc: 'desk', exclude: [], ...hourly, onDone: (outcome) => outcomes.push(outcome) };
    const backup = startDriveBackup(options);
    const run = backup.backUpNow();
    await until(() => existsSync(started));
    backup.foldersChanged();
    backup.cancel();
    await run;
    assert.equal(backup.running(), false, 'Cancel also drops the run a new folder asked for');
    assert.deepEqual(outcomes, []);
    assert.deepEqual(readdirSync(workDir), [], 'no copy left, and nothing marked as uploaded');
    backup.stop();

    // A folder added while a run is on: once it ends, another starts.
    const record = join(root, 'record');
    const quick = fakeCli(root, record);
    const again = startDriveBackup({ ...options, cli: () => quick });
    const first = again.backUpNow();
    again.foldersChanged();
    await first;
    assert.equal(again.running(), true);
    await until(() => outcomes.length === 2);
    again.stop();
    assert.equal(uploads(record).length, 1, 'the second run had nothing new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nothing runs without the tool or without folders', async () => {
  const outcomes: BackupOutcome[] = [];
  const base = { enabled: () => true, workDir: join(tmpdir(), 'kainos-never'), home: tmpdir(), pc: 'desk', exclude: [], ...hourly, onDone: (o: BackupOutcome) => outcomes.push(o) };
  const noCli = startDriveBackup({ ...base, folders: () => [tmpdir()], cli: () => undefined });
  await noCli.backUpNow();
  noCli.stop();
  const noFolders = startDriveBackup({ ...base, folders: () => [], cli: () => '/bin/false' });
  await noFolders.backUpNow();
  noFolders.stop();
  assert.deepEqual(outcomes, []);
});

test('a run starts from an empty copy: only Kainos-marked leftovers go, and a linked work folder is refused', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const workDir = join(root, 'drive-backup');
    const old = await freshStage(workDir);
    mkdirSync(join(old, 'x'));
    mkdirSync(join(workDir, 'stage-manual'));
    writeFileSync(join(workDir, 'stage-manual', 'mine.txt'), 'not Kainos');
    // A removal cut short after the files went keeps the mark, so it is finished at the next start.
    const half = await freshStage(workDir);
    mkdirSync(join(half, DRIVE_FOLDER, 'desk'), { recursive: true });
    const stage = await freshStage(workDir);
    assert.deepEqual(readdirSync(workDir).sort(), [stage.slice(workDir.length + 1), 'stage-manual'].sort());
    // A work folder that is a link could lead the clean-up to another disk.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'stage-keep'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'linked'));
    await assert.rejects(freshStage(join(root, 'linked')));
    assert.ok(existsSync(join(elsewhere, 'stage-keep')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run that cannot make its copy ends as a failed backup instead of throwing', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const workDir = join(root, 'not-a-folder');
    writeFileSync(workDir, '');
    writeFileSync(join(root, 'a.txt'), 'a');
    const outcomes: BackupOutcome[] = [];
    const backup = startDriveBackup({ folders: () => [root], enabled: () => true, cli: () => '/bin/true', workDir, home: root, pc: 'desk', exclude: [], ...hourly, onDone: (outcome) => outcomes.push(outcome) });
    await backup.backUpNow();
    backup.stop();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.ok, false);
    assert.match(outcomes[0]!.error ?? '', /^Could not prepare the backup/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('turning the Drive tab off during a run stops even Back up now before its upload', { skip: !posix }, async () => {
  const root = scratch();
  try {
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    for (let i = 0; i < 50; i += 1) writeFileSync(join(docs, `f${i}.txt`), String(i));
    const ran = join(root, 'ran');
    const cli = join(root, 'proton-drive');
    writeFileSync(cli, `#!/bin/sh\ntouch '${ran}'\n`);
    chmodSync(cli, 0o755);
    let on = true;
    const outcomes: BackupOutcome[] = [];
    const workDir = join(root, 'work');
    const backup = startDriveBackup({ folders: () => [docs], enabled: () => on, cli: () => cli, workDir, home: root, pc: 'desk', exclude: [], ...hourly, onDone: (outcome) => outcomes.push(outcome) });
    const run = backup.backUpNow();
    on = false;
    await run;
    backup.stop();
    assert.equal(existsSync(ran), false);
    assert.deepEqual(outcomes, []);
    assert.deepEqual(existsSync(workDir) ? readdirSync(workDir) : [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the size of a first backup is counted as the backup reads it, stopping past a limit', { skip: !posix }, async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'docs', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'docs', 'node_modules', 'big'), 'x'.repeat(1000));
    for (let i = 0; i < 5; i += 1) writeFileSync(join(root, 'docs', `f${i}`), 'abcd');
    const place = { home: root, exclude: [] };
    assert.deepEqual(await sizeUpTo([join(root, 'docs'), join(root, 'docs')], place, { bytes: 100, files: 100 }), { bytes: 20, files: 5, more: false });
    const capped = await sizeUpTo([join(root, 'docs')], place, { bytes: 100, files: 2 });
    assert.equal(capped.more, true);
    assert.equal(capped.files, 3, 'counting stops at the first file past the limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
