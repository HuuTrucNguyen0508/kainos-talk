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
  /** Ctrl+1..9 (Cmd on macOS): the service in that place in the sidebar. */
  | { readonly kind: 'service'; readonly index: number }
  /** Ctrl+Q (Cmd+Q on macOS). */
  | { readonly kind: 'quit' }
  /** F6: between the sidebar and the service page. */
  | { readonly kind: 'switch-pane' };

/**
 * The app's own keys, wherever focus is. Digits match the physical key, so AZERTY's
 * unshifted number row ("&", "é", ...) works; Q matches the letter, as quit does everywhere.
 */
export function shortcutFor(input: KeyInput, platform: NodeJS.Platform, serviceCount: number): Shortcut | undefined {
  if (input.type !== 'keyDown' || input.alt || input.shift) return undefined;
  const command = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!input.control && !input.meta) return input.key === 'F6' ? { kind: 'switch-pane' } : undefined;
  if (!command) return undefined;
  if (input.key.toLowerCase() === 'q') return { kind: 'quit' };
  const digit = input.code ? /^(?:Digit|Numpad)([1-9])$/.exec(input.code)?.[1] : /^[1-9]$/.exec(input.key)?.[0];
  if (digit === undefined) return undefined;
  const index = Number(digit) - 1;
  return index < serviceCount ? { kind: 'service', index } : undefined;
}
