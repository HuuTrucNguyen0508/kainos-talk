// Files between the PC and the phone, one at a time each way, over the phone's sync connection
// (protocol 6, docs/share-clipboard-plan.md). A file arrives under a hidden name in the downloads
// folder and takes its own name only once all of it is there; nothing is ever overwritten.

import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { MAX_CHUNK_BYTES, MAX_FILE_BYTES, safeFileName, type PhoneFrame, type TransferFrame } from '../shared/sync-protocol.ts';

/** The frames of a file transfer, either way. */
export type FileFrame = Exclude<TransferFrame, { readonly t: 'clip' }>;

export const isFileFrame = (frame: PhoneFrame): frame is FileFrame =>
  frame.t === 'fileOffer' || frame.t === 'fileChunk' || frame.t === 'fileEnd' || frame.t === 'fileResult' || frame.t === 'fileCancel';

/** The phone's connection, as transfers use it. */
export interface TransferWire {
  /** False once the socket's buffer is full: wait for `drained` before the next chunk. */
  send(frame: FileFrame): boolean;
  /** Resolves once the socket can take more, or has closed. */
  drained(): Promise<void>;
  /** Stops reading from the phone while the disk catches up, and starts again. */
  pause(): void;
  resume(): void;
}

/** How one file ended. `name` is what the user knows it by; `path` where it is on this PC. */
export type FileOutcome =
  | { readonly ok: true; readonly name: string; readonly path: string }
  | { readonly ok: false; readonly name: string; readonly error: string };

export interface TransferOptions {
  readonly wire: TransferWire;
  /** Where received files go, asked when each one starts: the folder the user chose. */
  readonly dir: () => string;
  readonly onReceived: (outcome: FileOutcome) => void;
  readonly onSent: (outcome: FileOutcome) => void;
}

export interface Transfers {
  receive(frame: FileFrame): void;
  /** Queues files for the phone; they go one at a time, in order. */
  send(paths: readonly string[]): void;
  /** The connection dropped: every file in flight fails, and partial files are deleted. */
  close(): void;
}

/** A sent file the phone has not answered for this long after its last byte counts as failed. */
const RESULT_TIMEOUT_MS = 60_000;
/** Received bytes waiting for the disk: above the first, reading from the phone pauses until the second. */
const PAUSE_ABOVE = 8 * 1024 * 1024;
const RESUME_BELOW = 2 * 1024 * 1024;
const GONE = 'phone disconnected';

/** The file being received: at most one, written to `tempPath` in order along `written`. */
interface Incoming {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  /** The folder it goes to, fixed when it starts so its temporary file sits beside it. */
  readonly dir: string;
  received: number;
  /** Bytes received and not on disk yet. */
  queued: number;
  readonly tempPath: string;
  handle: FileHandle | undefined;
  /** Opening the file, then every write, in order. Rejects once one of them failed. */
  written: Promise<void>;
  finishing?: Promise<void>;
}

/** The file being sent. `end` settles it once, whatever ends it first. */
interface Outgoing {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly end: (outcome: FileOutcome) => void;
  ended: boolean;
}

const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/**
 * The name a received file can have on this system: Windows refuses some characters and names,
 * and a name has at most 255 bytes, ` (n)` included.
 */
export function localFileName(name: string, copy: number, platform: NodeJS.Platform = process.platform): string {
  let local = name;
  if (platform === 'win32') {
    local = local.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '') || 'file';
    if (RESERVED_ON_WINDOWS.test(local)) local = `_${local}`;
  }
  let ext = extname(local);
  if (Buffer.byteLength(ext) > 32) ext = '';
  let stem = [...local.slice(0, local.length - ext.length)];
  const suffix = copy === 0 ? '' : ` (${copy})`;
  while (stem.length > 1 && Buffer.byteLength(`${stem.join('')}${suffix}${ext}`) > 255) stem.pop();
  return `${stem.join('')}${suffix}${ext}`;
}

/** Publishes under the first free name. The caller still owns the temporary file. */
async function place(tempPath: string, dir: string, name: string, isCurrent: () => boolean): Promise<string | undefined> {
  for (let copy = 0; copy < 10_000; copy++) {
    if (!isCurrent()) return undefined;
    const target = join(dir, localFileName(name, copy));
    try {
      try {
        await link(tempPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        if (!isCurrent()) return undefined;
        // Some file systems, such as FAT, do not support hard links.
        await copyFile(tempPath, target, constants.COPYFILE_EXCL);
      }
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('too many files with this name');
}

const MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.odt': 'application/vnd.oasis.opendocument.text',
};

const reason = (error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'disk full' : (error as Error).message).slice(0, 100);

export function createTransfers({ wire, dir, onReceived, onSent }: TransferOptions): Transfers {
  let closed = false;
  let incoming: Incoming | undefined;
  let paused = false;
  const queue: string[] = [];
  let outgoing: Outgoing | undefined;

  const flowAgain = () => {
    if (paused && (incoming?.queued ?? 0) < RESUME_BELOW) {
      paused = false;
      wire.resume();
    }
  };

  /** Ends the open file without keeping it. `tell` sends the phone a `fileCancel`. */
  function drop(file: Incoming, error: string, tell: boolean): void {
    if (incoming !== file) return;
    incoming = undefined;
    flowAgain();
    if (tell) wire.send({ t: 'fileCancel', id: file.id });
    void (file.finishing ?? file.written)
      .catch(() => undefined)
      .then(() => file.handle?.close())
      .catch(() => undefined)
      .then(() => unlink(file.tempPath))
      .catch(() => undefined);
    onReceived({ ok: false, name: file.name, error });
  }

  function offered(frame: Extract<FileFrame, { t: 'fileOffer' }>): void {
    // A new offer while one is open: the phone gave up on the open one.
    if (incoming) drop(incoming, 'replaced by another file', false);
    const target = dir();
    const file: Incoming = {
      id: frame.id,
      name: safeFileName(frame.name),
      size: frame.size,
      dir: target,
      received: 0,
      queued: 0,
      tempPath: join(target, `.kainos-${randomBytes(8).toString('hex')}.part`),
      handle: undefined,
      written: Promise.resolve(),
    };
    file.written = mkdir(target, { recursive: true })
      .then(() => open(file.tempPath, 'wx', 0o600))
      .then((handle) => {
        file.handle = handle;
      });
    void file.written.catch((error: unknown) => {
      if (!file.finishing) drop(file, reason(error), true);
    });
    incoming = file;
  }

  function chunk(file: Incoming, data: string): void {
    const bytes = Buffer.from(data, 'base64');
    file.received += bytes.length;
    if (file.received > file.size) return drop(file, 'more bytes than offered', true);
    file.queued += bytes.length;
    if (!paused && file.queued > PAUSE_ABOVE) {
      paused = true;
      wire.pause();
    }
    file.written = file.written.then(async () => {
      for (let offset = 0; offset < bytes.length; ) {
        const { bytesWritten } = await file.handle!.write(bytes, offset, bytes.length - offset);
        if (bytesWritten === 0) throw new Error('disk write made no progress');
        offset += bytesWritten;
      }
      file.queued -= bytes.length;
      if (incoming === file) flowAgain();
    });
    void file.written.catch((error: unknown) => {
      if (!file.finishing) drop(file, reason(error), true);
    });
  }

  function finish(file: Incoming): void {
    if (file.received !== file.size) {
      drop(file, 'the file arrived incomplete', false);
      wire.send({ t: 'fileResult', id: file.id, ok: false, error: 'not all bytes arrived' });
      return;
    }
    const isCurrent = () => incoming === file;
    file.finishing = file.written.then(async () => {
      if (!isCurrent()) return;
      await file.handle!.close();
      file.handle = undefined;
      const path = await place(file.tempPath, file.dir, file.name, isCurrent);
      if (path === undefined) return;
      // Published: the whole file is in place and from here on belongs to the user, so a late
      // cancel or drop only loses the answer. Only the temporary file is ours to clean up.
      await unlink(file.tempPath).catch(() => undefined);
      if (!isCurrent()) return;
      incoming = undefined;
      flowAgain();
      wire.send({ t: 'fileResult', id: file.id, ok: true, error: null });
      onReceived({ ok: true, name: basename(path), path });
    });
    void file.finishing.catch((error: unknown) => {
      if (!isCurrent()) return;
      const message = reason(error);
      drop(file, message, false);
      wire.send({ t: 'fileResult', id: file.id, ok: false, error: message });
    });
  }

  /** Sends one file and waits for the phone's answer. */
  async function sendOne(file: Outgoing, settled: Promise<FileOutcome>): Promise<FileOutcome> {
    let handle: FileHandle | undefined;
    let offeredIt = false;
    try {
      handle = await open(file.path, 'r');
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('not a file');
      if (info.size > MAX_FILE_BYTES) throw new Error('larger than 2 GiB');
      if (file.ended) return settled;
      wire.send({ t: 'fileOffer', id: file.id, name: file.name, size: info.size, mime: MIME[extname(file.name).toLowerCase()] ?? null });
      offeredIt = true;
      const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
      for (let sent = 0; sent < info.size; ) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(MAX_CHUNK_BYTES, info.size - sent), sent);
        if (file.ended) return settled;
        if (bytesRead === 0) throw new Error('the file got shorter while it was sent');
        sent += bytesRead;
        if (!wire.send({ t: 'fileChunk', id: file.id, data: buffer.toString('base64', 0, bytesRead) })) await wire.drained();
      }
      if (file.ended) return settled;
      wire.send({ t: 'fileEnd', id: file.id });
      const timer = setTimeout(() => file.end({ ok: false, name: file.name, error: 'no answer from the phone' }), RESULT_TIMEOUT_MS);
      void settled.finally(() => clearTimeout(timer));
    } catch (error) {
      if (offeredIt && !file.ended) wire.send({ t: 'fileCancel', id: file.id });
      file.end({ ok: false, name: file.name, error: reason(error) });
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return settled;
  }

  function next(): void {
    if (outgoing || closed) return;
    const path = queue.shift();
    if (path === undefined) return;
    let end!: (outcome: FileOutcome) => void;
    const settled = new Promise<FileOutcome>((resolve) => (end = resolve));
    const file: Outgoing = {
      id: randomUUID(),
      path,
      name: basename(path),
      ended: false,
      end: (outcome) => {
        if (file.ended) return;
        file.ended = true;
        end(outcome);
      },
    };
    outgoing = file;
    void sendOne(file, settled).then((outcome) => {
      outgoing = undefined;
      onSent(outcome);
      next();
    });
  }

  return {
    receive(frame) {
      if (closed) return;
      const file = incoming?.id === frame.id ? incoming : undefined;
      switch (frame.t) {
        case 'fileOffer':
          return offered(frame);
        case 'fileChunk':
          // Only chunks for the open file count.
          if (file && !file.finishing) chunk(file, frame.data);
          return;
        case 'fileEnd':
          if (file) {
            if (!file.finishing) finish(file);
            return;
          }
          // Nothing open by that id (cancelled, say): the phone still waits for an answer.
          wire.send({ t: 'fileResult', id: frame.id, ok: false, error: 'no such file' });
          return;
        case 'fileCancel':
          if (file) drop(file, 'cancelled on the phone', false);
          if (outgoing?.id === frame.id) outgoing.end({ ok: false, name: outgoing.name, error: 'cancelled on the phone' });
          return;
        case 'fileResult':
          if (outgoing?.id === frame.id) outgoing.end(frame.ok ? { ok: true, name: outgoing.name, path: outgoing.path } : { ok: false, name: outgoing.name, error: frame.error ?? 'failed' });
          return;
      }
    },
    send(paths) {
      if (closed) return;
      queue.push(...paths);
      next();
    },
    close() {
      if (closed) return;
      closed = true;
      if (incoming) drop(incoming, GONE, false);
      for (const path of queue.splice(0)) onSent({ ok: false, name: basename(path), error: GONE });
      outgoing?.end({ ok: false, name: outgoing.name, error: GONE });
    },
  };
}
