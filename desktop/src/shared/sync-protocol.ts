import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * SMS sync between the Kainos phone app (client) and this PC (server): JSON frames, one per
 * line, over TLS on the local network. `protocol/sms-sync-vectors.json` at the repo root holds
 * test vectors the phone's tests check too.
 */
/**
 * 2: each side proves itself with its own certificate (mutual TLS); no shared secret.
 * 3: every source the phone reads (chats and mail), not only texts. Since then the PC keeps
 *    texts only and ignores the rest, so the number stays: a phone on 3 or 4 still connects.
 * 4: the welcome lists what the PC still holds, so a reconnect sends only what changed.
 *    A conversation's `sender` is additive: an older phone leaves it out and it parses as `person`.
 */
export const SYNC_VERSION = 4;
export const SYNC_PORT = 48090;
/** mDNS service type: `_kainos-talk._tcp`. */
export const SYNC_SERVICE = 'kainos-talk';
/** A frame longer than this closes the connection. */
export const MAX_FRAME_BYTES = 1_500_000;

/**
 * The 6-digit code both screens show while pairing. It covers both devices' certificates, so a
 * device in the middle (with certificates of its own) makes the two codes differ.
 */
export function pairingCode(pcFingerprint: string, phoneFingerprint: string, phoneNonce: string, pcNonce: string): string {
  const digest = createHash('sha256').update(`${pcFingerprint.toUpperCase()}:${phoneFingerprint.toUpperCase()}:${phoneNonce}:${pcNonce}`, 'utf8').digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** SHA-256 of a DER certificate, upper-case hex without separators. */
export function certFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex').toUpperCase();
}

/**
 * What the PC holds of a conversation: the first 8 bytes of the SHA-256 of the frame
 * line it came in (UTF-8, no newline), in lower-case hex. The phone hashes the line it would
 * send; a different hash only means the phone sends it again.
 */
export function frameHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest().subarray(0, 8).toString('hex');
}

/** Private, link-local and loopback addresses: the only ones either side talks to. */
export function isLocalAddress(address: string): boolean {
  const ip = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}

export interface SyncMessage {
  readonly id: string;
  readonly sender: string | null;
  readonly text: string;
  readonly timeMs: number;
  readonly outgoing: boolean;
  /** incoming, sending, sent, confirmed or failed. */
  readonly status: string;
  /** A media label such as "image" when the text is empty or a caption. */
  readonly media: string | null;
  /** A picture the PC can fetch with `getImage`. */
  readonly image: string | null;
}

/**
 * Who a conversation is with. `service` is an automated sender: an alphanumeric sender ID or a
 * short code that is not a saved contact. Everything else, groups included, is `person`.
 */
export type SenderKind = 'person' | 'service';

/** A text conversation (SMS or RCS) from the phone's messages app. */
export interface SyncConversation {
  readonly key: string;
  readonly title: string;
  readonly isGroup: boolean;
  readonly sender: SenderKind;
  readonly unread: number;
  readonly lastActivityMs: number;
  /** The phone still has this conversation's notification, so a reply can go out. */
  readonly canReply: boolean;
  /** Oldest first, at most the last 200. */
  readonly messages: readonly SyncMessage[];
}

/** Frames the phone sends. */
export type PhoneFrame =
  | { readonly t: 'pair'; readonly v: number; readonly device: string; readonly nonce: string }
  | { readonly t: 'hello'; readonly v: number; readonly deviceId: string }
  /** The phone's user saw the same code on both screens. */
  | { readonly t: 'pairConfirm' }
  | { readonly t: 'conversation'; readonly conversation: SyncConversation }
  | { readonly t: 'removed'; readonly key: string }
  /**
   * A frame an older phone sends that the PC no longer keeps (mail, or a chat from another app).
   * It is read and dropped; closing the connection on it would cut off a phone that is only out of date.
   */
  | { readonly t: 'ignored' }
  | { readonly t: 'replyResult'; readonly id: string; readonly ok: boolean; readonly error: string | null }
  | { readonly t: 'pong' }
  /** A picture the PC asked for: JPEG in base64, or why it is missing. */
  | { readonly t: 'image'; readonly id: string; readonly mime: string | null; readonly data: string | null; readonly error: string | null };

/** Frames the PC sends. */
export type PcFrame =
  | { t: 'pairCode'; nonce: string }
  | { t: 'paired'; deviceId: string }
  | { t: 'pairRefused' }
  /**
   * Every conversation key the PC holds, with the `frameHash` of the frame it came in.
   * An empty hash means the PC changed it since (marked it read, say), so it is sent again.
   */
  | { t: 'welcome'; name: string; conversations: Record<string, string> }
  | { t: 'denied'; reason: string }
  | { t: 'reply'; id: string; key: string; text: string }
  | { t: 'read'; key: string }
  /** A new text to a number, sent by the phone itself (needs SMS access on the phone). */
  | { t: 'send'; id: string; to: string; text: string }
  | { t: 'ping' }
  | { t: 'getImage'; id: string };

const str = (value: unknown, max = 10_000): value is string => typeof value === 'string' && value.length <= max;
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseMessage(raw: unknown): SyncMessage | undefined {
  if (!record(raw)) return undefined;
  const { id, sender, text, timeMs, outgoing, status, media } = raw;
  const image = raw.image ?? null;
  if (!str(id, 200) || !(sender === null || str(sender, 500)) || !str(text) || !num(timeMs) || !bool(outgoing) || !str(status, 20)) return undefined;
  if (!(media === null || str(media, 20)) || !(image === null || str(image, 100))) return undefined;
  return { id, sender, text, timeMs, outgoing, status, media, image };
}

function parseConversation(raw: unknown): SyncConversation | undefined {
  if (!record(raw)) return undefined;
  const { key, title, isGroup, unread, lastActivityMs, canReply, messages } = raw;
  if (!str(key, 500) || !str(title, 500) || !bool(isGroup) || !num(unread) || !num(lastActivityMs) || !bool(canReply)) return undefined;
  if (!Array.isArray(messages) || messages.length > 200) return undefined;
  const parsed = messages.map(parseMessage);
  if (parsed.some((message) => message === undefined)) return undefined;
  // Missing (an older phone) or unknown: treat it as a person, who gets a reply box.
  return { key, title, isGroup, sender: raw.sender === 'service' ? 'service' : 'person', unread: Math.max(0, Math.floor(unread)), lastActivityMs, canReply, messages: parsed as SyncMessage[] };
}

/** One line from the phone: untrusted input, checked field by field. */
export function parsePhoneFrame(line: string): PhoneFrame | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record(raw)) return undefined;
  switch (raw.t) {
    case 'pair':
      return num(raw.v) && str(raw.device, 100) && str(raw.nonce, 100) ? { t: 'pair', v: raw.v, device: raw.device, nonce: raw.nonce } : undefined;
    case 'hello':
      return num(raw.v) && str(raw.deviceId, 100) ? { t: 'hello', v: raw.v, deviceId: raw.deviceId } : undefined;
    case 'pairConfirm':
      return { t: 'pairConfirm' };
    case 'conversation': {
      // A missing source is a phone from before chats of other apps travelled; those say 'sms'.
      if (record(raw.conversation) && raw.conversation.source !== undefined && raw.conversation.source !== 'sms') return { t: 'ignored' };
      const conversation = parseConversation(raw.conversation);
      return conversation ? { t: 'conversation', conversation } : undefined;
    }
    case 'mail':
    case 'mailRemoved':
      return { t: 'ignored' };
    case 'removed':
      return str(raw.key, 500) ? { t: 'removed', key: raw.key } : undefined;
    case 'replyResult':
      return str(raw.id, 100) && bool(raw.ok) && (raw.error === null || str(raw.error, 100))
        ? { t: 'replyResult', id: raw.id, ok: raw.ok, error: raw.error as string | null }
        : undefined;
    case 'pong':
      return { t: 'pong' };
    case 'image': {
      const { id, mime, data, error } = raw;
      if (!str(id, 100) || !(mime === null || mime === 'image/jpeg') || !(data === null || str(data, MAX_FRAME_BYTES)) || !(error === null || str(error, 100))) return undefined;
      return { t: 'image', id, mime, data, error };
    }
    default:
      return undefined;
  }
}
