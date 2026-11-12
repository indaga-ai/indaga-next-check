// Bundles the page script (web/app.mjs and the shared src/ modules) into web/dist/app.js.
import { build } from 'esbuild';

await build({
  entryPoints: ['web/app.mjs'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: true,
  outfile: 'web/dist/app.js',
  logLevel: 'warning',
});
console.log('built web/dist/app.js');
