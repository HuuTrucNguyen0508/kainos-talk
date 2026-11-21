import { DEFAULT_LOCAL_PORT, localServer } from './streamroom.ts';
import { unreadFromGmailTitle, unreadFromTitlePrefix, type Unread } from './unread.ts';

/**
 * Every service Kainos Talk hosts. Adding a service means adding one entry here.
 *
 * Host patterns are exact hostnames, or "*.example.com" for any subdomain of example.com.
 */
/**
 * What a website does while it is in the background (another tab is open, or the window is
 * hidden or minimised). 'run' keeps drawing it as if on screen. 'sleep' stops drawing it and
 * slows its timers to once a second, the way a browser treats a background tab; its connection
 * stays open, so messages and notifications still arrive. 'hibernate' sleeps it, then closes its
 * page after a while in the background, which frees its memory and stops its notifications.
 */
export type AwayMode = 'run' | 'sleep' | 'hibernate';

export interface ServiceDefinition {
  /** Stable id: names the login partition (persist:service-<id>) and the saved state. */
  readonly id: string;
  readonly name: string;
  /** One line on the Choose your apps page: what the user gets. */
  readonly about: string;
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
  /** A call app: its own pages may also share the screen and pick the speaker. */
  readonly calls?: true;
  /**
   * Opens each call in a window of its own: a blank one, which the page then sends to a call
   * page on its hosts. Only these services may open a blank popup.
   */
  readonly callWindow?: true;
  /**
   * Links to its hosts from the other services open in this tab instead of the browser, so an
   * invite link sent in a chat joins from Kainos.
   */
  readonly claimsLinks?: true;
  /**
   * Starts hibernated the first time Kainos knows it, for a service used now and then that has
   * nothing to notify about. Opening its tab wakes it.
   */
  readonly startsHibernated?: true;
  /** What it does in the background until the user picks otherwise in its menu; 'sleep' if unset. */
  readonly whenAway?: AwayMode;
  /**
   * Added after people had already chosen their apps: an update never turns it on for them, so
   * it waits off until they pick it on the Choose your apps page.
   */
  readonly optIn?: true;
  /**
   * Google's sign-in pages (accounts.google.com) see Firefox instead of Chrome. Google refuses
   * to sign in inside an app it recognises as an embedded Chrome, and lets Firefox through.
   */
  readonly googleSignIn?: true;
}

export interface UnreadCounter {
  /** CSS selector of the element the counter belongs to. */
  readonly scope: string;
  /** CSS selector of the counter itself. */
  readonly count: string;
}

export interface ServiceIcon {
  /** Tile colour. The white glyph on it must stay at 3:1 contrast or better. */
  readonly color: string;
  /** SVG path data on a 24×24 grid, drawn in white. */
  readonly glyph: string;
  /**
   * 'stroke' draws the path as a 1.8px line (Kainos' own icons); 'fill' fills it (brand logos,
   * from Simple Icons, CC0: https://simpleicons.org).
   */
  readonly paint: 'stroke' | 'fill';
}

export const SERVICES: readonly ServiceDefinition[] = [
  {
    // The id stays 'inbox': it names the login partition and the saved state.
    id: 'inbox',
    name: 'Texts',
    about: "Your phone's texts (SMS and RCS), through the Kainos phone app on your network.",
    // Kainos' own page: the phone's SMS and RCS conversations, synced over the local network
    // (sms-sync.ts).
    url: 'kainos:inbox',
    hosts: [],
    popupHosts: [],
    iconHosts: [],
    localPage: 'inbox',
    icon: {
      color: '#0E6B66',
      // A speech bubble drawn as a line, with two lines of text. The brand logos around it are
      // filled bubbles (WhatsApp, Messenger), so an outline cannot be mistaken for either.
      paint: 'stroke',
      glyph: 'M6.5 4.5h11A2.5 2.5 0 0 1 20 7v7a2.5 2.5 0 0 1-2.5 2.5H11L7 20v-3.5h-.5A2.5 2.5 0 0 1 4 14V7a2.5 2.5 0 0 1 2.5-2.5z M8 9h8 M8 12.5h5',
    },
    unread: unreadFromTitlePrefix,
  },
  {
    id: 'proton-mail',
    name: 'Proton Mail',
    about: 'Encrypted email from Proton.',
    url: 'https://mail.proton.me',
    hosts: ['mail.proton.me', 'account.proton.me'],
    popupHosts: ['account.proton.me', 'verify.proton.me'],
    iconHosts: ['mail.proton.me', 'account.proton.me'],
    icon: {
      color: '#6D4AFF',
      paint: 'fill',
      glyph: 'm15.24 8.998 3.656-3.073v15.81H2.482C1.11 21.735 0 20.609 0 19.223V6.944l7.58 6.38a2.186 2.186 0 0 0 2.871-.042l4.792-4.284h-.003zm-5.456 3.538 1.809-1.616a2.438 2.438 0 0 1-1.178-.533L.905 2.395A.552.552 0 0 0 0 2.826v2.811l8.226 6.923a1.186 1.186 0 0 0 1.558-.024zM23.871 2.463a.551.551 0 0 0-.776-.068l-3.199 2.688v16.653h1.623c1.371 0 2.481-1.127 2.481-2.513V2.824a.551.551 0 0 0-.129-.36z',
    },
    unread: unreadFromTitlePrefix,
    // Mail can wait: it frees its memory in the background rather than notify.
    whenAway: 'hibernate',
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
    about: "Servers, friends and calls, with Vencord's plugins and themes.",
    url: 'https://discord.com/app',
    hosts: ['discord.com'],
    popupHosts: ['hcaptcha.com', '*.hcaptcha.com'],
    iconHosts: ['cdn.discordapp.com', 'media.discordapp.net', 'discord.com'],
    icon: {
      color: '#5865F2',
      paint: 'fill',
      glyph: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
    },
    unread: unreadFromTitlePrefix,
    clientMod: 'vencord',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    about: "Chats from your phone's WhatsApp, linked by QR code.",
    url: 'https://web.whatsapp.com',
    hosts: ['web.whatsapp.com'],
    popupHosts: [],
    iconHosts: ['pps.whatsapp.net', 'web.whatsapp.com'],
    icon: {
      color: '#15924F',
      paint: 'fill',
      glyph: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
    },
    unread: unreadFromTitlePrefix,
  },
  {
    id: 'messenger',
    name: 'Messenger',
    about: 'Facebook Messenger chats.',
    url: 'https://www.messenger.com/',
    // Sign-in and security checks can pass through Facebook's own pages.
    hosts: ['www.messenger.com', 'messenger.com', 'www.facebook.com'],
    popupHosts: ['www.facebook.com'],
    iconHosts: ['*.fbcdn.net'],
    calls: true,
    callWindow: true,
    icon: {
      color: '#0866FF',
      paint: 'fill',
      glyph: 'M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.521 3.769 8.61a.96.96 0 0 1 .323.683l.065 2.135a.96.96 0 0 0 1.347.85l2.381-1.053a.96.96 0 0 1 .641-.046A13 13 0 0 0 12 23.28c6.76 0 12-4.952 12-11.64S18.76 0 12 0m6.806 7.44c.522-.03.971.567.63 1.094l-4.178 6.457a.707.707 0 0 1-.977.208l-3.87-2.504a.44.44 0 0 0-.49.007l-4.363 3.01c-.637.438-1.415-.317-.995-.966l4.179-6.457a.706.706 0 0 1 .977-.21l3.87 2.505c.15.097.344.094.491-.007l4.362-3.008a.7.7 0 0 1 .364-.13',
    },
    unread: unreadFromTitlePrefix,
  },
  {
    id: 'streamroom',
    name: 'Streamroom',
    about: 'Rooms for screen sharing and voice, on a Streamroom server you choose.',
    // Screen-share and voice rooms from the Streamroom project. Which server it uses is a choice
    // in its menu (shared/streamroom.ts): this computer until the user adds their own address.
    url: `${localServer(DEFAULT_LOCAL_PORT)}/`,
    hosts: ['localhost'],
    popupHosts: [],
    iconHosts: [],
    icon: {
      // Streamroom's own velvet, lifted so the tile still reads on the darkest docks.
      color: '#3D3670',
      // Its favicon as a line drawing: the shared screen, and three seats in front of it.
      paint: 'stroke',
      glyph: 'M5 3.5h14A1.5 1.5 0 0 1 20.5 5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 13V5A1.5 1.5 0 0 1 5 3.5z M6 19.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0z M11 19.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0z M16 19.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0z',
    },
    unread: unreadFromTitlePrefix,
    calls: true,
    claimsLinks: true,
    // A room is opened for a call and left; it never notifies, so it need not run all day.
    startsHibernated: true,
    whenAway: 'hibernate',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    about: 'Email from Google. Google may still refuse to sign in inside an app.',
    url: 'https://mail.google.com/mail/u/0/',
    // Signing in passes through Google's account pages, and YouTube's for the shared login.
    hosts: ['mail.google.com', 'accounts.google.com', 'accounts.youtube.com'],
    // Gmail opens a message or a draft in a window of its own; that window shares the login.
    popupHosts: ['mail.google.com', 'accounts.google.com'],
    iconHosts: ['*.googleusercontent.com', 'mail.google.com'],
    icon: {
      // Google's red, darkened so the white envelope keeps 3:1.
      color: '#C5221F',
      paint: 'fill',
      glyph: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
    },
    unread: unreadFromGmailTitle,
    optIn: true,
    googleSignIn: true,
  },
];

export function findService(id: unknown): ServiceDefinition | undefined {
  return SERVICES.find((service) => service.id === id);
}

/** Kainos' own pages hold state in main and cost little; only websites can hibernate. */
export function canHibernate(service: ServiceDefinition): boolean {
  return service.localPage === undefined;
}

export function defaultAwayMode(service: ServiceDefinition): AwayMode {
  return service.whenAway ?? 'sleep';
}

export function isAwayMode(value: unknown): value is AwayMode {
  return value === 'run' || value === 'sleep' || value === 'hibernate';
}

export function partitionFor(service: ServiceDefinition): string {
  return `persist:service-${service.id}`;
}
