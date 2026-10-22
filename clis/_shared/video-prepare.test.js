import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { validateManifest, readManifest, prepareVideo, waitFor, fillVerified } from './video-prepare.js';

const dirs = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const base = { video: 'video.mp4', cover: 'cover.png', title: '视频准备测试请勿发布', body: '用于验证原生准备流程的测试正文。', declaration: 'none', visibility: 'public' };
function box(type, data) { const b = Buffer.alloc(8); b.writeUInt32BE(data.length + 8); b.write(type, 4); return Buffer.concat([b, data]); }
async function fixture(platform = 'xiaohongshu') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-prepare-')); dirs.push(dir);
    vi.stubEnv('BYCLI_CONFIG_DIR', path.join(dir, 'config'));
    await fs.writeFile(path.join(dir, 'video.mp4'), Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.from('payload')),
        box('moov', box('trak', box('mdia', box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('vide')])))))]));
    const image = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(image); image.writeUInt32BE(960, 16); image.writeUInt32BE(640, 20);
    await fs.writeFile(path.join(dir, 'cover.png'), image);
    const value = { ...base, ...(platform === 'sohu' ? { category: ['科技', '电脑'], declaration: '无需声明' } : {}) };
    const input = path.join(dir, 'input.json'); await fs.writeFile(input, JSON.stringify(value));
    return { dir, input, value };
}
describe('video preparation input and local jobs', () => {
    it.each(['title', 'body', 'video', 'cover', 'declaration'])('rejects missing %s', key => {
        const v = { ...base }; delete v[key]; expect(() => validateManifest(v, 'xiaohongshu')).toThrow();
    });
    it.each([{ title: '长'.repeat(21) }, { body: '字'.repeat(1001) }, { visibility: 'private' }, { submit: true }, { declaration: 'made up' }, { coverRatio: '16:9' }])('rejects unsupported or excessive fields %j', patch => {
        expect(() => validateManifest({ ...base, ...patch }, 'xiaohongshu')).toThrow();
    });
    it('requires both Sohu category levels and an explicit declaration', () => {
        expect(() => validateManifest({ ...base, declaration: '无需声明', category: ['科技'] }, 'sohu')).toThrow();
        expect(validateManifest({ ...base, declaration: '无需声明', category: ['科技', '电脑'] }, 'sohu').category).toEqual(['科技', '电脑']);
    });
    it('resolves files relative to the manifest, validates dimensions and hashes them', async () => {
        const f = await fixture(); const result = await readManifest(f.input, 'xiaohongshu');
        expect(result.manifest.video).toBe(path.join(f.dir, 'video.mp4'));
        expect(result.assets.cover).toMatchObject({ width: 960, height: 640, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    });
    it('rejects a small Sohu cover before opening the browser', async () => {
        const f = await fixture('sohu'); const image = await fs.readFile(path.join(f.dir, 'cover.png')); image.writeUInt32BE(450, 16);
        await fs.writeFile(path.join(f.dir, 'cover.png'), image);
        await expect(readManifest(f.input, 'sohu')).rejects.toThrow('larger than');
    });
    it('requires explicit preparation mode before touching any files or UI', async () => {
        const callback = vi.fn(); await expect(prepareVideo({}, { input: 'missing.json' }, 'sohu', callback)).rejects.toThrow('--prepare');
        expect(callback).not.toHaveBeenCalled();
    });
    it('persists a ready job with an owner-only report and no submit action', async () => {
        const f = await fixture();
        const page = { evaluate: vi.fn().mockResolvedValue({ url: 'https://creator.xiaohongshu.com/publish/publish', account: 'test-account' }),
            getActivePage: () => 'target', screenshot: vi.fn(async ({ path: file }) => fs.writeFile(file, 'screenshot')) };
        const [row] = await prepareVideo(page, { input: f.input, prepare: true }, 'xiaohongshu', async (_p, _m, stage) => { await stage('verifying'); return { finalPublishClicked: false }; });
        const job = JSON.parse(await fs.readFile(row.report, 'utf8'));
        expect(job).toMatchObject({ status: 'ready_for_confirmation', submitted: false, finalPublishAction: 'not_implemented', pageTarget: 'target' });
        expect(JSON.stringify(job)).not.toContain('test-account');
        expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
        if (process.platform !== 'win32') expect((await fs.stat(row.report)).mode & 0o777).toBe(0o600);
    });
    it('does not claim readiness if an input file changes during upload', async () => {
        const f = await fixture(); const page = { screenshot: vi.fn(), evaluate: vi.fn() };
        await expect(prepareVideo(page, { input: f.input, prepare: true }, 'xiaohongshu', async () => {
            await fs.appendFile(path.join(f.dir, 'video.mp4'), 'changed'); return {};
        })).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
        expect(page.screenshot).not.toHaveBeenCalled();
    });
    it('records the failing stage without uploading again or submitting', async () => {
        const f = await fixture(); const callback = vi.fn(async (_page, _manifest, stage) => { await stage('uploading_cover'); throw new Error('upload failed'); });
        await expect(prepareVideo({}, { input: f.input, prepare: true }, 'xiaohongshu', callback)).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
        const [id] = await fs.readdir(path.join(f.dir, 'config/publish-jobs/xiaohongshu'));
        const job = JSON.parse(await fs.readFile(path.join(f.dir, 'config/publish-jobs/xiaohongshu', id, 'job.json'), 'utf8'));
        expect(job).toMatchObject({ status: 'failed', stage: 'uploading_cover', submitted: false }); expect(callback).toHaveBeenCalledTimes(1);
    });
    it('recognizes platform rejection instead of treating a chosen file as an upload success', async () => {
        const page = { evaluate: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce('请完善入驻信息再上传'), wait: vi.fn() };
        await expect(waitFor(page, 'false', 'upload', 50)).rejects.toMatchObject({ code: 'SITE_BLOCKED' });
        expect(page.wait).not.toHaveBeenCalled();
    });
    it('requires text readback to match the requested content', async () => {
        const page = { typeText: vi.fn(), evaluate: vi.fn().mockResolvedValue(false) };
        await expect(fillVerified(page, 'input', 'expected')).rejects.toMatchObject({ code: 'FIELD_MISMATCH' });
    });
    it('verifies rich-editor paragraph boundaries without relying on rendered innerText spacing', async () => {
        const dom = new JSDOM(`<div class="editor" contenteditable="true"><p>第一段</p><p><br></p><p>第二段<span>内容</span></p></div>`, {runScripts:'outside-only'});
        Object.defineProperty(dom.window.HTMLElement.prototype,'isContentEditable',{get(){return this.getAttribute('contenteditable')==='true';}});
        const page={typeText:vi.fn(),evaluate:script=>dom.window.eval(script)};
        try {
            await expect(fillVerified(page,'.editor','第一段\n\n第二段内容')).resolves.toBeUndefined();
            await expect(fillVerified(page,'.editor','第一段\n第二段内容')).rejects.toMatchObject({code:'FIELD_MISMATCH'});
        } finally {dom.window.close();}
    });
    it.each([
        ['视频上传中断！服务异常，请稍后重试', 'SITE_BLOCKED'],
        ['无法访问此网站 ERR_CONNECTION_CLOSED', 'SITE_UNREACHABLE'],
    ])('detects the actual page failure: %s', async (text, code) => {
        const dom = new JSDOM(`<body>${text}</body>`, { runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        const page = { evaluate: script => dom.window.eval(script), wait: vi.fn() };
        try { await expect(waitFor(page, 'false', 'upload', 20)).rejects.toMatchObject({ code }); expect(page.wait).not.toHaveBeenCalled(); }
        finally { dom.window.close(); }
    });
});
