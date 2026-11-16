// Writes the app icon the Linux package uses (build/icon.png), drawn from the same mark as the
// window and tray icons.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markPng } from '../src/main/app-icon.ts';

const dir = fileURLToPath(new URL('../build/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}icon.png`, markPng(512, false));
console.log('wrote desktop/build/icon.png');
