import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const compatRange: string = pkg.bycli?.compatRange ?? '>=0.0.0';
const buildPlaceholder = 'BYCLI_RUNTIME_BUILD_' + '0'.repeat(64);

export default defineConfig({
  define: {
    __BYCLI_COMPAT_RANGE__: JSON.stringify(compatRange),
    __BYCLI_BUILD_ID__: JSON.stringify(buildPlaceholder),
  },
  plugins: [{
    name: 'bycli-runtime-build',
    generateBundle(_options, bundle) {
      const background = bundle['background.js'];
      if (!background || background.type !== 'chunk' || !background.code.includes(buildPlaceholder)) {
        throw new Error('Missing runtime build placeholder');
      }
      const buildId = createHash('sha256').update(background.code).digest('hex');
      background.code = background.code.replaceAll(buildPlaceholder, buildId);
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({
        version: pkg.version, buildId,
        scriptSha256: createHash('sha256').update(background.code).digest('hex'),
      }, null, 2) });
    },
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/background.ts'),
      output: {
        entryFileNames: 'background.js',
        format: 'es',
      },
    },
    target: 'esnext',
    minify: false,
  },
});
