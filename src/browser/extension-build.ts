import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findPackageRoot } from '../package-paths.js';

export function installedExtensionBuild(root = findPackageRoot(fileURLToPath(import.meta.url))): {
  directory: string; version?: string; buildId?: string; valid: boolean;
} {
  const directory = join(root, 'extension');
  let version: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    version = manifest.version;
    const info = JSON.parse(readFileSync(join(directory, 'dist/build-info.json'), 'utf8'));
    const digest = createHash('sha256').update(readFileSync(join(directory, 'dist/background.js'))).digest('hex');
    return { directory, version, buildId: info.buildId,
      valid: /^[a-f0-9]{64}$/.test(info.buildId) && info.version === manifest.version && info.scriptSha256 === digest };
  } catch {
    return { directory, version, valid: false };
  }
}
