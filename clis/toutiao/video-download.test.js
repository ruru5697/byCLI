import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getRegistry } from '@sovovs/bycli/registry';
import { runToutiaoVideoDownload } from './video-download.js';
import './video-download.js';

describe('toutiao video download', () => {
    it('registers a browser download command', () => {
        expect(getRegistry().get('toutiao/video-download')?.browser).toBe(true);
    });

    it('downloads the playable source and reports bytes', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ title: '测试视频', src: 'data:video/mp4;base64,AAAA' }) };
        const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toutiao-video-'));
        const result = await runToutiaoVideoDownload(page, { video: '1'.repeat(9), output: outputDir });
        expect(result[0]).toMatchObject({ title: '测试视频', bytes: 3 });
        await fs.rm(outputDir, { recursive: true, force: true });
    });
});
