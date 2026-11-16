import type { AppChoice, AppsApi, AppsChoices } from '../shared/apps.ts';
import './apps.css';

declare global {
  interface Window {
    readonly kainosApps: AppsApi;
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const form = document.querySelector<HTMLFormElement>('#apps')!;
const list = document.querySelector<HTMLUListElement>('#list')!;
const dock = document.querySelector<HTMLSpanElement>('#dock')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;

function tile(service: AppChoice): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = 'tile';
  node.style.setProperty('--brand', service.icon.color);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `glyph-${service.icon.paint}`);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', service.icon.glyph);
  svg.append(path);
  node.append(svg);
  return node;
}

let choices: AppsChoices = { firstRun: true, services: [] };
const chosen = () => choices.services.filter((service) => list.querySelector<HTMLInputElement>(`input[value="${service.id}"]`)?.checked);

/** The dock preview, the status line and the button follow the switches. */
function update(): void {
  const on = chosen();
  const shown = new Set([...dock.children].map((node) => (node as HTMLElement).dataset.id));
  const wanted = new Set(on.map((service) => service.id));
  for (const node of [...dock.children]) if (!wanted.has((node as HTMLElement).dataset.id ?? '')) node.remove();
  // Tiles keep the list's order, so the preview is the dock's order.
  for (const service of on) {
    if (shown.has(service.id)) continue;
    const node = tile(service);
    node.dataset.id = service.id;
    const after = on.slice(0, on.indexOf(service)).reverse().map((other) => dock.querySelector(`[data-id="${other.id}"]`)).find(Boolean);
    if (after) after.after(node);
    else dock.prepend(node);
  }
  for (const row of list.querySelectorAll('.app')) row.toggleAttribute('data-off', !row.querySelector('input')!.checked);
  save.disabled = on.length === 0;
  status.textContent = on.length === 0 ? 'Pick at least one app.' : on.length === 1 ? '1 app on.' : `${on.length} apps on.`;
  if (choices.firstRun) save.textContent = on.length === 0 ? 'Start' : on.length === 1 ? 'Start with 1 app' : `Start with ${on.length} apps`;
}

function render(): void {
  if (!choices.firstRun) {
    document.title = 'Your apps';
    document.querySelector('#title')!.textContent = 'Your apps';
    document.querySelector('#lead')!.textContent = 'Switch apps on or off. One you switch off closes and stops notifying; its login stays, so switching it back on finds you signed in.';
  }
  cancel.hidden = choices.firstRun;
  list.replaceChildren(
    ...choices.services.map((service) => {
      const row = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'app';
      const text = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = service.name;
      const about = document.createElement('span');
      about.className = 'about';
      about.textContent = service.about;
      about.id = `about-${service.id}`;
      text.append(name, document.createElement('br'), about);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'switch';
      input.setAttribute('role', 'switch');
      input.value = service.id;
      input.checked = service.on;
      input.setAttribute('aria-describedby', about.id);
      label.append(tile(service), text, input);
      row.append(label);
      return row;
    }),
  );
  update();
}

list.addEventListener('change', update);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const ids = chosen().map((service) => service.id);
  if (ids.length > 0) window.kainosApps.save(ids);
});
cancel.addEventListener('click', () => window.kainosApps.cancel());
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !choices.firstRun) window.kainosApps.cancel();
});
void window.kainosApps.get().then((loaded) => {
  choices = loaded;
  render();
  list.querySelector('input')?.focus();
});
