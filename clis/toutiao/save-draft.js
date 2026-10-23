import fs from 'node:fs/promises';
import path from 'node:path';
import { readExistingDraft, readRestoredDraft } from './_draft-page.js';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

const TITLE_SELECTOR = 'textarea[placeholder*="请输入文章标题"]';
const EDITOR_SELECTOR = '[contenteditable="true"]';
const COVER_ADD_SELECTOR = '.article-cover-add';
const COVER_PANEL_INPUT = '.upload-image-panel input[type="file"]';

/** Toutiao may add blank lines; spaces inside a paragraph remain significant. */
export function normalizeDraftText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').split('\n').filter(line => line !== '').join('\n');
}

export function compareDraftText(expected, actual) {
    const a = normalizeDraftText(expected);
    const b = normalizeDraftText(actual);
    if (a === b) return { ok: true, offset: -1, context: '' };
    let offset = 0;
    const max = Math.min(a.length, b.length);
    while (offset < max && a[offset] === b[offset]) offset += 1;
    return { ok: false, offset, context: JSON.stringify(b.slice(Math.max(0, offset - 20), offset + 40)) };
}

async function readContent(kwargs) {
    const direct = String(kwargs?.content ?? '').trim();
    const file = String(kwargs?.contentFile ?? kwargs?.['content-file'] ?? '').trim();
    if (direct && file) throw new ArgumentError('use either --content or --content-file, not both');
    if (file) return String(await fs.readFile(file, 'utf8')).trim();
    return direct;
}

async function uploadCover(page, coverPath) {
    const opened = await page.evaluate(`
(() => {
  const el = document.querySelector(${JSON.stringify(COVER_ADD_SELECTOR)});
  if (!el) return false;
  el.click();
  return true;
})()
`);
    if (!opened) return { state: 'control_missing', debug: { opened } };
    await page.wait({ time: 3 });
    let before = await page.evaluate(`
(() => ({
  panelInputs: document.querySelectorAll('.upload-image-panel input[type="file"]').length,
  allInputs: document.querySelectorAll('input[type="file"]').length,
  panelVisible: !!document.querySelector('.upload-image-panel'),
}))()
`);
    try {
        await page.setFileInput([coverPath], COVER_PANEL_INPUT);
        await page.wait({ time: 1 });
        const attached = await page.evaluate(`
(() => {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  return inputs.map((el, i) => ({ i, files: el.files ? el.files.length : -1, names: el.files ? [...el.files].map(f => f.name) : [] }));
})()
`).catch(() => null);
        before = { ...(before && typeof before === 'object' ? before : {}), attached };
    } catch (error) {
        return { state: 'upload_failed', debug: { before, error: String(error?.message || error).slice(0, 120) } };
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await page.wait({ time: 3 });
        const confirmed = await page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null && !el.disabled;
  const labels = ['确定', '确认', '完成', '保存'];
  const btn = [...(document.querySelector('.upload-image-panel')?.querySelectorAll('button, [class*="btn"]') || [])].find(el => visible(el) && labels.includes((el.innerText || '').trim()));
  if (!btn) return false;
  btn.click();
  return true;
})()
`);
        if (confirmed) {
            for (let settle = 0; settle < 5; settle += 1) {
                await page.wait({ time: 2 });
                const applied = await page.evaluate(`
(() => [...document.querySelectorAll('.article-cover-images img, .article-cover img')].some(el => el.naturalWidth > 0))()
`);
                if (applied) return { state: 'applied', debug: { before, attempt, settle } };
            }
            return { state: 'confirm_clicked_without_preview', debug: { before, attempt } };
        }
    }
    const after = await page.evaluate(`
(() => ({
  imgs: [...document.querySelectorAll('.upload-image-panel img')].filter(el => el.naturalWidth > 0).length,
  buttons: [...document.querySelectorAll('button')].filter(el => el.offsetParent !== null).map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 10),
}))()
`);
    return { state: 'confirm_missing', debug: { before, after } };
}

export async function runToutiaoSaveDraft(page, kwargs) {
    const title = String(kwargs?.title ?? '').trim();
    const content = await readContent(kwargs);
    const coverInput = String(kwargs?.cover ?? '').trim();
    const cover = coverInput ? path.resolve(coverInput) : '';
    const replace = kwargs?.replace === true;
    if (title.length < 2 || title.length > 30) throw new ArgumentError('title must contain 2-30 characters');
    if (!content) throw new ArgumentError('article content cannot be empty');
    if ((kwargs?.['require-cover'] ?? kwargs?.requireCover) === true && !cover) throw new ArgumentError('--require-cover needs --cover');
    if (cover) {
        const stat = await fs.stat(cover).catch(() => null);
        if (!stat?.isFile() || !stat.size) throw new ArgumentError(`cover file not found: ${coverInput}`);
    }
    if (!page) throw new CommandExecutionError('Browser session required for Toutiao draft save');
    try {
        await page.goto('https://mp.toutiao.com/profile_v4/graphic/publish');
        await page.wait({ time: 3 });
        const loggedIn = await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(TITLE_SELECTOR)}) || document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`);
        if (!loggedIn) throw new AuthRequiredError('mp.toutiao.com');
        if (typeof page.fillText !== 'function' || typeof page.typeText !== 'function') {
            throw new CommandExecutionError('Browser extension does not support text filling');
        }
        const existing = await readExistingDraft(page);
        const hasExisting = Boolean(existing?.title) || Number(existing?.bodyLength || 0) > 0;
        if (hasExisting && !replace) {
            throw new CommandExecutionError(
                'Editor already holds a draft; pass --replace true to overwrite it, or clear the editor first',
            );
        }
        if (hasExisting && replace) {
            await page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null;
  const titleEl = [...document.querySelectorAll('textarea')].find(el => visible(el) && (el.placeholder || '').includes('请输入文章标题'));
  const editor = [...document.querySelectorAll('[contenteditable]')].find(el => visible(el));
  if (titleEl) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter ? setter.call(titleEl, '') : (titleEl.value = '');
    titleEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (editor) {
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }
  return true;
})()
`);
            await page.wait({ time: 1 });
        }
        await page.fillText(TITLE_SELECTOR, title);
        await page.click(EDITOR_SELECTOR);
        try {
            await page.typeText(EDITOR_SELECTOR, content);
        } catch {
            // The bridge may report an invocation error after insertion; the reload check below decides.
        }
        let coverState = 'none';
        let coverDebug = null;
        if (cover) {
            const upload = await uploadCover(page, cover);
            coverState = upload.state;
            coverDebug = upload.debug;
            if (coverState !== 'applied' && (kwargs?.['require-cover'] ?? kwargs?.requireCover) === true) {
                throw new CommandExecutionError(`Cover upload did not complete (${coverState}) ${JSON.stringify(coverDebug)}`);
            }
        }
        // Blur so the editor commits its model, then let the platform autosave.
        await page.click(TITLE_SELECTOR);
        await page.wait({ time: 8 });
        const draftUrl = await page.evaluate('location.href');
        if (!/mp\.toutiao\.com\/profile_v4\/graphic\/publish/.test(String(draftUrl))) {
            throw new CommandExecutionError('Unexpected editor URL after filling');
        }
        await page.goto(draftUrl);
        await page.wait({ time: 8 });
        const restored = await readRestoredDraft(page);
        if (String(restored.title || '').trim() !== title) {
            throw new CommandExecutionError('Draft title was not restored after reload; draft not confirmed');
        }
        const comparison = compareDraftText(content, restored.body);
        if (!comparison.ok) {
            throw new CommandExecutionError(`Draft body differs after reload at offset ${comparison.offset}; restored ${comparison.context}`);
        }
        if (coverState === 'applied' && !restored.coverCount) {
            throw new CommandExecutionError('Draft cover was not restored after reload; draft not confirmed');
        }
        return [{
            status: 'draft_saved',
            title,
            contentLength: content.length,
            restoredLength: String(restored.body || '').length,
            cover: coverState === 'applied' ? 'restored' : (cover ? `${coverState} ${JSON.stringify(coverDebug)}` : 'none'),
            url: draftUrl,
            submitted: false,
            message: '草稿已自动保存并重开核对；未提交发布',
        }];
    } catch (error) {
        if (error instanceof ArgumentError || error instanceof AuthRequiredError || error instanceof CommandExecutionError) throw error;
        throw new CommandExecutionError(`toutiao draft save failed: ${error?.message || error}`);
    }
}

export const saveDraftCommand = cli({
    site: 'toutiao', name: 'save-draft', access: 'write',
    description: '保存今日头条文章草稿：填充后等待平台自动保存，重开核对；不会提交发布',
    domain: 'mp.toutiao.com', strategy: Strategy.UI, browser: true,
    args: [
        { name: 'title', type: 'string', required: true, positional: true, help: '文章标题（2-30 字）' },
        { name: 'content', type: 'string', help: '文章正文' },
        { name: 'content-file', type: 'string', help: '正文文件路径' },
        { name: 'cover', type: 'string', help: '封面图片路径（可选）' },
        { name: 'replace', type: 'boolean', default: false, help: '编辑器已有草稿时先清空再填充' },
        { name: 'require-cover', type: 'boolean', default: false, help: '封面未成功应用时直接失败' },
    ],
    columns: ['status', 'title', 'contentLength', 'restoredLength', 'cover', 'url', 'submitted', 'message'],
    func: (page, kwargs) => runToutiaoSaveDraft(page, kwargs),
});
