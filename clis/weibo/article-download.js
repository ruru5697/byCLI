import { cli, Strategy } from '@sovovs/bycli/registry';
import { runWeiboArticleDownload } from './_article-download.js';
export { runWeiboArticleDownload, renderWeiboArticleMarkdown, __test__ } from './_article-download.js';

cli({
    site: 'weibo', name: 'article-download', access: 'read', description: 'Download a Weibo long article as Markdown or JSON',
    domain: 'weibo.com', strategy: Strategy.COOKIE, browser: true,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'Weibo article ID, mblogid, or URL' },
        { name: 'output', type: 'string', default: './weibo-downloads', help: 'Output directory' },
        { name: 'output-format', type: 'string', default: 'md', help: 'md or json' },
    ],
    columns: ['id', 'mblogid', 'url', 'title', 'format', 'path', 'bytes'],
    func: (page, kwargs) => runWeiboArticleDownload(page, kwargs),
});
