// Preload for the inbox page: exposes window.kainosSms and nothing else, and reports the
// pointer at the bottom edge for the auto-hiding dock.
import { contextBridge, ipcRenderer } from 'electron';
import { SmsChannel, type SmsApi, type SmsState } from '../shared/sms.ts';
import { reportBottomEdge } from './bottom-edge.ts';
import { followTheme } from './theme.ts';

const api: SmsApi = {
  getState: () => ipcRenderer.invoke(SmsChannel.getState),
  onState: (listener) => ipcRenderer.on(SmsChannel.state, (_event, state: SmsState) => listener(state)),
  reply: (key, text) => ipcRenderer.send(SmsChannel.reply, key, text),
  markRead: (key) => ipcRenderer.send(SmsChannel.markRead, key),
  answerPairing: (accept) => ipcRenderer.send(SmsChannel.answerPairing, accept === true),
  forgetPhone: () => ipcRenderer.send(SmsChannel.forgetPhone),
  send: (to, text) => ipcRenderer.send(SmsChannel.send, to, text),
  copyCode: (code) => ipcRenderer.send(SmsChannel.copyCode, code),
  onOpenKey: (listener) => ipcRenderer.on(SmsChannel.openKey, (_event, key: string) => listener(key)),
  onShown: (listener) => ipcRenderer.on(SmsChannel.shown, (_event, shown: boolean) => listener(shown === true)),
};

contextBridge.exposeInMainWorld('kainosSms', api);
reportBottomEdge();
followTheme();
