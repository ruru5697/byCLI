import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { webcrypto, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverScript, localCover, configureCover, verifyCover, sameCovers, requestedCovers, reconcileConfirmedCover, recoverCoverProcessing } from './_shared/cover.js';
import { publishWait } from './_shared/wait.js';
import { validatePublishArgs } from './_shared/publish.js';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'channels-cover-')); });
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
  const data = { isVideoInitialized: true, currentCoverImageUrl: 'default', useCustomCover: false };
  const cropData = { isCroppieReady: true, lastImageUrl: 'default' };
  const renderer = { $options: { methods: { getOriginalCanvas() {} } }, $props: { imageUrl: 'default' }, $data: cropData };
  dialog.__vue__ = { $options: { name: 'EditCoverDialog' }, $data: data };
  dialog.querySelector('.preview-item').__vue__ = renderer;
  const render = () => win.document.body.setAttribute('data-render', String(Math.random()));
  let role = 'horizontal';
  for (const name of ['horizontal', 'vertical']) root.querySelector(name === 'vertical' ? '.vertical-img-wrap' : '.horizon-img-wrap').onclick = () => {
    role = name; dialog.querySelector('h3').textContent = role === 'vertical' ? '编辑个人主页卡片' : '编辑分享卡片'; dialog.hidden = false; render();
  };
  root.querySelector('.cover-set-footer button:first-child').onclick = () => { dialog.hidden = true; data.useCustomCover = false; render(); };
  root.querySelector('.cover-set-footer button:last-child').onclick = () => {
    dialog.hidden = true;
    const img = root.querySelector(role === 'vertical' ? 'img.vertical-img-size' : 'img.horizon-img-size'); img.src = img.src.replace('original_', 'custom_');
    render();
  };
  const calls = [];
  const page = {
    focusWindow: vi.fn(), hover: vi.fn(), wait: vi.fn(),
    evaluate: async script => win.eval(script),
    click: async selector => { calls.push(['click', selector]); root.querySelector(selector).click(); },
    uploadFiles: async (selector, files) => {
      calls.push(['upload', files]);
      root.querySelector('.single-cover-uploader-wrap img').src = `data:image/jpeg;base64,${(await readFile(files[0])).toString('base64')}`;
      data.useCustomCover = true;
      data.customCoverPreviewUrl = root.querySelector('.single-cover-uploader-wrap img').src;
      data.currentCoverImageUrl = data.customCoverPreviewUrl;
      renderer.$props.imageUrl = data.currentCoverImageUrl; cropData.lastImageUrl = data.currentCoverImageUrl;
      render();
    },
  };
  return { page, root, win, calls };
}

describe('optional video cover configuration', () => {
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
    const click = ui.page.click;
    ui.page.click = async selector => { if (!selector.includes('confirm')) await click(selector); };
    ui.page.clickOnce = selector => ui.page.click(selector);
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('timed out');
    expect(op.cover.activation.status).toBe('dispatched');
    ui.page.consoleMessages = async () => [];
    expect(await recoverCoverProcessing(ui.page, op, async () => {}, publishWait(1))).toBe(false);
    ui.page.consoleMessages = async () => [{ timestamp: Date.parse(op.cover.activation.at), text: 'imgSizeInvalid width=0 height=0' }];
    expect(await recoverCoverProcessing(ui.page, op, async () => {}, publishWait(1))).toBe(true);
    expect(op.cover.processing_retries.horizontal).toBe(1);
    ui.page.click = click; await configureCover(ui.page, op, async () => {}, 1);
    expect(ui.calls.filter(([name]) => name === 'upload')).toHaveLength(2); ui.win.close();
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
    await configureCover(ui.page, op, async () => { if (phases.at(-1) !== op.cover.phase) phases.push(op.cover.phase); }, 1);
    expect(phases).toEqual(['opening', 'upload_unknown', 'confirm_unknown', 'pending', 'opening', 'upload_unknown', 'confirm_unknown', 'pending', 'configured']);
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
    ui.root.append(crop);
    const upload = ui.page.uploadFiles; let pending;
    const render = () => ui.win.document.body.setAttribute('data-crop', String(Math.random()));
    ui.page.uploadFiles = async (...args) => { pending = args; crop.hidden = false; render(); };
    let crops = 0;
    const click = ui.page.click;
    ui.page.click = async selector => {
      if (ui.root.querySelector(selector) === crop.querySelector('button')) { crops++; await upload(...pending); crop.hidden = true; render(); }
      else await click(selector);
    };
    await configureCover(ui.page, op, async () => {}, 1);
    expect(crops).toBe(1); await verifyCover(ui.page, op); ui.win.close();
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
    await expect(configureCover(ui.page, op, async () => {}, 1)).rejects.toThrow('unknown');
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
  expect(ui.calls.filter(([name, selector]) => name === 'click' && selector.includes('confirm'))).toHaveLength(2);
  ui.win.close();
});
