import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ejectAdapter } from './adapter-eject.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('vendors transitive shared imports without modifying another override baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eject-')); roots.push(root);
  const builtin = join(root, 'builtin'), user = join(root, 'user');
  mkdirSync(join(builtin, 'site/_shared'), { recursive: true }); mkdirSync(join(builtin, '_shared'));
  mkdirSync(join(user, '_shared'), { recursive: true });
  writeFileSync(join(user, '_shared/base.js'), 'existing local baseline');
  writeFileSync(join(builtin, '_shared/base.js'), 'export const n = 42;');
  writeFileSync(join(builtin, 'site/_shared/helper.js'), "export { n } from '../../_shared/base.js';");
  writeFileSync(join(builtin, 'site/main.js'), "export { n } from './_shared/helper.js';");
  writeFileSync(join(user, 'package.json'), '{"type":"module"}');
  ejectAdapter(builtin, user, 'site');
  expect((await import(join(user, 'site/main.js'))).n).toBe(42);
  expect(readFileSync(join(user, '_shared/base.js'), 'utf8')).toBe('existing local baseline');
  expect(() => ejectAdapter(builtin, user, '../bad')).toThrow('Invalid');
});
