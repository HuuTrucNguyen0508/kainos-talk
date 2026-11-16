import { Menu, app, desktopCapturer, type DesktopCapturerSource, type Session } from 'electron';

/**
 * Lets a call app's page share the screen (getDisplayMedia). Electron has no picker of its own:
 *
 * - On macOS the system picker chooses.
 * - On Linux under Wayland, asking for the sources opens the desktop portal's picker
 *   (xdg-desktop-portal), which returns only what the user chose.
 * - Elsewhere (Windows, X11) the sources come back as a list, and a menu of their names asks.
 *
 * Closing a picker without choosing cancels the share. `allowed` checks the requesting origin.
 */
export function handleScreenShare(ses: Session, allowed: (origin: string) => boolean): void {
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!allowed(request.securityOrigin)) {
        callback({});
        return;
      }
      void chooseSource().then(
        (source) => {
          if (!source) callback({});
          // System sound comes along on Windows only; Electron cannot capture it on Linux or macOS.
          else callback({ video: source, ...(request.audioRequested && process.platform === 'win32' && { audio: 'loopback' as const }) });
        },
        (error: unknown) => {
          console.error('Screen share failed', error);
          callback({});
        },
      );
    },
    { useSystemPicker: true },
  );
}

async function chooseSource(): Promise<DesktopCapturerSource | undefined> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  // Under Wayland the portal has already asked, and returns only the user's choice. Anywhere
  // else nothing has asked yet, so even a single source goes through the menu.
  if (portalPicks()) return sources[0];
  return sources.length > 0 ? pickFromMenu(sources) : undefined;
}

/** Electron captures through the desktop portal on Linux when it runs as a Wayland client. */
function portalPicks(): boolean {
  if (process.platform !== 'linux') return false;
  const ozone = app.commandLine.getSwitchValue('ozone-platform');
  return ozone === 'wayland' || (ozone === '' && Boolean(process.env.WAYLAND_DISPLAY));
}

function pickFromMenu(sources: readonly DesktopCapturerSource[]): Promise<DesktopCapturerSource | undefined> {
  return new Promise((resolve) => {
    let picked: DesktopCapturerSource | undefined;
    const item = (source: DesktopCapturerSource) => ({ label: source.name || 'Untitled window', click: () => (picked = source) });
    const screens = sources.filter((source) => source.id.startsWith('screen:'));
    const windows = sources.filter((source) => !source.id.startsWith('screen:'));
    Menu.buildFromTemplate([
      { label: 'Share your screen', enabled: false },
      ...screens.map(item),
      { type: 'separator' },
      ...windows.map(item),
      { type: 'separator' },
      { label: 'Cancel' },
    ]).popup({
      // The menu closes before its item's click runs on some platforms; wait a moment for it.
      callback: () => setTimeout(() => resolve(picked), 50),
    });
  });
}
