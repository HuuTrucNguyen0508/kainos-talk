import { imageUrl, type SmsApi, type SmsState } from '../shared/sms.ts';
import type { MailAction, SourceId, SyncConversation, SyncMail, SyncMessage } from '../shared/sync-protocol.ts';
import './inbox.css';

declare global {
  interface Window {
    readonly kainosSms: SmsApi;
  }
}

const api = window.kainosSms;
const root = document.getElementById('app') as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A line icon on the 24 grid, drawn like the phone's (1.8 stroke, round caps). */
function icon(paths: readonly string[], className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const ICON = {
  search: ['M15 15l5 5', 'M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12z'],
  compose: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z', 'M13.5 8.5l3 3'],
  send: ['M20.5 3.5L3.5 10.3l6.6 3.1 3.1 6.6z', 'M10.1 13.4l4.3-4.2'],
  phone: ['M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z', 'M11 18h2'],
};

/** The Kainos mark: a teal tile with a ring and a dot. */
function mark(className = 'mark'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const rect = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x: '2', y: '2', width: '28', height: '28', rx: '8' })) rect.setAttribute(k, v);
  const ring = document.createElementNS(SVG, 'circle');
  for (const [k, v] of Object.entries({ cx: '16', cy: '16', r: '7.7', class: 'mark-ring' })) ring.setAttribute(k, v);
  const dot = document.createElementNS(SVG, 'circle');
  for (const [k, v] of Object.entries({ cx: '16', cy: '16', r: '2.4', class: 'mark-dot' })) dot.setAttribute(k, v);
  svg.append(rect, ring, dot);
  return svg;
}

/** Initials of a name, or nothing for a bare number (which gets a phone glyph instead). */
function initials(title: string): string {
  const words = title.split(/[\s,]+/).filter((w) => /\p{L}/u.test(w[0] ?? ''));
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

/** Board groups, as on the phone: WhatsApp and WhatsApp Business share a line. */
type Group = 'whatsapp' | 'discord' | 'messenger' | 'sms' | 'mail';

/** How each phone source looks here: its jack letter and line colour, and its website in the bar. */
const SOURCE_UI: Record<SourceId, { readonly letter: string; readonly group: Group; readonly website: string | null; readonly app: string }> = {
  whatsapp: { letter: 'W', group: 'whatsapp', website: 'whatsapp', app: 'WhatsApp' },
  'whatsapp-business': { letter: 'W', group: 'whatsapp', website: null, app: 'WhatsApp Business' },
  discord: { letter: 'D', group: 'discord', website: 'discord', app: 'Discord' },
  messenger: { letter: 'F', group: 'messenger', website: 'messenger', app: 'Messenger' },
  sms: { letter: 'S', group: 'sms', website: null, app: 'Messages' },
  protonmail: { letter: 'M', group: 'mail', website: 'proton-mail', app: 'Proton Mail' },
};

const GROUPS: readonly { readonly id: Group | null; readonly label: string }[] = [
  { id: null, label: 'All' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'discord', label: 'Discord' },
  { id: 'messenger', label: 'Messenger' },
  { id: 'sms', label: 'SMS' },
  { id: 'mail', label: 'Mail' },
];

/** The source's jack: its letter on its line colour, in its line's shape (as on the phone). */
function jack(source: SourceId, inline = false): HTMLElement {
  const ui = SOURCE_UI[source];
  const node = el('span', inline ? 'jack jack-inline' : 'jack', ui.letter);
  node.dataset.line = ui.group;
  return node;
}

/** The conversation's tile: initials on a rimmed tile, with its source's jack in the corner, as on the phone. */
function avatar(title: string, source: SourceId, size: 'row' | 'head' = 'row'): HTMLElement {
  const tile = el('span', `avatar avatar-${size}`);
  tile.setAttribute('aria-hidden', 'true');
  const letters = initials(title);
  if (letters) tile.append(el('span', 'avatar-letters', letters));
  else tile.append(icon(ICON.phone, 'avatar-glyph'));
  tile.append(jack(source));
  return tile;
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A day separator: Today, Yesterday, the weekday this week, else the date. */
function dayLabel(ms: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(ms);
  return longDay.format(ms);
}

/** The list's time column: the time today, the weekday this week, else the date. */
function rowTime(ms: number): string {
  const days = (startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000;
  if (days < 1) return time.format(ms);
  if (days < 7) return weekday.format(ms);
  return date.format(ms);
}

function preview(message: SyncMessage | undefined): string {
  if (!message) return '';
  const text = message.text || (message.media ? `${message.media[0]!.toUpperCase()}${message.media.slice(1)}` : 'Message');
  return message.outgoing ? `You: ${text}` : text;
}

const STATUS: Record<string, string> = { sending: 'Sending', sent: 'Sent', confirmed: 'Delivered', failed: 'Not sent' };

/** One row of the list: a conversation or a mail. */
type Entry = { readonly kind: 'chat'; readonly c: SyncConversation } | { readonly kind: 'mail'; readonly m: SyncMail };

function entries(s: SmsState): Entry[] {
  const all: Entry[] = [...s.conversations.map((c) => ({ kind: 'chat' as const, c })), ...s.mails.map((m) => ({ kind: 'mail' as const, m }))];
  return all.sort((a, b) => timeOf(b) - timeOf(a));
}
const timeOf = (e: Entry) => (e.kind === 'chat' ? e.c.lastActivityMs : e.m.timeMs);
const groupOf = (e: Entry): Group => SOURCE_UI[e.kind === 'chat' ? e.c.source : e.m.source].group;
const unreadOf = (e: Entry) => (e.kind === 'chat' ? e.c.unread : e.m.read ? 0 : 1);
const keyOf = (e: Entry) => (e.kind === 'chat' ? e.c.key : e.m.key);

/** The board's filter: one line, or everything. */
let filter: Group | null = null;

let state: SmsState | undefined;
let openKey: string | undefined;
/** What the search box holds; the list shows matching conversations only. */
let query = '';
/** The thread pane shows the new-text form instead of a conversation. */
const NEW_TEXT = '\u0000new';
const drafts = new Map<string, string>();

// --- Setup screens: waiting for a phone, or a phone asking to pair ---

function renderSetup(s: SmsState): void {
  const card = el('section', 'card');
  if (s.pairing) {
    card.append(
      el('h1', '', `${s.pairing.device} wants to connect`),
      el('p', '', 'Check that your phone shows the same code. Confirm on both: Connect here, Codes match on the phone.'),
    );
    const code = el('div', 'code', `${s.pairing.code.slice(0, 3)} ${s.pairing.code.slice(3)}`);
    code.setAttribute('aria-label', `Code ${s.pairing.code.split('').join(' ')}`);
    if (s.pairing.pcAccepted) {
      card.append(code, el('p', '', s.pairing.phoneConfirmed ? 'Connecting…' : 'Waiting for the phone: press Codes match there.'), el('div', 'signal'));
      root.replaceChildren(wrap(card));
      return;
    }
    if (s.pairing.phoneConfirmed) card.append(el('p', '', 'The phone says the codes match.'));
    const accept = el('button', 'primary', 'Connect');
    accept.type = 'button';
    accept.addEventListener('click', () => api.answerPairing(true));
    const refuse = el('button', 'secondary', "Don't connect");
    refuse.type = 'button';
    refuse.addEventListener('click', () => api.answerPairing(false));
    const actions = el('div', 'actions');
    actions.append(accept, refuse);
    card.append(code, actions);
    root.replaceChildren(wrap(card));
    accept.focus();
    return;
  }

  card.append(
    el('h1', '', 'Connect your phone'),
    el('p', '', 'Your inbox (texts, WhatsApp, Discord, Messenger and mail) comes from the Kainos Talk app on your Android phone, over your home network. Nothing goes through the internet.'),
  );
  const steps = el('ol', 'steps');
  const step = (...parts: (string | Node)[]) => {
    const li = el('li');
    const body = el('span');
    body.append(...parts);
    li.append(body);
    steps.append(li);
  };
  step('Put the phone on the same Wi-Fi as this computer.');
  step('In Kainos Talk on the phone, open the menu and choose ', el('strong', '', 'Connect to PC'), '.');
  step('Pick ', el('strong', '', s.name), ' from the list.');
  step('Check the code, then connect on this screen.');
  card.append(steps);
  if (!s.listening.ok) card.append(el('p', 'problem', `Kainos Talk can't listen for your phone: ${s.listening.error}.`));
  else card.append(el('p', '', 'Waiting for your phone…'), el('div', 'signal'));
  root.replaceChildren(wrap(card));
}

function wrap(card: HTMLElement): HTMLElement {
  const setup = el('div', 'setup');
  card.prepend(mark('mark mark-large'));
  setup.append(card);
  return setup;
}

// --- Inbox: conversation list and the open thread ---

interface Inbox {
  readonly board: HTMLElement;
  readonly rows: HTMLUListElement;
  readonly phone: HTMLElement;
  readonly thread: HTMLElement;
}
let inbox: Inbox | undefined;

function buildInbox(): Inbox {
  const shell = el('div', 'inbox');
  const list = el('nav', 'list');
  list.setAttribute('aria-label', 'Conversations');
  const head = el('header', 'list-head');
  const search = el('label', 'search');
  const field = el('input');
  field.type = 'search';
  field.placeholder = 'Search';
  field.setAttribute('aria-label', 'Search the inbox');
  field.value = query;
  field.addEventListener('input', () => {
    query = field.value;
    if (state) renderRows(state, rows);
  });
  search.append(icon(ICON.search), field);
  const compose = el('button', 'new-text');
  compose.type = 'button';
  compose.title = 'New text';
  compose.setAttribute('aria-label', 'New text');
  compose.append(icon(ICON.compose));
  compose.addEventListener('click', () => open(NEW_TEXT));
  head.append(search, compose);
  const board = el('div', 'board');
  board.setAttribute('role', 'tablist');
  board.setAttribute('aria-label', 'Show');
  const rows = el('ul', 'rows');
  const phone = el('footer', 'phone');
  list.append(head, board, rows, phone);
  const thread = el('section', 'thread');
  shell.append(list, thread);
  root.replaceChildren(shell);
  // Up and down arrows move through the list.
  rows.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...rows.querySelectorAll<HTMLButtonElement>('.row')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  return { rows, phone, thread, board };
}

function renderPhone(s: SmsState, phone: HTMLElement): void {
  const p = s.phone!;
  phone.toggleAttribute('data-connected', p.connected);
  const forget = el('button', 'link', 'Forget');
  forget.type = 'button';
  forget.title = `Stop syncing with ${p.name}`;
  forget.addEventListener('click', () => {
    if (confirm(`Forget ${p.name}? Its texts leave this computer, and you will need to connect it again.`)) api.forgetPhone();
  });
  phone.replaceChildren(el('span', 'phone-dot'), el('span', 'phone-name', p.connected ? `${p.name}, connected` : `${p.name}, not connected`), forget);
}

/** The board: All and one chip per line, each with its unread count; a chip filters the list. */
function renderBoard(s: SmsState, board: HTMLElement): void {
  const all = entries(s);
  board.replaceChildren(
    ...GROUPS.filter((g) => g.id === null || all.some((e) => groupOf(e) === g.id)).map((g) => {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(filter === g.id));
      if (g.id) chip.dataset.line = g.id;
      const unread = all.filter((e) => g.id === null || groupOf(e) === g.id).reduce((n, e) => n + unreadOf(e), 0);
      chip.append(el('span', 'chip-label', g.label));
      if (unread) chip.append(el('span', 'chip-count', unread > 99 ? '99+' : String(unread)));
      chip.setAttribute('aria-label', unread ? `${g.label}, ${unread} unread` : g.label);
      chip.addEventListener('click', () => {
        filter = g.id;
        if (state) renderInbox(state);
      });
      return chip;
    }),
  );
}

function renderRows(s: SmsState, rows: HTMLUListElement): void {
  const focusedKey = (document.activeElement as HTMLElement | null)?.dataset.key;
  const q = query.trim().toLowerCase();
  const matches = (e: Entry) =>
    e.kind === 'chat'
      ? e.c.title.toLowerCase().includes(q) || e.c.messages.some((m) => m.text.toLowerCase().includes(q))
      : `${e.m.sender ?? ''} ${e.m.subject}`.toLowerCase().includes(q);
  const shown = entries(s).filter((e) => (filter === null || groupOf(e) === filter) && (!q || matches(e)));
  if (shown.length === 0) {
    rows.replaceChildren(
      el('li', 'no-match', q ? `Nothing matches \u201c${query.trim()}\u201d. Search looks at names, subjects and message text.` : 'Nothing here yet. New messages appear as they arrive on your phone.'),
    );
    return;
  }
  rows.replaceChildren(
    ...shown.map((e) => {
      const li = el('li');
      const row = el('button', 'row');
      row.type = 'button';
      const key = keyOf(e);
      row.dataset.key = key;
      row.setAttribute('aria-current', String(key === openKey));
      const unread = unreadOf(e);
      row.toggleAttribute('data-unread', unread > 0);
      const body = el('span', 'row-body');
      let title: string;
      let line: string;
      let source: SourceId;
      if (e.kind === 'chat') {
        title = e.c.title;
        line = preview(e.c.messages.at(-1));
        source = e.c.source;
      } else {
        title = e.m.sender ?? 'Sender hidden';
        line = e.m.subject;
        source = e.m.source;
      }
      body.append(el('span', 'row-title', title), el('span', 'row-time', rowTime(timeOf(e))), el('span', 'row-text', line));
      if (unread > 0) body.append(el('span', 'lamp', e.kind === 'mail' ? '' : unread > 99 ? '99+' : String(unread)));
      else body.append(el('span'));
      row.append(avatar(title, source), body);
      row.setAttribute('aria-label', `${title}, ${SOURCE_UI[source].app}${unread ? ', unread' : ''}, ${line}`);
      row.addEventListener('click', () => open(key));
      li.append(row);
      return li;
    }),
  );
  if (focusedKey) rows.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
}

function picture(id: string): HTMLImageElement {
  const img = el('img', 'bubble-image');
  img.alt = 'Picture';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.tabIndex = 0;
  img.title = 'Open full size';
  const enlarge = () => {
    if (img.naturalWidth > 0) showFullSize(img.src);
  };
  img.addEventListener('click', enlarge);
  img.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      enlarge();
    }
  });
  img.addEventListener('load', () => delete img.dataset.loading);
  img.addEventListener('error', () => {
    delete img.dataset.loading;
    img.alt = 'Picture not available from the phone';
    img.dataset.missing = '';
  });
  // Main serves the picture, asking the phone the first time; one already shown is in Blink's cache.
  img.src = imageUrl(id);
  if (!img.complete) img.dataset.loading = '';
  return img;
}

/** A picture at full size over the view; a click, Escape or the close button dismisses it. */
function showFullSize(src: string): void {
  const dialog = el('dialog', 'lightbox');
  dialog.setAttribute('aria-label', 'Picture');
  const img = el('img');
  img.src = src;
  img.alt = 'Picture';
  const close = el('button', 'lightbox-close', 'Close');
  close.type = 'button';
  dialog.append(img, close);
  dialog.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

function renderNewText(s: SmsState, thread: HTMLElement): void {
  if (thread.dataset.key !== NEW_TEXT) {
    const head = el('header', 'thread-head');
    head.append(el('h1', '', 'New text'));
    const form = el('form', 'new-form');
    const to = el('input');
    to.type = 'tel';
    to.placeholder = 'Phone number';
    to.setAttribute('aria-label', 'Phone number');
    const body = el('textarea');
    body.rows = 4;
    body.placeholder = 'Text';
    body.setAttribute('aria-label', 'Text');
    const send = el('button', 'send', 'Send');
    send.type = 'submit';
    const note = el('p', 'composer-note');
    form.append(to, body, send, note);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!to.value.trim() || !body.value.trim()) return;
      api.send(to.value.trim(), body.value);
      body.value = '';
    });
    thread.replaceChildren(head, form);
    thread.dataset.key = NEW_TEXT;
    to.focus();
  }
  const send = thread.querySelector<HTMLButtonElement>('.send')!;
  const note = thread.querySelector<HTMLParagraphElement>('.composer-note')!;
  const connected = s.phone?.connected === true;
  send.disabled = !connected || s.newText.sending;
  send.textContent = s.newText.sending ? 'Sending…' : 'Send';
  note.toggleAttribute('data-failed', Boolean(s.newText.failure));
  note.textContent = s.newText.failure
    ? `Not sent: ${s.newText.failure}.`
    : connected
      ? 'Sent from your phone as a normal text. It shows in the list once the phone has sent it. Needs "Allow texts and contacts" in Connect to PC on the phone.'
      : 'Your phone is not connected.';
}

/** "Open in WhatsApp": loads that website in Kainos, on demand. */
function openInApp(source: SourceId): HTMLButtonElement | null {
  const ui = SOURCE_UI[source];
  if (!ui.website) return null;
  const button = el('button', 'open-app', `Open in ${ui.app}`);
  button.type = 'button';
  button.addEventListener('click', () => api.openService(ui.website!));
  return button;
}

const ACTION_LABEL: Record<MailAction, string> = { archive: 'Archive', trash: 'Trash', markRead: 'Mark read' };
const REQUESTED: Record<MailAction, string> = { archive: 'Archive requested', trash: 'Trash requested', markRead: 'Marked read' };

/** A mail: the phone only knows sender and subject, so the body is one click away in the website. */
function renderMail(s: SmsState, mail: SyncMail, thread: HTMLElement): void {
  const head = el('header', 'thread-head');
  const names = el('div', 'thread-names');
  const sender = mail.sender ?? 'Sender hidden';
  names.append(el('h1', '', sender), el('p', '', mail.account ? `${mail.sourceLabel} · to ${mail.account}` : mail.sourceLabel));
  head.append(avatar(sender, mail.source, 'head'), names);
  const open = openInApp(mail.source);
  if (open) head.append(open);
  const body = el('section', 'mail');
  body.append(el('p', 'mail-time', `${dayLabel(mail.timeMs)}, ${time.format(mail.timeMs)}`), el('h2', 'mail-subject', mail.subject));
  if (!mail.sender) body.append(el('p', 'mail-note', `${mail.sourceLabel} hid the sender. Turn on its extended notifications on the phone to see who mail is from.`));
  body.append(el('p', 'mail-note', `The phone's notification carries only the sender and subject. The mail itself is in ${SOURCE_UI[mail.source].app}.`));
  const actions = el('div', 'mail-actions');
  for (const action of mail.actions) {
    const button = el('button', 'secondary', ACTION_LABEL[action]);
    button.type = 'button';
    button.disabled = s.phone?.connected !== true || s.sending.includes(mail.key);
    button.addEventListener('click', () => api.mailAction(mail.key, action));
    actions.append(button);
  }
  if (mail.actions.length) body.append(actions);
  const failure = s.failures[mail.key];
  if (failure) body.append(el('p', 'composer-note problem', `Not done: ${failure}.`));
  else if (mail.requested) body.append(el('p', 'mail-note', `${REQUESTED[mail.requested]}. ${SOURCE_UI[mail.source].app} doesn't confirm it.`));
  else if (!mail.actions.length) body.append(el('p', 'mail-note', `Its notification is gone from the phone, so do this in ${SOURCE_UI[mail.source].app}.`));
  thread.replaceChildren(head, body);
  thread.dataset.key = mail.key;
}

/** What the open conversation's thread was last built from, to skip rebuilding it unchanged. */
let threadSignature = '';

function renderThread(s: SmsState, thread: HTMLElement): void {
  if (openKey === NEW_TEXT) return renderNewText(s, thread);
  const mail = s.mails.find((m) => m.key === openKey);
  if (mail) return renderMail(s, mail, thread);
  const conversation = s.conversations.find((c) => c.key === openKey);
  if (!conversation) {
    const empty = el('div', 'empty-thread');
    const count = s.conversations.length + s.mails.length;
    const [title, body] = count
      ? ['Your inbox', `${count} item${count === 1 ? '' : 's'} from ${s.phone?.name ?? 'your phone'}. Pick one, or write a new text.`]
      : s.phone?.connected
        ? ['Nothing yet', 'Messages and mail appear here as they arrive on your phone. To see older texts, allow texts and contacts in Connect to PC on the phone.']
        : ['Your phone is not connected', 'Open Kainos Talk on the phone, on the same Wi-Fi as this computer.'];
    empty.append(mark('mark mark-large'), el('h2', '', title), el('p', '', body));
    thread.replaceChildren(empty);
    thread.dataset.key = '';
    return;
  }
  const sameThread = thread.dataset.key === conversation.key;
  // Unread does not show in the thread; leaving it out keeps marking read from rebuilding it.
  const signature = JSON.stringify([{ ...conversation, unread: 0 }, s.sending.includes(conversation.key), s.failures[conversation.key] ?? null, s.phone?.connected === true]);
  if (sameThread && signature === threadSignature) return;
  threadSignature = signature;
  const textarea = sameThread ? thread.querySelector('textarea') : null;
  const bubbles = el('ol', 'bubbles');
  bubbles.setAttribute('aria-label', `Messages with ${conversation.title}`);
  let lastDay = 0;
  conversation.messages.forEach((message, index) => {
    const day = startOfDay(message.timeMs);
    if (day !== lastDay) {
      bubbles.append(el('li', 'day', dayLabel(message.timeMs)));
      lastDay = day;
    }
    const bubble = el('li', 'bubble');
    bubble.toggleAttribute('data-out', message.outgoing);
    if (conversation.isGroup && !message.outgoing && message.sender) bubble.append(el('span', 'bubble-from', message.sender));
    if (message.image) bubble.append(picture(message.image));
    const isLast = index === conversation.messages.length - 1;
    const meta = message.outgoing && isLast && STATUS[message.status] ? `${STATUS[message.status]}, ${time.format(message.timeMs)}` : time.format(message.timeMs);
    // The time sits at the end of the last line, as on the phone.
    const text = el('span', 'bubble-text');
    if (message.text) text.append(document.createTextNode(message.text));
    else if (!message.image) text.append(document.createTextNode(`[${message.media ?? 'media'}]`));
    text.append(el('span', 'bubble-meta', meta));
    bubble.toggleAttribute('data-failed', message.status === 'failed');
    bubble.append(text);
    bubbles.append(bubble);
  });

  const head = el('header', 'thread-head');
  const names = el('div', 'thread-names');
  const kind = conversation.source === 'sms' ? (conversation.isGroup ? 'Group text' : 'Text message') : `${conversation.sourceLabel}${conversation.isGroup ? ' group' : ''}`;
  names.append(el('h1', '', conversation.title), el('p', '', kind));
  head.append(avatar(conversation.title, conversation.source, 'head'), names);
  const open = openInApp(conversation.source);
  if (open) head.append(open);
  const composer = composerFor(s, conversation, textarea);
  const previousScroll = sameThread ? thread.querySelector('.bubbles') : null;
  const atBottom = !previousScroll || previousScroll.scrollHeight - previousScroll.scrollTop - previousScroll.clientHeight < 40;
  thread.replaceChildren(head, bubbles, composer);
  thread.dataset.key = conversation.key;
  if (atBottom) bubbles.scrollTop = bubbles.scrollHeight;
  else bubbles.scrollTop = previousScroll!.scrollTop;
}

function composerFor(s: SmsState, conversation: SyncConversation, existing: HTMLTextAreaElement | null): HTMLElement {
  const form = el('form', 'composer');
  const textarea = existing ?? el('textarea');
  textarea.rows = 1;
  textarea.placeholder = conversation.source === 'sms' ? `Text ${conversation.title}` : `Reply through ${conversation.sourceLabel}`;
  textarea.setAttribute('aria-label', `Reply to ${conversation.title}`);
  if (!existing) {
    textarea.value = drafts.get(conversation.key) ?? '';
    // The textarea outlives re-renders (it keeps focus and the draft), so it looks up its
    // current form and button instead of holding on to the first ones.
    textarea.addEventListener('input', () => {
      drafts.set(conversation.key, textarea.value);
      const button = textarea.form?.querySelector<HTMLButtonElement>('.send');
      if (button && button.textContent?.trim() === 'Send') button.disabled = textarea.disabled || !textarea.value.trim();
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        textarea.form?.requestSubmit();
      }
    });
  }
  const connected = s.phone?.connected === true;
  const sending = s.sending.includes(conversation.key);
  textarea.disabled = !connected || !conversation.canReply;
  const send = el('button', 'send');
  send.type = 'submit';
  send.textContent = sending ? 'Sending…' : 'Send';
  send.setAttribute('aria-label', sending ? 'Sending' : `Send to ${conversation.title}`);
  send.prepend(icon(ICON.send));
  send.disabled = textarea.disabled || sending || !textarea.value.trim();
  const field = el('div', 'field');
  field.append(jack(conversation.source, true), textarea);
  form.append(field, send);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text || textarea.disabled) return;
    api.reply(conversation.key, text);
    textarea.value = '';
    drafts.delete(conversation.key);
  });
  const failure = s.failures[conversation.key];
  let note: string | undefined;
  if (failure) note = `Not sent: ${failure}. Try again, or reply on the phone.`;
  else if (!connected) note = 'Your phone is not connected, so replies can’t go out.';
  else if (!conversation.canReply) {
    note = conversation.source === 'sms'
      ? 'Reply on the phone: its notification for this conversation is gone.'
      : `Reply in ${SOURCE_UI[conversation.source].app}: its notification on the phone is gone, and replies go through it.`;
  }
  if (note) {
    const p = el('p', 'composer-note', note);
    p.toggleAttribute('data-failed', Boolean(failure));
    form.append(p);
  }
  return form;
}

function open(key: string): void {
  openKey = key;
  if (state) renderInbox(state);
  markOpenRead();
  inbox?.thread.querySelector('textarea')?.focus();
}

function markOpenRead(): void {
  if (!shown || !openKey) return;
  const conversation = state?.conversations.find((c) => c.key === openKey);
  const mail = state?.mails.find((m) => m.key === openKey);
  if ((conversation && conversation.unread > 0) || (mail && !mail.read)) api.markRead(openKey);
}

function renderInbox(s: SmsState): void {
  if (!inbox) inbox = buildInbox();
  if (openKey && openKey !== NEW_TEXT && !s.conversations.some((c) => c.key === openKey) && !s.mails.some((m) => m.key === openKey)) openKey = undefined;
  renderPhone(s, inbox.phone);
  renderBoard(s, inbox.board);
  renderRows(s, inbox.rows);
  renderThread(s, inbox.thread);
}

/** The state the page shows; a newer one waits for the next frame, or for the Inbox to be seen. */
let painted: SmsState | undefined;
let frame = 0;
/** The Inbox is in sight, as main tells it. */
let shown = false;

function render(s: SmsState): void {
  state = s;
  const total = s.conversations.reduce((sum, c) => sum + c.unread, 0) + s.mails.filter((m) => !m.read).length;
  // The sidebar reads the unread count from this title, as for every other service, hidden or not.
  document.title = total ? `(${total > 99 ? '99+' : total}) Inbox` : 'Inbox';
  if (shown && !frame) frame = requestAnimationFrame(paint);
}

function paint(): void {
  frame = 0;
  const s = state;
  // Hidden since this frame was asked for: the newest state waits, unpainted, for the next show.
  if (!shown || !s || s === painted) return;
  painted = s;
  if (!s.phone || s.pairing) {
    inbox = undefined;
    renderSetup(s);
    return;
  }
  renderInbox(s);
  markOpenRead();
}

api.onShown((now) => {
  shown = now;
  if (!now) return;
  paint();
  markOpenRead();
});
api.onState(render);
// A desktop notification was clicked: show what it was about, whatever the filter.
api.onOpenKey((key) => {
  filter = null;
  open(key);
});
void api.getState().then(render);
