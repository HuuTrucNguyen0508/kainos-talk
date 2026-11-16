// Bundles the main process, both preloads and the sidebar UI into dist/.
import { build, type BuildOptions } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;

const node: BuildOptions = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  // dbus-next requires these only when present (X11 session bus lookup, abstract sockets).
  external: ['electron', 'x11', 'usocket'],
  sourcemap: 'linked',
  logLevel: 'warning',
};

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/renderer`, { recursive: true });

await Promise.all([
  build({ ...node, entryPoints: [`${root}src/main/index.ts`], outfile: `${dist}/main.cjs` }),
  // Sandboxed preloads may only require('electron'), so everything else is bundled in.
  build({ ...node, platform: 'browser', entryPoints: [`${root}src/preload/app.ts`], outfile: `${dist}/preload-app.cjs` }),
  build({ ...node, platform: 'browser', entryPoints: [`${root}src/preload/service.ts`], outfile: `${dist}/preload-service.cjs` }),
  build({ ...node, platform: 'browser', entryPoints: [`${root}src/preload/inbox.ts`], outfile: `${dist}/preload-inbox.cjs` }),
  build({ ...node, platform: 'browser', entryPoints: [`${root}src/preload/server.ts`], outfile: `${dist}/preload-server.cjs` }),
  build({
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome140',
    entryPoints: [`${root}src/renderer/main.ts`, `${root}src/renderer/inbox.ts`, `${root}src/renderer/server.ts`],
    outdir: `${dist}/renderer`,
    loader: { '.woff2': 'file', '.woff': 'file' },
    assetNames: 'fonts/[name]-[hash]',
    sourcemap: 'linked',
    logLevel: 'warning',
  }),
  copyFile(`${root}src/renderer/index.html`, `${dist}/renderer/index.html`),
  copyFile(`${root}src/renderer/inbox.html`, `${dist}/renderer/inbox.html`),
  copyFile(`${root}src/renderer/server.html`, `${dist}/renderer/server.html`),
]);

console.log('built desktop/dist');
