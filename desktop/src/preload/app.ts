// Preload for the dock page: exposes window.kainos and nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channel, type DockFrame, type KainosApi, type Snapshot } from '../shared/ipc.ts';
import { followTheme } from './theme.ts';

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
  onFocusDock: (listener) => ipcRenderer.on(Channel.focusDock, () => listener()),
  openBarMenu: (at) => ipcRenderer.send(Channel.openBarMenu, at),
  openPhoneMenu: (at) => ipcRenderer.send(Channel.openPhoneMenu, at),
  onFrame: (listener) => ipcRenderer.on(Channel.dockFrame, (_event, frame: DockFrame) => listener(frame)),
  reportSize: (size) => ipcRenderer.send(Channel.dockSize, size),
  reportPointer: (over) => ipcRenderer.send(Channel.dockPointer, over === true),
  reportKeyboard: (focused) => ipcRenderer.send(Channel.dockKeyboard, focused === true),
  dismiss: () => ipcRenderer.send(Channel.dismissDock),
};

contextBridge.exposeInMainWorld('kainos', api);
followTheme();
