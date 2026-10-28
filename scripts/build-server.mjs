import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../apps/server/', import.meta.url)),
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['ws'],
  outfile: 'dist/index.mjs',
  logLevel: 'info',
});
