// A release stamp is baked into the image, never regenerated when a container restarts.
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const release = `${String(Date.now()).padStart(13, '0')}-${randomUUID()}`;
await build({
  absWorkingDir: fileURLToPath(new URL('../apps/server/', import.meta.url)),
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['ws', '@cloudbase/node-sdk'],
  define: { __CHAT_RELEASE__: JSON.stringify(release) },
  outfile: 'dist/index.mjs',
  logLevel: 'info',
});
console.log(`Deployment release: ${release}`);
