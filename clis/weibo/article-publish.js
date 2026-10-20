import { cli, Strategy } from '@sovovs/bycli/registry';
import { runWeiboArticlePublish, MAX_TITLE, MAX_SUMMARY } from './_article-publish.js';
export { runWeiboArticlePublish, __test__ } from './_article-publish.js';

cli({
    site: 'weibo', name: 'article-publish', access: 'write', description: 'Save a Weibo long article draft from offline-prepared HTML (dry-run by default; publishing stays manual)',
    domain: 'weibo.com', strategy: Strategy.UI, browser: true,
    args: [
        { name: 'title', type: 'string', required: true, help: `Article title (max ${MAX_TITLE} characters)` },
        { name: 'summary', type: 'string', required: false, help: `Optional lead paragraph (max ${MAX_SUMMARY} characters)` },
        { name: 'content', type: 'string', required: false, help: 'Inline article content' },
        { name: 'content-file', type: 'string', required: false, help: 'HTML or plain-text file; local <img> paths resolve relative to this file' },
        { name: 'content-format', type: 'string', required: false, choices: ['text', 'html'], help: 'Content format (default: html for .html/.htm files, otherwise text)' },
        { name: 'cover', type: 'string', required: false, help: 'Cover image path (jpg/png/gif/bmp)' },
        { name: 'execute', type: 'boolean', default: false, help: 'Fill the editor and save a draft (never publishes)' },
        { name: 'timeout', type: 'int', default: 300, help: 'Max seconds for the whole run; each body image upload can take up to 90s' },
    ],
    columns: ['status', 'draft_id', 'title', 'content_format', 'content_source', 'content_chars', 'images', 'cover', 'warnings', 'message', 'url'],
    func: (page, kwargs) => runWeiboArticlePublish(page, kwargs),
});
