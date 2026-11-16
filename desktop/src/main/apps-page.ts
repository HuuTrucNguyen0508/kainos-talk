import { WebContentsView, ipcMain, type BaseWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { AppsChannel, type AppsChoices } from '../shared/apps.ts';

export interface AppsPageOptions {
  readonly win: BaseWindow;
  /** Folder of the built pages and preloads (dist/). */
  readonly localDir: string;
  readonly background: string;
  /** What the page lists: every service, and which are on. Read when the page asks. */
  readonly choices: () => AppsChoices;
  /** The user saved: the ids to have on, at least one, all of them known. */
  readonly onSave: (ids: readonly string[]) => void;
  readonly onClose: () => void;
}

export interface AppsPage {
  readonly view: WebContentsView;
  close(): void;
}

/**
 * Choose your apps: a page of Kainos' own over the whole window, on first launch and from the
 * dock options menu. Saving closes it; so does Cancel, except on first launch.
 */
export function openAppsPage(options: AppsPageOptions): AppsPage {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(options.localDir, 'preload-apps.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  view.setBackgroundColor(options.background);
  const contents = view.webContents;
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const fromPage = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === contents;
  const known = () => options.choices().services.map((service) => service.id);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ipcMain.removeHandler(AppsChannel.get);
    ipcMain.removeListener(AppsChannel.save, save);
    ipcMain.removeListener(AppsChannel.cancel, cancel);
    options.win.contentView.removeChildView(view);
    if (!contents.isDestroyed()) contents.close();
    options.onClose();
  };
  const save = (event: IpcMainEvent, raw: unknown) => {
    if (!fromPage(event) || !Array.isArray(raw)) return;
    const ids = known().filter((id) => raw.includes(id));
    if (ids.length === 0) return;
    options.onSave(ids);
    close();
  };
  const cancel = (event: IpcMainEvent) => {
    if (fromPage(event) && !options.choices().firstRun) close();
  };
  ipcMain.handle(AppsChannel.get, (event) => (fromPage(event) ? options.choices() : undefined));
  ipcMain.on(AppsChannel.save, save);
  ipcMain.on(AppsChannel.cancel, cancel);

  options.win.contentView.addChildView(view);
  void contents.loadFile(join(options.localDir, 'renderer', 'apps.html')).then(() => contents.focus());
  return { view, close };
}
