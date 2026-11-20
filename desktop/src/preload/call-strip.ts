// Preload for the strip over a tab with a call on: exposes window.kainosCall and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import { Channel } from '../shared/ipc.ts';
import { followTheme } from './theme.ts';

/** What the tab shows under the strip. */
export type CallShowing = 'call' | 'chats';

export interface CallStripApi {
  /** Switches the tab between the call and the chats. */
  toggle(): void;
  onShowing(listener: (showing: CallShowing) => void): void;
}

const api: CallStripApi = {
  toggle: () => ipcRenderer.send(Channel.callToggle),
  onShowing: (listener) => ipcRenderer.on(Channel.callShowing, (_event, raw: unknown) => listener(raw === 'chats' ? 'chats' : 'call')),
};

contextBridge.exposeInMainWorld('kainosCall', api);
followTheme();
