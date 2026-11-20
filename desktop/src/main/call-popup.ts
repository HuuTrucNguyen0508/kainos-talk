import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { join } from 'node:path';
import { CallPopupChannel, type CallPopupState } from '../shared/sms.ts';

export interface CallPopupOptions {
  /** Folder of the built pages and preloads (dist/). */
  readonly localDir: string;
  readonly background: () => string;
  readonly answer: () => void;
  readonly decline: () => void;
  /** The window's page, so main can theme it while it is open. */
  readonly onOpen: (contents: WebContents) => void;
  readonly onClose: () => void;
}

export interface CallPopup {
  /** Shows the ringing call, or closes the window when nothing rings. */
  show(state: CallPopupState | undefined): void;
}

const callerOf = (state: CallPopupState) => state.call.name ?? state.call.number ?? 'Unknown number';

/**
 * The incoming-call window: a small window in the middle of the screen while the phone rings,
 * over whatever is open, with Answer and Decline. It closes once the call stops ringing. Closed
 * by hand, it stays closed for that call; the Texts page still has the call.
 */
export function createCallPopup(options: CallPopupOptions): CallPopup {
  let popup: BrowserWindow | undefined;
  let current: CallPopupState | undefined;
  /** The call whose window the user closed. */
  let dismissed: string | undefined;

  const fromPopup = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => popup !== undefined && !popup.isDestroyed() && event.sender === popup.webContents;
  ipcMain.handle(CallPopupChannel.getState, (event) => (fromPopup(event) ? current : undefined));
  ipcMain.on(CallPopupChannel.answer, (event) => {
    if (fromPopup(event)) options.answer();
  });
  ipcMain.on(CallPopupChannel.decline, (event) => {
    if (fromPopup(event)) options.decline();
  });

  function open(): BrowserWindow {
    const created = new BrowserWindow({
      width: 400,
      height: 260,
      center: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      title: 'Incoming call',
      backgroundColor: options.background(),
      show: false,
      webPreferences: {
        preload: join(options.localDir, 'preload-call-popup.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    created.setMenu(null);
    const contents = created.webContents;
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Shown without taking the keyboard: a key pressed in another app must not answer the call.
    created.once('ready-to-show', () => created.showInactive());
    created.on('close', () => {
      if (current) dismissed = current.call.id;
    });
    created.once('closed', () => {
      if (popup === created) popup = undefined;
      options.onClose();
    });
    void created.loadFile(join(options.localDir, 'renderer', 'call-popup.html'));
    options.onOpen(contents);
    return created;
  }

  return {
    show(state) {
      if (state && state.call.id === dismissed) return;
      if (!state) {
        current = undefined;
        dismissed = undefined;
        if (popup && !popup.isDestroyed()) popup.destroy();
        return;
      }
      current = state;
      popup ??= open();
      popup.setTitle(`${callerOf(state)} is calling`);
      popup.webContents.send(CallPopupChannel.state, state);
    },
  };
}
