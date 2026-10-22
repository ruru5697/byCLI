import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { AuthRequiredError, EmptyResultError } from '@sovovs/bycli/errors';
import { runWeiboStats } from './stats.js';
import './stats.js';

describe('weibo stats commands', () => {
    it('registers all content-specific stats commands', () => {
        for (const name of ['short-stats', 'image-stats', 'video-stats', 'article-stats']) {
            const command = getRegistry().get(`weibo/${name}`);
            expect(command?.access).toBe('read');
            expect(command?.browser).toBe(true);
            expect(command?.columns).toContain('likes');
        }
    });

    it('maps stable engagement fields from the status endpoint', async () => {
        const page = {
            goto: vi.fn(), wait: vi.fn(),
            evaluate: vi.fn().mockResolvedValue({
                session: 'test',
                data: {
                    id: '123', url: 'https://weibo.com/u/m', author: 'alice',
                    created_at: 'today', content_type: 'video', reposts: 2,
                    comments: 3, likes: 4, collects: 5, views: null,
                },
            }),
        };
        await expect(runWeiboStats(page, { id: '123' }, 'video')).resolves.toEqual([expect.objectContaining({ id: '123', likes: 4, content_type: 'video' })]);
        expect(page.goto).toHaveBeenCalledWith('https://weibo.com');
    });

    it('surfaces authentication and missing-post states', async () => {
        const authPage = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ auth: true }) };
        await expect(runWeiboStats(authPage, { id: '1' })).rejects.toBeInstanceOf(AuthRequiredError);
        const missingPage = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ missing: true }) };
        await expect(runWeiboStats(missingPage, { id: '1' })).rejects.toBeInstanceOf(EmptyResultError);
    });
});
