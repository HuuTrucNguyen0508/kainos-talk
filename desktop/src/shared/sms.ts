import type { SyncConversation } from './sync-protocol.ts';

/** Everything the SMS view shows: the sync server's state. */
export interface SmsState {
  /** How this PC appears in the phone's list. */
  readonly name: string;
  readonly listening: { readonly ok: true; readonly port: number } | { readonly ok: false; readonly error: string };
  /** The paired phone, if any. */
  readonly phone: { readonly name: string; readonly connected: boolean } | null;
  /** A phone asking to pair, with the code both screens show. */
  readonly pairing: { readonly device: string; readonly code: string; readonly pcAccepted: boolean; readonly phoneConfirmed: boolean } | null;
  /** Newest first. */
  readonly conversations: readonly SyncConversation[];
  /** Conversations with a reply on its way to the phone. */
  readonly sending: readonly string[];
  /** Conversation key to why its last reply failed. */
  readonly failures: Readonly<Record<string, string>>;
  /** A new text on its way, and why the last one failed. */
  readonly newText: { readonly sending: boolean; readonly failure: string | null };
}

export const SmsChannel = {
  getState: 'kainos-sms:get-state',
  state: 'kainos-sms:state',
  reply: 'kainos-sms:reply',
  markRead: 'kainos-sms:mark-read',
  answerPairing: 'kainos-sms:answer-pairing',
  forgetPhone: 'kainos-sms:forget-phone',
  send: 'kainos-sms:send',
  /** Inbox page to main: put a verification code on the clipboard. */
  copyCode: 'kainos-sms:copy-code',
  /** Main to the inbox page: open this conversation (a notification was clicked). */
  openKey: 'kainos-sms:open-key',
  /** Main to the inbox page: whether it is in sight. Its own visibilityState can't tell. */
  shown: 'kainos-sms:shown',
} as const;

/** Pictures from messages, served to the inbox page alone; fetched from the phone the first time. */
export const IMAGE_SCHEME = 'kainos-image';
/** What the Texts page may put on the clipboard: a verification code and nothing else. */
export const isCopyableCode = (raw: unknown): raw is string => typeof raw === 'string' && /^\d{4,8}$/.test(raw);

export const imageUrl = (id: string) => `${IMAGE_SCHEME}://picture/${encodeURIComponent(id)}`;

/** The SMS view's only API, exposed as window.kainosSms. */
export interface SmsApi {
  getState(): Promise<SmsState>;
  onState(listener: (state: SmsState) => void): void;
  reply(key: string, text: string): void;
  markRead(key: string): void;
  answerPairing(accept: boolean): void;
  forgetPhone(): void;
  /** A new text to a phone number. */
  send(to: string, text: string): void;
  /** Copies a verification code (4 to 8 digits); main writes the clipboard, since a local page may not. */
  copyCode(code: string): void;
  onOpenKey(listener: (key: string) => void): void;
  onShown(listener: (shown: boolean) => void): void;
}
