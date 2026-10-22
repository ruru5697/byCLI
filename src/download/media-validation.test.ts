import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateMp4File } from './media-validation.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function box(type: string, ...parts: Buffer[]): Buffer {
  const data = Buffer.concat(parts); const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8); header.write(type, 4); return Buffer.concat([header, data]);
}
function container(handler = 'vide'): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom0000')),
    box('mdat', Buffer.from('synthetic payload')),
    box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(handler))))),
  ]);
}
async function save(data: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bycli-mp4-validation-')); dirs.push(dir);
  const file = path.join(dir, 'video.mp4'); await writeFile(file, data); return file;
}
describe('native MP4 structural validation', () => {
  it('accepts a video container even when moov follows mdat', async () => {
    await expect(validateMp4File(await save(container()))).resolves.toBeUndefined();
  });
  it('rejects an audio-only container', async () => {
    await expect(validateMp4File(await save(container('soun')))).rejects.toThrow('no video track');
  });
  it('rejects a truncated box', async () => {
    await expect(validateMp4File(await save(container().subarray(0, -1)))).rejects.toThrow();
  });
  it('rejects an ftyp-only fake video', async () => {
    await expect(validateMp4File(await save(box('ftyp', Buffer.from('isom0000'))))).rejects.toThrow('complete MP4');
  });
  it('honors cancellation during validation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(validateMp4File(await save(container()), controller.signal)).rejects.toThrow();
  });
});
