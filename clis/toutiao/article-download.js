import { cli, Strategy } from '@sovovs/bycli/registry';
import { runToutiaoArticleDownload } from './_article-download.js';
export { runToutiaoArticleDownload, resolveToutiaoArticleUrl, renderToutiaoArticleMarkdown } from './_article-download.js';

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
