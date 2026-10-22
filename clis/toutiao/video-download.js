import { cli, Strategy } from '@sovovs/bycli/registry';
import { runToutiaoVideoDownload } from './_video-download.js';
export { runToutiaoVideoDownload } from './_video-download.js';

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
