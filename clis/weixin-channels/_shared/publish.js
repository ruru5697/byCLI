import { requirePublishConfirmation } from '../../_shared/publish-confirmation.js';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError, EmptyResultError } from '@sovovs/bycli/errors';
import { open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { publishScript, previewFingerprintDOM } from './publish-dom.js';
import { fetchPosts, fetchPostDetail } from './client.js';
import { normalizePost, normalizeDetail, resolveDateRange } from './model.js';
import { fetchManagementPost } from './management.js';
import { savedDraftId, openSavedDraft, draftReceipt } from './draft.js';
import { localCover, requestedCovers, coverSources, configureCover, verifyCover, coverScript, reconcileConfirmedCover } from './cover.js';
import { publishWait, videoObservation } from './wait.js';

// The WeChat channels rich-text editor (ProseMirror-like) always appends a
// trailing newline to innerText, so description comparisons must ignore
// trailing whitespace on both sides.
const descriptionFingerprint = value => String(value ?? '').replace(/[\s\u00a0\u200b\ufeff]+$/u, '');
const sameDescription = (value, expected) => typeof value === 'string' && typeof expected === 'string'
  && descriptionFingerprint(value) === descriptionFingerprint(expected);

const CREATE_URL = 'https://channels.weixin.qq.com/platform/post/create';
export const PUBLISH_COLUMNS = ['operation_id', 'status', 'submitted', 'id', 'management_id', 'metrics_source', 'editor_url', 'public_url', 'description', 'ai_generated', 'message', 'metrics', 'analytics', 'editor'];

export function validatePublishArgs(args) {
  requirePublishConfirmation(args);
  if (!args.execute) throw new ArgumentError('Use --execute to prepare or submit a video');
  if (!args.operation || typeof args.operation !== 'string') throw new ArgumentError('--operation must be a local journal path');
  if (!['prepare', 'adopt-draft', 'retry-upload', 'recover', 'resume', 'submit'].includes(args.mode ?? 'prepare')) throw new ArgumentError('--mode must be prepare, adopt-draft, retry-upload, recover, resume or submit');
  for (const flag of ['cover', 'vertical-cover']) if (args[flag] !== undefined && ((args.mode ?? 'prepare') !== 'prepare' || typeof args[flag] !== 'string' || !args[flag])) throw new ArgumentError(`--${flag} is only accepted when preparing a new operation; use the recorded cover during recovery`);
  if (args['cover-confirmed'] !== undefined && (args.mode !== 'resume' || !['horizontal', 'vertical'].includes(args['cover-confirmed']))) throw new ArgumentError('--cover-confirmed requires resume and the exact manually confirmed role');
  if (args['retry-cover-processing'] !== undefined && (args.mode !== 'resume' || !['horizontal', 'vertical'].includes(args['retry-cover-processing']) || args['cover-confirmed'])) throw new ArgumentError('--retry-cover-processing requires resume, the exact failed role and no manual-confirmation flag');
  if (args['resume-cover-opening'] !== undefined && (args.mode !== 'resume' || !['horizontal', 'vertical'].includes(args['resume-cover-opening']) || args['cover-confirmed'] || args['retry-cover-processing'])) throw new ArgumentError('--resume-cover-opening requires resume, the exact unopened-upload role and no other cover recovery flag');
  if (args['reopen-saved-draft'] !== undefined && (args['reopen-saved-draft'] !== true || args.mode !== 'resume' || !args['resume-cover-opening'])) throw new ArgumentError('--reopen-saved-draft requires resume with an exact --resume-cover-opening role');
  if (args.mode === 'recover' && !/^[a-f0-9]{32}$/i.test(args['editor-page'] || '')) throw new ArgumentError('Explicit recovery requires the inspected editor page ID');
  if (args.mode === 'recover' && !/^[\w-]{1,100}$/.test(args['editor-session'] || '')) throw new ArgumentError('Recovery requires an explicitly bound browser session');
  if (!['adopt-draft', 'recover', 'retry-upload'].includes(args.mode) && (args['editor-page'] !== undefined || args['editor-session'] !== undefined)) throw new ArgumentError('Editor binding is only valid with adopt-draft, recover or retry-upload');
  if (args.mode === 'adopt-draft' && (!/^export\/[\w-]+$/.test(args['draft-id'] || '') || !/^[a-f0-9]{32}$/i.test(args['editor-page'] || '')
    || !/^[\w-]{1,100}$/.test(args['editor-session'] || '') || !args.description?.trim() || !['yes', 'no'].includes(args['ai-generated']))) throw new ArgumentError('Draft adoption requires its exact draft ID, inspected bound editor, description and AI choice');
  if (args.mode === 'retry-upload' && (args['editor-page'] !== undefined || args['editor-session'] !== undefined)
    && (!/^[a-f0-9]{32}$/i.test(args['editor-page'] || '') || !/^[\w-]{1,100}$/.test(args['editor-session'] || ''))) throw new ArgumentError('Upload retry binding requires both inspected page ID and bound browser session');
  const timeout = args.timeout ?? 180;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800) throw new ArgumentError('--timeout must be 1–1800 seconds');
  if ((args.mode ?? 'prepare') === 'prepare') {
    if (typeof args.file !== 'string' || !args.file) throw new ArgumentError('A local video file is required');
    if (typeof args.description !== 'string' || !args.description.trim()) throw new ArgumentError('--description is required');
    if (!['yes', 'no'].includes(args['ai-generated'])) throw new ArgumentError('--ai-generated must explicitly be yes or no');
  }
  if (args.mode === 'retry-upload' && (typeof args.file !== 'string' || !args.file)) throw new ArgumentError('Explicit retry-upload requires the original local video file');
}

export async function readOperation(file) {
  let op;
  try { op = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new ArgumentError('Invalid operation journal'); }
  if (op.version !== 1 || typeof op.operation_id !== 'string' || typeof op.description !== 'string'
    || !['yes', 'no'].includes(op.ai_generated) || typeof op.submitted !== 'boolean'
    || !Number.isFinite(Date.parse(op.created_at)) || typeof op.status !== 'string'
    || op.cover != null && (!Object.keys(coverSources(op.cover)).length || Object.entries(coverSources(op.cover)).some(([role, source]) => !['horizontal', 'vertical'].includes(role) || typeof source?.path !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256 || '')))) throw new ArgumentError('Invalid operation journal schema');
  return op;
}
async function save(file, op) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(op, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => {}); }
}
function result(op, editor = null) {
  return [{ operation_id: op.operation_id, status: op.status, submitted: op.submitted, id: op.id ?? null,
    management_id: op.management_id ?? null, metrics_source: op.metrics_source ?? null,
    editor_url: op.editor_url ?? CREATE_URL, public_url: null, description: op.description, ai_generated: op.ai_generated,
    message: op.message ?? '', metrics: op.metrics ?? null, analytics: op.analytics ?? null,
    editor: editor ?? (op.source_draft_id || op.wait ? { draft_id: op.source_draft_id ?? null, verified_at: op.draft_verified_at ?? null,
      ...(op.cover ? { custom_cover: { phase: op.cover.phase, saved: op.cover.saved === true, activation: op.cover.activation ?? null,
        sources: Object.fromEntries(Object.entries(coverSources(op.cover)).map(([role, source]) => [role, { sha256: source.sha256 }])) } } : {}),
      ...(op.wait ? { wait: op.wait } : {}), ...(op.wait_error ? { wait_error: op.wait_error } : {}) } : null) }];
}
async function inspect(page, action, op) {
  const s = await page.evaluate(publishScript(action, op.operation_id, op.ai_generated));
  if (s?.error === 'login_required') throw new AuthRequiredError('channels.weixin.qq.com');
  if (!s || s.error) throw new CommandExecutionError(`Video editor unavailable: ${s?.error || 'invalid state'}`);
  return s;
}
async function locked(file, fn, onError) {
  let lock;
  try { lock = await open(`${file}.lock`, 'wx', 0o600); }
  catch (e) { throw new CommandExecutionError(e.code === 'EEXIST' ? 'Operation is already running; do not repeat submission' : 'Cannot create operation lock'); }
  try { return await fn(); }
  catch (error) { await onError?.(error); throw error; }
  finally { await lock.close(); await unlink(`${file}.lock`); }
}

async function verifySavedDraft(page, file, op, timeout, wait, inspectOnly = false, reopenOpening = false) {
  if (reopenOpening) {
    if (inspectOnly || op.submitted || !op.source_draft_id || op.cover?.phase !== 'opening' || !coverSources(op.cover)[op.cover.role]
      || op.cover.saved || op.cover.save_attempted || op.cover.pending_thumb || op.cover.activation
      || Object.keys(op.cover.completedRoles ?? {}).length) throw new CommandExecutionError('Saved draft reopening is only safe before any cover upload, confirmation or save');
    for (const source of Object.values(coverSources(op.cover))) if ((await localCover(source.path)).sha256 !== source.sha256) throw new CommandExecutionError('Recorded cover file changed; refusing draft reopening');
  }
  if (!reopenOpening && op.cover && op.cover.phase !== 'configured' && (op.cover.phase !== 'pending' || Object.keys(op.cover.completedRoles ?? {}).length)) {
    throw new CommandExecutionError('Custom cover update was interrupted; inspect the retained editor before reopening or uploading again');
  }
  op.status = 'draft_saved'; delete op.draft_verified_at;
  await save(file, op);
  await openSavedDraft(page, op, timeout, wait);
  let stageName = 'reopen-editor-load', stage = await wait.stage(stageName, 30), maxPercent = -1;
  const deadline = wait.deadline;
  while (Date.now() < deadline) {
    const s = await page.evaluate(publishScript('bind', op.operation_id, op.ai_generated));
    if (s?.error === 'editor_loading' || s?.error === 'wrong_editor_path') { await stage.observe({ state: s.error }); await page.wait(0.5); continue; }
    if (!s || s.error || s.blocked) throw new CommandExecutionError('Saved draft editor requires inspection');
    if (s.draft_id !== op.source_draft_id || !sameDescription(s.description, op.description)) {
      throw new CommandExecutionError('Reopened saved draft identity or content changed');
    }
    const name = !s.ready ? 'reopen-video-processing' : !s.ai_selected && !inspectOnly ? 'reopen-ai-label' : 'reopen-draft-verification';
    if (name !== stageName) { stageName = name; stage = await wait.stage(name, name === 'reopen-ai-label' ? 5 : 60); }
    maxPercent = Math.max(maxPercent, s.progress_percent ?? -1);
    await stage.observe(videoObservation(s), { ...videoObservation(s), progress_percent: maxPercent });
    if (s.ready) {
      if (!s.ai_selected && !inspectOnly) {
        const control = await inspect(page, 'ai', op);
        if (control.selector) { wait.assertRemaining(); await page.click(control.selector); }
        await page.wait(0.25); continue;
      }
      if (reopenOpening) {
        const cover = await page.evaluate(coverScript('status', op.operation_id));
        if (cover?.error || cover.dialog || cover.cropping || !['horizontal', 'vertical'].every(role =>
          op.cover.originalIdentities?.[role] && cover.cards?.[role] === op.cover.originalIdentities[role])) {
          throw new CommandExecutionError('Reopened draft covers changed; refusing upload');
        }
        op.cover.recoveries = [...(op.cover.recoveries || []), { at: new Date().toISOString(), from_phase: 'opening',
          method: 'exact-saved-draft-before-upload', previous_target: op.target, target: page.getActivePage?.(), previous_error: op.cover.error ?? null }];
        op.target = page.getActivePage?.(); op.cover.phase = 'pending';
        await save(file, op); reopenOpening = false;
      }
      if (op.cover && op.cover.phase !== 'configured') {
        if (inspectOnly) throw new CommandExecutionError('Read-only draft verification cannot configure a cover');
        await configureCover(page, op, () => save(file, op), timeout, wait);
        return saveCustomCoverDraft(page, file, op, timeout, wait);
      }
      if (await verifyCover(page, op, true) === false) { await page.wait(0.5); continue; }
      if (op.cover && !op.cover.saved) {
        if (!op.cover.save_attempted) {
          if (inspectOnly) throw new CommandExecutionError('Read-only draft verification cannot save a cover');
          return saveCustomCoverDraft(page, file, op, timeout, wait);
        }
        // A fresh exact draft read after an ambiguous save is sufficient to
        // reconcile its persisted covers; never repeat that save automatically.
        op.cover.saved = true;
      }
      op.target = page.getActivePage?.(); op.editor_url = s.url;
      op.status = s.can_submit ? 'prepared' : 'draft_saved';
      op.draft_verified_at = new Date().toISOString();
      op.message = s.can_submit ? 'Platform draft saved, found by exact ID and reopened; await user confirmation before separate submit'
        : !s.ai_selected ? 'Platform draft and covers saved and reopened; AI label must be restored before user-confirmed submission'
          : 'Platform draft saved and reopened; wait for cover or other editor requirements before user-confirmed submission';
      delete op.wait_error;
      await wait.finish(); await save(file, op); return result(op);
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Reopened platform draft verification', timeout);
}

async function draftSaveControl(page, op, wait, existing = false) {
  const stage = await wait.stage(existing ? 'cover-draft-save-control' : 'draft-save-control', 60);
  let maxPercent = -1;
  for (;;) {
    wait.assertRemaining();
    const state = await inspect(page, 'save-draft', op);
    if (state.operation_id !== op.operation_id || !sameDescription(state.description, op.description) || !state.ai_selected
      || existing && state.draft_id !== op.source_draft_id) throw new CommandExecutionError('Prepared draft identity, description or AI label changed; retain the editor without saving');
    if (state.blocked) throw new CommandExecutionError('Draft save requires user action; retain the editor without saving');
    maxPercent = Math.max(maxPercent, state.progress_percent ?? -1);
    const observation = { ...videoObservation(state), save_available: !!state.selector };
    await stage.observe(observation, { ...observation, progress_percent: maxPercent });
    // A playable local preview does not imply the native save control is
    // enabled: the platform may still be generating its default covers.
    if (state.selector) return state;
    await page.wait(0.5);
  }
}

async function saveCustomCoverDraft(page, file, op, timeout, wait) {
  if (op.cover.save_attempted) throw new CommandExecutionError('Custom cover save already attempted; resume to inspect the exact saved draft without saving again');
  await verifyCover(page, op);
  const state = await draftSaveControl(page, op, wait, true);
  if (!await page.startNetworkCapture('/post_draft')) throw new CommandExecutionError('Native cover draft receipt capture is required');
  await page.readNetworkCapture(); const started = Date.now();
  await wait.stage('cover-draft-save-action', 5);
  op.cover.save_attempted = true; op.cover.save_started_at = new Date(started).toISOString(); op.status = 'draft_save_unknown'; await save(file, op);
  await page.focusWindow?.(); wait.assertRemaining(); await page.click(state.selector);
  if (await savedDraftId(page, started, timeout, wait) !== op.source_draft_id) throw new CommandExecutionError('Cover update returned a different draft ID; inspect it, never create or save again');
  op.cover.saved = true; op.status = 'draft_saved'; await save(file, op);
  return verifySavedDraft(page, file, op, timeout, wait);
}

async function persistDraft(page, file, op, timeout, wait) {
  if (op.draft_save_attempted) throw new CommandExecutionError('Draft save was already attempted; inspect the draft box, do not repeat saving automatically');
  const state = await draftSaveControl(page, op, wait);
  if (!await page.startNetworkCapture('/post_draft')) throw new CommandExecutionError('Native draft receipt capture is required');
  await page.readNetworkCapture();
  const started = Date.now();
  await wait.stage('draft-save-action', 5);
  op.draft_save_attempted = true; op.draft_save_started_at = new Date(started).toISOString(); op.status = 'draft_save_unknown';
  op.message = 'Native draft save attempted; inspect exact receipt before continuing, never save again automatically';
  await save(file, op); await page.focusWindow?.(); wait.assertRemaining(); await page.click(state.selector);
  op.source_draft_id = await savedDraftId(page, started, timeout, wait);
  op.status = 'draft_saved'; await save(file, op);
  return verifySavedDraft(page, file, op, timeout, wait);
}

export async function publishVideo(page, args) {
  validatePublishArgs(args);
  const file = resolve(args.operation);
  let op;
  const wait = publishWait(args.timeout ?? 180, { heartbeat: true, onUpdate: async snapshot => {
    if (op) { op.wait = snapshot; await save(file, op); }
  } });
  return locked(file, async () => {
    op = await readOperation(file);
    const mode = args.mode ?? 'prepare';
    if (args['retry-cover-processing'] && (!op || op.submitted || !op.source_draft_id || op.cover?.phase !== 'confirm_unknown'
      || op.cover.role !== args['retry-cover-processing'])) throw new CommandExecutionError('Processing recovery requires the original unsubmitted draft and exact failed cover role');
    if (args['resume-cover-opening']) {
      if (!op || op.submitted || !op.source_draft_id || !op.target || op.cover?.phase !== 'opening'
        || op.cover.role !== args['resume-cover-opening'] || op.cover.saved || op.cover.save_attempted) throw new CommandExecutionError('Opening recovery requires the original unsubmitted draft before any cover upload or save');
      if (args['reopen-saved-draft']) return await verifySavedDraft(page, file, op, args.timeout ?? 180, wait, false, true);
      page.setActivePage(op.target);
      const state = await inspect(page, 'status', op);
      if (state.operation_id !== op.operation_id || state.draft_id !== op.source_draft_id || !sameDescription(state.description, op.description)
        || !state.ready || state.blocked || !state.ai_selected) throw new CommandExecutionError('Retained draft identity or content changed; refusing opening recovery');
      await configureCover(page, op, () => save(file, op), args.timeout ?? 180, wait, args['resume-cover-opening']);
      return await saveCustomCoverDraft(page, file, op, args.timeout ?? 180, wait);
    }
    if (args['cover-confirmed']) {
      if (!op || op.submitted || !op.source_draft_id || !op.target) throw new CommandExecutionError('Manual cover recovery requires the original unsubmitted saved draft');
      page.setActivePage(op.target);
      const s = await inspect(page, 'status', op);
      if (s.operation_id !== op.operation_id || s.draft_id !== op.source_draft_id || !sameDescription(s.description, op.description)
        || !s.ready || !s.ai_selected || s.blocked) throw new CommandExecutionError('Retained draft identity or content changed; refusing cover recovery');
      await wait.stage('manual-cover-reconciliation', 5);
      await reconcileConfirmedCover(page, op, args['cover-confirmed'], () => save(file, op));
      await configureCover(page, op, () => save(file, op), args.timeout ?? 180, wait);
      return await saveCustomCoverDraft(page, file, op, args.timeout ?? 180, wait);
    }
    if (op && mode === 'prepare') for (const [role, flag] of [['horizontal', 'cover'], ['vertical', 'vertical-cover']]) {
      if (args[flag] !== undefined && (await localCover(args[flag], flag)).sha256 !== coverSources(op.cover)[role]?.sha256) throw new ArgumentError('Existing operation retained; a different cover cannot replace its prepared content');
    }
    if (mode === 'adopt-draft') {
      if (op) return result({ ...op, message: 'Existing operation retained; no draft was adopted or submitted again' });
      const pending = { version: 1, operation_id: randomUUID(), created_at: new Date().toISOString(),
        description: args.description, ai_generated: args['ai-generated'], submitted: false, status: 'prepared',
        source: 'platform_draft', source_draft_id: args['draft-id'], target: args['editor-page'], editor_session: args['editor-session'] };
      page.setActivePage(pending.target);
      let state = await inspect(page, 'status', pending);
      if (state.draft_id !== pending.source_draft_id || !sameDescription(state.description, pending.description) || state.blocked || !state.ready || state.cover_pending) throw new CommandExecutionError('Exact saved draft, description, preview or cover is not ready; refusing adoption');
      // The platform can drop this declaration when reopening a saved draft.
      // Restore only the explicitly supplied choice through its scoped control.
      for (let n = 0; n < 12 && !state.ai_selected && Date.now() < wait.deadline; n++) {
        const control = await inspect(page, 'ai', pending);
        if (control.blocked || control.draft_id !== pending.source_draft_id || !sameDescription(control.description, pending.description)) throw new CommandExecutionError('Saved draft changed while restoring its declaration');
        if (control.selector) await page.click(control.selector);
        await page.wait(0.25); state = await inspect(page, 'status', pending);
      }
      if (!state.can_submit) throw new CommandExecutionError('Saved draft AI label or publish control is not ready; refusing adoption');
      await inspect(page, 'bind', pending);
      pending.editor_url = state.url;
      pending.draft_verified_at = new Date().toISOString();
      pending.message = 'Exact existing platform draft verified and retained; no upload, content change or submission';
      await save(file, pending); return result(pending);
    }
    if (mode === 'prepare' || mode === 'retry-upload' || mode === 'recover' || mode === 'resume') {
      if (op?.draft_save_attempted || op?.source_draft_id) {
        if (mode !== 'resume' || op.submitted) return result({ ...op, message: 'Existing platform draft retained; use resume to recheck it, never upload or save again' });
        if (!op.source_draft_id) throw new CommandExecutionError('Draft save receipt unknown; inspect draft box and adopt its exact ID explicitly; do not save again');
        if (op.cover?.phase === 'confirm_unknown' && op.cover.activation?.method === 'native-pointer-once') {
          if (!op.target || op.cover.save_attempted || op.cover.saved) throw new CommandExecutionError('Retained cover reconciliation is unavailable; do not repeat input or saving');
          page.setActivePage(op.target);
          const state = await inspect(page, 'status', op);
          if (state.operation_id !== op.operation_id || state.draft_id !== op.source_draft_id || !sameDescription(state.description, op.description)
            || !state.ready || state.blocked || !state.ai_selected) throw new CommandExecutionError('Retained draft identity or content changed; refusing automatic cover reconciliation');
          // configureCover first reads back the previous gesture. It refuses
          // an open/unchanged dialog, never replaying an uncertain click.
          await configureCover(page, op, () => save(file, op), args.timeout ?? 180, wait);
          return await saveCustomCoverDraft(page, file, op, args.timeout ?? 180, wait);
        }
        if (op.cover?.phase === 'configured' && !op.cover.saved && !op.cover.save_attempted) {
          // Cover configuration completed before a crash; verify the retained
          // editor and save once before any navigation can discard its edits.
          if (!op.target) throw new CommandExecutionError('Retained cover editor identity unavailable');
          page.setActivePage(op.target);
          const state = await inspect(page, 'status', op);
          if (state.operation_id !== op.operation_id || !state.ready || state.blocked || !state.ai_selected) throw new CommandExecutionError('Retained cover editor changed; inspect it before saving');
          return await saveCustomCoverDraft(page, file, op, args.timeout ?? 180, wait);
        }
        return await verifySavedDraft(page, file, op, args.timeout ?? 180, wait);
      }
      let state;
      if (mode === 'recover') {
        if (!op || op.submitted || !['preparing', 'preparation_unknown'].includes(op.status)) throw new CommandExecutionError('Only an unsubmitted interrupted preparation can be recovered');
        page.setActivePage(args['editor-page']);
        state = await inspect(page, 'status', op);
        if (state.blocked || !state.ready || state.description && !sameDescription(state.description, op.description)) throw new CommandExecutionError('Recovered editor is unavailable or contains different content');
        const fingerprint = await page.evaluate(`(${previewFingerprintDOM.toString()})()`);
        if (fingerprint?.sha256 !== op.sha256) throw new CommandExecutionError(`Recovered video identity was not verified: ${fingerprint?.error || 'hash_mismatch'}`);
        await inspect(page, 'bind', op);
        op.recoveries = [...(op.recoveries || []), { at: new Date().toISOString(), previous_target: op.target, target: args['editor-page'], sha256: fingerprint.sha256 }];
        op.target = args['editor-page']; op.editor_session = args['editor-session']; await save(file, op);
      } else if (mode !== 'resume') {
        // A retained journal is never permission to upload again.
        const authResume = op && mode === 'prepare' && op.authentication_required === true && op.upload_attempted === false
          && !op.file_selected && !op.submitted && !op.draft_save_attempted && !op.source_draft_id
          && ['preparing', 'preparation_unknown'].includes(op.status);
        if (op && mode === 'prepare' && !authResume) {
          return result({ ...op, message: 'Existing operation retained; inspect its status instead of uploading again' });
        }
        if (authResume && (args.description !== op.description || args['ai-generated'] !== op.ai_generated)) throw new ArgumentError('Authentication recovery must retain the original description and AI declaration');
        if (mode === 'retry-upload') {
          if (!op || op.submitted || !['preparing', 'preparation_unknown'].includes(op.status) || !op.target) throw new CommandExecutionError('Explicit upload retry requires an unsubmitted interrupted operation');
          page.setActivePage(args['editor-page'] || op.target);
          state = await inspect(page, 'status', op);
          if (state.blocked || state.ready || state.input_files.length || state.videos.length || state.description?.trim()) throw new CommandExecutionError('Original editor must be empty after reopening; refusing to overwrite an uploaded preview or other content');
        }
        const media = resolve(args.file);
        let info;
        try { info = await stat(media); } catch { throw new ArgumentError('Video file not found'); }
        if (!info.isFile() || info.size === 0) throw new ArgumentError('Video must be a nonempty local file');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(media)) hash.update(chunk);
        const sha256 = hash.digest('hex');
        if (authResume && op.sha256 !== sha256) throw new ArgumentError('Original video hash changed; refusing authentication recovery');
        if (mode === 'retry-upload') {
          if (op.sha256 !== sha256) throw new CommandExecutionError('Original video hash changed; refusing upload retry');
          op.upload_retries = [...(op.upload_retries || []), { at: new Date().toISOString(), previous_status: op.status }];
          if (args['editor-page']) {
            op.rebindings = [...(op.rebindings || []), { at: new Date().toISOString(), previous_target: op.target, target: args['editor-page'] }];
            op.target = args['editor-page']; op.editor_session = args['editor-session'];
          }
          op.status = 'preparing'; op.file_selected = false; op.description_filled = false;
        } else if (!authResume) op = { version: 1, operation_id: randomUUID(), created_at: new Date().toISOString(),
          description: args.description, ai_generated: args['ai-generated'], sha256,
          ...((args.cover || args['vertical-cover']) ? { cover: await requestedCovers(args) } : {}),
          status: 'preparing', submitted: false, upload_attempted: false };
        await save(file, op);
        const load = await wait.stage('video-editor-load', 30);
        let navigateToEditor = mode === 'prepare';
        if (authResume) {
          if (!op.target) throw new CommandExecutionError('Authentication recovery requires the retained page identity');
          page.setActivePage(op.target);
          const before = await page.evaluate(publishScript('status', op.operation_id, op.ai_generated));
          const safeLanding = before?.error === 'login_required' || before?.error === 'wrong_editor_path' && ['/', '/platform', '/platform/'].includes(before.path);
          if (!before || before.blocked || before.error && !safeLanding && before.error !== 'editor_loading') throw new CommandExecutionError('Authentication recovery requires the original login or editor page');
          if (!before.error && (before.draft_id || before.input_files.length || before.videos.length || before.description?.trim())) throw new CommandExecutionError('Authentication recovery requires an empty editor; retain existing content without uploading');
          // Never refresh an existing editor to manufacture an empty page.
          navigateToEditor = safeLanding;
        }
        if (navigateToEditor) await page.goto(CREATE_URL, { stealth: false });
        op.target = page.getActivePage?.();
        if (!op.target) throw new CommandExecutionError('Browser page identity is required');
        if (!op.editor_session) await page.focusWindow?.();
        await save(file, op);
        do {
          state = await page.evaluate(publishScript('bind', op.operation_id, op.ai_generated));
          await load.observe({ state: state?.error || 'loaded' });
          if (state?.error !== 'editor_loading') break;
          await page.wait(0.5);
        } while (Date.now() < wait.deadline);
        if (state?.error === 'login_required') {
          // Persist proof that authentication stopped preparation before file
          // selection. A confirmed rerun may perform the first upload only.
          if (op.upload_attempted === false) { op.authentication_required = true; await save(file, op); }
          throw new AuthRequiredError('channels.weixin.qq.com');
        }
        if (!state || state.error) throw new CommandExecutionError('Video editor did not become available');
        if (authResume && (state.draft_id || state.input_files.length || state.videos.length || state.description?.trim())) throw new CommandExecutionError('Authentication recovery requires an empty editor; retain existing content without uploading');
        op.editor_url = state.url;
        if (state.blocked) { op.status = 'requires_user_action'; op.message = 'Inspect login, verification or account permissions'; await save(file, op); return result(op); }
        const input = await inspect(page, 'input', op);
        if (!input.selector) throw new CommandExecutionError('Unique video upload control not found');
        await wait.stage('video-file-selection', 60);
        // Write intent before the RPC: a missing reply cannot be mistaken for
        // a login-only failure or permission to repeat the upload.
        wait.assertRemaining(); op.upload_attempted = true; op.status = 'preparing'; delete op.authentication_required; await save(file, op);
        await page.uploadFiles(input.selector, [media]);
        op.file_selected = true;
        await save(file, op);
      } else {
        // Explicit recovery only: preserve the uploaded video and the original tab.
        if (!op || op.submitted || !['preparing', 'preparation_unknown'].includes(op.status)) {
          throw new CommandExecutionError('Only an unsubmitted interrupted preparation can be resumed');
        }
        if (!op.target || typeof page.setActivePage !== 'function') throw new CommandExecutionError('Retained page identity unavailable');
        page.setActivePage(op.target);
        if (!op.editor_session) await page.focusWindow?.();
        state = await inspect(page, 'status', op);
        if (state.operation_id !== op.operation_id || !state.ready || (state.description && !sameDescription(state.description, op.description))) {
          throw new CommandExecutionError('Original uploaded preview is unavailable or the retained page changed; refusing recovery');
        }
      }
      const deadline = wait.deadline;
      let stage = await wait.stage('video-processing', 60), fieldsStage = false, maxPercent = -1;
      let filled = false;
      while (Date.now() < deadline) {
        state = await inspect(page, filled ? 'ai' : 'editor', op);
        if (state.blocked) break;
        if (state.ready && !fieldsStage) { fieldsStage = true; stage = await wait.stage('video-fields', 5); }
        maxPercent = Math.max(maxPercent, state.progress_percent ?? -1);
        const observation = { ...videoObservation(state), description_matches: sameDescription(state.description, op.description) };
        await stage.observe(observation, { ...observation, progress_percent: maxPercent });
        if (!filled && state.selector) {
          wait.assertRemaining(); const written = await page.fillText(state.selector, op.description);
          if (!written?.verified && !sameDescription(written?.actual, op.description)) throw new CommandExecutionError('Description input was not verified; inspect the retained page');
          filled = true;
          op.description_filled = true;
          await save(file, op);
        }
        else if (filled && !state.ai_selected && state.selector) { wait.assertRemaining(); await page.click(state.selector); }
        if (filled && state.ready && sameDescription(state.description, op.description) && state.ai_selected) {
          return await persistDraft(page, file, op, args.timeout ?? 180, wait);
        }
        await page.wait(0.5);
      }
      op.status = state.blocked ? 'requires_user_action' : 'preparation_unknown';
      op.message = 'Inspect retained tab; preparation has not been confirmed. Do not upload again automatically';
      await save(file, op);
      if (!state.blocked) throw new TimeoutError('Video preparation', args.timeout ?? 180, op.message);
      return result(op);
    }
    if (!op) throw new ArgumentError('Prepare an operation before submitting');
    if (op.submitted || op.status === 'published') return result({ ...op, message: 'Submission already attempted; reconcile status, never click publish again' });
    if (op.status !== 'prepared' || !op.source_draft_id) throw new CommandExecutionError('A saved and verified platform draft is required; preview-only legacy operations cannot be submitted');
    if (!op.target || typeof page.setActivePage !== 'function') throw new CommandExecutionError('Retained page identity unavailable');
    page.setActivePage(op.target);
    const state = await inspect(page, 'submit', op);
    if (state.operation_id !== op.operation_id || !sameDescription(state.description, op.description) || !state.ready || !state.ai_selected
      || op.source_draft_id && state.draft_id !== op.source_draft_id) {
      throw new CommandExecutionError('Prepared page changed or was reloaded; refusing submission');
    }
    if (state.blocked || !state.selector) throw new CommandExecutionError('Publish requires user action or an unambiguous enabled button');
    if (op.cover && !op.cover.saved) throw new CommandExecutionError('Custom cover has not been saved and reopened; refusing publication');
    await verifyCover(page, op);
    // Persist before the irreversible click. Crashes and ambiguous receipts cannot trigger a retry.
    op.status = 'submit_unknown'; op.submitted = true;
    op.user_confirmed_at = new Date().toISOString();
    op.submitted_at = new Date().toISOString();
    op.message = 'Submission may have happened; reconcile before any further action';
    await save(file, op);
    wait.assertRemaining(); await page.click(state.selector);
    for (let attempt = 0; attempt < 20 && Date.now() < wait.deadline; attempt++) {
      try {
        const after = await inspect(page, 'status', op);
        if (after.blocked || after.success) {
          op.status = after.blocked ? 'requires_user_action' : 'submitted';
          op.message = after.blocked ? 'Complete verification/terms manually; do not repeat submission' : 'UI confirms submission; publication and objectId still need reconciliation';
          await save(file, op); return result(op);
        }
      } catch { break; } // Navigation may remove the editor; keep durable unknown state.
      await page.wait(0.5);
    }
    return result(op);
  }, async error => {
    if (op && wait.snapshot) {
      op.wait = { ...wait.snapshot, status: 'stopped' };
      op.wait_error = { stage: wait.snapshot.stage, code: error.code || 'COMMAND_EXEC', message: error.message, hint: error.hint };
      if (op.status === 'preparing') op.status = 'preparation_unknown';
      op.message = `${error.message}; original operation and editor retained, do not repeat writes`;
      await save(file, op);
    }
  }).finally(() => wait.close());
}

export async function videoStatus(page, args) {
  if (!args.operation || typeof args.operation !== 'string') throw new ArgumentError('--operation is required');
  if (args.id !== undefined && (typeof args.id !== 'string' || !/^\d+$/.test(args.id))) throw new ArgumentError('--id must be a complete objectId string');
  const managementId = args['management-id'];
  if (managementId !== undefined && (typeof managementId !== 'string' || managementId.length > 512 || !/^export\/[A-Za-z0-9_-]+$/.test(managementId))) throw new ArgumentError('--management-id must be an exact export/... ID from the management list');
  if ([!!args.id, !!managementId, !!args['inspect-editor']].filter(Boolean).length > 1) throw new ArgumentError('--inspect-editor, --id and --management-id cannot be combined');
  if (managementId && ['days', 'start-date', 'end-date'].some(key => args[key] !== undefined)) throw new ArgumentError('Management metrics are cumulative; date-window arguments are not supported');
  const range = resolveDateRange(args, new Date(), 30);
  const file = resolve(args.operation);
  return locked(file, async () => {
    const op = await readOperation(file);
    if (!op) throw new ArgumentError('Operation journal not found');
    if (args['inspect-editor']) {
      if (!op.target || typeof page?.setActivePage !== 'function') throw new CommandExecutionError('Retained page identity unavailable');
      page.setActivePage(op.target);
      const editor = await page.evaluate(publishScript('status', op.operation_id, op.ai_generated));
      if (op.cover && editor && !editor.error && !editor.blocked) {
        editor.custom_cover = await page.evaluate(coverScript('diagnostics', op.operation_id, op.cover.role));
        if (editor.custom_cover) editor.custom_cover.activation = op.cover.activation ?? null;
      }
      // Reconcile an ambiguous save from the existing passive capture. Never
      // click save again. A completed matching receipt permits read-only reopen
      // and exact cover verification even when navigation removed old timings.
      const inspectable = editor?.path === '/platform/post/draftListManager'
        || !editor?.error && !editor?.blocked && editor?.operation_id === op.operation_id
          && editor?.draft_id === op.source_draft_id && sameDescription(editor?.description, op.description);
      if (inspectable && !op.submitted && op.status === 'draft_save_unknown' && op.cover?.phase === 'configured' && op.cover.save_attempted) {
        const after = Date.parse(op.cover.save_started_at || op.cover.manual_confirmations?.at(-1)?.at || op.created_at);
        const receipts = (await page.readNetworkCapture()).map(e => ({ id: draftReceipt(e, after), timestamp: e.timestamp })).filter(e => e.id);
        editor.draft_save_receipts = receipts;
        if (receipts.length && new Set(receipts.map(r => r.id)).size === 1 && receipts[0].id === op.source_draft_id) {
          op.native_draft_receipt = receipts[0]; op.status = 'draft_saved'; await save(file, op);
          const wait = publishWait(20, { onUpdate: async snapshot => { op.wait = snapshot; await save(file, op); } });
          return verifySavedDraft(page, file, op, 20, wait, true);
        }
      }
      return result(op, editor);
    }
    const id = args.id;
    if (!id && !managementId) return result({ ...op, message: 'Local status only. Supply --id or --management-id for remote reconciliation; no submission is retried' });
    if (!op.submitted) throw new CommandExecutionError('Cannot bind a published work to an operation that was never submitted');
    const currentUrl = await page.getCurrentUrl?.();
    if (currentUrl && new URL(currentUrl).pathname === '/platform/post/create') {
      throw new CommandExecutionError('Retained editor is still open; preserve it and use posts/post-detail separately instead of navigating away for reconciliation');
    }
    if (managementId) {
      const raw = await fetchManagementPost(page, managementId);
      const metrics = normalizePost(raw);
      // Publishing a saved draft creates a different management object ID.
      // Keep source_draft_id separately and verify the new work's time/content.
      if (raw.status !== 1 || metrics.title !== op.description || Date.parse(metrics.published_at) < Date.parse(op.submitted_at || op.created_at) - 60_000) {
        throw new CommandExecutionError('Management work does not match the submitted description, time or published status');
      }
      op.status = 'published'; op.management_id = managementId;
      op.metrics = metrics; op.metrics_source = 'management_cumulative'; op.analytics = null;
      op.message = 'Matched current account management record and cumulative metrics; numeric statistics ID and daily analytics are separate';
      await save(file, op); return result(op);
    }
    // Reuse the existing list, single-post client and mapping; no parallel analytics implementation.
    const posts = await fetchPosts(page, range, args.limit ?? 100);
    const raw = posts.find(item => item.objectId === id);
    if (!raw) throw new EmptyResultError('weixin-channels video-status', 'objectId not found in the selected publication window; today is excluded');
    const metrics = normalizePost(raw);
    if (metrics.title !== op.description || Date.parse(metrics.published_at) < Date.parse(op.created_at) - 60_000) {
      throw new CommandExecutionError('Published work does not match the prepared description and submission time');
    }
    const detail = await fetchPostDetail(page, id, range);
    op.status = 'published'; op.id = id; op.metrics = metrics;
    op.metrics_source = 'statistics';
    op.analytics = normalizeDetail(detail.data, detail.retention, id, range);
    op.message = 'Matched current account work and collected existing post-detail analytics';
    await save(file, op); return result(op);
  });
}
