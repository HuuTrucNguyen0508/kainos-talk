import { ipcRenderer } from 'electron';
import { Channel } from '../shared/ipc.ts';

/** Within this many pixels of a side, the pointer counts as at the edge. */
const EDGE = 2;
/**
 * Leaving the window this close to a side counts as leaving across it. Compositors with gaps
 * (Hyprland) put a few pixels between the window and the screen edge, so the last position
 * inside the window can be well short of the edge.
 */
const LEAVE_EDGE = 48;

/**
 * Tells the app when the pointer reaches a page's left or right edge, or leaves the window
 * across one, so an auto-hidden bar on that side can come out. Every page in a service view
 * runs it, Kainos' own SMS page included. Only changes are sent.
 */
export function reportPointerEdges(): void {
  let lastEdge = '';
  const report = (event: MouseEvent, leaving: boolean) => {
    const width = window.innerWidth;
    const x = event.clientX;
    const near = leaving ? LEAVE_EDGE : EDGE;
    const edge = x < near ? 'left' : x >= width - near ? 'right' : 'inside';
    if (edge === lastEdge) return;
    lastEdge = edge;
    ipcRenderer.send(Channel.pointerEdge, edge);
  };
  window.addEventListener('mousemove', (event) => report(event, false), { capture: true, passive: true });
  document.addEventListener(
    'mouseout',
    (event) => {
      if (event.relatedTarget === null) report(event, true);
    },
    { capture: true, passive: true },
  );
}
