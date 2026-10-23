import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash,randomUUID} from 'node:crypto';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {snapshotScript,assertArticleChecks,validateArticleManifest,compareMarkdown} from './_article-prepare.js';
import {waitFor} from '../_shared/video-prepare.js';
import {saveJob} from '../_shared/video-submit.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const PUBLISH_PATH='/content_api/v1/article/publish';
const validId=v=>typeof v==='string'&&/^[1-9]\d{0,29}$/.test(v);
export async function withArticleJob(id,action){
 if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw new ArgumentError('Valid local article job UUID required');
 const file=path.join(process.env.BYCLI_CONFIG_DIR||path.join(os.homedir(),'.bycli'),'publish-jobs','juejin',id,'job.json');let lock;
 try{lock=await fs.open(file+'.lock','wx',0o600)}catch(e){if(e.code==='EEXIST')throw new CliError('JOB_BUSY','Job is locked; inspect the owner before removing a stale lock');throw e}
 try{const job=JSON.parse(await fs.readFile(file,'utf8'));if(job.jobId!==id||job.platform!=='juejin'||job.contentType!=='article'||!validId(job.draftId))throw new CliError('INVALID_JOB','Article job identity differs');return await action(job,()=>saveJob(file,job),file)}finally{await lock.close();await fs.rm(file+'.lock',{force:true})}
}
export function parseArticleReceipt(e){
 let u;try{u=new URL(e.url)}catch{return null}
 if(u.protocol!=='https:'||u.hostname!=='api.juejin.cn'||u.pathname!==PUBLISH_PATH||e.method!=='POST'||e.responseStatus==null)return null;
 if(e.responseBodyTruncated)return {status:'result_unknown',reason:'truncated_response'};
 if(!e.responsePreview)return null;
 let b;try{b=JSON.parse(e.responsePreview)}catch{return {status:'result_unknown',reason:'invalid_json'}}
 const httpStatus=e.responseStatus,code=typeof b?.err_no==='number'?b.err_no:null;
 if(httpStatus<200||httpStatus>=300||!b||Array.isArray(b)||code===null)return {status:'result_unknown',httpStatus,code};
 if(code!==0)return {status:'rejected',httpStatus,code};
 const raw=b.data?.article_id,id=typeof raw==='string'?raw:Number.isSafeInteger(raw)?String(raw):null;
 const owner=b.data?.user_id;
 return {status:'accepted',httpStatus,code,contentId:validId(id)?id:null,accountId:validId(owner)?owner:null};
}
export function preparedArticleBody(job){
 const body=job.bodyAsStored??job.manifest.body;
 if(typeof body!=='string'||!compareMarkdown(job.manifest.body,body).ok)throw new CliError('INPUT_CHANGED','Stored Markdown differs from prepared input');
 return body;
}
export async function verifyArticleInputs(job){
 validateArticleManifest(job.manifest);preparedArticleBody(job);
 if(hash(JSON.stringify(job.manifest))!==job.inputSha256||job.assets?.cover?.path!==job.manifest.cover)throw new CliError('INPUT_CHANGED','Prepared manifest or cover metadata differs');
 const bytes=await fs.readFile(job.manifest.cover);if(hash(bytes)!==job.assets.cover.sha256||bytes.length!==job.assets.cover.bytes)throw new CliError('ASSET_CHANGED','Prepared cover bytes changed');
}
export async function inspectArticle(page,job){
 const s=await page.evaluate(snapshotScript());assertArticleChecks(s,job.manifest,job.assets,job.upload,preparedArticleBody(job));
 if(s.draftId!==job.draftId)throw new CliError('EDITOR_CHANGED','Exact authorized draft differs');
 const extra=await page.evaluate(String.raw`(async()=>{const p=document.querySelector('.publish-popup').__vue__.post;const value=JSON.stringify(Object.fromEntries(['link_url','is_gfw','is_english','is_original','type','html'].map(k=>[k,p[k]??null])));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('')})()`);
 return {draftId:s.draftId,account:s.account,title:s.title,bodySha256:s.bodySha256,coverHash:s.cover.hash,categoryId:s.categoryId,tags:s.tags,summary:s.summary,columns:s.columns,topics:s.topics,syncToOrg:s.syncToOrg,extraHash:extra};
}
export async function openArticleEditor(page,job){
 const tabs=await page.tabs(),url=`https://juejin.cn/editor/drafts/${job.draftId}`;
 if(tabs.length){page.setActivePage(tabs[0].page);const active=await page.evaluate('location.origin+location.pathname');if(active!==url){if(!['https://juejin.cn/creator/content/article/essays','https://juejin.cn/notification/system'].includes(active))throw new CliError('EDITOR_IN_USE','Retain existing owned page; finish or close it before restoring the authorized draft');await page.goto(url,{stealth:false});}}
 else await page.goto(url,{stealth:false});
 await page.focusWindow();await waitFor(page,`!!document.querySelector('.CodeMirror')?.CodeMirror`,'authorized saved draft',45000);
 if(!await page.evaluate(`document.querySelector('.publish-popup')?.__vue__?.active===true`)){await page.evaluate('window.scrollTo(0,0)');await page.click('.publish-popup > button.xitu-btn');}
 await waitFor(page,`document.querySelector('.coverselector_container .preview-image')?.complete&&document.querySelector('.coverselector_container .preview-image')?.naturalWidth>0`,'authorized loaded cover',30000);
}
export function articleOutput(job,file){return [{status:job.status,job_id:job.jobId,title:job.manifest.title,account:job.account?.name||job.review?.account?.name,submitted:job.submitted,draft_id:job.draftId,content_id:job.receipt?.contentId||job.reconciliation?.contentId||null,confirmation:job.review?.token||null,receipt_status:job.receipt?.status||null,query_status:job.lastQuery?.status||null,public_url:job.lastQuery?.publicUrl||null,report:file}];}
export function finalArticleGesture(expected,dryRun=false){
 const vm=document.querySelector('.publish-popup')?.__vue__,root=document.querySelector('.edit-draft')?.__vue__;
 const buttons=[...document.querySelectorAll('.publish-popup .panel button')].filter(e=>e.innerText.trim()==='确定并发布'&&e.getBoundingClientRect().width>0&&!e.disabled);
 const valid=location.origin+location.pathname===expected.url&&root?.$store?.state.auth?.user?.user_id===expected.accountId&&vm?.post?.title===expected.title&&vm?.post?.markdown===expected.body&&vm.active&&buttons.length===1;
 if(dryRun)return {valid:!!valid,buttonCount:buttons.length,panelOpen:!!vm?.active};
 window.__bycliArticleGesture={attemptId:expected.attemptId,phase:valid?'checked':'preflight_failed'};
 if(!valid)throw Error('Authorized publish control changed before dispatch');
 window.__bycliArticleGesture.phase='dispatching';buttons[0].click();window.__bycliArticleGesture.phase='dispatched';return true;
}
export async function articleJobAction(page,args,query){
 const modes=['review','submit','status'].filter(k=>!!args[k]);if(modes.length!==1||args.prepare||args.input||args.resume||args.confirm&&modes[0]!=='submit')throw new ArgumentError('Choose --review JOB, --submit JOB --confirm TOKEN, or --status JOB');
 const mode=modes[0];return withArticleJob(args[mode],async(job,save,file)=>{
  if(mode==='status'){if(job.attempt&&!job.receipt){job.status='result_unknown';await save()}if(job.receipt?.contentId||job.reconciliation?.contentId){job.lastQuery={at:new Date().toISOString(),...await query(page,job)};if(['published','reviewing','rejected','draft'].includes(job.lastQuery.status))job.status=job.lastQuery.status;await save()}return articleOutput(job,file)}
  if(job.attempt)throw new CliError('ALREADY_ATTEMPTED','Already attempted once; query and reconcile, never submit again');
  if(job.status!=='ready_for_confirmation')throw new CliError('JOB_NOT_READY','Prepare and verify the article first');
  await verifyArticleInputs(job);await openArticleEditor(page,job);const live=await inspectArticle(page,job),snapshotHash=hash(JSON.stringify(live));
  if(mode==='review'){job.review={token:randomUUID(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),snapshotHash,account:live.account};job.finalPublishAction='requires_confirmation';await save();return articleOutput(job,file)}
  if(!job.review||args.confirm!==job.review.token)throw new CliError('CONFIRMATION_REQUIRED','Exact current review token required after human authorization');
  if(!Number.isFinite(Date.parse(job.review.expiresAt))||Date.parse(job.review.expiresAt)<=Date.now())throw new CliError('CONFIRMATION_EXPIRED','Review expired');
  if(job.review.snapshotHash!==snapshotHash)throw new CliError('EDITOR_CHANGED','Prepared content or selected settings changed');
  if(typeof page.evaluateOnce!=='function')throw new CliError('ONE_SHOT_UNAVAILABLE','No-retry publishing capability required');
  if(!await page.startNetworkCapture(PUBLISH_PATH))throw new CliError('CAPTURE_UNAVAILABLE','Native receipt capture required');
  if(hash(JSON.stringify(await inspectArticle(page,job)))!==snapshotHash)throw new CliError('EDITOR_CHANGED','Content changed before final action');
  job.attempt={id:randomUUID(),startedAt:new Date().toISOString(),confirmation:job.review.token};job.status='submitting';job.submitted=null;job.finalPublishAction='attempt_recorded';await save();
  try{
   if(typeof page.evaluateOnce!=='function')throw Error('No one-shot browser action');
   const expected={url:'https://juejin.cn/editor/drafts/'+job.draftId,accountId:job.manifest.accountId,title:job.manifest.title,body:preparedArticleBody(job),attemptId:job.attempt.id};
   await page.evaluateOnce(`(${finalArticleGesture.toString()})(${JSON.stringify(expected)})`);
   await page.wait({time:25});const entries=await page.readNetworkCapture(),receipts=entries.map(parseArticleReceipt).filter(Boolean);
   job.receipt=receipts.length===1?{...receipts[0],receivedAt:new Date().toISOString(),endpoint:PUBLISH_PATH}:{status:'result_unknown',reason:receipts.length?'multiple_receipts':'receipt_missing'};
   if(job.receipt.accountId&&job.receipt.accountId!==job.manifest.accountId)job.receipt={status:'result_unknown',reason:'receipt_account_mismatch'};
  }catch(e){job.submissionError={code:e?.code||null,message:String(e?.message||e).replace(/https?:\/\/\S+/g,'[url]').slice(0,300)};try{job.gesture=await page.evaluate('window.__bycliArticleGesture||null')}catch{}}
  job.status=job.receipt?.status||'result_unknown';job.submitted=job.status==='accepted'?true:job.status==='rejected'?false:null;job.finalPublishAction='attempted_once';await save();return articleOutput(job,file);
 });
}
