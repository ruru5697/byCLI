import { ArgumentError, CliError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { publishWait } from './wait.js';

export async function localCover(value, flag = 'cover') {
  if (typeof value !== 'string' || !/\.(png|jpe?g)$/i.test(value)) throw new ArgumentError(`--${flag} must be a local PNG or JPEG image`);
  const path = resolve(value);
  let info, bytes;
  try { info = await stat(path); if (info.isFile()) bytes = await readFile(path); } catch { /* Return a stable input error. */ }
  if (!bytes?.length) throw new ArgumentError('Cover image must be a nonempty local file');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new ArgumentError('Cover contents must be PNG or JPEG');
  return { path, bytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// Each native card editor transcodes its own selected source. Track complete
// resource identities independently, never a URL prefix.
export function coverSources(cover) {
  return cover?.sources ?? (cover?.path ? { horizontal: cover } : {});
}
export function untouchedCover(cover) {
  return ['pending', 'opening'].includes(cover?.phase) && !cover.upload && !cover.activation && !cover.pending_thumb
    && !cover.saved && !cover.save_attempted && !Object.keys(cover.completedRoles ?? {}).length;
}
export async function requestedCovers(args) {
  const sources = {};
  for (const [role, flag] of [['horizontal', 'cover'], ['vertical', 'vertical-cover']]) {
    if (args[flag] !== undefined) sources[role] = await localCover(args[flag], flag);
  }
  return Object.keys(sources).length ? { sources, phase: 'pending' } : undefined;
}
export async function coverDOM(action, operationId, role = 'horizontal') {
  if (!['horizontal', 'vertical'].includes(role)) return { error: 'invalid_cover_role' };
  if (location.origin !== 'https://channels.weixin.qq.com' || location.pathname !== '/platform/post/create'
    || document.documentElement.getAttribute('data-bycli-channels-operation') !== operationId) return { error: 'wrong_bound_editor' };
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const visible = el => {
    for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
      const style = getComputedStyle(n);
      if (n.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  const text = roots.flatMap(r => [...r.querySelectorAll('*')]).filter(e => !e.children.length && visible(e)).map(e => e.textContent.trim()).join('\n');
  if (/验证码|安全验证|扫码验证|管理员本人验证/.test(text)) return { error: 'verification_required' };
  const wraps = roots.flatMap(r => [...r.querySelectorAll('.cover-preview-wrap')]).filter(visible);
  if (wraps.length !== 1) return { error: 'cover_editor_loading' };
  const root = wraps[0].getRootNode();
  if (action === 'position') {
    const card = wraps[0].querySelector(role === 'vertical' ? '.vertical-cover-wrap' : '.horizon-cover-wrap');
    card?.scrollIntoView?.({ block: 'center', inline: 'center' });
    return { positioned: !!card };
  }
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(n => n.toString(16).padStart(2, '0')).join('');
  const cards = {};
  for (const [name, selector] of [['vertical', '.vertical-cover-wrap img.vertical-img-size'], ['horizontal', '.horizon-cover-wrap img.horizon-img-size']]) {
    const imgs = [...wraps[0].querySelectorAll(selector)];
    if (imgs.length !== 1 || !imgs[0].complete || !imgs[0].naturalWidth) continue;
    const url = new URL(imgs[0].currentSrc || imgs[0].src);
    if (url.protocol !== 'https:' || !/(^|\.)video\.qq\.com$/.test(url.hostname)) continue;
    // encfilekey and idx identify the resource. token is transient authorization;
    // rendition/transport parameters may be rewritten on native draft reload.
    if (!url.searchParams.get('encfilekey')) continue;
    const identity = JSON.stringify([url.origin, url.pathname, url.searchParams.get('encfilekey'), url.searchParams.get('idx')]);
    cards[name] = await hash(new TextEncoder().encode(identity));
  }
  const dialogs = [...root.querySelectorAll('.weui-desktop-dialog')].filter(visible);
  const edit = dialogs.filter(d => /^编辑(分享|个人主页)卡片$/.test(d.querySelector('h3')?.textContent.trim() || ''));
  const crop = dialogs.filter(d => d.querySelector('h3')?.textContent.trim() === '裁剪封面图');
  let thumb = null, previewReady = false;
  if (edit.length === 1) {
    const imgs = [...edit[0].querySelectorAll('.single-cover-uploader-wrap img.img-wrap')];
    if (imgs.length === 1 && imgs[0].complete && imgs[0].naturalWidth && /^data:image\/(png|jpeg);base64,/.test(imgs[0].src)) {
      thumb = await hash(Uint8Array.from(atob(imgs[0].src.split(',')[1]), c => c.charCodeAt(0)));
    }
    previewReady = [...edit[0].querySelectorAll('.preview-item img')].some(e => visible(e) && e.complete && e.naturalWidth > 0);
  }
  const components = new Set();
  for (const d of edit) for (const e of [d, ...d.querySelectorAll('*')]) {
    for (let vm = e.__vue__, n = 0; vm && n < 6; vm = vm.$parent, n++) components.add(vm);
  }
  const editor = [...components].find(vm => vm.$options?.name === 'EditCoverDialog');
  const renderer = [...components].find(vm => typeof vm.$options?.methods?.getOriginalCanvas === 'function');
  const data = editor?.$data, cropData = renderer?.$data;
  const render = { known: !!editor && !!renderer, video_initialized: data?.isVideoInitialized === true,
    cropper_ready: cropData?.isCroppieReady === true,
    image_bound: !!data?.currentCoverImageUrl && renderer?.$props?.imageUrl === data.currentCoverImageUrl && cropData?.lastImageUrl === data.currentCoverImageUrl,
    custom_source_selected: data?.useCustomCover === true && !!data?.customCoverPreviewUrl && data.currentCoverImageUrl === data.customCoverPreviewUrl };
  let selector = null, point = null;
  const mark = elements => {
    if (elements.length !== 1) return null;
    for (const el of root.querySelectorAll('[data-bycli-channels-cover]')) el.removeAttribute('data-bycli-channels-cover');
    elements[0].setAttribute('data-bycli-channels-cover', action);
    if (action === 'confirm' || action === 'crop') elements[0].scrollIntoView?.({ block: 'center', inline: 'center' });
    if (['open', 'confirm', 'crop'].includes(action)) {
      const rect = elements[0].getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight) point = { x, y };
    }
    return `[data-bycli-channels-cover="${action}"]`;
  };
  const roleTitle = role === 'vertical' ? '编辑个人主页卡片' : '编辑分享卡片';
  if (edit.length === 1 && edit[0].querySelector('h3')?.textContent.trim() !== roleTitle && action !== 'status') return { error: 'wrong_cover_dialog' };
  if (action === 'open' && !edit.length && !crop.length) {
    // The edit strip is the native hit area at the bottom of each card.
    // Hover may expose a recommendation; choose “直接编辑”, never “使用素材”.
    const direct = [...root.querySelectorAll('.img-recommend-wrap .btn-directly-edit button')].filter(e => visible(e) && e.textContent.trim() === '直接编辑' && !e.disabled);
    if (direct.length) selector = mark(direct);
    else selector = mark([...wraps[0].querySelectorAll(role === 'vertical' ? '.vertical-img-wrap .edit-btn' : '.horizon-img-wrap .edit-btn')].filter(visible));
  }
  if (action === 'upload' && edit.length === 1 && !crop.length && render.known && render.video_initialized) selector = mark([...edit[0].querySelectorAll('.single-cover-uploader-wrap > input[type="file"]')].filter(e => /image/.test(e.accept)));
  if (action === 'crop' && crop.length === 1 && [...crop[0].querySelectorAll('canvas.cr-image')].some(e => e.width > 0 && e.height > 0)) {
    selector = mark([...crop[0].querySelectorAll('button')].filter(e => visible(e) && e.textContent.trim() === '确定' && !e.disabled));
  }
  if (action === 'confirm' && edit.length === 1 && !crop.length && thumb && previewReady && Object.values(render).every(Boolean)) {
    selector = mark([...edit[0].querySelectorAll('.cover-set-footer button')].filter(e => visible(e) && e.textContent.trim() === '确认' && !e.disabled && !/disabled/.test(e.className)));
  }
  if (action === 'cancel' && edit.length === 1 && !crop.length) selector = mark([...edit[0].querySelectorAll('.cover-set-footer button')].filter(e => visible(e) && e.textContent.trim() === '取消' && !e.disabled));
  return { render, cards, thumb, previewReady, dialog: edit.length === 1, cropping: crop.length === 1, selector, point };
}

export const coverScript = (action, id, role = 'horizontal') => `(${coverDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(id)},${JSON.stringify(role)})`;
export async function coverState(page, op, action = 'status', role = 'horizontal') {
  const state = await page.evaluate(coverScript(action, op.operation_id, role));
  if (!state || state.error) throw new CommandExecutionError(`Cover editor unavailable: ${state?.error || 'invalid response'}`);
  return state;
}
export function sameCovers(expected, actual) {
  const keys = Object.keys(expected ?? {});
  return keys.length > 0 && keys.every(k => ['vertical', 'horizontal'].includes(k) && typeof expected[k] === 'string' && expected[k] === actual?.[k]);
}
export async function verifyCover(page, op, allowLoading = false) {
  if (!op.cover) return;
  const state = await coverState(page, op);
  if (allowLoading && !state.dialog && !state.cropping && Object.keys(coverSources(op.cover)).some(k => !state.cards[k])) return false;
  if (state.dialog || state.cropping || !Object.keys(coverSources(op.cover)).every(k => op.cover.identities?.[k]) || !sameCovers(op.cover.identities, state.cards)) throw new CommandExecutionError('Saved custom cover identities changed or are not loaded; refusing publication');
}

export async function reconcileConfirmedCover(page, op, role, persist) {
  if (!op.cover || !['upload_unknown', 'confirm_unknown'].includes(op.cover.phase) || op.cover.role !== role || !coverSources(op.cover)[role]
    || op.cover.saved || op.cover.save_attempted) throw new CommandExecutionError('Manual cover confirmation does not match the pending role');
  for (const source of Object.values(coverSources(op.cover))) if ((await localCover(source.path)).sha256 !== source.sha256) throw new CommandExecutionError('Recorded cover file changed; refusing recovery');
  const state = await coverState(page, op, 'status', role);
  if (!confirmedCard(op, state, role)) throw new CommandExecutionError('Manually confirmed cover is not visible as a changed card or another card changed; retain the editor');
  op.cover.completedRoles ??= {};
  op.cover.completedRoles[role] = state.cards[role]; op.cover.phase = 'pending';
  op.cover.manual_confirmations = [...(op.cover.manual_confirmations || []), { role, at: new Date().toISOString(), identity: state.cards[role] }];
  delete op.cover.error; await persist();
}

function confirmedCard(op, state, role) {
  if (state.dialog || state.cropping || !state.cards[role] || !op.cover.originalIdentities?.[role]
    || state.cards[role] === op.cover.originalIdentities[role]) return false;
  return ['horizontal', 'vertical'].filter(r => r !== role).every(other => {
    const expected = op.cover.completedRoles?.[other] || op.cover.originalIdentities?.[other];
    return !!expected && state.cards[other] === expected;
  });
}


export async function configureCover(page, op, persist, timeout, wait = publishWait(timeout), retryUploadRole = null) {
  if (!op.cover) return;
  const sources = coverSources(op.cover);
  for (const source of Object.values(sources)) if ((await localCover(source.path)).sha256 !== source.sha256) throw new CommandExecutionError('Recorded cover file changed; refusing upload');
  if (op.cover.phase === 'configured') { await verifyCover(page, op); return; }
  op.cover.phase ??= 'pending';
  if (!['pending', 'opening', 'upload_unknown', 'confirm_unknown'].includes(op.cover.phase)) throw new CommandExecutionError('Cover action outcome is unknown; inspect the retained editor without another click');
  op.cover.completedRoles ??= {};
  if (op.cover.phase === 'pending' && untouchedCover(op.cover)) {
    const deadline = Math.min(wait.deadline, Date.now() + 20_000);
    const stage = await wait.stage('cover-load');
    let initial;
    do {
      initial = await page.evaluate(coverScript('open', op.operation_id, Object.keys(sources)[0]));
      if (!initial || initial.error && initial.error !== 'cover_editor_loading') throw new CommandExecutionError(`Cover editor unavailable: ${initial?.error || 'invalid response'}`);
      if (initial.dialog || initial.cropping || initial.thumb) throw new CommandExecutionError('An unrecorded cover dialog is open; retain the editor');
      await stage.observe({ cards: Object.keys(initial.cards ?? {}).length, edit_control: !!initial.selector });
      if (initial.cards?.horizontal && initial.cards?.vertical && initial.selector) break;
      await page.wait(0.5);
    } while (Date.now() < deadline);
    wait.assertRemaining();
    if (!initial.cards?.horizontal || !initial.cards?.vertical || !initial.selector) {
      throw new CliError('COVER_NOT_READY', 'Cover previews or edit control did not load within 20s', 'Reopen the same saved draft before any cover upload; do not upload the video again');
    }
    if (Object.keys(op.cover.originalIdentities ?? {}).length && !sameCovers(op.cover.originalIdentities, initial.cards)) throw new CommandExecutionError('Original cover cards changed before upload');
    op.cover.originalIdentities = initial.cards;
  } else op.cover.originalIdentities ??= (await coverState(page, op)).cards;
  for (const role of Object.keys(sources)) {
    if (op.cover.completedRoles[role]) {
      if ((await coverState(page, op)).cards[role] !== op.cover.completedRoles[role]) throw new CommandExecutionError('Partially configured cover changed; inspect the retained editor');
      continue;
    }
    if (op.cover.phase !== 'pending' && op.cover.role !== role) throw new CommandExecutionError('Interrupted cover role changed; inspect the retained editor');
    await configureRole(page, op, persist, timeout, role, wait, retryUploadRole === role);
  }
  const final = await coverState(page, op);
  if (!Object.keys(sources).every(k => final.cards[k] && final.cards[k] !== op.cover.originalIdentities[k])) throw new CommandExecutionError('Each requested card cover must use its uploaded image before saving');
  for (const role of ['horizontal', 'vertical']) if (!sources[role] && final.cards[role] !== op.cover.originalIdentities[role]) throw new CommandExecutionError('Unrequested default cover changed; inspect it before saving');
  op.cover.phase = 'configured'; op.cover.identities = Object.fromEntries(Object.keys(sources).map(k => [k, final.cards[k]])); await persist();
}

async function configureRole(page, op, persist, timeout, role, wait, retryUpload) {
  const deadline = wait.deadline;
  const before = op.cover.originalIdentities[role];
  let state, stage;
  if (['opening', 'upload_unknown'].includes(op.cover.phase)) {
    const current = await coverState(page, op, 'status', role);
    if (!['horizontal', 'vertical'].every(k => current.cards[k] && current.cards[k] === (op.cover.completedRoles[k] || op.cover.originalIdentities[k]))) throw new CommandExecutionError('Retained cover cards changed before recovery');
  }
  if (op.cover.phase === 'confirm_unknown') {
    state = await coverState(page, op, 'status', role);
    if (!state.dialog && !state.cropping && op.cover.pending_thumb && (op.cover.upload?.effect === 'confirmed' || op.cover.activation?.method === 'native-pointer-once' && op.cover.activation?.action === 'confirm' && ['dispatched', 'dispatch_unknown'].includes(op.cover.activation?.status))
      && state.cards[role] && state.cards[role] !== before) {
      op.cover.completedRoles[role] = state.cards[role]; op.cover.phase = 'pending'; await persist(); return;
    }
    throw new CommandExecutionError('Cover confirmation remains unknown; inspect the retained editor without clicking again');
  }
  if (op.cover.phase === 'upload_unknown') {
    state = await coverState(page, op, 'confirm', role);
    if (op.cover.upload?.effect === 'none' && retryUpload && !op.cover.upload.retry_consumed) {
      if (state.thumb || state.cropping || state.cards[role] !== before || !state.dialog) throw new CommandExecutionError('Cover retry evidence changed; retain the editor');
      op.cover.upload.retry_consumed = true; op.cover.phase = 'opening'; await persist();
    } else if (op.cover.upload?.effect === 'none' || !state.thumb || !state.render?.custom_source_selected) {
      throw new CommandExecutionError('Cover upload is unknown; inspect the retained editor. Retry requires a recorded no-injection error and --retry-cover-upload');
    }
  }
  if (op.cover.phase === 'pending') {
    stage = await wait.stage(`cover-${role}-open`);
    const openDeadline = Math.min(deadline, Date.now() + 20_000);
    while (Date.now() < openDeadline) {
      await coverState(page, op, 'position', role);
      state = await coverState(page, op, 'open', role);
      await stage.observe({ dialog: state.dialog, available: !!state.selector });
      if (state.selector) break;
      await page.wait(0.5);
    }
    wait.assertRemaining();
    if (!state?.selector) throw new CliError('COVER_NOT_READY', 'Native cover edit control did not load within 20s');
    op.cover.phase = 'opening'; op.cover.role = role; await persist(); await clickCoverControl(page, state);
  }
  if (op.cover.phase === 'opening') {
    stage = await wait.stage(`cover-${role}-initialization`);
    let nextOpenAt = Date.now() + 3000;
    const initializationDeadline = Math.min(deadline, Date.now() + 20_000);
    while (Date.now() < initializationDeadline) {
      state = await coverState(page, op, 'upload', role);
      await stage.observe({ dialog: state.dialog, cropping: state.cropping, available: !!state.selector, render: state.render });
      if (state.selector) break;
      if (!state.dialog && !state.cropping && Date.now() >= nextOpenAt) {
        nextOpenAt = Date.now() + 3000;
        const open = await coverState(page, op, 'open', role);
        if (open.selector) await clickCoverControl(page, open);
      }
      await page.wait(0.25);
    }
    wait.assertRemaining();
    if (!state?.selector) throw new CliError('COVER_NOT_READY', 'Native cover file input did not become ready within 20s');
    const retryConsumed = op.cover.upload?.retry_consumed === true;
    op.cover.phase = 'upload_unknown'; op.cover.upload = { effect: 'in_flight', retry_consumed: retryConsumed }; await persist();
    try { await page.uploadFiles(state.selector, [coverSources(op.cover)[role].path]); }
    catch (error) {
      op.cover.upload.effect = ['UPLOAD_NOT_STARTED', 'not_file_input', 'stale_ref', 'selector_not_found'].includes(error.code) ? 'none' : 'unknown';
      op.cover.upload.error_code = error.code ?? 'unknown'; await persist(); throw error;
    }
  }
  stage = await wait.stage(`cover-${role}-processing`);
  let cropClicked = false;
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'confirm', role);
    await stage.observe({ dialog: state.dialog, cropping: state.cropping, preview_ready: state.previewReady, render: state.render },
      { thumb: state.thumb, cropping: state.cropping, render: state.render });
    if (state.cropping && !cropClicked) {
      if (op.cover.crop_attempted) throw new CommandExecutionError('Crop confirmation already attempted; inspect the retained editor');
      const crop = await coverState(page, op, 'crop', role);
      if (crop.selector) { cropClicked = true; op.cover.crop_attempted = true; await persist(); await clickCoverControl(page, crop); }
    }
    if (state.selector && state.thumb) break;
    await page.wait(0.25);
  }
  if (!state?.selector || !state.thumb) throw new TimeoutError('Uploaded cover preview', timeout);
  // Recheck after focus/hover settling; never confirm a stale selector/source.
  await page.focusWindow?.(); await page.hover?.(state.selector); await page.wait(0.15);
  const settled = await coverState(page, op, 'confirm', role);
  if (!settled.selector || settled.thumb !== state.thumb || !settled.render?.custom_source_selected) throw new CommandExecutionError('Cover source changed before confirmation; retain the editor');
  op.cover.pending_thumb = settled.thumb; op.cover.upload = { ...op.cover.upload, effect: 'confirmed' };
  op.cover.phase = 'confirm_unknown';
  op.cover.activation = { role, action: 'confirm', method: page.nativeClickOnce || page.clickOnce ? 'native-pointer-once' : 'backend-click', status: 'dispatch_unknown', at: new Date().toISOString() };
  await persist(); await clickCoverControl(page, settled);
  op.cover.activation.status = 'dispatched'; await persist();
  stage = await wait.stage(`cover-${role}-card-image`);
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'status', role);
    await stage.observe({ dialog: state.dialog, cropping: state.cropping, card_updated: !!state.cards[role] && state.cards[role] !== before });
    if (!state.dialog && !state.cropping && state.cards[role] && state.cards[role] !== before) {
      op.cover.completedRoles[role] = state.cards[role]; op.cover.phase = 'pending'; delete op.cover.crop_attempted; await persist(); return;
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Custom cover card image', timeout);
}

async function clickCoverControl(page, state) {
  // Let focus and modal scrolling settle before dispatching native pointer input.
  await page.focusWindow?.(); await page.wait({ time: 1 });
  await page.hover?.(state.selector); await page.wait(0.5);
  if (state.point && (page.nativeClickOnce || page.nativeClick)) await (page.nativeClickOnce ?? page.nativeClick).call(page, state.point.x, state.point.y);
  else await (page.clickOnce ?? page.click).call(page, state.selector);
  await page.wait({ time: 1 });
}

export async function recoverCoverProcessing(page, op, persist, wait) {
  const a = op.cover?.activation, role = op.cover?.role;
  if (op.cover?.phase !== 'confirm_unknown' || a?.action !== 'confirm' || a.role !== role
    || a.method !== 'native-pointer-once' || a.status !== 'dispatched' || op.cover.save_attempted || op.cover.saved
    || (op.cover.processing_retries?.[role] || 0) >= 1 || typeof page.consoleMessages !== 'function') return false;
  const state = await coverState(page, op, 'status', role);
  const unchanged = current => ['horizontal', 'vertical'].every(k => current.cards[k] && current.cards[k] === (op.cover.completedRoles?.[k] || op.cover.originalIdentities?.[k]));
  if (!state.dialog || state.cropping || !op.cover.pending_thumb || state.thumb !== op.cover.pending_thumb || !unchanged(state)) return false;
  const after = Date.parse(a.at);
  const errors = (await page.consoleMessages('error')).filter(e => Number(e.timestamp) >= after && Number(e.timestamp) <= after + 15000 && /imgSizeInvalid width=0 height=0/.test(e.text || ''));
  if (!Number.isFinite(after) || errors.length !== 1) return false;
  for (const source of Object.values(coverSources(op.cover))) if ((await localCover(source.path)).sha256 !== source.sha256) return false;
  const cancel = await coverState(page, op, 'cancel', role);
  if (!cancel.selector) return false;
  op.cover.processing_retries ??= {}; op.cover.processing_retries[role] = 1;
  op.cover.processing_failures = [...(op.cover.processing_failures || []), { role, at: a.at, code: 'native_canvas_size_zero' }];
  op.cover.phase = 'cancel_unknown'; await persist(); await clickCoverControl(page, cancel);
  const stage = await wait.stage(`cover-${role}-failed-processing-cancel`);
  while (Date.now() < wait.deadline) {
    const current = await coverState(page, op, 'status', role);
    if (!unchanged(current)) throw new CommandExecutionError('Cover changed during processing recovery');
    await stage.observe({ dialog: current.dialog, cropping: current.cropping });
    if (!current.dialog && !current.cropping) { op.cover.phase = 'pending'; delete op.cover.upload; delete op.cover.crop_attempted; await persist(); return true; }
    await page.wait(0.5);
  }
  return false;
}
