import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const result = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['./src/index.ts'],
  tsconfig: './tsconfig.json',
  bundle: true,
  platform: 'browser',
  conditions: ['worker', 'browser'],
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
  metafile: true,
});
const nodeOnly = Object.keys(result.metafile.inputs).filter(name => /[/\\](?:ws[/\\]|(?:hyparquet|hyparquet-writer)[/\\]src[/\\]node\.js)/.test(name));
if (nodeOnly.length) throw new Error(`Worker bundle includes Node-only code: ${nodeOnly.join(', ')}`);
const output = result.outputFiles[0].contents;
console.log(`Worker bundle: ${output.length.toLocaleString()} bytes; ${gzipSync(output).length.toLocaleString()} bytes gzip. No Node-only dependencies bundled.`);

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['./examples/worker.ts'],
  tsconfig: './tsconfig.json',
  bundle: true,
  platform: 'browser',
  conditions: ['worker', 'browser'],
  format: 'esm',
  target: 'es2022',
  write: false,
});
console.log('Worker example bundles successfully.');
