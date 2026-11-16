// Preload for the Choose your apps page: exposes window.kainosApps and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import { AppsChannel, type AppsApi } from '../shared/apps.ts';
import { followTheme } from './theme.ts';

const api: AppsApi = {
  get: () => ipcRenderer.invoke(AppsChannel.get),
  save: (ids) => ipcRenderer.send(AppsChannel.save, [...ids]),
  cancel: () => ipcRenderer.send(AppsChannel.cancel),
};

contextBridge.exposeInMainWorld('kainosApps', api);
followTheme();
