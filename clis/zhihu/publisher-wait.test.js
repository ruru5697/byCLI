import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from '@sovovs/bycli/logger';
import { manageDraft, prepareDraft } from './_shared/publisher.js';

const id = '2095901655401231129';
const open = [], dirs = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const dom of open.splice(0)) dom.window.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'zhihu-wait-')); dirs.push(dir);
    const op = { version: 1, site: 'zhihu', kind: 'video', operation_id: randomUUID(), created_at: '2026-10-20T00:00:00Z',
        title: '指定视频标题', body: '正文不应写入诊断日志', ai_generated: 'yes', original: 'yes', category: '其他', images: [], image_count: 0,
        draft_id: id, draft_type: 'pin', editor_url: `https://www.zhihu.com/upload-video?id=${id}`, author_identity: 'test-owner',
        browser_target: 'retained', submitted: false, verified: true, status: 'draft_verified' };
    const file = join(dir, 'operation.json'); await writeFile(file, JSON.stringify(op));
    // Synthetic UI uses the video editor's scoped controls; no live publication.
    const dom = new JSDOM(`<main><input type="file" accept=".mp4"><span id="upload-state">上传成功</span>
        <textarea name="title">${op.title}</textarea><div class="public-DraftEditor-content" contenteditable="true">${op.body}</div>
        <div><label>视频标记</label><button aria-haspopup="true">含 AI 生成内容</button></div>
        <div class="VideoUploadForm-item"><label class="VideoUploadForm-itemTitle">原创视频</label><input type="checkbox" checked></div>
        <div class="VideoUploadForm-item"><label class="VideoUploadForm-itemTitle">所属领域</label><button role="combobox">其他</button></div>
        <div class="DraftStatusTip">刚刚 · 草稿</div><button>发布视频</button></main>`, { url: op.editor_url, runScripts: 'outside-only' });
    open.push(dom);
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const progress = vi.spyOn(log, 'info').mockImplementation(() => {});
    const page = {
        goto: vi.fn(async url => dom.reconfigure({ url })), focusWindow: vi.fn(), getActivePage: () => 'retained',
        startNetworkCapture: vi.fn(async () => true), setActivePage: vi.fn(),
        evaluate: async script => script.startsWith('(async function accountDOM') ? { status: 200, slug: 'test-owner' } : dom.window.eval(script),
        wait: vi.fn(async seconds => { now += seconds * 1000; await page.onWait?.(now - 1000); }),
        click: vi.fn(async () => { throw Error('Unexpected button click'); }), uploadFiles: vi.fn(),
    };
    return { dir, file, op, dom, page, progress, elapsed: () => now - 1000,
        title: dom.window.document.querySelector('textarea'), tip: dom.window.document.querySelector('.DraftStatusTip') };
}
const reopen = f => manageDraft(f.page, { operation: f.file, mode: 'reopen', execute: true, timeout: 600 }, 'video');

describe('draft verification waits', () => {
    it('reports a stable saved-title mismatch in 5s instead of waiting 600s, keeping the exact draft', async () => {
        const f = await fixture(); f.title.value = 'video';
        await expect(reopen(f)).rejects.toThrow('mismatched_fields=title');
        expect(f.elapsed()).toBe(5000);
        const saved = JSON.parse(await readFile(f.file));
        expect(saved).toMatchObject({ draft_id: id, submitted: false, verified: false, status: 'draft_saved',
            verification_error: { stage: 'reopen-content', code: 'COMMAND_EXEC' } });
        expect(saved.message).toContain('stable for 5s');
        expect(f.page.click).not.toHaveBeenCalled(); expect(f.page.uploadFiles).not.toHaveBeenCalled();
        expect(f.progress.mock.calls.flat().join('\n')).not.toContain(f.op.body);
    });

    it('waits for actual saving and emits progress before accepting the matching persisted contents', async () => {
        const f = await fixture(); f.title.value = 'video'; f.tip.textContent = '草稿保存中';
        f.page.onWait = elapsed => { if (elapsed >= 20000) { f.title.value = f.op.title; f.tip.textContent = '刚刚 · 草稿'; } };
        expect((await reopen(f))[0]).toMatchObject({ status: 'draft_verified', verified: true, submitted: false });
        expect(f.elapsed()).toBe(20000);
        expect(f.progress.mock.calls.flat().join('\n')).toContain('15s elapsed');
        expect(f.page.click).not.toHaveBeenCalled(); expect(f.page.uploadFiles).not.toHaveBeenCalled();
    });

    it('allows a briefly stale title to finish loading without silently changing it', async () => {
        const f = await fixture(); f.title.value = 'video';
        f.page.onWait = elapsed => { if (elapsed >= 3000) f.title.value = f.op.title; };
        expect((await reopen(f))[0].verified).toBe(true);
        expect(f.elapsed()).toBe(3000); expect(f.page.click).not.toHaveBeenCalled();
    });

    it('restarts the stable-mismatch grace period when the actual contents change', async () => {
        const f = await fixture(); f.title.value = 'video-A';
        f.page.onWait = elapsed => { if (elapsed === 4000) f.title.value = 'video-B'; };
        await expect(reopen(f)).rejects.toThrow('mismatched_fields=title');
        expect(f.elapsed()).toBe(9000);
    });

    it('allows the known creator-to-editor navigation transition, then checks the exact draft', async () => {
        const f = await fixture();
        f.page.goto = vi.fn(async () => f.dom.reconfigure({ url: 'https://www.zhihu.com/creator' }));
        f.page.onWait = () => f.dom.reconfigure({ url: f.op.editor_url });
        expect((await reopen(f))[0]).toMatchObject({ draft_id: id, verified: true });
        expect(f.elapsed()).toBe(500);
    });

    it.each(['https://example.com/', 'https://www.zhihu.com/signin'])('does not treat %s as a navigation grace page', async url => {
        const f = await fixture(); f.page.goto = vi.fn(async () => f.dom.reconfigure({ url }));
        await expect(reopen(f)).rejects.toThrow(url.includes('signin') ? 'Not logged in' : 'wrong_editor');
        expect(f.elapsed()).toBe(0); expect(f.page.click).not.toHaveBeenCalled();
    });

    it('bounds the creator transition to 5s even when the upload timeout is 600s', async () => {
        const f = await fixture();
        f.page.goto = vi.fn(async () => f.dom.reconfigure({ url: 'https://www.zhihu.com/creator' }));
        await expect(reopen(f)).rejects.toThrow('wrong_editor'); expect(f.elapsed()).toBe(5000);
    });

    it('reports an explicit save failure immediately', async () => {
        const f = await fixture(); f.tip.textContent = '草稿保存失败';
        await expect(reopen(f)).rejects.toThrow('platform reports draft save failure');
        expect(f.elapsed()).toBe(0); expect(f.page.click).not.toHaveBeenCalled();
    });

    it('includes the stage and last observed fields when genuine saving reaches its timeout', async () => {
        const f = await fixture(); f.title.value = 'video'; f.tip.textContent = '草稿保存中';
        await expect(manageDraft(f.page, { operation: f.file, mode: 'reopen', execute: true, timeout: 2 }, 'video'))
            .rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('reopen-content'), hint: expect.stringContaining('save=saving') });
        expect(JSON.parse(await readFile(f.file))).toMatchObject({ verified: false, verification_error: { code: 'TIMEOUT' } });
    });

    it('persists an observed native draft ID before a later title mismatch and never reuploads it', async () => {
        const f = await fixture(); await rm(f.file); f.title.value = '';
        const doc = f.dom.window.document;
        doc.querySelector('[contenteditable]').textContent = ''; doc.querySelector('#upload-state').textContent = '';
        f.dom.reconfigure({ url: 'https://www.zhihu.com/upload-video' });
        let uploaded = false;
        f.page.uploadFiles = vi.fn(async () => { uploaded = true; f.title.value = 'video'; doc.querySelector('#upload-state').textContent = '上传成功'; });
        f.page.fillText = async (selector, text) => {
            const el = doc.querySelector(selector);
            if (el.tagName === 'TEXTAREA') el.value = text;
            else { el.textContent = text; f.title.value = 'video'; }
            return { verified: true };
        };
        f.page.readNetworkCapture = async () => uploaded ? [{ url: 'https://api.zhihu.com/content/drafts', method: 'POST', responseStatus: 200,
            timestamp: Date.now(), responsePreview: JSON.stringify({ code: 0, data: { draft_type: 'pin', content_id: id } }) }] : [];
        const video = join(f.dir, 'video.mp4'); await writeFile(video, 'synthetic video');
        const args = { video, title: f.op.title, text: f.op.body, 'ai-generated': 'yes', original: 'yes', category: '其他',
            operation: f.file, execute: true, timeout: 600 };
        await expect(prepareDraft(f.page, args, 'video')).rejects.toThrow('mismatched_fields=title');
        expect(JSON.parse(await readFile(f.file))).toMatchObject({ draft_id: id, draft_type: 'pin', editor_url: f.op.editor_url, submitted: false, verified: false });
        await prepareDraft(f.page, args, 'video');
        expect(f.page.uploadFiles).toHaveBeenCalledTimes(1); expect(f.page.click).not.toHaveBeenCalled();
    });
});
