// Preload for the page behind a desktop app's window (Thunderbird): exposes window.kainosNative
// and nothing else, and reports the pointer at the bottom edge for the auto-hiding dock.
import { contextBridge, ipcRenderer } from 'electron';
import { NativeChannel, type NativeApi, type NativeAppView } from '../shared/native-app.ts';
import { reportBottomEdge } from './bottom-edge.ts';
import { followTheme } from './theme.ts';

const api: NativeApi = {
  getView: () => ipcRenderer.invoke(NativeChannel.getView),
  onView: (listener) => ipcRenderer.on(NativeChannel.view, (_event, view: NativeAppView) => listener(view)),
  open: () => ipcRenderer.send(NativeChannel.open),
};

contextBridge.exposeInMainWorld('kainosNative', api);
reportBottomEdge();
followTheme();
