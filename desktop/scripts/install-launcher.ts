// Adds Kainos Talk to the desktop's app launcher for this user: a .desktop entry that runs
// bin/kainos-talk from this checkout, and the app icon. Run again after moving the checkout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markPng } from '../src/main/app-icon.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const data = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');

for (const size of [64, 128, 256, 512]) {
  const dir = join(data, 'icons', 'hicolor', `${size}x${size}`, 'apps');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kainos-talk.png'), markPng(size, false));
}

const launcher = join(desktop, 'bin', 'kainos-talk');
const entry = `[Desktop Entry]
Type=Application
Name=Kainos Talk
GenericName=Messaging hub
Comment=Proton Mail, Discord, WhatsApp, Messenger and your phone's texts in one window
Exec="${launcher.replaceAll('"', '\\"')}" %U
Icon=kainos-talk
Terminal=false
Categories=Network;Chat;InstantMessaging;
StartupWMClass=kainos-talk
StartupNotify=true
`;
const applications = join(data, 'applications');
mkdirSync(applications, { recursive: true });
const file = join(applications, 'kainos-talk.desktop');
writeFileSync(file, entry);
try {
  execFileSync('update-desktop-database', [applications], { stdio: 'ignore' });
} catch {
  // Not installed everywhere; launchers that watch the folder pick the entry up anyway.
}
console.log(`installed ${file}`);
