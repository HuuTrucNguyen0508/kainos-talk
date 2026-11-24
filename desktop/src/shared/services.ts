import { DEFAULT_LOCAL_PORT, localServer } from './streamroom.ts';
import { NO_UNREAD, unreadFromGmailTitle, unreadFromTitlePrefix, type Unread } from './unread.ts';

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
  /**
   * A page of Kainos' own instead of a website; `url` is then only a label. 'native' is the page
   * behind a desktop app's window (`nativeApp`).
   */
  readonly localPage?: 'inbox' | 'native';
  /** A desktop app instead of a website: on Hyprland, its own window sits over the tab. */
  readonly nativeApp?: NativeApp;
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

export interface NativeApp {
  /** The program and its arguments, looked up on the PATH. */
  readonly command: readonly string[];
  /** Hyprland's class for its windows. */
  readonly windowClass: string;
  /**
   * The title its main window opens with, so a second window of the app (a message being
   * written, a dialog) is never the one placed over the tab.
   */
  readonly mainTitle: string;
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
  {
    id: 'proton-drive',
    name: 'Proton Drive',
    about: "Proton's encrypted cloud storage, in its web app.",
    url: 'https://drive.proton.me',
    hosts: ['drive.proton.me', 'account.proton.me'],
    popupHosts: ['account.proton.me', 'verify.proton.me'],
    iconHosts: ['drive.proton.me', 'account.proton.me'],
    icon: {
      // Proton's purple. Proton Mail's tile already carries Proton's logo, so Drive is a line
      // drawing of a folder instead of a second copy of it.
      color: '#6D4AFF',
      paint: 'stroke',
      glyph: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z M3.5 10.5h17',
    },
    unread: () => NO_UNREAD,
    // An upload or download runs in the page; sleeping it would slow or stall the transfer.
    whenAway: 'run',
    optIn: true,
  },
  {
    id: 'thunderbird',
    name: 'Thunderbird',
    about: "Mozilla's email app, its own window fitted into the tab.",
    url: 'kainos:thunderbird',
    hosts: [],
    popupHosts: [],
    iconHosts: [],
    localPage: 'native',
    nativeApp: { command: ['thunderbird'], windowClass: 'org.mozilla.Thunderbird', mainTitle: 'Mozilla Thunderbird' },
    icon: {
      color: '#0A84FF',
      paint: 'fill',
      glyph: 'M9.948 4.444h-.005c-1.92.788-2.126 2.55-1.817 3.499v.02C9.236 7.18 10.658 6.76 12 6.76c3.26 0 5.902 2.156 5.902 4.815 0 2.66-2.643 4.816-5.902 4.816l-.083-.002c-.155-.006-.354-.013-.435.118-.096.156.116.397.238.536 1.274 1.441 3.123 1.622 3.608 1.67l.076.008c-4.281.414-9.304-2.32-9.306-7.076 0-1.12.414-2.073 1.075-2.83l-.005-.002h-.003C7.31 6.38 6.376 3.47 4.629 2.898c-.124-.04-.246.054-.262.183-.23 1.924-.727 2.59-1.264 3.31-.805 1.08-1.39 2.328-1.365 3.698a10.99 10.99 0 0 1-.705-1.91c-.024-.09-.17-.365-.333-.272-.13.072-.227.274-.296.485A12.137 12.137 0 0 0 0 11.489c0 6.536 5.475 12 12 12 6.627 0 12-5.372 12-12 0-2.526-.781-4.87-2.115-6.805l.167-.002c.518 0 1.024.045 1.51.129-.734-.816-1.724-1.475-2.877-1.904a8.54 8.54 0 0 1 2.494-.495c-1.426-1.166-3.508-1.9-5.827-1.9-3.355 0-6.648 1.29-7.404 3.93zm.682 9.166c-.87-.905-3.473-3.91-3.473-3.91l.202.01 4.075 3.042c.305.223.74.22 1.043-.004l3.996-3.034.212-.018s-2.518 2.935-3.483 3.9c-.964.968-1.703.919-2.572.014zm2.774-10.083s.055.625-.576.824c-.722.227-1.042-.38-1.042-.38s.09-.417.676-.61c.626-.206.942.166.942.166z',
    },
    // Thunderbird shows its own unread count and sends its own notifications.
    unread: () => NO_UNREAD,
    optIn: true,
  },
];

export function findService(id: unknown): ServiceDefinition | undefined {
  return SERVICES.find((service) => service.id === id);
}

/** Kainos' own pages (and a desktop app's) hold state in main and cost little; only websites can hibernate. */
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
