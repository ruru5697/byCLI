import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ArgumentError, CliError } from '@sovovs/bycli/errors';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw new CliError(code, message); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const endpoints = { xiaohongshu: '/web_api/sns/v2/note', sohu: '/mpbp/bp/news/v4/news/publishVideo/v2' };
export function publishEndpoint(platform,contentType='video') {
    if(platform==='sohu'&&contentType==='gallery')return '/mpbp/bp/news/v4/news/publishAlbum/v2';
    if(platform==='sohu'&&contentType==='article')return '/mpbp/bp/news/v4/news/publish/v2';
    if(contentType==='video'||platform==='xiaohongshu'&&contentType==='image')return endpoints[platform];
    return undefined;
}
export const managers = { xiaohongshu: 'https://creator.xiaohongshu.com/new/note-manager', sohu: 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page' };
export async function saveJob(file, job) {
    job.updatedAt = new Date().toISOString();
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o600 }); await fs.rename(tmp, file); }
    finally { await fs.rm(tmp, { force: true }); }
}
export async function withJob(platform, id, action, contentType = 'video') {
    if (!publishEndpoint(platform,contentType)) throw new ArgumentError('Unsupported publishing content type');
    if (!uuid.test(id || '') || !endpoints[platform]) throw new ArgumentError('A valid local publishing job UUID is required');
    const file = path.join(process.env.BYCLI_CONFIG_DIR || path.join(os.homedir(), '.bycli'), 'publish-jobs', platform, id, 'job.json');
    let lock;
    try { lock = await fs.open(file + '.lock', 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') fail('JOB_BUSY', 'Job locked; inspect an interrupted process before removing its lock'); throw e; }
    try {
        const job = JSON.parse(await fs.readFile(file, 'utf8'));
        if (job.jobId !== id || job.platform !== platform || job.contentType !== contentType) fail('INVALID_JOB', 'Job identity mismatch');
        return await action(job, () => saveJob(file, job), file);
    } finally { await lock.close(); await fs.rm(file + '.lock', { force: true }); }
}
async function verifyAssets(job) {
    if (digest({ manifest: job.manifest, assets: job.assets }) !== job.inputSha256) fail('INPUT_CHANGED', 'Manifest or asset metadata changed');
    let assets;
    if(['gallery','article'].includes(job.contentType)) {
        if(!Array.isArray(job.assets.images)||job.assets.images.length!==job.manifest.images.length||!job.assets.images.length||job.assets.cover?.path!==job.manifest.cover)fail('INPUT_CHANGED','Invalid Sohu image assets or cover');
        assets=[...job.assets.images.map((a,i)=>{if(a.path!==(job.contentType==='gallery'?job.manifest.images[i]?.path:job.manifest.images[i]))fail('INPUT_CHANGED','Sohu image asset order differs');return {...a,label:`Image ${i+1}`}}),{...job.assets.cover,label:'cover'}];
    } else {
        assets = job.contentType === 'image' ? job.assets.map((a,i) => { if (a.path !== job.manifest.images[i] || a.order !== i+1) fail('INPUT_CHANGED','Image asset order differs from manifest'); return {path:a.path,sha256:a.sha256,label:`Image ${i+1}`}; }) : ['video','cover'].map(key => ({path:job.manifest[key],sha256:job.assets[key].sha256,label:key}));
        if (job.contentType === 'image' && (assets.length !== job.manifest.images.length || !assets.length)) fail('INPUT_CHANGED','Invalid image asset list');
    }
    for (const asset of assets) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
        if (hash.digest('hex') !== asset.sha256) fail('ASSET_CHANGED', `${asset.label} changed after preparation`);
    }
}
export function parseReceipt(platform, entry, contentType='video') {
    let url;
    try { url = new URL(entry.url); } catch { return null; }
    const trusted = platform === 'sohu' ? url.hostname === 'mp.sohu.com' : /(^|\.)xiaohongshu\.com$/.test(url.hostname);
    if (!trusted || url.protocol !== 'https:' || url.pathname !== publishEndpoint(platform,contentType) || entry.method !== 'POST') return null;
    if (entry.responseStatus == null) return null;
    if (!entry.responsePreview && !entry.responseBodyTruncated) return null;
    if (entry.responseBodyTruncated) return { status: 'result_unknown', reason: 'Incomplete response' };
    let body;
    try { body = JSON.parse(entry.responsePreview); } catch { return { status: 'result_unknown', reason: 'Non-JSON response' }; }
    const shape = { httpStatus: entry.responseStatus, responseShape: body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'result_unknown', ...shape, reason: 'Unexpected JSON envelope' };
    // Only structural diagnostics, never response values, tokens or arbitrary key names.
    shape.envelope = ['code','success','data','message','msg'].filter(key => Object.hasOwn(body,key));
    shape.dataShape = body.data === null ? 'null' : Array.isArray(body.data) ? 'array' : typeof body.data;
    const hasCode = Object.hasOwn(body,'code');
    shape.businessCodePresent = hasCode;
    shape.platformSuccess = typeof body.success === 'boolean' ? body.success : null;
    shape.dataFields = body.data && typeof body.data === 'object' ? ['id','noteId','note_id'].filter(key=>Object.hasOwn(body.data,key)) : [];
    // The real XHS response envelope can omit code. A literal success=true is
    // an explicit business signal; a present contradictory code remains unknown.
    const success = platform === 'sohu' ? body.code === 2000000 && (!['gallery','article'].includes(contentType)||body.success===true) : body.success === true && (!hasCode || body.code === 0);
    const code = typeof body.code === 'number' || typeof body.code === 'string' ? String(body.code).slice(0,40) : null;
    if (entry.responseStatus < 200 || entry.responseStatus >= 300) return { status: 'result_unknown', code, httpStatus: entry.responseStatus };
    // A rejection is conclusive only when the platform explicitly reports business failure.
    if(platform==='sohu'&&['gallery','article'].includes(contentType)&&body.code===2000000&&body.success!==true)return {status:'result_unknown',code,...shape};
    if (!success) return { status: (code !== null && (platform === 'sohu' || body.success === false) || platform === 'xiaohongshu' && !hasCode && body.success === false) ? 'rejected' : 'result_unknown', code, ...shape };
    const data = body.data;
    const raw = platform === 'sohu' ? (typeof data === 'object' ? data?.newsId ?? data?.id : data) : data?.id ?? data?.noteId ?? data?.note_id;
    const id = typeof raw === 'string' || Number.isSafeInteger(raw) ? String(raw) : '';
    const valid = platform === 'sohu' ? /^[1-9]\d{0,24}$/.test(id) : /^[a-f0-9]{24}$/.test(id);
    return { status: 'accepted', code, contentId: valid ? id : null, httpStatus: entry.responseStatus, platformSuccess: shape.platformSuccess, businessCodePresent: hasCode, successSignal: platform==='sohu'?'business_code':hasCode?'code_and_success':'explicit_success_without_code' };
}
export const sohuStatuses = { 1:'draft', 2:'reviewing', 3:'rejected', 4:'published', 5:'scheduled', 7:'deleted', 9:'deleted_after_review', 16:'second_review_passed' };
export function output(job, file) {
    return [{ status: job.status, job_id: job.jobId, submitted: job.submitted, content_id: job.receipt?.contentId || job.reconciliation?.contentId || null,
        content_type: job.contentType, public_url: job.lastQuery?.publicUrl || null, account: job.review?.account?.name || job.preparedAccount?.name || null, title: job.manifest.title, confirmation: job.review?.token || null,
        expires_at: job.review?.expiresAt || null, receipt_status: job.receipt?.status || null, identity_source: job.receipt?.contentId ? 'publish_receipt' : job.reconciliation?.contentId ? 'verified_manager_record' : null, query_status: job.lastQuery?.status || null, query_reason: job.lastQuery?.reason || null, report: file, preview: job.review?.preview || job.screenshot }];
}
/** All UI-specific code is injected. A durable attempt precedes exactly one publish gesture. */
export async function publishJobAction(page, kwargs, platform, adapter, contentType = 'video') {
    const modes = ['review','submit','status'].filter(k => !!kwargs[k]);
    if (modes.length !== 1 || kwargs.prepare || kwargs.input || (kwargs.confirm && modes[0] !== 'submit')) throw new ArgumentError('Choose exactly one of --review JOB, --submit JOB --confirm TOKEN, or --status JOB');
    const mode = modes[0];
    return withJob(platform, kwargs[mode], async (job, save, file) => {
        if (mode === 'status') {
            if (job.attempt && !job.receipt) { job.status = 'result_unknown'; await save(); }
            if (job.receipt?.contentId || job.reconciliation?.contentId) {
                const state = await adapter.query(page, job);
                job.lastQuery = { at: new Date().toISOString(), ...state };
                if (state.status && state.status !== 'not_found' && state.status !== 'query_unavailable') job.status = state.status;
                await save();
            }
            return output(job, file);
        }
        if (job.attempt) fail('ALREADY_ATTEMPTED', 'This job already has a submission attempt; query its status and reconcile it, never resubmit');
        if (job.status !== 'ready_for_confirmation' && !(platform==='sohu'&&['gallery','article'].includes(contentType)&&mode==='review'&&job.status==='draft_saved')) fail('JOB_NOT_READY', 'Prepare a fresh publishing job before review');
        const tabs = await page.tabs();
        if (!job.pageTarget || !tabs.some(t => t.page === job.pageTarget)) fail('EDITOR_MISSING', 'The prepared browser editor no longer exists');
        page.setActivePage(job.pageTarget);
        await page.focusWindow();
        await verifyAssets(job);
        const live = await adapter.inspect(page, job);
        if (job.publishBinding && digest({account:live.account,mediaHash:live.mediaHash}) !== job.publishBinding) fail('MEDIA_OR_ACCOUNT_CHANGED','Uploaded media or account changed; prepare a fresh job');
        if (mode === 'review') {
            job.status='ready_for_confirmation';
            if(platform==='sohu'&&['gallery','article'].includes(contentType)&&live.draftId)job.remoteDraftId=live.draftId;
            job.publishBinding = digest({account:live.account,mediaHash:live.mediaHash});
            const preview = path.join(path.dirname(file), 'confirmation.png');
            await page.screenshot({path:preview,fullPage:true}); await fs.chmod(preview,0o600);
            job.finalPublishAction = 'requires_confirmation';
            job.review = { token: randomUUID(), expiresAt: new Date(Date.now()+30*60*1000).toISOString(), snapshotHash:digest(live), account:live.account, preview,
                content: {title:job.manifest.title,body:job.manifest.body,declaration:job.manifest.declaration,visibility:job.manifest.visibility,category:job.manifest.category,...(['gallery','article'].includes(contentType)?{summary:job.manifest.summary,attribute:job.manifest.attribute,images:job.assets.images.map((a,i)=>({order:i+1,name:a.name,sha256:a.sha256,width:a.width,height:a.height,description:job.contentType==='gallery'?job.manifest.images[i].description:undefined})),cover:{sha256:job.assets.cover.sha256,width:job.assets.cover.width,height:job.assets.cover.height}}:{}),...(contentType==='image'?{images:job.assets.map(a=>({order:a.order,name:a.name,sha256:a.sha256,width:a.width,height:a.height}))}:{})} };
            await save(); return output(job,file);
        }
        if (!job.review || kwargs.confirm !== job.review.token) fail('CONFIRMATION_REQUIRED','Run --review JOB and pass its exact confirmation token after human approval');
        if (Date.parse(job.review.expiresAt) <= Date.now()) fail('CONFIRMATION_EXPIRED','Review the current editor again');
        if (digest(live) !== job.review.snapshotHash) fail('EDITOR_CHANGED','Account, media or editor settings changed; review again');
        if (!await page.startNetworkCapture(publishEndpoint(platform,contentType))) fail('CAPTURE_UNAVAILABLE','Submission requires native response capture');
        // Recheck after capture setup, before consuming the one-shot attempt.
        if (digest(await adapter.inspect(page,job)) !== job.review.snapshotHash) fail('EDITOR_CHANGED','Editor changed before submission');
        job.attempt = { id:randomUUID(),startedAt:new Date().toISOString(),confirmation:job.review.token };
        job.status = 'submitting'; job.submitted = null; job.finalPublishAction = 'attempt_recorded'; await save();
        try {
            await adapter.trigger(page,job);
            // Bridge capture is a draining read. Let the platform's 15s request timeout
            // finish before the single read; never drain an in-flight response on a poll.
            await page.wait({time:25});
            const entries=await page.readNetworkCapture();
            const receipts=entries.map(e=>parseReceipt(platform,e,contentType)).filter(Boolean);
            if (receipts.length > 1) job.receipt={status:'result_unknown',reason:'Multiple publish responses; reconcile manually'};
            else if(receipts.length===1) job.receipt={...receipts[0],receivedAt:new Date().toISOString(),endpoint:publishEndpoint(platform,contentType)};
            if(job.receipt){job.status=job.receipt.status;job.submitted=job.status==='accepted'?true:job.status==='rejected'?false:null;}
        } catch { job.submissionError='Publish gesture or receipt collection failed; do not retry'; }
        if (!job.receipt) job.status='result_unknown';
        job.finalPublishAction='attempted_once'; await save(); return output(job,file);
    }, contentType);
}

// Explicit wrappers preserve strict image/video job isolation at each command boundary.
export const videoJobAction = (page,kwargs,platform,adapter) => publishJobAction(page,kwargs,platform,adapter,'video');
export const imageJobAction = (page,kwargs,adapter) => publishJobAction(page,kwargs,'xiaohongshu',adapter,'image');

export const sohuContentJobAction=(page,kwargs,adapter,type)=>{if(!['gallery','article'].includes(type))throw new ArgumentError('Expected gallery or article');return publishJobAction(page,kwargs,'sohu',adapter,type);};
