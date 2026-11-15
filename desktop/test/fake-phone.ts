// A stand-in for the Kainos phone app: speaks the SMS sync protocol over TLS, the way the
// Android SyncClient does (trust on first use while pairing, then the pinned certificate).
import { randomBytes } from 'node:crypto';
import { connect, type TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import { SYNC_VERSION, certFingerprint, pairingCode, type PcFrame, type SourceId, type SyncConversation, type SyncMail } from '../src/shared/sync-protocol.ts';

/** A phone's own key and self-signed certificate, as the Android app keeps in its key store. */
export interface PhoneIdentity {
  readonly key: string;
  readonly cert: string;
  readonly fingerprint: string;
}

export async function newIdentity(name = 'Fake phone'): Promise<PhoneIdentity> {
  const pems = await generate([{ name: 'commonName', value: name }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' });
  return { key: pems.private, cert: pems.cert, fingerprint: new X509Certificate(pems.cert).fingerprint256.replaceAll(':', '') };
}

/** The fake phone's identity, unless a test brings another (an impostor, say). */
export const phoneIdentity = await newIdentity();

export interface FakePhoneLink {
  readonly frames: PcFrame[];
  readonly fingerprint: string;
  send(frame: unknown): void;
  /** Writes text as it is, with no newline added: a frame still on its way. */
  sendRaw(text: string): void;
  /** Sends several frames in one write, so the PC reads them in one go. */
  sendAll(frames: readonly unknown[]): void;
  /** Resolves with the next frame of this type. */
  next<T extends PcFrame['t']>(type: T, timeoutMs?: number): Promise<Extract<PcFrame, { t: T }>>;
  /** Whether pings are answered; turn off to play a phone that has vanished. */
  answerPings: boolean;
  close(): void;
  readonly closed: Promise<void>;
}

export function link(port: number, identity: PhoneIdentity | null = phoneIdentity, host = '127.0.0.1'): Promise<FakePhoneLink> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.3', ...(identity && { key: identity.key, cert: identity.cert }) }, () => {
      const frames: PcFrame[] = [];
      const waiters: { type: string; resolve: (frame: PcFrame) => void }[] = [];
      let buffer = '';
      let answerPings = true;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buffer.slice(0, end)) as PcFrame;
          buffer = buffer.slice(end + 1);
          if (frame.t === 'ping' && answerPings) socket.write('{"t":"pong"}\n');
          const waiter = waiters.findIndex((w) => w.type === frame.t);
          if (waiter >= 0) waiters.splice(waiter, 1)[0]!.resolve(frame);
          else frames.push(frame);
        }
      });
      const closed = new Promise<void>((done) => socket.on('close', () => done()));
      resolve({
        frames,
        fingerprint: certFingerprint(socket.getPeerX509Certificate()!.raw),
        send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
        sendRaw: (text) => socket.write(text),
        sendAll: (all) => socket.write(all.map((frame) => `${JSON.stringify(frame)}\n`).join('')),
        next: (type, timeoutMs = 5000) =>
          new Promise((done, fail) => {
            const queued = frames.findIndex((frame) => frame.t === type);
            if (queued >= 0) return done(frames.splice(queued, 1)[0] as never);
            const timer = setTimeout(() => fail(new Error(`no ${type} frame`)), timeoutMs);
            waiters.push({ type, resolve: (frame) => (clearTimeout(timer), done(frame as never)) });
          }),
        get answerPings() {
          return answerPings;
        },
        set answerPings(value) {
          answerPings = value;
        },
        close: () => socket.destroy(),
        closed,
      });
    });
    socket.on('error', reject);
  });
}

/**
 * Pairs: returns the code the phone would show. `confirm` is the phone user pressing "Codes
 * match"; `paired` resolves once the PC side has pressed Connect as well.
 */
export async function startPairing(port: number, device = 'Fake phone', identity: PhoneIdentity = phoneIdentity) {
  const phone = await link(port, identity);
  const nonce = randomBytes(16).toString('base64');
  phone.send({ t: 'pair', v: SYNC_VERSION, device, nonce });
  const { nonce: pcNonce } = await phone.next('pairCode');
  const code = pairingCode(phone.fingerprint, identity.fingerprint, nonce, pcNonce);
  return { phone, code, confirm: () => phone.send({ t: 'pairConfirm' }), paired: () => phone.next('paired', 10_000) };
}

export async function connectPaired(port: number, deviceId: string, identity: PhoneIdentity = phoneIdentity): Promise<FakePhoneLink> {
  const phone = await link(port, identity);
  phone.send({ t: 'hello', v: SYNC_VERSION, deviceId });
  await phone.next('welcome');
  return phone;
}

export function conversation(key: string, title: string, texts: { id: string; text: string; timeMs: number; outgoing?: boolean }[], unread = 1, source: SourceId = 'sms'): SyncConversation {
  const labels: Record<SourceId, string> = { whatsapp: 'WhatsApp', 'whatsapp-business': 'WhatsApp Business', discord: 'Discord', messenger: 'Messenger', sms: 'SMS', protonmail: 'Proton Mail' };
  return {
    source,
    sourceLabel: labels[source],
    key,
    title,
    isGroup: false,
    unread,
    lastActivityMs: Math.max(...texts.map((t) => t.timeMs)),
    canReply: true,
    messages: texts.map((t) => ({
      id: t.id,
      sender: t.outgoing ? null : title,
      text: t.text,
      timeMs: t.timeMs,
      outgoing: t.outgoing === true,
      status: t.outgoing ? 'sent' : 'incoming',
      media: null,
      image: null,
    })),
  };
}

export function mail(key: string, sender: string | null, subject: string, timeMs = Date.now()): SyncMail {
  return { key, source: 'protonmail', sourceLabel: 'Proton Mail', sender, subject, account: 'me@proton.me', timeMs, read: false, actions: ['archive', 'trash', 'markRead'], requested: null };
}
