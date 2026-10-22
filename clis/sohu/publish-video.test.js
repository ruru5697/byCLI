import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { sohuPreparedSnapshot, prepareSohuVideo } from './publish-video.js';

describe('Sohu preparation snapshot and entry guard', () => {
    it('reads the selected values and does not confuse unchecked declarations with selected ones', () => {
        const dom = new JSDOM(`<input class="titleErrorInput" value="预研请勿发布"><textarea class="abstract-main-textarea">测试正文</textarea>
            <div class="pic-cover" style="background-image:url(test.png)"></div><div class="channel-select-row"><span class="select-text">科技</span><span class="select-text">电脑</span></div>
            <label class="el-radio"><input type="radio" checked>无需声明</label><label class="el-radio"><input type="radio">含有AI生成内容</label>
            <div>视频上传成功！视频时长：00:00:05</div><div>您今天还能发 5 篇视频</div><button>发布</button>`, { runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100 });
        try {
            expect(dom.window.eval(`(${sohuPreparedSnapshot.toString()})()`)).toMatchObject({ videoUploaded: true, customCoverPresent: true,
                category: ['科技', '电脑'], declarations: ['无需声明'], quota: 5, videoDuration: '00:00:05', publishControlPresent: true });
        } finally { dom.window.close(); }
    });
    it('refuses to replace an existing editor before uploading any file', async () => {
        const page = { goto: vi.fn(), focusWindow: vi.fn(), evaluate: vi.fn().mockResolvedValue(true), setFileInput: vi.fn() };
        await expect(prepareSohuVideo(page, {}, vi.fn())).rejects.toMatchObject({ code: 'EXISTING_EDITOR' });
        expect(page.setFileInput).not.toHaveBeenCalled();
    });
});
