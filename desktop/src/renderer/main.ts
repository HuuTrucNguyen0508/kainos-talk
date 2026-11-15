import type { KainosApi, ServiceSnapshot, Snapshot } from '../shared/ipc.ts';
import { unreadLabel } from '../shared/unread.ts';
import { describe } from './describe.ts';
import './styles.css';

declare global {
  interface Window {
    readonly kainos: KainosApi;
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const BELL_OFF = 'M4.6 11V7.6a3.4 3.4 0 0 1 6.8 0V11l1.1 1.5h-9z M6.8 14.3h2.4 M2.5 2.5l11 11';
const ALERT = 'M8 4.2v4.6 M8 11.6v.1';

function icon(path: string, viewBox: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function serviceTile(service: ServiceSnapshot, tag: 'button' | 'div'): HTMLElement {
  const tile = element(tag, 'tile');
  tile.style.setProperty('--brand', service.color);
  tile.append(icon(service.glyph, '0 0 24 24'));
  return tile;
}

interface Socket {
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly badge: HTMLSpanElement;
}

const sockets = new Map<string, Socket>();
const list = document.getElementById('sockets') as HTMLUListElement;
const stage = document.getElementById('stage') as HTMLElement;
let current: Snapshot | undefined;

function shortcutLabel(index: number): string {
  return navigator.platform.startsWith('Mac') ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

function createSocket(service: ServiceSnapshot, index: number): Socket {
  const item = element('li', 'socket');
  const button = serviceTile(service, 'button') as HTMLButtonElement;
  button.type = 'button';
  button.title = `${service.name} (${shortcutLabel(index)})`;
  button.addEventListener('click', () => window.kainos.activate(service.id));
  // A right-click opens the menu at the pointer. The Menu key or Shift+F10 fires contextmenu with
  // no pointer press before it, so that menu opens beside the button instead.
  let pointerMenu = false;
  button.addEventListener('pointerdown', (event) => {
    pointerMenu = event.button === 2;
  });
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const box = button.getBoundingClientRect();
    if (pointerMenu) window.kainos.openServiceMenu(service.id);
    else window.kainos.openServiceMenu(service.id, { x: box.right, y: box.top });
    pointerMenu = false;
  });
  const badge = element('span', 'badge');
  badge.setAttribute('aria-hidden', 'true');
  const muted = element('span', 'flag flag-muted');
  muted.append(icon(BELL_OFF, '0 0 16 16'));
  const failed = element('span', 'flag flag-failed');
  failed.append(icon(ALERT, '0 0 16 16'));
  button.append(badge, muted, failed);
  item.append(element('span', 'socket-tab'), button);
  list.append(item);
  return { item, button, badge };
}

function toggle(node: HTMLElement, attribute: string, on: boolean): void {
  node.toggleAttribute(attribute, on);
}

function renderSockets(snapshot: Snapshot): void {
  snapshot.services.forEach((service, index) => {
    const socket = sockets.get(service.id) ?? createSocket(service, index);
    sockets.set(service.id, socket);
    const active = service.id === snapshot.activeId;
    socket.item.dataset.status = service.status.kind;
    toggle(socket.item, 'data-active', active);
    toggle(socket.item, 'data-muted', service.muted);
    socket.badge.textContent = unreadLabel(service.unread);
    toggle(socket.badge, 'data-marker', service.unread.kind === 'marker');
    socket.button.setAttribute('aria-label', describe(service));
    if (active) socket.button.setAttribute('aria-current', 'page');
    else socket.button.removeAttribute('aria-current');
  });
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
  notice.append(serviceTile(service, 'div'));
  if (service.status.kind === 'loading' || service.status.kind === 'asleep') {
    notice.append(element('h1', '', `Opening ${service.name}`), element('div', 'signal'));
  } else {
    const retry = element('button', 'retry', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => window.kainos.retry(service.id));
    notice.append(
      element('h1', '', `${service.name} didn't load`),
      element('p', '', `Kainos Talk couldn't reach ${service.status.host} (${service.status.reason}).`),
      element('p', '', 'Check your internet connection, then retry.'),
      retry,
    );
  }
  stage.append(notice);
}

function render(snapshot: Snapshot): void {
  current = snapshot;
  document.body.dataset.side = snapshot.bar.side;
  toggle(document.body, 'data-auto-hide', snapshot.bar.autoHide);
  renderSockets(snapshot);
  renderStage(snapshot);
}

// The bar options menu: from the mark, or a right-click on the bar's empty space. A keyboard
// press opens it beside the mark, as the service menus do.
const rail = document.querySelector('.rail') as HTMLElement;
const barOptions = document.getElementById('bar-options') as HTMLButtonElement;
barOptions.addEventListener('click', (event) => {
  const box = barOptions.getBoundingClientRect();
  if (event.detail === 0) window.kainos.openBarMenu({ x: box.right, y: box.bottom });
  else window.kainos.openBarMenu();
});
rail.addEventListener('contextmenu', (event) => {
  if (event.target instanceof Element && event.target.closest('.socket')) return;
  event.preventDefault();
  window.kainos.openBarMenu();
});

// An auto-hidden bar stays out while the pointer is on it.
rail.addEventListener('pointerenter', () => window.kainos.railPointer(true));
rail.addEventListener('pointerleave', () => window.kainos.railPointer(false));

// Up and down arrows move between services in the rail.
list.addEventListener('keydown', (event) => {
  if (!current || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
  const buttons = [...sockets.values()].map((socket) => socket.button);
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
});

// F6 from inside a service page lands here, on the active service's button.
window.kainos.onFocusRail(() => {
  if (current) sockets.get(current.activeId)?.button.focus();
});

window.kainos.onSnapshot(render);
void window.kainos.getSnapshot().then(render);
