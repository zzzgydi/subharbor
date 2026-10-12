import { build } from 'esbuild';
await build({
  entryPoints: ['apps/server/src/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['packages/script/src/worker.ts'],
  outfile: 'dist/script-worker.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
