import { describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import './comments.js';
import './favorites.js';
import './feed.js';
import './hot.js';
import './me.js';
import './post.js';
import './search.js';
import './user.js';

function envelope(data) {
  return { session: 'site:weibo:test', data };
}

function makePage(evaluateResults = []) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script) => {
      if (String(script).includes('window.scrollBy')) return undefined;
      return queue.length ? queue.shift() : undefined;
    }),
  };
}

describe('weibo read adapters Browser Bridge envelopes', () => {
  it('follows comment cursors without duplicating comment ids', async () => {
    const page = makePage([
      envelope({ items: [{ comment_id: 'c1', author: 'a', text: 'one' }], next_cursor: 'next-1', has_more: true }),
      envelope({ items: [{ comment_id: 'c1', author: 'a', text: 'one' }, { comment_id: 'c2', author: 'b', text: 'two' }], next_cursor: '', has_more: false }),
    ]);
    const rows = await getRegistry().get('weibo/comments').func(page, { id: 'https://weibo.com/42/AbC12', limit: 2, sort: 'time' });
    expect(rows.map((row) => row.comment_id)).toEqual(['c1', 'c2']);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.evaluate.mock.calls[1][0]).toContain('next-1');
  });

  it('unwraps comments, feed, hot, search, and favorites array payloads', async () => {
    await expect(getRegistry().get('weibo/comments').func(
      makePage([envelope([{ rank: 1, author: 'a', text: 't', likes: 0, replies: 0, time: '' }])]),
      { id: '123', limit: 1 },
    )).resolves.toHaveLength(1);

    await expect(getRegistry().get('weibo/feed').func(
      makePage([envelope('123456'), envelope([{ id: 'm1', author: 'a', text: 't', reposts: 0, comments: 0, likes: 0, time: '', url: 'https://weibo.com/1/m1' }])]),
      { type: 'for-you', limit: 1 },
    )).resolves.toHaveLength(1);

    await expect(getRegistry().get('weibo/hot').func(
      makePage([envelope([{ rank: 1, word: 'bycli', hot_value: 1, category: '', label: '', url: 'https://s.weibo.com/weibo?q=bycli' }])]),
      { limit: 1 },
    )).resolves.toHaveLength(1);

    await expect(getRegistry().get('weibo/search').func(
      makePage([envelope([{ id: 'm1', title: 'byCLI', author: 'a', time: '', url: 'https://weibo.com/1/m1' }])]),
      { keyword: 'bycli', limit: 1 },
    )).resolves.toEqual([{ rank: 1, id: 'm1', title: 'byCLI', author: 'a', time: '', url: 'https://weibo.com/1/m1' }]);

    await expect(getRegistry().get('weibo/favorites').func(
      makePage([envelope('123456'), envelope([{ text: '作者A\n这是一条收藏微博', url: 'https://weibo.com/123/AbCd1' }])]),
      { limit: 1 },
    )).resolves.toHaveLength(1);
  });

  it('unwraps me, post, and user object payloads', async () => {
    await expect(getRegistry().get('weibo/me').func(
      makePage([envelope('123456'), envelope({ screen_name: 'me', uid: '123456' })]),
      {},
    )).resolves.toMatchObject({ screen_name: 'me', uid: '123456' });

    await expect(getRegistry().get('weibo/post').func(
      makePage([envelope({ id: '1', text: 'post' })]),
      { id: '1' },
    )).resolves.toContainEqual({ field: 'text', value: 'post' });

    await expect(getRegistry().get('weibo/user').func(
      makePage([envelope({ screen_name: 'alice', uid: '42' })]),
      { id: '42' },
    )).resolves.toMatchObject({ screen_name: 'alice', uid: '42' });
  });

  it('fails typed instead of returning empty rows for malformed post-unwrap payloads', async () => {
    await expect(getRegistry().get('weibo/hot').func(
      makePage([envelope({ error: 'API error' })]),
      { limit: 1 },
    )).rejects.toBeInstanceOf(CommandExecutionError);

    await expect(getRegistry().get('weibo/user').func(
      makePage([envelope([{ screen_name: 'wrong shape' }])]),
      { id: '42' },
    )).rejects.toBeInstanceOf(CommandExecutionError);
  });
});
