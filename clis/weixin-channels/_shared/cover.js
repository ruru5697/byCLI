import { ArgumentError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
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
export async function requestedCovers(args) {
  const sources = {};
  for (const [role, flag] of [['horizontal', 'cover'], ['vertical', 'vertical-cover']]) {
    if (args[flag] !== undefined) sources[role] = await localCover(args[flag], flag);
  }
  return Object.keys(sources).length ? { sources, phase: 'pending' } : undefined;
}
export async function coverDOM(action, operationId, role = 'horizontal') {
  const positionControl = action === 'position-confirm' || action === 'position-crop' || action === 'position-cancel';
  if (positionControl) action = action.slice('position-'.length);
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
  // Observe the native component's readiness; never invoke its private methods.
  // Video initialization can asynchronously replace a freshly uploaded image.
  const components = new Set();
  for (const d of edit) for (const e of [d, ...d.querySelectorAll('*')]) {
    for (let vm = e.__vue__, n = 0; vm && n < 6; vm = vm.$parent, n++) components.add(vm);
  }
  const editor = [...components].find(vm => vm.$options?.name === 'EditCoverDialog');
  const renderer = [...components].find(vm => typeof vm.$options?.methods?.getOriginalCanvas === 'function');
  const data = editor?.$data, cropData = renderer?.$data;
  const imageBound = !!data?.currentCoverImageUrl && renderer?.$props?.imageUrl === data.currentCoverImageUrl
    && cropData?.lastImageUrl === data.currentCoverImageUrl;
  const render = { known: !!editor && !!renderer, video_initialized: data?.isVideoInitialized === true,
    cropper_ready: cropData?.isCroppieReady === true, image_bound: imageBound,
    custom_source_selected: data?.useCustomCover === true && !!data?.customCoverPreviewUrl
      && data.currentCoverImageUrl === data.customCoverPreviewUrl };
  const editorReady = render.known && render.video_initialized && render.cropper_ready && render.image_bound;
  let selector = null, point = null, obscured = false;
  const mark = elements => {
    if (elements.length !== 1) return null;
    for (const el of root.querySelectorAll('[data-bycli-channels-cover]')) el.removeAttribute('data-bycli-channels-cover');
    elements[0].setAttribute('data-bycli-channels-cover', action);
    // Scroll once before settling, not on every inspection/guard. Repeated
    // scrolling can move the dialog between hit testing and browser input.
    if (positionControl) elements[0].scrollIntoView?.({ block: 'center', inline: 'center' });
    if (['open', 'confirm', 'crop', 'cancel'].includes(action)) {
      const rect = elements[0].getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight) {
        point = { x, y };
        // A modal can move or become covered while native focus/hover settles.
        // Never dispatch a confirm/crop click to a different control at that point.
        if (['confirm', 'crop', 'cancel'].includes(action) && document.elementFromPoint) {
          let hit = document.elementFromPoint(x, y);
          for (;;) {
            const inner = hit?.shadowRoot?.elementFromPoint?.(x, y);
            if (!inner || inner === hit) break;
            hit = inner;
          }
          obscured = !hit || !elements[0].contains(hit);
        }
      }
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
  if (action === 'confirm' && edit.length === 1 && !crop.length && thumb && previewReady && editorReady && render.custom_source_selected) {
    selector = mark([...edit[0].querySelectorAll('.cover-set-footer button')].filter(e => visible(e) && e.textContent.trim() === '确认' && !e.disabled && !/disabled/.test(e.className)));
  }
  if (action === 'cancel' && edit.length === 1 && !crop.length) selector = mark([...edit[0].querySelectorAll('.cover-set-footer button')].filter(e => visible(e) && e.textContent.trim() === '取消' && !e.disabled));
  const state = { render, cards, thumb, previewReady, dialog: edit.length === 1, cropping: crop.length === 1, selector, point, obscured, topWindow: window === top };
  if (action === 'diagnostics') {
    // Read-only render evidence: a loaded upload thumbnail alone does not
    // prove the platform selected it as the crop/confirmation source.
    state.images = [...edit, ...crop].flatMap(d => [...d.querySelectorAll('img')]).map(e => ({
      classes: e.className, complete: e.complete, width: e.naturalWidth, height: e.naturalHeight,
      source_kind: e.src.startsWith('data:') ? 'data' : e.src.startsWith('blob:') ? 'blob' : 'remote',
      ancestors: [e.parentElement, e.parentElement?.parentElement, e.parentElement?.parentElement?.parentElement]
        .filter(Boolean).map(n => ({ tag: n.tagName, classes: n.className })),
    }));
    state.canvases = [...edit, ...crop].flatMap(d => [...d.querySelectorAll('canvas')]).map(e => ({ classes: e.className, width: e.width, height: e.height }));
    const controls = [...edit, ...crop].flatMap(d => [...d.querySelectorAll('button')])
      .filter(e => visible(e) && /^(确认|确定|取消)$/.test(e.textContent.trim()));
    state.dialog_titles = [...edit, ...crop].map(d => d.querySelector('h3')?.textContent.trim());
    state.controls = controls.map(e => {
      const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      let hit = document.elementFromPoint?.(x, y);
      for (;;) { const inner = hit?.shadowRoot?.elementFromPoint?.(x, y); if (!inner || inner === hit) break; hit = inner; }
      return { label: e.textContent.trim(), disabled: e.disabled, aria_disabled: e.getAttribute('aria-disabled'),
        classes: e.className, pointer_events: getComputedStyle(e).pointerEvents,
        rect: { x, y, width: r.width, height: r.height }, hit_matches: !!hit && e.contains(hit), hit_tag: hit?.tagName || null };
    });
    state.viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      top_window: window === top, visual_scale: globalThis.visualViewport?.scale ?? null };
  }
  return state;
}

export const coverScript = (action, id, role = 'horizontal') => `(${coverDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(id)},${JSON.stringify(role)})`;

// Reserve the exact live control. This script never clicks it: confirmation
// uses browser mouse input, including sites that ignore untrusted DOM clicks.
export function coverControlScript(action, id, role, thumb, point, attempt = 0) {
  return `(async () => {
    const state = await ${coverScript(action, id, role)};
    if (state.error) return state;
    if (!state.topWindow) return { error: 'unsupported_cover_coordinate_frame' };
    if (!state.selector || state.obscured || !state.point) return { error: 'cover_control_changed' };
    if (['confirm', 'cancel'].includes(${JSON.stringify(action)}) && state.thumb !== ${JSON.stringify(thumb)}) return { error: 'cover_preview_changed' };
    const expected = ${JSON.stringify(point)};
    if (!expected || Math.abs(state.point.x - expected.x) > 1 || Math.abs(state.point.y - expected.y) > 1) return { error: 'cover_control_moved' };
    const roots = [document];
    for (let i=0; i<roots.length; i++) for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
    const buttons = roots.flatMap(r => [...r.querySelectorAll(state.selector)]);
    if (buttons.length !== 1) return { error: 'ambiguous_cover_control' };
    const key = ${JSON.stringify(`data-bycli-cover-once-${role}-${action}`)};
    if (document.documentElement.getAttribute(key) === ${JSON.stringify(attempt ? `${id}:processing-retry-${attempt}` : id)}) return { error: 'cover_action_already_attempted' };
    document.documentElement.setAttribute(key, ${JSON.stringify(attempt ? `${id}:processing-retry-${attempt}` : id)});
    return { reserved: true, point: state.point, method: 'native-pointer-once' };
  })()`;
}

// The user has completed the recorded role manually. Reconcile its exact
// retained editor without clicking, navigating, reuploading or replacing an ID.
export async function reconcileConfirmedCover(page, op, role, persist) {
  if (!op.cover || op.cover.phase !== 'confirm_unknown' || op.cover.role !== role || !coverSources(op.cover)[role]
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

// Read back a completed browser gesture after a lost response or late UI
// update. No input, upload, modal reopen or inferred manual approval here.
async function reconcileNativeCover(page, op, persist) {
  const a = op.cover.activation, role = op.cover.role;
  if (op.cover.phase !== 'confirm_unknown' || a?.method !== 'native-pointer-once' || a.action !== 'confirm'
    || a.role !== role || !['dispatched', 'dispatch_unknown'].includes(a.status)) return false;
  const state = await coverState(page, op, 'status', role);
  if (!confirmedCard(op, state, role)) return false;
  op.cover.completedRoles ??= {}; op.cover.completedRoles[role] = state.cards[role];
  op.cover.phase = 'pending'; a.status = 'verified'; a.reconciled_at = new Date().toISOString();
  delete op.cover.error; await persist(); return true;
}

export async function recoverCoverProcessing(page, op, persist, wait) {
  const a = op.cover?.activation, role = op.cover?.role;
  if (op.cover?.phase !== 'confirm_unknown' || a?.action !== 'confirm' || a.role !== role
    || a.method !== 'native-pointer-once' || a.status !== 'dispatched' || op.cover.save_attempted || op.cover.saved
    || (op.cover.processing_retries?.[role] || 0) >= 1 || typeof page.consoleMessages !== 'function') return false;
  const state = await coverState(page, op, 'status', role);
  if (!state.dialog || state.cropping || !op.cover.pending_thumb || state.thumb !== op.cover.pending_thumb
    || !['horizontal', 'vertical'].every(r => !!state.cards[r] && state.cards[r] === (op.cover.completedRoles?.[r] || op.cover.originalIdentities?.[r]))) return false;
  const after = Date.parse(a.at);
  // An exact, target-scoped native processing error is required. An open
  // modal or a missing response alone never authorizes another confirmation.
  const failures = (await page.consoleMessages('error')).filter(e => Number(e.timestamp) >= after
    && Number(e.timestamp) <= after + 15000 && /imgSizeInvalid width=0 height=0/.test(e.text || ''));
  if (!Number.isFinite(after) || failures.length !== 1) return false;
  for (const source of Object.values(coverSources(op.cover))) if ((await localCover(source.path)).sha256 !== source.sha256) return false;
  op.cover.processing_failures = [...(op.cover.processing_failures || []), { role, at: a.at, code: 'native_canvas_size_zero', activation: { ...a } }];
  await persist();
  let stage = await wait.stage(`cover-${role}-failed-processing-cancel`, 5);
  if (!await clickCoverControl(page, op, 'cancel', role, () => wait.assertRemaining(), persist)) return false;
  for (;;) {
    const current = await coverState(page, op, 'status', role);
    if (!['horizontal', 'vertical'].every(r => !!current.cards[r] && current.cards[r] === (op.cover.completedRoles?.[r] || op.cover.originalIdentities?.[r]))) throw new CommandExecutionError('A cover changed during failed-processing recovery; retain the editor');
    await stage.observe({ dialog: current.dialog, cropping: current.cropping });
    if (!current.dialog && !current.cropping) break;
    await page.wait(0.5);
  }
  op.cover.processing_retries ??= {}; op.cover.processing_retries[role] = 1;
  op.cover.phase = 'pending'; delete op.cover.error; await persist(); return true;
}
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

export async function configureCover(page, op, persist, timeout, wait = publishWait(timeout), resumeOpeningRole = null) {
  if (!op.cover) return;
  const sources = coverSources(op.cover);
  for (const source of Object.values(sources)) if ((await localCover(source.path)).sha256 !== source.sha256) throw new CommandExecutionError('Recorded cover file changed; refusing upload');
  if (op.cover.phase === 'configured') { await verifyCover(page, op); return; }
  await reconcileNativeCover(page, op, persist);
  if (op.cover.phase === 'confirm_unknown') await recoverCoverProcessing(page, op, persist, wait);
  if (resumeOpeningRole) {
    const state = await coverState(page, op, 'upload', resumeOpeningRole);
    const expected = { ...op.cover.originalIdentities, ...op.cover.completedRoles };
    if (op.cover.phase !== 'opening' || op.cover.role !== resumeOpeningRole || !sources[resumeOpeningRole]
      || op.cover.saved || op.cover.save_attempted || op.cover.pending_thumb || op.cover.completedRoles?.[resumeOpeningRole]
      || op.cover.activation?.role === resumeOpeningRole || !state.dialog || state.cropping || state.thumb
      || !state.render?.known || state.render.custom_source_selected
      || !['horizontal', 'vertical'].every(role => expected[role] && state.cards[role] === expected[role])) {
      throw new CommandExecutionError('Opening recovery cannot prove that the retained dialog is unchanged and no cover upload was attempted');
    }
    op.cover.recoveries = [...(op.cover.recoveries || []), { at: new Date().toISOString(), from_phase: 'opening', role: resumeOpeningRole, method: 'retained-dialog-before-upload' }];
    await persist();
  }
  // An interrupted upload/confirmation is retained for inspection, never retried.
  if (op.cover.phase && op.cover.phase !== 'pending' && !(resumeOpeningRole && op.cover.phase === 'opening')) throw new CommandExecutionError('Custom cover update was interrupted; inspect the retained editor before continuing, do not upload again automatically');
  const initial = await coverState(page, op);
  op.cover.originalIdentities ??= initial.cards;
  op.cover.completedRoles ??= {};
  for (const role of Object.keys(sources)) {
    if (op.cover.completedRoles[role]) {
      if ((await coverState(page, op)).cards[role] !== op.cover.completedRoles[role]) throw new CommandExecutionError('Partially configured cover changed; inspect it before recovery');
      continue;
    }
    try {
      try { await configureRole(page, op, persist, timeout, role, wait, role === resumeOpeningRole); }
      catch (error) {
        if (!await recoverCoverProcessing(page, op, persist, wait)) throw error;
        await configureRole(page, op, persist, timeout, role, wait);
      }
    }
    catch (error) {
      op.cover.error = { role, phase: op.cover.phase, code: error.code || 'COMMAND_EXEC', message: error.message };
      await persist(); throw error;
    }
  }
  const final = await coverState(page, op);
  if (!Object.keys(sources).every(k => final.cards[k] && final.cards[k] !== op.cover.originalIdentities[k])) throw new CommandExecutionError('Each requested card cover must use its uploaded image before saving');
  for (const role of ['horizontal', 'vertical']) if (!sources[role] && final.cards[role] !== op.cover.originalIdentities[role]) throw new CommandExecutionError('Unrequested default cover changed; inspect it before saving');
  op.cover.phase = 'configured'; op.cover.identities = Object.fromEntries(Object.keys(sources).map(k => [k, final.cards[k]])); await persist();
}

async function configureRole(page, op, persist, timeout, role, wait, retainedOpen = false) {
  const deadline = wait.deadline;
  let stage = await wait.stage(`cover-${role}-open-control`, 30);
  let state;
  if (!retainedOpen) {
    while (Date.now() < deadline) {
      await page.focusWindow?.(); await page.wait({ time: 1 });
      await coverState(page, op, 'position', role); await page.wait(0.15);
      await page.wait({ time: 1 });
      state = await coverState(page, op, 'open', role);
      await stage.observe({ control_available: !!state.selector, dialog: state.dialog, cropping: state.cropping });
      if (state.selector) break;
      await page.wait(0.5);
    }
    if (!state?.selector) throw new TimeoutError('Native cover edit control', timeout);
    stage = await wait.stage(`cover-${role}-open-response`, 5);
    op.cover.phase = 'opening'; op.cover.role = role; await persist(); await page.wait(0.15); await clickCoverControl(page, op, 'open', role); await page.wait({ time: 1 });
  }
  state = null;
  let initializing = false;
  let nextOpenAt = Date.now() + 3000;
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'upload', role);
    if (state.dialog && !state.selector && !state.cropping && !initializing) {
      initializing = true; stage = await wait.stage(`cover-${role}-editor-initialization`, 60);
    }
    await stage.observe({ dialog: state.dialog, cropping: state.cropping, input_available: !!state.selector, render: state.render });
    if (state.selector) break;
    // Hover overlays can consume the first pointer click. Reopen only while
    // there is observably no dialog; file upload/confirmation are never retried.
    if (!state.dialog && !state.cropping && Date.now() >= nextOpenAt) {
      nextOpenAt = Date.now() + 3000;
      await page.focusWindow?.(); await page.wait({ time: 1 });
      const open = await coverState(page, op, 'open', role);
      if (open.selector) { await page.wait(0.15); await clickCoverControl(page, op, 'open', role); await page.wait({ time: 1 }); }
    }
    await page.wait(0.25);
  }
  if (!state?.selector) throw new TimeoutError('Native cover file input', timeout);
  const before = state.cards[role];
  stage = await wait.stage(`cover-${role}-upload-preview`, 60);
  op.cover.phase = 'upload_unknown'; await persist();
  await page.uploadFiles(state.selector, [coverSources(op.cover)[role].path]);
  state = null;
  let cropClicked = false, cropStage;
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'confirm', role);
    if (state.cropping) {
      cropStage ??= await wait.stage(`cover-${role}-crop-control`, 30);
    } else if (cropStage) {
      cropStage = null;
      stage = await wait.stage(`cover-${role}-upload-preview`, 60);
    }
    await (cropStage || stage).observe({ cropping: state.cropping, thumbnail_ready: !!state.thumb, preview_ready: state.previewReady, confirm_available: !!state.selector, render: state.render },
      { cropping: state.cropping, thumb: state.thumb, preview_ready: state.previewReady });
    if (state.cropping && !cropClicked) {
      const crop = await coverState(page, op, 'crop', role);
      if (crop.selector) {
        cropClicked = await clickCoverControl(page, op, 'crop', role, () => wait.assertRemaining(), persist);
        if (cropClicked) cropStage = await wait.stage(`cover-${role}-crop-response`, 5);
      }
    }
    // Reinspect after native focus/hover: a crop dialog can appear while those
    // actions settle. Only mark confirmation uncertain when a click is issued.
    if (state.selector && state.thumb) {
      const clicked = await clickCoverControl(page, op, 'confirm', role, async current => {
        wait.assertRemaining();
        op.cover.pending_thumb = current.thumb;
        op.cover.phase = 'confirm_unknown'; await persist();
      }, persist);
      if (clicked && op.cover.completedRoles[role] && op.cover.activation?.status === 'verified') return;
      if (clicked) break;
    }
    await page.wait(0.25);
  }
  if (op.cover.phase !== 'confirm_unknown') throw new TimeoutError('Uploaded cover preview or crop confirmation', timeout);
  stage = await wait.stage(`cover-${role}-confirm-response`, 5);
  let dialogClosed = false;
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'status', role);
    if (!state.dialog && !state.cropping && state.cards[role] && state.cards[role] !== before) {
      op.cover.completedRoles[role] = state.cards[role]; op.cover.phase = 'pending';
      if (op.cover.activation?.action === 'confirm') op.cover.activation.status = 'verified';
      await persist(); return;
    }
    const observation = { role, dialog: state.dialog, cropping: state.cropping, preview_ready: state.previewReady,
      card_updated: !!state.cards[role] && state.cards[role] !== before };
    op.cover.last_observation = observation;
    if (state.cropping) throw new CommandExecutionError(`Custom ${role} cover is still in the crop dialog after the confirmation attempt; retain the editor and inspect it, do not upload or confirm again automatically`);
    if (!state.dialog && !dialogClosed) {
      dialogClosed = true; stage = await wait.stage(`cover-${role}-card-image`, 60);
    }
    await stage.observe(observation);
    await page.wait(0.5);
  }
  throw new TimeoutError('Custom cover card image', timeout, `role=${role}; dialog=${state?.dialog}; cropping=${state?.cropping}; preview_ready=${state?.previewReady}; retain the editor, do not upload or confirm again automatically`);
}

async function clickCoverControl(page, op, action, role, beforeClick = async () => {}, persist = async () => {}) {
  // Let focus and modal scrolling settle before dispatching native pointer input.
  await page.focusWindow?.(); await page.wait({ time: 1 });
  let state = await coverState(page, op, action, role);
  if (!state.selector) return false;
  if (action === 'confirm' || action === 'crop' || action === 'cancel') await coverState(page, op, `position-${action}`, role);
  await page.hover?.(state.selector); await page.wait(0.5);
  state = await coverState(page, op, action, role);
  if (!state.selector) return false;
  if (state.obscured) throw new CommandExecutionError(`Native cover ${action} control is obscured; retain the editor instead of clicking another control`);
  if (action === 'confirm' || action === 'crop' || action === 'cancel') {
    if (typeof page.evaluateOnce !== 'function' || typeof page.nativeClickOnce !== 'function') throw new CommandExecutionError('Single-execution browser mouse input is required for cover confirmation; update byCLI');
    if (!state.point) throw new CommandExecutionError('Cover control has no visible viewport hit point; retain the editor');
    // Two reads after focus/scroll/hover must agree before reserving a gesture.
    await page.wait(0.15);
    const settled = await coverState(page, op, action, role);
    if (!settled.selector || settled.obscured || !settled.point || settled.thumb !== state.thumb
      || Math.abs(settled.point.x - state.point.x) > 1 || Math.abs(settled.point.y - state.point.y) > 1) return false;
    state = settled;
    const activation = { role, action, method: 'native-pointer-once', status: 'preparing', at: new Date().toISOString() };
    op.cover.activation = activation; await persist();
    let receipt;
    try { receipt = await page.evaluateOnce(coverControlScript(action, op.operation_id, role, state.thumb, state.point, op.cover.processing_retries?.[role] || 0)); }
    catch (error) { activation.status = 'reservation_unknown'; await persist(); throw error; }
    if (receipt?.reserved !== true) {
      activation.status = 'not_dispatched'; activation.reason = receipt?.error || 'invalid_reservation'; await persist();
      // No gesture was reserved or sent. Let the existing bounded preview
      // loop remeasure a moving control, never replay an attempted input.
      if (['cover_control_changed', 'cover_control_moved', 'cover_preview_changed'].includes(activation.reason)) return false;
      throw new CommandExecutionError(`Cover mouse input was not dispatched: ${activation.reason}; retain the editor`);
    }
    activation.status = 'reserved'; await persist(); await beforeClick(state);
    activation.status = 'dispatching'; await persist();
    try { await page.nativeClickOnce(receipt.point.x, receipt.point.y); }
    catch (error) {
      activation.status = 'dispatch_unknown'; await persist();
      // A transport error is not a failed platform action. Accept only an
      // already completed exact card transition, never resend the gesture.
      if (action !== 'confirm' || !await reconcileNativeCover(page, op, persist).catch(() => false)) throw error;
    }
    if (activation.status !== 'verified') activation.status = 'dispatched';
    await persist();
  } else {
    await beforeClick(state);
    if (state.point && page.nativeClick) await page.nativeClick(state.point.x, state.point.y);
    else await page.click(state.selector);
  }
  await page.wait({ time: 1 });
  return true;
}
