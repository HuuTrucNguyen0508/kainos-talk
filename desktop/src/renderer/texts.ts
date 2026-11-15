import type { SyncConversation } from '../shared/sync-protocol.ts';

/** The Texts page's two lists: conversations with people, and notices from automated senders. */
export interface TextsLists {
  readonly people: readonly SyncConversation[];
  readonly notices: readonly SyncConversation[];
}

/** Splits the phone's conversations (newest first, kept in order) by who sent them. */
export function splitBySender(conversations: readonly SyncConversation[]): TextsLists {
  return {
    people: conversations.filter((c) => c.sender !== 'service'),
    notices: conversations.filter((c) => c.sender === 'service'),
  };
}

export function unreadIn(list: readonly SyncConversation[]): number {
  return list.reduce((sum, c) => sum + c.unread, 0);
}

/** Conversations whose name or any message contains the query, ignoring case. */
export function matching(list: readonly SyncConversation[], query: string): readonly SyncConversation[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.text.toLowerCase().includes(q)));
}

/** Words that say a number in the text is a one-time code. "code postal" and "code promo" are not. */
const CODE_WORD = /(?<![\p{L}\d])(?:code(?!s?\s+(?:postal|promo))|codes|v[ée]rification|verify|otp|passcode)(?![\p{L}])/giu;
/**
 * A lone run of 4 to 8 digits: not part of a longer number, a phone number written in groups,
 * a date, an amount ("1500 €") or a reference like "404-8812345".
 */
const CANDIDATE = /(?<![\p{L}\d.,/+\-–€$£])(\d{4,8})(?![\p{L}\d:/\-–%€$£]|[.,]\d|\s?(?:€|\$|£|eur\b|euros?\b|%))/giu;
/** How far, in characters, a code may sit from the word that announces it. */
const NEAR = 60;

/**
 * The verification code in a text, if it has one: 4 to 8 digits standing alone, within a short
 * distance of a word such as "code", "vérification" or "OTP". The closest one wins.
 */
export function findCode(text: string): string | undefined {
  const words = [...text.matchAll(CODE_WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (words.length === 0) return undefined;
  let best: { code: string; distance: number } | undefined;
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;
    // A colon after a word introduces a code; a colon after digits belongs to a time/reference.
    if (/\d\s*:\s*$/.test(text.slice(0, start))) continue;
    const end = start + m[0].length;
    const distance = Math.min(...words.map((w) => (end <= w.start ? w.start - end : start >= w.end ? start - w.end : 0)));
    if (distance <= NEAR && (!best || distance < best.distance)) best = { code: m[1]!, distance };
  }
  return best?.code;
}

/** A code as it is read aloud: six digits in two groups of three, others as they are. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
