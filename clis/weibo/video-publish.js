/** Publish a Weibo video through the logged-in upload page. Dry-run by default. */
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { getSelfUid, unwrapEvaluateResult } from './utils.js';
import { __test__ as publishTest } from './publish.js';

const UPLOAD_URL = 'https://weibo.com/upload/channel';
const FILE_INPUT_SELECTOR = '[data-bycli-weibo-video-input="1"]';
const TITLE_LIMIT = 30;

function preview(kwargs) {
    const text = publishTest.validateText(kwargs?.text);
    const video = publishTest.validateVideoPath(kwargs?.video);
    return { text, video };
}

async function evaluate(page, js) {
    return unwrapEvaluateResult(await page.evaluate(js));
}

function clickExactJs(text) {
    return `(() => { const wanted = ${JSON.stringify(text)}; const el = [...document.querySelectorAll('button, a, label, span, div')].reverse().find((node) => node.offsetParent !== null && (node.innerText || '').trim() === wanted); if (!el) return false; el.click(); return true; })()`;
}

async function waitFor(page, ready, label, seconds = 30) {
    for (let i = 0; i < seconds; i++) {
        const state = await evaluate(page, ready);
        if (state?.ok) return state;
        if (state?.error) throw new CommandExecutionError(state.error);
        await page.wait({ time: 1 });
    }
    throw new CommandExecutionError(label);
}

/** Weibo creates a detached file input when 上传视频 is clicked. Keep that input and skip the OS dialog. */
async function armVideoInput(page) {
    const armed = await evaluate(page, `(() => {
        const orig = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {
            if (this.type === 'file' && !this.isConnected) {
                this.setAttribute('data-bycli-weibo-video-input', '1');
                document.body.appendChild(this);
                return;
            }
            return orig.apply(this, arguments);
        };
        const button = document.querySelector('[id^="video_button_upload"]');
        if (!button) { HTMLInputElement.prototype.click = orig; return false; }
        button.click();
        HTMLInputElement.prototype.click = orig;
        return !!document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)});
    })()`);
    if (!armed) throw new CommandExecutionError('Could not open the Weibo video file picker. The upload page may still be loading.');
}

async function chooseDeclaration(page, aiGenerated) {
    const option = aiGenerated ? '含AI生成内容' : '我的内容无需声明';
    const opened = await evaluate(page, clickExactJs('请进行内容声明（必填）'));
    if (!opened) throw new CommandExecutionError('Could not open the Weibo content declaration');
    await page.wait({ time: 0.5 });
    const picked = await evaluate(page, clickExactJs(option));
    if (!picked) throw new CommandExecutionError(`Could not choose content declaration: ${option}`);
    const confirmed = await evaluate(page, `(() => { const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.innerText || '').trim() === '确定'); const button = buttons[buttons.length - 1]; if (!button) return false; button.click(); return true; })()`);
    if (!confirmed) throw new CommandExecutionError('Could not confirm the Weibo content declaration');
}

export async function runWeiboVideoPublish(page, kwargs) {
    const checked = preview(kwargs);
    const execute = kwargs?.execute === true || kwargs?.execute === 'true';
    const aiGenerated = kwargs?.['ai-generated'] === true || kwargs?.['ai-generated'] === 'true';
    if (!execute) {
        return [{ status: 'dry-run', message: 'Preview only; pass --execute after manual confirmation to publish.', text: checked.text, video: checked.video }];
    }
    if (!page) throw new CommandExecutionError('Browser session required for weibo video-publish');

    await page.goto('https://weibo.com', { waitUntil: 'load', settleMs: 2000 });
    try { await getSelfUid(page); } catch (error) {
        if (error instanceof AuthRequiredError) throw error;
        throw new CommandExecutionError('Not logged into Weibo. Please login at weibo.com first.');
    }
    await page.goto(`${UPLOAD_URL}?_=${Date.now()}`, { waitUntil: 'load', settleMs: 1500 });
    await waitFor(page, `(() => ({ ok: !!document.querySelector('[id^="video_button_upload"]') }))()`, 'Weibo video upload page did not load', 20);
    await page.wait({ time: 1.5 });
    await armVideoInput(page);
    if (typeof page.uploadFiles === 'function') await page.uploadFiles(FILE_INPUT_SELECTOR, [checked.video]);
    else {
        await page.setFileInput([checked.video], FILE_INPUT_SELECTOR);
        await evaluate(page, `(() => { const el = document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)}); if (!el) return false; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    }

    await waitFor(page, `(() => {
        const text = document.body?.innerText || '';
        if (/文件大小不能超过|验证失败|上传失败|格式不支持/.test(text)) return { error: text.replace(/\\s+/g, ' ').slice(0, 300) };
        const ready = text.includes('上传完成') && [...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && (b.innerText || '').trim() === '发布');
        return { ok: ready };
    })()`, 'Video upload did not complete before timeout', 180);

    if (!await evaluate(page, clickExactJs('原创'))) throw new CommandExecutionError('Could not choose video type 原创');
    await chooseDeclaration(page, aiGenerated);
    const title = [...checked.text].slice(0, TITLE_LIMIT).join('');
    const filled = await evaluate(page, `(() => {
        const titleInput = document.querySelector('input[placeholder="填写标题（0～30个字）"]');
        if (!titleInput) return 'no-title';
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(titleInput, ${JSON.stringify(title)});
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        const area = [...document.querySelectorAll('textarea')].reverse().find((node) => node.offsetParent !== null);
        if (area) {
            const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setArea.call(area, ${JSON.stringify(checked.text)});
            area.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return 'ok';
    })()`);
    if (filled !== 'ok') throw new CommandExecutionError('Could not fill the Weibo video title');

    const published = await evaluate(page, `(() => { const button = [...document.querySelectorAll('button')].reverse().find((b) => b.offsetParent !== null && !b.disabled && (b.innerText || '').trim() === '发布'); if (!button) return false; button.click(); return true; })()`);
    if (!published) throw new CommandExecutionError('Could not click the Weibo video publish button');

    const result = await waitFor(page, `(() => {
        const text = document.body?.innerText || '';
        if (/视频已上传成功|发布成功/.test(text)) return { ok: true, message: '视频已上传成功，将在转码后发布' };
        if (/请选择类型后再发布|请添加内容声明|发布失败/.test(text)) return { error: text.replace(/\\s+/g, ' ').slice(0, 300) };
        return null;
    })()`, 'Weibo video publish result was unclear. Check 视频管理 manually; do not retry automatically.', 30);

    return [{ status: 'success', message: result.message, text: checked.text, video: checked.video }];
}

cli({
    site: 'weibo', name: 'video-publish', access: 'write', description: 'Publish a Weibo video post (dry-run by default)',
    domain: 'weibo.com', strategy: Strategy.UI, browser: true,
    args: [
        { name: 'text', type: 'string', required: true, positional: true, help: 'Post text (max 2000 characters; the first 30 become the video title)' },
        { name: 'video', type: 'string', required: true, help: 'Video path (mp4/mov/m4v/webm)' },
        { name: 'ai-generated', type: 'boolean', default: false, help: 'Declare the video as 含AI生成内容. The default declaration is 我的内容无需声明' },
        { name: 'execute', type: 'boolean', default: false, help: 'Actually publish after manual confirmation' },
        { name: 'timeout', type: 'int', default: 300, help: 'Max seconds for the whole run, including video upload' },
    ],
    columns: ['status', 'message', 'text', 'video'],
    func: (page, kwargs) => runWeiboVideoPublish(page, kwargs),
});

export const __test__ = { preview, runWeiboVideoPublish };
