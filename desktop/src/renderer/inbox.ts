import { imageUrl, isPhoneNumber, type SmsApi, type SmsState } from '../shared/sms.ts';
import type { CallEntry, SyncConversation, SyncMessage } from '../shared/sync-protocol.ts';
import { callLabel, caller, clock, matchingCalls, timeline } from './calls.ts';
import { findCode, groupCode, matching, splitBySender, unreadIn } from './texts.ts';
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

function button(className: string, text?: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A line icon on the 24 grid (1.8 stroke, round caps). */
function icon(paths: readonly string[], className = 'ic'): SVGSVGElement {
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
  copy: ['M9.5 8.5H18A1.5 1.5 0 0 1 19.5 10v8.5A1.5 1.5 0 0 1 18 20H9.5A1.5 1.5 0 0 1 8 18.5V10a1.5 1.5 0 0 1 1.5-1.5z', 'M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  linkOff: ['M3.5 9.5a12.5 12.5 0 0 1 17 0', 'M7 13.2a7.5 7.5 0 0 1 10 0', 'M12 17.4v.2', 'M4.5 3.5l15 17'],
  call: ['M6.6 3.5h2.6l1.5 4-2 1.3a11 11 0 0 0 6.5 6.5l1.3-2 4 1.5v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z'],
  hangUp: ['M3.2 14.2c4.9-4.3 12.7-4.3 17.6 0l-1.9 3-3.5-1.3v-2.5a10.5 10.5 0 0 0-6.8 0v2.5l-3.5 1.3z'],
};

/** The Kainos mark: a tile with a ring and a dot. */
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

function avatar(title: string): HTMLElement {
  const tile = el('span', 'avatar');
  tile.setAttribute('aria-hidden', 'true');
  const letters = initials(title);
  if (letters) tile.append(el('span', '', letters));
  else tile.append(icon(ICON.phone));
  return tile;
}

function count(n: number): HTMLElement {
  return n > 0 ? el('span', 'count', n > 99 ? '99+' : String(n)) : el('span');
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

/** The lists' time column: the time today, the weekday this week, else the date. */
function rowTime(ms: number): string {
  const days = (startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000;
  if (days < 1) return time.format(ms);
  if (days < 7) return weekday.format(ms);
  return date.format(ms);
}

function messageText(message: SyncMessage | undefined): string {
  if (!message) return '';
  return message.text || (message.media ? `${message.media[0]!.toUpperCase()}${message.media.slice(1)}` : 'Message');
}

function preview(message: SyncMessage | undefined): string {
  const text = messageText(message);
  return message?.outgoing ? `You: ${text}` : text;
}

const STATUS: Record<string, string> = { sending: 'Sending', sent: 'Sent', confirmed: 'Delivered', failed: 'Not sent' };

/** Puts the code on the clipboard and shows it worked on the control for a moment. */
function copyCode(control: HTMLElement, code: string): void {
  api.copyCode(code);
  control.dataset.copied = '';
  control.querySelector('svg')?.replaceWith(icon(ICON.check));
  const label = control.querySelector('small');
  if (label) label.textContent = 'Copied';
  setTimeout(() => {
    delete control.dataset.copied;
    control.querySelector('svg')?.replaceWith(icon(ICON.copy));
    if (label) label.textContent = 'Copy';
  }, 1500);
}

function codeButton(code: string, className: 'chip' | 'code-inline'): HTMLButtonElement {
  const node = button(className);
  node.title = `Copy ${code}`;
  node.setAttribute('aria-label', `Copy code ${code}`);
  node.append(document.createTextNode(groupCode(code)), icon(ICON.copy));
  if (className === 'chip') node.append(el('small', '', 'Copy'));
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    copyCode(node, code);
  });
  return node;
}

let state: SmsState | undefined;
/** The conversation in the middle pane; none shows the new-text form. */
let openKey: string | undefined;
/** The left column's list. Notices has its own column from 1500px, so there it shows as People. */
let tab: 'people' | 'notices' | 'calls' = 'people';
/** A number to put in the call form the next time it opens (from a call with no conversation). */
let dialPrefill = '';
/** A failed call action the user dismissed; the bar shows the next one. */
let dismissedFailure: string | null = null;
/** What is wrong with the number in the call form, found before it goes to the phone. */
let dialProblem: string | null = null;
/** What the search box holds; both lists show matching conversations only. */
let query = '';
const drafts = new Map<string, string>();
const narrow = matchMedia('(max-width: 1499px)');

// --- Setup screens: waiting for a phone, or a phone asking to pair ---

function renderSetup(s: SmsState): void {
  const card = el('section', 'card');
  if (s.pairing) {
    card.append(
      el('h1', '', `${s.pairing.device} wants to connect`),
      el('p', '', 'Check that your phone shows the same code. Confirm on both: Connect here, Codes match on the phone.'),
    );
    const code = el('div', 'pair-code', groupCode(s.pairing.code));
    code.setAttribute('aria-label', `Code ${s.pairing.code.split('').join(' ')}`);
    if (s.pairing.pcAccepted) {
      card.append(code, el('p', '', s.pairing.phoneConfirmed ? 'Connecting…' : 'Waiting for the phone: press Codes match there.'), el('div', 'signal'));
      root.replaceChildren(wrap(card));
      return;
    }
    if (s.pairing.phoneConfirmed) card.append(el('p', '', 'The phone says the codes match.'));
    const accept = button('primary', 'Connect');
    accept.addEventListener('click', () => api.answerPairing(true));
    const refuse = button('secondary', "Don't connect");
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
    el('p', '', 'Your texts (SMS and RCS) come from the Kainos Talk app on your Android phone, over your home network. Nothing goes through the internet.'),
  );
  const steps = el('ol', 'steps');
  const step = (...parts: (string | Node)[]) => {
    const li = el('li');
    li.append(...parts);
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

// --- Texts: people on the left, the open conversation in the middle, notices on the right ---

interface Texts {
  readonly shell: HTMLElement;
  readonly offline: HTMLElement;
  readonly callBar: HTMLElement;
  readonly people: HTMLElement;
  readonly compose: HTMLButtonElement;
  readonly peopleRows: HTMLUListElement;
  readonly callRows: HTMLUListElement;
  readonly tabs: { readonly people: HTMLButtonElement; readonly notices: HTMLButtonElement; readonly calls: HTMLButtonElement };
  readonly notices: HTMLElement;
  /** Head and feed of the notices: in the right column, or under the tabs in a narrow window. */
  readonly noticesBody: HTMLElement;
  readonly noticesUnread: HTMLElement;
  readonly markAll: HTMLButtonElement;
  readonly noticeRows: HTMLUListElement;
  readonly middle: HTMLElement;
}
let texts: Texts | undefined;

/** Up and down arrows move through a list's buttons. */
function arrowKeys(list: HTMLElement, selector: string): void {
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(selector)];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
}

function buildTexts(): Texts {
  const shell = el('div', 'texts');
  const offline = el('div', 'offline-bar');
  offline.setAttribute('role', 'status');
  const callBar = el('section', 'call-bar');
  callBar.setAttribute('aria-label', 'Call');

  const people = el('nav', 'side people');
  people.setAttribute('aria-label', 'People');
  const tools = el('div', 'side-tools');
  const search = el('label', 'search');
  const field = el('input');
  field.type = 'search';
  field.placeholder = 'Search texts';
  field.setAttribute('aria-label', 'Search texts');
  field.value = query;
  field.addEventListener('input', () => {
    query = field.value;
    if (state) renderLists(state);
  });
  search.append(icon(ICON.search), field);
  const compose = button('new-text');
  compose.addEventListener('click', () => open(undefined));
  tools.append(search, compose);

  const seg = el('div', 'seg');
  seg.setAttribute('role', 'tablist');
  seg.setAttribute('aria-label', 'Lists');
  const tabButton = (name: typeof tab, label: string) => {
    const node = button('');
    node.setAttribute('role', 'tab');
    node.dataset.tab = name;
    node.append(el('span', '', label), el('span'));
    node.addEventListener('click', () => {
      tab = name;
      if (state) renderTexts(state);
    });
    return node;
  };
  const tabs = { people: tabButton('people', 'People'), notices: tabButton('notices', 'Notices'), calls: tabButton('calls', 'Calls') };
  seg.append(tabs.people, tabs.notices, tabs.calls);

  const peopleRows = el('ul', 'rows people-rows');
  arrowKeys(peopleRows, '.row');
  const callRows = el('ul', 'rows call-rows');
  callRows.setAttribute('aria-label', 'Recent calls');
  arrowKeys(callRows, '.row');
  people.append(tools, seg, peopleRows, callRows);

  const notices = el('aside', 'side notices');
  notices.setAttribute('aria-label', 'Notices');
  const noticesBody = el('div', 'notices-body');
  const noticesHead = el('header', 'side-head');
  const noticesUnread = el('span');
  const markAll = button('quiet', 'Mark all read');
  markAll.addEventListener('click', () => {
    for (const c of state ? splitBySender(state.conversations).notices : []) if (c.unread > 0) api.markRead(c.key);
  });
  noticesHead.append(el('h2', '', 'Notices'), noticesUnread, markAll);
  const noticeRows = el('ul', 'rows notice-rows');
  arrowKeys(noticeRows, '.notice-open');
  noticesBody.append(noticesHead, noticeRows);
  notices.append(noticesBody);

  const middle = el('section', 'middle');
  shell.append(offline, callBar, people, middle, notices);
  root.replaceChildren(shell);
  return { shell, offline, callBar, people, compose, peopleRows, callRows, tabs, notices, noticesBody, noticesUnread, markAll, noticeRows, middle };
}

/** In a narrow window the notices move under the tabs in the left column; wide, they have their own. */
function placeNotices(t: Texts): void {
  const parent = narrow.matches ? t.people : t.notices;
  if (t.noticesBody.parentElement !== parent) parent.append(t.noticesBody);
}

function renderOffline(s: SmsState, t: Texts): void {
  const off = s.phone?.connected !== true;
  t.shell.toggleAttribute('data-offline', off);
  if (!off) {
    t.offline.replaceChildren();
    return;
  }
  const line = el('p');
  line.append(el('b', '', 'Your phone is not connected.'), ' ', el('span', '', 'Open Kainos Talk on the phone, on the same Wi-Fi as this computer.'));
  t.offline.replaceChildren(icon(ICON.linkOff), line);
}

/** The phone's call, across the top: who, how long, and its buttons. */
function renderCallBar(s: SmsState, bar: HTMLElement): void {
  const call = s.call;
  const failure = s.callAction.failure;
  // A new attempt shows its own failure, even one worded like the dismissed one.
  if (s.callAction.pending) dismissedFailure = null;
  if (!call && (!failure || failure === dismissedFailure)) {
    delete bar.dataset.phase;
    delete bar.dataset.signature;
    bar.replaceChildren();
    return;
  }
  const signature = JSON.stringify([call, s.callAction]);
  if (bar.dataset.signature === signature) return;
  bar.dataset.signature = signature;
  if (!call) {
    bar.dataset.phase = 'failed';
    const dismiss = button('quiet', 'Dismiss');
    dismiss.addEventListener('click', () => {
      dismissedFailure = failure;
      renderCallBar(s, bar);
    });
    bar.replaceChildren(el('p', 'call-problem', `Your phone didn’t do that: ${failure}.`), dismiss);
    return;
  }
  bar.dataset.phase = call.phase;
  const who = el('div', 'call-who');
  const name = caller(call);
  const detail = el('p', 'call-detail');
  if (call.phase === 'ringing') detail.textContent = call.name && call.number ? `${call.number} is calling your phone` : 'Calling your phone';
  else {
    const since = el('span', 'call-clock');
    since.dataset.since = String(call.sinceMs);
    since.textContent = clock(Date.now() - call.sinceMs);
    detail.append(since, ` ${call.direction === 'incoming' ? 'on the call' : 'calling out'}. Sound comes through this computer while your phone is connected to it over Bluetooth.`);
  }
  who.append(el('h2', '', name), detail);
  const lamp = el('span', 'call-lamp');
  lamp.setAttribute('aria-hidden', 'true');
  const actions = el('div', 'call-actions');
  const pending = s.callAction.pending;
  if (call.phase === 'ringing') {
    const decline = button('call-end', 'Decline');
    decline.prepend(icon(ICON.hangUp));
    decline.disabled = pending;
    decline.addEventListener('click', () => api.hangUp());
    const answer = button('call-answer', 'Answer');
    answer.prepend(icon(ICON.call));
    answer.disabled = pending;
    answer.addEventListener('click', () => api.answer());
    actions.append(decline, answer);
  } else {
    const end = button('call-end', 'End call');
    end.prepend(icon(ICON.hangUp));
    end.disabled = pending;
    end.addEventListener('click', () => api.hangUp());
    actions.append(end);
  }
  bar.replaceChildren(lamp, who, actions);
  if (failure) bar.append(el('p', 'call-problem', `Your phone didn’t do that: ${failure}.`));
}

/** The call bar's clock moves on its own; the rest of the page only changes with the state. */
setInterval(() => {
  for (const since of document.querySelectorAll<HTMLElement>('.call-clock')) since.textContent = clock(Date.now() - Number(since.dataset.since));
}, 1000);

function noMatch(empty: string): HTMLLIElement {
  return el('li', 'no-match', query.trim() ? `Nothing matches “${query.trim()}”. Search looks at names and message text.` : empty);
}

function personRow(c: SyncConversation): HTMLLIElement {
  const li = el('li');
  const row = button('row');
  row.dataset.key = c.key;
  row.setAttribute('aria-current', String(c.key === openKey));
  row.toggleAttribute('data-unread', c.unread > 0);
  const line = preview(c.messages.at(-1));
  const body = el('span', 'row-body');
  const side = el('span', 'row-side');
  side.append(count(c.unread));
  body.append(el('span', 'row-title', c.title), el('span', 'row-time', rowTime(c.lastActivityMs)), el('span', 'row-text', line), side);
  row.append(avatar(c.title), body);
  row.setAttribute('aria-label', `${c.title}${c.unread ? `, ${c.unread} unread` : ''}, ${line}`);
  row.addEventListener('click', () => open(c.key));
  li.append(row);
  return li;
}

/** A notice is read where it lies: its latest text in full, and its code ready to copy. */
function noticeItem(c: SyncConversation): HTMLLIElement {
  const li = el('li', 'notice-item');
  li.dataset.key = c.key;
  li.setAttribute('aria-current', String(c.key === openKey));
  li.toggleAttribute('data-unread', c.unread > 0);
  const last = c.messages.at(-1);
  const text = messageText(last);
  const opener = button('notice-open');
  opener.dataset.key = c.key;
  opener.append(el('b', '', c.title));
  opener.setAttribute('aria-label', `${c.title}${c.unread ? ', unread' : ''}: ${text}`);
  opener.addEventListener('click', () => open(c.key));
  const stamp = el('time', '', rowTime(c.lastActivityMs));
  stamp.dateTime = new Date(c.lastActivityMs).toISOString();
  li.append(el('span', 'dot'), opener, stamp, el('p', '', text));
  const code = last && !last.outgoing ? findCode(last.text) : undefined;
  if (code) li.append(codeButton(code, 'chip'));
  return li;
}

function renderLists(s: SmsState): void {
  const t = texts!;
  const { people, notices } = splitBySender(s.conversations);
  const focused = (document.activeElement as HTMLElement | null)?.dataset;
  const shown = shownTab();
  t.shell.dataset.tab = shown;
  for (const [name, list] of [['people', people], ['notices', notices], ['calls', []]] as const) {
    const node = t.tabs[name];
    node.setAttribute('aria-selected', String(shown === name));
    node.lastElementChild!.replaceWith(count(unreadIn(list)));
  }
  const calling = shown === 'calls';
  t.compose.title = calling ? 'Call a number' : 'New text';
  t.compose.setAttribute('aria-label', t.compose.title);
  t.compose.replaceChildren(icon(calling ? ICON.call : ICON.compose));
  const noticesUnread = unreadIn(notices);
  t.noticesUnread.textContent = noticesUnread ? `${noticesUnread} unread` : '';
  t.markAll.disabled = noticesUnread === 0;

  const shownPeople = matching(people, query);
  t.peopleRows.replaceChildren(
    ...(shownPeople.length ? shownPeople.map(personRow) : [noMatch(s.conversations.length ? 'No texts from people yet.' : 'No texts yet. New texts appear as they arrive on your phone.')]),
  );
  const shownNotices = matching(notices, query);
  t.noticeRows.replaceChildren(...(shownNotices.length ? shownNotices.map(noticeItem) : [noMatch('Codes, deliveries and other automated texts land here.')]));
  const shownCalls = matchingCalls(s.calls, query);
  t.callRows.replaceChildren(
    ...(shownCalls.length ? shownCalls.map((entry) => callRow(entry, s)) : [noMatch('No calls yet. To see them here, allow calls in Connect to PC on the phone.')]),
  );
  if (focused?.key) t.shell.querySelector<HTMLElement>(`button[data-key="${CSS.escape(focused.key)}"]`)?.focus();
  else if (focused?.call) t.shell.querySelector<HTMLElement>(`button[data-call="${CSS.escape(focused.call)}"]`)?.focus();
}

/** The list the left column shows: Notices only in a narrow window, where it has no column of its own. */
function shownTab(): typeof tab {
  return tab === 'notices' && !narrow.matches ? 'people' : tab;
}

/** A call in the log. Opening it shows its conversation, or the call form with its number. */
function callRow(entry: CallEntry, s: SmsState): HTMLLIElement {
  const li = el('li');
  const row = button('row call-row');
  row.dataset.call = entry.id;
  const who = caller(entry);
  const label = callLabel(entry);
  const body = el('span', 'row-body');
  const text = el('span', 'row-text', label);
  text.toggleAttribute('data-missed', entry.kind === 'missed');
  body.append(el('span', 'row-title', who), el('span', 'row-time', rowTime(entry.timeMs)), text);
  row.append(avatar(entry.name ?? ''), body);
  const conversation = entry.key ? s.conversations.find((c) => c.key === entry.key) : undefined;
  row.setAttribute('aria-label', `${who}, ${label}, ${rowTime(entry.timeMs)}`);
  row.title = conversation ? `Open your texts with ${who}` : entry.number ? `Call ${entry.number}` : '';
  row.disabled = !conversation && !entry.number;
  row.addEventListener('click', () => {
    if (conversation) return open(conversation.key, true);
    dialPrefill = entry.number ?? '';
    open(undefined);
  });
  li.append(row);
  return li;
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
  const close = button('lightbox-close', 'Close');
  dialog.append(img, close);
  dialog.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

const NEW_TEXT = '\u0000new';
const DIAL = '\u0000dial';

/** Nothing open in Calls: the middle pane is the call form. */
function renderDial(s: SmsState, middle: HTMLElement): void {
  if (middle.dataset.key !== DIAL) {
    const blank = el('div', 'blank');
    const form = el('form', 'new-form');
    const to = el('input', 'input');
    to.type = 'tel';
    to.placeholder = 'Phone number';
    to.autocomplete = 'off';
    to.id = 'dial-to';
    const toLabel = el('label', '', 'Number');
    toLabel.htmlFor = to.id;
    const call = el('button', 'primary send');
    call.type = 'submit';
    call.append(icon(ICON.call), el('span', '', 'Call'));
    const footer = el('footer');
    footer.append(call, el('p', 'composer-note'));
    form.append(
      el('h1', '', 'Call a number'),
      el('p', 'lead', 'Your phone places the call. You hear it on this computer while the phone is connected to it over Bluetooth.'),
      toLabel,
      to,
      footer,
    );
    to.addEventListener('input', () => {
      if (!dialProblem) return;
      dialProblem = null;
      if (state) renderDial(state, middle);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (call.disabled) return;
      dialProblem = isPhoneNumber(to.value) ? null : 'Type a phone number: digits, with spaces, dashes or a leading + if you like.';
      if (!dialProblem) api.dial({ number: to.value.trim() });
      else if (state) renderDial(state, middle);
    });
    blank.append(form);
    middle.replaceChildren(blank);
    middle.dataset.key = DIAL;
  }
  const to = middle.querySelector<HTMLInputElement>('#dial-to')!;
  if (dialPrefill) {
    to.value = dialPrefill;
    dialPrefill = '';
  }
  const call = middle.querySelector<HTMLButtonElement>('.send')!;
  const note = middle.querySelector<HTMLParagraphElement>('.composer-note')!;
  const blocked = callBlocked(s);
  call.disabled = blocked !== undefined;
  call.lastElementChild!.textContent = s.callAction.pending ? 'Calling…' : 'Call';
  const problem = dialProblem ?? (s.callAction.failure ? `Not called: ${s.callAction.failure}.` : null);
  note.toggleAttribute('data-failed', problem !== null);
  note.textContent = problem ?? blocked ?? 'The number shows as yours, as for any call from your phone.';
}

/** Why a new call can't start now, if it can't. */
function callBlocked(s: SmsState): string | undefined {
  if (s.phone?.connected !== true) return 'Your phone is not connected, so it can’t place a call.';
  if (s.call) return 'Your phone is already on a call.';
  if (s.callAction.pending) return 'Waiting for your phone…';
  return undefined;
}

/** Nothing open: the middle pane is the new-text form, ready to type into. */
function renderNewText(s: SmsState, middle: HTMLElement): void {
  if (middle.dataset.key !== NEW_TEXT) {
    const blank = el('div', 'blank');
    const form = el('form', 'new-form');
    const lead = el('p', 'lead');
    const to = el('input', 'input');
    to.type = 'tel';
    to.placeholder = 'Phone number';
    to.autocomplete = 'off';
    to.id = 'new-to';
    const body = el('textarea', 'input tall');
    body.placeholder = 'Write your text';
    body.id = 'new-body';
    const toLabel = el('label', '', 'To');
    toLabel.htmlFor = to.id;
    const bodyLabel = el('label', '', 'Text');
    bodyLabel.htmlFor = body.id;
    const send = el('button', 'primary send');
    send.type = 'submit';
    send.append(icon(ICON.send), el('span', '', 'Send'));
    const footer = el('footer');
    footer.append(send, el('p', 'composer-note'));
    form.append(el('h1', '', 'New text'), lead, toLabel, to, bodyLabel, body, footer);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!to.value.trim() || !body.value.trim() || send.disabled) return;
      api.send(to.value.trim(), body.value);
      body.value = '';
    });
    blank.append(form);
    middle.replaceChildren(blank);
    middle.dataset.key = NEW_TEXT;
  }
  const total = s.conversations.length;
  middle.querySelector('.lead')!.textContent = total
    ? `Or pick a conversation on the left. ${s.phone?.name ?? 'Your phone'} has sent ${total} conversation${total === 1 ? '' : 's'}.`
    : 'No texts yet. They appear on the left as they arrive on your phone; to see older ones, allow texts and contacts in Connect to PC on the phone.';
  const send = middle.querySelector<HTMLButtonElement>('.send')!;
  const note = middle.querySelector<HTMLParagraphElement>('.composer-note')!;
  const connected = s.phone?.connected === true;
  send.disabled = !connected || s.newText.sending;
  send.lastElementChild!.textContent = s.newText.sending ? 'Sending…' : 'Send';
  note.toggleAttribute('data-failed', Boolean(s.newText.failure));
  note.textContent = s.newText.failure
    ? `Not sent: ${s.newText.failure}.`
    : connected
      ? 'Sent from your phone as a normal text.'
      : 'Your phone is not connected, so the text can’t go out.';
}

/** A message's text with its verification code, if any, as a Copy button inside the sentence. */
function textWithCode(text: string, outgoing: boolean): (string | Node)[] {
  const code = outgoing ? undefined : findCode(text);
  const at = code ? text.indexOf(code) : -1;
  if (!code || at < 0) return [text];
  return [text.slice(0, at), codeButton(code, 'code-inline'), text.slice(at + code.length)];
}

/** What the open conversation's thread was last built from, to skip rebuilding it unchanged. */
let threadSignature = '';

function renderThread(s: SmsState, middle: HTMLElement): void {
  const conversation = s.conversations.find((c) => c.key === openKey);
  if (!conversation) return shownTab() === 'calls' ? renderDial(s, middle) : renderNewText(s, middle);
  const sameThread = middle.dataset.key === conversation.key;
  const items = timeline(conversation.messages, s.calls, conversation.key);
  // Unread does not show in the thread; leaving it out keeps marking read from rebuilding it.
  const signature = JSON.stringify([
    { ...conversation, unread: 0 },
    s.sending.includes(conversation.key),
    s.failures[conversation.key] ?? null,
    s.phone?.connected === true,
    items.filter((item) => item.kind === 'call'),
    callBlocked(s) ?? null,
  ]);
  if (sameThread && signature === threadSignature) return;
  threadSignature = signature;
  const textarea = sameThread ? middle.querySelector('textarea') : null;
  const bubbles = el('ol', 'bubbles');
  bubbles.setAttribute('aria-label', `Messages with ${conversation.title}`);
  let lastDay = 0;
  const lastMessage = conversation.messages.at(-1);
  for (const item of items) {
    const at = item.kind === 'message' ? item.message.timeMs : item.call.timeMs;
    const day = startOfDay(at);
    if (day !== lastDay) {
      bubbles.append(el('li', 'day', dayLabel(at)));
      lastDay = day;
    }
    if (item.kind === 'call') {
      const line = el('li', 'call-line');
      line.toggleAttribute('data-missed', item.call.kind === 'missed');
      line.append(icon(ICON.call), el('span', '', `${callLabel(item.call)}, ${time.format(at)}`));
      bubbles.append(line);
      continue;
    }
    const message = item.message;
    const bubble = el('li', 'bubble');
    bubble.toggleAttribute('data-out', message.outgoing);
    if (conversation.isGroup && !message.outgoing && message.sender) bubble.append(el('span', 'bubble-from', message.sender));
    if (message.image) bubble.append(picture(message.image));
    const isLast = message === lastMessage;
    const meta = message.outgoing && isLast && STATUS[message.status] ? `${STATUS[message.status]}, ${time.format(message.timeMs)}` : time.format(message.timeMs);
    // The time sits at the end of the last line, as on the phone.
    const text = el('span', 'bubble-text');
    if (message.text) text.append(...textWithCode(message.text, message.outgoing));
    else if (!message.image) text.append(`[${message.media ?? 'media'}]`);
    text.append(el('span', 'bubble-meta', meta));
    bubble.toggleAttribute('data-failed', message.status === 'failed');
    bubble.append(text);
    bubbles.append(bubble);
  }

  const head = el('header', 'thread-head');
  const names = el('div');
  names.append(el('h1', '', conversation.title), el('p', '', conversation.isGroup ? 'Group text' : conversation.sender === 'service' ? 'Automated text' : 'Text message'));
  head.append(avatar(conversation.title), names);
  if (!conversation.isGroup && conversation.sender === 'person') {
    const call = button('quiet call-button');
    call.append(icon(ICON.call), el('span', '', 'Call'));
    const blocked = callBlocked(s);
    call.disabled = blocked !== undefined;
    call.title = blocked ?? `Call ${conversation.title} from your phone`;
    call.addEventListener('click', () => api.dial({ key: conversation.key }));
    head.append(call);
  }
  // Moving the reply box into the new thread drops its focus; a draft being typed keeps it.
  const typing = textarea && document.activeElement === textarea ? ([textarea.selectionStart, textarea.selectionEnd] as const) : undefined;
  const composer = composerFor(s, conversation, textarea);
  const previousScroll = sameThread ? middle.querySelector('.bubbles') : null;
  const atBottom = !previousScroll || previousScroll.scrollHeight - previousScroll.scrollTop - previousScroll.clientHeight < 40;
  const thread = el('div', 'thread');
  thread.append(head, bubbles, composer);
  middle.replaceChildren(thread);
  middle.dataset.key = conversation.key;
  if (typing && textarea && !textarea.disabled) {
    textarea.focus();
    textarea.setSelectionRange(...typing);
  }
  if (atBottom) bubbles.scrollTop = bubbles.scrollHeight;
  else bubbles.scrollTop = previousScroll!.scrollTop;
}

function composerFor(s: SmsState, conversation: SyncConversation, existing: HTMLTextAreaElement | null): HTMLElement {
  const form = el('form', 'composer');
  const textarea = existing ?? el('textarea');
  textarea.rows = 1;
  textarea.placeholder = `Text ${conversation.title}`;
  textarea.setAttribute('aria-label', `Reply to ${conversation.title}`);
  if (!existing) {
    textarea.value = drafts.get(conversation.key) ?? '';
    // The textarea outlives re-renders (it keeps focus and the draft), so it looks up its
    // current form and button instead of holding on to the first ones.
    textarea.addEventListener('input', () => {
      drafts.set(conversation.key, textarea.value);
      const send = textarea.form?.querySelector<HTMLButtonElement>('.send');
      if (send && send.dataset.sending === undefined) send.disabled = textarea.disabled || !textarea.value.trim();
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
  send.toggleAttribute('data-sending', sending);
  send.title = sending ? 'Sending' : 'Send';
  send.setAttribute('aria-label', sending ? 'Sending' : `Send to ${conversation.title}`);
  send.append(icon(ICON.send));
  send.disabled = textarea.disabled || sending || !textarea.value.trim();
  const field = el('div', 'field');
  field.append(textarea);
  form.toggleAttribute('data-off', textarea.disabled);
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
  else if (!conversation.canReply) note = 'Reply on the phone: its notification for this conversation is gone.';
  if (note) {
    const p = el('p', 'composer-note', note);
    p.toggleAttribute('data-failed', Boolean(failure));
    form.append(p);
  }
  return form;
}

/**
 * Shows a conversation in the middle pane, or for none the new-text form (the call form in
 * Calls). Opened from the call log, the conversation keeps Calls in the left column.
 */
function open(key: string | undefined, fromCalls = false): void {
  openKey = key;
  const conversation = key ? state?.conversations.find((c) => c.key === key) : undefined;
  if (conversation && !fromCalls) tab = conversation.sender === 'service' ? 'notices' : 'people';
  if (state && texts) renderTexts(state);
  markOpenRead();
  const target = conversation ? texts?.middle.querySelector('textarea') : texts?.middle.querySelector<HTMLInputElement>('#new-to, #dial-to');
  if (target && !target.disabled) target.focus();
}

function markOpenRead(): void {
  if (!shown || !openKey) return;
  const conversation = state?.conversations.find((c) => c.key === openKey);
  if (conversation && conversation.unread > 0) api.markRead(openKey);
}

function renderTexts(s: SmsState): void {
  if (!texts) texts = buildTexts();
  if (openKey && !s.conversations.some((c) => c.key === openKey)) openKey = undefined;
  placeNotices(texts);
  renderOffline(s, texts);
  renderCallBar(s, texts.callBar);
  renderLists(s);
  renderThread(s, texts.middle);
}

/** The state the page shows; a newer one waits for the next frame, or for the page to be seen. */
let painted: SmsState | undefined;
let frame = 0;
/** The Texts page is in sight, as main tells it. */
let shown = false;

function render(s: SmsState): void {
  state = s;
  const total = s.conversations.reduce((sum, c) => sum + c.unread, 0);
  // The dock reads the unread count from this title, as for every other service, hidden or not.
  document.title = total ? `(${total > 99 ? '99+' : total}) Texts` : 'Texts';
  if (shown && !frame) frame = requestAnimationFrame(paint);
}

function paint(): void {
  frame = 0;
  const s = state;
  // Hidden since this frame was asked for: the newest state waits, unpainted, for the next show.
  if (!shown || !s || s === painted) return;
  painted = s;
  if (!s.phone || s.pairing) {
    texts = undefined;
    renderSetup(s);
    return;
  }
  renderTexts(s);
  markOpenRead();
}

narrow.addEventListener('change', () => {
  if (texts && state) renderTexts(state);
});
api.onShown((now) => {
  shown = now;
  if (!now) return;
  paint();
  markOpenRead();
});
api.onState(render);
// A desktop notification was clicked: show that conversation, in its list.
api.onOpenKey(open);
void api.getState().then(render);
