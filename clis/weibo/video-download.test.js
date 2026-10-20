import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EmptyResultError } from '@sovovs/bycli/errors';
import { runWeiboVideoDownload } from './video-download.js';

describe('weibo video-download', () => {
    it('downloads the media URL exposed by the status payload', async () => {
        const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-weibo-'));
        const page = {
            goto: vi.fn(),
            wait: vi.fn(),
            evaluate: vi.fn().mockResolvedValue({
                session: 'site:weibo:test',
                data: {
                    title: '测试视频',
                    sourceUrl: 'https://weibo.com/42/AbC12',
                    mediaUrl: 'https://video.example.test/a.mp4',
                },
            }),
        };
        const fetch = vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
            headers: { get: () => 'video/mp4' },
        });

        const rows = await runWeiboVideoDownload(page, { id: 'https://weibo.com/42/AbC12', output }, { fetch });
        expect(rows[0]).toMatchObject({ mblogid: 'AbC12', bytes: 3, contentType: 'video/mp4' });
        await expect(fs.stat(rows[0].path)).resolves.toMatchObject({ size: 3 });
        expect(fetch).toHaveBeenCalledWith('https://video.example.test/a.mp4', expect.objectContaining({ headers: expect.any(Object) }));
        await fs.rm(output, { recursive: true, force: true });
    });

    it('fails when the post does not expose a playable video', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ missing: true }) };
        await expect(runWeiboVideoDownload(page, { id: '123' }, { fetch: vi.fn() })).rejects.toBeInstanceOf(EmptyResultError);
    });
});
