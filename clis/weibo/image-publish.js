/** Explicit image-post command. The legacy `weibo publish --images` remains supported. */
import { cli, Strategy, getRegistry } from '@sovovs/bycli/registry';
import { ArgumentError } from '@sovovs/bycli/errors';
import './publish.js';

cli({
    site: 'weibo', name: 'image-publish', access: 'write', description: 'Publish a Weibo image post (dry-run by default)',
    domain: 'weibo.com', strategy: Strategy.UI, browser: true,
    args: [
        { name: 'text', type: 'string', required: true, positional: true, help: 'Post text' },
        { name: 'images', type: 'string', required: true, help: 'Image paths, comma-separated (jpg/png/gif/webp)' },
        { name: 'execute', type: 'boolean', default: false, help: 'Actually publish after manual confirmation' },
    ],
    columns: ['status', 'message', 'text'],
    func: async (page, kwargs) => {
        if (kwargs?.execute !== true && kwargs?.execute !== 'true') {
            if (!String(kwargs?.images || '').trim()) throw new ArgumentError('--images is required');
            return [{ status: 'dry-run', message: 'Preview only; pass --execute after manual confirmation to publish.', text: String(kwargs.text || '').trim() }];
        }
        const publish = getRegistry().get('weibo/publish');
        if (!publish?.func) throw new ArgumentError('Legacy weibo publish command is unavailable');
        return publish.func(page, { ...kwargs, video: undefined });
    },
});

