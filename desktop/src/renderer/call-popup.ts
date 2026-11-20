import type { CallPopupApi, CallPopupState } from '../shared/sms.ts';
import './call-popup.css';

declare global {
  interface Window {
    readonly kainosRinging: CallPopupApi;
  }
}

const api = window.kainosRinging;
const who = document.getElementById('who')!;
const detail = document.getElementById('detail')!;
const problem = document.getElementById('problem')!;
const answer = document.getElementById('answer') as HTMLButtonElement;
const decline = document.getElementById('decline') as HTMLButtonElement;

const SVG = 'http://www.w3.org/2000/svg';
/** The handset, upright for Answer and turned down for Decline (the Texts page draws the same). */
function handset(down: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    down
      ? 'M3.2 14.2c4.9-4.3 12.7-4.3 17.6 0l-1.9 3-3.5-1.3v-2.5a10.5 10.5 0 0 0-6.8 0v2.5l-3.5 1.3z'
      : 'M6.6 3.5h2.6l1.5 4-2 1.3a11 11 0 0 0 6.5 6.5l1.3-2 4 1.5v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z',
  );
  svg.append(path);
  return svg;
}
answer.prepend(handset(false));
decline.prepend(handset(true));
answer.addEventListener('click', () => api.answer());
decline.addEventListener('click', () => api.decline());

function render(state: CallPopupState): void {
  const { call } = state;
  who.textContent = call.name ?? call.number ?? 'Unknown number';
  detail.textContent = call.name && call.number ? `${call.number} is calling your phone` : 'Calling your phone';
  answer.disabled = state.pending;
  decline.disabled = state.pending;
  problem.textContent = state.failure ? `Your phone didn’t do that: ${state.failure}.` : '';
}

api.onState(render);
void api.getState().then((state) => state && render(state));
