import type { CallEntry, SyncMessage } from '../shared/sync-protocol.ts';

/** A call's length as people say it: "45 s", "1 min 35 s", "1 h 2 min". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** A running call's clock: 0:42, 12:03, 1:02:03. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const KIND: Record<CallEntry['kind'], string> = {
  incoming: 'Incoming call',
  outgoing: 'Outgoing call',
  missed: 'Missed call',
  declined: 'Declined call',
};

/** What happened, with how long it lasted when someone picked up: "Outgoing call, 1 min 35 s". */
export function callLabel(call: CallEntry): string {
  const answered = call.kind === 'incoming' || call.kind === 'outgoing';
  return answered && call.seconds > 0 ? `${KIND[call.kind]}, ${duration(call.seconds)}` : KIND[call.kind];
}

/** Who a call was with, as the list shows them. */
export function caller(call: { readonly name: string | null; readonly number: string | null }): string {
  return call.name ?? call.number ?? 'Hidden number';
}

const digits = (text: string) => text.replace(/\D/g, '');

/** Calls whose name or number contains the query; a number matches however it is spaced. */
export function matchingCalls(calls: readonly CallEntry[], query: string): readonly CallEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return calls;
  const qDigits = digits(q);
  return calls.filter(
    (call) => call.name?.toLowerCase().includes(q) || call.number?.toLowerCase().includes(q) || (qDigits.length >= 3 && digits(call.number ?? '').includes(qDigits)),
  );
}

export type TimelineItem = { readonly kind: 'message'; readonly message: SyncMessage } | { readonly kind: 'call'; readonly call: CallEntry };

/** The phone sends a conversation's last 200 texts at most. */
const MAX_MESSAGES = 200;

/**
 * A conversation's texts and its calls in one timeline, oldest first. When the phone sent only
 * the last texts of a long conversation, calls from before them are left out: the thread starts
 * where its texts do.
 */
export function timeline(messages: readonly SyncMessage[], calls: readonly CallEntry[], key: string): readonly TimelineItem[] {
  const from = messages.length >= MAX_MESSAGES ? messages[0]!.timeMs : -Infinity;
  const mine = calls.filter((call) => call.key === key && call.timeMs >= from);
  const items: TimelineItem[] = [...messages.map((message) => ({ kind: 'message' as const, message })), ...mine.map((call) => ({ kind: 'call' as const, call }))];
  // Stable: a text and a call at the same moment keep texts first.
  return items.sort((a, b) => timeOf(a) - timeOf(b));
}

const timeOf = (item: TimelineItem) => (item.kind === 'message' ? item.message.timeMs : item.call.timeMs);
