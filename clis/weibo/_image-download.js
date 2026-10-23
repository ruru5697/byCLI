import { outputFilenameStem } from '../_shared/output-filename.js';
/** Download original images attached to a Weibo post. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { normalizeWeiboTarget, unwrapEvaluateResult } from './utils.js';

function safeName(value) {
    return outputFilenameStem(value, 'weibo-image');
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

/** Resolve only picture media, never a video's poster. Mixed-media data is
 * distinct from legacy pic_infos; reported pic_num is retained without assuming
 * it is the number of downloadable original images. */
export function resolveWeiboImages(status) {
    const urls = [];
    const add = info => {
        const value = info?.original?.url || info?.largest?.url || info?.large?.url || info?.mw2000?.url || info?.url || info?.thumbnail?.url;
        if (typeof value !== 'string') return;
        const url = value.startsWith('//') ? 'https:' + value : value;
        if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
    };
    const mixed = Array.isArray(status.mix_media_info?.items) ? status.mix_media_info.items : null;
    for (const item of mixed || []) if (item?.type === 'pic') add(item.data);
    const infos = status.pic_infos && typeof status.pic_infos === 'object' ? status.pic_infos : {};
    const ids = Array.isArray(status.pic_ids) && status.pic_ids.length ? status.pic_ids : Object.keys(infos);
    for (const id of ids) add(infos[id]);
    const reported = Number.isSafeInteger(status.pic_num) && status.pic_num >= 0 ? status.pic_num : null;
    return {urls, resolved_image_count:urls.length, reported_pic_num:reported,
        mixed_video_count:mixed ? mixed.filter(item => item?.type === 'video').length : null,
        count_matches_reported:reported === null ? null : reported === urls.length};
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
        const images = (${resolveWeiboImages.toString()})(status);
        return { ...images, title: String(status.text_raw || '').replace(/\\s+/g, ' ').trim().slice(0, 100), mblogid: status.mblogid || ${JSON.stringify(target.mblogid)} || '', id: String(status.idstr || status.id || id) };
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
        rows.push({ id: payload.id, mblogid: payload.mblogid || null, index: index + 1, url: sourceUrl, path: filePath, bytes: bytes.length, contentType: response.headers.get('content-type') || null, resolved_image_count:payload.resolved_image_count ?? payload.urls.length, reported_pic_num:payload.reported_pic_num ?? null, mixed_video_count:payload.mixed_video_count ?? null, count_matches_reported:payload.count_matches_reported ?? null });
    }
    return rows;
}


export const __test__ = { safeName, extensionFrom, resolveWeiboImages, runWeiboImageDownload };
