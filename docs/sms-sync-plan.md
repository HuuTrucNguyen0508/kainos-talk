# Plan: SMS from the phone to the PC

Status: built on 2026-11-14. Changes from the first plan: pairing compares a 6-digit code (confirmed on both screens) instead of scanning a QR code; trust is mutual TLS with a key in Android's key store instead of a shared secret; the phone also reads the SMS/MMS inbox (history, pictures, sending) when the user allows it. Chosen on 2026-11-14 after Google started refusing its sign-in inside
Kainos ("This browser or app may not be secure"), which leaves Google Messages for web unusable in
the SMS tab. Google Messages also no longer offers QR pairing.

## What the user gets

- The PC's SMS tab shows the phone's texts (SMS and RCS) in a Kainos view: conversation list,
  thread, reply box, unread badge and desktop notifications. No Google account.
- Replies typed on the PC go to the phone, which sends them through the SMS app's own reply
  button on its notification.
- It works while the phone and the PC are on the same network. Nothing goes through a server.

Limits carried over from the phone app: only texts that arrive after the phone app is installed,
and a reply works only while that conversation's notification is still on the phone. A later
step can send texts directly (`SEND_SMS`) to lift the second limit.

## Shape

```
 Phone (Kainos Android)                         PC (Kainos desktop)
 NotificationListener ─▶ Room store             SMS view (sidebar page, native UI)
          │                                               ▲
          ▼                                               │ IPC
   SyncClient ── WebSocket over TLS, LAN only ──▶ SyncServer (main process)
   (reconnects, pinned certificate)                (listens while the app runs)
```

- **The PC is the server, the phone the client.** The notification listener already lives as long
  as Android lets it, so it keeps one connection open and reconnects with backoff.
- **Pairing by QR code.** The PC's SMS tab shows a QR code: `kainos-pair:` with the PC's LAN
  addresses, port, its TLS certificate's SHA-256 fingerprint and a one-time token valid for five
  minutes. The phone scans it (CameraX and the ZXing core library, no Google Play Services),
  connects with that certificate pinned, and trades the token for a long-term device secret. The
  phone keeps the secret in the Android Keystore; the PC keeps it hashed in its userData folder.
- **Finding the PC later.** mDNS service `_kainos-talk._tcp` (Android `NsdManager`, desktop
  `multicast-dns`), falling back to the last address that worked.
- **LAN only.** The phone connects only to private addresses (RFC 1918, link-local, IPv6 ULA)
  and the PC drops connections from anywhere else. TLS 1.3 with the pinned self-signed
  certificate the PC generates once.
- **Tailscale (added 2026-11-24).** Tailscale's addresses (100.64.0.0/10, and
  fd7a:115c:a1e0::/48, already inside the IPv6 ULA range) count as local too, so texts, calls,
  clipboard and files keep working when the phone is away from the Wi-Fi. mDNS doesn't cross
  Tailscale, so the PC lists its own Tailscale addresses in the `welcome` (`tailnet`, at most 4;
  an older phone ignores the key, so `SYNC_VERSION` stays 6). The phone keeps the last ones it
  got and tries them after the Wi-Fi addresses, or first when no Wi-Fi or Ethernet is up, in
  which case it skips the 60 s wait for Wi-Fi. A session saves them only while its pairing is
  still the one on disk, so it can't undo Forget. The PC sends them only in the welcome: if
  Tailscale comes up on it mid-session, the phone learns them on its next reconnect. The PC doesn't announce its
  Tailscale address over mDNS and refuses `pair` from one (`denied`, reason `tailnet`):
  pairing stays on the Wi-Fi, so other people's devices on a shared tailnet can't ask to pair.
  Both devices must be on the same tailnet, and the phone must connect on the Wi-Fi once after
  updating so it learns the PC's addresses.
- **Protocol** (JSON frames, versioned): `hello` (device id, secret, protocol version) →
  `snapshot` (SMS conversations and their messages since a timestamp) → live `upsert` frames as
  texts arrive → `reply` from the PC with a request id → `replyResult` from the phone. `read`
  flows both ways so unread counts agree.

## Phone changes

- Manifest: `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `CAMERA`. The build
  guard that forbids network permissions changes to allow them, and a test checks the LAN-only
  address rule instead.
- `SyncClient`: connection, backoff, snapshot and upserts from the Room store's SMS rows, replies
  through `TalkHub.sendReply`.
- A "Connect to PC" screen (scan, status, forget the PC) in the Pocket Switchboard style.

## PC changes

- `SyncServer` in the main process (`ws` over `node:tls`, certificate via `selfsigned`), pairing
  tokens, device secrets.
- The SMS service stops being a web view: a native view in the sidebar page with conversation
  list, thread and reply, plus the pairing QR when no phone is paired. Unread and notifications
  go through the paths the other services use.
- The Google Messages tab and its Google hosts are removed.

## Proof

- Protocol: shared test vectors run by both the Kotlin and the TypeScript tests.
- Desktop: unit tests for pairing and the LAN rule, and the off-screen smoke test drives a fake
  phone client through pairing, a snapshot, a live text and a reply.
- Phone: unit tests for the client against a fake server, and an emulator run against the real
  desktop app on the same machine.

## Order

1. Protocol and test vectors.
2. PC server and pairing, with the fake phone in the smoke test.
3. Phone client and pairing screen.
4. PC SMS view (after a `/frontend-design` pass).
5. End-to-end run on the emulator, then a review of the whole diff.
