import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runWeiboImageDownload } from './image-download.js';
import './image-download.js';

describe('weibo image-download', () => {
  it('downloads every original image exposed by the status payload', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-weibo-images-'));
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ session: 'x', data: { id: '1', mblogid: 'A', urls: ['https://img.example/a.jpg', 'https://img.example/b.png'] } }) };
    const fetch = vi.fn().mockImplementation(async (url) => ({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer, headers: { get: () => url.endsWith('.png') ? 'image/png' : 'image/jpeg' } }));
    const rows = await runWeiboImageDownload(page, { id: 'A', output }, { fetch });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ index: 1, bytes: 3, contentType: 'image/jpeg' });
    expect(rows[1]).toMatchObject({ index: 2, contentType: 'image/png' });
    await fs.rm(output, { recursive: true, force: true });
  });
});
