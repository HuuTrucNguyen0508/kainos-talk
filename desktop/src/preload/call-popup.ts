// Preload for the incoming-call window: exposes window.kainosRinging and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import { CallPopupChannel, type CallPopupApi, type CallPopupState } from '../shared/sms.ts';
import { followTheme } from './theme.ts';

const api: CallPopupApi = {
  getState: () => ipcRenderer.invoke(CallPopupChannel.getState),
  onState: (listener) => ipcRenderer.on(CallPopupChannel.state, (_event, state: CallPopupState) => listener(state)),
  answer: () => ipcRenderer.send(CallPopupChannel.answer),
  decline: () => ipcRenderer.send(CallPopupChannel.decline),
};

contextBridge.exposeInMainWorld('kainosRinging', api);
followTheme();
