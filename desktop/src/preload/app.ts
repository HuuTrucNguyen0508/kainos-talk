// Preload for the sidebar page: exposes window.kainos and nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channel, type KainosApi, type Snapshot } from '../shared/ipc.ts';

const api: KainosApi = {
  getSnapshot: () => ipcRenderer.invoke(Channel.getSnapshot),
  onSnapshot(listener) {
    const handler = (_event: IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on(Channel.snapshot, handler);
    return () => ipcRenderer.off(Channel.snapshot, handler);
  },
  activate: (serviceId) => ipcRenderer.send(Channel.activate, serviceId),
  retry: (serviceId) => ipcRenderer.send(Channel.retry, serviceId),
  openServiceMenu: (serviceId, at) => ipcRenderer.send(Channel.openServiceMenu, serviceId, at),
  onFocusRail: (listener) => ipcRenderer.on(Channel.focusRail, () => listener()),
  railPointer: (over) => ipcRenderer.send(Channel.railPointer, over === true),
  openBarMenu: (at) => ipcRenderer.send(Channel.openBarMenu, at),
};

contextBridge.exposeInMainWorld('kainos', api);
