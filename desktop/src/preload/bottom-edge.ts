import { ipcRenderer } from 'electron';
import { exitZone, pointerZone, type PagePointer } from '../shared/dock-edge.ts';
import { Channel } from '../shared/ipc.ts';

/**
 * Tells the app where the pointer is against the page's bottom edge, and when it leaves the
 * window through that edge, so the auto-hiding dock can come up. Every service page and the
 * Texts page run it; main listens to the active one. Only changes are sent.
 */
export function reportBottomEdge(): void {
  let last: PagePointer | undefined;
  const send = (zone: PagePointer) => {
    if (zone === last) return;
    last = zone;
    ipcRenderer.send(Channel.pagePointer, zone);
  };
  ipcRenderer.on(Channel.resetPagePointer, () => { last = undefined; });
  window.addEventListener('mousemove', (event) => {
    if (event.isTrusted === false) return;
    send(pointerZone(event.clientY, window.innerHeight));
  }, { capture: true, passive: true });
  document.addEventListener(
    'mouseout',
    (event) => {
      if (event.isTrusted === false) return;
      if (event.relatedTarget === null) send(exitZone(event.clientX, event.clientY, window.innerWidth, window.innerHeight));
    },
    { capture: true, passive: true },
  );
}
