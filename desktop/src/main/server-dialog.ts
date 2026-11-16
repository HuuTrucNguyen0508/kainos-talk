import { BrowserWindow, ipcMain, type BaseWindow, type WebContents } from 'electron';
import { join } from 'node:path';
import { Channel } from '../shared/ipc.ts';
import { parsePort, readPortInput, readServerInput } from '../shared/streamroom.ts';

/** Add an address, or change the port of Streamroom on this PC. */
export type ServerDialogMode =
  | { readonly kind: 'address'; readonly onChoose: (origin: string) => void }
  | { readonly kind: 'port'; readonly port: number; readonly onChoose: (port: number) => void };

export interface ServerDialogOptions {
  readonly mode: ServerDialogMode;
  readonly parent: BaseWindow;
  /** Folder of the built pages and preloads (dist/). */
  readonly localDir: string;
  readonly background: string;
  /** The window's page, so main can theme it while it is open. */
  readonly onOpen: (contents: WebContents) => void;
  readonly onClose: () => void;
}

let open: BrowserWindow | undefined;

/**
 * The Add a Streamroom address window, or in port mode the Change this PC's port one. Only one is
 * open at a time; asking again focuses it.
 */
export function askServerAddress(options: ServerDialogOptions): void {
  if (open && !open.isDestroyed()) {
    open.focus();
    return;
  }
  const dialog = new BrowserWindow({
    parent: options.parent,
    modal: true,
    width: 480,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: options.mode.kind === 'port' ? "Change this PC's Streamroom port" : 'Add a Streamroom address',
    backgroundColor: options.background,
    show: false,
    webPreferences: {
      preload: join(options.localDir, 'preload-server.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  open = dialog;
  dialog.setMenu(null);
  const contents = dialog.webContents;
  const fromDialog = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === contents;
  const add = (event: Electron.IpcMainInvokeEvent, raw: unknown): string | undefined => {
    if (!fromDialog(event)) return undefined;
    const text = typeof raw === 'string' ? raw : '';
    const { mode } = options;
    const reading = mode.kind === 'port' ? readPortInput(text) : readServerInput(text);
    if (!reading) return mode.kind === 'port' ? 'Enter a port.' : 'Enter an address.';
    if ('problem' in reading) return reading.problem;
    if (mode.kind === 'port') mode.onChoose(parsePort(text)!);
    else mode.onChoose(reading.origin);
    dialog.close();
    return undefined;
  };
  const cancel = (event: Electron.IpcMainEvent) => {
    if (fromDialog(event)) dialog.close();
  };
  ipcMain.handle(Channel.serverAdd, add);
  ipcMain.on(Channel.serverCancel, cancel);
  // Nothing in the window leaves it: no links, no new windows.
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dialog.once('ready-to-show', () => dialog.show());
  dialog.once('closed', () => {
    ipcMain.removeHandler(Channel.serverAdd);
    ipcMain.removeListener(Channel.serverCancel, cancel);
    open = undefined;
    options.onClose();
  });
  options.onOpen(contents);
  const query: Record<string, string> = options.mode.kind === 'port' ? { mode: 'port', port: String(options.mode.port) } : { mode: 'address' };
  void dialog.loadFile(join(options.localDir, 'renderer', 'server.html'), { query });
}
