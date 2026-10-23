// Ownership follows routed traffic, not build timestamps or container restarts.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../apps/server/', import.meta.url)),
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['ws', '@cloudbase/node-sdk'],
  outfile: 'dist/index.mjs',
  logLevel: 'info',
});
