import { outputFilenameStem } from '../_shared/output-filename.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { resolveToutiaoArticleUrl } from './_article-download.js';

function safeName(value) {
    return outputFilenameStem(value, 'toutiao-video');
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
