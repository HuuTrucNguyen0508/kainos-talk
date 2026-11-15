# Kainos Talk desktop

Electron shell that hosts Proton Mail, Discord, WhatsApp, Messenger and SMS (Google Messages for
web) in one window. A narrow bar on the left or right switches between them; each service runs in
its own `WebContentsView` with its own persistent login (`persist:service-<id>`).

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
| `src/main/index.ts` | Window, tray, menus, shortcuts, saved state, sidebar IPC, bar auto-hide. |
| `src/main/bar.ts` | Bar side and layout rules: outer screen edge, docked strip or overlay. |
| `src/main/screen-side.ts` | Watches which screen the window is on (Hyprland socket, else Electron's bounds). |
| `src/main/hyprland.ts` | Reads Hyprland's `clients` and `monitors` JSON. |
| `src/renderer/inbox.ts` | The Inbox page: every conversation and mail from the phone, the source board, threads, mail actions. |
| `src/main/sms-sync.ts` | SMS sync server: TLS, pairing, the phone's texts, replies. Protocol in `src/shared/sync-protocol.ts`. |
| `src/main/mdns.ts` | Announces the sync server: Avahi over D-Bus, or an in-app responder; LAN interfaces only. |
| `test/fake-phone.ts` | A protocol-speaking stand-in for the phone, used by the unit and smoke tests. |
| `src/main/service-runtime.ts` | One service view: session, user agent, permissions, navigation rules, load status. |
| `src/main/navigation.ts` | Which links stay in a service, open as a popup, or go to the system browser. |
| `src/main/permissions.ts` | Notifications and mic/camera for the service's own origin; everything else denied. |
| `src/main/notifications.ts` | Turns page notifications into native ones; mute and click-to-focus. |
| `src/preload/app.ts` | The sidebar's only API, `window.kainos`. |
| `src/preload/service.ts` | Routes each page's `Notification` calls through the app (see below). |
| `src/main/vencord.ts` | Downloads, updates and loads the Vencord extension into Discord's session. |
| `src/renderer/` | The sidebar page (bar plus the loading and failed notices), a transparent view above the services: plain TypeScript and CSS, no framework. |

## Behaviour notes

- **Browser identity.** Every service sees stock Chrome's user agent for this platform
  (`Chrome/<major>.0.0.0`, no Electron token). WhatsApp Web refuses anything else.
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
- **Inbox and sleeping websites** (`docs/pc-inbox-plan.md`). The Inbox, first in the bar, shows
  everything the paired phone gathers (texts, WhatsApp, Discord, Messenger, Proton Mail) and
  raises the desktop notifications for all of them. The websites load only when opened (except
  the one open at quit) and sleep 15 minutes after they leave the screen, which frees their
  memory (an asleep page is about:blank). Right-click a website for "Keep running in the
  background" or "Sleep now". While asleep, its badge shows what the Inbox has unread for it.
  While the phone is connected, the websites' own notifications are dropped, since the Inbox
  already sends them, and the window title counts the Inbox only.
- **The bar.** Click the Kainos mark at the top of the bar (or right-click the bar's empty space)
  for its options:
  - **Hide the bar until the pointer reaches it.** The page then takes the whole window. Push the
    pointer against the bar's edge of the window (or leave the window across that edge) and the
    bar slides out over the page without resizing it; it hides again once the pointer leaves it.
    F6 brings it out too, with focus on the active service. A teal line marks its inner edge.
  - **Side.** "Outer edge" (the default) puts the bar on the edge of the screen that has no other
    screen beside it, so the pointer stops there: left on a screen with a neighbour to its right,
    right on a screen with a neighbour to its left, left on a lone screen. It follows the window
    when it moves to another screen. "Always left" and "Always right" fix it.
  - Wayland never tells a window where it is. On Hyprland the app asks Hyprland's own socket
    which monitor the window is on; on other Wayland compositors "Outer edge" stays on the left,
    so pick a side by hand there. X11, Windows and macOS use the window's bounds.
- **Messenger** opens `www.messenger.com`. Sign-in and security checks may pass through
  `www.facebook.com`, which stays inside the view.
- **SMS** is not a website. Google refuses its sign-in inside Kainos ("This browser or app may not
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
  - Pairing: the phone shows a 6-digit code, the SMS tab shows the same one, and it completes
    only when the user confirms on both (Codes match on the phone, Connect on the PC). The code
    covers both devices' certificates, so a device in the middle shows a different code.
  - Trust is mutual TLS with pinned certificates, as in Kainos Player: the phone has its own key
    in Android's key store, and each side accepts only the certificate it paired with. No shared
    secret exists. The PC keeps the phone's certificate fingerprint (`sms-sync/phone.json`).
    Protocol 2; a phone paired under protocol 1 (a secret) pairs again once.
  - Pictures (MMS from the SMS inbox, and pictures from chat notifications such as RCS) are
    fetched one at a time when the thread shows them (`getImage`) and cached in memory.
  - Texts are held in memory only; the phone sends them again on each connection. Replies go
    back to the phone, which sends them through the SMS app's notification, so a reply works
    only while that notification is still on the phone.
  - The SMS view (`src/renderer/sms.ts`) is a local page with its own preload; its title carries
    the unread count to the sidebar like the websites' titles do.
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
  storage from being evicted. Reading the clipboard, screen capture, location and everything
  else are denied, and no client certificate is ever sent.
- **Sign out** stops the page and closes its popups, then clears the service's cookies,
  storage and cache, then reloads it. A page's "leave site?" prompt never blocks Reload or
  Sign out.
- **Saved state** lives in `kainos-state.json` in Electron's userData folder: window bounds,
  maximised, last active service, muted services, bar side and auto-hide.
- **Close** hides the window to the tray when a tray is running. On Linux that means a
  StatusNotifierItem host such as a panel or waybar; with none (common on Wayland compositors),
  closing quits.
- **Shortcuts** work from the sidebar or inside a page:
  - Ctrl+1..5 (Cmd on macOS) switch service. The digit is the physical key, so it works on
    AZERTY without Shift.
  - Ctrl+Q (Cmd+Q) quits.
  - F6 moves keyboard focus from the page to its button in the sidebar, and back.
  - On a sidebar button, the Menu key or Shift+F10 opens the service menu (Reload, Mute,
    Sign out) beside the button.

## After you sign in

- **Discord:** if Discord messages raise no notifications, open Discord's User Settings >
  Notifications and turn on **Enable Desktop Notifications**. Discord's web client may leave
  it off in an app like this one.
