import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { compareDraftText, normalizeDraftText, runToutiaoSaveDraft } from './save-draft.js';

let COVER = '';
beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toutiao-draft-'));
    COVER = path.join(dir, 'cover.jpg');
    await fs.writeFile(COVER, 'fake-jpeg-bytes');
});
afterAll(async () => {
    if (COVER) await fs.rm(path.dirname(COVER), { recursive: true, force: true });
});

const TITLE = '拆解 Grok Bot 技术架构';
const BODY = '先说一个容易被忽略的细节。\n\n第二段内容。';

function makePage(overrides = {}) {
    const state = { restoredTitle: TITLE, restoredBody: BODY, coverCount: 1, url: 'https://mp.toutiao.com/profile_v4/graphic/publish' };
    const page = {
        goto: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
        click: vi.fn(async () => {}),
        fillText: vi.fn(async () => ({ actual: TITLE })),
        typeText: vi.fn(async () => {}),
        setFileInput: vi.fn(async () => {}),
        evaluate: vi.fn(async (code) => {
            const src = String(code);
            if (src.includes('bodyLength')) return { title: state.existingTitle ?? '', bodyLength: state.existingBodyLength ?? 0 };
            if (src.includes('location.href') && !src.includes('titleEl')) return state.url;
            if (src.includes('titleEl')) return { title: state.restoredTitle, body: state.restoredBody, coverCount: state.coverCount, url: state.url };
            return true;
        }),
        ...overrides,
    };
    return { page, state };
}

describe('toutiao save-draft', () => {
    it('rejects a title outside 2-30 characters before touching the browser', async () => {
        const page = { goto: vi.fn() };
        await expect(runToutiaoSaveDraft(page, { title: '短', content: BODY })).rejects.toBeInstanceOf(ArgumentError);
        await expect(runToutiaoSaveDraft(page, { title: 'x'.repeat(31), content: BODY })).rejects.toBeInstanceOf(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('rejects empty content', async () => {
        await expect(runToutiaoSaveDraft({}, { title: TITLE, content: '   ' })).rejects.toBeInstanceOf(ArgumentError);
    });

    it('requires a browser session', async () => {
        await expect(runToutiaoSaveDraft(null, { title: TITLE, content: BODY })).rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('reports auth when the editor is missing', async () => {
        const page = { goto: vi.fn(async () => {}), wait: vi.fn(async () => {}), evaluate: vi.fn(async () => false) };
        await expect(runToutiaoSaveDraft(page, { title: TITLE, content: BODY })).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('saves, reloads and confirms the restored draft', async () => {
        const { page } = makePage();
        const [result] = await runToutiaoSaveDraft(page, { title: TITLE, content: BODY });
        expect(result).toMatchObject({ status: 'draft_saved', submitted: false, title: TITLE, contentLength: BODY.length });
        expect(page.goto).toHaveBeenCalledTimes(2);
        expect(page.fillText).toHaveBeenCalledWith('textarea[placeholder*="请输入文章标题"]', TITLE);
        expect(page.typeText).toHaveBeenCalledWith('[contenteditable="true"]', BODY);
    });

    it('never clicks a publish control', async () => {
        const { page } = makePage();
        await runToutiaoSaveDraft(page, { title: TITLE, content: BODY });
        const clickedPublish = page.click.mock.calls.some(([selector]) => /发布/.test(String(selector)));
        const evaluatedPublish = page.evaluate.mock.calls.some(([code]) => /预览并发布/.test(String(code)));
        expect(clickedPublish).toBe(false);
        expect(evaluatedPublish).toBe(false);
    });

    it('fails when the reloaded body does not match', async () => {
        const { page, state } = makePage();
        state.restoredBody = '被改掉的正文';
        await expect(runToutiaoSaveDraft(page, { title: TITLE, content: BODY })).rejects.toThrow(/Draft body differs/);
    });

    it('fails when the reloaded title does not match', async () => {
        const { page, state } = makePage();
        state.restoredTitle = '另一个标题';
        await expect(runToutiaoSaveDraft(page, { title: TITLE, content: BODY })).rejects.toThrow(/Draft title was not restored/);
    });

    it('requires the cover to survive the reload when it was applied', async () => {
        const { page, state } = makePage();
        state.coverCount = 0;
        await expect(runToutiaoSaveDraft(page, { title: TITLE, content: BODY, cover: COVER }))
            .rejects.toThrow(/cover was not restored/);
    });

    it('saves the draft and reports the cover when the uploader never confirms', async () => {
        const { page, state } = makePage();
        state.coverCount = 0;
        page.evaluate = vi.fn(async (code) => {
            const src = String(code);
            if (src.includes('bodyLength')) return { title: '', bodyLength: 0 };
            if (src.includes('location.href') && !src.includes('titleEl')) return state.url;
            if (src.includes('titleEl')) return { title: state.restoredTitle, body: state.restoredBody, coverCount: 0, url: state.url };
            if (src.includes('article-cover-add')) return true;
            if (src.includes("labels")) return false; // 确认按钮始终没出现
            return true;
        });
        const [result] = await runToutiaoSaveDraft(page, { title: TITLE, content: BODY, cover: COVER });
        expect(result.status).toBe('draft_saved');
        expect(String(result.cover)).toContain('confirm_missing');
    });

    it('fails on an unapplied cover only when --require-cover is set', async () => {
        const { page, state } = makePage();
        state.coverCount = 0;
        page.evaluate = vi.fn(async (code) => {
            const src = String(code);
            if (src.includes('bodyLength')) return { title: '', bodyLength: 0 };
            if (src.includes('location.href') && !src.includes('titleEl')) return state.url;
            if (src.includes('titleEl')) return { title: state.restoredTitle, body: state.restoredBody, coverCount: 0, url: state.url };
            if (src.includes('article-cover-add')) return true;
            if (src.includes("labels")) return false;
            return true;
        });
        await expect(runToutiaoSaveDraft(page, { title: TITLE, content: BODY, cover: COVER, 'require-cover': true }))
            .rejects.toThrow(/Cover upload did not complete/);
    });

    it('refuses to overwrite an existing draft without --replace', async () => {
        const { page, state } = makePage();
        state.existingTitle = '旧草稿标题';
        state.existingBodyLength = 42;
        await expect(runToutiaoSaveDraft(page, { title: TITLE, content: BODY })).rejects.toThrow(/already holds a draft/);
        expect(page.fillText).not.toHaveBeenCalled();
    });

    it('clears the editor first when --replace is explicit', async () => {
        const { page, state } = makePage();
        state.existingTitle = '旧草稿标题';
        state.existingBodyLength = 42;
        const [result] = await runToutiaoSaveDraft(page, { title: TITLE, content: BODY, replace: true });
        expect(result.status).toBe('draft_saved');
        expect(page.fillText).toHaveBeenCalled();
    });

    it('tolerates whitespace drift from the platform autosave', () => {
        expect(compareDraftText('a\n\nb', 'a\nb').ok).toBe(true);
        expect(normalizeDraftText(' 一 二 ')).toBe(' 一 二 ');expect(compareDraftText('do not execute','donotexecute').ok).toBe(false);
        const mismatch = compareDraftText('hello world', 'hello there');
        expect(mismatch.ok).toBe(false);
        expect(mismatch.offset).toBe(6);
    });
});


describe('Toutiao draft validation regressions',()=>{
 it('requires a cover path when the CLI requires a cover',async()=>{
  const page={goto:vi.fn()};
  await expect(runToutiaoSaveDraft(page,{title:TITLE,content:BODY,'require-cover':true})).rejects.toThrow('--require-cover needs --cover');
  expect(page.goto).not.toHaveBeenCalled();
 });
 it('resolves relative cover paths before injection',async()=>{
  const {page}=makePage();
  await runToutiaoSaveDraft(page,{title:TITLE,content:BODY,cover:path.relative(process.cwd(),COVER)});
  expect(page.setFileInput).toHaveBeenCalledWith([COVER],'.upload-image-panel input[type="file"]');
 });
 it('detects loss of word spacing after reload',async()=>{
  const {page,state}=makePage();state.restoredBody='donotexecute';
  await expect(runToutiaoSaveDraft(page,{title:TITLE,content:'do not execute'})).rejects.toThrow('Draft body differs');
 });
 it('does not confirm a button outside the cover upload panel',async()=>{
  const {JSDOM}=await import('jsdom');
  const dom=new JSDOM('<button id="other">保存</button><div class="upload-image-panel"><button id="cover">确定</button></div>',{runScripts:'outside-only'});
  const clicked=[];
  for(const button of dom.window.document.querySelectorAll('button')){Object.defineProperty(button,'innerText',{get:()=>button.textContent});Object.defineProperty(button,'offsetParent',{value:dom.window.document.body});button.addEventListener('click',()=>clicked.push(button.id));}
  const {page}=makePage(),original=page.evaluate;
  page.evaluate=vi.fn(async code=>code.includes('const labels =')?dom.window.eval(code):original(code));
  try{await runToutiaoSaveDraft(page,{title:TITLE,content:BODY,cover:COVER});expect(clicked).toEqual(['cover']);}
  finally{dom.window.close();}
 });
});
