import { app, shell } from 'electron';
import { isExternalSafe } from './navigation.ts';

/**
 * Opens a link in the system browser. Automated runs set KAINOS_BLOCK_EXTERNAL=1 so a test
 * never opens the user's browser; the link is reported as an app event instead.
 */
export function openExternal(url: string): void {
  if (!isExternalSafe(url)) return;
  if (process.env.KAINOS_BLOCK_EXTERNAL === '1') {
    app.emit('kainos-external', url);
    return;
  }
  shell.openExternal(url).catch((error: unknown) => console.error('Could not open link', url, error));
}
