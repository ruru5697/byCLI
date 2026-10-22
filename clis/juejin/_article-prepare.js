import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {imageDimensions} from '../_shared/image-prepare.js';
import {waitFor,clickText,fillVerified} from '../_shared/video-prepare.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const NEW_ARTICLE='https://juejin.cn/editor/drafts/new?v=2';
export const CATEGORIES=['后端','前端','Android','iOS','人工智能','开发工具','代码人生','阅读'];
export function validateArticleManifest(v){
 if(!v||typeof v!=='object'||Array.isArray(v))throw new ArgumentError('Expected article JSON object');
 const allowed=['title','body','cover','summary','category','tags','columns','topics','visibility','accountId'];
 for(const k of Object.keys(v))if(!allowed.includes(k))throw new ArgumentError(`Unsupported manifest field: ${k}`);
 for(const [k,min,max]of [['title',1,100],['body',1,100000],['summary',50,100]])if(typeof v[k]!=='string'||v[k].trim().length<min||v[k].length>max||/\r/.test(v[k])||(k!=='body'&&/\n/.test(v[k])))throw new ArgumentError(`${k} requires ${min}–${max} character units; use LF in body only`);
 if(typeof v.cover!=='string'||!v.cover.trim())throw new ArgumentError('Local PNG/JPEG cover required');
 if(!CATEGORIES.includes(v.category))throw new ArgumentError('Unsupported category');
 // Current account's real panel permits one tag. More tags need separate validation.
 if(!Array.isArray(v.tags)||v.tags.length!==1||typeof v.tags[0]!=='string'||!v.tags[0].trim()||v.tags[0].length>30)throw new ArgumentError('Exactly one explicit tag is supported');
 if(!Array.isArray(v.columns)||v.columns.length||!Array.isArray(v.topics)||v.topics.length||v.visibility!=='public')throw new ArgumentError('Explicit empty columns/topics and public visibility required');
 if(typeof v.accountId!=='string'||!/^\d{1,30}$/.test(v.accountId))throw new ArgumentError('Expected public accountId required');
 // Remote inline media requires a separate upload/verification workflow.
 if(/!\[|<\s*(?:img|iframe|video|script)\b/i.test(v.body))throw new ArgumentError('Inline media/active HTML is unsupported; use Markdown text, code, lists and tables');
 return structuredClone(v);
}
export async function readArticleManifest(input){
 let value;try{value=JSON.parse(await fs.readFile(input,'utf8'))}catch{throw new ArgumentError('Cannot read article manifest')}
 const manifest=validateArticleManifest(value),file=path.resolve(path.dirname(path.resolve(input)),manifest.cover);
 let data,stat;try{stat=await fs.stat(file);data=await fs.readFile(file)}catch{throw new ArgumentError('Cannot read cover')}
 if(!stat.isFile()||!stat.size||stat.size>=5*1024**2||!/\.(png|jpe?g)$/i.test(file))throw new ArgumentError('Cover must be PNG/JPEG smaller than 5 MiB');
 const dims=imageDimensions(data,path.extname(file).toLowerCase());
 if(dims.width<192||dims.height<128||dims.width*2!==dims.height*3)throw new ArgumentError('Cover must be at least 192×128 with exact 3:2 aspect ratio');
 manifest.cover=file;
 return {manifest,assets:{cover:{path:file,bytes:stat.size,sha256:hash(data),...dims}}};
}
export function coverResourceKey(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||!/(^|\.)(?:juejin\.cn|byteimg\.com)$/.test(u.hostname))return null;
 const match=u.pathname.match(/\/(tos-[^/]+)\/([a-f0-9]{32})(?:[~/.]|$)/i);return match?match[1]+'/'+match[2]:null;}catch{return null;}
}
export const snapshotScript=()=>`(${articleSnapshot.toString()})(${coverResourceKey.toString()})`;
/** Return whitelisted fields only. Signed image URLs never leave the page. */
export async function articleSnapshot(resourceKey){
 const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const root=document.querySelector('.edit-draft')?.__vue__,panel=document.querySelector('.publish-popup'),popup=panel?.__vue__,post=popup?.post;
 const user=root?.$store?.state.auth?.user;
 const text=document.querySelector('.CodeMirror')?.CodeMirror?.getValue();
 const cover=document.querySelector('.coverselector_container .preview-image');
 const image=cover?.matches('img')?cover:cover?.querySelector('img');
 const final=[...panel?.querySelectorAll('button')||[]].filter(e=>e.innerText.trim()==='确定并发布');
 const tagInputs=[...panel?.querySelectorAll('.tag-input')||[]];
 const preview=document.querySelector('.bytemd-preview');
 return {url:location.origin+location.pathname,draftId:/^\/editor\/drafts\/(\d+)$/.exec(location.pathname)?.[1]||null,account:{id:user?.user_id||null,name:user?.user_name||null},title:document.querySelector('input.title-input')?.value,body:text,bodySha256:typeof text==='string'?await digest(text):null,
  modelMatches:post?.markdown===text&&post?.title===document.querySelector('input.title-input')?.value,
  category:post?.category?.title||post?.category?.name||null,categoryId:post?.category?.id||null,categorySelected:[...panel?.querySelectorAll('.category-list .item.active')||[]].map(e=>e.innerText.trim()),
  tags:(post?.tags||[]).map(t=>({id:t.id,title:t.title})),tagLimit:popup?.tagLimit,
  summary:panel?.querySelector('.summary-textarea textarea')?.value,modelSummary:post?.brief_content,
  columns:(post?.columns||[]).map(c=>typeof c==='string'?c:c.id),topics:(tagInputs[1]?.__vue__?.value||[]).map(t=>typeof t==='string'?t:t.id),topicState:root?.$store?.state.topic?.theme_ids||[],
  syncToOrg:popup?.sync_to_org,cover:{present:!!post?.cover_image,hash:post?.cover_image&&resourceKey(post.cover_image)?await digest(resourceKey(post.cover_image)):null,visible:!!cover&&cover.getBoundingClientRect().width>0,loaded:!!image&&image.complete&&image.naturalWidth>0,matchesModel:!!image&&image.getAttribute('src')===post?.cover_image,width:image?.naturalWidth||0,height:image?.naturalHeight||0,updating:!!document.querySelector('.coverselector_container')?.__vue__?.updating},
  panelOpen:popup?.active===true,finalControlPresent:final.length===1,finalControlDisabled:final.some(e=>e.disabled),status:root?.status,saveText:document.querySelector('.status-text')?.innerText,
  rendering:{headings:preview?.querySelectorAll('h1,h2,h3').length||0,tables:preview?.querySelectorAll('table').length||0,codeBlocks:preview?.querySelectorAll('pre').length||0},finalPublishClicked:false};
}
export function assertArticleChecks(s,m,a,binding){
 if(s.account?.id!==m.accountId)throw new CliError('ACCOUNT_MISMATCH','Logged-in account differs from expected public ID');
 if(!s.draftId||s.url!==`https://juejin.cn/editor/drafts/${s.draftId}`||s.title!==m.title||s.body!==m.body||s.bodySha256!==hash(m.body)||!s.modelMatches)throw new CliError('FIELD_MISMATCH','Draft identity, title or Markdown differs');
 if(s.category!==m.category||s.categorySelected.length!==1||s.categorySelected[0]!==m.category||s.tags.length!==1||s.tags[0].title!==m.tags[0]||(typeof s.tags[0].id!=='string'||!/^\d+$/.test(s.tags[0].id))||s.summary!==m.summary||s.modelSummary!==m.summary)throw new CliError('SETTINGS_MISMATCH','Category, tag or summary differs');
 if(s.columns.length||s.topics.length||s.topicState.length||s.syncToOrg!==false)throw new CliError('SETTINGS_MISMATCH','Unexpected column, topic or organization synchronization');
 if(!s.cover.present||!s.cover.visible||!s.cover.loaded||!s.cover.matchesModel||s.cover.width!==a.cover.width||s.cover.height!==a.cover.height||s.cover.updating||s.cover.hash!==binding.hash||binding.sha256!==a.cover.sha256||binding.bytes!==a.cover.bytes)throw new CliError('COVER_MISMATCH','Cover upload or applied binding differs');
 if(!s.panelOpen||!s.finalControlPresent||s.finalControlDisabled||s.status!=='editing')throw new CliError('EDITOR_NOT_READY','Publish panel or saved draft is not ready');
}
export async function checkBlankEditor(page){
 const state=await page.evaluate(String.raw`(()=>{const root=document.querySelector('.edit-draft')?.__vue__;return {url:location.origin+location.pathname,title:document.querySelector('.title-input')?.value,body:document.querySelector('.CodeMirror')?.CodeMirror?.getValue(),cover:!!root?.draft?.cover_image}})()`);
 if(state.url!=='https://juejin.cn/editor/drafts/new'||state.title!==''||state.body!==''||state.cover)throw new CliError('EXISTING_EDITOR','Retain current page: only a blank new draft may be filled');
}
export async function prepareArticleEditor(page,m,a,stage,resumeDraftId=null,resumeManifest=m){
 const tabs=await page.tabs();
 if(resumeDraftId){
  if(!tabs.length)throw new CliError('RESUME_MISMATCH','Open the retained draft before resuming');
  page.setActivePage(tabs[0].page);
  const s=await page.evaluate(snapshotScript());
  if(s.draftId!==resumeDraftId||s.title!==resumeManifest.title||s.body!==resumeManifest.body||s.account.id!==m.accountId)throw new CliError('RESUME_MISMATCH','Retained draft identity or content differs');
 }else if(tabs.length){page.setActivePage(tabs[0].page);const state=await page.evaluate('location.origin+location.pathname');if(state==='https://juejin.cn/editor/drafts/new')await checkBlankEditor(page);else if(!['https://juejin.cn/','https://juejin.cn/creator/content/article'].includes(state)&&await page.evaluate('location.href')!=='about:blank')throw new CliError('EXISTING_EDITOR','Retain existing page; close or finish it before preparing another draft');else await page.goto(NEW_ARTICLE,{stealth:false});}
 else await page.goto(NEW_ARTICLE,{stealth:false});
 await stage('opening_editor');await page.focusWindow();
 await waitFor(page,`!!document.querySelector('.CodeMirror')?.CodeMirror&&!!document.querySelector('.edit-draft')?.__vue__?.$store?.state.auth?.user?.user_id`,'authenticated Markdown editor',45000);
 if(!resumeDraftId)await checkBlankEditor(page);
 const before=await page.evaluate(snapshotScript());
 if(before.account.id!==m.accountId)throw new CliError('ACCOUNT_MISMATCH','Logged-in account differs');
 await stage('filling_content');
 await fillVerified(page,'input.title-input',m.title);
 await page.evaluate(`document.querySelector('.CodeMirror').CodeMirror.setValue(${JSON.stringify(m.body)})`);
 await waitFor(page,`document.querySelector('.CodeMirror').CodeMirror.getValue()===${JSON.stringify(m.body)}`,'exact Markdown');
 if(!await page.evaluate(`document.querySelector('.publish-popup')?.__vue__?.active===true`))await page.click('.publish-popup > button.xitu-btn');
 await waitFor(page,`document.querySelector('.publish-popup')?.__vue__?.active===true`,'publish settings panel');
 await clickText(page,m.category,'.category-list');
 await page.evaluate(`document.querySelectorAll('.publish-popup .tag-input')[0].setAttribute('data-bycli-tags','true')`);
 const currentTags=await page.evaluate(`document.querySelector('.publish-popup').__vue__.post.tags.map(t=>t.title)`);
 if(currentTags.length&&JSON.stringify(currentTags)!==JSON.stringify(m.tags))throw new CliError('SETTINGS_MISMATCH','Retained tags differ');
 if(!currentTags.length){
 await page.click('[data-bycli-tags] input');
 await fillVerified(page,'[data-bycli-tags] input',m.tags[0]);
 await waitFor(page,`[...document.querySelectorAll('.byte-select-dropdown li')].some(e=>e.getBoundingClientRect().width>0&&e.innerText.trim()===${JSON.stringify(m.tags[0])})`,'exact matching tag',20000);
 await clickText(page,m.tags[0],'.byte-select-dropdown');
 }
 await fillVerified(page,'.summary-textarea textarea',m.summary);
 await stage('uploading_cover');
 // Capture File before the website clears the input. Raw file and upload URL stay in-page.
 await page.evaluate(String.raw`(()=>{window.__bycliJuejinCover=null;document.querySelector('.coverselector_container input[type=file]').addEventListener('change',event=>{const f=event.target.files[0];window.__bycliJuejinCover={pending:true};if(f)f.arrayBuffer().then(async b=>{window.__bycliJuejinCover={bytes:f.size,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('')}})},{capture:true,once:true})})()`);
 const previousSave=await page.evaluate(`document.querySelector('.status-text').__vue__.lastSaveTime`);
 await page.setFileInput([m.cover],'.coverselector_container input[type=file]');
 await waitFor(page,`!!document.querySelector('.publish-popup').__vue__.post.cover_image&&!document.querySelector('.coverselector_container').__vue__.updating&&!!window.__bycliJuejinCover?.sha256`,'applied cover',90000);
 await waitFor(page,`document.querySelector('.coverselector_container .preview-image')?.complete&&document.querySelector('.coverselector_container .preview-image')?.naturalWidth>0`,'loaded cover preview',45000);
 await waitFor(page,`document.querySelector('.status-text').__vue__.lastSaveTime!==${JSON.stringify(previousSave)}`,'cover autosave acknowledgement',30000);
 await waitFor(page,`/^\\/editor\\/drafts\\/\\d+$/.test(location.pathname)&&document.querySelector('.edit-draft').__vue__.status==='editing'`,'saved remote draft',45000);
 await page.wait({time:2});
 await waitFor(page,`document.querySelector('.edit-draft').__vue__.status==='editing'`,'settled autosave',30000);
 let checks=await page.evaluate(snapshotScript());
 const selected=await page.evaluate('window.__bycliJuejinCover');
 const binding={...selected,hash:checks.cover.hash};
 assertArticleChecks(checks,m,a,binding);
 await stage('checking_persistence',{preCloseChecks:checks,upload:binding});
 // Closing and reopening the owned tab verifies server persistence, not same-page memory.
 const draftUrl=checks.url,t=await page.tabs();await page.closeTab(t[0].page);
 await page.goto(draftUrl,{stealth:false});
 await waitFor(page,`!!document.querySelector('.CodeMirror')?.CodeMirror`,'reopened draft',45000);
 await page.click('.publish-popup > button.xitu-btn');
 await waitFor(page,`document.querySelector('.publish-popup')?.__vue__?.active===true&&document.querySelector('.edit-draft')?.__vue__?.status==='editing'`,'reopened settings',30000);
 await waitFor(page,`document.querySelector('.coverselector_container .preview-image')?.complete&&document.querySelector('.coverselector_container .preview-image')?.naturalWidth>0`,'reopened cover preview',45000);
 checks=await page.evaluate(snapshotScript());
 assertArticleChecks(checks,m,a,binding);
 return {account:checks.account,draftId:checks.draftId,draftUrl,checks,upload:binding,persistence:'verified_after_close_and_reopen'};
}
export async function prepareArticle(page,args){
 if(args.prepare!==true||!args.input)throw new ArgumentError('Use --prepare --input manifest.json; final submission is not implemented in this command');
 const {manifest,assets}=await readArticleManifest(args.input);
 if(args.resume&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.resume))throw new ArgumentError('Invalid resume job ID');
 const jobId=args.resume||randomUUID(),dir=path.join(process.env.BYCLI_CONFIG_DIR||path.join(os.homedir(),'.bycli'),'publish-jobs','juejin',jobId);
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const report=path.join(dir,'job.json'),preview=path.join(dir,'preview.png');
 let lock;try{lock=await fs.open(report+'.lock','wx',0o600)}catch(e){if(e.code==='EEXIST')throw new CliError('JOB_BUSY','Preparation job is locked; inspect an interrupted process before removing the lock');throw e}
 try{
 let resumeManifest=manifest;
 let job={schemaVersion:1,jobId,platform:'juejin',contentType:'article',status:'preparing',stage:'validated',createdAt:new Date().toISOString(),submitted:false,finalPublishAction:'requires_confirmation',manifest,assets,inputSha256:hash(JSON.stringify(manifest)),report,sideEffects:['remote draft autosave','cover upload'],screenshot:preview};
 if(args.resume){
  const old=JSON.parse(await fs.readFile(report,'utf8'));
  if(old.jobId!==jobId||old.platform!=='juejin'||old.contentType!=='article'||old.status!=='failed'||old.attempt||old.submitted!==false||typeof old.draftId!=='string'||!/^\d+$/.test(old.draftId)||old.manifest.accountId!==manifest.accountId)throw new CliError('RESUME_MISMATCH','Only a failed preparation with a recorded draft and matching account may resume');
  resumeManifest=old.recoveryManifest||old.manifest;
  job={...old,status:'preparing',manifest,assets,inputSha256:job.inputSha256,resumedAt:new Date().toISOString(),recoveryManifest:resumeManifest,revisions:[...(old.revisions||[]),{at:new Date().toISOString(),previousInputSha256:old.inputSha256,inputSha256:job.inputSha256}]};delete job.error;
 }
 const save=async()=>{await fs.writeFile(report+'.tmp',JSON.stringify(job,null,2),{mode:0o600});await fs.rename(report+'.tmp',report)};
 await save();
 try{
  Object.assign(job,await prepareArticleEditor(page,manifest,assets,async (s,details)=>{job.stage=s;if(details)Object.assign(job,details);await save()},args.resume?job.draftId:null,resumeManifest));
  const reread=await readArticleManifest(args.input);
  if(hash(JSON.stringify(reread.manifest))!==job.inputSha256||reread.assets.cover.sha256!==assets.cover.sha256)throw new CliError('ASSET_CHANGED','Manifest or cover changed during preparation');
  await page.screenshot({path:preview,fullPage:false});await fs.chmod(preview,0o600);
  delete job.recoveryManifest;job.status='ready_for_confirmation';job.stage='ready';job.verifiedAt=new Date().toISOString();await save();
 }catch(error){
  try{const s=await page.evaluate(snapshotScript());if(['filling_content','uploading_cover','checking_persistence'].includes(job.stage)&&(!args.resume||s.draftId===job.draftId)&&s.title===manifest.title&&s.body===manifest.body&&s.account.id===manifest.accountId&&s.draftId){job.draftId=s.draftId;job.draftUrl=s.url;job.recoveryManifest=manifest;}}catch{}
  job.status='failed';job.failureHistory=[...(job.failureHistory||[]),{at:new Date().toISOString(),stage:job.stage,code:error?.code||'PREPARATION_FAILED'}];job.error={code:error?.code||'PREPARATION_FAILED',message:'Preparation did not pass; retain browser page for inspection'};await save();throw new CliError(job.error.code,`Article preparation stopped; inspect retained page and ${report}`)}
 return [{status:job.status,job_id:jobId,title:manifest.title,account:job.account.name,draft_id:job.draftId,draft_url:job.draftUrl,submitted:false,report,preview}];
 }finally{await lock.close();await fs.rm(report+'.lock',{force:true})}
}
