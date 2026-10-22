import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@sovovs/bycli/download/media-download', () => ({ downloadMedia: download }));
import { parseSohuArticle, buildSohuVideoExtractJs, command } from './download.js';

function extract({ vid = '719223894', playerVid = vid, src = 'https://cdn.vod.tv.itc.cn/movie.mp4', extra = '' } = {}) {
    const dom = new JSDOM(`<div class="place_video" data-bid="${vid}"><video></video></div>${extra}`,
        { url: 'https://www.sohu.com/a/1028743820_121620820', runScripts: 'outside-only' });
    dom.window._player = { videoData: { vid: playerVid } };
    dom.window.document.querySelector('video').ms = { media: { kernel: { cdnurl: src } } };
    try { return dom.window.eval(buildSohuVideoExtractJs('1028743820_121620820')); }
    finally { dom.window.close(); }
}

describe('sohu native video download', () => {
    it('normalizes mobile article links to the desktop body player', () => {
        expect(parseSohuArticle('https://m.sohu.com/a/123_456/?share=1')).toEqual({ articleId: '123_456', url: 'https://www.sohu.com/a/123_456' });
    });
    it.each(['https://sohu.com.evil/a/123_456', 'https://tv.sohu.com/v/123', 'file:///a/123_456', 'https://user:pass@www.sohu.com/a/123_456', '123_456'])('rejects unrelated input %s', input => {
        expect(() => parseSohuArticle(input)).toThrow();
    });
    it('extracts the article video with matching player identity', () => {
        expect(extract()).toMatchObject({ articleId: '1028743820_121620820', videoId: '719223894', source: 'article_player' });
    });
    it('does not select a mismatched global player or unrelated recommendation', () => {
        expect(extract({ playerVid: 'ad', extra: '<video src="https://cdn.vod.tv.itc.cn/ad.mp4"></video>' })).toMatchObject({ pending: true });
    });
    it.each(['blob:secret', 'https://unrelated.example/movie.mp4'])('rejects unusable sources %s', src => {
        expect(extract({ src })).toMatchObject({ pending: true });
    });
    it('reports an unsupported playlist explicitly', () => {
        expect(extract({ src: 'https://cdn.vod.tv.itc.cn/video.m3u8?token=private' })).toMatchObject({ unsupported: expect.stringContaining('HLS') });
    });
    it('waits for the player, then downloads one validated MP4 without exporting site cookies', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn()
            .mockResolvedValueOnce({ pending: true })
            .mockResolvedValueOnce({ videoId: '99', url: 'https://cdn.vod.tv.itc.cn/movie.mp4' }) };
        download.mockResolvedValue([{ status: 'success', path: '/out/movie.mp4' }]);
        expect(await command.func(page, { url: 'https://m.sohu.com/a/123_456', output: '/out' }))
            .toEqual([{ status: 'success', path: '/out/movie.mp4', article_id: '123_456', video_id: '99' }]);
        expect(page.wait).toHaveBeenCalledTimes(1);
        expect(download).toHaveBeenCalledWith([expect.objectContaining({ expectedMedia: 'mp4', type: 'video' })],
            expect.objectContaining({ validateMedia: true, headers: { Referer: 'https://www.sohu.com/a/123_456' } }));
    });
    it('fails explicitly when the body player never yields media', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ pending: true }) };
        await expect(command.func(page, { url: 'https://www.sohu.com/a/123_456' })).rejects.toMatchObject({ code: 'NO_VIDEO' });
        expect(page.evaluate).toHaveBeenCalledTimes(30);
    });
});
