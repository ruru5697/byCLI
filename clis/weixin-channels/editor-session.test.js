import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const created = vi.hoisted(() => []);
vi.mock('@sovovs/bycli/browser/page', () => ({ Page: class { constructor(...args) { created.push(args); } } }));
import { editorSessionPage } from './_shared/editor-session.js';
let dir, file;
beforeEach(async () => { created.length = 0; dir = await mkdtemp(join(tmpdir(), 'bycli-editor-session-')); file = join(dir, 'op.json');
  await writeFile(file, JSON.stringify({ version: 1, operation_id: 'local-op', description: 'fixture', ai_generated: 'yes', submitted: false,
    status: 'preparation_unknown', created_at: new Date().toISOString(), editor_session: 'bound-editor' })); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
// Synthetic lease-routing contract; real ownership remains enforced by Bridge.
it('routes recovered publish commands through the explicitly bound browser lease', async () => {
  const original = { contextId: 'profile-a' };
  expect(await editorSessionPage(original, { operation: file, mode: 'submit' })).not.toBe(original);
  expect(created).toEqual([['bound-editor', undefined, 'profile-a', undefined, 'browser']]);
});
it('keeps local status browser-free and remote reconciliation on its separate adapter page', async () => {
  expect(await editorSessionPage(null, { operation: file }, true)).toBeNull();
  const separate = { contextId: 'profile-a' };
  expect(await editorSessionPage(separate, { operation: file, 'management-id': 'export/test' }, true)).toBe(separate);
  expect(created).toEqual([]);
});

it.each([false, true])('resumes a saved draft on the owned adapter lease instead of its old borrowed session (saved covers: %s)', async covers => {
  const op = JSON.parse(await readFile(file, 'utf8'));
  op.source_draft_id = 'export/saved'; op.status = 'prepared';
  if (covers) op.cover = { saved: true, phase: 'configured', sources: { horizontal: { path: '/fixture.png', sha256: 'a'.repeat(64) } } };
  await writeFile(file, JSON.stringify(op));
  const owned = { contextId: 'profile-a' };
  expect(await editorSessionPage(owned, { operation: file, mode: 'resume' })).toBe(owned);
  expect(created).toEqual([]);
  expect(await editorSessionPage(owned, { operation: file, mode: 'submit' })).not.toBe(owned);
});
