import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * SMS sync between the Kainos phone app (client) and this PC (server): JSON frames, one per
 * line, over TLS on the local network or the user's Tailscale network. `protocol/sms-sync-vectors.json` at the repo root holds
 * test vectors the phone's tests check too.
 */
/**
 * 2: each side proves itself with its own certificate (mutual TLS); no shared secret.
 * 3: every source the phone reads (chats and mail), not only texts. Since then the PC keeps
 *    texts only and ignores the rest, so the number stays: a phone on 3 or 4 still connects.
 * 4: the welcome lists what the PC still holds, so a reconnect sends only what changed.
 *    A conversation's `sender` is additive: an older phone leaves it out and it parses as `person`.
 * 5: phone calls (`call`, `callLog`, `answer`, `hangUp`, `dial`). An older PC closes the connection
 *    on a frame type it does not know, so the number moves and both apps update together.
 * 6: clipboard text, text shared from the phone and files both ways (`clip`, `shareText`,
 *    `fileOffer`, `fileChunk`, `fileEnd`, `fileResult`, `fileCancel`). Again both apps update together.
 */
export const SYNC_VERSION = 6;
export const SYNC_PORT = 48090;
/** mDNS service type: `_kainos-talk._tcp`. */
export const SYNC_SERVICE = 'kainos-talk';
/** A frame longer than this closes the connection. */
export const MAX_FRAME_BYTES = 1_500_000;

/**
 * The 6-digit code both screens show while pairing. It covers both devices' certificates, so a
 * device in the middle (with certificates of its own) makes the two codes differ, unless it picks
 * the last nonce by trying about a million: no side commits to its nonce first.
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

/**
 * Private, link-local and loopback addresses, plus Tailscale's (100.64.0.0/10, and fd7a:… inside
 * fc00::/7): the only ones either side talks to.
 */
export function isLocalAddress(address: string): boolean {
  const ip = unmapped(address);
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || isTailnetAddress(ip);
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}

/** An address Tailscale hands out: 100.64.0.0/10, or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const ip = unmapped(address);
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
}

/** At most this many Tailscale addresses go in a welcome. */
export const MAX_TAILNET_ADDRESSES = 4;

/**
 * This PC's Tailscale addresses for the welcome: the phone keeps them and tries them when the PC
 * isn't on its Wi-Fi. Matched by range, since the interface's name differs by system, but one
 * named Tailscale comes first, so a carrier's 100.64/10 addresses can't crowd it out. IPv4 first.
 */
export function tailnetAddresses(interfaces: Readonly<Record<string, readonly { address: string; internal: boolean }[] | undefined>>): string[] {
  const found = Object.entries(interfaces)
    .flatMap(([name, infos]) => (infos ?? []).map((info) => ({ ...info, tailscale: /tailscale/i.test(name) })))
    .filter((info) => !info.internal && isTailnetAddress(info.address))
    .sort((a, b) => Number(b.tailscale) - Number(a.tailscale) || Number(a.address.includes(':')) - Number(b.address.includes(':')))
    .map((info) => info.address);
  return [...new Set(found)].slice(0, MAX_TAILNET_ADDRESSES);
}

function unmapped(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
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

/** Android tells a normal app only ringing and off the hook, so a call placed is `active` at once. */
export type CallPhase = 'ringing' | 'active';

/** The call on the phone right now. */
export interface LiveCall {
  readonly id: string;
  readonly phase: CallPhase;
  readonly direction: 'incoming' | 'outgoing';
  /** Null for a hidden number, or a call placed on the phone before its number is known. */
  readonly number: string | null;
  /** The saved contact's name. */
  readonly name: string | null;
  /** The text conversation with this number, when there is one. */
  readonly key: string | null;
  readonly sinceMs: number;
}

export type CallKind = 'incoming' | 'outgoing' | 'missed' | 'declined';

/** One line of the phone's call log. */
export interface CallEntry {
  readonly id: string;
  readonly kind: CallKind;
  readonly number: string | null;
  readonly name: string | null;
  readonly key: string | null;
  readonly timeMs: number;
  /** How long it lasted; 0 for a call nobody answered. */
  readonly seconds: number;
}

export const MAX_CALL_LOG = 100;

/** Longest clipboard or shared text, in UTF-16 units (JavaScript's and Kotlin's `length`). */
export const MAX_TEXT_CHARS = 100_000;
/** Largest file either side offers: 2 GiB. */
export const MAX_FILE_BYTES = 2_147_483_648;
/** Most bytes one `fileChunk` carries, before base64. */
export const MAX_CHUNK_BYTES = 262_144;
/** A full chunk in base64. */
const MAX_CHUNK_BASE64 = 349_528;

/**
 * Clipboard text and files, which travel both ways. One file at a time each way: the sender
 * waits for `fileResult` before it offers the next one.
 */
export type TransferFrame =
  | { readonly t: 'clip'; readonly text: string }
  /** A file follows. `name` is untrusted: the receiver saves it under `safeFileName(name)`. */
  | { readonly t: 'fileOffer'; readonly id: string; readonly name: string; readonly size: number; readonly mime: string | null }
  /** The next bytes of the open file, in base64. */
  | { readonly t: 'fileChunk'; readonly id: string; readonly data: string }
  | { readonly t: 'fileEnd'; readonly id: string }
  /** How a file the other side sent ended. */
  | { readonly t: 'fileResult'; readonly id: string; readonly ok: boolean; readonly error: string | null }
  /** Either side stops a transfer; the receiver deletes what it has. */
  | { readonly t: 'fileCancel'; readonly id: string };

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
  /** The call on the phone changed; null when it ended. */
  | { readonly t: 'call'; readonly call: LiveCall | null }
  /** The newest calls, newest first. */
  | { readonly t: 'callLog'; readonly calls: readonly CallEntry[] }
  /** A picture the PC asked for: JPEG in base64, or why it is missing. */
  | { readonly t: 'image'; readonly id: string; readonly mime: string | null; readonly data: string | null; readonly error: string | null }
  /** Text or a link shared from the phone: a link opens on the PC, other text goes on its clipboard. */
  | { readonly t: 'shareText'; readonly text: string }
  | TransferFrame;

/** Frames the PC sends. */
export type PcFrame =
  | { t: 'pairCode'; nonce: string }
  | { t: 'paired'; deviceId: string }
  | { t: 'pairRefused' }
  /**
   * Every conversation key the PC holds, with the `frameHash` of the frame it came in.
   * An empty hash means the PC changed it since (marked it read, say), so it is sent again.
   */
  /**
   * `tailnet`: this PC's Tailscale addresses (`tailnetAddresses`), so the phone can reach it off
   * the Wi-Fi. Additive: an older phone ignores it, so the version stays.
   */
  | { t: 'welcome'; name: string; conversations: Record<string, string>; tailnet: string[] }
  | { t: 'denied'; reason: string }
  | { t: 'reply'; id: string; key: string; text: string }
  | { t: 'read'; key: string }
  /** A new text to a number, sent by the phone itself (needs SMS access on the phone). */
  | { t: 'send'; id: string; to: string; text: string }
  | { t: 'ping' }
  | { t: 'getImage'; id: string }
  /**
   * Answers the ringing call. Each call action names the call and the phase the PC showed, so the
   * phone refuses one that changed meanwhile, and is answered with a `replyResult` of the same id.
   */
  | { t: 'answer'; id: string; call: string }
  /** Ends the call, or declines it while it rings. */
  | { t: 'hangUp'; id: string; call: string; phase: CallPhase }
  /** Calls a number, or the one number of a text conversation: exactly one of the two is set. */
  | { t: 'dial'; id: string; number: string | null; key: string | null }
  | TransferFrame;

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

const nullable = (value: unknown, max: number): value is string | null => value === null || str(value, max);
/** A time a `Date` can hold, so formatting it can't throw. */
const time = (value: unknown): value is number => num(value) && Math.abs(value) <= 8.64e15;

function parseLiveCall(raw: unknown): LiveCall | null | undefined {
  if (raw === null) return null;
  if (!record(raw)) return undefined;
  const { id, phase, direction, number, name, key, sinceMs } = raw;
  if (!str(id, 100) || (phase !== 'ringing' && phase !== 'active') || (direction !== 'incoming' && direction !== 'outgoing')) return undefined;
  if (!nullable(number, 40) || !nullable(name, 500) || !nullable(key, 500) || !time(sinceMs)) return undefined;
  return { id, phase, direction, number, name, key, sinceMs };
}

const CALL_KINDS: readonly unknown[] = ['incoming', 'outgoing', 'missed', 'declined'] satisfies CallKind[];

function parseCallEntry(raw: unknown): CallEntry | undefined {
  if (!record(raw)) return undefined;
  const { id, kind, number, name, key, timeMs, seconds } = raw;
  if (!str(id, 100) || !CALL_KINDS.includes(kind) || !nullable(number, 40) || !nullable(name, 500) || !nullable(key, 500) || !time(timeMs) || !num(seconds)) return undefined;
  return { id, kind: kind as CallKind, number, name, key, timeMs, seconds: Math.max(0, Math.floor(seconds)) };
}

const text = (value: unknown): value is string => str(value, MAX_TEXT_CHARS) && value.length > 0;
/** Standard base64 with padding, as both apps write it. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseTransfer(raw: Record<string, unknown>): TransferFrame | undefined {
  switch (raw.t) {
    case 'clip':
      return text(raw.text) ? { t: 'clip', text: raw.text } : undefined;
    case 'fileOffer': {
      const { id, name, size, mime } = raw;
      if (!str(id, 100) || !str(name, 255) || name.length === 0 || !nullable(mime, 255)) return undefined;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) return undefined;
      return { t: 'fileOffer', id, name, size, mime };
    }
    case 'fileChunk':
      return str(raw.id, 100) && str(raw.data, MAX_CHUNK_BASE64) && BASE64.test(raw.data) ? { t: 'fileChunk', id: raw.id, data: raw.data } : undefined;
    case 'fileEnd':
      return str(raw.id, 100) ? { t: 'fileEnd', id: raw.id } : undefined;
    case 'fileResult':
      return str(raw.id, 100) && bool(raw.ok) && nullable(raw.error, 100) ? { t: 'fileResult', id: raw.id, ok: raw.ok, error: raw.error } : undefined;
    case 'fileCancel':
      return str(raw.id, 100) ? { t: 'fileCancel', id: raw.id } : undefined;
    default:
      return undefined;
  }
}

/**
 * The name a received file is saved under: what follows the last `/` or `\`, without control
 * characters or surrounding spaces, and `file` when nothing usable is left.
 */
export function safeFileName(offered: string): string {
  const name = offered.slice(Math.max(offered.lastIndexOf('/'), offered.lastIndexOf('\\')) + 1).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return name === '' || name === '.' || name === '..' ? 'file' : name;
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
    case 'call': {
      const call = parseLiveCall(raw.call);
      return call === undefined ? undefined : { t: 'call', call };
    }
    case 'callLog': {
      if (!Array.isArray(raw.calls) || raw.calls.length > MAX_CALL_LOG) return undefined;
      const calls = raw.calls.map(parseCallEntry);
      return calls.every((entry) => entry !== undefined) ? { t: 'callLog', calls: calls as CallEntry[] } : undefined;
    }
    case 'image': {
      const { id, mime, data, error } = raw;
      if (!str(id, 100) || !(mime === null || mime === 'image/jpeg') || !(data === null || str(data, MAX_FRAME_BYTES)) || !(error === null || str(error, 100))) return undefined;
      return { t: 'image', id, mime, data, error };
    }
    case 'shareText':
      return text(raw.text) ? { t: 'shareText', text: raw.text } : undefined;
    default:
      return parseTransfer(raw);
  }
}
