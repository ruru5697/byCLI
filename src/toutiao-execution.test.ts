import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCommand } from './execution.js';
import { getRegistry } from './registry-api.js';
import '../clis/toutiao/hot.js';
import '../clis/toutiao/search.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Toutiao public command execution', () => {
  it('passes hot-board arguments through the non-browser execution path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({data: [
      {ClusterIdStr: '1', Title: 'kept'}, {ClusterIdStr: '2', Title: ''},
      {ClusterIdStr: '3', Title: 'also kept'}, {ClusterIdStr: '4', Title: 'over-limit'},
    ]}), {status: 200})));
    const rows = await executeCommand(getRegistry().get('toutiao/hot')!, {limit: 2}) as Array<{title: string; rank: number}>;
    expect(rows.map(row => row.title)).toEqual(['kept', 'also kept']);
    expect(rows.map(row => row.rank)).toEqual([1, 2]);
  });

  it('passes query, type and limit through the non-browser execution path', async () => {
    const html = `<script type="application/json">${JSON.stringify({data: {
      title: '搜索结果', article_url: '/article/1', media_name: '来源', digg_count: 5,
    }})}</script>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(html, {status: 200}));
    vi.stubGlobal('fetch', fetchMock);
    const rows = await executeCommand(getRegistry().get('toutiao/search')!, {query: '人工 智能', type: 'video', limit: 5}) as Array<{title: string; like_count: number}>;
    const requested = new URL(fetchMock.mock.calls[0][0]);
    expect(requested.origin + requested.pathname).toBe('https://www.toutiao.com/search/');
    expect(requested.searchParams.get('keyword')).toBe('人工 智能');
    expect(requested.searchParams.get('pd')).toBe('video');
    expect(rows[0]).toMatchObject({title: '搜索结果', like_count: 5});
  });
});
