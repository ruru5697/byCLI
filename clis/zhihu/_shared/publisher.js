import { requirePublishConfirmation } from '../../_shared/publish-confirmation.js';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { log } from '@sovovs/bycli/logger';
import { answerDraftCommand } from '../answer-waiting-draft.js';
import { inspectDraftPage, draftScript, resolveDraftOptions, normalizeDraftText } from '../draft-shared.js';
import { articlePersisted } from './article-draft-read.js';
import { currentAccount } from './account.js';
import { publishReceipt } from './receipt.js';
import { randomUUID } from 'node:crypto';
import { creatorTarget } from '../creator-model.js';
import { publisherScript } from './publisher-dom.js';
import { localFile, plainBody, saveOperation, withOperation } from './operation.js';

export const PUBLISH_COLUMNS = ['operation_id', 'kind', 'status', 'submitted', 'draft_id', 'editor_url', 'target', 'public_url', 'title', 'ai_generated', 'verified', 'message'];
export function operationResult(op) {
    return [{ operation_id: op.operation_id, kind: op.kind, status: op.status, submitted: op.submitted,
        draft_id: op.draft_id ?? null, editor_url: op.editor_url ?? null, target: op.content_target ?? null,
        public_url: op.public_url ?? null, title: op.title, ai_generated: op.ai_generated,
        verified: op.verified ?? false, message: op.message ?? '' }];
}
export function validateWrite(args, preparing = false) {
  requirePublishConfirmation(args);
    if (args.execute !== true && args.execute !== 'true') throw new ArgumentError('Use --execute for this write action');
    if (typeof args.operation !== 'string' || !args.operation) throw new ArgumentError('--operation is required; always reuse the same journal for the same work');
    if (!Number.isInteger(args.timeout ?? 120) || (args.timeout ?? 120) < 1 || (args.timeout ?? 120) > 1800) throw new ArgumentError('--timeout must be 1–1800 seconds');
    if (preparing && !['yes', 'no'].includes(args['ai-generated'])) throw new ArgumentError('--ai-generated must explicitly be yes or no');
}
async function inspect(page, op, action = 'status', allowCreatorTransition = false) {
    const s = await page.evaluate(publisherScript(op.kind, action, op));
    if (s?.error === 'auth') throw new AuthRequiredError('zhihu.com');
    if (allowCreatorTransition && s?.error === 'wrong_editor' && /^https:\/\/www\.zhihu\.com\/creator\/?(?:\?|$)/.test(s.url || '')) return s;
    if (!s || s.error) throw new CommandExecutionError(`Zhihu ${op.kind} editor unavailable: ${s?.error || 'invalid response'}`);
    return s;
}
async function waitFor(page, op, args, predicate, action = 'status', options = {}) {
    const started = Date.now(), timeout = args.timeout ?? 120;
    const deadline = started + timeout * 1000, stage = options.stage || action;
    let lastState, stableMismatch, stableSince, nextProgress = started + 15000;
    const describe = s => `ready=${!!s?.ready}, save=${s?.save_state || 'unavailable'}, draft_id=${s?.draft_id || op.draft_id || 'unknown'}, mismatched_fields=${contentDifferences(s, op, options.verifyDraftId).join(',') || 'none'}`;
    log.info(`[zhihu:${op.kind}] ${stage}: waiting (limit ${timeout}s)`);
    for (let n = 0; n < (args.timeout ?? 120) * 2; n++) {
        let s;
        try { s = await inspect(page, op, action, options.creatorTransition && Date.now() - started < 5000); }
        catch (e) { if (!/editor_loading/.test(e.message)) throw e; }
        lastState = s;
        if (s?.blocked) throw new CommandExecutionError('Editor requires manual verification or agreement review; inspect the retained tab');
        if (s?.save_state === 'failed') throw new CommandExecutionError(`Zhihu ${stage}: platform reports draft save failure; retain this operation and editor`);
        if (s && await predicate(s)) {
            log.info(`[zhihu:${op.kind}] ${stage}: complete (${Math.round((Date.now() - started) / 1000)}s)`);
            return s;
        }
        const differences = options.verifyContent && s?.ready && s.saved && s.images_ready ? contentDifferences(s, op, options.verifyDraftId) : [];
        if (differences.length) {
            // A saved, loaded draft with unchanged conflicting contents is not
            // an upload still in progress. Reset the grace period on any change.
            const signature = JSON.stringify([differences, s.title, s.body, s.draft_id, s.image_count, s.image_keys, s.cover_key]);
            if (signature !== stableMismatch) { stableMismatch = signature; stableSince = Date.now(); }
            if (Date.now() - stableSince >= 5000) throw new CommandExecutionError(`Zhihu ${stage}: saved draft content mismatch stable for 5s; ${describe(s)}; inspect the existing draft, do not upload again`);
        } else { stableMismatch = null; stableSince = null; }
        if (Date.now() >= nextProgress) {
            log.info(`[zhihu:${op.kind}] ${stage}: ${Math.round((Date.now() - started) / 1000)}s elapsed; ${describe(s)}`);
            nextProgress = Date.now() + 15000;
        }
        if (Date.now() >= deadline) break;
        await page.wait(0.5);
    }
    throw new TimeoutError(`Zhihu ${stage}`, timeout, `Last state: ${describe(lastState)}; inspect the existing journal/tab, do not create another operation`);
}
const assetKey = value => value?.match(/v2-[a-f0-9]+/i)?.[0] || value;
function contentDifferences(s, op, verifyDraftId = false) {
    if (!s?.ready) return [];
    const differences = [];
    if (verifyDraftId && op.draft_id && s.draft_id !== op.draft_id) differences.push('draft_id');
    if (op.kind !== 'answer' && s.title !== op.title) differences.push('title');
    if (normalizeDraftText(s.body) !== normalizeDraftText(op.body)) differences.push('body');
    if (s.image_count !== op.image_count) differences.push('image_count');
    if (op.image_keys && JSON.stringify(s.image_keys?.map(assetKey)) !== JSON.stringify(op.image_keys.map(assetKey))) differences.push('image_keys');
    if (op.cover_key && assetKey(s.cover_key) !== assetKey(op.cover_key)) differences.push('cover');
    return differences;
}
function sameContent(s, op) {
    return s.ready && !s.blocked && s.images_ready && contentDifferences(s, op).length === 0;
}
async function fill(page, op, action, value) {
    const s = await inspect(page, op, action);
    if (!s.selector) throw new CommandExecutionError(`No unique ${action} control in the verified editor`);
    const result = await page.fillText(s.selector, value);
    if (!result?.verified) throw new CommandExecutionError(`${action} input was not verified`);
}
async function setVideoOptions(page, op, args) {
    await setDeclaration(page, op, args);
    if (op.kind !== 'video') return;
    let s = await inspect(page, op, 'original');
    if (!s.original_selected) {
        if (!s.selector || typeof page.setChecked !== 'function') throw new CommandExecutionError('Originality control unavailable');
        await page.setChecked(s.selector, op.original === 'yes');
    }
    let clicks = 0;
    await waitFor(page, op, args, async state => {
        if (state.category_selected && state.original_selected) return true;
        if (state.selector && clicks++ < 2) await page.click(state.selector);
        return false;
    }, 'category');
}
async function setDeclaration(page, op, args) {
    let clicks = 0;
    return waitFor(page, op, args, async s => {
        if (s.ai_selected) return true;
        if (s.selector && clicks++ < 3) await page.click(s.selector);
        return false;
    }, 'ai');
}
export async function prepareDraft(page, args, kind) {
    validateWrite(args, true);
    return withOperation(args.operation, async (file, existing) => {
        if (existing) {
            if (existing.kind !== kind) throw new ArgumentError('Operation belongs to another content kind');
            return operationResult({ ...existing, message: 'Existing operation retained; use reopen/status or submit, never recreate it automatically' });
        }
        const body = await plainBody(args);
        if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > (kind === 'video' ? 80 : 100)) throw new ArgumentError('A nonempty title within the editor limit is required');
        let images;
        try { images = args.images ? JSON.parse(args.images) : []; } catch { throw new ArgumentError('--images must be a JSON array'); }
        if (!Array.isArray(images) || images.length > 20 || images.some(x => typeof x !== 'string')) throw new ArgumentError('--images must be a JSON array of at most 20 local paths');
        const media = [];
        for (const image of images) media.push(await localFile(image, true));
        const cover = args.cover ? await localFile(args.cover, true) : null;
        if (cover && !/\.(png|jpe?g)$/i.test(cover.path)) throw new ArgumentError('Article cover must be PNG or JPEG');
        const video = kind === 'video' ? await localFile(args.video) : null;
        if (kind === 'video' && (media.length || cover)) throw new ArgumentError('Video flow uses its generated cover; article images/cover are not supported');
        if (kind === 'video' && (!['yes', 'no'].includes(args.original) || typeof args.category !== 'string' || !args.category.trim())) throw new ArgumentError('Video requires explicit --original yes|no and --category');
        const op = { version: 1, site: 'zhihu', kind, operation_id: randomUUID(), created_at: new Date().toISOString(),
            title: args.title, body, ai_generated: args['ai-generated'], image_count: media.length, images: media, cover, video, category: args.category, original: args.original,
            submitted: false, status: 'preparing', verified: false };
        await saveOperation(file, op);
        try {
            await page.goto(kind === 'video' ? 'https://www.zhihu.com/upload-video' : 'https://zhuanlan.zhihu.com/write', { stealth: false });
            op.browser_target = page.getActivePage?.();
            op.author_identity = await currentAccount(page); await saveOperation(file, op);
            await page.focusWindow?.();
            const initial = await waitFor(page, op, args, s => kind === 'video' ? !!s.selector : s.ready, kind === 'video' ? 'upload' : 'status', { stage: 'open-editor' });
            if (initial.body || initial.title || initial.image_count || initial.draft_id) throw new CommandExecutionError('New editor contains existing content; refusing to overwrite it');
            await inspect(page, op, 'bind');
            const captureStarted = Date.now();
            if (kind === 'video') {
                if (!await page.startNetworkCapture?.()) throw new CommandExecutionError('Native response capture is required to identify a video draft before upload');
                await page.readNetworkCapture?.();
                await page.uploadFiles(initial.selector, [video.path]);
                op.file_selected = true; await saveOperation(file, op);
                await waitFor(page, op, args, s => s.ready, 'status', { stage: 'video-upload' });
            }
            await fill(page, op, 'title', op.title); await fill(page, op, 'body', op.body);
            if (media.length) {
                const control = await inspect(page, op, 'images');
                if (!control.selector) throw new CommandExecutionError('Unique body-image input unavailable');
                for (let i = 0; i < media.length; i++) {
                    await page.uploadFiles(control.selector, [media[i].path]);
                    await waitFor(page, op, args, s => s.image_count === i + 1 && s.images_ready && s.saved);
                }
            }
            const draftIds = new Set();
            const identified = await waitFor(page, op, args, async s => {
                if (kind === 'video') {
                    for (const entry of await page.readNetworkCapture()) {
                        let url; try { url = new URL(entry.url); } catch { continue; }
                        if (url.origin !== 'https://api.zhihu.com' || url.pathname !== '/content/drafts' || entry.method !== 'POST' || entry.responseStatus !== 200 || entry.responseBodyTruncated || !Number.isFinite(Number(entry.timestamp)) || Number(entry.timestamp) < captureStarted) continue;
                        let response;
                        try { response = JSON.parse(entry.responsePreview); } catch { continue; }
                        if (response.code === 0 && ['pin', 'zvideo'].includes(response.data?.draft_type) && typeof response.data?.content_id === 'string' && /^\d+$/.test(response.data.content_id)) {
                            draftIds.add(response.data.content_id); op.draft_type = response.data.draft_type;
                        }
                    }
                    if (draftIds.size > 1) throw new CommandExecutionError('More than one draft identity observed; refusing to guess');
                    if (draftIds.size === 1) {
                        s.draft_id = [...draftIds][0];
                        // Keep the exact native receipt even when later content
                        // verification fails, so recovery does not create a draft.
                        if (!op.draft_id) {
                            op.draft_id = s.draft_id;
                            op.editor_url = `https://www.zhihu.com/upload-video?id=${s.draft_id}`;
                            await saveOperation(file, op);
                        }
                    }
                }
                return sameContent(s, op) && s.saved && /^\d+$/.test(s.draft_id || '');
            }, 'status', { stage: 'draft-save', verifyContent: true });
            op.draft_id = identified.draft_id;
            op.editor_url = kind === 'video' ? `https://www.zhihu.com/upload-video?id=${identified.draft_id}` : `https://zhuanlan.zhihu.com/p/${identified.draft_id}/edit`;
            op.image_keys = identified.image_keys; await saveOperation(file, op);
            if (cover) {
                const control = await inspect(page, op, 'cover');
                if (!control.selector) throw new CommandExecutionError('Unique cover input unavailable');
                await page.uploadFiles(control.selector, [cover.path]);
                const covered = await waitFor(page, op, args, s => !!s.cover_key);
                op.cover_key = covered.cover_key; await saveOperation(file, op);
            }
            await setVideoOptions(page, op, args);
            // Declaration changes can leave the UI in saving state. Article
            // persistence is established by a fresh server draft read after reload.
            const saved = await waitFor(page, op, args, s => sameContent(s, op) && s.ai_selected && (kind === 'article' || ['saved', 'not_shown'].includes(s.save_state)), 'status', { stage: 'save-content', verifyContent: true });
            if (kind === 'article') { op.draft_id = saved.draft_id; op.editor_url = `https://zhuanlan.zhihu.com/p/${saved.draft_id}/edit`; }
            op.status = 'draft_saved'; op.message = 'Draft saved; verifying persistence by reopening its exact URL';
            await saveOperation(file, op);
            return await reopenDraft(page, args, file, op);
        } catch (e) {
            op.status = 'preparation_unknown'; op.verified = false;
            op.message = e.message;
            op.verification_error ??= { code: e.code || 'COMMAND_EXEC', message: e.message };
            await saveOperation(file, op); throw e;
        }
    });
}
export async function prepareAnswer(page, args) {
    validateWrite(args, true);
    return withOperation(args.operation, async (file, existing) => {
        if (existing) {
            if (existing.kind !== 'answer') throw new ArgumentError('Operation belongs to another content kind');
            return operationResult(existing);
        }
        const options = resolveDraftOptions({ target: args.target, mode: 'new', timeout: Math.min(args.timeout ?? 120, 120) });
        const op = { version: 1, site: 'zhihu', kind: 'answer', operation_id: randomUUID(), created_at: new Date().toISOString(),
            question_id: options.questionId, title: args['expected-title'] || '', body: await plainBody(args), ai_generated: args['ai-generated'],
            image_count: 0, images: [], submitted: false, status: 'preparing', verified: false };
        await saveOperation(file, op);
        try { return await reopenAnswer(page, args, file, op); }
        catch (e) { op.status = 'preparation_unknown'; op.message = 'Inspect existing answer draft; do not create another operation'; await saveOperation(file, op); throw e; }
    });
}
async function reopenAnswer(page, args, file, op) {
    if (op.submitted) throw new CommandExecutionError('Already submitted; reconcile without recreating an answer');
    await page.goto(`https://www.zhihu.com/question/${op.question_id}`, { stealth: false });
    op.author_identity = await currentAccount(page, op.author_identity);
    await answerDraftCommand.func(page, { target: `question:${op.question_id}`, text: op.body, mode: 'new', existing: 'error',
        execute: true, timeout: Math.min(args.timeout ?? 120, 120), 'expected-title': op.title || undefined, 'close-editor': false });
    const state = await page.evaluate(draftScript(inspectDraftPage, op.question_id));
    if (state.status !== 'editor' || state.mode !== 'new' || !state.saved || normalizeDraftText(state.text) !== op.body || !state.title) throw new CommandExecutionError('New answer draft identity/content could not be verified');
    op.title = state.title; op.editor_url = state.url; op.draft_id = null;
    await inspect(page, op, 'bind'); await setDeclaration(page, op, args);
    op.browser_target = page.getActivePage?.(); op.status = 'draft_verified'; op.verified = true;
    op.message = 'New answer draft persisted and re-read; declaration configured; not submitted';
    await saveOperation(file, op); return operationResult(op);
}
export async function reopenDraft(page, args, file, op) {
    if (op.kind === 'answer') return reopenAnswer(page, args, file, op);
    if (op.cover && !op.cover_key) throw new CommandExecutionError('Requested cover has not been confirmed; use explicit repair-cover on the same draft');
    if (op.submitted || !op.editor_url || !op.draft_id) throw new CommandExecutionError('Only an identified unsubmitted draft can be reopened');
    const expected = op.kind === 'article' ? `https://zhuanlan.zhihu.com/p/${op.draft_id}/edit` : `https://www.zhihu.com/upload-video?id=${op.draft_id}`;
    if (op.editor_url !== expected) throw new ArgumentError('Unexpected persisted draft URL');
    op.verified = false; op.status = 'draft_saved';
    op.message = 'Reopening the exact saved draft to verify its persisted contents';
    delete op.verification_error;
    await saveOperation(file, op);
    log.info(`[zhihu:${op.kind}] reopen: opening draft ${op.draft_id}`);
    try {
        await page.goto('https://www.zhihu.com/creator', { stealth: false });
        await page.startNetworkCapture?.();
        await page.goto(expected, { stealth: false });
        await page.focusWindow?.();
        op.author_identity = await currentAccount(page, op.author_identity);
        const restored = await waitFor(page, op, args, async s => sameContent(s, op) && s.draft_id === op.draft_id
            && (op.kind === 'article' ? await articlePersisted(page, op) : s.saved), 'status',
            { stage: 'reopen-content', verifyContent: true, verifyDraftId: true, creatorTransition: true });
        if (op.kind === 'article') op.server_draft_verified_at = new Date().toISOString();
        await inspect(page, op, 'bind');
        // The article editor does not persist this declaration in the remote draft.
        // Configure it after content readback and verify again at submission time.
        await setVideoOptions(page, op, args);
        op.browser_target = page.getActivePage?.(); op.status = 'draft_verified'; op.verified = true;
        op.message = 'Unpublished draft content reopened and verified; declaration configured in retained editor';
        op.image_count = restored.image_count;
        await saveOperation(file, op); return operationResult(op);
    } catch (e) {
        op.verified = false; op.message = e.message;
        op.verification_error = { stage: 'reopen-content', code: e.code || 'COMMAND_EXEC', message: e.message };
        await saveOperation(file, op); throw e;
    }
}
export async function manageDraft(page, args, kind) {
    validateWrite(args);
    return withOperation(args.operation, async (file, op) => {
        if (!op || op.kind !== kind) throw new ArgumentError('Matching prepared operation not found');
        const mode = args.mode ?? 'reopen';
        if (!['reopen', 'resume', 'repair-cover', 'submit'].includes(mode)) throw new ArgumentError('--mode must be reopen, resume, repair-cover or submit');
        if (mode === 'repair-cover') {
            if (kind !== 'article' || op.submitted || !op.cover || !op.draft_id || op.editor_url !== `https://zhuanlan.zhihu.com/p/${op.draft_id}/edit`) throw new CommandExecutionError('Cover repair requires an identified unsubmitted article draft with its original cover file');
            const local = await localFile(op.cover.path, true);
            if (local.sha256 !== op.cover.sha256) throw new CommandExecutionError('Cover file changed; refusing repair');
            await page.goto(op.editor_url, { stealth: false });
            await page.focusWindow?.();
            op.author_identity = await currentAccount(page, op.author_identity);
            await waitFor(page, op, args, s => sameContent(s, { ...op, cover_key: null }) && s.draft_id === op.draft_id);
            if (!await articlePersisted(page, { ...op, cover: null, cover_key: null })) throw new CommandExecutionError('Article server content changed; refusing cover repair');
            await page.startNetworkCapture?.();
            await page.readNetworkCapture?.();
            op.status = 'preparation_unknown'; op.verified = false;
            op.cover_attempts = [...(op.cover_attempts || []), new Date().toISOString()];
            op.message = 'Explicit cover retry on existing unpublished draft; no article creation or submission';
            await saveOperation(file, op);
            const control = await inspect(page, op, 'reset-cover');
            if (!control.selector) throw new CommandExecutionError('Unique cover input unavailable');
            await page.uploadFiles(control.selector, [local.path]);
            const covered = await waitFor(page, op, args, s => !!s.cover_key);
            op.cover_key = covered.cover_key; await saveOperation(file, op);
            return reopenDraft(page, args, file, op);
        }
        if (mode === 'resume') {
            if (kind !== 'article') throw new ArgumentError('Only article preparation supports resume; use reopen for other kinds');
            if (op.submitted || (op.status !== 'preparation_unknown' && !(args['repair-images'] && op.status === 'draft_verified')) || !op.browser_target) throw new CommandExecutionError('Only an interrupted unsubmitted preparation can resume');
            page.setActivePage(op.browser_target); await page.focusWindow?.();
            if (!op.author_identity) throw new CommandExecutionError('Reopen to bind the verified account before draft repair');
            await currentAccount(page, op.author_identity);
            const s = await inspect(page, op);
            if (s.operation_id !== op.operation_id || !sameContent(s, op) || s.save_state === 'failed' || !/^\d+$/.test(s.draft_id || '') || (op.cover && !s.cover_key)) throw new CommandExecutionError('Retained draft changed or is incomplete; refusing recovery without another upload');
            op.draft_id = s.draft_id; op.editor_url = s.url.split('#')[0];
            if (args['repair-images']) {
                for (const image of op.images) {
                    const current = await localFile(image.path, true);
                    if (current.sha256 !== image.sha256) throw new CommandExecutionError('Local image changed; refusing draft repair');
                }
                await fill(page, op, 'body', op.body);
                await waitFor(page, op, args, state => state.image_count === 0 && state.body === op.body);
                for (let i = 0; i < op.images.length; i++) {
                    const control = await inspect(page, op, 'images');
                    if (!control.selector) throw new CommandExecutionError('Unique image input unavailable');
                    await page.uploadFiles(control.selector, [op.images[i].path]);
                    await waitFor(page, op, args, state => state.image_count === i + 1 && state.images_ready && state.saved);
                }
            }
            const repaired = await inspect(page, op);
            op.image_keys = repaired.image_keys; op.cover_key = repaired.cover_key;
            await saveOperation(file, op); await setVideoOptions(page, op, args);
            return reopenDraft(page, args, file, op);
        }
        if (mode === 'reopen') return reopenDraft(page, args, file, op);
        if (op.submitted) return operationResult({ ...op, message: 'Submission was already attempted; reconcile status rather than submit again' });
        if (!op.verified || op.status !== 'draft_verified' || !op.browser_target) throw new CommandExecutionError('Reopen and verify the unsubmitted draft before publishing');
        page.setActivePage(op.browser_target); await page.focusWindow?.();
        if (!op.author_identity) throw new CommandExecutionError('Reopen this draft to bind its verified current account before submission');
        await currentAccount(page, op.author_identity);
        const s = await inspect(page, op, 'submit');
        if (s.success && s.operation_id === op.operation_id && s.draft_id === op.draft_id && sameContent(s, op)) {
            op.submitted = true; op.status = 'submitted'; op.verified = false;
            op.message = 'Matching editor already displays publish success; reconcile its public target without another click';
            await saveOperation(file, op); return operationResult(op);
        }
        if (s.operation_id !== op.operation_id || s.draft_id !== op.draft_id || !sameContent(s, op) || !s.ai_selected || !s.selector
            || (kind === 'article' ? !await articlePersisted(page, op) : !['saved', 'not_shown'].includes(s.save_state))) throw new CommandExecutionError('Draft identity, content, declaration or enabled publish control changed; refusing submission');
        const captureStarted = Date.now();
        const capture = await page.startNetworkCapture?.();
        if (capture) await page.readNetworkCapture?.();
        if (kind === 'video' && !capture) throw new CommandExecutionError('Native publish receipt capture is required for video type/identity');
        // Durable uncertainty is recorded before the irreversible click. Never retry.
        op.user_confirmed_at = new Date().toISOString();
        op.submitted = true; op.status = 'submit_unknown'; op.verified = false;
        op.message = 'Submission may have happened; status reconciliation is required'; await saveOperation(file, op);
        await page.click(s.selector);
        for (let n = 0; n < 20; n++) {
            let after;
            try { after = await inspect(page, op); } catch {
                const current = await page.getCurrentUrl?.().catch(() => null);
                try {
                    const target = creatorTarget(current);
                    const matches = kind === 'article' ? target.type === 'article' && target.id === op.draft_id
                        : kind === 'answer' ? target.type === 'answer' && target.contentUrl?.includes(`/question/${op.question_id}/answer/`) : false;
                    if (matches) { op.status = 'submitted'; op.content_target = kind === 'answer' ? `answer:${op.question_id}:${target.id}` : `${target.type}:${target.id}`; op.public_url = target.contentUrl; op.message = 'Navigated to exact submitted work; verify public content separately'; }
                } catch { /* Preserve unknown state when no exact public target is observable. */ }
                if (!capture) break;
            }
            // Bridge reads drain in-flight requests as well as complete ones. Do
            // not consume a pending POST before its response body arrives.
            if (capture && (after?.success || after?.blocked || op.status === 'submitted' || n === 19)) {
                await page.wait(0.25);
                for (const entry of await page.readNetworkCapture()) {
                    const receipt = publishReceipt(entry, op, captureStarted);
                    if (!receipt) continue;
                    op.status = receipt.status;
                    op.message = receipt.status === 'submitted' ? 'Platform receipt confirms submission; verify public content separately' : 'Platform rejected submission; do not auto-retry';
                    if (receipt.id) {
                        op.content_target = receipt.type === 'answer' ? `answer:${op.question_id}:${receipt.id}` : `${receipt.type}:${receipt.id}`;
                        op.public_url = creatorTarget(op.content_target).contentUrl;
                    }
                    await saveOperation(file, op); return operationResult(op);
                }
            }
            if (after?.blocked) { op.message = 'Complete verification manually; never repeat publish'; break; }
            if (after?.success) {
                op.status = 'submitted'; op.message = 'UI confirms submission; public availability still requires status verification';
                for (const url of after.detail_links) {
                    try {
                        const t = creatorTarget(url);
                        if (kind === 'article' && t.type !== 'article' || kind === 'video' && !['pin', 'zvideo'].includes(t.type)) continue;
                        if (kind === 'article' && t.id !== op.draft_id) continue;
                        if (kind === 'answer' && (t.type !== 'answer' || !t.contentUrl?.includes(`/question/${op.question_id}/answer/`))) continue;
                        if (kind === 'video' && t.id !== op.draft_id) continue;
                        op.content_target = t.type === 'answer' ? `answer:${op.question_id}:${t.id}` : `${t.type}:${t.id}`; op.public_url = t.contentUrl; break;
                    } catch { /* Ignore unrelated links, never guess a video platform type. */ }
                }
                if (kind === 'article') { op.content_target = `article:${op.draft_id}`; op.public_url = `https://zhuanlan.zhihu.com/p/${op.draft_id}`; }
                break;
            }
            if (op.status === 'submitted') break;
            await page.wait(0.5);
        }
        await saveOperation(file, op); return operationResult(op);
    });
}
