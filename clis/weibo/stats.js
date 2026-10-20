/** Read stable engagement metrics for a Weibo post. */
import { cli, Strategy } from '@sovovs/bycli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { normalizeWeiboTarget, requireObjectEvaluateResult, unwrapEvaluateResult } from './utils.js';

export const WEIBO_STATS_COLUMNS = [
    'id', 'mblogid', 'url', 'author', 'author_uid', 'created_at', 'content_type',
    'requested_content_type',
    'reposts', 'comments', 'likes', 'collects', 'views', 'video_plays', 'visibility', 'observed_at',
];

export async function runWeiboStats(page, kwargs, contentType = 'short') {
    const target = normalizeWeiboTarget(kwargs?.id);
    const lookup = target.id || target.mblogid;
    await page.goto('https://weibo.com');
    await page.wait(2);
    const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(lookup)};
        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), {credentials: 'include'});
        if (resp.status === 403 || resp.status === 401) return { auth: true };
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const s = await resp.json();
        if (!s.ok && !s.idstr && !s.id) return { missing: true };
        const u = s.user || {};
        const pageInfo = s.page_info || {};
        const mediaInfo = pageInfo.media_info || {};
        const hasImages = Number(s.pic_num || Object.keys(s.pic_infos || {}).length || 0) > 0;
        const hasVideo = Boolean(mediaInfo.mp4_720p_mp4 || mediaInfo.mp4_hd_mp4 || mediaInfo.stream_url || pageInfo.type === 'video');
        const hasLongText = Boolean(s.isLongText || s.is_long_text || pageInfo.object_type === 'article');
        // page_info.type is also reported as "article" by some ordinary
        // image posts. Prefer concrete media and explicit long-text markers;
        // only use the generic type as a final fallback.
        const requestedType = ${JSON.stringify(contentType)};
        const detectedContentType = hasVideo
            ? 'video'
            : hasImages
              ? 'image'
              : hasLongText && requestedType !== 'image'
                ? 'article'
                : (requestedType || 'short');
        return {
          id: String(s.idstr || s.id || id),
          mblogid: s.mblogid || (${JSON.stringify(target.mblogid)}),
          url: 'https://weibo.com/' + String(u.id || '') + '/' + String(s.mblogid || ''),
          author: String(u.screen_name || ''),
          author_uid: String(u.idstr || u.id || ''),
          created_at: String(s.created_at || ''),
          content_type: detectedContentType,
          requested_content_type: ${JSON.stringify(contentType)},
          reposts: Number(s.reposts_count ?? 0),
          comments: Number(s.comments_count ?? 0),
          likes: Number(s.attitudes_count ?? 0),
          collects: Number(s.collect_count ?? s.favorites_count ?? 0),
          views: s.read_count == null ? null : Number(s.read_count),
          video_plays: s.play_count == null ? (s.video_play_count == null ? null : Number(s.video_play_count)) : Number(s.play_count),
          visibility: s.visible?.type === 0 ? 'public' : (s.visible?.type == null ? null : String(s.visible.type)),
          observed_at: new Date().toISOString(),
        };
      })()
    `)), 'weibo stats');
    if (data.auth) throw new AuthRequiredError('weibo.com');
    if (data.missing) throw new EmptyResultError('weibo stats', `Post ${lookup} was not found`);
    if (data.error) throw new CommandExecutionError(String(data.error));
    return [data];
}

function register(name, description, contentType) {
    return cli({
        site: 'weibo', name, access: 'read', description, domain: 'weibo.com',
        strategy: Strategy.COOKIE, browser: true,
        args: [{ name: 'id', type: 'string', required: true, positional: true, help: '微博 ID 或 mblogid' }],
        columns: WEIBO_STATS_COLUMNS,
        func: (page, kwargs) => runWeiboStats(page, kwargs, contentType),
    });
}

export const shortStatsCommand = register('short-stats', '获取短微博互动数据', 'short');
export const imageStatsCommand = register('image-stats', '获取图片微博互动数据', 'image');
export const videoStatsCommand = register('video-stats', '获取视频微博互动数据', 'video');
export const articleStatsCommand = register('article-stats', '获取微博长文章互动数据', 'article');
