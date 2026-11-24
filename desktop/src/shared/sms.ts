import type { CallEntry, LiveCall, SyncConversation } from './sync-protocol.ts';

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
  /** The call on the phone now. */
  readonly call: LiveCall | null;
  /** The phone's newest calls, newest first. */
  readonly calls: readonly CallEntry[];
  /** An answer, hang-up or dial on its way to the phone, and why the last one failed. */
  readonly callAction: { readonly pending: boolean; readonly failure: string | null };
  /** Whether call sound can reach this PC over Bluetooth. */
  readonly callAudio: CallAudio | null;
}

/**
 * Whether call sound can reach this PC: the phone connected to it over Bluetooth hands-free.
 * Null until the PC first tries, and on systems where it can't (Windows).
 */
export interface CallAudio {
  readonly kind: 'connected' | 'connecting' | 'unreachable' | 'pc-off' | 'not-paired' | 'no-bluetooth';
  /** The phone's Bluetooth name. */
  readonly device: string | null;
}

/** What the incoming-call window shows: the ringing call, and the phone's answer to a button. */
export interface CallPopupState {
  readonly call: LiveCall;
  /** Answer or Decline is on its way to the phone. */
  readonly pending: boolean;
  readonly failure: string | null;
}

export const CallPopupChannel = {
  getState: 'kainos-call-popup:get-state',
  state: 'kainos-call-popup:state',
  answer: 'kainos-call-popup:answer',
  decline: 'kainos-call-popup:decline',
} as const;

/** The incoming-call window's only API, exposed as window.kainosRinging. */
export interface CallPopupApi {
  getState(): Promise<CallPopupState | undefined>;
  onState(listener: (state: CallPopupState) => void): void;
  answer(): void;
  decline(): void;
}

export const SmsChannel = {
  getState: 'kainos-sms:get-state',
  state: 'kainos-sms:state',
  reply: 'kainos-sms:reply',
  markRead: 'kainos-sms:mark-read',
  answerPairing: 'kainos-sms:answer-pairing',
  forgetPhone: 'kainos-sms:forget-phone',
  send: 'kainos-sms:send',
  answer: 'kainos-sms:answer',
  hangUp: 'kainos-sms:hang-up',
  dial: 'kainos-sms:dial',
  /** Inbox page to main: connect the phone over Bluetooth for call sound. */
  connectCallAudio: 'kainos-sms:connect-call-audio',
  /** Inbox page to main: put a verification code on the clipboard. */
  copyCode: 'kainos-sms:copy-code',
  /** Main to the inbox page: open this conversation (a notification was clicked). */
  openKey: 'kainos-sms:open-key',
  /** Main to the inbox page: whether it is in sight. Its own visibilityState can't tell. */
  shown: 'kainos-sms:shown',
} as const;

/** What the phone dials or texts: digits with spaces, dashes, dots or brackets and a leading +, 3 to 20 digits. */
export function isPhoneNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, '').length;
  // The phone takes a number of up to 40 characters, separators included.
  return /^\+?[0-9 ().-]+$/.test(raw.trim()) && raw.trim().length <= 40 && digits >= 3 && digits <= 20;
}

/** The longest text, reply or new, that goes to the phone. */
export const MAX_SMS_TEXT = 5000;

/** Pictures from messages, served to the inbox page alone; fetched from the phone the first time. */
export const IMAGE_SCHEME = 'kainos-image';
/** What the Texts page may put on the clipboard: a verification code and nothing else. */
export const isCopyableCode = (raw: unknown): raw is string => typeof raw === 'string' && /^\d{4,8}$/.test(raw);

export const imageUrl = (id: string) => `${IMAGE_SCHEME}://picture/${encodeURIComponent(id)}`;

/** The SMS view's only API, exposed as window.kainosSms. */
export interface SmsApi {
  /** None while the phone sync is still starting. */
  getState(): Promise<SmsState | undefined>;
  onState(listener: (state: SmsState) => void): void;
  reply(key: string, text: string): void;
  markRead(key: string): void;
  /** Answers the request showing `code`, so a click never lands on a newer one. */
  answerPairing(accept: boolean, code: string): void;
  forgetPhone(): void;
  /** A new text to a phone number. */
  send(to: string, text: string): void;
  answer(): void;
  hangUp(): void;
  /** Calls a number, or the one number of a text conversation. */
  dial(to: { readonly number: string } | { readonly key: string }): void;
  /** Connects the phone over Bluetooth so call sound comes through this PC. */
  connectCallAudio(): void;
  /** Copies a verification code (4 to 8 digits); main writes the clipboard, since a local page may not. */
  copyCode(code: string): void;
  onOpenKey(listener: (key: string) => void): void;
  onShown(listener: (shown: boolean) => void): void;
}
