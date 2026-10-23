import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { webcrypto, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverScript, coverControlScript, localCover, configureCover, verifyCover, sameCovers, requestedCovers, reconcileConfirmedCover, recoverCoverProcessing } from './_shared/cover.js';
import { publishWait } from './_shared/wait.js';
import { validatePublishArgs } from './_shared/publish.js';
import { log } from '@sovovs/bycli/logger';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'channels-cover-')); vi.spyOn(log, 'info').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function source(name = 'cover.jpg') {
  const path = join(dir, name); await writeFile(path, Buffer.concat([Buffer.from([255, 216, 255, 224, 1, 2, 3]), Buffer.from(name)]));
  return { ...await localCover(path), phase: 'pending' };
}
// Synthetic DOM uses the native classes/title/footer observed on 2026-10-20.
// Browser actions simulate platform image processing; they do not call hidden APIs.
function browser() {
  const dom = new JSDOM('<wujie-app></wujie-app>', { url: 'https://channels.weixin.qq.com/platform/post/create', runScripts: 'outside-only' });
  const win = dom.window, root = win.document.querySelector('wujie-app').attachShadow({ mode: 'open' });
  win.TextEncoder = TextEncoder; Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle });
  win.document.documentElement.setAttribute('data-bycli-channels-operation', 'bound');
  root.innerHTML = `<div class="cover-preview-wrap">
    <div class="vertical-cover-wrap"><div class="vertical-img-wrap"><img class="vertical-img-size" src="https://finder.video.qq.com/251/20304/stodownload?encfilekey=original_vertical&idx=1&token=old"><div class="edit-btn">编辑</div></div></div>
    <div class="horizon-cover-wrap"><div class="horizon-img-wrap"><img class="horizon-img-size" src="https://finder.video.qq.com/251/20304/stodownload?encfilekey=original_horizontal&idx=1&token=old"><div class="edit-btn">编辑</div></div></div>
    <div class="edit-cover-dialog"><div class="weui-desktop-dialog" hidden><h3>编辑分享卡片</h3>
      <div class="single-cover-uploader-wrap"><input type="file" accept="image/jpeg,image/jpg,image/png"><img class="img-wrap"></div>
      <div class="preview-item"><img src="data:image/jpeg;base64,AAAA"></div>
      <div class="cover-set-footer"><button>取消</button><button>确认</button></div>
    </div></div></div>`;
  const loaded = img => Object.defineProperties(img, { complete: { value: true, configurable: true }, naturalWidth: { value: 1920, configurable: true }, naturalHeight: { value: 1080, configurable: true } });
  root.querySelectorAll('img').forEach(loaded);
  const dialog = root.querySelector('.weui-desktop-dialog');
  const editor = { $options: { name: 'EditCoverDialog' }, $data: {
    isVideoInitialized: true, useCustomCover: false, customCoverPreviewUrl: '', currentCoverImageUrl: 'data:image/jpeg;base64,AAAA',
  } };
  const renderer = { $parent: editor, $options: { methods: { getOriginalCanvas() {} } },
    $props: { get imageUrl() { return editor.$data.currentCoverImageUrl; } },
    $data: { isCroppieReady: true, get lastImageUrl() { return editor.$data.currentCoverImageUrl; } },
  };
  dialog.__vue__ = editor; root.querySelector('.preview-item').__vue__ = renderer;
  const render = () => win.document.body.setAttribute('data-render', String(Math.random()));
  let role = 'horizontal';
  for (const name of ['horizontal', 'vertical']) root.querySelector(name === 'vertical' ? '.vertical-img-wrap' : '.horizon-img-wrap').onclick = () => {
    role = name; dialog.querySelector('h3').textContent = role === 'vertical' ? '编辑个人主页卡片' : '编辑分享卡片'; dialog.hidden = false; render();
  };
  root.querySelector('.cover-set-footer button:last-child').onclick = () => {
    dialog.hidden = true;
    const img = root.querySelector(role === 'vertical' ? 'img.vertical-img-size' : 'img.horizon-img-size'); img.src = img.src.replace('original_', 'custom_');
    render();
  };
  root.querySelector('.cover-set-footer button:first-child').onclick = () => { dialog.hidden = true; render(); };
  // Give controls real viewport geometry; browser mouse input targets this
  // control, while DOM .click() can be ignored independently in regressions.
  const rect = { left: 100, top: 100, width: 100, height: 30 };
  for (const b of root.querySelectorAll('button')) b.getBoundingClientRect = () => rect;
  win.document.elementFromPoint = () => [...root.querySelectorAll('button[data-bycli-channels-cover]')][0] || null;
  const calls = [];
  const page = {
    focusWindow: vi.fn(), hover: vi.fn(), wait: vi.fn(),
    evaluate: async script => win.eval(script),
    evaluateOnce: vi.fn(async script => win.eval(script)),
    nativeClickOnce: vi.fn(async () => {
      const button = root.querySelector('[data-bycli-channels-cover]');
      // Simulates the browser input handler, not HTMLElement.click().
      await button.onclick?.({ isTrusted: true });
    }),
    click: async selector => { calls.push(['click', selector]); root.querySelector(selector).click(); },
    uploadFiles: async (selector, files) => {
      calls.push(['upload', files]);
      root.querySelector('.single-cover-uploader-wrap img').src = `data:image/jpeg;base64,${(await readFile(files[0])).toString('base64')}`;
      editor.$data.useCustomCover = true;
      editor.$data.customCoverPreviewUrl = root.querySelector('.single-cover-uploader-wrap img').src;
      editor.$data.currentCoverImageUrl = editor.$data.customCoverPreviewUrl;
      render();
    },
  };
  return { page, root, win, calls, editor, renderer };
}

describe('optional video cover configuration', () => {
  it('limits explicit processing recovery to resume of an exact role, excluding submit and manual confirmation', () => {
    const a = { operation: 'op', execute: true, 'retry-cover-processing': 'horizontal' };
    expect(() => validatePublishArgs({ ...a, mode: 'resume' })).not.toThrow();
    for (const mode of ['prepare', 'submit', 'recover']) expect(() => validatePublishArgs({ ...a, mode, ...(mode === 'submit' ? { 'user-confirmed': true } : {}) })).toThrow('--retry-cover-processing');
    expect(() => validatePublishArgs({ ...a, mode: 'resume', 'retry-cover-processing': 'other' })).toThrow('--retry-cover-processing');
    expect(() => validatePublishArgs({ ...a, mode: 'resume', 'cover-confirmed': 'horizontal' })).toThrow('Select one cover recovery action');
  });
  it('uploads after video initialization even when the default cropper has no image, then waits for custom binding', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.editor.$data.currentCoverImageUrl = ''; ui.renderer.$data.isCroppieReady = false;
    const upload = ui.page.uploadFiles;
    ui.page.uploadFiles = async (...args) => { await upload(...args); ui.renderer.$data.isCroppieReady = true; };
    await configureCover(ui.page, op, async () => {}, 2);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('continues an exact retained opening without reopening or retrying a previous upload', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.root.querySelector('.horizon-img-wrap').click();
    op.cover.originalIdentities = (await ui.win.eval(coverScript('status', 'bound'))).cards;
    op.cover.phase = 'opening'; op.cover.role = 'horizontal'; op.cover.completedRoles = {};
    const open = vi.fn(); ui.root.querySelector('.horizon-img-wrap').onclick = open;
    await configureCover(ui.page, op, async () => {}, 2, undefined, null, 'horizontal');
    expect(open).not.toHaveBeenCalled(); expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
    expect(op.cover.recoveries).toMatchObject([{ method: 'retained-dialog-before-upload' }]);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it.each(['uploaded', 'changed-card', 'wrong-role', 'upload_unknown'])('refuses opening continuation with %s evidence', async reason => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.root.querySelector('.horizon-img-wrap').click();
    op.cover.originalIdentities = (await ui.win.eval(coverScript('status', 'bound'))).cards;
    op.cover.phase = 'opening'; op.cover.role = 'horizontal'; op.cover.completedRoles = {};
    if (reason === 'uploaded') ui.editor.$data.useCustomCover = true, ui.editor.$data.customCoverPreviewUrl = ui.editor.$data.currentCoverImageUrl;
    if (reason === 'changed-card') ui.root.querySelector('img.vertical-img-size').src = ui.root.querySelector('img.vertical-img-size').src.replace('idx=1', 'idx=2');
    if (reason === 'wrong-role') op.cover.role = 'vertical';
    if (reason === 'upload_unknown') op.cover.phase = 'upload_unknown';
    await expect(configureCover(ui.page, op, async () => {}, 2, undefined, null, 'horizontal')).rejects.toThrow('Opening recovery');
    expect(ui.calls).toEqual([]); ui.win.close();
  });
  it('rejects an opening continuation flag for submission or mixed recovery', () => {
    const a = { operation: 'op', execute: true, 'resume-cover-opening': 'horizontal' };
    expect(() => validatePublishArgs({ ...a, mode: 'resume' })).not.toThrow();
    for (const mode of ['prepare', 'submit', 'recover']) expect(() => validatePublishArgs({ ...a, mode, ...(mode === 'submit' ? { 'user-confirmed': true } : {}) })).toThrow(/--resume-cover-opening|Select one cover recovery action/);
    expect(() => validatePublishArgs({ ...a, mode: 'resume', 'retry-cover-processing': 'horizontal' })).toThrow(/--resume-cover-opening|Select one cover recovery action/);
    expect(() => validatePublishArgs({ ...a, mode: 'resume', 'reopen-saved-draft': true })).not.toThrow();
    expect(() => validatePublishArgs({ operation: 'op', execute: true, mode: 'resume', 'reopen-saved-draft': true })).toThrow('--reopen-saved-draft');
  });
  it('waits for delayed video initialization before selecting a cover file', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.editor.$data.isVideoInitialized = false;
    let polls = 0, uploadedBeforeReady = false;
    const upload = ui.page.uploadFiles;
    ui.page.uploadFiles = async (...args) => { uploadedBeforeReady = !ui.editor.$data.isVideoInitialized; await upload(...args); };
    ui.page.wait = async () => {
      if (!ui.root.querySelector('.weui-desktop-dialog').hidden && ++polls === 4) ui.editor.$data.isVideoInitialized = true;
    };
    await configureCover(ui.page, op, async () => {}, 10);
    expect(polls).toBeGreaterThanOrEqual(4); expect(uploadedBeforeReady).toBe(false);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('waits for the selected custom image to be bound to the crop renderer before confirming', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const upload = ui.page.uploadFiles; let binding = false, polls = 0;
    ui.page.uploadFiles = async (...args) => { await upload(...args); ui.editor.$data.currentCoverImageUrl = 'data:image/jpeg;base64,AAAA'; binding = true; };
    ui.page.wait = async () => {
      if (binding && ++polls === 4) ui.editor.$data.currentCoverImageUrl = ui.editor.$data.customCoverPreviewUrl;
    };
    const click = ui.page.nativeClickOnce.getMockImplementation();
    ui.page.nativeClickOnce.mockImplementation(async (...args) => {
      expect(ui.editor.$data.currentCoverImageUrl).toBe(ui.editor.$data.customCoverPreviewUrl); await click(...args);
    });
    await configureCover(ui.page, op, async () => {}, 10);
    expect(polls).toBeGreaterThanOrEqual(4); expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(1);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('recovers one exact native canvas failure on the same role without manual confirmation or video upload', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let now = 1000, confirms = 0, failedAt;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    ui.page.wait = async v => { now += (typeof v === 'number' ? v : v.time) * 1000; };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child'), success = confirm.onclick;
    confirm.onclick = () => {
      if (++confirms === 1) failedAt = Date.parse(op.cover.activation.at);
      else success();
    };
    ui.page.consoleMessages = vi.fn(async () => [{ timestamp: failedAt, text: '[getOriginalCanvas]horizon error: imgSizeInvalid width=0 height=0' }]);
    await configureCover(ui.page, op, async () => {}, 90);
    expect(confirms).toBe(2); expect(op.cover.processing_retries.horizontal).toBe(1);
    expect(op.cover.processing_failures).toMatchObject([{ role: 'horizontal', code: 'native_canvas_size_zero' }]);
    expect(op.cover.manual_confirmations).toBeUndefined();
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(2);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(3); // failure, cancel, corrected confirmation
    await verifyCover(ui.page, op); ui.win.close();
  });
  it.each(['stale-error', 'different-error', 'changed-card'])('does not recover an uncertain confirmation using %s evidence', async reason => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    ui.page.wait = async v => { now += (typeof v === 'number' ? v : v.time) * 1000; };
    ui.root.querySelector('.cover-set-footer button:last-child').onclick = () => {};
    await expect(configureCover(ui.page, op, async () => {}, 90)).rejects.toThrow('confirm-response: no progress');
    ui.page.consoleMessages = vi.fn(async () => [{ timestamp: Date.parse(op.cover.activation.at) + (reason === 'stale-error' ? -1 : 0),
      text: reason === 'different-error' ? 'unrelated canvas failure' : 'imgSizeInvalid width=0 height=0' }]);
    if (reason === 'changed-card') ui.root.querySelector('img.vertical-img-size').src = 'https://finder.video.qq.com/file?encfilekey=another';
    await expect(configureCover(ui.page, op, async () => {}, 90)).rejects.toThrow('interrupted');
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1); ui.win.close();
  });
  it('stops after one processing retry per role even when the native canvas keeps failing', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let now = 1000, failedAt; vi.spyOn(Date, 'now').mockImplementation(() => now);
    ui.page.wait = async v => { now += (typeof v === 'number' ? v : v.time) * 1000; };
    ui.root.querySelector('.cover-set-footer button:last-child').onclick = () => { failedAt = Date.parse(op.cover.activation.at); };
    ui.page.consoleMessages = vi.fn(async () => [{ timestamp: failedAt, text: 'imgSizeInvalid width=0 height=0' }]);
    await expect(configureCover(ui.page, op, async () => {}, 90)).rejects.toThrow('confirm-response: no progress');
    expect(op.cover.processing_retries.horizontal).toBe(1);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(3);
    await expect(configureCover(ui.page, op, async () => {}, 90)).rejects.toThrow('interrupted');
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(3); ui.win.close();
  });
  it('reports retained cover controls without marking, scrolling, clicking or uploading', async () => {
    const ui = browser(); ui.root.querySelector('.horizon-img-wrap').click();
    const before = ui.root.innerHTML;
    const state = await ui.win.eval(coverScript('diagnostics', 'bound'));
    expect(state).toMatchObject({ dialog: true, cropping: false, dialog_titles: ['编辑分享卡片'],
      controls: [{ label: '取消', disabled: false }, { label: '确认', disabled: false }] });
    expect(ui.root.innerHTML).toBe(before); expect(ui.calls).toEqual([]); ui.win.close();
  });
  it('leaves the default platform covers untouched when no image was supplied', async () => {
    const page = { evaluate: vi.fn(), click: vi.fn(), uploadFiles: vi.fn() };
    await configureCover(page, {}, vi.fn(), 1); await verifyCover(page, {});
    expect(page.evaluate).not.toHaveBeenCalled(); expect(page.click).not.toHaveBeenCalled(); expect(page.uploadFiles).not.toHaveBeenCalled();
  });
  it('validates image bytes instead of accepting a renamed non-image', async () => {
    const path = join(dir, 'renamed.png'); await writeFile(path, 'not an image');
    await expect(localCover(path)).rejects.toThrow('contents');
    await expect(localCover(join(dir, 'missing.jpg'))).rejects.toThrow('nonempty');
    await expect(localCover('/tmp/cover.gif')).rejects.toThrow('PNG or JPEG');
  });
  it('does not silently apply a new cover on submit, resume or an adopted draft', () => {
    for (const flag of ['cover', 'vertical-cover']) for (const mode of ['resume', 'submit', 'adopt-draft', 'retry-upload', 'recover']) expect(() => validatePublishArgs({ mode, [flag]: '/tmp/cover.jpg', execute: true, operation: 'op', ...(mode === 'submit' ? { 'user-confirmed': true } : {}) })).toThrow(`--${flag}`);
  });
  it('uploads distinct sources once to their respective card editors and records their identities', async () => {
    const ui = browser(), horizontal = await source(), vertical = await source('portrait.jpg');
    const cover = await requestedCovers({ cover: horizontal.path, 'vertical-cover': vertical.path }), op = { operation_id: 'bound', cover };
    expect(horizontal.sha256).not.toBe(vertical.sha256);
    const phases = [];
    await configureCover(ui.page, op, async () => { phases.push(op.cover.phase); }, 1);
    expect(phases.filter((v, i) => i === 0 || v !== phases[i - 1])).toEqual(['opening', 'upload_unknown', 'confirm_unknown', 'pending', 'opening', 'upload_unknown', 'confirm_unknown', 'pending', 'configured']);
    expect(ui.calls.filter(([name]) => name === 'upload')).toEqual([['upload', [horizontal.path]], ['upload', [vertical.path]]]);
    expect(op.cover.identities).toEqual({
      vertical: createHash('sha256').update(JSON.stringify(['https://finder.video.qq.com', '/251/20304/stodownload', 'custom_vertical', '1'])).digest('hex'),
      horizontal: createHash('sha256').update(JSON.stringify(['https://finder.video.qq.com', '/251/20304/stodownload', 'custom_horizontal', '1'])).digest('hex'),
    });
    await verifyCover(ui.page, op);
    await configureCover(ui.page, op, vi.fn(), 1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(2);
    ui.win.close();
  });
  it.each([['horizontal', 'cover'], ['vertical', 'vertical-cover']])('replaces only the requested %s cover, leaving the other default intact', async (role, flag) => {
    const ui = browser(), image = await source();
    const op = { operation_id: 'bound', cover: await requestedCovers({ [flag]: image.path }) };
    const before = await ui.win.eval(coverScript('status', 'bound'));
    await configureCover(ui.page, op, async () => {}, 1);
    const after = await ui.win.eval(coverScript('status', 'bound'));
    const other = role === 'horizontal' ? 'vertical' : 'horizontal';
    expect(after.cards[other]).toBe(before.cards[other]);
    expect(after.cards[role]).not.toBe(before.cards[role]);
    expect(Object.keys(op.cover.identities)).toEqual([role]);
    expect(ui.calls.filter(([name]) => name === 'upload')).toEqual([['upload', [image.path]]]);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('allows signed URL refreshes but refuses another complete resource key', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    await configureCover(ui.page, op, async () => {}, 1);
    for (const img of ui.root.querySelectorAll('img.vertical-img-size,img.horizon-img-size')) img.src = img.src.replace('token=old', 'token=new') + '&picformat=200';
    await verifyCover(ui.page, op);
    const img = ui.root.querySelector('img.horizon-img-size'); img.src = img.src.replace('custom_horizontal', 'custom_horizontal_different');
    await expect(verifyCover(ui.page, op)).rejects.toThrow('identities changed');
    ui.win.close();
  });
  it('retries only the unopened hover overlay, never the actual image upload', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    ui.page.wait = async () => { clock += 250; };
    const button = ui.root.querySelector('.horizon-img-wrap'), open = button.onclick;
    let attempts = 0;
    button.onclick = () => { if (++attempts > 1) open(); };
    await configureCover(ui.page, op, async () => {}, 10);
    expect(attempts).toBe(2);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
    ui.win.close();
  });
  it('uses native pointer input at the visible edit strip without clicking a decorative image center', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.root.querySelector('.horizon-img-wrap .edit-btn').getBoundingClientRect = () => ({ left: 20, top: 30, width: 40, height: 10 });
    ui.page.nativeClick = vi.fn(async (x, y) => {
      expect([x, y]).toEqual([40, 35]); ui.root.querySelector('.horizon-img-wrap').click();
    });
    await configureCover(ui.page, op, async () => {}, 1);
    expect(ui.page.nativeClick).toHaveBeenCalledTimes(1); await verifyCover(ui.page, op); ui.win.close();
  });
  it('completes the native crop dialog before confirming the requested cover', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const crop = ui.win.document.createElement('div'); crop.className = 'weui-desktop-dialog'; crop.hidden = true;
    crop.innerHTML = '<h3>裁剪封面图</h3><canvas class="cr-image" width="100" height="100"></canvas><button>确定</button>';
    crop.querySelector('button').getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 30 });
    ui.root.append(crop);
    const upload = ui.page.uploadFiles; let pending;
    const render = () => ui.win.document.body.setAttribute('data-crop', String(Math.random()));
    ui.page.uploadFiles = async (...args) => { pending = args; crop.hidden = false; render(); };
    let crops = 0;
    crop.querySelector('button').onclick = async () => { crops++; await upload(...pending); crop.hidden = true; render(); };
    await configureCover(ui.page, op, async () => {}, 1);
    expect(crops).toBe(1); await verifyCover(ui.page, op); ui.win.close();
  });
  it('handles a crop dialog that appears during confirm hover without marking or clicking confirmation early', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const crop = ui.win.document.createElement('div'); crop.className = 'weui-desktop-dialog'; crop.hidden = true;
    crop.innerHTML = '<h3>裁剪封面图</h3><canvas class="cr-image" width="100" height="100"></canvas><button>确定</button>';
    crop.querySelector('button').getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 30 });
    ui.root.append(crop);
    let appeared = false, crops = 0, confirmations = 0;
    const render = () => ui.win.document.body.setAttribute('data-crop', String(Math.random()));
    crop.querySelector('button').onclick = () => { crops++; crop.hidden = true; render(); };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child'), originalConfirm = confirm.onclick;
    confirm.onclick = () => { confirmations++; originalConfirm(); };
    ui.page.hover = async selector => {
      if (!appeared && ui.root.querySelector(selector) === confirm) {
        expect(op.cover.phase).toBe('upload_unknown'); appeared = true; crop.hidden = false; render();
      }
    };
    await configureCover(ui.page, op, async () => {}, 2);
    expect(crops).toBe(1); expect(confirmations).toBe(1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('remeasures after hover moves the dialog and uses single-attempt browser input', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child');
    let left = 10;
    confirm.getBoundingClientRect = () => ({ left, top: 30, width: 40, height: 10 });
    ui.win.document.elementFromPoint = () => confirm;
    ui.page.hover = async selector => { if (ui.root.querySelector(selector) === confirm) left = 210; };
    ui.page.nativeClick = vi.fn(async () => { throw Error('Coordinate click must not confirm'); });
    await configureCover(ui.page, op, async () => {}, 2);
    expect(ui.page.nativeClick).not.toHaveBeenCalled(); expect(ui.page.evaluateOnce).toHaveBeenCalledTimes(1);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledWith(230, 35);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('does not click through a control covering the native confirmation button', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child');
    confirm.getBoundingClientRect = () => ({ left: 20, top: 30, width: 40, height: 10 });
    ui.win.document.elementFromPoint = () => ui.root.host;
    ui.page.nativeClick = vi.fn();
    await expect(configureCover(ui.page, op, async () => {}, 2)).rejects.toThrow('control is obscured');
    expect(ui.page.nativeClick).not.toHaveBeenCalled();
    expect(op.cover).toMatchObject({ phase: 'upload_unknown', error: { role: 'horizontal', phase: 'upload_unknown' } });
    expect(ui.root.querySelector('.weui-desktop-dialog').hidden).toBe(false); ui.win.close();
  });
  it('automatically confirms both roles when the platform ignores DOM-generated click events', async () => {
    const ui = browser(), horizontal = await source(), vertical = await source('vertical.jpg');
    const op = { operation_id: 'bound', cover: await requestedCovers({ cover: horizontal.path, 'vertical-cover': vertical.path }) };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child'), original = confirm.onclick;
    let trusted = 0, untrusted = 0;
    confirm.onclick = event => {
      if (!event.isTrusted) { untrusted++; return; }
      trusted++; original();
    };
    await configureCover(ui.page, op, async () => {}, 10);
    expect(trusted).toBe(2); expect(untrusted).toBe(0);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(2);
    expect(op.cover.activation).toMatchObject({ role: 'vertical', action: 'confirm', method: 'native-pointer-once', status: 'verified' });
    expect(op.cover.manual_confirmations).toBeUndefined();
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('waits for an animating control to settle without reserving a gesture at its old location', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child');
    let reads = 0;
    confirm.getBoundingClientRect = () => ({ left: ++reads < 6 ? 100 : 200, top: 100, width: 100, height: 30 });
    await configureCover(ui.page, op, async () => {}, 10);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(1);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledWith(250, 115);
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('retains an unknown browser input outcome without a DOM fallback or another mouse press', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.page.nativeClickOnce.mockRejectedValue(new Error('mouse press response lost'));
    await expect(configureCover(ui.page, op, async () => {}, 10)).rejects.toThrow('mouse press response lost');
    expect(op.cover.activation).toMatchObject({ action: 'confirm', status: 'dispatch_unknown' });
    expect(op.cover.phase).toBe('confirm_unknown');
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(1);
    expect(ui.root.querySelector('.weui-desktop-dialog').hidden).toBe(false);
    await expect(configureCover(ui.page, op, async () => {}, 10)).rejects.toThrow('interrupted');
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(1); ui.win.close();
  });
  it('reads back a successful confirmation after the input response was lost, without manual confirmation', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    const native = ui.page.nativeClickOnce.getMockImplementation();
    ui.page.nativeClickOnce.mockImplementation(async (...args) => { await native(...args); throw Error('release response lost'); });
    await configureCover(ui.page, op, async () => {}, 10);
    expect(op.cover.phase).toBe('configured');
    expect(op.cover.activation).toMatchObject({ status: 'verified', method: 'native-pointer-once' });
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(1);
    expect(op.cover.manual_confirmations).toBeUndefined();
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('reconciles a late successful card update and continues the remaining role without reuploading', async () => {
    const ui = browser(), horizontal = await source(), vertical = await source('vertical.jpg');
    const op = { operation_id: 'bound', cover: await requestedCovers({ cover: horizontal.path, 'vertical-cover': vertical.path }) };
    const native = ui.page.nativeClickOnce.getMockImplementation();
    ui.page.nativeClickOnce.mockRejectedValueOnce(Error('response lost'));
    await expect(configureCover(ui.page, op, async () => {}, 10)).rejects.toThrow('response lost');
    // The platform finishes the original gesture after the caller lost its
    // response. Resume may observe this change but must not issue it again.
    await native();
    await configureCover(ui.page, op, async () => {}, 10);
    expect(ui.calls.filter(([name]) => name === 'upload')).toEqual([['upload', [horizontal.path]], ['upload', [vertical.path]]]);
    expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(2);
    expect(op.cover.manual_confirmations).toBeUndefined();
    await verifyCover(ui.page, op); ui.win.close();
  });
  it('reports a crop dialog after a confirmation attempt immediately, retaining uncertainty without another click', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const crop = ui.win.document.createElement('div'); crop.className = 'weui-desktop-dialog'; crop.hidden = true;
    crop.innerHTML = '<h3>裁剪封面图</h3><canvas class="cr-image" width="100" height="100"></canvas><button>确定</button>';
    crop.querySelector('button').getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 30 });
    ui.root.append(crop);
    let confirms = 0;
    ui.root.querySelector('.cover-set-footer button:last-child').onclick = () => {
      confirms++; crop.hidden = false; ui.win.document.body.setAttribute('data-crop', 'shown');
    };
    await expect(configureCover(ui.page, op, async () => {}, 900)).rejects.toThrow('still in the crop dialog');
    expect(confirms).toBe(1); expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
    expect(op.cover).toMatchObject({ phase: 'confirm_unknown', last_observation: { cropping: true }, error: { phase: 'confirm_unknown' } });
    await expect(configureCover(ui.page, op, async () => {}, 900)).rejects.toThrow('interrupted');
    expect(confirms).toBe(1); expect(crop.hidden).toBe(false); ui.win.close();
  });
  it('chooses direct editing from a recommendation popover, never the suggested material', async () => {
    const ui = browser(), popover = ui.win.document.createElement('div');
    popover.className = 'img-recommend-wrap';
    popover.innerHTML = '<div class="btn-directly-edit"><button>直接编辑</button></div><div class="btn-use"><button>使用素材</button></div>';
    ui.root.append(popover);
    const state = await ui.win.eval(coverScript('open', 'bound'));
    expect(ui.root.querySelector(state.selector).textContent).toBe('直接编辑');
    expect(ui.root.querySelector('.btn-use button').hasAttribute('data-bycli-channels-cover')).toBe(false);
    ui.win.close();
  });
  it('stops a confirmation that leaves the editor open after 5s without a second confirmation or upload', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    ui.page.wait = async value => { now += (typeof value === 'number' ? value : value.time) * 1000; };
    const confirm = ui.root.querySelector('.cover-set-footer button:last-child');
    confirm.onclick = vi.fn();
    await expect(configureCover(ui.page, op, async () => {}, 900)).rejects.toThrow('confirm-response: no progress');
    expect(now).toBeLessThan(20000); expect(confirm.onclick).toHaveBeenCalledTimes(1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
    expect(op.cover.phase).toBe('confirm_unknown'); ui.win.close();
  });
  it('shares one total budget for both requested covers instead of renewing it for the second role', async () => {
    const ui = browser(), horizontal = await source(), vertical = await source('vertical.jpg');
    const op = { operation_id: 'bound', cover: await requestedCovers({ cover: horizontal.path, 'vertical-cover': vertical.path }) };
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    ui.page.wait = async value => { now += (typeof value === 'number' ? value : value.time) * 1000; };
    await expect(configureCover(ui.page, op, async () => {}, 7)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(op.cover.completedRoles.horizontal).toBeTruthy(); expect(op.cover.completedRoles.vertical).toBeUndefined();
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1); ui.win.close();
  });
  it('refuses source file changes before any browser mutation', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    await writeFile(op.cover.path, Buffer.from([255,216,255,0,9]));
    await expect(configureCover(ui.page, op, vi.fn(), 1)).rejects.toThrow('file changed');
    expect(ui.calls).toEqual([]); ui.win.close();
  });
  it('persists an uncertain upload before the native action and never reuploads it', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.page.uploadFiles = async () => { expect(op.cover.phase).toBe('upload_unknown'); throw Error('transport lost'); };
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('transport lost');
    ui.page.uploadFiles = vi.fn();
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('interrupted');
    expect(ui.page.uploadFiles).not.toHaveBeenCalled(); ui.win.close();
  });
  it('rejects the wrong editor and hands verification to the user', async () => {
    const ui = browser();
    expect(await ui.win.eval(coverScript('open', 'another'))).toMatchObject({ error: 'wrong_bound_editor' });
    ui.root.append(ui.win.document.createTextNode(''));
    const notice = ui.win.document.createElement('div'); notice.textContent = '安全验证'; ui.root.append(notice);
    expect(await ui.win.eval(coverScript('open', 'bound'))).toMatchObject({ error: 'verification_required' });
    ui.win.close();
  });
  it('requires all requested loaded resource identities', () => {
    expect(sameCovers({}, {})).toBe(false);
    expect(sameCovers({ vertical: 'v' }, { vertical: 'v', horizontal: 'h' })).toBe(true);
    expect(sameCovers({ vertical: 'v', horizontal: 'h' }, { vertical: 'v' })).toBe(false);
    expect(sameCovers({ vertical: 'v', horizontal: 'h' }, { vertical: 'v', horizontal: 'h' })).toBe(true);
  });
  it('never falls back or replays if the single-execution activation loses its response', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.page.evaluateOnce = vi.fn(async script => { await ui.win.eval(script); throw Error('response lost'); });
    await expect(configureCover(ui.page, op, async () => {}, 2)).rejects.toThrow('response lost');
    expect(op.cover.phase).toBe('upload_unknown');
    expect(op.cover.activation.status).toBe('reservation_unknown');
    expect(ui.page.nativeClickOnce).not.toHaveBeenCalled();
    await expect(configureCover(ui.page, op, async () => {}, 2)).rejects.toThrow('interrupted');
    expect(ui.page.evaluateOnce).toHaveBeenCalledTimes(1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1); ui.win.close();
  });
  it('reserves the native control once without DOM activation or a second reservation', async () => {
    const ui = browser(), image = await source();
    ui.root.querySelector('.horizon-img-wrap').click(); await ui.page.uploadFiles(null, [image.path]);
    const state = await ui.win.eval(coverScript('confirm', 'bound'));
    const script = coverControlScript('confirm', 'bound', 'horizontal', state.thumb, state.point);
    expect(await ui.win.eval(script)).toMatchObject({ reserved: true });
    expect(ui.root.querySelector('.weui-desktop-dialog').hidden).toBe(false);
    ui.root.querySelector('.horizon-img-wrap').click();
    expect(await ui.win.eval(script)).toEqual({ error: 'cover_action_already_attempted' }); ui.win.close();
  });
  it('reconciles a manually confirmed role and configures only the remaining role on the retained page', async () => {
    const ui = browser(), horizontal = await source(), vertical = await source('portrait.jpg');
    const op = { operation_id: 'bound', cover: await requestedCovers({ cover: horizontal.path, 'vertical-cover': vertical.path }) };
    ui.page.nativeClickOnce.mockImplementationOnce(async () => { throw Error('activation interrupted'); });
    await expect(configureCover(ui.page, op, async () => {}, 2)).rejects.toThrow('activation interrupted');
    await expect(reconcileConfirmedCover(ui.page, op, 'horizontal', async () => {})).rejects.toThrow('not visible');
    ui.root.querySelector('.cover-set-footer button:last-child').click();
    await expect(reconcileConfirmedCover(ui.page, op, 'vertical', async () => {})).rejects.toThrow('pending role');
    await reconcileConfirmedCover(ui.page, op, 'horizontal', async () => {});
    expect(op.cover.manual_confirmations).toHaveLength(1);
    await configureCover(ui.page, op, async () => {}, 2);
    expect(ui.calls.filter(([name]) => name === 'upload')).toEqual([['upload', [horizontal.path]], ['upload', [vertical.path]]]);
    await verifyCover(ui.page, op); ui.win.close();
  });
it('allows only one explicitly requested retry after a proven pre-injection failure', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    ui.page.uploadFiles = vi.fn(async () => { throw Object.assign(new Error('input disappeared'), { code: 'UPLOAD_NOT_STARTED' }); });
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('input disappeared');
    expect(op.cover.upload.effect).toBe('none');
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('Retry requires');
    expect(ui.page.uploadFiles).toHaveBeenCalledTimes(1);
    await expect(configureCover(ui.page, op, async () => {}, 1, undefined, 'horizontal')).rejects.toThrow('input disappeared');
    expect(ui.page.uploadFiles).toHaveBeenCalledTimes(2);
    await expect(configureCover(ui.page, op, async () => {}, 1, undefined, 'horizontal')).rejects.toThrow('Retry requires');
    expect(ui.page.uploadFiles).toHaveBeenCalledTimes(2); ui.win.close();
  });
it('does not confirm an uploaded thumbnail when the platform has not selected its custom source', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    ui.page.wait = async () => { clock += 10; };
    const upload = ui.page.uploadFiles;
    ui.page.uploadFiles = async (...args) => {
      await upload(...args);
      ui.root.querySelector('.weui-desktop-dialog').__vue__.$data.useCustomCover = false;
    };
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('timed out');
    expect(ui.calls.filter(([name, selector]) => name === 'click' && selector.includes('confirm'))).toHaveLength(0);
    expect(op.cover.phase).toBe('upload_unknown'); ui.win.close();
  });
it('resumes an accepted custom source after a lost upload response without uploading again', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() }, upload = ui.page.uploadFiles;
    ui.page.uploadFiles = async (...args) => { await upload(...args); throw new Error('response lost'); };
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('response lost');
    expect(op.cover.upload.effect).toBe('unknown');
    ui.page.uploadFiles = vi.fn(); await configureCover(ui.page, op, async () => {}, 1);
    expect(ui.page.uploadFiles).not.toHaveBeenCalled(); await verifyCover(ui.page, op); ui.win.close();
  });
it.each(['upload_unknown', 'confirm_unknown'])('reconciles a manually completed %s cover without another input action', async phase => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    await configureCover(ui.page, op, async () => {}, 1);
    const calls = ui.calls.length; op.cover.phase = phase; op.cover.role = 'horizontal';
    delete op.cover.completedRoles.horizontal;
    await reconcileConfirmedCover(ui.page, op, 'horizontal', async () => {});
    await configureCover(ui.page, op, async () => {}, 1);
    expect(ui.calls).toHaveLength(calls); await verifyCover(ui.page, op); ui.win.close();
  });
it('recovers one exact native processing failure, never an unproven confirmation', async () => {
    const ui = browser(), op = { operation_id: 'bound', cover: await source() };
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    ui.page.wait = async () => { clock += 10; };
    const click = ui.page.nativeClickOnce;
    ui.page.nativeClickOnce = async (...args) => { if (ui.root.querySelector('[data-bycli-channels-cover]')?.getAttribute('data-bycli-channels-cover') !== 'confirm') await click(...args); };
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('timed out');
    expect(op.cover.activation.status).toBe('dispatched');
    ui.page.consoleMessages = async () => [];
    expect(await recoverCoverProcessing(ui.page, op, async () => {}, publishWait(1))).toBe(false);
    ui.page.consoleMessages = async () => [{ timestamp: Date.parse(op.cover.activation.at), text: 'imgSizeInvalid width=0 height=0' }];
    expect(await recoverCoverProcessing(ui.page, op, async () => {}, publishWait(1))).toBe(true);
    expect(op.cover.processing_retries.horizontal).toBe(1);
    ui.page.nativeClickOnce = click; await configureCover(ui.page, op, async () => {}, 1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(2); ui.win.close();
  });
it('waits for both initial cards instead of freezing an empty baseline', async () => {
  const ui = browser(), op = { operation_id: 'bound', cover: await source() };
  const image = ui.root.querySelector('img.horizon-img-size');
  Object.defineProperty(image, 'naturalWidth', { value: 0, configurable: true });
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  ui.page.wait = async () => {
    clock += 100;
    Object.defineProperty(image, 'naturalWidth', { value: 1920, configurable: true });
  };
  await configureCover(ui.page, op, async () => {}, 10);
  expect(Object.keys(op.cover.originalIdentities)).toHaveLength(2);
  expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(1);
  ui.win.close();
});
it('reports a reloadable load failure after 20s without uploading or persisting an empty baseline', async () => {
  const ui = browser(), op = { operation_id: 'bound', cover: await source() };
  ui.root.querySelectorAll('.edit-btn').forEach(e => e.remove());
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  ui.page.wait = async () => { clock += 5000; };
  await expect(configureCover(ui.page, op, async () => {}, 180)).rejects.toMatchObject({ code: 'COVER_NOT_READY' });
  expect(op.cover.originalIdentities).toBeUndefined();
  expect(op.cover.phase).toBe('pending');
  expect(ui.calls).toEqual([]);
  ui.win.close();
});
it('bounds an uninitialized empty cover dialog before injecting a file', async () => {
  const ui = browser(), op = { operation_id: 'bound', cover: await source() };
  ui.root.querySelector('.weui-desktop-dialog').__vue__.$data.isVideoInitialized = false;
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  ui.page.wait = async () => { clock += 1000; };
  await expect(configureCover(ui.page, op, async () => {}, 180)).rejects.toMatchObject({ code: 'COVER_NOT_READY' });
  expect(op.cover.phase).toBe('opening'); expect(op.cover.upload).toBeUndefined();
  expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(0);
  ui.win.close();
});
it('finishes both covers from verified platform state even when native injection consumes FileList', async () => {
  const ui = browser(), horizontal = await source(), vertical = await source('vertical.jpg');
  const op = { operation_id: 'bound', cover: await requestedCovers({ cover: horizontal.path, 'vertical-cover': vertical.path }) };
  const upload = ui.page.uploadFiles;
  ui.page.uploadFiles = async (...args) => {
    await upload(...args);
    return { uploaded: true, files: 1, file_names: [], file_list_verified: false };
  };
  await configureCover(ui.page, op, async () => {}, 1);
  expect(op.cover.phase).toBe('configured');
  expect(Object.keys(op.cover.completedRoles).sort()).toEqual(['horizontal', 'vertical']);
  expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(2);
  expect(ui.page.nativeClickOnce).toHaveBeenCalledTimes(2);
  ui.win.close();
});
});
