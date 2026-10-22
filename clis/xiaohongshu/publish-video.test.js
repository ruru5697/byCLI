import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { xhsPreparedSnapshot, prepareXhsVideo, waitForXhsCoverReplacement } from './publish-video.js';

describe('Xiaohongshu video preparation', () => {
    it('does not report an enabled publish control as a completed publication', () => {
        const dom = new JSDOM(`<input placeholder="填写标题会有更多赞哦" value="预研请勿发布"><div class="tiptap ProseMirror">正文</div>
            <div class="cover--row"><div class="default" style="background-image:url(test.png);aspect-ratio:1.33 / 1"></div></div>
            <div class="d-select">添加内容类型声明</div><div>公开可见</div><xhs-publish-btn submit-disabled="false"></xhs-publish-btn>`, { runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100 });
        try {
            const result = dom.window.eval(`(${xhsPreparedSnapshot.toString()})()`);
            expect(result).toMatchObject({ publishEnabled: true, customCoverPresent: true, visibilityPublic: true, videoReady: false });
            expect(result).not.toHaveProperty('published');
        } finally { dom.window.close(); }
    });
    it('reads the selected portrait cover and ignores recommendation thumbnails', () => {
        const dom = new JSDOM(`<div class="cover--column"><div class="default column" style="background-image:url(selected.png);aspect-ratio:0.75 / 1"></div><div class="recommend"><div class="default" style="background-image:url(recommended.png)"></div></div></div>`, { runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        try {
            expect(dom.window.eval(`(${xhsPreparedSnapshot.toString()})()`)).toMatchObject({customCoverPresent:true,coverAspectRatio:'0.75 / 1'});
            dom.window.document.querySelector('.cover--column > .default').remove();
            expect(dom.window.eval(`(${xhsPreparedSnapshot.toString()})()`)).toMatchObject({customCoverPresent:false});
        } finally { dom.window.close(); }
    });
    it('waits until the main cover actually changes after the crop dialog closes', async () => {
        const dom = new JSDOM(`<body><div class="cover--column"><div class="default" style="background-image:url(old.png)"></div></div></body>`, { runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        const old = dom.window.document.querySelector('.default').style.backgroundImage;
        const page = {evaluate:vi.fn(script=>dom.window.eval(script)),wait:vi.fn(async()=>{dom.window.document.querySelector('.default').style.backgroundImage='url(new.png)';})};
        try {expect(await waitForXhsCoverReplacement(page,old)).toBe(true);expect(page.wait).toHaveBeenCalledTimes(1);} finally {dom.window.close();}
    });
    it('reads multiline plain text from ProseMirror paragraphs including intentional empty lines', () => {
        const dom=new JSDOM(`<div class="tiptap ProseMirror"><p>第一段</p><p><br></p><p>第二段</p></div>`,{runScripts:'outside-only'});
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {get(){return this.textContent;}});
        try {expect(dom.window.eval(`(${xhsPreparedSnapshot.toString()})()`).body).toBe('第一段\n\n第二段');} finally {dom.window.close();}
    });
    it('refuses to replace an existing editor before uploading any file', async () => {
        const page = { goto: vi.fn(), focusWindow: vi.fn(), evaluate: vi.fn().mockResolvedValue(true), setFileInput: vi.fn() };
        await expect(prepareXhsVideo(page, {}, vi.fn())).rejects.toMatchObject({ code: 'EXISTING_EDITOR' });
        expect(page.setFileInput).not.toHaveBeenCalled();
    });
});
