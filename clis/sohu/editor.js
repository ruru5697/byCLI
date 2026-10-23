import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {cli,Strategy} from '@sovovs/bycli/registry';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {withJob} from '../_shared/video-submit.js';
import {openCategory,selectSohuPrimary,categoryState} from './_category.js';

import {editorType} from './_editor.js';
export {editorType} from './_editor.js';
export function editorDiagnostics(type,readCategory){
 const selector=type==='video'?'.channel-select-row .select':type==='gallery'?'.select.plugin-dropdown':null;
 const controls=selector?[...document.querySelectorAll(selector)].slice(0,6).map((e,index)=>{
  const clone=e.cloneNode(true);clone.querySelectorAll('svg,script,style').forEach(n=>n.remove());
  return {index,...readCategory(type,index),html:clone.outerHTML.slice(0,12000)};
 }):[];
 const actions=[...document.querySelectorAll('body *')].filter(e=>!e.children.length&&/^(存草稿|保存草稿|保存到草稿箱|发布|定时发布|取消|保存|退出)$/.test(e.textContent.trim())&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).slice(0,30).map(e=>({label:e.textContent.trim(),tag:e.tagName,className:e.className}));
 return {controls,actions};
}
async function matchingJobs(target){
 const root=path.join(process.env.BYCLI_CONFIG_DIR||path.join(os.homedir(),'.bycli'),'publish-jobs','sohu');
 let entries;try{entries=await fs.readdir(root)}catch(e){if(e.code==='ENOENT')return [];throw e}
 const jobs=[];
 for(const id of entries){
  if(!/^[a-f0-9-]{36}$/i.test(id))continue;
  try{const j=JSON.parse(await fs.readFile(path.join(root,id,'job.json'),'utf8'));if(j.pageTarget===target&&j.jobId===id&&['video','gallery','article'].includes(j.contentType))jobs.push(j)}catch(e){if(e.code!=='ENOENT')throw e}
 }
 return jobs;
}
export async function editorCommand(page,args){
 if(['open','close','primary'].some(k=>args[k]!==undefined&&(typeof args[k]!=='string'||!args[k].trim()||args[k].startsWith('--'))))throw new ArgumentError('Editor page IDs and category labels must be nonempty strings');
 const modes=['open','close','categories','inspect'].filter(k=>!!args[k]);
 if(modes.length>1||args.discard&&!args.close||args.primary&&!args.categories)throw new ArgumentError('Choose list (default), --open PAGE, --close PAGE --discard, or --categories [--primary NAME], or --inspect');
 if(args.close&&!args.discard)throw new ArgumentError('Closing a retained editor requires --discard; this may lose unsaved content');
 const tabs=await page.tabs(),editors=tabs.filter(t=>editorType(t.url));
 if(!modes.length){const rows=[];for(const t of editors){const jobs=await matchingJobs(t.page);const j=jobs.sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')))[0];rows.push({page:t.page,content_type:editorType(t.url),status:'editor_retained',...(j?{job_id:j.jobId,job_status:j.status,remote_draft_id:j.remoteDraftId||null}:{})});}return rows;}
 const mode=modes[0],target=['categories','inspect'].includes(mode)?editors.length===1?editors[0]:null:editors.find(t=>t.page===args[mode]);
 if(!target){if(mode==='close'&&!tabs.some(t=>t.page===args.close)){
   await updateClosedJobs(args.close,async()=>{});return [{page:args.close,status:'already_closed'}];
  }throw new CliError('EDITOR_NOT_FOUND','Select an exact retained editor in the current Sohu adapter session');}
 page.setActivePage(target.page);
 if(mode==='inspect')return [{page:target.page,content_type:editorType(target.url),status:'editor_diagnostics',...await page.evaluate(`(${editorDiagnostics.toString()})(${JSON.stringify(editorType(target.url))},${categoryState.toString()})`)}];
 if(mode==='open'){await page.focusWindow();return [{page:target.page,content_type:editorType(target.url),status:'editor_retained'}]}
 if(mode==='categories'){
  const type=editorType(target.url);if(type==='article')throw new CliError('CATEGORY_UNAVAILABLE','Article preparation has no channel category field');
  const primary=await openCategory(page,type,0);
  if(!args.primary){await page.click(primary.scope+' .select-main');return primary.options.map(label=>({content_type:type,level:'primary',label}));}
  // Close the opened primary before using the normal verified selection flow.
  await page.click(primary.scope+' .select-main');
  await selectSohuPrimary(page,type,args.primary);
  const secondary=await openCategory(page,type,1);await page.click(secondary.scope+' .select-main');
  return secondary.options.map(label=>({content_type:type,level:'secondary',primary:args.primary,label}));
 }
 await updateClosedJobs(target.page,async()=>{
  // Recheck the owned tab identity immediately before the destructive local gesture.
  const current=(await page.tabs()).find(t=>t.page===target.page);
  if(!current||current.url!==target.url)throw new CliError('EDITOR_CHANGED','Editor changed before close; inspect it again');
  await page.closeTab(target.page);
  if((await page.tabs()).some(t=>t.page===target.page))throw new CliError('EDITOR_CLOSE_FAILED','Editor is still present; no success recorded');
  page.setActivePage(undefined);
 });
 return [{page:target.page,status:'editor_closed',discarded:true}];
}
async function updateClosedJobs(target,close){
 const jobs=await matchingJobs(target);
 async function locked(i){
  if(i===jobs.length)return close();
  const expected=jobs[i];
  return withJob('sohu',expected.jobId,async(job,save)=>{
   if(job.pageTarget!==target)throw new CliError('EDITOR_CHANGED','Job editor binding changed');
   await locked(i+1);
   job.editorClosedAt=new Date().toISOString();job.pageTarget=null;delete job.review;
   if(!job.attempt&&job.status!=='draft_saved')job.status=job.draftSaveAttempt?'draft_save_unknown':'editor_closed';
   await save();
  },expected.contentType);
 }
 await locked(0);
}
export const command=cli({site:'sohu',name:'editor',access:'write',description:'列出、打开或明确放弃并关闭搜狐适配器编辑器；读取当前形态分类',domain:'mp.sohu.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,siteSession:'persistent',args:[{name:'open',valueRequired:true,help:'Exact retained editor page ID'},{name:'close',valueRequired:true,help:'Exact editor page ID to discard and close'},{name:'discard',type:'bool',default:false},{name:'inspect',type:'bool',default:false,help:'Read current category controls and draft/publish control labels without clicking or changing the editor'},{name:'categories',type:'bool',default:false},{name:'primary',valueRequired:true,help:'Select a primary category and list its secondary options'}],columns:['status','job_id','job_status','remote_draft_id','page','content_type','level','primary','label','discarded','controls','actions'],func:editorCommand});
