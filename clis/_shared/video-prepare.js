import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ArgumentError, CliError } from '@sovovs/bycli/errors';
import { validateMp4File } from '@sovovs/bycli/download';

export const SOHU_DECLARATIONS = ['无需声明', '含有虚构演绎内容', '含有AI生成内容', '含有营销信息', '内容为转载', '内容为个人观点'];
export const XHS_DECLARATIONS = ['none', '虚构演绎，仅供娱乐', '笔记含AI合成内容', '内容包含营销广告'];
export function validateManifest(value, platform) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArgumentError('Expected a JSON object');
    const allowed = ['video', 'cover', 'title', 'body', 'declaration', 'visibility', ...(platform === 'sohu' ? ['category'] : ['coverRatio'])];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ArgumentError(`Unsupported manifest field: ${key}`);
    for (const key of ['video', 'cover', 'title', 'body', 'declaration']) {
        if (typeof value[key] !== 'string' || !value[key].trim()) throw new ArgumentError(`Missing nonempty field: ${key}`);
    }
    const titleLength = value.title.length;
    if (titleLength < (platform === 'sohu' ? 5 : 1) || titleLength > (platform === 'sohu' ? 72 : 20)) throw new ArgumentError('Title exceeds platform length limits');
    if (value.body.length < (platform === 'sohu' ? 5 : 1) || value.body.length > (platform === 'sohu' ? 200 : 1000)) throw new ArgumentError('Body exceeds platform length limits');
    if (/[\r\n]/.test(value.title)) throw new ArgumentError('Title must be a single line');
    if (value.visibility !== 'public') throw new ArgumentError('This preparation command currently requires visibility="public"');
    if (!(platform === 'sohu' ? SOHU_DECLARATIONS : XHS_DECLARATIONS).includes(value.declaration)) throw new ArgumentError('Unsupported content declaration');
    if (platform === 'sohu' && value.category !== undefined && (!Array.isArray(value.category) || value.category.length !== 2 || value.category.some(x => typeof x !== 'string' || !x.trim()))) throw new ArgumentError('Sohu requires category: [primary, secondary]');
    if (platform === 'xiaohongshu' && value.coverRatio !== undefined && !['原始', '1:1', '3:4', '4:3'].includes(value.coverRatio)) throw new ArgumentError('Unsupported coverRatio');
    return { ...value };
}

async function fingerprint(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

export async function readManifest(input, platform) {
    let value;
    try { value = JSON.parse(await fs.readFile(input, 'utf8')); }
    catch { throw new ArgumentError('Cannot read the input JSON manifest'); }
    const manifest = validateManifest(value, platform);
    const base = path.dirname(path.resolve(input));
    const assets = {};
    for (const key of ['video', 'cover']) {
        const file = path.resolve(base, manifest[key]);
        let stat;
        try { stat = await fs.stat(file); } catch { throw new ArgumentError(`${key} file not found`); }
        if (!stat.isFile() || !stat.size) throw new ArgumentError(`${key} must be a nonempty regular file`);
        if (stat.size > (key === 'cover' ? 10 * 1024 ** 2 : platform === 'sohu' ? 4 * 1024 ** 3 : 20 * 1024 ** 3)) throw new ArgumentError(`${key} exceeds supported size`);
        manifest[key] = file;
        assets[key] = { path: file, bytes: stat.size, sha256: await fingerprint(file) };
    }
    if (path.extname(manifest.video).toLowerCase() !== '.mp4') throw new ArgumentError('This version prepares MP4 videos only');
    try { await validateMp4File(manifest.video); } catch { throw new ArgumentError('Video is not a valid MP4 with a video track'); }
    // Cover support is deliberately narrow: validate the file signature, not just its extension.
    const cover = await fs.readFile(manifest.cover);
    let width, height;
    if (cover.length >= 24 && cover.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        width = cover.readUInt32BE(16); height = cover.readUInt32BE(20);
    } else if (cover[0] === 0xff && cover[1] === 0xd8) {
        for (let i = 2; i + 8 < cover.length;) {
            if (cover[i++] !== 0xff) break;
            while (cover[i] === 0xff) i++;
            const marker = cover[i++];
            if (marker === 0xda || marker === 0xd9) break;
            const size = cover.readUInt16BE(i);
            if (size < 2 || i + size > cover.length) break;
            if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = cover.readUInt16BE(i + 3); width = cover.readUInt16BE(i + 5); break; }
            i += size;
        }
    }
    if (!width || !height || !/\.(png|jpe?g)$/i.test(manifest.cover)) throw new ArgumentError('Cover must be a PNG or JPEG image');
    if (platform === 'sohu' && (width <= 450 || height <= 300)) throw new ArgumentError('Sohu cover must be larger than 450×300');
    assets.cover.width = width; assets.cover.height = height;
    return { manifest, assets };
}

export async function waitFor(page, expression, label, timeout = 60000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
        value = await page.evaluate(expression);
        if (value) return value;
        const failure = await page.evaluate(String.raw`(() => {
            const text = document.body?.innerText || '';
            const network = text.match(/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|无法访问此网站/);
            if (network) return { code: 'SITE_UNREACHABLE', message: network[0] };
            const hit = text.match(/请完善入驻信息再上传|未实名[^\n]*|上传失败[^\n]*|上传出错[^\n]*|视频上传中断[^\n]*|服务异常[^\n]*|请先登录|账号异常|请完成验证/);
            return hit ? { code: 'SITE_BLOCKED', message: hit[0].slice(0, 120) } : null;
        })()`);
        if (failure) throw new CliError(failure.code || 'SITE_BLOCKED', failure.message || failure);
        await page.wait({ time: 0.5 });
    } while (Date.now() < deadline);
    throw new CliError('PREPARATION_TIMEOUT', `Timed out waiting for ${label}`);
}

/** Tag only an unambiguous visible target, then use the normal native click bridge. */
export async function clickText(page, text, scope = 'body') {
    const token = `prepare-${randomUUID()}`;
    const count = await page.evaluate(String.raw`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(scope)} + ' *')].filter(e =>
            e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0);
        if (nodes.length === 1) nodes[0].setAttribute('data-bycli-prepare', ${JSON.stringify(token)});
        return nodes.length;
    })()`);
    if (count !== 1) throw new CliError('CONTROL_NOT_FOUND', `Expected one visible control: ${text}, found ${count}`);
    await page.click(`[data-bycli-prepare="${token}"]`);
}

export async function fillVerified(page, selector, value) {
    await page.typeText(selector, value);
    const matched = await page.evaluate(String.raw`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        const editable = e?.isContentEditable;
        const paragraphs = editable && e.children.length > 0 && [...e.children].every(n => n.tagName === 'P');
        const actual = editable ? (paragraphs ? [...e.children].map(n => n.textContent).join('\n') : e.innerText) : e?.value;
        return (actual || '').replace(/\r\n/g, '\n').trim() === ${JSON.stringify(value)}.replace(/\r\n/g, '\n').trim();
    })()`);
    if (!matched) throw new CliError('FIELD_MISMATCH', `Could not verify ${selector}`);
}

/** Preparation never submits. Optional inspection binds uploaded media and account for later review. */
export async function prepareVideo(page, kwargs, platform, prepare, inspect) {
    if (kwargs.prepare !== true) throw new ArgumentError('Use --prepare; this command cannot publish or submit');
    const { manifest, assets } = await readManifest(kwargs.input, platform);
    const jobId = randomUUID();
    const dir = path.join(process.env.BYCLI_CONFIG_DIR || path.join(os.homedir(), '.bycli'), 'publish-jobs', platform, jobId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const report = path.join(dir, 'job.json');
    const job = { schemaVersion: 1, jobId, platform, contentType: 'video', createdAt: new Date().toISOString(),
        status: 'preparing', stage: 'validated', submitted: false, finalPublishAction: 'not_implemented',
        remoteDraftId: null, editorPersistence: 'live_browser_editor; remote draft durability not guaranteed',
        manifest, assets, inputSha256: createHash('sha256').update(JSON.stringify({ manifest, assets })).digest('hex'),
        sideEffects: ['Video and cover uploads; platform may automatically save a remote draft'], report };
    const save = async () => {
        job.updatedAt = new Date().toISOString();
        const temp = path.join(dir, 'job.tmp');
        await fs.writeFile(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
        await fs.rename(temp, report);
    };
    await save();
    const stage = async (name, checkpoint) => { job.stage = name; if(checkpoint)job.preparationCheckpoint=checkpoint; await save(); };
    try {
        job.checks = await prepare(page, manifest, stage);
        // Detect changed local inputs before claiming the prepared result matches the manifest.
        for (const key of ['video', 'cover']) if (await fingerprint(manifest[key]) !== assets[key].sha256) throw new CliError('ASSET_CHANGED', `${key} changed during preparation`);
        const pageState = await page.evaluate(String.raw`(() => {
            const account = document.querySelector('.user-name,.user-info,.user-info-name,.name-box')?.textContent?.trim() || '';
            return { url: location.origin + location.pathname, account };
        })()`);
        job.pageUrl = pageState.url;
        job.accountContextSha256 = pageState.account ? createHash('sha256').update(pageState.account).digest('hex') : null;
        job.pageTarget = page.getActivePage?.() ?? null;
        if (inspect) {
            const live = await inspect(page, job);
            job.preparedAccount = live.account;
            job.publishBinding = createHash('sha256').update(JSON.stringify({account:live.account,mediaHash:live.mediaHash})).digest('hex');
            job.finalPublishAction = 'requires_confirmation';
        }
        job.screenshot = path.join(dir, 'preview.png');
        await page.screenshot({ path: job.screenshot, fullPage: true });
        await fs.chmod(job.screenshot, 0o600);
        job.stage = 'ready'; job.status = 'ready_for_confirmation';
        await save();
        return [{ status: job.status, job_id: jobId, submitted: false, title: manifest.title, report, preview: job.screenshot }];
    } catch (error) {
        job.status = error.code === 'CATEGORY_REQUIRED' ? 'category_required' : 'failed';
        job.pageTarget = page.getActivePage?.() ?? null;
        job.error = { code: error.code || 'PREPARATION_FAILED', message: String(error.message || 'Preparation failed').replace(/https?:\/\/\S+/g, '[url]').slice(0, 400) };
        await save();
        if(error.code==='CATEGORY_REQUIRED')return [{status:job.status,job_id:jobId,submitted:false,report,recovery:'Inspect bycli sohu editor --categories, then --resume JOB --category JSON'}];
        throw new CliError(job.error.code, job.error.message, `Local preparation report: ${report}`);
    }
}
