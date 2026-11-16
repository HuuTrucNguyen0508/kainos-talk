// Preload for the Add a Streamroom address window: exposes window.kainosServer and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import { Channel } from '../shared/ipc.ts';
import { followTheme } from './theme.ts';

export interface ServerApi {
  /** Adds the address and opens it; resolves to the problem when main refuses it. */
  add(address: string): Promise<string | undefined>;
  cancel(): void;
}

const api: ServerApi = {
  add: (address) => ipcRenderer.invoke(Channel.serverAdd, address),
  cancel: () => ipcRenderer.send(Channel.serverCancel),
};

contextBridge.exposeInMainWorld('kainosServer', api);
followTheme();
