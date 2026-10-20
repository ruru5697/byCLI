import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';

export function resolveToutiaoArticleUrl(input) {
    const value = String(input ?? '').trim();
    if (!value) throw new ArgumentError('article URL or ID is required');
    if (/^\d{8,32}$/.test(value)) return `https://www.toutiao.com/article/${value}/`;
    let url;
    try { url = new URL(value); } catch { throw new ArgumentError('article must be a valid Toutiao URL or numeric ID'); }
    if (!/(^|\.)toutiao\.com$/i.test(url.hostname)) throw new ArgumentError('article URL must belong to toutiao.com');
    url.hash = '';
    return url.toString();
}

function safeStem(value) {
    return String(value || 'toutiao-article').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120) || 'toutiao-article';
}

export function renderToutiaoArticleMarkdown(article) {
    const header = [`# ${article.title || '今日头条文章'}`, '', `- 原文：${article.url}`, article.author ? `- 作者：${article.author}` : null, article.published ? `- 发布时间：${article.published}` : null, ''].filter(Boolean).join('\n');
    const title = String(article.title || '').trim();
    const bodyLines = String(article.text || '').split(/\r?\n/);
    if (title && bodyLines[0]?.trim().replace(/^#\s*/, '') === title) bodyLines.shift();
    return `${header}\n${bodyLines.join('\n').replace(/^\n+/, '')}\n`;
}

export async function runToutiaoArticleDownload(page, kwargs) {
    const url = resolveToutiaoArticleUrl(kwargs?.article ?? kwargs?.url ?? kwargs?.id);
    const outputDir = path.resolve(String(kwargs?.output || './toutiao-downloads'));
    const format = String(kwargs?.outputFormat || kwargs?.['output-format'] || 'md').toLowerCase();
    if (!['md', 'json'].includes(format)) throw new ArgumentError('--format must be md or json');
    try {
        // Do not wait for the public page's load event: ads/telemetry keep it
        // open indefinitely. The browser backend supports a non-blocking
        // navigation mode; the fixed hydration wait below is sufficient.
        // Use a fresh owned tab so persistent site sessions cannot retain a stale
        // page identity from an earlier command. `tabs:new` returns immediately;
        // the fixed hydration wait below gives Toutiao time to render its article.
        if (typeof page.newTab === 'function' && typeof page.setActivePage === 'function') {
            const nextPage = await page.newTab(url);
            if (!nextPage) throw new CommandExecutionError('Toutiao article download could not create a browser tab');
            page.setActivePage(nextPage);
        } else {
            await page.goto(url, { waitUntil: 'none', settleMs: 0, stealth: false });
        }
        await page.wait(8);
        const article = await page.evaluate(`
(() => {
  const pick = (selectors) => selectors.map((s) => document.querySelector(s)).find(Boolean);
  const root = pick(['article', '[class*="article-content"]', '[class*="articleContent"]', 'main']) || document.body;
  const title = document.querySelector('h1')?.innerText?.trim() || document.title || '';
  const text = root.innerText?.trim() || '';
  const metaLine = [...document.querySelectorAll('body *')].map((n) => n.innerText?.trim()).find((v) => /^20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T咏午时:]|$)/.test(v || '') && (v || '').length < 80) || '';
  const dateMatch = metaLine.match(/^(20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T咏午时:]\\d{1,2}:\\d{2})?)/);
  const published = document.querySelector('time')?.getAttribute('datetime') || dateMatch?.[1] || '';
  const author = document.querySelector('a[href*="/c/user/"]')?.innerText?.trim() || metaLine.match(/·\\s*([^·]+)$/)?.[1]?.trim() || '';
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  return { title, text, published, author, url: canonical, isVideo: location.pathname.includes('/video/') };
})()
`);
        if (article?.isVideo) throw new ArgumentError('The supplied URL is a video; use toutiao video-download instead.');
        if (!article?.text || article.text.length < 20) throw new EmptyResultError('toutiao article download', 'Article body was not found or the page is a login/anti-bot wall.');
        await fs.mkdir(outputDir, { recursive: true });
        const ext = format === 'json' ? 'json' : 'md';
        const filePath = path.join(outputDir, `${safeStem(article.title)}.${ext}`);
        const content = format === 'json' ? JSON.stringify({ ...article, sourceUrl: url }, null, 2) : renderToutiaoArticleMarkdown({ ...article, url: article.url || url });
        await fs.writeFile(filePath, content, 'utf8');
        return [{ url: article.url || url, title: article.title || null, author: article.author || null, published: article.published || null, format, path: filePath, bytes: Buffer.byteLength(content) }];
    } catch (error) {
        if (error instanceof ArgumentError || error instanceof EmptyResultError) throw error;
        throw new CommandExecutionError(`toutiao article download failed: ${error?.message || error}`);
    }
}

export const articleDownloadCommand = cli({
    site: 'toutiao', name: 'article-download', access: 'read', description: '下载今日头条文章正文为 Markdown 或 JSON',
    // This command needs the logged-in Chrome renderer for the hydrated
    // article DOM; use the UI runner even though the page itself is public.
    domain: 'www.toutiao.com', strategy: Strategy.UI, browser: true, siteSession: 'ephemeral',
    args: [
        { name: 'article', type: 'string', required: true, positional: true, help: '今日头条文章 URL 或数字 ID' },
        { name: 'output', default: './toutiao-downloads', help: '输出目录' },
        { name: 'output-format', default: 'md', help: '文件格式：md 或 json（CLI 的 -f/--format 仍用于控制命令输出）' },
    ],
    columns: ['url', 'title', 'author', 'published', 'format', 'path', 'bytes'],
    func: (page, kwargs) => runToutiaoArticleDownload(page, kwargs),
});
