# Kainos Talk desktop

Electron shell that hosts Proton Mail, Discord, WhatsApp, Messenger, Streamroom and Gmail in one window, plus a
Texts page for the phone's SMS and RCS, each switched on or off on Choose your apps. A dock that slides up from the bottom of the window switches between them; each
service runs in its own `WebContentsView` with its own persistent login (`persist:service-<id>`).
The websites that are on load at startup. In the background they sleep and keep notifying, or
hibernate after a while, as each one's **In the background** choice says (see **In the background**);
Streamroom starts hibernated, and opens the Streamroom server picked in its menu.

## Commands

Run from the repository root or from this folder.

```sh
pnpm install                     # also downloads the Electron binary
pnpm --filter desktop start      # build, then open the app
pnpm --filter desktop build      # bundle into desktop/dist
pnpm --filter desktop test       # unit tests (node:test)
pnpm --filter desktop typecheck
pnpm --filter desktop smoke      # off-screen end-to-end check against the live services
pnpm --filter desktop install-launcher  # add Kainos Talk to your app launcher (this user)
```

`install-launcher` writes `kainos-talk.desktop` and the icon under `~/.local/share`. The entry runs
`bin/kainos-talk` from this checkout, which rebuilds when the source is newer than the build and
then starts Electron, so the launcher always opens the current code. The window's class (Wayland
app id) is `kainos-talk`. Run it again if the checkout moves.

`smoke` never shows a window, opens a browser or touches your tray or notifications: Electron runs
on the headless Ozone platform with no `DISPLAY` or `WAYLAND_DISPLAY`, on a private D-Bus session
whose config lists no service directories (so nothing, such as your notification daemon, can be
activated on it). Its only tray host and notification server is `test/fake-desktop-host.py`,
which the test reads to check that notifications arrive. Outside links are reported instead of
opened (`KAINOS_BLOCK_EXTERNAL=1`). It needs `dbus-daemon`, `dbus-send` and Python 3 with
PyGObject, plus network access. Screenshots go to `.verify/` (git-ignored), or to
`KAINOS_VERIFY_DIR` when set.

## Layout

| Path | What it does |
|---|---|
| `src/shared/services.ts` | The service registry. Add a service by adding one entry. |
| `src/shared/unread.ts` | Unread parsing from page titles, totals, badge and window-title labels. |
| `src/main/index.ts` | Window, tray, menus, shortcuts, saved state, dock IPC. |
| `src/main/bar.ts` | Layout: the page under the floating dock, or above the always-shown dock's strip. |
| `src/main/dock-reveal.ts` | When the auto-hiding dock shows: a small state machine fed by the pointer, keyboard, menus and tab drags. |
| `src/shared/dock-order.ts` | The dock's service order and hidden services: loading them, moving a tab, where a dragged tab lands. |
| `src/shared/theme.ts` | The colour themes: ids, menu names, and each one's page colour, which main paints behind the pages. |
| `src/preload/theme.ts` | Keeps `data-theme` on the dock and Texts pages' root on the picked theme. |
| `src/preload/bottom-edge.ts` | Reports the pointer at a page's bottom edge, or leaving the window through it, for the dock. |
| `src/renderer/inbox.ts` | The Texts page (service id `inbox`): the phone's SMS and RCS conversations, threads, replies, new texts. |
| `src/main/sms-sync.ts` | SMS sync server: TLS, pairing, the phone's texts, replies. Protocol in `src/shared/sync-protocol.ts`. |
| `src/main/mdns.ts` | Announces the sync server: Avahi over D-Bus, or an in-app responder; LAN interfaces only. |
| `test/fake-phone.ts` | A protocol-speaking stand-in for the phone, used by the unit and smoke tests. |
| `src/main/service-runtime.ts` | One service view: session, user agent, permissions, navigation rules, load status. |
| `src/main/away.ts` | In the background: when a page out of sight sleeps, and when one set to hibernate closes. |
| `src/main/navigation.ts` | Which links stay in a service, open as a popup, open in a service that claims them (Streamroom), or go to the system browser. |
| `src/shared/streamroom.ts` | Streamroom's servers: reading an address, the saved choice, and the service pointed at it. |
| `src/main/apps-page.ts` | Choose your apps (`src/renderer/apps.ts`, `src/preload/apps.ts`): every service with a switch. |
| `src/main/server-dialog.ts` | The Add a Streamroom address window (`src/renderer/server.ts`, `src/preload/server.ts`). |
| `src/main/screen-share.ts` | Screen sharing for a call app (Streamroom): the system's picker, or a menu of screens and windows. |
| `src/main/permissions.ts` | Notifications and mic/camera for the service's own origin, plus screen sharing and speaker choice for a call app; everything else denied. |
| `src/main/notifications.ts` | Turns page notifications into native ones; mute and click-to-focus. |
| `src/preload/app.ts` | The dock page's only API, `window.kainos`. |
| `src/preload/service.ts` | Routes each page's `Notification` calls through the app (see below). |
| `src/main/vencord.ts` | Downloads, updates and loads the Vencord extension into Discord's session. |
| `src/renderer/` | The dock page (the floating islands or the strip, plus the loading and failed notices over the whole window) and the Texts page: plain TypeScript and CSS, no framework. `tokens.css` holds the five colour themes, one block each (`src/shared/theme.ts` lists them for main). |

## Behaviour notes

- **Browser identity.** Every service sees stock Chrome's user agent for this platform
  (`Chrome/<major>.0.0.0`, no Electron token). WhatsApp Web refuses anything else.
- **HDR screens (Linux).** Chromium's Wayland colour management is turned off
  (`--disable-features=WaylandWpColorManagerV1`). With it on, Hyprland's HDR mode showed the
  whole window greyish, with raised blacks and faded colours, while other windows looked right;
  screenshots looked normal. Without it the window is plain SDR and converted like the others.
- **Notifications.** Electron gives the main process no hook into a page's notifications, so
  the service preload replaces `window.Notification` and `ServiceWorkerRegistration.showNotification`
  in the page with a version that hands each one to the app. Apart from Vencord in Discord,
  that is the only script the app injects into the services, and it is what makes per-service mute, click-to-open and `tag` replacement
  work. Notifications raised from inside a service worker's own thread (web push while the page
  is closed) bypass it. A sender's avatar is fetched only from the service's own image hosts
  (`iconHosts` in the registry), without cookies or redirects, at most 512 KB within 3 s;
  anything else shows the app icon.
- **Vencord** runs in the Discord tab with its settings, plugins, themes and QuickCSS editor.
  The app loads the official Chrome extension build (`extension-chrome.zip` from Vencord's
  `devbuild` release) into the Discord session with Electron's extension support. It is kept in
  `vencord/extension/` in the userData folder. The app checks for a new build at startup and
  every 6 hours. A new build waits in `vencord/extension-next/` and takes over at the next launch;
  the very first download loads right away and reloads Discord. Electron cannot run the
  extension's service worker (keyboard shortcut commands) or its header rules, so the app drops
  the first and applies the second itself: Discord's content security policy is removed, and
  stylesheets from `raw.githubusercontent.com` are served as CSS, so themes can load from any
  host. Vencord keeps its settings in Discord's site storage, so **Sign out of Discord also
  resets Vencord**.
- **Texts and the websites.** Texts, first in the dock, shows the SMS and RCS conversations the paired
  phone sends, lets you reply or start a new text, and raises a desktop notification for each new
  text (mute it from its menu like any service). Its id stays `inbox`, because that names its
  login partition and the saved state. The websites load at startup and raise their own
  notifications unless they hibernate (see **Hibernate** and **In the background**). The window title and the tray lamp count every service. The phone app
  only syncs texts; `docs/pc-inbox-plan.md` records the earlier plan that mirrored every app and
  slept the websites, which was dropped.
- **The dock** hides until it is wanted, then slides up over the bottom of the page; the page never
  resizes. It comes up when the pointer rests against the window's bottom edge for a moment
  (160ms, so passing by on the way to a message box does not flash it), or leaves the window
  through that edge, which is where the pointer ends in a tiled window with gaps (Hyprland). It
  stays while the pointer is on it or in the strip-high band along the bottom, while keyboard
  focus is in it (F6), while one of its menus is open and while a tab is being dragged, and slides away 400ms after the pointer
  goes up into the page, when focus leaves it, or at once on Escape. While shown it covers the
  page's message box. Its view is only as big as the islands and their shadow, so the rest of the
  page keeps its clicks. The two islands sit together in the middle of the window. **Always show
  the dock**, in the Kainos mark's menu (or a right-click on the dock's empty space), keeps it in a
  64px strip of its own instead, with the page ending above it. **Theme**, in the same menu, colours
  the dock and the Texts page: **Match system** (the default: Daylight when the system is light,
  Bakelite when it is dark), or one of Switchboard (teal and ink), Daylight (light), Bakelite (warm
  dark), Carbon (black, white and greys; the services' logos are the only colour) and Aubergine
  (plum). It applies at once and is kept with the window state. The websites keep their own
  colours. The left island holds the Kainos mark and
  one tab per service (logo, name, then its unread count, a dot for new activity, a bell for muted,
  a red mark when it failed to load or, on Texts, when the phone is not connected). When the names
  no longer fit, every tab but the active one drops its name, then the active name hides too.
  If needed, the service tabs scroll horizontally; the mark and phone stay reachable.
  **Rearranging:** drag a tab along the dock to move it (a press that moves less than 5px is
  still a click); its neighbours step aside and a dashed slot shows where it lands. Alt+Left and
  Alt+Right move the focused tab, and each service's menu has **Move left** and **Move right**.
  **Hide from dock** in a service's menu takes its tab out; the service keeps running, notifying
  and counting in the title and tray unless muted. Hiding the open service opens the next tab.
  **Hidden services**, in the Kainos mark's menu, shows a hidden service again in its old place.
  Texts cannot be hidden. The order and hidden services are kept with the window state, and a
  service added in a later version appears at the end. The right island shows the paired
  phone and whether it is connected; click it for Open Texts and **Forget this phone**.
  Long device names truncate with the full name in a tooltip. While a service loads or fails, the
  dock page covers the whole window to say why, with the dock in its strip; a page in fullscreen
  covers the dock, which does not come up until it leaves fullscreen.
- **Hibernate**, in a website's menu, closes its page to free the memory it holds: the page's
  renderer process ends, and nothing of it stays loaded. The login, cookies and site storage stay,
  so it wakes signed in. A hibernating tab's logo turns grey with a moon after its name; it shows
  no unread count and raises no notifications. Opening its tab wakes it and loads its start page;
  **Wake**, in the same menu, loads it without opening it. If the hibernated service was open, the
  tab next to it opens, preferring one that is awake; hiding a tab does the same. Hibernating
  services are kept with the window state. The service opened at launch is always awake, and
  Texts cannot hibernate (its texts live in the app itself, not in a page).
- **In the background**, in a website's menu, says what the site does while it is out of sight
  (another tab is open, or the window is hidden or minimised). Each choice is kept with the window
  state.
  - **Keep running** keeps drawing the page as if it were on screen.
  - **Sleep, still notifying** stops drawing it and slows its timers to once a second, as a browser
    does with a background tab. Its connection stays open, so messages, notifications and the
    unread count still arrive at once. It is the default for WhatsApp, Discord, Messenger and
    Gmail, and Texts always does it.
  - **Hibernate after 10 minutes** sleeps it, then hibernates it after 10 minutes out of sight,
    as **Hibernate** does: no notifications until its tab is opened again. It is the default for
    Proton Mail and Streamroom. A page that is in a call, sharing the screen, using the
    microphone or camera, playing sound or showing a popup is left alone, and tried again 10
    minutes later. The open tab never hibernates, and neither does a tab hidden from the dock.

  A tab that another replaces sleeps a minute later, so switching back and forth costs nothing,
  and is drawn again the moment it is back. The open tab sleeps whenever its window is out of
  sight: hidden to the tray, minimised, or, on Windows and macOS, covered by other windows (Linux
  compositors do not tell apps that). A page that has not finished loading does not sleep yet,
  and one in a call (the same list as above) stays fully awake until the call ends.
  `node scripts/sleep-check.ts [app]` checks all this from inside a page on the running app (the
  Windows workflow runs it on the packaged .exe); the smoke test cannot, since Playwright keeps
  every page it drives visible.
- **Streamroom** is the [Streamroom](https://github.com/HuuTrucNguyen0508/streamroom) project's
  rooms for screen sharing and voice. Kainos holds no Streamroom server of its own: **Server**, in
  the tab's menu, picks which one the tab opens.
  - **This PC (localhost:8080)**, the default, is Streamroom run on this computer with
    `pnpm start`, as the Streamroom project's guide
    [Run Streamroom on your own computer](https://github.com/HuuTrucNguyen0508/streamroom/blob/main/docs/local.md)
    says; **Run Streamroom on this PC…**, at the bottom of the Server menu, opens that guide. Browsers allow the microphone and screen sharing
    on plain http only for `localhost`, so Kainos trusts plain http there and nowhere else.
    **Change this PC's port…** opens the same small window for a port, for a server started with
    `PORT=8090 pnpm start`; **Use this port** moves This PC there and opens it.
  - **Add an address…** opens a small window for any other server: your own Streamroom deployed
    to Cloudflare from that project's code (`streamroom.your-name.workers.dev`; its
    [Cloudflare guide](https://github.com/HuuTrucNguyen0508/streamroom/blob/main/docs/cloudflare.md)
    opens from **Deploy your own on Cloudflare…** in the same menu), a Tailscale address (`https://your-pc.your-tailnet.ts.net`) for calls with
    friends on your tailnet, or a second server on this PC (`localhost:8090`). A bare host means
    https; a room or invite link gives its server. The line under the field reads back what will
    open, and **Add and open** switches the tab to it.
  - The added addresses stay in the menu, the current one checked; **Forget** drops the current one
    and goes back to this PC. The choice is saved with the window state, not in the code.
  - Each server keeps its own host login, since logins belong to an address. A deployment with
    a host passphrase asks for it before a room can be started; invite links need none.

  It starts hibernated the first time Kainos knows it, since a room is opened for a call and
  then left; its tab wakes it. It may use the microphone, share the screen and pick the speaker.
  Sharing goes through the system's picker: on Linux under Wayland the desktop portal
  (`xdg-desktop-portal`) asks what to share, on macOS the system picker does, and elsewhere a
  menu lists the screens and windows. Electron captures system sound with the screen only on
  Windows. A Streamroom link to any added server opened in another service (an invite sent in
  Discord or WhatsApp) opens in the Streamroom tab, waking it and switching it to that server,
  instead of the browser. Files sent in a room ask where to save them.
- **Choose your apps.** The first launch opens on Choose your apps, a page over the whole
  window listing every service with a switch and one line on what it is; nothing loads and
  nothing listens for the phone until **Start**. The dock preview along its bottom fills with the
  tiles of the apps switched on. Later, **Choose apps…** in the Kainos mark's menu opens the same
  page as Your apps, with Cancel. A service switched off has no tab, no page, no notifications
  and no place in Hidden services, and its invite links go to the browser; its login stays, so
  switching it back on finds it signed in. Texts off stops the phone sync altogether: no port
  48090, no mDNS record, and no phone island in the dock. At least one app stays on. A state from
  before this page keeps every service it had on, and a service added later that is marked opt-in
  (Gmail) stays off until it is picked here.
- **Gmail** opens `mail.google.com`. It is opt-in, so an update never adds it to an existing set
  of apps. Google refuses to sign in inside apps it recognises as an embedded Chrome ("This browser
  or app may not be secure"), as it did for Google Messages, so Google's sign-in pages
  (`accounts.google.com`) in the Gmail tab see Firefox: its user agent in the requests, without
  Chrome's `Sec-CH-UA` client hints, and in the page's `navigator`. Whether Google accepts that
  can only be checked by signing in; if it still refuses, Gmail cannot be used in Kainos.
- **Messenger** opens `www.messenger.com`. Sign-in and security checks may pass through
  `www.facebook.com`, which stays inside the view.
- **Texts** is not a website. Google refuses its sign-in inside Kainos ("This browser or app may not
  be secure") and Google Messages for web no longer pairs by QR code, so the phone's texts come
  from the Kainos phone app instead (`src/main/sms-sync.ts`, plan in `docs/sms-sync-plan.md`):
  - The PC listens on TCP port 48090 (TLS 1.3, a self-signed certificate made on first run) and
    advertises itself over mDNS as `_kainos-talk._tcp`, with its certificate fingerprint in the
    record (`src/main/mdns.ts`). On Linux it registers through the system's Avahi daemon over
    D-Bus, on real LAN interfaces only (no Docker, VPN or Tailscale), the way Kainos Player's
    `AvahiHubAdvertiser` does; elsewhere, or without Avahi, an mDNS responder inside the app does
    it. Either way the interfaces are checked every 30 s and the record follows them. The phone never relies on a remembered IP address: it knows the PC by that
    fingerprint and looks it up on the network again whenever a connection fails, so a new
    address from the router is picked up by itself. There is no manual address entry. It accepts connections only from local
    addresses. **A firewall must allow port 48090/tcp and 5353/udp from the local network**; with ufw:
    `sudo ufw allow from 192.168.0.0/16 to any port 48090 proto tcp` and
    `sudo ufw allow from 192.168.0.0/16 to any port 5353 proto udp` (mDNS is how the phone finds
    the PC, so this one is required too).
  - Pairing: the phone shows a 6-digit code, the Texts page shows the same one, and it completes
    only when the user confirms on both (Codes match on the phone, Connect on the PC). The code
    covers both devices' certificates, so a device in the middle shows a different code.
  - Trust is mutual TLS with pinned certificates, as in Kainos Player: the phone has its own key
    in Android's key store, and each side accepts only the certificate it paired with. No shared
    secret exists. The PC keeps the phone's certificate fingerprint (`sms-sync/phone.json`).
    Protocol 2; a phone paired under protocol 1 (a secret) pairs again once.
  - The protocol is still version 4. An older phone build also sends mail and chats of other apps
    (`mail`, `mailRemoved`, and a `conversation` whose `source` is not `sms`); the PC reads and
    drops them without closing the connection. Only a conversation with no `source`, or `sms`,
    is kept.
  - Pictures (MMS from the SMS inbox, and pictures from chat notifications such as RCS) are
    fetched one at a time when the thread shows them (`getImage`) and cached in memory.
  - Texts are held in memory only. On each connection the PC's welcome lists a hash of every
    conversation it still holds, and the phone sends only the conversations that changed or
    are missing.
  - Replies go back to the phone. With the texts permission, a reply in an SMS conversation is
    sent as an SMS by the phone itself. An RCS chat that exists only as a notification is
    answered through that notification while it is still on the phone, and as an SMS to the
    chat's number once it is gone.
  - The Texts page (`src/renderer/inbox.ts`) is a local page with its own preload; its title
    carries the unread count to the dock like the websites' titles do.
- **Unread counts** come from the page title ("(3) …", "(99+) …", "• …"). Proton's title only
  counts the open folder, so for Proton the preload reads the Inbox counter in the page's
  sidebar and falls back to the title when that element is missing. The selector comes from
  Ferdium's Proton recipe and has not been checked against a signed-in page yet.
- **Popups.** Only captcha and sign-in hosts (`popupHosts`) open in a popup, which shares the
  service's login and shows its host in the title. A popup that heads anywhere else closes,
  and the page opens in the system browser. Blank popups are refused. Discord's account
  connections (linking GitHub and so on) therefore open in the browser.
- **Permissions.** A service's own pages may show notifications, use the microphone and camera,
  copy to the clipboard, go fullscreen (the page then covers the whole window) and keep their
  storage from being evicted. Streamroom, a call app, may also share the screen and choose the
  speaker. Reading the clipboard, screen capture for every other service, location and everything
  else are denied, and no client certificate is ever sent.
- **Sign out** stops the page and closes its popups, then clears the service's cookies,
  storage and cache, then reloads it. A page's "leave site?" prompt never blocks Reload or
  Sign out.
- **Saved state** lives in `kainos-state.json` in Electron's userData folder: window bounds,
  maximised, last active service, muted services, whether the dock is always shown, the theme,
  the dock's service order and hidden services, the hibernating services, each website's
  **In the background** choice, Streamroom's
  server, added addresses and this PC's port, the apps switched on, and whether they have been
  chosen.
- **Close** hides the window to the tray when a tray is running. On Linux that means a
  StatusNotifierItem host such as a panel or waybar; with none (common on Wayland compositors),
  closing quits.
- **Shortcuts** work from the dock or inside a page:
  - Ctrl+1..9 (Cmd on macOS) open the tab in that place in the dock, as you have arranged it
    (hidden services are skipped). The digit is the physical key, so it works on AZERTY without
    Shift.
  - Ctrl+Q (Cmd+Q) quits.
  - F5 or Ctrl+R (Cmd+R) reloads the open service, which picks up a new version of the site
    (Streamroom after a deploy or a restart of its local server). Shift+F5, Ctrl+F5 or Ctrl+Shift+R fetch every file again,
    past the cache.
  - F6 moves keyboard focus from the page to its tab in the dock (bringing a hidden dock up), and
    back. Left and right arrows move between the tabs, Alt+Left and Alt+Right move the focused
    tab (its new place is announced to screen readers); Escape goes back to the page.
  - On a dock tab, the Menu key or Shift+F10 opens the service menu (Reload or Wake, Hibernate,
    In the background, Mute, Server for Streamroom, Move left, Move right, Hide from dock, Sign out) at the tab.

## After you sign in

- **Discord:** if Discord messages raise no notifications, open Discord's User Settings >
  Notifications and turn on **Enable Desktop Notifications**. Discord's web client may leave
  it off in an app like this one.

### Additional Texts contrast checks

`pnpm test` checks every theme's token pairs against WCAG 2 (`src/renderer/tokens.test.ts`),
including these, which no rendered page shows at rest. Hover uses a 50% sRGB mix of surface and
rail. The lightbox backdrop is each theme's `--scrim`; its fallback text is white. The backdrop
result uses a white underlay, the worst case even with arbitrary image content. Close has its own
opaque surface background. `pnpm smoke` then measures every visible text and icon on the dock and
the Texts page in each theme and fails under 4.5:1 for text, 3:1 for large text and icons.

| Text/background | Switchboard | Daylight | Bakelite | Carbon | Aubergine |
|---|---:|---:|---:|---:|---:|
| Primary text / hovered row or notice | 14.28:1 | 15.69:1 | 14.64:1 | 18.05:1 | 14.09:1 |
| Secondary text / hovered row or notice | 7.18:1 | 6.90:1 | 7.54:1 | 9.16:1 | 7.65:1 |
| Disabled Send / raised (WCAG exempt) | 6.15:1 | 6.22:1 | 6.58:1 | 7.69:1 | 6.24:1 |
| Lightbox fallback text / scrim (worst case) | 14.37:1 | 14.51:1 | 14.51:1 | 15.58:1 | 14.09:1 |
| Lightbox Close / surface | 14.97:1 | 16.60:1 | 15.17:1 | 19.09:1 | 14.73:1 |
