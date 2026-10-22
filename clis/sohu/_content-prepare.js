import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {imageDimensions} from '../_shared/image-prepare.js';
import {SOHU_DECLARATIONS,waitFor,clickText,fillVerified} from '../_shared/video-prepare.js';
import {statsAccount} from '../_shared/video-stats.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
export const contentUrl=type=>`https://mp.sohu.com/mpfe/v4/contentManagement/news/add${type==='gallery'?'atlas':'article'}`;
export function validateContentManifest(value,type){
 if(!['gallery','article'].includes(type)||!value||typeof value!=='object'||Array.isArray(value))throw new ArgumentError('Expected a gallery or article JSON object');
 const allowed=['title','cover','declaration','visibility','accountId',...(type==='gallery'?['images','category']:['body','summary','images','attribute'])];
 for(const key of Object.keys(value))if(!allowed.includes(key))throw new ArgumentError(`Unsupported manifest field: ${key}`);
 if(typeof value.title!=='string'||value.title.trim().length<5||value.title.length>72||/[\r\n]/.test(value.title))throw new ArgumentError('title requires 5–72 character units on one line');
 if(typeof value.cover!=='string'||!value.cover.trim())throw new ArgumentError('A local cover image is required');
 if(!SOHU_DECLARATIONS.includes(value.declaration)||value.visibility!=='public')throw new ArgumentError('Explicit supported declaration and public visibility are required');
 if(typeof value.accountId!=='string'||!/^\d{1,30}$/.test(value.accountId))throw new ArgumentError('Expected public accountId is required');
 if(!Array.isArray(value.images)||value.images.length<(type==='gallery'?3:1)||value.images.length>(type==='gallery'?40:20))throw new ArgumentError('gallery supports 3–40 images; article supports 1–20 end-of-body images');
 if(type==='gallery'){
  if(value.images.some(x=>!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['path','description'].includes(k))||typeof x.path!=='string'||!x.path.trim()||typeof x.description!=='string'||!x.description.trim()||x.description.length>200))throw new ArgumentError('Each gallery image needs path and 1–200 character description');
  if(!Array.isArray(value.category)||value.category.length!==2||value.category.some(x=>typeof x!=='string'||!x.trim()))throw new ArgumentError('category requires [primary, secondary]');
 }else{
  if(typeof value.body!=='string'||!value.body.trim()||value.body.length>20000||/[\r]/.test(value.body))throw new ArgumentError('body requires 1–20000 character units of plain text using LF newlines');
  if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>120||/[\r\n]/.test(value.summary))throw new ArgumentError('summary requires 1–120 character units on one line');
  if(value.attribute!=='none')throw new ArgumentError('Only explicit attribute="none" is supported');
  if(value.images.some(x=>typeof x!=='string'||!x.trim()))throw new ArgumentError('Article images must be ordered local file paths');
 }
 return structuredClone(value);
}
export async function readContentManifest(input,type){
 let value;try{value=JSON.parse(await fs.readFile(input,'utf8'))}catch{throw new ArgumentError('Cannot read input JSON manifest')}
 const manifest=validateContentManifest(value,type),base=path.dirname(path.resolve(input));
 async function image(item,cover=false){
  const file=path.resolve(base,item);let stat;try{stat=await fs.stat(file)}catch{throw new ArgumentError('Image file not found')}
  if(!stat.isFile()||!stat.size||stat.size>=10*1024**2||!/\.(png|jpe?g)$/i.test(file))throw new ArgumentError('Only nonempty PNG/JPEG files smaller than 10 MiB are supported');
  const data=await fs.readFile(file),dims=imageDimensions(data,path.extname(file).toLowerCase());
  if(dims.width<=(cover?450:250)||dims.height<=(cover?300:250))throw new ArgumentError(cover?'Cover must exceed 450×300':'Images must exceed 250×250');
  return {path:file,name:path.basename(file),bytes:stat.size,sha256:hash(data),...dims};
 }
 const images=[];for(const x of manifest.images)images.push(await image(type==='gallery'?x.path:x));
 if(type==='article'&&new Set(images.map(a=>a.name)).size!==images.length)throw new ArgumentError('Article images require distinct file names for upload-order verification');
 if(new Set(images.map(a=>a.sha256)).size!==images.length)throw new ArgumentError('Repeated image content is unsupported');
 const cover=await image(manifest.cover,true);manifest.cover=cover.path;
 manifest.images=images.map((a,i)=>type==='gallery'?{path:a.path,description:manifest.images[i].description}:a.path);
 return {manifest,assets:{images,cover}};
}

/** Browser-side only: return fingerprints and selected safe fields, never media URLs. */
export async function contentSnapshot(type){
 const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const visible=e=>!!e&&e.getBoundingClientRect().width>0;
 const pictures=[];
 if(type==='gallery'){
  const infos=document.querySelector('.editor-area')?.__vue__?.picInfos;
  if(!Array.isArray(infos))return {unavailable:true};
  for(const x of infos)pictures.push({sha256:x.file instanceof File?await digest(await x.file.arrayBuffer()):null,bytes:x.file?.size,width:x.width,height:x.height,status:x.status,description:x.description,uploadHash:x.url?await digest(x.url):null});
 }else{
  for(const img of document.querySelectorAll('.ql-editor img')){const task=document.querySelector('.upload-control')?.__vue__?.resources?.find(r=>r.dom===img);pictures.push({resourceReady:task?.status==='success'&&task.src===img.getAttribute('src'),name:img.alt,width:img.naturalWidth,height:img.naturalHeight,loaded:img.complete&&img.naturalWidth>0,uploadHash:await digest(new URL(img.getAttribute('src')||'',location.href).href)});}
 }
 const cover=document.querySelector('.pic-cover');const background=cover?.style.backgroundImage||'';
 const publish=[...document.querySelectorAll('.bottom-button li')].filter(e=>e.innerText.trim()==='发布'&&visible(e));
 const editor=document.querySelector('.ql-editor');
 const body=editor?[...editor.children].filter(e=>!e.classList.contains('ql-image-container')).map(e=>e.textContent).join('\n').replace(/\n+$/,''):null;
 const loginParent=document.querySelector('.check-visible-box');
 return {url:location.origin+location.pathname,title:document.querySelector('input[placeholder="请输入标题（5-72字）"]')?.value,pictures,descriptions:[...document.querySelectorAll('textarea.text-desc')].map(e=>e.value),body,summary:document.querySelector('textarea.abstract-main-textarea')?.value,
  cover:{present:visible(cover)&&!!background&&!/url\(["']?["']?\)/.test(background),binding:await digest(background)},
  category:[...document.querySelectorAll('.select.plugin-dropdown .select-main .select-text')].filter(visible).map(e=>e.innerText.trim()),
  attribute:document.querySelector('.article-attr')?.innerText.trim(),declarations:[...document.querySelectorAll('label.el-radio')].filter(e=>e.querySelector('input')?.checked).map(e=>e.innerText.trim()),
  dialogsClosed:![...document.querySelectorAll('.select-dialog,.el-dialog__wrapper,.dialog')].some(visible),quota:Number(document.querySelector('.rest-number strong')?.innerText.trim()??-1),
  publishControlPresent:publish.length===1,publishControlDisabled:publish.some(e=>e.matches('.disabled,.disable-button,[disabled]')),
  loginGate:loginParent?{visible:visible(loginParent),text:loginParent.innerText,checked:!!loginParent.querySelector('.mp-check.checked')}:null,
  finalPublishClicked:false};
}
export function assertContentChecks(checks,manifest,assets,type,upload){
 if(checks.unavailable||checks.url!==contentUrl(type)||checks.title!==manifest.title)throw new CliError('FIELD_MISMATCH','Title or editor identity differs');
 const imageMismatch=checks.pictures.length!==assets.images.length||new Set(checks.pictures.map(p=>p.uploadHash)).size!==assets.images.length||checks.pictures.some((p,i)=>{
  const a=assets.images[i];
  if(!p.uploadHash||p.uploadHash!==upload.images[i]||p.width!==a.width||p.height!==a.height)return true;
  if(type==='gallery')return p.sha256!==a.sha256||p.bytes!==a.bytes||p.status!=='resolved';
  const selected=upload.sourceImages?.[i];
  return !p.loaded||!p.resourceReady||p.name!==a.name||selected?.sha256!==a.sha256||selected?.bytes!==a.bytes||selected?.name!==a.name||selected?.status!=='resolved';
 });
 if(imageMismatch)throw new CliError('IMAGE_MISMATCH','Uploaded images, content fingerprints or ordering differ');
 if(type==='gallery'&&(JSON.stringify(checks.descriptions)!==JSON.stringify(manifest.images.map(x=>x.description))||checks.pictures.some((p,i)=>p.description!==manifest.images[i].description)||JSON.stringify(checks.category)!==JSON.stringify(manifest.category)))throw new CliError('FIELD_MISMATCH','Gallery descriptions or category differ');
 if(type==='article'&&(!checks.loginGate?.visible||checks.loginGate.checked))throw new CliError('VISIBILITY_UNVERIFIED','Article public full-text visibility must be explicitly unchecked');
 if(type==='article'&&(checks.body!==manifest.body||checks.summary!==manifest.summary||checks.attribute!=='属性\n\n未选择'))throw new CliError('FIELD_MISMATCH','Article body, summary or attribute differs');
 if(!checks.cover.present||checks.cover.binding!==upload.coverBinding||upload.coverSha256!==assets.cover.sha256||!checks.declarations.includes(manifest.declaration)||!checks.dialogsClosed||checks.quota<=0||!checks.publishControlPresent||checks.publishControlDisabled||checks.loginGate?.checked)throw new CliError('EDITOR_NOT_READY','Cover, declaration, visibility, quota or editor controls are not ready');
}
async function fileHashes(page,selector){
 return page.evaluate(`(async()=>{
  const rows=document.querySelector(${JSON.stringify(selector)})?.closest('.local-upload,.board')?.__vue__?.files||[],out=[];
  for(const row of rows){
   const f=row.file;if(!(f instanceof File))return [];
   const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
   out.push({name:f.name,bytes:f.size,sha256,status:row.status,uploaded:!!row.url});
  }
  return out;
 })()`);
}
async function uploadDialog(page,files,assets){
 await waitFor(page,`!!document.querySelector('#new-file')`,'local image input');
 await page.setFileInput(files,'#new-file');
 await waitFor(page,`document.body.innerText.includes(${JSON.stringify('已成功上传'+files.length+'张图片')})`,'successful image upload',120000);
 const filesRead=await fileHashes(page,'#new-file');
 if(filesRead.length!==assets.length||filesRead.some((f,i)=>f.sha256!==assets[i].sha256||f.bytes!==assets[i].bytes||f.status!=='resolved'||!f.uploaded))throw new CliError('ASSET_CHANGED','Browser selected files differ from local input');
 await clickText(page,'确定');
 return filesRead;
}
async function selectGalleryCategory(page,labels){
 for(let i=0;i<2;i++){
  await page.evaluate(`document.querySelectorAll('.select.plugin-dropdown')[${i}]?.setAttribute('data-bycli-category', '${i}')`);
  const scope=`[data-bycli-category="${i}"]`;await page.click(scope+' .select-main');await clickText(page,labels[i],scope+' .select-list');
  await waitFor(page,`document.querySelector('${scope} .select-text')?.innerText.trim()===${JSON.stringify(labels[i])}`,'selected category');
  if(i===0)await page.wait({time:1});
 }
}
export async function prepareContentEditor(page,manifest,assets,type,stage){
 const tabs=await page.tabs();
 if(tabs.length){page.setActivePage(tabs[0].page);const safe=await page.evaluate(`(()=>{const u=new URL(location.href);return location.href==='about:blank'||u.origin==='https://mp.sohu.com'&&['/mpfe/v4/contentManagement/first/page','/mpfe/v4/data/analysis'].includes(u.pathname)})()`);if(!safe)throw new CliError('EXISTING_EDITOR','Retain current owned page; finish or close it before preparing new content');}
 await stage('opening_editor');await page.goto(contentUrl(type),{stealth:false});await page.focusWindow();
 await waitFor(page,`!!document.querySelector('input[placeholder="请输入标题（5-72字）"]')&&Number(document.querySelector('.rest-number strong')?.innerText)>0`,'loaded editor and publishing quota',30000);
 await page.wait({time:2});
 const existing=await page.evaluate(`(()=>({title:document.querySelector('input[placeholder="请输入标题（5-72字）"]')?.value,body:document.querySelector('.ql-editor')?.innerText.trim(),images:document.querySelectorAll('.ql-editor img,.pic-info .pic-item').length}))()`);
 if(existing.title||existing.body||existing.images)throw new CliError('EXISTING_EDITOR','Platform restored existing content; retain it for inspection instead of overwriting');
 const account=await statsAccount(page,'sohu',manifest.accountId);
 await fillVerified(page,'input[placeholder="请输入标题（5-72字）"]',manifest.title);
 if(type==='article'){
  await fillVerified(page,'.ql-editor',manifest.body);
  await fillVerified(page,'textarea.abstract-main-textarea',manifest.summary);
  // Use a normal DOM selection so the toolbar inserts pictures at the end of the text.
  await page.evaluate(`(()=>{const e=document.querySelector('.ql-editor');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`);
  await page.click('.ql-toolbar button.ql-image');
 }else await page.click('button.positive-button');
 await stage('uploading_images');
 const selected=await uploadDialog(page,assets.images.map(a=>a.path),assets.images);
 await waitFor(page,type==='gallery'?`document.querySelectorAll('.pic-info .pic-item').length===${assets.images.length}`:`document.querySelectorAll('.ql-editor img').length===${assets.images.length}&&[...document.querySelectorAll('.ql-editor img')].every(e=>e.complete&&e.naturalWidth>0&&!e.src.startsWith('blob:')&&document.querySelector('.upload-control')?.__vue__?.resources?.some(r=>r.dom===e&&r.status==='success'&&r.src===e.getAttribute('src')))`,'inserted images');
 if(type==='gallery'){
  for(const [i,item]of manifest.images.entries()){
   await page.evaluate(`document.querySelectorAll('textarea.text-desc')[${i}]?.setAttribute('data-bycli-description','${i}')`);
   await fillVerified(page,`[data-bycli-description="${i}"]`,item.description);
  }
  await selectGalleryCategory(page,manifest.category);
 }
 const inserted=await page.evaluate(`(${contentSnapshot.toString()})(${JSON.stringify(type)})`);
 const upload={images:inserted.pictures.map(p=>p.uploadHash),sourceImages:selected.map(f=>({name:f.name,bytes:f.bytes,sha256:f.sha256,status:f.status}))};
 await stage('uploading_cover');await page.click('.cover-button');await clickText(page,'本地上传','.select-dialog');
 await waitFor(page,`!!document.querySelector('#new-file')`,'cover file input');await page.setFileInput([manifest.cover],'#new-file');
 await waitFor(page,`document.body.innerText.includes('已选择1张')`,'uploaded cover',120000);
 const coverFiles=await fileHashes(page,'#new-file');
 if(coverFiles.length!==1||coverFiles[0].sha256!==assets.cover.sha256)throw new CliError('ASSET_CHANGED','Browser cover differs from local cover');
 await waitFor(page,`document.body.innerText.includes('已选择1张')`,'uploaded cover',120000);await clickText(page,'确定','.select-dialog');
 await waitFor(page,`!!document.querySelector('.pic-cover')?.style.backgroundImage&&!document.querySelector('.pic-cover')?.style.backgroundImage.includes('url("")')`,'applied cover');
 upload.coverSha256=coverFiles[0].sha256;
 await stage('filling_required_fields');await clickText(page,manifest.declaration,'label.el-radio');
 const checks=await page.evaluate(`(${contentSnapshot.toString()})(${JSON.stringify(type)})`);upload.coverBinding=checks.cover.binding;
 assertContentChecks(checks,manifest,assets,type,upload);
 await statsAccount(page,'sohu',account.id);
 return {...checks,account,upload,visibility:'public_platform_default',remoteDraftDurability:'not_guaranteed'};
}
export async function prepareSohuContent(page,kwargs,type){
 if(kwargs.prepare!==true||!kwargs.input||Object.entries(kwargs).some(([k,v])=>['submit','confirm','review','status'].includes(k)&&v))throw new ArgumentError('Preparation requires --prepare --input without review/submit/status');
 const {manifest,assets}=await readContentManifest(kwargs.input,type),jobId=randomUUID();
 const dir=path.join(process.env.BYCLI_CONFIG_DIR||path.join(os.homedir(),'.bycli'),'publish-jobs','sohu',jobId);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const report=path.join(dir,'job.json'),job={schemaVersion:1,jobId,platform:'sohu',contentType:type,createdAt:new Date().toISOString(),status:'preparing',stage:'validated',submitted:false,finalPublishAction:'requires_confirmation',remoteDraftId:null,editorPersistence:'live_browser_editor; remote draft durability not guaranteed',manifest,assets,inputSha256:hash(JSON.stringify({manifest,assets})),sideEffects:['Image and cover uploads; platform may automatically save a draft'],report};
 const save=async()=>{job.updatedAt=new Date().toISOString();const temp=path.join(dir,randomUUID()+'.tmp');await fs.writeFile(temp,JSON.stringify(job,null,2),{mode:0o600});await fs.rename(temp,report)};
 await save();
 try{
  job.checks=await prepareContentEditor(page,manifest,assets,type,async stage=>{job.stage=stage;await save()});
  for(const a of [...assets.images,assets.cover])if(hash(await fs.readFile(a.path))!==a.sha256)throw new CliError('ASSET_CHANGED','Local image changed during preparation');
  job.preparedAccount=job.checks.account;job.pageTarget=page.getActivePage?.()??null;job.screenshot=path.join(dir,'preview.png');await page.screenshot({path:job.screenshot,fullPage:false});await fs.chmod(job.screenshot,0o600);
  job.status='ready_for_confirmation';job.stage='ready';await save();
  return [{status:job.status,job_id:jobId,content_type:type,title:manifest.title,submitted:false,account:job.preparedAccount.name,report,preview:job.screenshot}];
 }catch(error){job.status='failed';job.pageTarget=page.getActivePage?.()??null;job.error={code:error.code||'PREPARATION_FAILED',message:String(error.message||error).replace(/(?:https?:)?\/\/\S+/g,'[url]').slice(0,400)};await save();throw new CliError(job.error.code,job.error.message,`Local preparation report: ${report}`)}
}
