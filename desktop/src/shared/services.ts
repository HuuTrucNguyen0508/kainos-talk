import { unreadFromTitlePrefix, type Unread } from './unread.ts';

/**
 * Every service Kainos Talk hosts. Adding a service means adding one entry here.
 *
 * Host patterns are exact hostnames, or "*.example.com" for any subdomain of example.com.
 */
export interface ServiceDefinition {
  /** Stable id: names the login partition (persist:service-<id>) and the saved state. */
  readonly id: string;
  readonly name: string;
  /** The page the service opens on. */
  readonly url: string;
  /** Top-level pages that stay inside the service view, including its sign-in pages. */
  readonly hosts: readonly string[];
  /**
   * Pages the service may open in a popup window, such as a captcha or sign-in step. A popup
   * stays on these and `hosts`; anything else goes to the system browser and closes it.
   */
  readonly popupHosts: readonly string[];
  /** Image hosts a notification icon (a sender's avatar) may be fetched from. */
  readonly iconHosts: readonly string[];
  readonly icon: ServiceIcon;
  /** Reads the unread count from the page title. */
  readonly unread: (title: string) => Unread;
  /**
   * An unread counter on the page itself, read by the service preload. While `scope` is on the
   * page, `count` decides (missing means 0); without it the title decides.
   */
  readonly unreadCounter?: UnreadCounter;
  /** A client mod loaded into the page before its own code. */
  readonly clientMod?: 'vencord';
  /** A page of Kainos' own instead of a website; `url` is then only a label. */
  readonly localPage?: 'inbox';
}

export interface UnreadCounter {
  /** CSS selector of the element the counter belongs to. */
  readonly scope: string;
  /** CSS selector of the counter itself. */
  readonly count: string;
}

export interface ServiceIcon {
  /** Tile colour. White strokes on it must stay at 3:1 contrast or better. */
  readonly color: string;
  /** SVG path data on a 24×24 grid, drawn as a 1.8px white stroke. */
  readonly glyph: string;
}

export const SERVICES: readonly ServiceDefinition[] = [
  {
    id: 'inbox',
    name: 'Inbox',
    // Kainos' own page: every conversation and mail from the phone, synced over the local
    // network (sms-sync.ts). The websites below load only when opened.
    url: 'kainos:inbox',
    hosts: [],
    popupHosts: [],
    iconHosts: [],
    localPage: 'inbox',
    icon: {
      color: '#0E6B66',
      // An inbox tray.
      glyph: 'M4 13h4.2l1.6 2.6h4.4l1.6-2.6H20 M4 13l2.6-7.2a1.2 1.2 0 0 1 1.1-.8h8.6a1.2 1.2 0 0 1 1.1.8L20 13v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z',
    },
    unread: unreadFromTitlePrefix,
  },
  {
    id: 'proton-mail',
    name: 'Proton Mail',
    url: 'https://mail.proton.me',
    hosts: ['mail.proton.me', 'account.proton.me'],
    popupHosts: ['account.proton.me', 'verify.proton.me'],
    iconHosts: ['mail.proton.me', 'account.proton.me'],
    icon: {
      color: '#6D4AFF',
      glyph: 'M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z M3.6 7.4 12 13.2l8.4-5.8',
    },
    unread: unreadFromTitlePrefix,
    // The title only counts the open folder, so read the Inbox counter in the sidebar.
    // Selectors from Ferdium's Proton recipe; not yet checked against a signed-in page.
    unreadCounter: {
      scope: '[data-testid="navigation-link:inbox"]',
      count: '[data-testid="navigation-link:inbox"] [data-testid="navigation-link:unread-count"]',
    },
  },
  {
    id: 'discord',
    name: 'Discord',
    url: 'https://discord.com/app',
    hosts: ['discord.com'],
    popupHosts: ['hcaptcha.com', '*.hcaptcha.com'],
    iconHosts: ['cdn.discordapp.com', 'media.discordapp.net', 'discord.com'],
    icon: {
      color: '#5865F2',
      glyph: 'M4.5 14.5V12a7.5 7.5 0 0 1 15 0v2.5 M4.5 14h3v5h-2a1 1 0 0 1-1-1z M19.5 14h-3v5h2a1 1 0 0 0 1-1z',
    },
    unread: unreadFromTitlePrefix,
    clientMod: 'vencord',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    url: 'https://web.whatsapp.com',
    hosts: ['web.whatsapp.com'],
    popupHosts: [],
    iconHosts: ['pps.whatsapp.net', 'web.whatsapp.com'],
    icon: {
      color: '#15924F',
      // A plain chat bubble with three dots, not WhatsApp's handset-in-a-bubble logo.
      glyph: 'M5.5 4.5h13a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7.3l-4.4 3.3v-3.3H5.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z M8.3 10.8h.01 M12 10.8h.01 M15.7 10.8h.01',
    },
    unread: unreadFromTitlePrefix,
  },
  {
    id: 'messenger',
    name: 'Messenger',
    url: 'https://www.messenger.com/',
    // Sign-in and security checks can pass through Facebook's own pages.
    hosts: ['www.messenger.com', 'messenger.com', 'www.facebook.com'],
    popupHosts: ['www.facebook.com'],
    iconHosts: ['*.fbcdn.net'],
    icon: {
      color: '#0866FF',
      // A round chat bubble with two lines of text, not Messenger's lightning-bolt logo.
      glyph: 'M12 3.8c-4.7 0-8.3 3.4-8.3 7.8 0 2.3 1 4.3 2.6 5.7v3l2.8-1.5c.9.3 1.9.4 2.9.4 4.7 0 8.3-3.4 8.3-7.6S16.7 3.8 12 3.8z M8.6 10.4h6.8 M8.6 13.4h4.4',
    },
    unread: unreadFromTitlePrefix,
  },
];

export function findService(id: unknown): ServiceDefinition | undefined {
  return SERVICES.find((service) => service.id === id);
}

export function partitionFor(service: ServiceDefinition): string {
  return `persist:service-${service.id}`;
}
