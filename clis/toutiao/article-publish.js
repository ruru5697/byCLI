import fs from 'node:fs/promises';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

const TITLE_SELECTOR = 'textarea[placeholder*="请输入文章标题"]';
const EDITOR_SELECTOR = '[contenteditable="true"]';

async function readContent(kwargs) {
    const direct = String(kwargs?.content ?? '').trim();
    const file = String(kwargs?.contentFile ?? kwargs?.['content-file'] ?? '').trim();
    if (direct && file) throw new ArgumentError('use either --content or --content-file, not both');
    if (file) return String(await fs.readFile(file, 'utf8')).trim();
    return direct;
}

export async function runToutiaoArticlePublish(page, kwargs) {
    const title = String(kwargs?.title ?? '').trim();
    const content = await readContent(kwargs);
    const execute = Boolean(kwargs?.execute);
    if (title.length < 2 || title.length > 30) throw new ArgumentError('title must contain 2-30 characters');
    if (!content) throw new ArgumentError('article content cannot be empty');
    if (!execute) return [{ status: 'dry-run', title, contentLength: content.length, message: '未执行发布；确认内容后添加 --execute' }];
    if (!page) throw new CommandExecutionError('Browser session required for Toutiao article publish');
    try {
        await page.goto('https://mp.toutiao.com/profile_v4/graphic/publish');
        await page.wait({ time: 3 });
        const loggedIn = await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(TITLE_SELECTOR)}) || document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`);
        if (!loggedIn) throw new AuthRequiredError('mp.toutiao.com');
        if (!page.evaluateWithArgs) throw new CommandExecutionError('Browser extension does not support argumented evaluation');
        let filled = null;
        if (typeof page.fillText === 'function') {
          try {
            const titleResult = await page.fillText('textarea[placeholder*="请输入文章标题"]', title);
            await page.click('[contenteditable="true"]');
            try { await page.typeText('[contenteditable="true"]', content); } catch { /* bridge may report an invocation error after insertion */ }
            filled = { ok: true, title: titleResult?.actual || title, contentLength: content.length };
          } catch { /* fallback below */ }
        }
        if (!filled) filled = await page.evaluateWithArgs(`
(() => {
  const visible = el => !!el && el.offsetParent !== null;
  const titleEl = [...document.querySelectorAll('textarea')].find(el => visible(el) && (el.placeholder || '').includes('请输入文章标题'));
  const editor = [...document.querySelectorAll('[contenteditable]')].find(el => visible(el));
  if (!titleEl || !editor) return { ok: false, message: 'publish editor not found', titleFound: !!titleEl, editorFound: !!editor };
  const titleSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  titleSetter ? titleSetter.call(titleEl, titleText) : (titleEl.value = titleText);
  titleEl.dispatchEvent(new Event('input', { bubbles: true }));
  titleEl.dispatchEvent(new Event('change', { bubbles: true }));
  editor.focus();
  editor.innerHTML = '<p>' + bodyText.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</p>';
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: bodyText }));
  return { ok: true, title: titleEl.value, contentLength: editor.innerText.length };
})()
`, { titleText: title, bodyText: content });
        
        
        if (!filled?.title || filled.contentLength < 1) throw new CommandExecutionError('Could not fill Toutiao article editor');
        const preview = await page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null && !el.disabled;
  const btn = [...document.querySelectorAll('button')].find(el => visible(el) && (el.innerText || '').trim().includes('预览并发布'));
  if (!btn) return { ok: false, message: '预览并发布按钮未找到' };
  btn.click(); return { ok: true };
})()
`);
        if (!preview?.ok) throw new CommandExecutionError(preview?.message || 'Could not open Toutiao preview');
        await page.wait({ time: 2 });
        const dismissedNotice = await page.evaluate(`
(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return false;
  const target = [...dialog.querySelectorAll('*')].find(el => {
    const text = (el.innerText || el.textContent || '').trim();
    return text === '已知悉协议，去了解更多' || text.includes('已知悉协议');
  }) || [...dialog.querySelectorAll('[tabindex]')].at(-1);
  if (!target) return false;
  target.click(); return true;
})()
`);
        if (dismissedNotice) {
            await page.wait({ time: 1 });
            await page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null && !el.disabled;
  const btn = [...document.querySelectorAll('button')].find(el => visible(el) && (el.innerText || '').trim().includes('预览并发布'));
  if (btn) btn.click();
})()
`);
            await page.wait({ time: 2 });
        }
        const submitted = await page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null && !el.disabled;
  const btn = [...document.querySelectorAll('button, [role="button"]')].find(el => visible(el) && (el.innerText || '').trim() === '发布');
  if (!btn) return { ok: false, message: '发布确认按钮未找到，可能需要人工确认' };
  btn.click(); return { ok: true };
})()
`);
        if (!submitted?.ok) throw new CommandExecutionError(submitted?.message || 'Publish result was not confirmed');
        await page.wait({ time: 3 });
        const result = await page.evaluate(`({ url: location.href, text: document.body.innerText.slice(-1200) })`);
        return [{ status: 'submitted', title, contentLength: content.length, url: result?.url || null, message: '已提交；请在作品管理中核对发布状态' }];
    } catch (error) {
        if (error instanceof ArgumentError || error instanceof AuthRequiredError || error instanceof CommandExecutionError) throw error;
        throw new CommandExecutionError(`toutiao article publish failed: ${error?.message || error}`);
    }
}

export const articlePublishCommand = cli({
    site: 'toutiao', name: 'article-publish', access: 'write', description: '发布今日头条文章（默认 dry-run，使用 --execute 才提交）',
    domain: 'mp.toutiao.com', strategy: Strategy.UI, browser: true,
    args: [
        { name: 'title', type: 'string', required: true, positional: true, help: '文章标题（2-30 字）' },
        { name: 'content', type: 'string', help: '文章正文' },
        { name: 'content-file', type: 'string', help: '正文文件路径' },
        { name: 'execute', type: 'boolean', default: false, help: '实际提交发布；不传则仅 dry-run' },
    ],
    columns: ['status', 'title', 'contentLength', 'url', 'message'],
    func: (page, kwargs) => runToutiaoArticlePublish(page, kwargs),
});
