import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['ws', 'proper-lockfile'],
  minifySyntax: true,
  treeShaking: true,
});

await copyFile('../pricing/catalog.json', 'pricing-catalog.json');
