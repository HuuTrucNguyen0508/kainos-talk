# Kainos Talk

One app for Proton Mail, Discord, WhatsApp and Messenger, with your phone's texts (SMS and RCS) on the PC.

- `desktop/`: the PC app (Electron). Each website runs in its own view inside one window, with a dock that slides up from the bottom to switch between them, and a Texts page shows the phone's texts.
- `android/`: the phone app (Kotlin, Gradle). It is an SMS bridge: it sends the phone's texts (SMS and RCS from the messages app) to the PC's Texts page over the local network, and sends the replies you write there. See [docs/sms-sync-plan.md](docs/sms-sync-plan.md).
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
