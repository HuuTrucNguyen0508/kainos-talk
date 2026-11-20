import type { CallStripApi, CallShowing } from '../preload/call-strip.ts';
import './call-strip.css';

declare global {
  interface Window {
    readonly kainosCall: CallStripApi;
  }
}

const strip = document.querySelector<HTMLButtonElement>('#strip')!;
const action = document.querySelector<HTMLSpanElement>('#action')!;

const show = (showing: CallShowing) => {
  strip.dataset['showing'] = showing;
  action.textContent = showing === 'call' ? 'Back to chats' : 'Back to call';
};
strip.addEventListener('click', () => window.kainosCall.toggle());
window.kainosCall.onShowing(show);
