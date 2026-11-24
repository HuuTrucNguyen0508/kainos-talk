import type { NativeApi, NativeAppView } from '../shared/native-app.ts';
import type { ServiceIcon } from '../shared/services.ts';
import './native.css';

declare global {
  interface Window {
    readonly kainosNative: NativeApi;
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const root = document.getElementById('app') as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tile(icon: ServiceIcon): HTMLElement {
  const node = el('span', 'tile');
  node.style.setProperty('--brand', icon.color);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `glyph-${icon.paint}`);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', icon.glyph);
  svg.append(path);
  node.append(svg);
  return node;
}

/** What the page says in each state: a heading, a line, and the button, if any. */
function words(view: NativeAppView): { title: string; line: string; button?: string } {
  const { name } = view;
  switch (view.state.kind) {
    case 'starting':
      return { title: `Opening ${name}`, line: `Its window takes this place once it is up.` };
    case 'placed':
      return { title: name, line: `Its window sits here. If you can’t see it, bring it back.`, button: `Bring ${name} here` };
    case 'closed':
      return { title: `${name} is closed`, line: `Open it and its window fits into this tab, above the dock.`, button: `Open ${name}` };
    case 'missing':
      return { title: `${name} isn’t installed`, line: `Install ${name} from your system’s software manager, then open it here.`, button: `Open ${name}` };
    case 'separate':
      return { title: `${name} opens in its own window`, line: `Only on Hyprland can Kainos fit another app’s window into a tab.`, button: `Open ${name}` };
  }
}

let shownKey = '';
function render(view: NativeAppView | undefined): void {
  if (!view) return;
  const key = `${view.name}:${view.state.kind}`;
  if (key === shownKey) return;
  shownKey = key;
  document.title = view.name;
  root.dataset.state = view.state.kind;
  const { title, line, button } = words(view);
  const body = el('div');
  body.append(el('h1', '', title), el('p', '', line));
  if (button) {
    const open = el('button', 'primary', button);
    open.type = 'button';
    open.addEventListener('click', () => window.kainosNative.open());
    body.append(open);
  }
  const notice = el('section', 'notice');
  notice.append(tile(view.icon), body);
  root.replaceChildren(notice);
}

window.kainosNative.onView(render);
void window.kainosNative.getView().then(render);
