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
  readonly button: HTMLButtonElement;
  readonly state: HTMLSpanElement;
}

const tabs = new Map<string, Tab>();
const list = document.getElementById('tabs') as HTMLUListElement;
const dock = document.getElementById('dock') as HTMLElement;
const group = document.getElementById('group') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const phone = document.getElementById('phone') as HTMLButtonElement;
let current: Snapshot | undefined;

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

function createTab(service: ServiceSnapshot, index: number): Tab {
  const item = element('li', '');
  const button = element('button', 'tab');
  button.type = 'button';
  button.dataset.id = service.id;
  button.title = `${service.name} (${shortcutLabel(index)})`;
  button.addEventListener('click', () => window.kainos.activate(service.id));
  onMenu(button, (at) => window.kainos.openServiceMenu(service.id, at));
  const state = element('span', 'state');
  state.setAttribute('aria-hidden', 'true');
  button.append(serviceTile(service), element('span', 'name', service.name), state);
  item.append(button);
  list.append(item);
  return { button, state };
}

/** What the tab shows after the name: failed, phone offline, a count, a dot, or muted. */
function renderState(node: HTMLSpanElement, service: ServiceSnapshot, phoneOffline: boolean): void {
  const label = unreadLabel(service.unread);
  const kind =
    service.status.kind === 'failed' ? 'failed' : phoneOffline ? 'offline' : service.unread.kind === 'count' ? 'count' : label ? 'dot' : service.muted ? 'muted' : '';
  const key = `${kind}:${label}`;
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.dataset.kind = kind;
  if (kind === 'failed') node.replaceChildren(icon(ICON.alert));
  else if (kind === 'offline') node.replaceChildren(icon(ICON.linkOff));
  else if (kind === 'count') node.replaceChildren(element('span', 'count', label));
  else if (kind === 'dot') node.replaceChildren(element('span', 'dot'));
  else if (kind === 'muted') node.replaceChildren(icon(ICON.bellOff));
  else node.replaceChildren();
}

function renderTabs(snapshot: Snapshot): void {
  const phoneOffline = snapshot.phone !== null && !snapshot.phone.connected;
  snapshot.services.forEach((service, index) => {
    const tab = tabs.get(service.id) ?? createTab(service, index);
    tabs.set(service.id, tab);
    const offline = phoneOffline && service.id === 'inbox';
    tab.button.dataset.status = service.status.kind;
    tab.button.toggleAttribute('data-muted', service.muted);
    renderState(tab.state, service, offline);
    tab.button.setAttribute('aria-label', describe(service, offline));
    if (service.id === snapshot.activeId) tab.button.setAttribute('aria-current', 'page');
    else tab.button.removeAttribute('aria-current');
  });
}

function renderPhone(snapshot: Snapshot): void {
  const link = snapshot.phone;
  const key = link ? `${link.name}:${link.connected}` : '';
  phone.hidden = false;
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
  if (!service || service.status.kind === 'ready') return;

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

// Left and right arrows move between the services in the dock.
list.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  const buttons = [...tabs.values()].map((tab) => tab.button);
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
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
    // Escape leaves the dock for the page (and an auto-hiding dock goes away). Main forgets
    // the keyboard focus with it.
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
  if (current) tabs.get(current.activeId)?.button.focus();
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
