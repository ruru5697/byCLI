import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getRegistry } from '@sovovs/bycli/registry';
import { ArgumentError } from '@sovovs/bycli/errors';
import { resolveToutiaoArticleUrl, renderToutiaoArticleMarkdown, runToutiaoArticleDownload } from './article-download.js';
import './article-download.js';

describe('toutiao article download', () => {
    it('normalizes article IDs and validates URLs', () => {
        expect(resolveToutiaoArticleUrl('123456789')).toBe('https://www.toutiao.com/article/123456789/');
        expect(resolveToutiaoArticleUrl('https://www.toutiao.com/article/123456789/?utm_source=x')).toContain('toutiao.com/article');
        expect(() => resolveToutiaoArticleUrl('https://example.com/a')).toThrow(ArgumentError);
    });

    it('renders stable markdown metadata', () => {
        expect(renderToutiaoArticleMarkdown({ title: '测试', url: 'https://www.toutiao.com/a', author: '作者', text: '正文' })).toContain('# 测试');
    });

    it('extracts and writes an article as JSON', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ title: '测试文章', text: '这是足够长的正文内容，用于验证下载流程。', author: '作者', published: '2026-10-19', url: 'https://www.toutiao.com/article/1/' }) };
        const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toutiao-download-'));
        const output = await runToutiaoArticleDownload(page, { article: '1'.repeat(9), output: outputDir, outputFormat: 'json' });
        expect(output[0]).toMatchObject({ title: '测试文章', format: 'json' });
        expect(page.goto).toHaveBeenCalled();
        await fs.rm(outputDir, { recursive: true, force: true });
    });

    it('registers the public browser command', () => {
        expect(getRegistry().get('toutiao/article-download')?.browser).toBe(true);
    });
});
