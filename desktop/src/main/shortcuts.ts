export interface KeyInput {
  readonly type: string;
  /** The character the key types on the current layout. */
  readonly key: string;
  /** The physical key, layout-independent ("Digit1"); empty when unknown. */
  readonly code: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type Shortcut =
  /** Ctrl+1..9 (Cmd on macOS): the tab in that place in the dock, hidden services skipped. */
  | { readonly kind: 'service'; readonly index: number }
  /** Ctrl+Q (Cmd+Q on macOS). */
  | { readonly kind: 'quit' }
  /** F6: between the dock and the service page. */
  | { readonly kind: 'switch-pane' }
  /** F5 or Ctrl+R reloads the open service; with Shift (or Ctrl+F5), past the cache. */
  | { readonly kind: 'reload'; readonly ignoreCache: boolean };

/**
 * The app's own keys, wherever focus is. Digits match the physical key, so AZERTY's
 * unshifted number row ("&", "é", ...) works; Q matches the letter, as quit does everywhere.
 */
export function shortcutFor(input: KeyInput, platform: NodeJS.Platform, serviceCount: number): Shortcut | undefined {
  if (input.type !== 'keyDown' || input.alt) return undefined;
  const command = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  const plain = !input.control && !input.meta;
  if (input.key === 'F5' && (plain || command)) return { kind: 'reload', ignoreCache: input.shift || command };
  if (command && input.key.toLowerCase() === 'r') return { kind: 'reload', ignoreCache: input.shift };
  if (input.shift) return undefined;
  if (plain) return input.key === 'F6' ? { kind: 'switch-pane' } : undefined;
  if (!command) return undefined;
  if (input.key.toLowerCase() === 'q') return { kind: 'quit' };
  const digit = input.code ? /^(?:Digit|Numpad)([1-9])$/.exec(input.code)?.[1] : /^[1-9]$/.exec(input.key)?.[0];
  if (digit === undefined) return undefined;
  const index = Number(digit) - 1;
  return index < serviceCount ? { kind: 'service', index } : undefined;
}
