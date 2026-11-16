import { dropIndex, makeRoom } from '../shared/dock-order.ts';
import { DOCK_FLOAT, type DockFrame, type DockSize, type KainosApi, type ServiceSnapshot, type Snapshot } from '../shared/ipc.ts';
import { unreadLabel } from '../shared/unread.ts';
import { describe } from './describe.ts';
import './styles.css';

declare global {
  interface Window {
    readonly kainos: KainosApi;
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const ICON = {
  phone: ['M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z', 'M11 18h2'],
  alert: ['M12 6.5v7', 'M12 17.3v.2'],
  bellOff: ['M7 16.5V11a5 5 0 0 1 10 0v5.5l1.5 2h-13z', 'M10.3 21h3.4', 'M4 4l16 16'],
  // A crescent moon: the service hibernates.
  moon: ['M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z'],
  linkOff: ['M3.5 9.5a12.5 12.5 0 0 1 17 0', 'M7 13.2a7.5 7.5 0 0 1 10 0', 'M12 17.4v.2', 'M4.5 3.5l15 17'],
};

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

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function serviceTile(service: ServiceSnapshot): HTMLElement {
  const tile = element('span', 'tile');
  tile.style.setProperty('--brand', service.color);
  tile.append(icon([service.glyph], `glyph-${service.paint}`));
  return tile;
}

interface Tab {
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly state: HTMLSpanElement;
  readonly name: string;
}

const tabs = new Map<string, Tab>();
const list = document.getElementById('tabs') as HTMLUListElement;
const dock = document.getElementById('dock') as HTMLElement;
const group = document.getElementById('group') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const phone = document.getElementById('phone') as HTMLButtonElement;
const announcer = document.getElementById('announce') as HTMLElement;
let current: Snapshot | undefined;
/** The tabs' service ids in the order the dock shows them now. */
let shownIds: string[] = [];

/** Where a dragged tab will land, behind the tab itself; always the list's last item. */
const slot = element('li', 'slot');
slot.setAttribute('aria-hidden', 'true');
slot.hidden = true;
list.append(slot);

const tabButtons = () => [...list.querySelectorAll<HTMLButtonElement>('.tab')];

/** Says something to screen readers; the same words twice are said twice. */
function announce(text: string): void {
  announcer.textContent = '';
  setTimeout(() => {
    announcer.textContent = text;
  }, 50);
}

function shortcutLabel(index: number): string {
  return navigator.platform.startsWith('Mac') ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

/** Where a menu opened from the keyboard goes: from the control's top-left corner, above the dock. */
function anchor(node: HTMLElement): { x: number; y: number } {
  const box = node.getBoundingClientRect();
  return { x: Math.round(box.left), y: Math.round(box.top) };
}

/**
 * A right-click opens a menu at the pointer. The Menu key or Shift+F10 fires contextmenu with no
 * pointer press before it, so that menu opens at the control instead.
 */
function onMenu(node: HTMLElement, open: (at?: { x: number; y: number }) => void): void {
  let pointerMenu = false;
  node.addEventListener('pointerdown', (event) => {
    pointerMenu = event.button === 2;
  });
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    open(pointerMenu ? undefined : anchor(node));
    pointerMenu = false;
  });
}

function createTab(service: ServiceSnapshot): Tab {
  const item = element('li', '');
  const button = element('button', 'tab');
  button.type = 'button';
  button.dataset.id = service.id;
  button.addEventListener('click', () => window.kainos.activate(service.id));
  onMenu(button, (at) => window.kainos.openServiceMenu(service.id, at));
  const state = element('span', 'state');
  state.setAttribute('aria-hidden', 'true');
  button.append(serviceTile(service), element('span', 'name', service.name), state);
  item.append(button);
  return { item, button, state, name: service.name };
}

/**
 * Puts the tabs in this order and takes out the rest. A focused tab keeps focus: moveBefore
 * moves it without blurring where Chromium has it, and focus is put back where it does not.
 */
function placeTabs(ids: readonly string[]): void {
  const focused = document.activeElement;
  ids.forEach((id, index) => {
    const item = tabs.get(id)?.item;
    const before = list.children[index] ?? slot;
    if (!item || before === item) return;
    const parent = list as HTMLUListElement & { moveBefore?: (node: Node, child: Node | null) => void };
    if (item.isConnected && parent.moveBefore) parent.moveBefore(item, before);
    else list.insertBefore(item, before);
  });
  for (const [id, tab] of tabs) if (!ids.includes(id)) tab.item.remove();
  shownIds = [...ids];
  if (focused instanceof HTMLButtonElement && focused.classList.contains('tab') && document.activeElement !== focused) {
    // A hidden tab's focus goes to the active service's tab.
    (focused.isConnected ? focused : current && tabs.get(current.activeId)?.button.isConnected ? tabs.get(current.activeId)!.button : tabButtons()[0])?.focus();
  }
}

const position = (ids: readonly string[], id: string) => `tab ${ids.indexOf(id) + 1} of ${ids.length}`;

/** Tells screen readers about tabs hidden or shown again, and a focused tab moved from a menu. */
function announceChanges(before: readonly string[], after: readonly string[], hiddenIds: readonly string[]): void {
  if (before.length === 0) return;
  const name = (id: string) => tabs.get(id)?.name ?? id;
  const said: string[] = [];
  for (const id of before) if (!after.includes(id) && hiddenIds.includes(id)) said.push(`${name(id)} hidden from the dock. Show it again from Dock options, Hidden services.`);
  for (const id of after) if (!before.includes(id)) said.push(`${name(id)} is back in the dock, ${position(after, id)}.`);
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : undefined;
  if (focusedId && before.includes(focusedId) && after.includes(focusedId) && before.indexOf(focusedId) !== after.indexOf(focusedId)) {
    said.push(`${name(focusedId)} moved to ${position(after, focusedId)}.`);
  }
  if (said.length) announce(said.join(' '));
}

/** What the tab shows after the name: failed, phone offline, hibernating, a count, a dot, or muted. */
function renderState(node: HTMLSpanElement, service: ServiceSnapshot, phoneOffline: boolean): void {
  const label = unreadLabel(service.unread);
  const kind =
    service.status.kind === 'failed'
      ? 'failed'
      : phoneOffline
        ? 'offline'
        : service.status.kind === 'hibernated'
          ? 'asleep'
          : service.unread.kind === 'count'
            ? 'count'
            : label
              ? 'dot'
              : service.muted
                ? 'muted'
                : '';
  const key = `${kind}:${label}`;
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.dataset.kind = kind;
  if (kind === 'failed') node.replaceChildren(icon(ICON.alert));
  else if (kind === 'offline') node.replaceChildren(icon(ICON.linkOff));
  else if (kind === 'asleep') node.replaceChildren(icon(ICON.moon));
  else if (kind === 'count') node.replaceChildren(element('span', 'count', label));
  else if (kind === 'dot') node.replaceChildren(element('span', 'dot'));
  else if (kind === 'muted') node.replaceChildren(icon(ICON.bellOff));
  else node.replaceChildren();
}

function renderTabs(snapshot: Snapshot): void {
  const phoneOffline = snapshot.phone !== null && !snapshot.phone.connected;
  const ids = snapshot.services.map((service) => service.id).filter((id) => !snapshot.hiddenIds.includes(id));
  for (const service of snapshot.services) {
    const tab = tabs.get(service.id) ?? createTab(service);
    tabs.set(service.id, tab);
    const index = ids.indexOf(service.id);
    const title = index >= 0 && index < 9 ? `${service.name} (${shortcutLabel(index)})` : service.name;
    if (tab.button.title !== title) tab.button.title = title;
    const offline = phoneOffline && service.id === 'inbox';
    tab.button.dataset.status = service.status.kind;
    tab.button.toggleAttribute('data-muted', service.muted);
    renderState(tab.state, service, offline);
    tab.button.setAttribute('aria-label', describe(service, offline));
    if (service.id === snapshot.activeId) tab.button.setAttribute('aria-current', 'page');
    else tab.button.removeAttribute('aria-current');
  }
  // A drag in progress keeps the tabs where they are; its drop puts them right.
  if (drag?.started || ids.join() === shownIds.join()) return;
  const before = shownIds;
  placeTabs(ids);
  announceChanges(before, ids, snapshot.hiddenIds);
}

/** Moves a tab to `to` among the tabs at once, then asks main to keep it there. */
function moveTab(id: string, to: number): void {
  const ids = shownIds.filter((other) => other !== id);
  ids.splice(to, 0, id);
  placeTabs(ids);
  announce(`${tabs.get(id)?.name ?? id} moved to ${position(ids, id)}.`);
  window.kainos.moveService(id, to);
}

// ---------- Dragging a tab along the dock ----------
// Pointer events with capture rather than HTML drag and drop, which is unreliable over the
// service views. A press that moves less than DRAG_THRESHOLD stays a click.

const DRAG_THRESHOLD = 5;

interface Drag {
  readonly id: string;
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  started: boolean;
  /** Its place among the tabs when the drag started, and where it would land now. */
  from: number;
  to: number;
  /** How far it has moved, in pixels, held inside the list. */
  dx: number;
  others: HTMLLIElement[];
  centres: number[];
  /** Its own width plus the gap: how far each tab it passes steps aside. */
  step: number;
  left: number;
  minDx: number;
  maxDx: number;
}
let drag: Drag | undefined;
/** Stays armed through a cancelled pointer's release, which may be much later than Escape. */
let suppressedClick: { pointerId: number } | undefined;

function finishPointer(pointerId: number): void {
  const suppressed = suppressedClick;
  if (suppressed?.pointerId !== pointerId) return;
  // The release's click is dispatched before this timer. If no click follows, let the
  // next deliberate click through instead of keeping stale suppression.
  setTimeout(() => {
    if (suppressedClick === suppressed) suppressedClick = undefined;
  }, 0);
}

function beginDrag(d: Drag): void {
  const items = shownIds.map((id) => tabs.get(id)!.item);
  const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
  d.started = true;
  d.from = d.to = items.indexOf(d.item);
  d.others = items.filter((item) => item !== d.item);
  d.centres = d.others.map((item) => item.offsetLeft + item.offsetWidth / 2);
  d.step = d.item.offsetWidth + gap;
  d.left = d.item.offsetLeft;
  const first = items[0]!;
  const last = items.at(-1)!;
  d.minDx = first.offsetLeft - d.left;
  d.maxDx = last.offsetLeft + last.offsetWidth - (d.left + d.item.offsetWidth);
  list.toggleAttribute('data-scrolls', list.scrollWidth > list.clientWidth + 1);
  slot.style.width = `${d.item.offsetWidth}px`;
  slot.style.transform = `translateX(${d.left}px)`;
  slot.hidden = false;
  d.item.dataset.dragged = '';
  dock.dataset.dragging = '';
  window.kainos.reportDrag(true);
}

function updateDrag(d: Drag, dx: number): void {
  d.dx = Math.min(Math.max(dx, d.minDx), d.maxDx);
  d.item.style.transform = `translateX(${d.dx}px)`;
  d.to = dropIndex(d.centres, d.left + d.item.offsetWidth / 2 + d.dx);
  d.others.forEach((item, k) => {
    const shift = makeRoom(k, d.from, d.to);
    item.style.transform = shift ? `translateX(${shift * d.step}px)` : '';
  });
  const landing =
    d.to === d.from ? d.left : d.to < d.from ? d.others[d.to]!.offsetLeft : d.others[d.to - 1]!.offsetLeft + d.others[d.to - 1]!.offsetWidth - d.item.offsetWidth;
  slot.style.transform = `translateX(${landing}px)`;
}

/** Ends a press or drag; a drop that changed place moves the tab, a cancelled one puts it back. */
function endDrag(drop: boolean): void {
  const d = drag;
  drag = undefined;
  if (!d?.started) return;
  window.kainos.reportDrag(false);
  suppressedClick = { pointerId: d.pointerId };
  const shownAt = d.left + d.dx;
  for (const item of d.others) {
    item.style.transition = 'none';
    item.style.transform = '';
  }
  slot.hidden = true;
  delete d.item.dataset.dragged;
  delete dock.dataset.dragging;
  if (drop && d.to !== d.from) moveTab(d.id, d.to);
  else if (current) renderTabs(current);
  // The dropped tab settles into its place from where the pointer left it.
  d.item.style.transition = 'none';
  d.item.style.transform = `translateX(${shownAt - d.item.offsetLeft}px)`;
  void d.item.offsetWidth;
  d.item.style.transition = '';
  d.item.style.transform = '';
  for (const item of d.others) item.style.transition = '';
}

list.addEventListener('pointerdown', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.tab') : null;
  const id = button?.dataset.id;
  if (!button || !id || event.button !== 0 || !event.isPrimary || drag) return;
  suppressedClick = undefined;
  const item = button.parentElement as HTMLLIElement;
  drag = { id, item, button, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false, from: 0, to: 0, dx: 0, others: [], centres: [], step: 0, left: 0, minDx: 0, maxDx: 0 };
  try {
    button.setPointerCapture(event.pointerId);
  } catch {
    // A pointer released outside this view is cancelled by the next buttonless move.
  }
});
document.addEventListener('pointermove', (event) => {
  if ((event.buttons & 1) === 0) {
    if (drag && event.pointerId === drag.pointerId) endDrag(false);
    finishPointer(event.pointerId);
    return;
  }
  const d = drag;
  if (!d || event.pointerId !== d.pointerId) return;
  const dx = event.clientX - d.startX;
  if (!d.started) {
    if (Math.hypot(dx, event.clientY - d.startY) < DRAG_THRESHOLD) return;
    beginDrag(d);
  }
  updateDrag(d, dx);
});
document.addEventListener('pointerup', (event) => {
  if (drag && event.pointerId === drag.pointerId) endDrag(true);
  finishPointer(event.pointerId);
});
document.addEventListener('pointercancel', (event) => {
  if (drag && event.pointerId === drag.pointerId) endDrag(false);
  finishPointer(event.pointerId);
});
list.addEventListener('lostpointercapture', (event) => {
  if (drag && event.pointerId === drag.pointerId) endDrag(false);
});
addEventListener('blur', () => endDrag(false));
list.addEventListener(
  'click',
  (event) => {
    if (!(event instanceof PointerEvent) || event.pointerId !== suppressedClick?.pointerId) return;
    suppressedClick = undefined;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

function renderPhone(snapshot: Snapshot): void {
  const link = snapshot.phone;
  const key = link ? `${link.name}:${link.connected}` : '';
  phone.hidden = !snapshot.texts;
  if (phone.dataset.key === key) return;
  phone.dataset.key = key;
  phone.toggleAttribute('data-off', link !== null && !link.connected);
  if (!link) {
    phone.removeAttribute('aria-haspopup');
    phone.setAttribute('aria-label', 'No phone. Connect your phone on the Texts page');
    phone.title = 'Connect your phone on the Texts page';
    phone.replaceChildren(icon(ICON.phone), element('b', '', 'No phone'), element('span', '', 'connect one in Texts'));
    return;
  }
  const status = link.connected ? 'connected' : 'not connected';
  phone.setAttribute('aria-haspopup', 'menu');
  phone.title = `${link.name}, ${status}. Phone options`;
  phone.setAttribute('aria-label', `${link.name}, ${status}. Phone options`);
  phone.replaceChildren(icon(ICON.phone), element('b', '', link.name), element('span', 'dot'), element('span', '', status));
}

function renderStage(snapshot: Snapshot): void {
  const service = snapshot.services.find((candidate) => candidate.id === snapshot.activeId);
  const key = service ? `${service.id}:${service.status.kind}:${service.status.kind === 'failed' ? service.status.reason : ''}` : '';
  if (stage.dataset.key === key) return;
  stage.dataset.key = key;
  stage.replaceChildren();
  // The active service is never left hibernating: opening its tab wakes it.
  if (!service || service.status.kind === 'ready' || service.status.kind === 'hibernated') return;

  const notice = element('section', 'notice');
  notice.dataset.state = service.status.kind;
  const body = element('div', '');
  notice.append(serviceTile(service), body);
  if (service.status.kind === 'loading') {
    const where = service.host ? `Connecting to ${service.host}. ` : '';
    body.append(element('h1', '', `Opening ${service.name}`), element('p', '', `${where}The other services stay open while you wait.`), element('div', 'signal'));
  } else {
    const facts = element('dl', 'facts');
    facts.append(element('dt', '', 'Address'), element('dd', '', service.status.host), element('dt', '', 'Error'), element('dd', '', service.status.reason));
    const retry = element('button', 'primary retry', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => window.kainos.retry(service.id));
    const actions = element('div', 'actions');
    actions.append(retry, element('span', '', 'The other services are not affected.'));
    body.append(element('h1', '', `${service.name} didn’t load`), element('p', '', 'Check your internet connection, then retry.'), facts, actions);
  }
  stage.append(notice);
}

/** How main has placed this page. Until it says, the strip across the whole view. */
let frame: DockFrame = { kind: 'cover', raised: true, room: innerWidth };
/** The strip's side padding (styles.css .dock). */
const STRIP_PAD = 10;
let reportedSize = '';

/**
 * Collapses names progressively until the group of islands fits the window; past that the tab
 * list scrolls. The group is measured at its natural width, not the view's, because a floating
 * dock's view is only as wide as the group it reports here.
 */
function fitNames(): void {
  const room = frame.room - 2 * (frame.kind === 'float' ? DOCK_FLOAT.margin : STRIP_PAD);
  group.style.maxWidth = 'none';
  delete dock.dataset.compact;
  delete dock.dataset.icons;
  // Allow fractional layout rounding.
  const fits = () => group.getBoundingClientRect().width <= room + 0.5;
  if (!fits()) dock.dataset.compact = '';
  if (!fits()) dock.dataset.icons = '';
  group.style.maxWidth = `${Math.max(0, room)}px`;
  const box = group.getBoundingClientRect();
  const size: DockSize = { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  const key = `${size.width}x${size.height}`;
  if (key === reportedSize || size.width === 0) return;
  reportedSize = key;
  window.kainos.reportSize(size);
}

function render(snapshot: Snapshot): void {
  current = snapshot;
  renderTabs(snapshot);
  renderPhone(snapshot);
  renderStage(snapshot);
  fitNames();
}

// The dock options menu: from the mark, or a right-click on the dock's empty space. A keyboard
// press opens it at the mark, as the service menus do.
const options = document.getElementById('dock-options') as HTMLButtonElement;
options.addEventListener('click', (event) => window.kainos.openBarMenu(event.detail === 0 ? anchor(options) : undefined));
dock.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.kainos.openBarMenu();
});
phone.addEventListener('click', (event) => window.kainos.openPhoneMenu(event.detail === 0 ? anchor(phone) : undefined));
onMenu(phone, (at) => window.kainos.openPhoneMenu(at));

// Keep keyboard navigation visible when the compact tab list needs to scroll.
list.addEventListener('focusin', (event) => {
  if (event.target instanceof HTMLButtonElement) {
    event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
});

// Left and right arrows move between the services in the dock; with Alt they move the focused
// service along it.
list.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  const buttons = tabButtons();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || drag?.started) return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 1 : -1;
  if (event.altKey) {
    const id = buttons[index]!.dataset.id!;
    const to = index + step;
    if (to < 0 || to >= buttons.length) announce(`${tabs.get(id)?.name ?? id} is already the ${to < 0 ? 'first' : 'last'} tab.`);
    else moveTab(id, to);
    return;
  }
  const next = (index + step + buttons.length) % buttons.length;
  buttons[next]?.focus();
});

// The auto-hiding dock stays up while the pointer is on this page or keyboard focus is in it.
// A click's focus does not hold it: once the pointer leaves, the dock goes.
let pointerOver = false;
const setPointer = (over: boolean) => {
  if (over === pointerOver) return;
  pointerOver = over;
  window.kainos.reportPointer(over);
};
document.addEventListener('mousemove', () => setPointer(true), { passive: true });
document.addEventListener('mouseover', () => setPointer(true), { passive: true });
document.addEventListener('mouseout', (event) => {
  if (event.relatedTarget === null) setPointer(false);
});

let keyboardUse = false;
let keyboardReported = false;
function reportKeyboard(force = false): void {
  const now = keyboardUse && document.hasFocus() && dock.contains(document.activeElement);
  if (now === keyboardReported && !force) return;
  keyboardReported = now;
  window.kainos.reportKeyboard(now);
}
addEventListener(
  'keydown',
  (event) => {
    keyboardUse = true;
    reportKeyboard();
    // Escape during a drag puts the tab back. Otherwise it leaves the dock for the page (and
    // an auto-hiding dock goes away), and main forgets the keyboard focus with it.
    if (event.key === 'Escape' && drag?.started) {
      event.preventDefault();
      endDrag(false);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      keyboardUse = false;
      keyboardReported = false;
      window.kainos.dismiss();
    }
  },
  true,
);
addEventListener(
  'pointerdown',
  () => {
    keyboardUse = false;
    reportKeyboard();
  },
  true,
);
document.addEventListener('focusin', () => reportKeyboard());
// The next focused element is only known after focusout has finished.
document.addEventListener('focusout', () => setTimeout(reportKeyboard, 0));
addEventListener('blur', () => reportKeyboard());

// F6 from inside a service page lands here, on the active service's tab.
window.kainos.onFocusDock(() => {
  keyboardUse = true;
  const active = current && tabs.get(current.activeId)?.button;
  (active?.isConnected ? active : tabButtons()[0])?.focus();
  // Main showed the dock for this; say whether focus really arrived.
  reportKeyboard(true);
});

window.kainos.onFrame((next) => {
  // A dock that moves, appears or goes away may do so under a still pointer, with no mouseout
  // to follow; start over without it, and the next move over the dock reports it again.
  if (next.kind !== frame.kind || next.raised !== frame.raised) setPointer(false);
  frame = next;
  document.body.dataset.frame = next.kind;
  document.body.toggleAttribute('data-raised', next.raised);
  fitNames();
});
document.documentElement.style.setProperty('--float-margin', `${DOCK_FLOAT.margin}px`);
document.documentElement.style.setProperty('--float-bottom', `${DOCK_FLOAT.bottom}px`);

addEventListener('resize', fitNames);
void document.fonts.ready.then(fitNames);
window.kainos.onSnapshot(render);
void window.kainos.getSnapshot().then(render);
