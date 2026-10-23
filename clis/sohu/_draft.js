import {CliError,ArgumentError} from '@sovovs/bycli/errors';
import {withJob,verifyAssets,managers} from '../_shared/video-submit.js';
import {startReadCapture} from '../_shared/read-response-capture.js';
import {waitFor} from '../_shared/video-prepare.js';
import {statsAccount} from '../_shared/video-stats.js';
import {contentUrl} from './_content-prepare.js';

const validId=id=>typeof id==='string'&&/^[1-9]\d{0,24}$/.test(id);
/** A successful save response supplies identity only. Owner draft record + reopened
 * content are still mandatory. Never interpret a publish response as a draft save. */
export function draftReceipt(entry){
 let u,b;try{u=new URL(entry.url);b=JSON.parse(entry.responsePreview)}catch{return null}
 if(u.origin!=='https://mp.sohu.com'||!/^\/mpbp\/bp\/news\//.test(u.pathname)||!/save|draft/i.test(u.pathname)||/publish/i.test(u.pathname)||entry.method!=='POST'||entry.responseStatus!==200||entry.responseBodyTruncated||b.code!==2000000||b.success!==true)return null;
 const value=typeof b.data==='object'&&b.data?(b.data.draftId??b.data.newsId??b.data.id):b.data;
 // JSON numbers beyond the safe integer range cannot identify an exact draft.
 if(typeof value==='number'&&!Number.isSafeInteger(value))return null;
 const id=String(value??'');return /^[1-9]\d{0,24}$/.test(id)?{draftId:id}:null;
}
export function saveControl(expected){
 const u=new URL(location.href),account=document.querySelector('#app')?.__vue__?.$store?.state?.app?.userInfo;
 if(u.origin+u.pathname!==expected.url||String(account?.id)!==expected.account||document.querySelector('input[placeholder="请输入标题（5-72字）"]')?.value!==expected.title||expected.draftId&&u.searchParams.get('id')!==expected.draftId)throw Error('Draft editor identity changed');
 const nodes=[...document.querySelectorAll('.bottom-button li')].filter(e=>e.innerText.trim()==='存草稿'&&e.getBoundingClientRect().width>0);
 if(nodes.length!==1||nodes[0].matches('.disabled,.disable-button,[disabled]'))throw Error('Draft save control unavailable');
 const e=nodes[0];e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
 const hit=document.elementFromPoint(x,y);
 if(!hit||!(hit===e||e.contains(hit))||x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('Draft save control is obscured');
 return {x,y,draftId:u.searchParams.get('id')};
}
async function ownerDraft(page,job,id){
 await waitFor(page,`document.querySelectorAll('.content-item').length>0||document.body.innerText.includes('这里空空如也')`,'owner draft records',30000);
 await statsAccount(page,'sohu',job.preparedAccount.id);
 const record=await waitFor(page,`(()=>{const rows=[...document.querySelectorAll('.content-item')];const records=rows.map(row=>{const r=[row,...row.querySelectorAll('*')].find(e=>e.__vue__?._props?.article)?.__vue__._props.article;return r?{id:String(r.id??r.newsId??''),type:r.type,status:r.status}:null}).filter(Boolean);return records.find(r=>r.id===${JSON.stringify(id)})||null})()`, 'exact owner draft record', 30000);
 if(!record||record.type!==(job.contentType==='gallery'?3:2)||record.status!==1)throw new CliError('DRAFT_UNVERIFIED','Exact owner draft ID/type/status not found in loaded manager records');
 return record;
}
async function reopen(page,job,id,adapter){
 await page.goto(contentUrl(job.contentType)+'?id='+id,{stealth:false});
 await waitFor(page,`document.querySelector('input[placeholder="请输入标题（5-72字）"]')?.value===${JSON.stringify(job.manifest.title)}`,'reopened saved draft',30000);
 // Restored editors can finish image loading after their title is rendered.
 await waitFor(page,`document.querySelectorAll(${JSON.stringify(job.contentType==='gallery'?'.pic-info .pic-item':'.ql-editor img')}).length===${job.assets.images.length}`,'reopened draft images',30000);
 if(job.contentType==='article')await waitFor(page,`[...document.querySelectorAll('.ql-editor img')].every(e=>e.complete&&e.naturalWidth>0)`,'loaded saved article images',30000);
 const live=await adapter.inspect(page,{...job,remoteDraftId:id,draftVerification:true});
 if(live.draftId!==id||live.account.id!==job.preparedAccount.id)throw new CliError('DRAFT_UNVERIFIED','Reopened draft identity changed');
 job.pageTarget=page.getActivePage?.()??null;delete job.editorClosedAt;
 return live;
}
export async function draftAction(page,args,type,adapter){
 const modes=['saveDraft','draftStatus','openDraft'].filter(k=>!!args[k]);
 if(modes.length!==1||['prepare','input','review','submit','confirm','status'].some(k=>args[k]))throw new ArgumentError('Choose --save-draft JOB, --draft-status JOB, or --open-draft JOB alone');
 const mode=modes[0];
 return withJob('sohu',args[mode],async(job,save,file)=>{
  if(job.attempt)throw new CliError('ALREADY_ATTEMPTED','Published/submitted jobs cannot be saved as drafts');
  await verifyAssets(job);
  if(mode==='draftStatus'&&job.status==='draft_saved')return [{status:job.status,job_id:job.jobId,remote_draft_id:job.remoteDraftId,content_type:type,submitted:false,report:file}];
  if(mode==='openDraft'){
   if(job.status!=='draft_saved'||!validId(job.remoteDraftId))throw new CliError('DRAFT_UNVERIFIED','Only a verified saved draft can be reopened');
   const tabs=await page.tabs();
   if(tabs.some(t=>/\/news\/add(?:article|atlas|video)(?:\?|$)/.test(t.url)))throw new CliError('EDITOR_IN_USE','Retain the other editor; use bycli sohu editor to inspect or close it');
   if(tabs.some(t=>{try{const u=new URL(t.url);return t.url!=='about:blank'&&!(u.origin==='https://mp.sohu.com'&&['/mpfe/v4/contentManagement/first/page','/mpfe/v4/data/analysis'].includes(u.pathname))}catch{return true}}))throw new CliError('EXISTING_PAGE','Retain the current owned page before reopening a saved draft');
   let live;try{live=await reopen(page,job,job.remoteDraftId,adapter)}catch(e){job.pageTarget=page.getActivePage?.()??job.pageTarget;await save();throw e}job.draftVerifiedAt=new Date().toISOString();delete job.review;await save();
   return [{status:job.status,job_id:job.jobId,remote_draft_id:job.remoteDraftId,content_type:type,submitted:false,account:live.account.name,report:file}];
  }
  if(mode==='saveDraft'&&job.status==='draft_saved'&&validId(job.remoteDraftId)){
   const tabs=await page.tabs();if(job.pageTarget&&tabs.some(t=>t.page===job.pageTarget)){page.setActivePage(job.pageTarget);await adapter.inspect(page,{...job,draftVerification:true});}
   return [{status:job.status,job_id:job.jobId,remote_draft_id:job.remoteDraftId,content_type:type,submitted:false,report:file,recovery:'--open-draft'}];
  }
  if(mode==='saveDraft'&&job.draftSaveAttempt)throw new CliError('DRAFT_SAVE_ALREADY_ATTEMPTED','Save already dispatched; use --draft-status to reconcile, or --open-draft for a verified saved draft');
  if(mode==='saveDraft'){
   if(job.status!=='ready_for_confirmation')throw new CliError('JOB_NOT_READY','Prepare and verify content before saving a draft');
   const tabs=await page.tabs();if(!job.pageTarget||!tabs.some(t=>t.page===job.pageTarget))throw new CliError('EDITOR_MISSING','Prepared editor is missing');
   page.setActivePage(job.pageTarget);await page.focusWindow();
   const live=await adapter.inspect(page,job);
   if(live.account.id!==job.preparedAccount.id)throw new CliError('ACCOUNT_CHANGED','Prepared account differs');
   if(typeof page.nativeClickOnce!=='function')throw new CliError('ONE_SHOT_UNAVAILABLE','Draft save requires no-retry native mouse input');
   await startReadCapture(page,'/mpbp/bp/news/');
   const expected={url:contentUrl(type),account:job.preparedAccount.id,title:job.manifest.title,draftId:live.draftId||null};
   const point=await page.evaluate(`(${saveControl.toString()})(${JSON.stringify(expected)})`);
   // Bind the final content snapshot after scrolling/observer setup, before any press.
   const after=await adapter.inspect(page,job);
   if(JSON.stringify(live)!==JSON.stringify(after))throw new CliError('EDITOR_CHANGED','Content changed before draft save');
   job.draftSaveAttempt={startedAt:new Date().toISOString(),candidateId:point.draftId||null,contentBinding:{mediaHash:live.mediaHash,settingsHash:live.settingsHash}};
   job.status='draft_saving';delete job.review;await save();
   try{await page.nativeClickOnce(point.x,point.y)}catch{job.draftSaveAttempt.gestureUncertain=true;}
  }else{
   if(!job.draftSaveAttempt)throw new CliError('DRAFT_UNVERIFIED','No draft save attempt to reconcile');
   if(job.pageTarget&&(await page.tabs()).some(t=>t.page===job.pageTarget))page.setActivePage(job.pageTarget);
   else throw new CliError('EDITOR_MISSING','Save result page is missing; retain the unknown attempt');
  }
  // Observe without replaying the save gesture. A lost response never means failure.
  let state;const deadline=Date.now()+15000;
  try{do{
   state=await page.evaluate(`(()=>({url:location.origin+location.pathname,draftId:new URL(location.href).searchParams.get('id'),ids:[...new Set((window.__bycliReadCapture?.entries||[]).map(${draftReceipt.toString()}).filter(Boolean).map(r=>r.draftId))]}))()`);
   const ids=state.ids||[];
   if(ids.length===1){if(job.draftSaveAttempt.candidateId&&job.draftSaveAttempt.candidateId!==ids[0])job.draftSaveAttempt.identityConflict=true;else{job.draftSaveAttempt.candidateId=ids[0];job.draftSaveAttempt.acknowledged=true}}
   if(ids.length>1){job.draftSaveAttempt.identityConflict=true;break}
   if(validId(state.draftId)&&!job.draftSaveAttempt.candidateId)job.draftSaveAttempt.candidateId=state.draftId;
   if(state.url===managers.sohu||job.draftSaveAttempt.acknowledged)break;
   await page.wait({time:0.5});
  }while(Date.now()<deadline);}catch{job.draftSaveAttempt.observationUncertain=true;}
  const id=job.draftSaveAttempt.candidateId;
  job.status='draft_save_unknown';await save();
  try{
   if(!validId(id)||job.draftSaveAttempt.identityConflict||state?.url!==managers.sohu&&!job.draftSaveAttempt.acknowledged)throw new CliError('DRAFT_UNVERIFIED','No confirmed save and exact draft identity; editor retained');
   if(state.url!==managers.sohu){
    // Reconciliation must not discard edits made after the save gesture.
    if(state.url!==contentUrl(type))throw new CliError('DRAFT_UNVERIFIED','Save result is not a known editor or manager');
    const current=await adapter.inspect(page,{...job,remoteDraftId:null,draftVerification:true});
    if(current.account.id!==job.preparedAccount.id||current.mediaHash!==job.draftSaveAttempt.contentBinding?.mediaHash||current.settingsHash!==job.draftSaveAttempt.contentBinding?.settingsHash)throw new CliError('EDITOR_CHANGED','Retain edits made after draft save; no navigation performed');
    await page.goto(managers.sohu,{stealth:false});
   }
   await ownerDraft(page,job,id);
   await reopen(page,job,id,adapter);
   job.remoteDraftId=id;job.status='draft_saved';job.editorPersistence='verified_remote_draft';job.draftVerifiedAt=new Date().toISOString();delete job.draftSaveError;await save();
  }catch(error){job.pageTarget=page.getActivePage?.()??job.pageTarget;job.draftSaveError={code:error.code||'DRAFT_UNVERIFIED'};await save();}
  return [{status:job.status,job_id:job.jobId,remote_draft_id:job.remoteDraftId||null,content_type:type,submitted:false,report:file,recovery:job.status==='draft_saved'?'--open-draft':'--draft-status'}];
 },type);
}
