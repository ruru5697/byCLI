import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { installedExtensionBuild } from './extension-build.js';

it('rejects a matching manifest with stale/tampered background bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'extension-build-'));
  try {
    const directory = join(root, 'extension'); mkdirSync(join(directory, 'dist'), { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{"version":"2.0.0"}');
    writeFileSync(join(directory, 'dist/background.js'), 'original');
    writeFileSync(join(directory, 'dist/build-info.json'), JSON.stringify({ version: '2.0.0', buildId: 'a'.repeat(64), scriptSha256: createHash('sha256').update('original').digest('hex') }));
    expect(installedExtensionBuild(root)).toMatchObject({ valid: true, buildId: 'a'.repeat(64) });
    writeFileSync(join(directory, 'dist/background.js'), 'stale');
    expect(installedExtensionBuild(root).valid).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('reports the bundled directory and manifest version even when legacy build metadata is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'extension-build-legacy-'));
  try {
    const directory = join(root, 'extension'); mkdirSync(directory);
    writeFileSync(join(directory, 'manifest.json'), '{"version":"2.1.25"}');
    expect(installedExtensionBuild(root)).toEqual({ directory, version: '2.1.25', valid: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
