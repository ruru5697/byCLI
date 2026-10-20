/** Download original images attached to a Weibo post. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { normalizeWeiboTarget, unwrapEvaluateResult } from './utils.js';

function safeName(value) {
    return String(value || 'weibo-image').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 100) || 'weibo-image';
}

function extensionFrom(contentType, url) {
    const type = String(contentType || '').toLowerCase();
    if (type.includes('png')) return '.png';
    if (type.includes('webp')) return '.webp';
    if (type.includes('gif')) return '.gif';
    if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
    const match = String(url || '').match(/\.(jpe?g|png|gif|webp)(?:[?#]|$)/i);
    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

export async function runWeiboImageDownload(page, kwargs, deps = {}) {
    const target = normalizeWeiboTarget(kwargs?.id ?? kwargs?.url);
    const outputDir = path.resolve(String(kwargs?.output || './weibo-downloads'));
    const fetchImpl = deps.fetch ?? fetch;
    await page.goto('https://weibo.com');
    await page.wait(2);
    const lookup = target.id || target.mblogid;
    const payload = unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(lookup)};
        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), { credentials: 'include' });
        if (resp.status === 401 || resp.status === 403) return { auth: true };
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const status = await resp.json();
        if (!status.ok && !status.idstr && !status.id) return { missing: true };
        const urls = [];
        const infos = status.pic_infos || {};
        for (const id of status.pic_ids || Object.keys(infos)) {
          const info = infos[id] || {};
          const value = info.original?.url || info.large?.url || info.mw2000?.url || info.url || info.thumbnail?.url;
          if (value && !urls.includes(value)) urls.push(value);
        }
        return { urls, title: String(status.text_raw || '').replace(/\\s+/g, ' ').trim().slice(0, 100), mblogid: status.mblogid || ${JSON.stringify(target.mblogid)} || '', id: String(status.idstr || status.id || id) };
      })()
    `));
    if (payload?.auth) throw new CommandExecutionError('Weibo login is required to download images');
    if (payload?.missing) throw new EmptyResultError('weibo image download', `Post ${lookup} was not found`);
    if (payload?.error) throw new CommandExecutionError(`weibo image download: ${payload.error}`);
    if (!Array.isArray(payload?.urls) || payload.urls.length === 0) throw new EmptyResultError('weibo image download', 'No images were attached to this post');

    await fs.mkdir(outputDir, { recursive: true });
    const rows = [];
    for (let index = 0; index < payload.urls.length; index++) {
        const sourceUrl = payload.urls[index];
        const response = await fetchImpl(sourceUrl, { headers: { referer: 'https://weibo.com/', 'user-agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new CommandExecutionError(`image request failed: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new EmptyResultError('weibo image download', 'Image response was empty');
        const ext = extensionFrom(response.headers.get('content-type'), sourceUrl);
        const filePath = path.join(outputDir, `${safeName(payload.mblogid || payload.id)}-${String(index + 1).padStart(2, '0')}${ext}`);
        await fs.writeFile(filePath, bytes);
        rows.push({ id: payload.id, mblogid: payload.mblogid || null, index: index + 1, url: sourceUrl, path: filePath, bytes: bytes.length, contentType: response.headers.get('content-type') || null });
    }
    return rows;
}

cli({
    site: 'weibo', name: 'image-download', access: 'read', description: 'Download original images from a Weibo post',
    domain: 'weibo.com', strategy: Strategy.COOKIE, browser: true,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'Weibo post ID, mblogid, or URL' },
        { name: 'output', type: 'string', default: './weibo-downloads', help: 'Output directory' },
    ],
    columns: ['id', 'mblogid', 'index', 'url', 'path', 'bytes', 'contentType'],
    func: (page, kwargs) => runWeiboImageDownload(page, kwargs),
});

export const __test__ = { safeName, extensionFrom, runWeiboImageDownload };
