import fs from 'node:fs/promises';
import path from 'node:path';
import {liveContext} from '../_shared/video-site-submit.js';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {withJob,verifyAssets,digest} from '../_shared/video-submit.js';
import {selectSohuCategory} from './_category.js';
import {clickText} from '../_shared/video-prepare.js';
import {contentSnapshot,assertContentChecks} from './_content-prepare.js';
import {statsAccount} from '../_shared/video-stats.js';

/** Resume only the checkpoint after all uploads, before category/declaration selection.
 * No navigation, upload, or publishing gesture is permitted in this recovery path. */
export async function resumeCategory(page,args,type,adapter,snapshot){
 if(!['video','gallery'].includes(type)||!args.resume||Object.entries(args).some(([k,v])=>['prepare','input','review','submit','confirm','status','save-draft','draft-status','open-draft'].includes(k)&&v))throw new ArgumentError('Use --resume JOB --category JSON alone');
 let category;try{category=JSON.parse(args.category)}catch{throw new ArgumentError('--category requires a JSON array [primary, secondary]')}
 if(!Array.isArray(category)||category.length!==2||category.some(s=>typeof s!=='string'||!s.trim()))throw new ArgumentError('--category requires two nonempty labels');
 return withJob('sohu',args.resume,async(job,save,file)=>{
  if(job.attempt||job.draftSaveAttempt||!['failed','category_required'].includes(job.status)||job.stage!=='selecting_category'||!job.preparationCheckpoint)throw new CliError('RESUME_UNAVAILABLE','Only a retained category-selection checkpoint can be resumed');
  if(!job.pageTarget||!(await page.tabs()).some(t=>t.page===job.pageTarget))throw new CliError('EDITOR_MISSING','Retained editor is missing; no assets reuploaded');
  await verifyAssets(job);page.setActivePage(job.pageTarget);await page.focusWindow();
  const m={...job.manifest,category},checkpoint=job.preparationCheckpoint;
  // Verify the original uploaded identities before changing the local input contract.
  if(type==='gallery'){
   const before=await page.evaluate(`(${contentSnapshot.toString()})('gallery')`);
   const expected={...before,category:m.category,declarations:[m.declaration]};
   assertContentChecks(expected,m,job.assets,type,checkpoint.upload);
   await statsAccount(page,'sohu',checkpoint.account.id);
  }else{
   const before=await page.evaluate(`(${snapshot.toString()})()`);
   if(before.title!==job.manifest.title||before.body!==job.manifest.body||!before.videoUploaded||!before.customCoverPresent)throw new CliError('EDITOR_CHANGED','Prepared video fields or media missing');
   const current=await page.evaluate(`(${liveContext.toString()})('sohu')`);
   if(current.account?.id!==checkpoint.account?.id||digest({upload:current.uploadIdentity,cover:current.cover,video:current.video})!==checkpoint.mediaHash)throw new CliError('MEDIA_OR_ACCOUNT_CHANGED','Prepared video account or uploaded media changed');
  }
  await selectSohuCategory(page,type,category);await clickText(page,m.declaration,'label.el-radio');
  if(type==='gallery'){
   const checks=await page.evaluate(`(${contentSnapshot.toString()})('gallery')`);assertContentChecks(checks,m,job.assets,type,checkpoint.upload);
   job.checks={...checks,upload:checkpoint.upload,account:checkpoint.account};job.preparedAccount=checkpoint.account;
  }
  const updated={...job,manifest:m};const live=await adapter.inspect(page,updated);
  job.manifest=m;job.inputSha256=digest({manifest:m,assets:job.assets});job.preparedAccount=live.account;job.publishBinding=digest({account:live.account,mediaHash:live.mediaHash});
  job.screenshot=path.join(path.dirname(file),'preview.png');await page.screenshot({path:job.screenshot,fullPage:false});await fs.chmod(job.screenshot,0o600);
  job.status='ready_for_confirmation';job.stage='ready';job.finalPublishAction='requires_confirmation';delete job.review;delete job.error;await save();
  return [{status:job.status,job_id:job.jobId,content_type:type,title:m.title,submitted:false,report:file,preview:job.screenshot}];
 },type);
}
