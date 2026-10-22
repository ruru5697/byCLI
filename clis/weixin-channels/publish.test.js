import { log } from '@sovovs/bycli/logger';
import { coverScript, localCover } from './_shared/cover.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { publishVideo, videoStatus } from './_shared/publish.js';
import { publishWait } from './_shared/wait.js';
import * as coverModule from './_shared/cover.js';
vi.mock('./_shared/cover.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, configureCover: vi.fn(actual.configureCover), verifyCover: vi.fn(actual.verifyCover) };
});
import { previewFingerprintDOM, publishScript } from './_shared/publish-dom.js';

const retrieval = vi.hoisted(() => ({ posts: [], calls: [] }));
vi.mock('./_shared/client.js', () => ({
  fetchPosts: async (...args) => { retrieval.calls.push(['posts', ...args.slice(1)]); return retrieval.posts; },
  fetchPostDetail: async (...args) => {
    retrieval.calls.push(['detail', ...args.slice(1)]);
    return { data: { feedData: [{ totalData: {}, dataByTabtype: [] }], notExistFansData: true }, retention: { items: [], videoLen: 3, maxLostRateSec: 0 } };
  },
}));

beforeEach(async () => {
  const actual = await vi.importActual('./_shared/cover.js');
  vi.mocked(coverModule.configureCover).mockReset().mockImplementation(actual.configureCover);
  vi.mocked(coverModule.verifyCover).mockReset().mockImplementation(actual.verifyCover);
});

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bycli-channels-')); retrieval.posts = []; retrieval.calls = []; });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

// Synthetic UI contract, not a captured/live acceptance fixture.
function browser(block = '') {
  const dom = new JSDOM('<wujie-app></wujie-app>', { url: 'https://channels.weixin.qq.com/platform/post/create', runScripts: 'outside-only' });
  const root = dom.window.document.querySelector('wujie-app').attachShadow({ mode: 'open' });
  root.innerHTML = `<input type="file" accept="video/*" hidden><video></video><div contenteditable="true"></div>
    <div><span>视频标注</span></div><div><div class="selected">选择视频标注</div><div class="options" hidden><div>含AI生成内容</div><div>无需标注</div></div></div>
    <button>发表</button><button id="save-draft">保存草稿</button><div class="result"></div><div>${block}</div>`;
  const selected = root.querySelector('.selected'), options = root.querySelector('.options');
  // JSDOM does not invalidate style caches for mutations in shadow roots.
  const render = () => dom.window.document.body.setAttribute('data-render', String(Math.random()));
  selected.addEventListener('click', () => { options.hidden = false; render(); });
  for (const option of options.children) option.addEventListener('click', () => { selected.textContent = option.textContent; options.hidden = true; render(); });
  let clicks = 0, uploads = 0, saves = 0, target = 'retained-page';
  root.querySelector('#save-draft').addEventListener('click', () => {
    saves++;
    root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove());
    const draftId = 'export/saved_fixture';
    const wrap = dom.window.document.createElement('div'); wrap.className = 'post-edit-wrap';
    wrap.__vue__ = { $props: { postStore: { defaultValue: { objectId: draftId }, tempPost: { objectId: draftId } } } }; root.append(wrap);
    const card = dom.window.document.createElement('div'); card.className = 'post-draft-item';
    card.__vue__ = { $props: { post: { objectId: draftId, desc: { description: root.querySelector('[contenteditable]').innerText } } } };
    const edit = dom.window.document.createElement('span'); edit.className = 'icon-edit';
    edit.addEventListener('click', () => dom.reconfigure({ url: 'https://channels.weixin.qq.com/platform/post/create' }));
    card.append(edit); root.append(card);
  });
  dom.window.performance.getEntriesByType = () => saves ? [{ name: 'https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_draft', startTime: Date.now() - dom.window.performance.timeOrigin, responseEnd: 1 }] : [];
  root.querySelector('button').addEventListener('click', () => { clicks++; root.querySelector('.result').textContent = '发表成功'; });
  const page = {
    withAcceptedDialogs: vi.fn(async (_origin, run) => run()),
    goto: vi.fn(async url => dom.reconfigure({ url })), getActivePage: () => target, setActivePage: vi.fn(value => { target = value; }),
    evaluate: async js => dom.window.eval(js), wait: async () => {},
    startNetworkCapture: async () => true,
    readNetworkCapture: async () => saves ? [{ url: 'https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_draft', method: 'POST', responseStatus: 201, timestamp: Date.now(), responsePreview: JSON.stringify({ errCode: 0, data: { objectId: 'export/saved_fixture' } }) }] : [],
    uploadFiles: async () => { uploads++; Object.defineProperties(root.querySelector('video'), { readyState: { value: 1 }, duration: { value: 3 } }); },
    fillText: async (sel, text) => { root.querySelector(sel).innerText = text; return { filled: true, verified: true }; },
    click: async sel => { root.querySelector(sel).click(); },
  };
  return { page, root, clicks: () => clicks, uploads: () => uploads, saves: () => saves };
}
async function args() {
  const file = join(dir, 'video.mp4'); await writeFile(file, 'local video fixture');
  return { file, description: '固定的验证说明', 'ai-generated': 'yes', operation: join(dir, 'operation.json'), execute: true, timeout: 1 };
}

// Minimal synthetic management cards; fields follow the observed UI backing data.
function managementBrowser(records) {
  const dom = new JSDOM('<wujie-app></wujie-app>', { url: 'https://channels.weixin.qq.com/platform/post/list', runScripts: 'outside-only' });
  const root = dom.window.document.querySelector('wujie-app').attachShadow({ mode: 'open' });
  for (const record of records) {
    const card = dom.window.document.createElement('div'); card.className = 'post-feed-item';
    card.__vue__ = { $props: { post: record } }; root.append(card);
  }
  const page = { goto: vi.fn(async url => dom.reconfigure({ url })),
    evaluate: vi.fn(async script => dom.window.eval(script)), wait: async () => {},
    getCurrentUrl: async () => dom.window.location.href };
  return { page, root };
}

describe('video publishing lifecycle', () => {
  it.each(['/login', '/login/', '/login.html', '/login.html?redirect=%2Fplatform%2Fpost%2Fcreate'])('classifies %s as authentication before attempting upload', async path => {
    const ui = browser(), a = await args(), navigate = ui.page.goto.getMockImplementation();
    ui.page.goto.mockImplementation(async () => navigate('https://channels.weixin.qq.com' + path));
    await expect(publishVideo(ui.page, a)).rejects.toMatchObject({ code: 'AUTH_REQUIRED', exitCode: 77 });
    await expect(readFile(a.operation)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ui.uploads()).toBe(0); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
  });
  it.each(['/login.htmlx', '/login-extra'])('does not turn an unrelated %s path into a login pause', async path => {
    const ui = browser(), a = await args(), navigate = ui.page.goto.getMockImplementation();
    ui.page.goto.mockImplementation(async () => navigate('https://channels.weixin.qq.com' + path));
    await expect(publishVideo(ui.page, a)).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    await expect(readFile(a.operation)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ui.uploads()).toBe(0);
  });
  it('continues the first upload after login on the same operation, then refuses a second prepare upload', async () => {
    const ui = browser(), a = await args(), navigate = ui.page.goto.getMockImplementation();
    const video = ui.root.querySelector('video'), upload = ui.page.uploadFiles; video.remove();
    ui.page.uploadFiles = async (...args) => { ui.root.append(video); return upload(...args); };
    ui.page.goto.mockImplementation(async () => navigate('https://channels.weixin.qq.com/login.html'));
    await legacyLoginOperation(ui, a);
    const original = JSON.parse(await readFile(a.operation, 'utf8'));
    // A second auth pause retains the same operation without selecting a file.
    await expect(publishVideo(ui.page, a)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(ui.uploads()).toBe(0);
    ui.page.goto.mockImplementation(navigate);
    const [row] = await publishVideo(ui.page, a);
    expect(row).toMatchObject({ operation_id: original.operation_id, status: 'prepared', submitted: false });
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(op.upload_attempted).toBe(true); expect(op.authentication_required).toBeUndefined();
    await publishVideo(ui.page, a);
    expect(ui.uploads()).toBe(1); expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('continues in an already empty retained editor without refreshing it', async () => {
    const ui = browser(), a = await args(), navigate = ui.page.goto.getMockImplementation();
    const video = ui.root.querySelector('video'), upload = ui.page.uploadFiles; video.remove();
    ui.page.uploadFiles = async (...args) => { ui.root.append(video); return upload(...args); };
    ui.page.goto.mockImplementation(async () => navigate('https://channels.weixin.qq.com/login.html'));
    await legacyLoginOperation(ui, a);
    await navigate('https://channels.weixin.qq.com/platform/post/create');
    ui.page.goto.mockImplementation(navigate); ui.page.goto.mockClear();
    expect((await publishVideo(ui.page, a))[0]).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.page.goto.mock.calls.every(([url]) => url.includes('/platform/post/draftListManager'))).toBe(true);
    expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it.each(['video', 'description', 'ai', 'populated-editor'])('rejects login continuation when %s changed', async reason => {
    const ui = browser(), a = await args(), navigate = ui.page.goto.getMockImplementation();
    ui.page.goto.mockImplementation(async () => navigate('https://channels.weixin.qq.com/login.html'));
    await legacyLoginOperation(ui, a);
    ui.page.goto.mockImplementation(navigate); ui.page.goto.mockClear();
    const retry = { ...a };
    if (reason === 'video') await writeFile(a.file, 'changed video bytes');
    if (reason === 'description') retry.description = 'different content';
    if (reason === 'ai') retry['ai-generated'] = 'no';
    if (reason === 'populated-editor') {
      await navigate('https://channels.weixin.qq.com/platform/post/create');
      ui.root.querySelector('video').remove();
      ui.root.querySelector('[contenteditable]').innerText = 'keep my work';
    }
    await expect(publishVideo(ui.page, retry)).rejects.toThrow();
    expect(ui.page.goto).not.toHaveBeenCalled();
    expect(ui.uploads()).toBe(0); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
  });
  it('journals upload intent before the RPC and cannot treat a lost upload reply as a login-only pause', async () => {
    const ui = browser(), a = await args();
    ui.page.uploadFiles = vi.fn(async () => {
      expect(JSON.parse(await readFile(a.operation, 'utf8')).upload_attempted).toBe(true);
      throw new Error('upload reply lost');
    });
    await expect(publishVideo(ui.page, a)).rejects.toThrow('upload reply lost');
    await publishVideo(ui.page, a);
    expect(ui.page.uploadFiles).toHaveBeenCalledTimes(1); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
  });
  it('does not reopen a legacy authentication record without durable proof of no upload attempt', async () => {
    const ui = browser(), a = await args(), navigate = ui.page.goto.getMockImplementation();
    ui.page.goto.mockImplementation(async () => navigate('https://channels.weixin.qq.com/login.html'));
    await legacyLoginOperation(ui, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8')); delete op.upload_attempted;
    await writeFile(a.operation, JSON.stringify(op)); ui.page.goto.mockClear();
    await publishVideo(ui.page, a);
    expect(ui.page.goto).not.toHaveBeenCalled(); expect(ui.uploads()).toBe(0);
  });
  it('waits for native draft saving to become enabled after default cover generation, then saves once', async () => {
    const ui = browser(), a = { ...await args(), timeout: 10 };
    const button = ui.root.querySelector('#save-draft'); button.disabled = true;
    const pending = ui.root.ownerDocument.createElement('span'); pending.textContent = '封面生成中'; ui.root.append(pending);
    let polls = 0;
    ui.page.wait = async () => {
      if (ui.root.querySelector('.selected').textContent === '含AI生成内容' && ++polls === 3) {
        button.disabled = false; pending.remove(); ui.root.ownerDocument.body.setAttribute('data-render', 'covers-ready');
      }
    };
    const [row] = await publishVideo(ui.page, a);
    expect(row.status).toBe('prepared'); expect(polls).toBeGreaterThanOrEqual(3);
    expect(ui.saves()).toBe(1); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('bounds waiting for a disabled native save control without attempting save, reupload or publication', async () => {
    const ui = browser(), a = { ...await args(), timeout: 900 };
    ui.root.querySelector('#save-draft').disabled = true;
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(log, 'info').mockImplementation(() => {});
    ui.page.wait = async seconds => { now += seconds * 1000; };
    await expect(publishVideo(ui.page, a)).rejects.toThrow('draft-save-control: no progress');
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(op.draft_save_attempted).toBeUndefined(); expect(op.wait_error.stage).toBe('draft-save-control');
    expect(now).toBeLessThan(70000); expect(ui.saves()).toBe(0); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('resumes a completed native cover gesture without manual confirmation, input replay or discarding retained edits', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8')), win = ui.root.ownerDocument.defaultView;
    win.TextEncoder = TextEncoder; Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle });
    const wrap = win.document.createElement('div'); wrap.className = 'cover-preview-wrap';
    wrap.innerHTML = '<div class="horizon-cover-wrap"><img class="horizon-img-size" src="https://finder.video.qq.com/file?encfilekey=original_h&idx=1"></div><div class="vertical-cover-wrap"><img class="vertical-img-size" src="https://finder.video.qq.com/file?encfilekey=default_v&idx=1"></div>';
    ui.root.append(wrap);
    for (const img of wrap.querySelectorAll('img')) Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    const original = await win.eval(coverScript('status', op.operation_id));
    wrap.querySelector('.horizon-img-size').src = 'https://finder.video.qq.com/file?encfilekey=uploaded_h&idx=1';
    const image = join(dir, 'cover.jpg'); await writeFile(image, Buffer.from([255, 216, 255, 224]));
    op.cover = { sources: { horizontal: await localCover(image) }, phase: 'confirm_unknown', role: 'horizontal',
      originalIdentities: original.cards, activation: { role: 'horizontal', action: 'confirm', method: 'native-pointer-once', status: 'dispatch_unknown' } };
    await writeFile(a.operation, JSON.stringify(op)); ui.page.goto.mockClear();
    ui.page.nativeClickOnce = vi.fn();
    const [row] = await publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true, timeout: 10 });
    const saved = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(row.status).toBe('prepared'); expect(saved.cover.saved).toBe(true);
    expect(saved.cover.activation.status).toBe('verified'); expect(saved.cover.manual_confirmations).toBeUndefined();
    expect(ui.page.nativeClickOnce).not.toHaveBeenCalled();
    expect(ui.saves()).toBe(2); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('reconciles a completed ambiguous cover save by read-only reopen, without restoring AI or repeating a write', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8')), win = ui.root.ownerDocument.defaultView;
    win.TextEncoder = TextEncoder; Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle });
    const wrap = win.document.createElement('div'); wrap.className = 'cover-preview-wrap';
    wrap.innerHTML = '<div class="horizon-cover-wrap"><img class="horizon-img-size" src="https://finder.video.qq.com/file?encfilekey=uploaded_h&idx=1"></div><div class="vertical-cover-wrap"><img class="vertical-img-size" src="https://finder.video.qq.com/file?encfilekey=default_v&idx=1"></div>';
    ui.root.append(wrap);
    for (const img of wrap.querySelectorAll('img')) Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    const state = await win.eval(coverScript('status', op.operation_id));
    op.cover = { sources: { horizontal: { path: join(dir, 'cover.jpg'), sha256: 'a'.repeat(64) } },
      phase: 'configured', identities: { horizontal: state.cards.horizontal }, save_attempted: true, save_started_at: new Date(1).toISOString() };
    op.status = 'draft_save_unknown'; await writeFile(a.operation, JSON.stringify(op));
    ui.root.querySelector('.selected').textContent = '选择视频标注';
    win.document.body.setAttribute('data-render', 'reset-ai');
    const [row] = await videoStatus(ui.page, { operation: a.operation, 'inspect-editor': true });
    const saved = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(row.status).toBe('draft_saved'); expect(saved.cover.saved).toBe(true);
    expect(saved.native_draft_receipt.id).toBe(op.source_draft_id);
    expect(ui.root.querySelector('.selected').textContent).toBe('选择视频标注');
    expect(ui.saves()).toBe(1); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('retains an uploaded video and useful journal diagnostics when processing stops progressing', async () => {
    const ui = browser(), a = { ...await args(), timeout: 900 };
    vi.spyOn(log, 'info').mockImplementation(() => {});
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    ui.page.wait = async seconds => { now += seconds * 1000; };
    ui.page.uploadFiles = vi.fn();
    await expect(publishVideo(ui.page, a)).rejects.toThrow('Video preparation');
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(op).toMatchObject({ status: 'processing', submitted: false, file_selected: true,
      wait: { stage: 'video-processing', status: 'interrupted' },
      wait_error: { stage: 'video-processing', code: 'TIMEOUT' } });
    expect(now).toBeGreaterThanOrEqual(901000); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
    await publishVideo(ui.page, a); expect(ui.page.uploadFiles).toHaveBeenCalledTimes(1);
  });
  it('allows a video with increasing upload progress to take longer than the idle budget', async () => {
    const ui = browser(), a = { ...await args(), timeout: 900 };
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const progress = ui.root.ownerDocument.createElement('progress'); progress.max = 100; progress.value = 0; ui.root.append(progress);
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const video = ui.root.querySelector('video');
    ui.page.uploadFiles = vi.fn();
    ui.page.wait = async seconds => {
      now += seconds * 1000; progress.value = Math.min(100, Math.floor((now - 1000) / 1000));
      if (now >= 91000) Object.defineProperties(video, { readyState: { value: 1, configurable: true }, duration: { value: 3, configurable: true } });
    };
    const [row] = await publishVideo(ui.page, a);
    expect(row).toMatchObject({ status: 'prepared', submitted: false, editor: { wait: { status: 'completed' } } });
    expect(now).toBeGreaterThanOrEqual(91000); expect(ui.page.uploadFiles).toHaveBeenCalledTimes(1);
    expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('persists a native draft, reopens its exact card and awaits confirmation without publishing', async () => {
    const ui = browser(), a = await args();
    const [row] = await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(row).toMatchObject({ status: 'prepared', submitted: false });
    expect(op).toMatchObject({ source_draft_id: 'export/saved_fixture', draft_save_attempted: true });
    expect(op.draft_verified_at).toBeTruthy(); expect(op.user_confirmed_at).toBeUndefined();
    expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'submit', execute: true })).rejects.toThrow('--user-confirmed');
    await publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true, timeout: 1 });
    expect(ui.saves()).toBe(1); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('retains an unknown save without uploading, saving or publishing again', async () => {
    const ui = browser(), a = await args(), original = ui.page.click;
    ui.page.click = async selector => {
      if (selector.includes('save-draft')) {
        expect(JSON.parse(await readFile(a.operation, 'utf8'))).toMatchObject({ status: 'draft_save_unknown', submitted: false, draft_save_attempted: true });
        throw Error('save transport lost');
      }
      return original(selector);
    };
    await expect(publishVideo(ui.page, a)).rejects.toThrow('save transport lost');
    ui.page.click = vi.fn();
    await publishVideo(ui.page, a);
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true, timeout: 1 })).rejects.toThrow(/receipt unknown|timed out/);
    expect(ui.page.click).not.toHaveBeenCalled(); expect(ui.uploads()).toBe(1);
  });
  it('rejects legacy preview-only operations even when submission is confirmed', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8')); delete op.source_draft_id;
    await writeFile(a.operation, JSON.stringify(op));
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'submit', execute: true, 'user-confirmed': true })).rejects.toThrow('saved and verified platform draft');
    expect(ui.clicks()).toBe(0);
  });
  it.each(['cover', 'vertical-cover'])('rejects a new %s source on an existing saved operation before touching the browser', async flag => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const image = join(dir, 'replacement.jpg'); await writeFile(image, Buffer.from([255, 216, 255, 1]));
    ui.page.goto.mockClear();
    await expect(publishVideo(ui.page, { ...a, [flag]: image })).rejects.toThrow('different cover');
    expect(ui.page.goto).not.toHaveBeenCalled(); expect(ui.saves()).toBe(1); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it.each(['opening', 'upload_unknown', 'confirm_unknown', 'partial'])('retains the current editor on an interrupted %s cover update', async phase => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.cover = { sources: { vertical: { path: join(dir, 'portrait.jpg'), sha256: 'a'.repeat(64) } },
      phase: phase === 'partial' ? 'pending' : phase, completedRoles: phase === 'partial' ? { horizontal: 'already-configured' } : {} };
    await writeFile(a.operation, JSON.stringify(op)); ui.page.goto.mockClear();
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true })).rejects.toThrow(/retained editor|nonempty local/);
    expect(ui.page.goto).not.toHaveBeenCalled(); expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it.each(['upload_unknown', 'completed', 'activation', 'save', 'source-changed'])('does not reopen an interrupted draft with %s evidence', async reason => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    const image = join(dir, 'cover.jpg'); await writeFile(image, Buffer.from([255, 216, 255, 224]));
    op.cover = { sources: { horizontal: await localCover(image) }, phase: 'opening', role: 'horizontal', completedRoles: {} };
    if (reason === 'upload_unknown') op.cover.phase = 'upload_unknown';
    if (reason === 'completed') op.cover.completedRoles.horizontal = 'changed';
    if (reason === 'activation') op.cover.activation = { action: 'confirm' };
    if (reason === 'save') op.cover.save_attempted = true;
    if (reason === 'source-changed') await writeFile(image, Buffer.from([255, 216, 255, 225]));
    await writeFile(a.operation, JSON.stringify(op)); ui.page.goto.mockClear();
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'resume', 'resume-cover-opening': 'horizontal', 'reopen-saved-draft': true, execute: true })).rejects.toThrow();
    expect(ui.page.goto).not.toHaveBeenCalled(); expect(ui.saves()).toBe(1); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('reopens only the exact saved draft and configures a not-yet-uploaded cover after the original page is gone', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8')), win = ui.root.ownerDocument.defaultView;
    win.TextEncoder = TextEncoder; Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle });
    const wrap = win.document.createElement('div'); wrap.className = 'cover-preview-wrap';
    wrap.innerHTML = `<div class="horizon-cover-wrap"><div class="horizon-img-wrap"><img class="horizon-img-size" src="https://finder.video.qq.com/file?encfilekey=original_h&idx=1"><div class="edit-btn">编辑</div></div></div>
      <div class="vertical-cover-wrap"><img class="vertical-img-size" src="https://finder.video.qq.com/file?encfilekey=default_v&idx=1"></div>
      <div class="weui-desktop-dialog" hidden><h3>编辑分享卡片</h3><div class="single-cover-uploader-wrap"><input type="file" accept="image/png"><img class="img-wrap"></div><div class="preview-item"><img src="data:image/jpeg;base64,AAAA"></div><div class="cover-set-footer"><button>确认</button></div></div>`;
    ui.root.append(wrap);
    for (const img of wrap.querySelectorAll('img')) Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    const dialog = wrap.querySelector('.weui-desktop-dialog');
    const data = { isVideoInitialized: true, useCustomCover: false, currentCoverImageUrl: '', customCoverPreviewUrl: '' };
    const editor = { $options: { name: 'EditCoverDialog' }, $data: data };
    dialog.__vue__ = editor;
    wrap.querySelector('.preview-item').__vue__ = { $parent: editor, $options: { methods: { getOriginalCanvas() {} } },
      $props: { get imageUrl() { return data.currentCoverImageUrl; } },
      $data: { isCroppieReady: true, get lastImageUrl() { return data.currentCoverImageUrl; } } };
    const render = () => win.document.body.setAttribute('data-render', String(Math.random()));
    wrap.querySelector('.edit-btn').onclick = () => { dialog.hidden = false; render(); };
    const button = wrap.querySelector('button'); button.getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 30 });
    win.document.elementFromPoint = () => button;
    button.onclick = () => { dialog.hidden = true; wrap.querySelector('.horizon-img-size').src = 'https://finder.video.qq.com/file?encfilekey=custom_h&idx=1'; render(); };
    ui.page.nativeClickOnce = vi.fn(async () => button.onclick()); ui.page.evaluateOnce = ui.page.evaluate;
    let coverUploads = 0;
    ui.page.uploadFiles = async (selector, files) => {
      coverUploads++; wrap.querySelector('.img-wrap').src = 'data:image/jpeg;base64,' + (await readFile(files[0])).toString('base64');
      data.currentCoverImageUrl = data.customCoverPreviewUrl = wrap.querySelector('.img-wrap').src; data.useCustomCover = true; render();
    };
    const original = await win.eval(coverScript('status', op.operation_id));
    const image = join(dir, 'cover.jpg'); await writeFile(image, Buffer.from([255, 216, 255, 224]));
    op.cover = { sources: { horizontal: await localCover(image) }, phase: 'opening', role: 'horizontal', originalIdentities: original.cards, completedRoles: {} };
    op.target = 'gone-page'; await writeFile(a.operation, JSON.stringify(op)); ui.page.goto.mockClear();
    const [row] = await publishVideo(ui.page, { operation: a.operation, mode: 'resume', 'resume-cover-opening': 'horizontal', 'reopen-saved-draft': true, execute: true, timeout: 10 });
    const saved = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(row).toMatchObject({ status: 'prepared', submitted: false }); expect(saved.cover.saved).toBe(true);
    expect(saved.source_draft_id).toBe(op.source_draft_id); expect(saved.target).not.toBe('gone-page');
    expect(saved.cover.recoveries[0]).toMatchObject({ method: 'exact-saved-draft-before-upload', previous_target: 'gone-page' });
    expect(coverUploads).toBe(1); expect(ui.uploads()).toBe(1); expect(ui.saves()).toBe(2); expect(ui.clicks()).toBe(0);
  });
  it('refuses publication if a recorded custom cover is not saved or its editor identity is unavailable', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.cover = { path: join(dir, 'cover.jpg'), sha256: 'a'.repeat(64), phase: 'configured', saved: false };
    await writeFile(a.operation, JSON.stringify(op));
    const submit = { operation: a.operation, mode: 'submit', execute: true, 'user-confirmed': true };
    await expect(publishVideo(ui.page, submit)).rejects.toThrow('has not been saved');
    op.cover.saved = true; await writeFile(a.operation, JSON.stringify(op));
    await expect(publishVideo(ui.page, submit)).rejects.toThrow('Cover editor unavailable');
    expect(ui.clicks()).toBe(0); expect(JSON.parse(await readFile(a.operation, 'utf8')).submitted).toBe(false);
  });
  it('adopts an exact existing platform draft without uploading or changing content, then submits once', async () => {
    const ui = browser(), a = await args(), draftId = 'export/precise_draft';
    Object.defineProperties(ui.root.querySelector('video'), { readyState: { value: 4 }, duration: { value: 175 } });
    ui.root.querySelector('[contenteditable]').innerText = a.description;
    // A real saved draft can reopen with this declaration cleared.
    ui.root.querySelector('.selected').textContent = '选择视频标注';
    const wrap = ui.root.ownerDocument.createElement('div'); wrap.className = 'post-edit-wrap';
    wrap.__vue__ = { $props: { postStore: { defaultValue: { objectId: draftId }, tempPost: { objectId: draftId } } } }; ui.root.append(wrap);
    const adopt = { operation: a.operation, mode: 'adopt-draft', 'draft-id': draftId, 'editor-page': 'A4BDE4E421777B2A9B81569BE866DC32',
      'editor-session': 'saved-draft', description: a.description, 'ai-generated': 'yes', execute: true };
    const [row] = await publishVideo(ui.page, adopt);
    expect(row).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.uploads()).toBe(0); expect(ui.clicks()).toBe(0);
    expect(JSON.parse(await readFile(a.operation, 'utf8')).source_draft_id).toBe(draftId);
    expect((await publishVideo(ui.page, adopt))[0].operation_id).toBe(row.operation_id);
    await publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true });
    await publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true });
    expect(ui.clicks()).toBe(1); expect(ui.uploads()).toBe(0);
  });
  it.each(['identity', 'description', 'cover'])('rejects saved draft adoption with changed %s', async reason => {
    const ui = browser(), a = await args(), draftId = 'export/precise_draft';
    Object.defineProperties(ui.root.querySelector('video'), { readyState: { value: 4 }, duration: { value: 175 } });
    ui.root.querySelector('[contenteditable]').innerText = reason === 'description' ? 'different' : a.description;
    ui.root.querySelector('.selected').textContent = reason === 'ai' ? '无需标注' : '含AI生成内容';
    if (reason === 'cover') ui.root.querySelector('.result').textContent = '封面生成中';
    const wrap = ui.root.ownerDocument.createElement('div'); wrap.className = 'post-edit-wrap';
    wrap.__vue__ = { $props: { postStore: { defaultValue: { objectId: draftId }, tempPost: { objectId: reason === 'identity' ? 'export/other' : draftId } } } }; ui.root.append(wrap);
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'adopt-draft', 'draft-id': draftId, 'editor-page': 'A4BDE4E421777B2A9B81569BE866DC32',
      'editor-session': 'saved-draft', description: a.description, 'ai-generated': 'yes', execute: true })).rejects.toThrow('saved draft');
    expect(ui.clicks()).toBe(0); expect(ui.uploads()).toBe(0);
    await expect(readFile(a.operation)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('recovers an explicitly selected restarted page only after hashing its exact local preview', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.status = 'preparation_unknown'; delete op.source_draft_id; delete op.draft_save_attempted; ui.root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove()); await writeFile(a.operation, JSON.stringify(op));
    const win = ui.root.ownerDocument.defaultView, data = await readFile(a.file);
    Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle });
    win.fetch = vi.fn(async () => ({ ok: true, blob: async () => ({ size: data.length, arrayBuffer: async () => data }) }));
    ui.root.querySelector('video').src = 'blob:https://channels.weixin.qq.com/local-preview';
    ui.root.ownerDocument.documentElement.removeAttribute('data-bycli-channels-operation');
    ui.root.querySelector('[contenteditable]').innerText = '';
    const target = 'A4BDE4E421777B2A9B81569BE866DC32';
    const [row] = await publishVideo(ui.page, { operation: a.operation, mode: 'recover', 'editor-page': target, 'editor-session': 'restarted', execute: true, timeout: 1 });
    expect(row).toMatchObject({ operation_id: op.operation_id, status: 'prepared', description: a.description, submitted: false });
    const fresh = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(fresh.target).toBe(target); expect(fresh.recoveries[0].sha256).toBe(op.sha256);
    expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('rejects a restarted preview with a different hash without rebinding or uploading', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.status = 'preparation_unknown'; delete op.source_draft_id; delete op.draft_save_attempted; ui.root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove()); await writeFile(a.operation, JSON.stringify(op));
    const win = ui.root.ownerDocument.defaultView;
    Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle });
    win.fetch = async () => ({ ok: true, blob: async () => ({ size: 3, arrayBuffer: async () => Buffer.from('bad') }) });
    ui.root.querySelector('video').src = 'blob:https://channels.weixin.qq.com/different-preview';
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'recover', 'editor-page': 'A4BDE4E421777B2A9B81569BE866DC32', 'editor-session': 'restarted', execute: true })).rejects.toThrow('hash_mismatch');
    expect(JSON.parse(await readFile(a.operation, 'utf8')).target).toBe(op.target);
    expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('never fetches remote media and bounds recovery hash memory', async () => {
    const ui = browser(), win = ui.root.ownerDocument.defaultView;
    Object.defineProperty(ui.root.querySelector('video'), 'readyState', { value: 1 });
    ui.root.querySelector('video').src = 'https://finder.video.qq.com/remote';
    win.fetch = vi.fn();
    expect(await win.eval(`(${previewFingerprintDOM.toString()})()`)).toMatchObject({ error: 'unique_local_preview_required' });
    expect(win.fetch).not.toHaveBeenCalled();
    ui.root.querySelector('video').src = 'blob:https://channels.weixin.qq.com/large-preview';
    const arrayBuffer = vi.fn(); win.fetch = async () => ({ ok: true, blob: async () => ({ size: 257 * 1024 * 1024, arrayBuffer }) });
    expect(await win.eval(`(${previewFingerprintDOM.toString()})()`)).toMatchObject({ error: 'preview_hash_size_limit_256MiB' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it('prepares an open-shadow editor, then submits only once, without claiming publication', async () => {
    const ui = browser(), a = await args();
    expect((await publishVideo(ui.page, a))[0]).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.clicks()).toBe(0);
    expect(ui.uploads()).toBe(1);
    const row = (await publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true }))[0];
    expect(row).toMatchObject({ status: 'submitted', submitted: true, id: null });
    expect(ui.page.setActivePage).toHaveBeenCalledWith('retained-page');
    await publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true });
    await publishVideo(ui.page, a);
    expect(ui.clicks()).toBe(1); expect(ui.uploads()).toBe(1);
  });
  it('writes unknown state before a click that crashes, and refuses to submit again', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    ui.page.click = async () => {
      expect(JSON.parse(await readFile(a.operation, 'utf8'))).toMatchObject({ status: 'submit_unknown', submitted: true });
      throw Error('transport lost');
    };
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true })).rejects.toThrow('transport lost');
    ui.page.click = vi.fn();
    expect((await publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true }))[0].status).toBe('submit_unknown');
    expect(ui.page.click).not.toHaveBeenCalled();
  });
  it.each(['', 'plaintext-only'])('recognizes a valid contenteditable=%s description editor', async value => {
    const ui = browser(), a = await args();
    ui.root.querySelector('[contenteditable]').setAttribute('contenteditable', value);
    expect((await publishVideo(ui.page, a))[0]).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.uploads()).toBe(1);
  });
  it('resumes editing in the retained uploaded page without navigation or another upload', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.status = 'preparation_unknown'; delete op.source_draft_id; delete op.draft_save_attempted; ui.root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove()); await writeFile(a.operation, JSON.stringify(op));
    ui.root.querySelector('[contenteditable]').innerText = '';
    ui.page.goto.mockClear();
    expect((await publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true }))[0]).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.page.goto.mock.calls.every(([url]) => url.includes('draftListManager'))).toBe(true); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('retries only an explicitly requested identical upload in the empty original page, preserving operation identity', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.status = 'upload_not_started'; op.upload = { effect: 'none' }; delete op.source_draft_id; delete op.draft_save_attempted; ui.root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove()); await writeFile(a.operation, JSON.stringify(op));
    ui.root.querySelector('video').remove(); ui.root.querySelector('[contenteditable]').innerText = '';
    const video = ui.root.ownerDocument.createElement('video');
    const originalUpload = ui.page.uploadFiles;
    ui.page.uploadFiles = async (...input) => { ui.root.append(video); return originalUpload(...input); };
    ui.page.goto.mockClear();
    const [row] = await publishVideo(ui.page, { file: a.file, operation: a.operation, mode: 'retry-upload', 'editor-page': 'A4BDE4E421777B2A9B81569BE866DC32', 'editor-session': 'restarted', execute: true, timeout: 1 });
    expect(row).toMatchObject({ operation_id: op.operation_id, description: a.description, status: 'prepared', submitted: false });
    expect(ui.uploads()).toBe(2); expect(ui.clicks()).toBe(0); expect(ui.page.goto.mock.calls.every(([url]) => url.includes('draftListManager'))).toBe(true);
    expect(JSON.parse(await readFile(a.operation, 'utf8')).upload_retries).toHaveLength(1);
    expect(JSON.parse(await readFile(a.operation, 'utf8')).editor_session).toBe('restarted');
  });
  it.each(['preview', 'different-file', 'submitted'])('refuses explicit upload retry with %s', async reason => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.status = 'preparation_unknown'; delete op.source_draft_id; delete op.draft_save_attempted; ui.root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove()); if (reason === 'submitted') op.submitted = true;
    await writeFile(a.operation, JSON.stringify(op));
    if (reason !== 'preview') { ui.root.querySelector('video').remove(); ui.root.querySelector('[contenteditable]').innerText = ''; }
    if (reason === 'different-file') await writeFile(a.file, 'changed video');
    await expect(publishVideo(ui.page, { file: a.file, operation: a.operation, mode: 'retry-upload', execute: true })).rejects.toThrow();
    expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it('waits for an opening AI menu instead of toggling it closed during opacity animation', async () => {
    const ui = browser(), a = await args();
    const options = ui.root.querySelector('.options'), selected = ui.root.querySelector('.selected');
    let opens = 0, waits = 0;
    selected.addEventListener('click', () => { opens++; options.style.opacity = '0'; });
    ui.page.wait = async () => {
      if (!options.hidden && ++waits >= 3) {
        options.style.opacity = '1';
        ui.root.ownerDocument.body.setAttribute('data-animation', String(waits));
      }
    };
    expect((await publishVideo(ui.page, a))[0].status).toBe('prepared');
    expect(opens).toBe(1); expect(waits).toBeGreaterThanOrEqual(3);
  });
  it('rejects an unverified description before selecting AI or submitting', async () => {
    const ui = browser(), a = await args();
    ui.page.fillText = async () => ({ filled: true, verified: false });
    await expect(publishVideo(ui.page, a)).rejects.toThrow('not verified');
    expect(ui.clicks()).toBe(0);
  });
  it.each(['css-disabled', 'aria-disabled', 'cover-pending'])('does not submit a prepared page with %s', async reason => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    if (reason === 'css-disabled') ui.root.querySelector('button').className = 'weui-desktop-btn_disabled';
    if (reason === 'aria-disabled') ui.root.querySelector('button').setAttribute('aria-disabled', 'true');
    if (reason === 'cover-pending') ui.root.querySelector('.result').textContent = '封面生成中，请等待完成后再发表';
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true })).rejects.toThrow('unambiguous');
    expect(ui.clicks()).toBe(0);
    expect(JSON.parse(await readFile(a.operation, 'utf8')).submitted).toBe(false);
  });
  it.each(['binding', 'text', 'preview', 'submitted'])('rejects recovery after changed %s without uploading', async change => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.status = 'preparation_unknown'; delete op.source_draft_id; delete op.draft_save_attempted; ui.root.querySelectorAll('.post-edit-wrap,.post-draft-item').forEach(e => e.remove());
    if (change === 'binding') ui.root.ownerDocument.documentElement.removeAttribute('data-bycli-channels-operation');
    if (change === 'text') ui.root.querySelector('[contenteditable]').innerText = 'manual edit';
    if (change === 'preview') ui.root.querySelector('video').remove();
    if (change === 'submitted') op.submitted = true;
    await writeFile(a.operation, JSON.stringify(op));
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true })).rejects.toThrow(/refusing recovery|interrupted preparation/);
    expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });
  it.each(['text', 'binding', 'ambiguous'])('refuses changed %s before submission', async change => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    if (change === 'text') ui.root.querySelector('[contenteditable]').innerText = 'changed';
    if (change === 'binding') ui.root.ownerDocument.documentElement.removeAttribute('data-bycli-channels-operation');
    if (change === 'ambiguous') ui.root.append(ui.root.querySelector('button').cloneNode(true));
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'submit', 'user-confirmed': true, execute: true })).rejects.toThrow(/changed|unambiguous/);
    expect(ui.clicks()).toBe(0);
  });
  it('hands visible verification off without uploading or accepting it', async () => {
    const ui = browser('管理员本人验证'), a = await args();
    await expect(publishVideo(ui.page, a)).rejects.toThrow('verification or account permission');
    await expect(readFile(a.operation)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ui.uploads()).toBe(0); expect(ui.clicks()).toBe(0);
  });
  it('fails invalid input and concurrent operations before site mutation', async () => {
    const ui = browser(), a = await args();
    await expect(publishVideo(ui.page, { ...a, timeout: 0 })).rejects.toThrow('timeout');
    await writeFile(`${a.operation}.lock`, '');
    await expect(publishVideo(ui.page, a)).rejects.toThrow('already running');
    expect(ui.page.goto.mock.calls.every(([url]) => url.includes('draftListManager'))).toBe(true);
  });
});

describe('integration with existing Channels analytics', () => {
  const id = '18446744073709551615';
  async function journal() {
    const a = await args();
    await writeFile(a.operation, JSON.stringify({ version: 1, operation_id: 'local-op', description: a.description,
      ai_generated: 'yes', submitted: true, status: 'submit_unknown', created_at: '2026-10-17T00:00:00Z' }));
    return a;
  }
  it('keeps no-id status local and never bootstraps a browser', async () => {
    const a = await journal();
    expect((await videoStatus(null, a))[0].status).toBe('submit_unknown');
    expect(retrieval.calls).toEqual([]);
  });
  it('inspects only the retained editor without uploading, submitting or collecting analytics', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const row = (await videoStatus(ui.page, { operation: a.operation, 'inspect-editor': true }))[0];
    expect(row.editor).toMatchObject({ ready: true, description: a.description, ai_selected: true, editors_count: 1 });
    expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0); expect(retrieval.calls).toEqual([]);
    await expect(videoStatus(ui.page, { operation: a.operation, id, 'inspect-editor': true })).rejects.toThrow('cannot be combined');
  });
  it('links an exact string ID and reuses metric semantics and detail mapping', async () => {
    const a = await journal();
    retrieval.posts = [{ objectId: id, createTime: Date.parse('2026-10-18T00:00:00Z') / 1000,
      desc: { description: a.description }, readCount: '12', likeCount: '3', favCount: '2' }];
    const row = (await videoStatus({}, { operation: a.operation, id }))[0];
    expect(row).toMatchObject({ status: 'published', id, metrics: { views: 12, recommendations: 3, likes: 2, comments: null } });
    expect(row.analytics.id).toBe(id);
    expect(retrieval.calls.map(x => x[0])).toEqual(['posts', 'detail']);
  });
  it('does not attach another work just because it has an ID', async () => {
    const a = await journal();
    retrieval.posts = [{ objectId: id, createTime: Math.floor(Date.now() / 1000), desc: { description: 'other content' } }];
    await expect(videoStatus({}, { operation: a.operation, id })).rejects.toThrow('does not match');
    expect(JSON.parse(await readFile(a.operation, 'utf8')).status).toBe('submit_unknown');
  });
  it('preserves an open publishing editor instead of navigating it to analytics', async () => {
    const a = await journal();
    const page = { getCurrentUrl: async () => 'https://channels.weixin.qq.com/platform/post/create' };
    await expect(videoStatus(page, { operation: a.operation, id })).rejects.toThrow('Retained editor is still open');
    expect(retrieval.calls).toEqual([]);
  });
  it('reads new-work management metrics through the existing model without inventing a numeric statistics ID', async () => {
    const a = await journal(), managementId = 'export/UzFfBg_test';
    const ui = managementBrowser([{ objectId: managementId, status: 1, createTime: 1792401007,
      desc: { description: a.description }, readCount: 0, likeCount: 3, favCount: 2, forwardAggregationCount: 0 }]);
    const row = (await videoStatus(ui.page, { operation: a.operation, 'management-id': managementId }))[0];
    expect(row).toMatchObject({ status: 'published', id: null, management_id: managementId, metrics_source: 'management_cumulative',
      analytics: null, metrics: { views: 0, recommendations: 3, likes: 2, comments: null, shares: 0 } });
    expect(ui.page.evaluate).toHaveBeenCalledTimes(2); expect(retrieval.calls).toEqual([]);
  });
  it('keeps the saved draft ID separate from the new published ID and checks submission time', async () => {
    const a = await journal(), managementId = 'export/published_new_id';
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.source_draft_id = 'export/original_draft_id'; op.submitted_at = '2026-10-19T13:04:51Z';
    await writeFile(a.operation, JSON.stringify(op));
    const ui = managementBrowser([{ objectId: managementId, status: 1, createTime: 1792415096, desc: { description: a.description }, readCount: 0 }]);
    expect((await videoStatus(ui.page, { operation: a.operation, 'management-id': managementId }))[0]).toMatchObject({ status: 'published', management_id: managementId });
    expect(JSON.parse(await readFile(a.operation, 'utf8')).source_draft_id).toBe('export/original_draft_id');
    ui.root.firstElementChild.__vue__.$props.post.createTime = 1792414000;
    await expect(videoStatus(ui.page, { operation: a.operation, 'management-id': managementId })).rejects.toThrow('does not match');
  });
  it('waits out a transient duplicate management card before accepting the exact ID', async () => {
    const a = await journal(), managementId = 'export/UzFfBg_test';
    const record = { objectId: managementId, status: 1, createTime: 1792401007, desc: { description: a.description } };
    const ui = managementBrowser([record, record]); let calls = 0;
    const original = ui.page.evaluate;
    ui.page.evaluate = async script => { if (++calls === 2) ui.root.lastElementChild.remove(); return original(script); };
    expect((await videoStatus(ui.page, { operation: a.operation, 'management-id': managementId }))[0].status).toBe('published');
    expect(calls).toBe(3);
  });
  it.each(['description', 'time', 'status'])('rejects management %s mismatch without binding it', async change => {
    const a = await journal(), managementId = 'export/UzFfBg_test';
    const record = { objectId: managementId, status: 1, createTime: 1792401007, desc: { description: a.description } };
    if (change === 'description') record.desc.description = 'another work';
    if (change === 'time') record.createTime = 1;
    if (change === 'status') record.status = 0;
    const ui = managementBrowser([record]);
    await expect(videoStatus(ui.page, { operation: a.operation, 'management-id': managementId })).rejects.toThrow('does not match');
    expect(JSON.parse(await readFile(a.operation, 'utf8')).management_id).toBeUndefined();
  });
  it.each(['missing', 'duplicate'])('refuses %s management IDs', async kind => {
    const a = await journal(), managementId = 'export/UzFfBg_test';
    const record = { objectId: managementId, status: 1, createTime: 1792401007, desc: { description: a.description } };
    const ui = managementBrowser(kind === 'missing' ? [] : [record, record]);
    await expect(videoStatus(ui.page, { operation: a.operation, 'management-id': managementId })).rejects.toMatchObject({ code: 'EMPTY_RESULT', hint: expect.stringContaining('did not stabilize') });
  });
  it('keeps management IDs, statistics IDs and date-window contracts distinct', async () => {
    const a = await journal(), ui = managementBrowser([]), managementId = 'export/UzFfBg_test';
    await expect(videoStatus(ui.page, { operation: a.operation, 'management-id': '123' })).rejects.toThrow('exact export/');
    await expect(videoStatus(ui.page, { operation: a.operation, id: managementId })).rejects.toThrow('complete objectId');
    await expect(videoStatus(ui.page, { operation: a.operation, id, 'management-id': managementId })).rejects.toThrow('cannot be combined');
    await expect(videoStatus(ui.page, { operation: a.operation, days: 7, 'management-id': managementId })).rejects.toThrow('cumulative');
    expect(ui.page.goto.mock.calls.every(([url]) => url.includes('draftListManager'))).toBe(true);
  });
});


async function legacyLoginOperation(ui, a) {
  await ui.page.goto('https://channels.weixin.qq.com/platform/post/create');
  ui.page.goto.mockClear();
  const op = { version: 1, operation_id: 'legacy-login', created_at: new Date().toISOString(),
    description: a.description, ai_generated: a['ai-generated'], sha256: createHash('sha256').update(await readFile(a.file)).digest('hex'),
    status: 'preparation_unknown', submitted: false, target: ui.page.getActivePage(), upload_attempted: false, authentication_required: true };
  await writeFile(a.operation, JSON.stringify(op));
  return op;
}

describe('publishing recovery regressions', () => {
it('opts active publishing into Channels-only dialogs and retains the separate submit gate', async () => {
    const ui = browser(), a = await args();
    await publishVideo(ui.page, a);
    expect(ui.page.withAcceptedDialogs).toHaveBeenCalledWith('https://channels.weixin.qq.com', expect.any(Function), 6000);
    expect(ui.clicks()).toBe(0);
    ui.page.withAcceptedDialogs.mockClear();
    await publishVideo(ui.page, a); // Retained prepare is read-only.
    expect(ui.page.withAcceptedDialogs).not.toHaveBeenCalled();
    await expect(publishVideo(ui.page, { operation: a.operation, mode: 'submit', execute: true })).rejects.toThrow('--user-confirmed');
    expect(ui.page.withAcceptedDialogs).not.toHaveBeenCalled();
  });

it('saves and reopens a multi-line rich description with a rendered terminal newline, and resumes without rewriting it', async () => {
    const ui = browser(), a = await args(); a.description = '第一段\n第二段 #话题';
    ui.page.fillText = vi.fn(async (selector, text) => {
      ui.root.querySelector(selector).innerText = text + '\n';
      return { filled: true, verified: false, mode: 'contenteditable', actual: text + '\n' };
    });
    expect((await publishVideo(ui.page, a))[0]).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.page.fillText).toHaveBeenCalledTimes(1); expect(ui.saves()).toBe(1);
    await publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true, timeout: 1 });
    expect(ui.page.fillText).toHaveBeenCalledTimes(1); expect(ui.uploads()).toBe(1); expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
  });

it('resumes the retained uploaded page with an equivalent description without filling or uploading again', async () => {
    const ui = browser(), a = await args(); a.description = '第一段\n第二段 #话题\n';
    ui.page.fillText = vi.fn(async (selector, text) => {
      ui.root.querySelector(selector).innerText = text + '\n';
      throw Error('original fill verification interrupted');
    });
    await expect(publishVideo(ui.page, a)).rejects.toThrow('original fill verification interrupted');
    const before = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(before.submitted).toBe(false); expect(ui.uploads()).toBe(1);
    ui.page.fillText.mockClear();
    expect((await publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true, timeout: 1 }))[0]).toMatchObject({ operation_id: before.operation_id, status: 'prepared', submitted: false });
    expect(ui.page.fillText).not.toHaveBeenCalled(); expect(ui.uploads()).toBe(1); expect(ui.clicks()).toBe(0);
  });

it.each(['body', 'space', 'paragraph', 'wrong-host'])('does not relax verification for a changed %s', async change => {
    const ui = browser(), a = await args(); a.description = '第一段\n第二段';
    ui.page.fillText = async (selector, text) => {
      const actual = change === 'body' ? '第一段\n其他内容\n' : change === 'space' ? text + ' ' : change === 'paragraph' ? text.replace('\n', '\n\n') : text + '\n';
      ui.root.querySelector(selector).innerText = change === 'wrong-host' ? 'different editor content' : actual;
      return { filled: true, verified: false, mode: 'contenteditable', actual };
    };
    await expect(publishVideo(ui.page, a)).rejects.toThrow('Description input was not verified');
    expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
  });

it.each(['first-available-wait', 'input-inspection'])('never injects a file after the total budget expires during %s', async phase => {
    const ui = browser(), a = await args();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const evaluate = ui.page.evaluate;
    ui.page.wait = async () => { if (phase === 'first-available-wait') now += 1200; };
    ui.page.evaluate = async script => {
      const state = await evaluate(script);
      if (phase === 'input-inspection' && state?.selector?.includes('"input"')) now += 1200;
      return state;
    };
    try {
      await expect(publishVideo(ui.page, a)).rejects.toMatchObject({ code: 'TIMEOUT' });
      if (phase === 'first-available-wait') await expect(readFile(a.operation)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(JSON.parse(await readFile(a.operation, 'utf8'))).toMatchObject({ status: 'upload_not_started', upload: { effect: 'none' }, submitted: false });
      expect(ui.uploads()).toBe(0); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
    } finally { clock.mockRestore(); }
  });

it.each(['/login', '/login/', '/login.html', '/login.html?from=assistant'])('recognizes the real login route %s before inspecting editor controls', async path => {
    const dom = new JSDOM('', { url: `https://channels.weixin.qq.com${path}`, runScripts: 'outside-only' });
    expect(dom.window.eval(publishScript('bind', 'op', 'yes'))).toEqual({ error: 'login_required' });
    expect(dom.window.document.documentElement.hasAttribute('data-bycli-channels-operation')).toBe(false);
    dom.window.close();
  });

it.each(['login', 'navigation', 'verification'])('does not create a journal on %s failure; ordinary prepare works after resolving it', async failure => {
    const ui = browser(), a = await args(), goto = ui.page.goto;
    if (failure === 'login') ui.page.goto = async () => goto('https://channels.weixin.qq.com/login.html');
    if (failure === 'navigation') ui.page.goto = async () => { throw Error('navigation disconnected'); };
    if (failure === 'verification') ui.root.lastElementChild.textContent = '安全验证';
    await expect(publishVideo(ui.page, a)).rejects.toThrow();
    await expect(readFile(a.operation)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ui.uploads()).toBe(0); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
    ui.root.lastElementChild.textContent = ''; ui.page.goto = goto;
    expect((await publishVideo(ui.page, a))[0]).toMatchObject({ status: 'prepared', submitted: false });
    expect(ui.uploads()).toBe(1); expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
  });

it('reopens an exact saved draft without arming dialogs on a dead target or uploading/saving again', async () => {
    const ui = browser(), a = await args(); await publishVideo(ui.page, a);
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    op.target = 'closed-page'; op.editor_session = 'old-borrowed-session'; await writeFile(a.operation, JSON.stringify(op));
    ui.page.setActivePage.mockClear();
    ui.page.withAcceptedDialogs = vi.fn(async (_origin, run) => {
      expect(ui.page.setActivePage).not.toHaveBeenCalledWith('closed-page');
      return run();
    });
    const [after] = await publishVideo(ui.page, { operation: a.operation, mode: 'resume', execute: true, timeout: 1 });
    expect(after).toMatchObject({ operation_id: op.operation_id, status: 'prepared', submitted: false });
    expect(JSON.parse(await readFile(a.operation, 'utf8')).editor_session).toBeUndefined();
    expect(ui.uploads()).toBe(1); expect(ui.saves()).toBe(1); expect(ui.clicks()).toBe(0);
  });

it.each(['unknown', 'legacy'])('does not turn %s upload outcome into an absent-upload receipt', async kind => {
    const ui = browser(), a = await args();
    ui.page.uploadFiles = vi.fn(async () => { throw Error('native upload response lost'); });
    await expect(publishVideo(ui.page, a)).rejects.toThrow('native upload response lost');
    const op = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(op.upload.effect).toBe('unknown');
    if (kind === 'legacy') { delete op.upload; await writeFile(a.operation, JSON.stringify(op)); }
    await expect(publishVideo(ui.page, { file: a.file, operation: a.operation, mode: 'retry-upload', execute: true })).rejects.toThrow('not proven absent');
    expect(ui.page.uploadFiles).toHaveBeenCalledTimes(1); expect(ui.saves()).toBe(0); expect(ui.clicks()).toBe(0);
    const after = JSON.parse(await readFile(a.operation, 'utf8'));
    expect(after.upload?.effect).toBe(kind === 'legacy' ? undefined : 'unknown');
    expect(after.upload_retries).toBeUndefined();
  });

it('rejects an otherwise empty retry editor that belongs to an existing platform draft', async () => {
    const ui = browser(), a = await args();
    ui.page.uploadFiles = vi.fn(async () => { throw Object.assign(Error('missing capability'), { code: 'UPLOAD_NOT_STARTED' }); });
    await expect(publishVideo(ui.page, a)).rejects.toThrow('missing capability');
    const wrap = ui.root.ownerDocument.createElement('div'); wrap.className = 'post-edit-wrap';
    wrap.__vue__ = { $props: { postStore: { defaultValue: { objectId: 'export/another_draft' }, tempPost: { objectId: 'export/another_draft' } } } }; ui.root.append(wrap);
    await expect(publishVideo(ui.page, { file: a.file, operation: a.operation, mode: 'retry-upload', execute: true })).rejects.toThrow('must be empty');
    expect(ui.page.uploadFiles).toHaveBeenCalledTimes(1); expect(ui.saves()).toBe(0);
  });

it('waits for initialization to end and resolves the replacement input before one upload', async () => {
    const ui = browser('页面初始化中'), a = await args(); let waits = 0;
    ui.page.wait = async () => {
      if (++waits === 2) {
        ui.root.lastElementChild.textContent = '已就绪';
        const input = ui.root.querySelector('input'); input.replaceWith(input.cloneNode());
      }
    };
    const native = ui.page.uploadFiles;
    ui.page.uploadFiles = async (...args) => { expect(waits).toBeGreaterThanOrEqual(2); return native(...args); };
    expect((await publishVideo(ui.page, a))[0].status).toBe('prepared'); expect(ui.uploads()).toBe(1);
  });

it('allows 90 seconds of silent processing within the requested budget, then stops at the total deadline', async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const wait = publishWait(180);
  try {
    const processing = await wait.stage('video-processing');
    await processing.observe({ ready: false }); now += 90_000;
    await expect(processing.observe({ ready: false })).resolves.toBeUndefined();
    now += 90_000;
    await expect(processing.observe({ ready: false })).rejects.toMatchObject({ code: 'TIMEOUT' });
  } finally { wait.close(); clock.mockRestore(); }
});

it.each(['recovers', 'opening-recovers', 'exhausts', 'deadline', 'unknown-upload'])('reopens only the same untouched saved draft when cover loading %s', async outcome => {
  const ui = browser(), a = await args(); a.timeout = 180;
  const image = join(dir, 'cover.jpg'); await writeFile(image, Buffer.from([255,216,255,224,1,2,3])); a.cover = image;
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  ui.page.wait = async () => { clock += 500; };
  const attempts = vi.spyOn(coverModule, 'configureCover').mockImplementation(async (_page, op) => {
    if (outcome.endsWith('recovers') && op.cover.reloads?.length === 1) { op.cover.phase = 'configured'; return; }
    if (outcome === 'opening-recovers') op.cover.phase = 'opening';
    if (outcome === 'deadline') clock += 180_000;
    if (outcome === 'unknown-upload') { op.cover.phase = 'upload_unknown'; op.cover.upload = { effect: 'unknown' }; }
    throw Object.assign(new Error('cover not ready'), { code: 'COVER_NOT_READY' });
  });
  attempts.mockClear();
  vi.spyOn(coverModule, 'verifyCover').mockResolvedValue(undefined);
  const evaluate = ui.page.evaluate;
  if (outcome === 'opening-recovers') ui.page.evaluate = async script => script.includes('async function coverDOM')
    ? { cards: {}, dialog: true, cropping: false, render: { custom_source_selected: false } } : evaluate(script);
  if (outcome.endsWith('recovers')) expect((await publishVideo(ui.page, a))[0]).toMatchObject({ status: 'prepared', submitted: false });
  else await expect(publishVideo(ui.page, a)).rejects.toMatchObject({ code: outcome === 'deadline' ? 'TIMEOUT' : 'COVER_NOT_READY' });
  const op = JSON.parse(await readFile(a.operation, 'utf8'));
  expect(op.source_draft_id).toBe('export/saved_fixture'); expect(op.submitted).toBe(false);
  expect(op.cover.reloads?.length ?? 0).toBe(outcome.endsWith('recovers') ? 1 : outcome === 'exhausts' ? 3 : 0);
  expect(attempts).toHaveBeenCalledTimes(outcome.endsWith('recovers') ? 2 : outcome === 'exhausts' ? 4 : 1);
  expect(ui.uploads()).toBe(1); expect(ui.saves()).toBe(outcome.endsWith('recovers') ? 2 : 1); expect(ui.clicks()).toBe(0);
});
});
