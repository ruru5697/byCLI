import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CliError } from '@sovovs/bycli/errors';
import { downloadMedia } from '@sovovs/bycli/download/media-download';

export function parseSohuArticle(input) {
    try {
        const u = new URL(String(input).trim());
        const match = u.pathname.match(/^\/a\/(\d+_\d+)\/?$/);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password
            || !['www.sohu.com', 'm.sohu.com', 'sohu.com'].includes(u.hostname) || !match) throw new Error();
        return { articleId: match[1], url: `https://www.sohu.com/a/${match[1]}` };
    } catch {
        throw new ArgumentError('Expected a Sohu account article URL: https://www.sohu.com/a/<article>_<author>');
    }
}

/** Associate the media with the article's player, never a recommendation/ad resource. */
export function buildSohuVideoExtractJs(articleId) {
    return String.raw`(() => {
        const expected = ${JSON.stringify(articleId)};
        if (location.pathname.replace(/\/$/, '') !== '/a/' + expected) return { error: 'Unexpected article page' };
        const roots = [...document.querySelectorAll('.place_video')];
        const player = window._player;
        for (const root of roots) {
            const vid = root.getAttribute('data-vid') || root.getAttribute('data-bid') || root.id.replace(/^ab/, '');
            const video = root.querySelector('video');
            if (!vid || !video) continue;
            // This private shape is capability-detected and checked against the body video ID.
            const matches = String(player?.videoData?.vid || '') === String(vid);
            const media = video.ms?.media;
            const raw = matches ? media?.kernel?.cdnurl : null;
            const direct = video.currentSrc || video.src || video.querySelector('source')?.src;
            const candidate = raw || direct;
            if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
            let u;
            try { u = new URL(candidate); } catch { continue; }
            if (u.username || u.password) continue;
            const host = u.hostname.toLowerCase();
            if (!(host === 'itc.cn' || host.endsWith('.itc.cn') || host === 'sohu.com' || host.endsWith('.sohu.com'))) continue;
            if (/\.m3u8(?:$|\?)/i.test(candidate)) return { unsupported: 'HLS playlists are not supported by native MP4 download' };
            return { articleId: expected, videoId: String(vid), url: candidate,
                duration: video.duration || null, source: raw ? 'article_player' : 'article_video' };
        }
        return { pending: true, playerCount: roots.length };
    })()`;
}

export const command = cli({
    site: 'sohu', name: 'download', access: 'read',
    description: '原生下载搜狐号文章内的视频（MP4）',
    domain: 'www.sohu.com', strategy: Strategy.COOKIE, navigateBefore: false,
    args: [
        { name: 'url', positional: true, required: true, help: 'Sohu account article URL (www.sohu.com/a/… or m.sohu.com/a/…)' },
        { name: 'timeout', type: 'int', default: 120, help: 'Total file transfer timeout in seconds (1-3600)' },
        { name: 'output', default: './sohu-downloads', help: 'Output directory' },
    ],
    columns: ['article_id', 'video_id', 'status', 'size', 'path'],
    func: async (page, kwargs) => {
        const timeout = kwargs.timeout === undefined ? 120 : Number(kwargs.timeout);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new ArgumentError('--timeout must be an integer from 1 to 3600 seconds');
        const target = parseSohuArticle(kwargs.url);
        await page.goto(target.url);
        let data;
        // The player is loaded lazily; retry extraction, not navigation or download.
        for (let i = 0; i < 30; i++) {
            data = await page.evaluate(buildSohuVideoExtractJs(target.articleId));
            if (data?.url || data?.error || data?.unsupported) break;
            await page.wait({ time: 0.5 });
        }
        if (data?.error) throw new CliError('UNEXPECTED_PAGE', data.error);
        if (data?.unsupported) throw new CliError('UNSUPPORTED_MEDIA', data.unsupported);
        if (!data?.url) throw new CliError('NO_VIDEO', 'No downloadable article video became available.', 'Open the desktop article and check that the body video is accessible; login or player changes may require attention.');
        const results = await downloadMedia([{ type: 'video', url: data.url, expectedMedia: 'mp4',
            filename: `${target.articleId}_${data.videoId}.mp4` }], {
            output: kwargs.output, subdir: target.articleId,
            headers: { Referer: target.url }, validateMedia: true, timeout: timeout * 1000,
        });
        return results.map(r => ({ ...r, article_id: target.articleId, video_id: data.videoId }));
    },
});
