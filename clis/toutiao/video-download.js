import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { resolveToutiaoArticleUrl } from './article-download.js';

function safeName(value) {
    return String(value || 'toutiao-video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120) || 'toutiao-video';
}

export async function runToutiaoVideoDownload(page, kwargs) {
    const sourceUrl = resolveToutiaoArticleUrl(kwargs?.video ?? kwargs?.url ?? kwargs?.id);
    const outputDir = path.resolve(String(kwargs?.output || './toutiao-downloads'));
    try {
        await page.goto(sourceUrl);
        await page.wait('networkidle');
        await page.wait(2);
        const media = await page.evaluate(`
(() => {
  const video = document.querySelector('video');
  return { title: document.querySelector('h1')?.innerText?.trim() || document.title || '', src: video?.currentSrc || video?.src || '' };
})()
`);
        if (!media?.src) throw new EmptyResultError('toutiao video download', 'No playable video source was found.');
        const response = await fetch(media.src, { headers: { referer: sourceUrl, 'user-agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new CommandExecutionError(`video request failed: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new EmptyResultError('toutiao video download', 'Video response was empty.');
        await fs.mkdir(outputDir, { recursive: true });
        const filePath = path.join(outputDir, `${safeName(media.title)}.mp4`);
        await fs.writeFile(filePath, bytes);
        return [{ url: sourceUrl, title: media.title || null, path: filePath, bytes: bytes.length, contentType: response.headers.get('content-type') || 'video/mp4' }];
    } catch (error) {
        if (error instanceof ArgumentError || error instanceof EmptyResultError || error instanceof CommandExecutionError) throw error;
        throw new CommandExecutionError(`toutiao video download failed: ${error?.message || error}`);
    }
}

export const videoDownloadCommand = cli({
    site: 'toutiao', name: 'video-download', access: 'read', description: '下载今日头条视频到本地文件',
    domain: 'www.toutiao.com', strategy: Strategy.PUBLIC, browser: true,
    args: [
        { name: 'video', type: 'string', required: true, positional: true, help: '今日头条视频 URL 或数字 ID' },
        { name: 'output', default: './toutiao-downloads', help: '输出目录' },
    ],
    columns: ['url', 'title', 'path', 'bytes', 'contentType'],
    func: (page, kwargs) => runToutiaoVideoDownload(page, kwargs),
});
