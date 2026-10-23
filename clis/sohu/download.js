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
        const roots = [...document.querySelectorAll('.place_video, #mainVideoContent, #sohuPlayer')]
            .filter(root => !root.closest('.recommend,.recommend-list,.advertisement,[data-ad]'));
        const candidates = [];
        for (const root of roots) {
            const videos = [...root.querySelectorAll('video')];
            for (const video of videos) {
                if (video.closest('.recommend,.recommend-list,.advertisement,[data-ad]')) continue;
                const owner = video.closest('.place_video') || root;
                const vm = video.__vue__ || video.closest('#sohuPlayer')?.__vue__ || owner.__vue__ || root.__vue__;
                const props = vm?.$props || video.__vueParentComponent?.props || root.__vueParentComponent?.props;
                const direct = video.currentSrc || video.src || video.querySelector('source')?.src;
                // New Sohu players expose their identity on the component or the canonical
                // v2.sohu.com/v/url/<video>_<author>.MP4 link inside the body player.
                let linked;
                try { linked = new URL(direct, location.href); } catch {}
                const canonical = linked?.hostname === 'v2.sohu.com'
                    ? linked.pathname.match(/^\/v\/url\/(\d+)_(\d+)\.MP4$/i) : null;
                const explicit = owner.getAttribute('data-vid') || owner.getAttribute('data-bid')
                    || owner.id.match(/^ab(\d+)$/)?.[1] || root.getAttribute('data-vid')
                    || vm?.videoData?.vid || props?.vid || props?.videoId || vm?.vid || vm?.videoId;
                const vid = String(explicit || canonical?.[1] || '');
                if (!/^\d+$/.test(vid) || canonical && (canonical[1] !== vid || canonical[2] !== expected.split('_')[1])) continue;
                const player = window._player;
                const matches = String(player?.videoData?.vid || '') === vid;
                const raw = matches ? video.ms?.media?.kernel?.cdnurl : null;
                // A DOM-bound component is usable without relying on an unrelated global player.
                const componentSource = String(vm?.videoData?.vid || props?.vid || props?.videoId || vm?.vid || vm?.videoId || '') === vid
                    ? video.ms?.media?.kernel?.cdnurl : null;
                const candidate = raw || componentSource || direct;
                if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
                let u;
                try { u = new URL(candidate); } catch { continue; }
                if (u.username || u.password) continue;
                const host = u.hostname.toLowerCase();
                if (!(host === 'itc.cn' || host.endsWith('.itc.cn') || host === 'sohu.com' || host.endsWith('.sohu.com'))) continue;
                if (/\.m3u8(?:$|\?)/i.test(candidate)) { candidates.push({unsupported:'HLS playlists are not supported by native MP4 download',videoId:vid}); continue; }
                candidates.push({ articleId: expected, videoId: vid, url: candidate,
                    duration: Number.isFinite(video.duration) ? video.duration : null,
                    source: raw || componentSource ? 'article_player' : 'article_video' });
            }
        }
        const unique = [...new Map(candidates.map(c => [c.videoId, c])).values()];
        if (unique.length > 1) return { error: 'Multiple body video identities; cannot choose one unambiguously' };
        if (unique.length === 1) return unique[0];
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
