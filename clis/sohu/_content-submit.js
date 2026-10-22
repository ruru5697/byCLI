import {CliError,ArgumentError} from '@sovovs/bycli/errors';
import {digest,sohuStatuses,sohuContentJobAction,managers} from '../_shared/video-submit.js';
import {openManagerPage} from '../_shared/video-site-submit.js';
import {waitFor} from '../_shared/video-prepare.js';
import {statsAccount} from '../_shared/video-stats.js';
import {contentSnapshot,contentUrl} from './_content-prepare.js';

const paragraphs=value=>(value||'').replace(/\r\n/g,'\n').split(/\n+/).filter(p=>p.trim());
/** Exact text per paragraph; saved drafts may collapse empty paragraphs, never words. */
export function assertContentForSubmit(s,job){
 const type=job.contentType,m=job.manifest,a=job.assets,baseline=job.checks;
 if(!['gallery','article'].includes(type)||s.unavailable||s.url!==contentUrl(type)||s.title!==m.title)throw new CliError('FIELD_MISMATCH','Authorized content editor or title differs');
 if(!Array.isArray(s.pictures)||s.pictures.length!==a.images.length||new Set(s.pictures.map(p=>p.uploadHash)).size!==a.images.length||s.pictures.some((p,i)=>!p.uploadHash||p.uploadHash!==baseline.pictures[i]?.uploadHash||p.width!==a.images[i].width||p.height!==a.images[i].height||(type==='gallery'?(p.sha256!=null&&p.sha256!==a.images[i].sha256||p.description!==m.images[i].description):(!p.loaded||!p.resourceReady||p.name!==a.images[i].name))))throw new CliError('IMAGE_MISMATCH','Ordered uploaded image identities or content differ from the prepared job');
 if(type==='gallery'&&(JSON.stringify(s.descriptions)!==JSON.stringify(m.images.map(p=>p.description))||JSON.stringify(s.category)!==JSON.stringify(m.category)))throw new CliError('FIELD_MISMATCH','Gallery captions or category differ');
 if(type==='article'){
  if(JSON.stringify(paragraphs(s.body))!==JSON.stringify(paragraphs(m.body))||s.summary!==m.summary||s.attribute!=='属性\n\n未选择')throw new CliError('FIELD_MISMATCH','Article paragraph text, summary or attribute differs');
  if(!s.loginGate?.visible||s.loginGate.checked)throw new CliError('VISIBILITY_UNVERIFIED','Public full-text visibility must be explicitly verified');
 }
 if(!s.cover.present||s.cover.binding!==baseline.cover.binding||baseline.upload?.coverSha256!==a.cover.sha256||JSON.stringify(s.declarations)!==JSON.stringify([m.declaration])||!s.dialogsClosed||s.quota<=0||!s.publishControlPresent||s.publishControlDisabled)throw new CliError('EDITOR_NOT_READY','Cover, declaration, quota or publishing controls differ');
}

/** Only selected publishing settings are hashed; media URLs never leave browser memory. */
export async function selectedContentSettings(){
 const keys=['topicIds','userLabels','additionalStatement','sourceUrl','columnNewsIds','creationStatement','coverType','idPush','selectTagList'];
 const options=[...document.querySelectorAll('.select-option')].map(e=>{const vm=e.__vue__;return Object.fromEntries(keys.map(k=>[k,vm?.[k]??null]))});
 const controls=[...document.querySelectorAll('input,textarea,select')].filter(e=>!['file','hidden'].includes(e.type)).map(e=>({type:e.type,value:e.value,checked:!!e.checked}));
 const checks=[...document.querySelectorAll('.mp-check')].map(e=>({checked:e.classList.contains('checked'),context:e.parentElement.innerText}));
 const editorHtml=document.querySelector?.('.ql-editor')?.innerHTML??null;
 const text=new TextEncoder().encode(JSON.stringify({options,controls,checks,editorHtml}));
 return {draftId:new URL(location.href).searchParams.get('id'),settingsHash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',text))].map(b=>b.toString(16).padStart(2,'0')).join('')};
}
export function managerPublicUrl(raw,id,type,accountId){
 try{const u=new URL(raw);if(u.protocol==='https:'&&u.hostname==='www.sohu.com'&&(type==='gallery'?u.pathname===`/picture/${id}`:u.pathname===`/a/${id}_${accountId}`)&&!u.search)return u.href}catch{}
 return null;
}
/** Exact owner record, including numeric type, determines status. Never infer by title. */
export function contentManagerState(records,id,type,accountId){
 const record=records.find(r=>r.contentId===id);
 if(!record)return {status:'not_found',contentId:id,reason:'Exact ID absent from the loaded first page; not assumed deleted'};
 if(record.contentType!==(type==='gallery'?3:2))return {status:'query_unavailable',contentId:id,reason:'Exact ID is not the requested content type'};
 return {status:sohuStatuses[record.platformStatus]||'query_unavailable',contentId:id,contentType:type,platformStatus:record.platformStatus,title:record.title,publicUrl:record.platformStatus===4?managerPublicUrl(record.link,id,type,accountId):null,source:'exact_owner_manager_record'};
}
export async function querySohuContent(page,job){
 const id=job.receipt?.contentId||job.reconciliation?.contentId,account=job.review?.account||job.preparedAccount;
 if(!/^[1-9]\d{0,24}$/.test(id||'')||!account?.id)throw new CliError('CONTENT_ID_MISSING','Verified content ID and prepared account are required');
 await openManagerPage(page,'sohu');await page.goto(managers.sohu,{stealth:false});await page.focusWindow();
 await waitFor(page,`!!document.querySelector('.tab_header')`,'owner manager',30000);
 await statsAccount(page,'sohu',account.id);
 // Explicitly select all content types; this row model was verified for both real samples.
 const count=await page.evaluate(`(()=>{const e=[...document.querySelectorAll('.tab_header *')].filter(e=>!e.children.length&&e.textContent.trim()==='全部'&&e.getBoundingClientRect().width>0);if(e.length===1)e[0].setAttribute('data-bycli-all-content','true');return e.length})()`);
 if(count!==1)throw new CliError('MANAGER_UNAVAILABLE','All-content filter unavailable');
 await page.click('[data-bycli-all-content="true"]');await page.wait({time:1});
 await waitFor(page,`document.querySelectorAll('.content-item').length>0||document.body.innerText.includes('这里空空如也')`,'loaded owner records',30000);
 const records=await page.evaluate(`(()=>[...document.querySelectorAll('.content-item')].map(row=>{const r=[...row.querySelectorAll('*')].find(e=>e.__vue__?._props?.article)?.__vue__._props.article;return {contentId:String(r?.id??r?.newsId??''),contentType:r?.type,platformStatus:r?.status,title:row.querySelector('h3.title a')?.innerText,link:row.querySelector('h3.title a')?.getAttribute('href')};}))()`);
 await statsAccount(page,'sohu',account.id);
 return contentManagerState(records,id,job.contentType,account.id);
}
export function makeSohuContentAdapter(type){
 if(!['gallery','article'].includes(type))throw new ArgumentError('Expected gallery or article');
 return {
  async inspect(page,job){
   const s=await page.evaluate(`(${contentSnapshot.toString()})(${JSON.stringify(type)})`);assertContentForSubmit(s,job);
   const account=await statsAccount(page,'sohu',job.preparedAccount?.id);
   if(!job.preparedAccount?.id||account.id!==job.manifest.accountId)throw new CliError('ACCOUNT_CHANGED','Prepared and expected account must match');
   const selected=await page.evaluate(`(${selectedContentSettings.toString()})()`);
   if(!/^[a-f0-9]{64}$/.test(selected.settingsHash)||selected.draftId&&!/^[1-9]\d{0,24}$/.test(selected.draftId)||job.remoteDraftId&&selected.draftId!==job.remoteDraftId)throw new CliError('EDITOR_CHANGED','Saved draft identity or publishing settings unavailable');
   return {account,draftId:selected.draftId,title:s.title,body:s.body,summary:s.summary,url:s.url,mediaHash:digest({pictures:s.pictures.map(p=>({uploadHash:p.uploadHash,width:p.width,height:p.height})),cover:s.cover.binding}),settingsHash:digest({selected:selected.settingsHash,descriptions:s.descriptions,category:s.category,declarations:s.declarations,body:s.body,summary:s.summary,attribute:s.attribute,loginGate:s.loginGate})};
  },
  async trigger(page,job){
   if(typeof page.evaluateOnce!=='function')throw new CliError('ONE_SHOT_UNAVAILABLE','No-retry publishing capability is required');
   return page.evaluateOnce(`(()=>{const u=new URL(location.href),a=document.querySelector('#app')?.__vue__?.$store?.state?.app?.userInfo;const nodes=[...document.querySelectorAll('.bottom-button li')].filter(e=>e.innerText.trim()==='发布'&&e.getBoundingClientRect().width>0);if(u.origin+u.pathname!==${JSON.stringify(contentUrl(type))}||u.searchParams.get('id')!==${JSON.stringify(job.remoteDraftId??null)}||String(a?.id)!==${JSON.stringify(job.preparedAccount.id)}||document.querySelector('input[placeholder="请输入标题（5-72字）"]')?.value!==${JSON.stringify(job.manifest.title)}||nodes.length!==1||nodes[0].matches('.disabled,.disable-button,[disabled]'))throw Error('Authorized publishing control changed');nodes[0].click();return true})()`);
  },
  query:querySohuContent,
 };
}
export const contentArgs=[{name:'input',help:'Local content JSON manifest'},{name:'prepare',type:'bool',default:false},{name:'review',help:'Review a prepared local job UUID; confirmation expires in 30 minutes'},{name:'submit',help:'Submit a reviewed job once after explicit human approval'},{name:'confirm',help:'Exact token from review'},{name:'status',help:'Query a local job and its exact verified content ID'},{name:'timeout',type:'int',default:300}];
export function contentCommand(page,kwargs,type,prepare){
 if(kwargs.prepare&&!kwargs.review&&!kwargs.submit&&!kwargs.status&&!kwargs.confirm&&kwargs.input)return prepare(page,kwargs,type);
 return sohuContentJobAction(page,kwargs,makeSohuContentAdapter(type),type);
}
