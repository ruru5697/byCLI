/** Download the playable video from a Weibo post. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { normalizeWeiboTarget, unwrapEvaluateResult } from './utils.js';

function safeName(value) {
    return String(value || 'weibo-video')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .trim()
        .slice(0, 120) || 'weibo-video';
}

export async function runWeiboVideoDownload(page, kwargs, deps = {}) {
    const target = normalizeWeiboTarget(kwargs?.id ?? kwargs?.url);
    const outputDir = path.resolve(String(kwargs?.output || './weibo-downloads'));
    const fetchImpl = deps.fetch ?? fetch;
    await page.goto('https://weibo.com');
    await page.wait(2);

    const media = unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(target.id || target.mblogid)};
        const postUrl = ${JSON.stringify(target.url)};
        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), { credentials: 'include' });
        if (resp.status === 401 || resp.status === 403) return { auth: true };
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const status = await resp.json();
        if (!status.ok && !status.idstr && !status.id) return { missing: true };
        const info = status.page_info || {};
        const mediaInfo = info.media_info || {};
        const object = info.object || {};
        const src = mediaInfo.mp4_720p_mp4 || mediaInfo.mp4_hd_mp4 || mediaInfo.stream_url || object.stream_url || '';
        const title = String(status.text_raw || document.title || '微博视频').replace(/\\s+/g, ' ').trim().slice(0, 120);
        return {
          title,
          sourceUrl: postUrl || ('https://weibo.com/' + String(status.user?.id || '') + '/' + String(status.mblogid || '')),
          mediaUrl: src,
          contentType: String(info.type || mediaInfo.type || ''),
        };
      })()
    `));

    if (media?.auth) throw new CommandExecutionError('Weibo login is required to download this video');
    if (media?.missing) throw new EmptyResultError('weibo video download', 'The Weibo post was not found');
    if (media?.error) throw new CommandExecutionError(`weibo video download: ${media.error}`);
    if (!media?.mediaUrl) throw new EmptyResultError('weibo video download', 'No playable video source was exposed by the post');

    const response = await fetchImpl(media.mediaUrl, {
        headers: {
            referer: media.sourceUrl || 'https://weibo.com/',
            'user-agent': 'Mozilla/5.0',
        },
    });
    if (!response.ok) throw new CommandExecutionError(`video request failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new EmptyResultError('weibo video download', 'Video response was empty');

    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${safeName(media.title)}-${target.mblogid || target.id}.mp4`);
    await fs.writeFile(outputPath, bytes);
    return [{
        id: target.id || null,
        mblogid: target.mblogid || null,
        url: media.sourceUrl || target.url,
        title: media.title || null,
        path: outputPath,
        bytes: bytes.length,
        contentType: response.headers.get('content-type') || 'video/mp4',
    }];
}

cli({
    site: 'weibo',
    name: 'video-download',
    access: 'read',
    description: 'Download a video from a Weibo post',
    domain: 'weibo.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'Weibo post ID, mblogid, or URL' },
        { name: 'output', type: 'string', default: './weibo-downloads', help: 'Output directory' },
    ],
    columns: ['id', 'mblogid', 'url', 'title', 'path', 'bytes', 'contentType'],
    func: (page, kwargs) => runWeiboVideoDownload(page, kwargs),
});

export const __test__ = { safeName, runWeiboVideoDownload };
