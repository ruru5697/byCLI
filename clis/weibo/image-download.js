import { cli, Strategy } from '@sovovs/bycli/registry';
import { runWeiboImageDownload } from './_image-download.js';
export { runWeiboImageDownload, __test__ } from './_image-download.js';

cli({
    site: 'weibo', name: 'image-download', access: 'read', description: 'Download original images from a Weibo post',
    domain: 'weibo.com', strategy: Strategy.COOKIE, browser: true,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'Weibo post ID, mblogid, or URL' },
        { name: 'output', type: 'string', default: './weibo-downloads', help: 'Output directory' },
    ],
    columns: ['id', 'mblogid', 'index', 'url', 'path', 'bytes', 'contentType', 'resolved_image_count', 'reported_pic_num', 'mixed_video_count', 'count_matches_reported'],
    func: (page, kwargs) => runWeiboImageDownload(page, kwargs),
});
