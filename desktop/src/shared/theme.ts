/**
 * The colour themes of the pages Kainos Talk draws itself (the dock and the Texts page). Their
 * token values live in renderer/tokens.css, one block per theme selected by `data-theme` on the
 * root element; this table is what main needs: the menu's names, and the colour behind the
 * pages until they paint (each theme's --surface), so nothing flashes in another colour.
 */
export const THEMES = [
  { id: 'switchboard', name: 'Switchboard', kind: 'dark', surface: '#0b1316' },
  { id: 'daylight', name: 'Daylight', kind: 'light', surface: '#ffffff' },
  { id: 'bakelite', name: 'Bakelite', kind: 'dark', surface: '#15100d' },
  { id: 'carbon', name: 'Carbon', kind: 'dark', surface: '#000000' },
  { id: 'aubergine', name: 'Aubergine', kind: 'dark', surface: '#21152b' },
] as const satisfies readonly { id: string; name: string; kind: 'light' | 'dark'; surface: string }[];

export type Theme = (typeof THEMES)[number];
export type ThemeId = Theme['id'];

/** What the user picked: a theme by name, or `system`, which follows the system's light or dark setting. */
export type ThemeChoice = ThemeId | 'system';

/** What `system` shows when the system is light or dark. */
export const SYSTEM_THEME = { light: 'daylight', dark: 'bakelite' } as const satisfies Record<Theme['kind'], ThemeId>;

const isThemeId = (raw: unknown): raw is ThemeId => THEMES.some((theme) => theme.id === raw);

/** A saved or sent choice is untrusted: anything but a known theme id means `system`. */
export function parseThemeChoice(raw: unknown): ThemeChoice {
  return isThemeId(raw) ? raw : 'system';
}

/** The theme a choice shows right now. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  const id = choice === 'system' ? SYSTEM_THEME[systemDark ? 'dark' : 'light'] : choice;
  return THEMES.find((theme) => theme.id === id)!;
}
