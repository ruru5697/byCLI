import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import{createHash,randomUUID}from'node:crypto';
import{ArgumentError,CliError}from'@sovovs/bycli/errors';import{imageDimensions}from'../_shared/image-prepare.js';import{waitFor,fillVerified}from'../_shared/video-prepare.js';import{saveJob}from'../_shared/video-submit.js';
const sha=x=>createHash('sha256').update(x).digest('hex');export const EDITOR='https://editor.csdn.net/md/';
export function retainedEditorError(tab){
 const target=tab&&tab.page?String(tab.page):'unknown';
 const where=tab&&tab.url?` at ${tab.url}`:'';
 return new CliError('EXISTING_EDITOR',`Retain current owned page${where}; finish or close it before preparing another article. In the byCLI Adapter browser window, manually finish or close the CSDN editor tab (target ${target}). Ordinary browser sessions cannot close this Adapter tab`);
}
export function tagMissMessage(platform,tag,suggestions){
 const visible=(Array.isArray(suggestions)?suggestions:[]).filter(x=>typeof x==='string'&&x.trim()).slice(0,8);
 return visible.length
  ?`${platform} has no existing tag ${JSON.stringify(tag)}; visible suggestions: ${visible.map(x=>JSON.stringify(x)).join(', ')}`
  :`${platform} has no existing tag ${JSON.stringify(tag)} and no suggestion list was visible`;
}

export function validateCsdnManifest(v){
 if(!v||typeof v!=='object'||Array.isArray(v))throw new ArgumentError('Expected CSDN article JSON');
 const keys=['title','body','cover','summary','tags','articleType','visibility','declaration','accountId','columns','backupToGitCode','multiPlatform','template','activities','topics'];for(const k of Object.keys(v))if(!keys.includes(k))throw new ArgumentError(`Unsupported field: ${k}`);
 for(const[k,min,max]of[['title',5,100],['body',1,80000],['summary',1,256]])if(typeof v[k]!=='string'||v[k].trim().length<min||v[k].length>max||/\r/.test(v[k])||k!=='body'&&/\n/.test(v[k]))throw new ArgumentError(`${k} requires ${min}–${max} character units; LF only in body`);
 if(typeof v.cover!=='string'||!v.cover.trim()||typeof v.accountId!=='string'||! /^[a-zA-Z0-9_]{3,64}$/.test(v.accountId))throw new ArgumentError('Local cover and exact public CSDN account name required');
 if(!Array.isArray(v.tags)||v.tags.length<1||v.tags.length>7||v.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>30||/[\r\n,]/.test(t))||new Set(v.tags).size!==v.tags.length)throw new ArgumentError('Provide 1–7 distinct explicit tags');
 if(v.articleType!=='original'||v.visibility!=='public'||v.declaration!=='部分内容由AI辅助生成'||v.template!=='默认模板'||v.backupToGitCode!==false||v.multiPlatform!==false||['columns','activities','topics'].some(k=>!Array.isArray(v[k])||v[k].length))throw new ArgumentError('Only original/public, explicit AI-assisted declaration, default template, no backups/multi-platform/columns/activities/topics supported');
 if(/!\[|<\s*(?:img|script|iframe|video)\b/i.test(v.body))throw new ArgumentError('Inline media and active HTML require a separate upload workflow');return structuredClone(v);
}
// CSDN nested modals can acknowledge a native point click without activating the target.
// Use the observed DOM click handlers for reversible preparation, never the final publish control.
export async function csdnClick(page,selector){
 const ok=await page.evaluate(`(()=>{const list=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getBoundingClientRect().width>0||e.matches('input[type=radio],input[type=checkbox]')&&e.parentElement.getBoundingClientRect().width>0);if(list.length!==1)return false;const e=list[0];if(e.closest('.modal__publish-article')&&['发布文章','定时发布'].includes(e.innerText.trim()))throw Error('Final publish forbidden during preparation');e.click();return true})()`);if(!ok)throw new CliError('CONTROL_NOT_FOUND','Expected one visible preparation control');
}
export async function csdnText(page,text,scope='body'){
 if(['发布文章','定时发布'].includes(text))throw new CliError('FINAL_PUBLISH_FORBIDDEN','Preparation cannot submit');
 const n=await page.evaluate(`(()=>{const rows=[...document.querySelectorAll(${JSON.stringify(scope+' *')})].filter(e=>!e.children.length&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0);if(rows.length===1)rows[0].click();return rows.length})()`);if(n!==1)throw new CliError('CONTROL_NOT_FOUND','Expected one exact preparation text control');
}
export async function readCsdnManifest(input){
 let raw;try{raw=JSON.parse(await fs.readFile(input,'utf8'))}catch{throw new ArgumentError('Cannot read input JSON')}
 const manifest=validateCsdnManifest(raw),file=path.resolve(path.dirname(path.resolve(input)),manifest.cover);let data,stat;try{stat=await fs.stat(file);data=await fs.readFile(file)}catch{throw new ArgumentError('Cannot read cover image')}
 if(!stat.isFile()||!stat.size||stat.size>=5*1024**2||!/\.(png|jpe?g)$/i.test(file))throw new ArgumentError('Static PNG/JPEG smaller than 5 MiB required');const dimensions=imageDimensions(data,path.extname(file).toLowerCase());
 if(dimensions.width<356||dimensions.height<200||dimensions.width*50!==dimensions.height*89)throw new ArgumentError('Cover must be at least 356×200 with exact 89:50 ratio for the observed fixed CSDN crop');
 manifest.cover=file;return{manifest,assets:{cover:{path:file,bytes:stat.size,sha256:sha(data),...dimensions}}};
}
/** Browser-only safe snapshot. Media URLs and full account profiles never leave page memory. */
export async function csdnSnapshot(){
 const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const store=document.querySelector('.app')?.__vue__?.$store,s=store?.state,file=store?.getters['file/current'],body=store?.getters['content/current']?.text,user=s?.userInfo;
 let vm=document.querySelector('.creation-statement-row .el-select')?.__vue__;while(vm&&!Object.hasOwn(vm.$data,'coverimages'))vm=vm.$parent;
 const modal=document.querySelector('.modal__publish-article'),visible=e=>!!e&&e.getBoundingClientRect().width>0;
 const tags=vm?(Array.isArray(file?.tags)?file.tags:typeof file?.tags==='string'?file.tags.split(',').filter(Boolean):null):null;
 const covers=file?.coverimages,coverList=Array.isArray(covers)?covers:typeof covers==='string'&&covers?[covers]:[];const coverHashes=[];
 for(const c of coverList){const value=typeof c==='string'?c:c?.url;try{const u=new URL(value);if(u.protocol!=='https:'||!/(^|\.)csdnimg\.cn$/.test(u.hostname))coverHashes.push(null);else coverHashes.push(await digest(u.origin+u.pathname))}catch{coverHashes.push(null)}}
 const img=document.querySelector('.container-coverimage-box .preview-box img.preview');let displayedHash=null;try{const u=new URL(img?.getAttribute('src'));displayedHash=await digest(u.origin+u.pathname)}catch{}
 const radioValues=[...modal?.querySelectorAll('input[type=radio]:checked')||[]].map(e=>e.value),multi=document.querySelector('.multi-platform-publish')?.__vue__;
 const final=[...modal?.querySelectorAll('button')||[]].filter(e=>e.innerText.trim()==='发布文章'&&visible(e));
 const selected=(selector)=>modal?.querySelector(selector)?.__vue__?.value;
 return {url:location.origin+location.pathname,account:{id:user?.name||null,name:user?.nickname||null},localFileId:s?.file?.currentId,title:document.querySelector('.article-bar__title--input')?.value,modelTitle:file?.name,body,bodySha256:typeof body==='string'?await digest(body):null,remoteDraftId:file?.articleid?String(file.articleid):null,draftStatus:file?.articlestatus,
  panelOpen:visible(modal),tags,tagLabels:[...modal?.querySelectorAll('.mark_selection_title_el_tag .mark_selection_box_el_tag')||[]].map(e=>e.innerText.trim()),summary:modal?.querySelector('.desc-box textarea')?.value,modelSummary:file?.descr,articleType:vm?.articletype,visibility:vm?.readType,declaration:vm?.creation_statement,declarationLabel:modal?.querySelector('.creation-statement-row input')?.value,columns:Array.isArray(file?.categories)?file.categories:typeof file?.categories==='string'?file.categories.split(',').filter(Boolean):null,backupToGitCode:vm?.sync_git_code,multiPlatform:multi?.enabled,selectedPlatforms:multi?.selectedPlatformKeys,templateId:vm?.articleTemplateSubmitValue,templateLabel:modal?.querySelector('.article-template-selector input:checked')?.parentElement.innerText.trim(),activityId:vm?.doingsActivityId,topicId:vm?.topicActivityId,activities:selected('.drop-activity'),scheduledTime:vm?.scheduled_time,
  cover:{hashes:coverHashes,displayedHash,present:visible(img)&&!!img?.getAttribute('src'),loaded:!!img?.complete&&img.naturalWidth>0,width:img?.naturalWidth||0,height:img?.naturalHeight||0,uploading:!!document.querySelector('.container-coverimage-box')?.__vue__?.uploading,cropOpen:visible(document.querySelector('.vue-image-crop-upload'))},
  checkedRadios:radioValues,modalTypes:s?.modal?.stack.map(x=>typeof x==='string'?x:x.type),finalControlPresent:final.length===1,finalControlDisabled:final.some(e=>e.disabled),quota:user?.remaining_publish_count,autoSave:{isSaving:s?.autoSave?.isSaving,isAutoSaving:s?.autoSave?.isAutoSaving},rendering:{headings:document.querySelectorAll('.preview h2').length,codeBlocks:document.querySelectorAll('.preview pre').length},finalPublishClicked:false};
}
export const csdnSnapshotScript=()=>`(${csdnSnapshot.toString()})()`;
export function assertCsdnChecks(s,m,a,binding){
 if(s.account?.id!==m.accountId)throw new CliError('ACCOUNT_MISMATCH','Expected CSDN owner differs');
 if(![EDITOR,EDITOR.slice(0,-1)].includes(s.url)||s.title!==m.title||s.modelTitle!==m.title||s.body!==m.body||s.bodySha256!==sha(m.body))throw new CliError('FIELD_MISMATCH','Markdown or title differs');
 if(!s.panelOpen||JSON.stringify(s.tags)!==JSON.stringify(m.tags)||JSON.stringify(s.tagLabels)!==JSON.stringify(m.tags)||s.summary!==m.summary||s.modelSummary!==m.summary||s.articleType!=='original'||s.visibility!=='public'||s.declaration!==1||s.declarationLabel!==m.declaration)throw new CliError('SETTINGS_MISMATCH','Article settings differ');
 if(!s.cover.present||!s.cover.loaded||s.cover.width!==356||s.cover.height!==200||s.cover.uploading||s.cover.cropOpen||s.cover.hashes.length!==1||!s.cover.hashes[0]||s.cover.displayedHash!==s.cover.hashes[0]||s.cover.hashes[0]!==binding.remoteHash||binding.sourceSha256!==a.cover.sha256||binding.sourceBytes!==a.cover.bytes||binding.crop?.width!==356||binding.crop?.height!==200||! /^[a-f0-9]{64}$/.test(binding.crop?.sha256||''))throw new CliError('COVER_MISMATCH','Selected/cropped/applied cover identity differs');
 if(JSON.stringify(s.modalTypes)!==JSON.stringify(['publishArticle'])||!Number.isFinite(Number(s.quota))||Number(s.quota)<=0||!s.finalControlPresent||s.finalControlDisabled||!s.checkedRadios.includes('original')||!s.checkedRadios.includes('public')||s.backupToGitCode||s.multiPlatform||s.selectedPlatforms?.length||s.columns?.length||s.activityId||s.topicId||s.scheduledTime||s.templateId!==-1)throw new CliError('EDITOR_NOT_READY','Default template, empty activities, backup or final controls differ');
}
export async function fillCsdnTitle(page,title){
 if(!await page.evaluate(`document.querySelector('.article-bar__title--input').getBoundingClientRect().width>0`))await csdnClick(page,'.article-bar__title-display');
 await waitFor(page,`document.querySelector('.article-bar__title--input').getBoundingClientRect().width>0`,'visible title input');
 await fillVerified(page,'.article-bar__title--input',title);await page.evaluate(`document.querySelector('.article-bar__title--input').blur()`);await waitFor(page,`document.querySelector('.app').__vue__.$store.getters['file/current'].name===${JSON.stringify(title)}`,'committed title');
}
export async function dismissCsdnTemplate(page){
 const info=await page.evaluate(`(()=>{const types=document.querySelector('.app').__vue__.$store.state.modal.stack.map(x=>typeof x==='string'?x:x.type);return {types,panelOpen:!!document.querySelector('.modal__publish-article')?.getBoundingClientRect().width}})()`);
 if(!info.types.includes('tpl'))return;
 if(info.types.some(t=>!['tpl','publishArticle'].includes(t)))throw new CliError('EXISTING_DIALOG','Retain an unexpected queued modal');
 // CSDN renders the first queued modal. Temporarily close settings to cancel a queued template picker.
 if(info.panelOpen)await csdnClick(page,'.modal__publish-article > .modal__inner-2 > .modal__close-button');
 for(let n=0;n<3;n++){
  const has=await page.evaluate(`document.querySelector('.app').__vue__.$store.state.modal.stack.some(x=>(typeof x==='string'?x:x.type)==='tpl')`);if(!has)break;
  await waitFor(page,`!!document.querySelector('.modal_outer')?.getBoundingClientRect().width`,'visible optional template picker',5000);await csdnText(page,'取消','.modal_outer');
 }
 await waitFor(page,`!document.querySelector('.app').__vue__.$store.state.modal.stack.some(x=>(typeof x==='string'?x:x.type)==='tpl')`,'dismissed optional template picker',5000);
 if(info.panelOpen){await csdnClick(page,'button.btn-publish');await waitFor(page,`!!document.querySelector('.creation-statement-row')`,'restored settings after template cancellation',30000);}
}
async function openSettings(page){await dismissCsdnTemplate(page);await csdnClick(page,'button.btn-publish');await waitFor(page,`!!document.querySelector('.modal__publish-article .creation-statement-row')`,'CSDN publishing settings',45000);}
export async function prepareCsdnEditor(page,m,a,markdownFile,stage,resumeId,resumeTitle=m.title,existingUpload=null){
 const tabs=await page.tabs();if(tabs.length){page.setActivePage(tabs[0].page);if(!resumeId)throw retainedEditorError(tabs[0]);}
 else{if(resumeId)throw new CliError('EDITOR_MISSING','Retained failed preparation editor is required');await page.goto(EDITOR,{stealth:false})}
 await page.focusWindow();await waitFor(page,`!!document.querySelector('.app')?.__vue__?.$store?.state.userInfo.name&&!!document.querySelector('#import-markdown-file-input')`,'authenticated Markdown editor',45000);
 let state=await page.evaluate(csdnSnapshotScript());if(state.account.id!==m.accountId)throw new CliError('ACCOUNT_MISMATCH','Logged-in CSDN account differs');
 if(!resumeId&&state.modalTypes.length===1&&state.modalTypes[0]==='tpl'){await csdnText(page,'取消','.modal_outer');state=await page.evaluate(csdnSnapshotScript());}
 if(resumeId){if(state.localFileId!==resumeId||state.modelTitle!==resumeTitle||state.body!==m.body)throw new CliError('RESUME_MISMATCH','Retained local file or content differs');if(existingUpload&&state.panelOpen){let matches=false;try{assertCsdnChecks(state,m,a,existingUpload);matches=true}catch{}if(matches)return finishCsdnDraft(page,m,a,existingUpload,stage)}if(state.panelOpen)await csdnClick(page,'.modal__publish-article > .modal__inner-2 > .modal__close-button');}
 else{
  if(state.modalTypes.length)throw new CliError('EXISTING_DIALOG','Retain existing modal before importing a new local file');
  const before=await page.evaluate(`(()=>{const st=document.querySelector('.app').__vue__.$store;return {id:st.state.file.currentId,name:st.getters['file/current']?.name,articleId:st.getters['file/current']?.articleid}})()`);
  await stage('importing_markdown');await page.setFileInput([markdownFile],'#import-markdown-file-input');
  await waitFor(page,`document.querySelector('.app').__vue__.$store.state.file.currentId!==${JSON.stringify(before.id)}&&document.querySelector('.app').__vue__.$store.getters['content/current']?.text===${JSON.stringify(m.body)}`,'new imported file with exact body',30000);
  const retained=await page.evaluate(`(()=>{const f=document.querySelector('.app').__vue__.$store.state.file.itemMap[${JSON.stringify(before.id)}];return !!f&&f.name===${JSON.stringify(before.name)}&&f.articleid===${JSON.stringify(before.articleId)}})()`);if(!retained)throw new CliError('ORIGINAL_FILE_CHANGED','Original local file metadata differs after import');
  const imported=await page.evaluate(csdnSnapshotScript());await stage('imported',{localFileId:imported.localFileId,recoveryTitle:imported.modelTitle});
 }
 await fillCsdnTitle(page,m.title);
 const filled=await page.evaluate(csdnSnapshotScript());if(filled.body!==m.body||filled.modelTitle!==m.title)throw new CliError('FIELD_MISMATCH','Title edit changed the Markdown body');
 state=await page.evaluate(csdnSnapshotScript());await stage('opening_settings',{localFileId:state.localFileId,recoveryTitle:state.modelTitle});await openSettings(page);
 let tags=await page.evaluate(`(()=>{let v=document.querySelector('.creation-statement-row .el-select').__vue__;while(v&&!Object.hasOwn(v.$data,'tags'))v=v.$parent;return document.querySelector('.app').__vue__.$store.getters['file/current'].tags})()`);if(typeof tags==='string')tags=tags.split(',').filter(Boolean);if(!Array.isArray(tags))throw new CliError('SETTINGS_MISMATCH','Unexpected existing tags');
 for(const tag of m.tags.filter(t=>!tags.includes(t))){
  const search='input[placeholder="请输入文字搜索，Enter键入可添加自定义标签"]';if(!await page.evaluate(`!!document.querySelector(${JSON.stringify(search)})&&document.querySelector(${JSON.stringify(search)}).getBoundingClientRect().width>0`))await csdnClick(page,'.mark_selection[typename="tags"] .tag__btn-tag');
  await fillVerified(page,search,tag);
  try{await waitFor(page,`[...document.querySelectorAll('.el-autocomplete-suggestion__list li')].some(e=>e.getBoundingClientRect().width>0&&e.innerText.trim()===${JSON.stringify(tag)})`,'exact existing tag '+tag,20000);}
  catch(error){if(error?.code!=='PREPARATION_TIMEOUT')throw error;const suggestions=await page.evaluate(`[...document.querySelectorAll('.el-autocomplete-suggestion__list li')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.innerText.trim()).filter(Boolean).slice(0,8)`).catch(()=>[]);throw new CliError('TAG_NOT_FOUND',tagMissMessage('CSDN',tag,suggestions));}
  await csdnText(page,tag,'.el-autocomplete-suggestion__list');
 }
 const selectedTags=await page.evaluate(`document.querySelector('.app').__vue__.$store.getters['file/current'].tags`);
 for(const extra of (Array.isArray(selectedTags)?selectedTags:selectedTags.split(',').filter(Boolean)).filter(t=>!m.tags.includes(t))){await page.evaluate(`(()=>{const e=[...document.querySelectorAll('.mark_selection_title_el_tag .mark_selection_box_el_tag')].find(e=>e.innerText.trim()===${JSON.stringify(extra)});if(!e)throw Error('Unexpected tag control');e.querySelector('.el-tag__close').click()})()`);}
 await fillVerified(page,'.modal__publish-article .desc-box textarea',m.summary);
 await csdnClick(page,'.creation-statement-row input.el-input__inner');await csdnText(page,m.declaration,'.el-select-dropdown');
 for(const value of ['original','public'])await csdnClick(page,`.modal__publish-article input[type=radio][value="${value}"]`);
 await csdnClick(page,'.article-template-selector input[value="-1"]');await csdnClick(page,'.multi-platform-publish input[value="false"]');
 const backup=await page.evaluate(`document.querySelector('.modal__publish-article .el-checkbox input')?.checked`);if(backup)await csdnClick(page,'.modal__publish-article .el-checkbox');
 await stage('uploading_cover');
 if(!await page.evaluate(`!!document.querySelector('.container-coverimage-box input[type=file]')`)){await page.evaluate(`(()=>{const box=document.querySelector('.container-coverimage-box .preview-box');const remove=box?.querySelector('.btn-remove-coverimg');if(!box||box.getBoundingClientRect().width<=0||!remove)throw Error('Cover replacement control unavailable');remove.click()})()`);await waitFor(page,`!!document.querySelector('.container-coverimage-box input[type=file]')`,'cover replacement input');}
 await page.evaluate(String.raw`(()=>{window.__bycliCsdnSource=null;document.querySelector('.container-coverimage-box input[type=file]').addEventListener('change',e=>{const f=e.target.files[0];if(f)f.arrayBuffer().then(async b=>{window.__bycliCsdnSource={bytes:f.size,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('')}})},{once:true,capture:true})})()`);
 await page.setFileInput([m.cover],'.container-coverimage-box input[type=file]');await waitFor(page,`document.querySelector('.vue-image-crop-upload')?.getBoundingClientRect().width>0&&document.querySelector('.vicp-img')?.naturalWidth>0&&!!window.__bycliCsdnSource`,'loaded source crop',45000);
 const source=await page.evaluate('window.__bycliCsdnSource');if(source.sha256!==a.cover.sha256||source.bytes!==a.cover.bytes)throw new CliError('ASSET_CHANGED','Browser selected cover differs');
 const cropped=await page.evaluate(String.raw`(async()=>{const c=document.querySelector('.vue-image-crop-upload').__vue__;const raw=c.createImgUrl.split(',')[1],bytes=Uint8Array.from(atob(raw),x=>x.charCodeAt(0));return {width:c.width,height:c.height,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')}})()`);
 await csdnText(page,'确认上传','.vue-image-crop-upload');
 await waitFor(page,`!document.querySelector('.container-coverimage-box').__vue__.uploading&&!!document.querySelector('.container-coverimage-box .preview-box img.preview')?.naturalWidth`,'uploaded cropped cover',90000);
 if(await page.evaluate(`document.querySelector('.vue-image-crop-upload').getBoundingClientRect().width>0`))await csdnClick(page,'.vue-image-crop-upload .vicp-close');
 await waitFor(page,`document.querySelector('.vue-image-crop-upload').getBoundingClientRect().width===0`,'closed crop dialog',5000);
 state=await page.evaluate(csdnSnapshotScript());const binding={sourceSha256:source.sha256,sourceBytes:source.bytes,crop:cropped,remoteHash:state.cover.hashes[0]};await stage('checking_settings',{localFileId:state.localFileId,upload:binding,checks:state});assertCsdnChecks(state,m,a,binding);
 return finishCsdnDraft(page,m,a,binding,stage);
}
export async function finishCsdnDraft(page,m,a,binding,stage){
 let state=await page.evaluate(csdnSnapshotScript());assertCsdnChecks(state,m,a,binding);
 const count=await page.evaluate(`performance.getEntriesByType('resource').filter(r=>r.name.includes('/mdeditor/saveArticle')&&r.responseEnd>0).length`);
 await stage('saving_draft');await csdnText(page,'保存为草稿','.modal__publish-article');
 await waitFor(page,`(()=>{const st=document.querySelector('.app').__vue__.$store;return st.state.notice.txt==='已成功保存至草稿箱'&&st.getters['file/current'].articlestatus===2&&Number(st.getters['file/current'].articleid)>0&&!st.state.autoSave.isSaving&&performance.getEntriesByType('resource').filter(r=>r.name.includes('/mdeditor/saveArticle')&&r.responseEnd>0).length>${count}})()`,'explicit remote draft save acknowledgement',45000);
 state=await page.evaluate(csdnSnapshotScript());if(!Number.isSafeInteger(Number(state.remoteDraftId))||Number(state.remoteDraftId)<=0)throw new CliError('DRAFT_ID_UNVERIFIED','Saved draft identity unavailable');
 await stage('checking_persistence',{remoteDraftId:state.remoteDraftId});
 await csdnClick(page,'.modal__publish-article > .modal__inner-2 > .modal__close-button');
 const tab=(await page.tabs())[0];await page.closeTab(tab.page);await page.goto(EDITOR.slice(0,-1)+'?articleId='+state.remoteDraftId,{stealth:false});
 await waitFor(page,`Number(document.querySelector('.app')?.__vue__?.$store?.getters['file/current']?.articleid)===${Number(state.remoteDraftId)}`,'server-restored draft',45000);await openSettings(page);
 await waitFor(page,`document.querySelector('.container-coverimage-box .preview-box img.preview')?.naturalWidth>0`,'restored cover',30000);
 await page.wait({time:1});await dismissCsdnTemplate(page);
 const restored=await page.evaluate(csdnSnapshotScript());assertCsdnChecks(restored,m,a,binding);if(restored.remoteDraftId!==state.remoteDraftId)throw new CliError('DRAFT_ID_CHANGED','Restored draft differs');
 return{localFileId:restored.localFileId,remoteDraftId:restored.remoteDraftId,account:restored.account,checks:restored,upload:binding,persistence:'closed_and_reopened_server_draft'};
}

export async function prepareCsdnArticle(page,args){
 if(args.prepare!==true||!args.input||args.submit||args.review||args.status||args.confirm)throw new ArgumentError('Use --prepare --input; this command has no final submit mode');
 const {manifest,assets}=await readCsdnManifest(args.input);if(args.resume&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.resume))throw new ArgumentError('Invalid resume UUID');const jobId=args.resume||randomUUID(),dir=path.join(process.env.BYCLI_CONFIG_DIR||path.join(os.homedir(),'.bycli'),'publish-jobs','csdn',jobId);await fs.mkdir(dir,{recursive:true,mode:0o700});const report=path.join(dir,'job.json');let lock;
 try{lock=await fs.open(report+'.lock','wx',0o600)}catch(e){if(e.code==='EEXIST')throw new CliError('JOB_BUSY','Preparation job locked');throw e}
 try{
  const inputSha256=sha(JSON.stringify({manifest,assets}));let job={schemaVersion:1,platform:'csdn',contentType:'article',jobId,status:'preparing',stage:'validated',manifest,assets,inputSha256,createdAt:new Date().toISOString(),submitted:false,finalPublishAction:'requires_confirmation',report,sideEffects:['new local Markdown file','cover upload/crop','explicit remote draft save']};
  if(args.resume){const old=JSON.parse(await fs.readFile(report,'utf8'));if(old.jobId!==jobId||old.platform!=='csdn'||old.contentType!=='article'||old.status!=='failed'||old.attempt||old.submitted!==false||!old.localFileId||old.inputSha256!==inputSha256)throw new CliError('RESUME_MISMATCH','Only the exact unchanged failed draft preparation may resume');job={...old,status:'preparing'};delete job.error;}
  const save=()=>saveJob(report,job);await save();const markdownFile=path.join(dir,'candidate.md');await fs.writeFile(markdownFile,manifest.body,{mode:0o600});
  try{Object.assign(job,await prepareCsdnEditor(page,manifest,assets,markdownFile,async(stage,details)=>{job.stage=stage;if(details)Object.assign(job,details);await save()},args.resume?job.localFileId:null,job.recoveryTitle||manifest.title,job.upload));const reread=await readCsdnManifest(args.input);if(sha(JSON.stringify(reread))!==sha(JSON.stringify({manifest,assets})))throw new CliError('ASSET_CHANGED','Inputs changed during preparation');job.status='ready_for_confirmation';job.stage='ready';job.screenshot=path.join(dir,'preview.png');await page.screenshot({path:job.screenshot,fullPage:false});await fs.chmod(job.screenshot,0o600);job.verifiedAt=new Date().toISOString();await save();}
  catch(e){try{const live=await page.evaluate(csdnSnapshotScript());if(live.localFileId===job.localFileId&&live.body===manifest.body&&live.account.id===manifest.accountId)job.recoveryTitle=live.modelTitle}catch{}job.failureHistory=[...(job.failureHistory||[]),{stage:job.stage,code:e.code||'PREPARATION_FAILED',at:new Date().toISOString()}];job.status='failed';job.error={code:e.code||'PREPARATION_FAILED',message:String(e.message||e).replace(/https?:\/\/\S+/g,'[url]').slice(0,300)};await save();throw new CliError(job.error.code,`${job.error.message}; inspect retained editor and ${report}`)}
  return[{status:job.status,job_id:jobId,title:manifest.title,account:job.account.name,draft_id:job.remoteDraftId,submitted:false,report,preview:job.screenshot}];
 }finally{await lock.close();await fs.rm(report+'.lock',{force:true})}
}
