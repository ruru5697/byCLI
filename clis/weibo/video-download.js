import { cli, Strategy } from '@sovovs/bycli/registry';
import { runWeiboVideoDownload } from './_video-download.js';
export { runWeiboVideoDownload, __test__ } from './_video-download.js';

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
