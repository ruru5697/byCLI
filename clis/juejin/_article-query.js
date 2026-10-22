import {ArgumentError,CliError} from '@sovovs/bycli/errors';import {waitFor} from '../_shared/video-prepare.js';
export const ARTICLE_MANAGER='https://juejin.cn/creator/content/article/essays';
export async function openArticleReadPage(page,url){
 const ts=await page.tabs();if(ts.length){page.setActivePage(ts[0].page);const active=await page.evaluate('location.href');let u;try{u=new URL(active)}catch{}
 if(u?.origin==='https://juejin.cn'&&u.pathname.startsWith('/editor/'))throw new CliError('EDITOR_IN_USE','Retain current editor before querying article status or data');
 if(active!=='about:blank'&&!(u?.origin==='https://juejin.cn'&&(/^\/(published|post\/\d+|creator\/home|creator\/content\/article\/essays|creator\/data\/content\/article\/[^/]+|notification\/system)\/?$/.test(u.pathname))))throw new CliError('PAGE_IN_USE','Retain unknown owned page before article query');
 }await page.goto(url,{stealth:false});await page.focusWindow();
}
export async function ownerAccount(page,expected){
 const a=await page.evaluate(`(()=>{const u=document.querySelector('#__nuxt')?.__vue__?.$store?.state.auth?.user;return {id:u?.user_id||null,name:u?.user_name||null}})()`);
 if(!a?.id||a.id!==expected)throw new CliError('ACCOUNT_MISMATCH','Current owner account differs from the expected public ID');return a;
}
/** Owner model and its visible row are read together; no signed media or author profile leaves the page. */
export function ownerArticleSnapshot(){
 return [...document.querySelectorAll('.essays-container a.link')].map(e=>{let v=e.__vue__,r;for(let n=0;v&&n<5;n++,v=v.$parent){if(v.$props?.data?.article_info){r=v.$props.data;break}}const i=r?.article_info;return {id:r?.article_id,accountId:i?.user_id,draftId:i?.draft_id,title:i?.title,status:i?.status,auditStatus:i?.audit_status,visibleLevel:i?.visible_level,url:e.origin+e.pathname,text:e.innerText,metrics:{impressions:i?.display_count,reads:i?.view_count,likes:i?.digg_count,comments:i?.comment_count,favorites:i?.collect_count}}});
}
export function selectOwnerArticle(records,id,accountId,draftId){
 if(typeof id!=='string'||! /^[1-9]\d{0,29}$/.test(id)||typeof accountId!=='string'||!/^\d+$/.test(accountId))throw new ArgumentError('Exact article ID and public owner ID required');
 if(records.some(r=>typeof r.id!=='string'))throw new CliError('DOM_ID_UNVERIFIED','Rendered owner record identity not yet bound');
 const found=records.filter(r=>r.id===id);if(!found.length)return null;if(found.length!==1)throw new CliError('AMBIGUOUS_CONTENT','Multiple exact owner records');const r=found[0];
 if(r.accountId!==accountId||draftId&&r.draftId!==draftId)throw new CliError('CONTENT_IDENTITY_MISMATCH','Article owner or original draft differs');
 if(r.url!==`https://juejin.cn/post/${id}`)throw new CliError('CONTENT_IDENTITY_MISMATCH','Owner article link differs');return r;
}
export function ownerArticleState(r){
 if(!r)return {status:'not_found',reason:'Exact article absent from the loaded first page; not assumed deleted'};
 let status='query_unavailable';if(r.status===-1)status='deleted';else if(r.auditStatus===-1)status='rejected';else if([0,1].includes(r.auditStatus))status='reviewing';else if(r.auditStatus===3)status='updating';else if(r.auditStatus===2&&[1,2].includes(r.status)&&r.visibleLevel===0)status='published';
 return {status,contentId:r.id,draftId:r.draftId,title:r.title,platformStatus:r.status,auditStatus:r.auditStatus,visibleLevel:r.visibleLevel,publicUrl:status==='published'?r.url:null,source:'exact_owner_manager_record'};
}
export async function loadOwnerArticle(page,id,accountId,draftId){
 await openArticleReadPage(page,ARTICLE_MANAGER);
 await waitFor(page,`performance.getEntriesByType('resource').some(r=>r.name.includes('/content_api/v1/article/list_by_user')&&r.responseEnd>0)`,'completed owner article response',45000);
 await waitFor(page,`(()=>{const p=document.querySelector('.first-tab')?.__vue__?.$parent;return p&&Array.isArray(p.articleList)&&!p.showLoading&&(document.querySelector('.essays-container')||p.isNoData)})()`,'loaded article manager',45000);
 await page.wait({time:0.5});
 const account=await ownerAccount(page,accountId),records=await page.evaluate(`(${ownerArticleSnapshot.toString()})()`);const row=selectOwnerArticle(records,id,accountId,draftId);await ownerAccount(page,accountId);return {account,row,records};
}
export async function queryArticle(page,job){const {row}=await loadOwnerArticle(page,job.receipt?.contentId||job.reconciliation?.contentId,job.manifest.accountId,job.draftId);if(row&&row.title!==job.manifest.title)throw new CliError('CONTENT_IDENTITY_MISMATCH','Owner title differs');return ownerArticleState(row);}
