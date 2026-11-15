import { randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { announce } from './mdns.ts';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import {
  MAX_FRAME_BYTES,
  SYNC_PORT,
  SYNC_SERVICE,
  SYNC_VERSION,
  frameHash,
  isLocalAddress,
  pairingCode,
  parsePhoneFrame,
  type PcFrame,
  type PhoneFrame,
  type MailAction,
  type SyncConversation,
  type SyncMail,
  type SyncMessage,
} from '../shared/sync-protocol.ts';
import type { SmsState } from '../shared/sms.ts';

export interface SmsSyncOptions {
  /** Where the certificate and the paired phone are kept. */
  readonly dir: string;
  readonly port?: number;
  /** Advertise the PC on the network with mDNS. */
  readonly advertise?: boolean;
  readonly onChange: () => void;
  /** A message arrived that the user has not seen. */
  readonly onIncoming: (conversation: SyncConversation, message: SyncMessage) => void;
  /** A mail arrived that the user has not seen. */
  readonly onMail?: (mail: SyncMail) => void;
}

export interface SmsSync {
  state(): SmsState;
  /** Sends a reply through the phone; false when no phone is connected. */
  reply(key: string, text: string): boolean;
  markRead(key: string): void;
  /** Asks the phone to archive, trash or mark a mail read through the mail app; false when offline. */
  mailAction(key: string, action: MailAction): boolean;
  answerPairing(accept: boolean): void;
  forgetPhone(): void;
  /** Sends a new text to a number through the phone; false when no phone is connected. */
  send(to: string, text: string): boolean;
  /** A picture from a message (JPEG bytes); fetched from the phone once, then cached. */
  image(id: string): Promise<Buffer | null>;
  /** Closes the server and every connection. */
  stop(): Promise<void>;
}

interface PairedPhone {
  readonly id: string;
  readonly name: string;
  /** SHA-256 of the phone's own certificate: the only one it may connect with. */
  readonly fingerprint: string;
}

interface Tls {
  readonly key: string;
  readonly cert: string;
}

const PAIRING_TIMEOUT_MS = 120_000;
/** The failures and pending map's key for a new text (not a conversation). */
const NEW_TEXT = '\u0000new';
const REPLY_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 20_000;
/** Bytes of pictures kept in memory; the oldest go first. */
const IMAGE_CACHE_BYTES = 24 * 1024 * 1024;
/** Under the phone's 90 s read timeout; each ping wakes the phone's Wi-Fi, so no more often. */
const PING_EVERY_MS = 60_000;
/** The phone answers a ping at once; none within this long and it is gone (the PC mutes the sites' own notifications while it is thought connected). */
const PONG_GRACE_MS = 20_000;
/** A connection that is not a connected phone (pairing, or one that never said hello) and went quiet. */
const DEAD_AFTER_MS = 150_000;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Written through a temporary file, readable by this user only. */
function writeJson(file: string, value: unknown): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}


async function loadTls(dir: string): Promise<Tls> {
  const file = join(dir, 'tls.json');
  const saved = readJson<Tls>(file);
  if (saved?.key && saved.cert) return saved;
  const { generate } = await import('selfsigned');
  const notBeforeDate = new Date(Date.now() - 86_400_000);
  const notAfterDate = new Date(notBeforeDate.getTime() + 20 * 365 * 86_400_000);
  const pems = await generate([{ name: 'commonName', value: 'Kainos Talk' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
  });
  const tls = { key: pems.private, cert: pems.cert };
  writeJson(file, tls);
  return tls;
}

/** One line-delimited JSON connection. */
class Line {
  private buffer = '';
  readonly socket: TLSSocket;
  constructor(socket: TLSSocket, onFrame: (frame: PhoneFrame, line: string) => void) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_FRAME_BYTES) return socket.destroy();
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const frame = parsePhoneFrame(line);
        if (!frame) return socket.destroy();
        onFrame(frame, line);
      }
    });
  }
  send(frame: PcFrame): void {
    if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(frame)}\n`);
  }
}

/**
 * The PC end of SMS sync: a TLS server on the local network that the paired phone connects to.
 * Texts are kept in memory only. They outlive a dropped connection: the welcome tells the phone
 * what is held, and the phone sends only what changed.
 */
export async function startSmsSync(options: SmsSyncOptions): Promise<SmsSync> {
  mkdirSync(options.dir, { recursive: true });
  const tls = await loadTls(options.dir);
  const fingerprint = new X509Certificate(tls.cert).fingerprint256.replaceAll(':', '');
  const phoneFile = join(options.dir, 'phone.json');
  // A phone paired before certificates (protocol 1, a shared secret) must pair again.
  let phone = readJson<PairedPhone>(phoneFile) ?? undefined;
  if (phone && !phone.fingerprint) phone = undefined;
  const port = options.port ?? SYNC_PORT;

  let listenError: string | undefined;
  let connection: Line | undefined;
  let connectedAt = 0;
  let pairing:
    | { line: Line; device: string; code: string; phoneFingerprint: string; pcAccepted: boolean; phoneConfirmed: boolean; timer: NodeJS.Timeout }
    | undefined;

  /** Pairing ends once the user confirmed the code on both screens. */
  function finishPairing(): void {
    if (!pairing || !pairing.pcAccepted || !pairing.phoneConfirmed) return changed();
    const { line, device, phoneFingerprint } = pairing;
    phone = { id: randomUUID(), name: device, fingerprint: phoneFingerprint };
    writeJson(phoneFile, phone);
    connection?.socket.destroy();
    conversations.clear();
    mails.clear();
    hashes.clear();
    line.send({ t: 'paired', deviceId: phone.id });
    line.socket.end();
    endPairing();
  }
  const conversations = new Map<string, SyncConversation>();
  const mails = new Map<string, SyncMail>();
  /**
   * The `frameHash` of the frame each conversation and mail came in, by `conv:` or `mail:` and
   * its key. One changed here (marked read) has none, so the phone sends it again.
   */
  const hashes = new Map<string, string>();
  const seen = new Set<string>();
  const replies = new Map<string, { key: string; timer: NodeJS.Timeout }>();
  const failures = new Map<string, string>();
  /** Recent pictures, oldest first, so the cache can drop the oldest. */
  const images = new Map<string, Buffer>();
  let imageBytes = 0;
  const imageWaiters = new Map<string, ((picture: Buffer | null) => void)[]>();

  // A reconnect brings the whole inbox as one frame per conversation; the app hears of it once.
  let changeQueued: NodeJS.Immediate | undefined;
  const changed = () => {
    changeQueued ??= setImmediate(() => {
      changeQueued = undefined;
      options.onChange();
    });
  };
  const sockets = new Set<TLSSocket>();
  let withdraw: (() => Promise<void>) | undefined;

  function endPairing(): void {
    if (!pairing) return;
    clearTimeout(pairing.timer);
    pairing = undefined;
    changed();
  }

  function receive(frame: PhoneFrame, line: string): void {
    if (frame.t === 'conversation') {
      const { conversation } = frame;
      conversations.set(conversation.key, conversation);
      hashes.set(`conv:${conversation.key}`, frameHash(line));
      for (const message of conversation.messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        // Texts the phone sends again on connecting are old news; only new ones notify.
        if (!message.outgoing && message.timeMs >= connectedAt - 30_000) options.onIncoming(conversation, message);
      }
      failures.delete(conversation.key);
    } else if (frame.t === 'image') {
      const picture = frame.data ? Buffer.from(frame.data, 'base64') : null;
      if (picture) {
        imageBytes += picture.length - (images.get(frame.id)?.length ?? 0);
        images.delete(frame.id);
        images.set(frame.id, picture);
        while (imageBytes > IMAGE_CACHE_BYTES) {
          const [oldest, bytes] = images.entries().next().value!;
          images.delete(oldest);
          imageBytes -= bytes.length;
        }
      }
      for (const done of imageWaiters.get(frame.id) ?? []) done(picture);
      imageWaiters.delete(frame.id);
      return;
    } else if (frame.t === 'mail') {
      const { mail } = frame;
      const fresh = !mails.has(mail.key) && !mail.read && mail.timeMs >= connectedAt - 30_000;
      mails.set(mail.key, mail);
      hashes.set(`mail:${mail.key}`, frameHash(line));
      if (fresh) options.onMail?.(mail);
    } else if (frame.t === 'mailRemoved') {
      mails.delete(frame.key);
      hashes.delete(`mail:${frame.key}`);
    } else if (frame.t === 'removed') {
      conversations.delete(frame.key);
      hashes.delete(`conv:${frame.key}`);
    } else if (frame.t === 'replyResult') {
      const pending = replies.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      replies.delete(frame.id);
      if (!frame.ok) failures.set(pending.key, frame.error ?? 'failed');
    }
    changed();
  }

  // Each phone proves itself with its own self-signed certificate, checked against the one it
  // paired with, so no CA is involved and no shared secret exists.
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false }, (socket) => {
    if (!isLocalAddress(socket.remoteAddress ?? '')) return socket.destroy();
    const peer = socket.getPeerX509Certificate();
    if (!peer) return socket.destroy();
    const phoneFingerprint = peer.fingerprint256.replaceAll(':', '');
    sockets.add(socket);
    let lastHeard = Date.now();
    let pongDue: NodeJS.Timeout | undefined;
    let pongPending = false;
    const armPongGrace = () => {
      clearTimeout(pongDue);
      pongDue = setTimeout(() => socket.destroy(), PONG_GRACE_MS);
    };
    let role: 'unknown' | 'pairing' | 'phone' = 'unknown';
    const first = setTimeout(() => role === 'unknown' && socket.destroy(), 10_000);
    const line: Line = new Line(socket, (frame, text) => {
      lastHeard = Date.now();
      pongPending = false;
      clearTimeout(pongDue);
      if (role === 'phone') return receive(frame, text);
      if (role === 'pairing') {
        if (frame.t === 'pairConfirm' && pairing?.line === line) {
          pairing.phoneConfirmed = true;
          finishPairing();
        }
        return;
      }
      clearTimeout(first);
      if (frame.t === 'pair' && frame.v === SYNC_VERSION) {
        if (pairing) {
          line.send({ t: 'pairRefused' });
          return socket.end();
        }
        role = 'pairing';
        const pcNonce = randomBytes(16).toString('base64');
        const code = pairingCode(fingerprint, phoneFingerprint, frame.nonce, pcNonce);
        line.send({ t: 'pairCode', nonce: pcNonce });
        pairing = {
          line,
          device: frame.device,
          code,
          phoneFingerprint,
          pcAccepted: false,
          phoneConfirmed: false,
          timer: setTimeout(() => {
            line.send({ t: 'pairRefused' });
            socket.end();
            endPairing();
          }, PAIRING_TIMEOUT_MS),
        };
        changed();
        return;
      }
      if (frame.t === 'hello' && frame.v === SYNC_VERSION && phone && frame.deviceId === phone.id) {
        if (timingSafeEqual(Buffer.from(phoneFingerprint), Buffer.from(phone.fingerprint))) {
          role = 'phone';
          connection?.socket.destroy();
          connection = line;
          connectedAt = Date.now();
          const held = (kind: string, keys: Iterable<string>) => Object.fromEntries([...keys].map((key) => [key, hashes.get(`${kind}:${key}`) ?? '']));
          line.send({ t: 'welcome', name: hostname(), conversations: held('conv', conversations.keys()), mails: held('mail', mails.keys()) });
          changed();
          return;
        }
      }
      // A different protocol version is not a forgotten phone: the phone keeps trying, and
      // reconnects once both apps are updated.
      const wrongVersion = (frame.t === 'hello' || frame.t === 'pair') && frame.v !== SYNC_VERSION;
      line.send({ t: 'denied', reason: wrongVersion ? 'version' : frame.t === 'hello' ? 'unknown phone' : 'unsupported' });
      socket.end();
    });
    const ping = setInterval(() => {
      if (Date.now() - lastHeard > DEAD_AFTER_MS) return socket.destroy();
      if (role !== 'phone') return;
      line.send({ t: 'ping' });
      // A whole frame from the phone, the pong included, cancels this; so does a pause in the data
      // shorter than the grace, since a big picture on a slow link is a frame still arriving.
      pongPending = true;
      armPongGrace();
    }, PING_EVERY_MS);
    // Any data is a sign of life, not only a whole frame: a picture on a slow link can take longer
    // than DEAD_AFTER_MS to arrive.
    socket.on('data', () => {
      lastHeard = Date.now();
      if (pongPending) armPongGrace();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      clearInterval(ping);
      clearTimeout(pongDue);
      clearTimeout(first);
      if (pairing?.line === line) endPairing();
      if (connection === line) {
        connection = undefined;
        for (const [id, pending] of replies) {
          clearTimeout(pending.timer);
          failures.set(pending.key, 'phone disconnected');
          replies.delete(id);
        }
        changed();
      }
    });
  });
  server.on('tlsClientError', () => undefined);
  server.on('error', (error: NodeJS.ErrnoException) => {
    listenError = error.code === 'EADDRINUSE' ? `port ${port} is in use` : error.message;
    changed();
  });
  server.listen(port, '::');

  let stopped = false;
  if (options.advertise !== false) {
    // The phone finds this PC by its certificate fingerprint, never by a remembered address:
    // the router may hand the PC a new one at any time. The window does not wait for it.
    announce({ name: `Kainos Talk on ${hostname()}`, type: SYNC_SERVICE, port, txt: { v: String(SYNC_VERSION), fp: fingerprint } }).then(
      (done) => {
        if (stopped) void done();
        else withdraw = done;
      },
      (error: unknown) => console.warn('SMS sync: not announced on the network', error),
    );
  }

  return {
    state(): SmsState {
      return {
        name: hostname(),
        listening: listenError ? { ok: false, error: listenError } : { ok: true, port },
        phone: phone ? { name: phone.name, connected: connection !== undefined } : null,
        pairing: pairing ? { device: pairing.device, code: pairing.code, pcAccepted: pairing.pcAccepted, phoneConfirmed: pairing.phoneConfirmed } : null,
        conversations: [...conversations.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs),
        mails: [...mails.values()].sort((a, b) => b.timeMs - a.timeMs),
        sending: [...new Set([...replies.values()].map((pending) => pending.key))],
        failures: Object.fromEntries([...failures].filter(([key]) => key !== NEW_TEXT)),
        newText: { sending: [...replies.values()].some((pending) => pending.key === NEW_TEXT), failure: failures.get(NEW_TEXT) ?? null },
      };
    },
    reply(key, text) {
      if (!connection || !conversations.has(key)) return false;
      const id = randomUUID();
      failures.delete(key);
      replies.set(id, {
        key,
        timer: setTimeout(() => {
          replies.delete(id);
          failures.set(key, 'no answer from the phone');
          changed();
        }, REPLY_TIMEOUT_MS),
      });
      connection.send({ t: 'reply', id, key, text });
      changed();
      return true;
    },
    send(to, text) {
      const digits = to.replace(/\D/g, '').length;
      if (!connection || !/^\+?[0-9 ().-]+$/.test(to.trim()) || digits < 3 || digits > 20 || !text.trim()) return false;
      const id = randomUUID();
      failures.delete(NEW_TEXT);
      replies.set(id, {
        key: NEW_TEXT,
        timer: setTimeout(() => {
          replies.delete(id);
          failures.set(NEW_TEXT, 'no answer from the phone');
          changed();
        }, REPLY_TIMEOUT_MS),
      });
      connection.send({ t: 'send', id, to: to.trim(), text });
      changed();
      return true;
    },
    image(id) {
      const cached = images.get(id);
      if (cached) return Promise.resolve(cached);
      if (!connection) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiting = imageWaiters.get(id);
        const timer = setTimeout(() => resolve(null), IMAGE_TIMEOUT_MS);
        const done = (picture: Buffer | null) => {
          clearTimeout(timer);
          resolve(picture);
        };
        if (waiting) return waiting.push(done);
        imageWaiters.set(id, [done]);
        connection!.send({ t: 'getImage', id });
      });
    },
    markRead(key) {
      const conversation = conversations.get(key);
      const mail = mails.get(key);
      if (conversation && conversation.unread > 0) {
        conversations.set(key, { ...conversation, unread: 0 });
        hashes.delete(`conv:${key}`);
      } else if (mail && !mail.read) {
        mails.set(key, { ...mail, read: true });
        hashes.delete(`mail:${key}`);
      } else return;
      connection?.send({ t: 'read', key });
      changed();
    },
    mailAction(key, action) {
      const mail = mails.get(key);
      if (!connection || !mail || !mail.actions.includes(action)) return false;
      const id = randomUUID();
      failures.delete(key);
      replies.set(id, {
        key,
        timer: setTimeout(() => {
          replies.delete(id);
          failures.set(key, 'no answer from the phone');
          changed();
        }, REPLY_TIMEOUT_MS),
      });
      mails.set(key, { ...mail, requested: action, read: mail.read || action === 'markRead' });
      hashes.delete(`mail:${key}`);
      connection.send({ t: 'mailAction', id, key, action });
      changed();
      return true;
    },
    answerPairing(accept) {
      if (!pairing) return;
      if (accept) {
        pairing.pcAccepted = true;
        return finishPairing();
      }
      pairing.line.send({ t: 'pairRefused' });
      pairing.line.socket.end();
      endPairing();
    },
    forgetPhone() {
      phone = undefined;
      writeJson(phoneFile, null);
      connection?.socket.destroy();
      connection = undefined;
      conversations.clear();
      mails.clear();
      hashes.clear();
      changed();
    },
    stop() {
      stopped = true;
      clearImmediate(changeQueued);
      void withdraw?.();
      if (pairing) clearTimeout(pairing.timer);
      for (const pending of replies.values()) clearTimeout(pending.timer);
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
