import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { Strategy } from '@sovovs/bycli/registry';
import { ArgumentError } from '@sovovs/bycli/errors';
import { runToutiaoArticlePublish } from './article-publish.js';
import './article-publish.js';

describe('toutiao article publish', () => {
    it('requires execute before any remote write', async () => {
        const page = { goto: vi.fn() };
        const result = await runToutiaoArticlePublish(page, { title: '测试文章', content: '正文内容' });
        expect(result[0]).toMatchObject({ status: 'dry-run', title: '测试文章' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('validates title and content', async () => {
        await expect(runToutiaoArticlePublish({}, { title: 'x', content: '正文' })).rejects.toBeInstanceOf(ArgumentError);
        await expect(runToutiaoArticlePublish({}, { title: '测试文章', content: '' })).rejects.toBeInstanceOf(ArgumentError);
    });

    it('registers a UI write command', () => {
        const command = getRegistry().get('toutiao/article-publish');
        expect(command?.access).toBe('write');
        expect(command?.strategy).toBe(Strategy.UI);
    });
});
