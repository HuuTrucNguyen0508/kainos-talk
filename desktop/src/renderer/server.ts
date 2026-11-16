import type { ServerApi } from '../preload/server.ts';
import { readPortInput, readServerInput, type ServerReading } from '../shared/streamroom.ts';
import './server.css';

declare global {
  interface Window {
    readonly kainosServer: ServerApi;
  }
}

const form = document.querySelector<HTMLFormElement>('#add')!;
const input = document.querySelector<HTMLInputElement>('#address')!;
const reading = document.querySelector<HTMLParagraphElement>('#reading')!;
const submit = document.querySelector<HTMLButtonElement>('#submit')!;

// Port mode changes the port of Streamroom on this PC; main says which in the query.
const query = new URLSearchParams(location.search);
const portMode = query.get('mode') === 'port';
const readInput = (text: string): ServerReading => (portMode ? readPortInput(text) : readServerInput(text));
if (portMode) {
  const title = "Change this PC's port";
  document.title = title;
  document.querySelector('#title')!.textContent = title;
  document.querySelector('#lead')!.textContent = 'The port your Streamroom on this PC listens on.';
  document.querySelector('#label')!.textContent = 'Port';
  input.inputMode = 'numeric';
  input.placeholder = '8080';
  input.value = query.get('port') ?? '';
  input.select();
  submit.textContent = 'Use this port';
}

/** Set once Add has been pressed: from then on a problem shows while typing too. */
let tried = false;

/** Shows what will open, or a problem; a problem from typing waits until Add is pressed. */
function show(problem?: string): void {
  const read = readInput(input.value);
  const text = problem ?? (read && 'problem' in read && tried ? read.problem : undefined);
  reading.replaceChildren();
  reading.toggleAttribute('data-problem', text !== undefined);
  form.toggleAttribute('data-problem', text !== undefined);
  input.setAttribute('aria-invalid', String(text !== undefined));
  if (text !== undefined) reading.textContent = text;
  else if (read && 'origin' in read) {
    const origin = document.createElement('b');
    origin.textContent = read.origin;
    reading.append('Opens ', origin);
  }
  submit.disabled = read === undefined;
}

input.addEventListener('input', () => show());
form.addEventListener('submit', (event) => {
  event.preventDefault();
  tried = true;
  const read = readInput(input.value);
  if (!read || 'problem' in read) {
    show();
    input.focus();
    return;
  }
  submit.disabled = true;
  void window.kainosServer.add(input.value).then((problem) => {
    if (problem) show(problem);
  });
});
document.querySelector('#cancel')!.addEventListener('click', () => window.kainosServer.cancel());
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.kainosServer.cancel();
});
show();
