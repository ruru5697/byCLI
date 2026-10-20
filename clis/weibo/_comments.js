import { CommandExecutionError } from '@sovovs/bycli/errors';
import { requireBoundedInteger } from '../_shared/search-adapter.js';
import { normalizeWeiboTarget, unwrapEvaluateResult } from './utils.js';

export const runWeiboComments = async (page, kwargs) => {
        const count = requireBoundedInteger(kwargs.limit, 20, 1, 100, '--limit');
        const target = normalizeWeiboTarget(kwargs.id);
        const lookup = target.id || target.mblogid;
        const sort = kwargs.sort === 'hot' ? 'hot' : 'time';
        const includeReplies = kwargs['include-replies'] === true || kwargs.includeReplies === true;
        await page.goto('https://weibo.com');
        await page.wait(2);

        const rows = [];
        const seenComments = new Set();
        const seenCursors = new Set();
        let cursor = String(kwargs.cursor || '');
        let nextCursor = null;
        let hasMore = false;

        while (rows.length < count) {
            if (seenCursors.has(cursor)) break;
            seenCursors.add(cursor);
            const payload = unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(lookup)};
        const count = ${count};
        const cursor = ${JSON.stringify(cursor)};
        const sort = ${JSON.stringify(sort)};
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
        const params = new URLSearchParams({ flow: '0', is_reload: '1', id, is_show_bulletin: '2', is_mix: '0', count: String(count), max_id_type: sort === 'hot' ? '1' : '0' });
        if (cursor) params.set('max_id', cursor);
        const resp = await fetch('/ajax/statuses/buildComments?' + params.toString(), {credentials: 'include'});
        if (resp.status === 401 || resp.status === 403) return { auth: true };
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const data = await resp.json();
        if (!data.ok) return { error: 'API error: ' + (data.msg || 'unknown') };
        const items = (data.data || []).map((c) => {
          const replies = (c.reply_comments || c.replies || (c.reply_comment ? [c.reply_comment] : [])).map((reply) => ({
            id: String(reply.idstr || reply.id || ''),
            author: reply.user?.screen_name || '',
            author_uid: String(reply.user?.idstr || reply.user?.id || ''),
            text: strip(reply.text || ''),
            time: reply.created_at || '',
          }));
          return {
            comment_id: String(c.idstr || c.id || ''),
            author: c.user?.screen_name || '',
            author_uid: String(c.user?.idstr || c.user?.id || ''),
            text: strip(c.text || ''),
            likes: Number(c.like_count ?? 0),
            reply_count: Number(c.total_number ?? replies.length ?? 0),
            replies: ${includeReplies} ? replies : undefined,
            time: c.created_at || '',
          };
        });
        return { items, next_cursor: String(data.max_id ?? data.next_cursor ?? ''), has_more: Boolean(data.max_id || data.has_more) };
      })()
    `));

            if (payload?.auth) throw new CommandExecutionError('Weibo login is required to read comments');
            if (payload?.error) throw new CommandExecutionError(`weibo comments: ${String(payload.error)}`);
            const items = Array.isArray(payload) ? payload : payload?.items;
            if (!Array.isArray(items)) throw new CommandExecutionError('weibo comments returned malformed extraction payload');
            for (const item of items) {
                if (!item || (item.comment_id && seenComments.has(item.comment_id))) continue;
                if (item.comment_id) seenComments.add(item.comment_id);
                rows.push({ rank: rows.length + 1, ...item });
                if (rows.length >= count) break;
            }
            if (Array.isArray(payload)) break;
            nextCursor = payload.next_cursor || null;
            hasMore = payload.has_more === true && Boolean(nextCursor);
            if (!hasMore || !nextCursor || nextCursor === cursor) break;
            cursor = nextCursor;
        }
        return rows.map((row) => ({ ...row, next_cursor: nextCursor, has_more: hasMore }));
    };
