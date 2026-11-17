# Kainos Talk

One app for Proton Mail, Discord, WhatsApp, Messenger and Streamroom, with your phone's texts (SMS and RCS) on the PC.

- `desktop/`: the PC app (Electron). Each website runs in its own view inside one window, with a dock that slides up from the bottom to switch between them, and a Texts page shows the phone's texts.
- `android/`: the phone app (Kotlin, Gradle). It is an SMS bridge: it sends the phone's texts (SMS and RCS from the messages app) to the PC's Texts page over the local network, and sends the replies you write there. See [docs/sms-sync-plan.md](docs/sms-sync-plan.md).
- `protocol/`: test vectors for the phone-to-PC SMS sync, checked by both apps' tests.

## Install

Download both apps from the [latest release](https://github.com/HuuTrucNguyen0508/kainos-talk/releases/latest):

- **PC (Linux, x86-64):** `Kainos-Talk-<version>-x86_64.AppImage`. Make it executable
  (`chmod +x Kainos-Talk-*.AppImage`) and run it.
- **PC (Windows 10 or 11, x64):** `Kainos-Talk-<version>-Setup.exe` installs it;
  `Kainos-Talk-<version>-portable.exe` runs without installing. Both are unsigned: when
  SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**. Allow
  Kainos Talk on private networks when Windows Firewall asks, so the phone can connect.
- **Phone (Android 13 or newer):** `Kainos-Talk-<version>.apk`. Open it on the phone and allow
  installing from that source. Then pair it with the PC from the Texts page.

On first launch the PC app asks which apps you want; change them any time with **Choose apps…**
in the Kainos mark's menu on the dock.

The PC and the phone find each other on the local network; on Linux the PC's firewall must allow
48090/tcp and 5353/udp from it (see [desktop/README.md](desktop/README.md)).

The Streamroom tab opens a [Streamroom](https://github.com/HuuTrucNguyen0508/streamroom) server you
choose under **Server** in its tab's menu. Kainos runs none itself:

- **On this PC:** follow Streamroom's
  [Run Streamroom on your own computer](https://github.com/HuuTrucNguyen0508/streamroom/blob/main/docs/local.md)
  (`pnpm build && pnpm start`, port 8080 by default), then pick **This PC**. If it uses another
  port, set it with **Change this PC's port…**.
- **Your own deployment:** deploy Streamroom to Cloudflare with its
  [Cloudflare guide](https://github.com/HuuTrucNguyen0508/streamroom/blob/main/docs/cloudflare.md),
  then add its address with **Add an address…**.

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

## Release builds

```sh
pnpm --filter desktop package          # desktop/release/Kainos-Talk-<version>-x86_64.AppImage
pnpm --filter desktop package:win      # desktop/release/Kainos-Talk-<version>-Setup.exe and -portable.exe (Wine on Linux)
cd android && ./gradlew assembleRelease # android/app/build/outputs/apk/release/app-release.apk
```

The Android build needs JDK 17 and the Android SDK. A release APK is signed only when
`android/signing.properties` (git-ignored) or `KAINOS_SIGNING_*` environment variables give
`storeFile`, `storePassword`, `keyAlias` and `keyPassword`; without them it is unsigned, and with
only some of them the build stops. `KAINOS_SMOKE_APP=desktop/release/linux-unpacked/kainos-talk
node desktop/test/smoke.ts` runs the desktop smoke test against the packaged app. The **Windows
build** workflow (GitHub Actions, run by hand) builds the Windows files on Windows, runs the desktop
unit tests there and checks the packaged app starts; its artifact holds the `.exe` files.

## Licence

MIT. See [LICENSE](LICENSE).
