# Kainos Talk

One app for Proton Mail, Discord, WhatsApp, Messenger and SMS.

- `desktop/`: the PC app (Electron). Each service runs in its own view inside one window, with a sidebar to switch between them.
- `android/`: the phone app (Kotlin, Gradle). It reads the notifications the real apps post; see [android/docs/notification-facts.md](android/docs/notification-facts.md). It also sends the phone's texts to the PC's SMS tab over the local network; see [docs/sms-sync-plan.md](docs/sms-sync-plan.md).
- `protocol/`: test vectors for the phone-to-PC SMS sync, checked by both apps' tests.

## Requirements

Node 26 and pnpm 12.

## Commands

```sh
pnpm install
pnpm build   # compile the desktop app
pnpm start   # build and launch the desktop app
pnpm test    # unit tests
```

See [desktop/README.md](desktop/README.md) for the desktop app's layout and the off-screen smoke test.
