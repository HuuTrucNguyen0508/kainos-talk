import type { MailAction, SyncConversation, SyncMail } from './sync-protocol.ts';

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
  /** Newest first. */
  readonly mails: readonly SyncMail[];
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
  mailAction: 'kainos-sms:mail-action',
  openService: 'kainos-sms:open-service',
  /** Main to the inbox page: open this conversation or mail (a notification was clicked). */
  openKey: 'kainos-sms:open-key',
  /** Main to the inbox page: whether it is in sight. Its own visibilityState can't tell. */
  shown: 'kainos-sms:shown',
} as const;

/** Pictures from messages, served to the inbox page alone; fetched from the phone the first time. */
export const IMAGE_SCHEME = 'kainos-image';
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
  mailAction(key: string, action: MailAction): void;
  /** Opens a service's own website in Kainos (for example Proton Mail to read a mail in full). */
  openService(serviceId: string): void;
  onOpenKey(listener: (key: string) => void): void;
  onShown(listener: (shown: boolean) => void): void;
}
