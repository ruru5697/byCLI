import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { runToutiaoArticleStats } from './article-stats.js';
import { runToutiaoVideoStats } from './video-stats.js';

describe('Toutiao statistics public output contract', () => {
  it.each([
    ['article-stats', runToutiaoArticleStats, { article: 'article title' }],
    ['video-stats', runToutiaoVideoStats, { video: 'video title' }],
  ])('%s declares every emitted field', async (name, collect, args) => {
    const row = { found: true, title: 'title', status: '已发布', impressions: '0', views: '2', likes: '0', comments: '0', text: 'title' };
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue(row) };
    const [result] = await collect(page, args);
    expect(Object.keys(result).filter(key => !getRegistry().get(`toutiao/${name}`).columns.includes(key))).toEqual([]);
    expect(result).toMatchObject({ found: true, impressions: '0', views: '2' });
  });
});
