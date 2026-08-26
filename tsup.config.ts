import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  // Keep `node:` builtin specifiers verbatim. tsup strips the `node:` prefix
  // by default (`removeNodeProtocol`), which turns `node:sqlite` into bare
  // `sqlite` — not resolvable in Node ESM.
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
  dts: true,
  outDir: 'dist',
  assets: ['src/classifier/classifier-prompt.mustache'],
});
