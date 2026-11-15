import { ipcRenderer } from 'electron';
import { Channel } from '../shared/ipc.ts';
import { parseThemeChoice } from '../shared/theme.ts';

/**
 * Keeps `data-theme` on the page's root element on the theme the user picked, which selects
 * that theme's block in tokens.css. Without the attribute the page follows the system's light
 * or dark setting. The dock and the Texts page run it; service pages are never themed.
 */
export function followTheme(): void {
  let choice = parseThemeChoice(undefined);
  const apply = () => {
    const root = document.documentElement;
    if (!root) return;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  };
  const set = (raw: unknown) => {
    choice = parseThemeChoice(raw);
    apply();
  };
  // The preload can run before the root element exists; it gets the attribute once it does.
  document.addEventListener('readystatechange', apply, { once: true });
  ipcRenderer.on(Channel.theme, (_event, raw: unknown) => set(raw));
  void ipcRenderer.invoke(Channel.getTheme).then(set);
}
