import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {imageJobAction,videoJobAction,digest,parseReceipt,withJob} from '../_shared/video-submit.js';
import {makeImageAdapter} from '../_shared/image-site-submit.js';
import {xhsManagerRecordType} from '../_shared/video-site-submit.js';
const id='3b262918-5147-48e5-aea9-35c606a48b59',dirs=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const d of dirs.splice(0))await fs.rm(d,{recursive:true,force:true});});
async function fixture(){
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-image-submit-'));dirs.push(d);vi.stubEnv('BYCLI_CONFIG_DIR',d);
 const images=[path.join(d,'01.png'),path.join(d,'02.png')],assets=[];
 for(const [i,p]of images.entries()){await fs.writeFile(p,'image'+i);assets.push({order:i+1,path:p,name:path.basename(p),sha256:createHash('sha256').update('image'+i).digest('hex'),bytes:6,width:1080,height:1440});}
 const manifest={images,title:'咖啡面试',body:'原创漫画',declaration:'笔记含AI合成内容',visibility:'public',accountId:'123'};
 const dir=path.join(d,'publish-jobs/xiaohongshu',id);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'job.json');
 const job={jobId:id,platform:'xiaohongshu',contentType:'image',status:'ready_for_confirmation',submitted:false,pageTarget:'prepared',preparedAccount:{id:'123',name:'测试账号'},manifest,assets,inputSha256:digest({manifest,assets}),checks:{images:[{uploadIdSha256:'first'},{uploadIdSha256:'second'}]}};
 await fs.writeFile(file,JSON.stringify(job));
 const live={account:job.preparedAccount,mediaHash:'image-hash',settingsHash:'settings-hash',title:manifest.title,body:manifest.body};
 const adapter={inspect:vi.fn(async()=>live),trigger:vi.fn(),query:vi.fn()};
 const response={url:'https://creator.xiaohongshu.com/web_api/sns/v2/note',method:'POST',responseStatus:200,responsePreview:JSON.stringify({code:0,success:true,data:{note_id:'a'.repeat(24)}})};
 const page={tabs:vi.fn(async()=>[{page:'prepared'}]),setActivePage:vi.fn(),focusWindow:vi.fn(),screenshot:async({path:p})=>fs.writeFile(p,'preview'),startNetworkCapture:vi.fn(async()=>true),readNetworkCapture:vi.fn(async()=>[response]),wait:vi.fn()};
 return {job,file,page,adapter,live,response,read:async()=>JSON.parse(await fs.readFile(file,'utf8'))};
}
describe('strict image/video job isolation',()=>{
 it('rejects image jobs at the video command boundary',async()=>{const f=await fixture();await expect(videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'INVALID_JOB'});expect(f.adapter.inspect).not.toHaveBeenCalled();});
 it('rejects video jobs at the image command boundary',async()=>{const f=await fixture();await fs.writeFile(f.file,JSON.stringify({...f.job,contentType:'video'}));await expect(imageJobAction(f.page,{review:id},f.adapter)).rejects.toMatchObject({code:'INVALID_JOB'});});
 it('does not allow unsupported content types or platforms',async()=>{await expect(withJob('sohu',id,vi.fn(),'image')).rejects.toThrow();await expect(withJob('xiaohongshu',id,vi.fn(),'article')).rejects.toThrow();});
});
describe('image confirmation and durable single submission',()=>{
 it('reviews exact ordered assets without capturing or clicking',async()=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter),j=await f.read();expect(j.review.content.images.map(i=>i.sha256)).toEqual(f.job.assets.map(i=>i.sha256));expect(r).toMatchObject({content_type:'image',submitted:false});expect(j.finalPublishAction).toBe('requires_confirmation');expect(f.adapter.trigger).not.toHaveBeenCalled();expect(f.page.startNetworkCapture).not.toHaveBeenCalled();});
 it('blocks wrong confirmation before capture or attempt',async()=>{const f=await fixture();await imageJobAction(f.page,{review:id},f.adapter);await expect(imageJobAction(f.page,{submit:id,confirm:'wrong'},f.adapter)).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});expect((await f.read()).attempt).toBeUndefined();expect(f.page.startNetworkCapture).not.toHaveBeenCalled();expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('writes the attempt before one gesture, parses acceptance and refuses re-submit',async()=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter);f.adapter.trigger.mockImplementation(async()=>{expect((await f.read()).attempt.id).toBeTruthy();});const [s]=await imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter);expect(s).toMatchObject({status:'accepted',submitted:true,content_id:'a'.repeat(24)});await expect(imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter)).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});expect(f.adapter.trigger).toHaveBeenCalledTimes(1);});
 it.each(['mediaHash','settingsHash','account'])('refuses changed %s after review',async key=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter);f.live[key]=key==='account'?{id:'different',name:'other'}:'changed';await expect(imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter)).rejects.toThrow();expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('checks local files and ordered manifest fingerprints',async()=>{const f=await fixture();await fs.appendFile(f.job.manifest.images[1],'changed');await expect(imageJobAction(f.page,{review:id},f.adapter)).rejects.toMatchObject({code:'ASSET_CHANGED'});});
 it('rejects expired review and missing native capture without consuming the attempt',async()=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter);const j=await f.read();j.review.expiresAt='2000-01-01';await fs.writeFile(f.file,JSON.stringify(j));await expect(imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter)).rejects.toMatchObject({code:'CONFIRMATION_EXPIRED'});const [fresh]=await imageJobAction(f.page,{review:id},f.adapter);f.page.startNetworkCapture.mockResolvedValue(false);await expect(imageJobAction(f.page,{submit:id,confirm:fresh.confirmation},f.adapter)).rejects.toMatchObject({code:'CAPTURE_UNAVAILABLE'});expect((await f.read()).attempt).toBeUndefined();expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('detects changes during capture setup before the final gesture',async()=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter);f.page.startNetworkCapture.mockImplementation(async()=>{f.live.settingsHash='changed';return true;});await expect(imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter)).rejects.toMatchObject({code:'EDITOR_CHANGED'});expect((await f.read()).attempt).toBeUndefined();expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('preserves unknown on a possible dispatch failure and never tries another gesture',async()=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter);f.adapter.trigger.mockRejectedValue(new Error('connection lost after dispatch'));const [s]=await imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter);expect(s).toMatchObject({status:'result_unknown',submitted:null});expect(f.adapter.trigger).toHaveBeenCalledTimes(1);await expect(imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter)).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});});
 it.each(['missing','multiple','unknown'])('does not infer success for %s receipts',async mode=>{const f=await fixture(),[r]=await imageJobAction(f.page,{review:id},f.adapter);f.page.readNetworkCapture.mockResolvedValue(mode==='missing'?[]:mode==='multiple'?[f.response,f.response]:[{...f.response,responsePreview:'{"data":{"other":"secret"}}'}]);const [s]=await imageJobAction(f.page,{submit:id,confirm:r.confirmation},f.adapter);expect(s.status).toBe('result_unknown');expect(s.submitted).toBeNull();expect(JSON.stringify((await f.read()).receipt??null)).not.toContain('secret');});
 it('keeps an unsubmitted job local without leaving the prepared editor',async()=>{const f=await fixture();const [s]=await imageJobAction(f.page,{status:id},f.adapter);expect(s.status).toBe('ready_for_confirmation');expect(f.adapter.query).not.toHaveBeenCalled();expect(f.page.setActivePage).not.toHaveBeenCalled();});
 it('uses exact content IDs and retains known status on query misses',async()=>{const f=await fixture();await fs.writeFile(f.file,JSON.stringify({...f.job,attempt:{id:'once'},status:'accepted',submitted:true,receipt:{status:'accepted',contentId:'a'.repeat(24)}}));f.adapter.query.mockResolvedValue({status:'not_found'});const [s]=await imageJobAction(f.page,{status:id},f.adapter);expect(s.status).toBe('accepted');expect(s.query_status).toBe('not_found');expect(f.adapter.trigger).not.toHaveBeenCalled();});
});
describe('image live inspection and final control',()=>{
 function snapshot(){}const assert=vi.fn();
 const state={images:[{uploadIdSha256:'first'},{uploadIdSha256:'second'}],declarations:['笔记含AI合成内容'],visibilityPublic:true,scheduled:false};
 const job={manifest:{title:'咖啡',body:'正文',accountId:'123'},assets:[],preparedAccount:{id:'123',name:'账号'},checks:{images:state.images}};
 const context={url:'https://creator.xiaohongshu.com/publish/publish',publishHandlerAvailable:true,settingsHash:'b'.repeat(64)};
 it('returns only fingerprints and public account information',async()=>{const p={evaluate:vi.fn().mockResolvedValueOnce(state).mockResolvedValueOnce({account:{id:'123',name:'账号'}}).mockResolvedValueOnce(context)};const r=await makeImageAdapter(snapshot,assert).inspect(p,job);expect(r).toMatchObject({account:{id:'123'},title:'咖啡'});expect(r.mediaHash).toMatch(/^[a-f0-9]{64}$/);});
 it('rejects an account switch before returning a review',async()=>{const p={evaluate:vi.fn().mockResolvedValueOnce(state).mockResolvedValueOnce({account:{id:'other',name:'other'}})};await expect(makeImageAdapter(snapshot,assert).inspect(p,job)).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});});
 it('rejects replacement uploads even if they contain the same files',async()=>{const changed={...state,images:[{uploadIdSha256:'replacement'},{uploadIdSha256:'second'}]};const p={evaluate:vi.fn().mockResolvedValueOnce(changed).mockResolvedValueOnce({account:{id:'123',name:'账号'}})};await expect(makeImageAdapter(snapshot,assert).inspect(p,job)).rejects.toMatchObject({code:'UPLOADED_IMAGES_CHANGED'});});
 it('does not try a fallback publish method on an invocation failure',async()=>{const p={evaluateOnce:vi.fn().mockRejectedValue(new Error('possible dispatch')),click:vi.fn()};await expect(makeImageAdapter(snapshot,assert).trigger(p)).rejects.toThrow();expect(p.evaluateOnce).toHaveBeenCalledTimes(1);expect(p.click).not.toHaveBeenCalled();});
 it('requires positive image evidence when interpreting a manager record',()=>{expect(xhsManagerRecordType({type:'video',images_list:[{}]})).toBe('video');expect(xhsManagerRecordType({type:'normal',images_list:[{}]})).toBe('image');for(const r of [{type:'normal'},{type:'normal',images_list:[]},{type:'unknown',images_list:[{}]}])expect(xhsManagerRecordType(r)).toBeNull();});
 it('parses only success envelopes; never treats a title or draft ID as a receipt ID',()=>{const e=body=>({url:'https://creator.xiaohongshu.com/web_api/sns/v2/note',method:'POST',responseStatus:200,responsePreview:JSON.stringify(body)});expect(parseReceipt('xiaohongshu',e({code:0,success:true,data:{note_id:'a'.repeat(24)}}))).toMatchObject({status:'accepted',contentId:'a'.repeat(24)});expect(parseReceipt('xiaohongshu',e({code:0,success:true,data:{draftId:'a'.repeat(24),title:'咖啡'}}))).toMatchObject({status:'accepted',contentId:null});});
});

describe('image manager lifecycle queries (synthetic signed list fixtures)',()=>{
 function managerPage(targetTab,record,account='123'){
  let selected='0';
  const p={tabs:vi.fn(async()=>[{page:'manager',url:'https://creator.xiaohongshu.com/new/note-manager'}]),setActivePage:vi.fn(),focusWindow:vi.fn(),wait:vi.fn(),click:vi.fn(),goto:vi.fn(),newTab:vi.fn()};
  p.evaluate=vi.fn(async code=>{
   if(code.startsWith('!!document.querySelector('))return false;
   if(code.includes('document.querySelectorAll')&&code.includes('.tab-list .tab-item'))return true;
   if(code.includes('async function managerAccount'))return {account:{id:account,name:'账号'}};
   if(code==='window.__bycliReadCapture?.entries || []')return [{url:`https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted?tab=${selected}&page=0`,method:'GET',responseStatus:200,responsePreview:JSON.stringify({code:0,success:true,data:{notes:selected===targetTab?[record]:[]}})}];
   if(code.includes('return nodes.length')){for(const [label,tab]of [['已发布','1'],['审核中','2'],['未通过','3']])if(code.includes(JSON.stringify(label)))selected=tab;return 1;}
   if(code.includes('window.__bycliReadCapture'))return undefined;
   throw Error('Unexpected query script');
  });return p;
 }
 const job={contentType:'image',receipt:{contentId:'a'.repeat(24)},review:{account:{id:'123'}}};
 it.each([['1','published'],['2','reviewing'],['3','rejected']])('uses filter %s for %s, without interpreting tab_status as publication state',async(tab,status)=>{const p=managerPage(tab,{id:'a'.repeat(24),type:'normal',images_list:[{}],tab_status:999});const state=await makeImageAdapter(null,null).query(p,job);expect(state).toMatchObject({status,contentId:'a'.repeat(24),contentType:'image'});expect(p.newTab).not.toHaveBeenCalled();});
 it('does not accept an unrelated exact-ID video record as a published image',async()=>{const p=managerPage('1',{id:'a'.repeat(24),type:'video'});expect(await makeImageAdapter(null,null).query(p,job)).toMatchObject({status:'query_unavailable'});});
 it('does not infer deletion or zero data from first-page misses',async()=>{const p=managerPage('1',{id:'b'.repeat(24),type:'normal',images_list:[{}]});expect(await makeImageAdapter(null,null).query(p,job)).toMatchObject({status:'not_found'});});
 it('refuses manager results from another account',async()=>{const p=managerPage('1',{id:'a'.repeat(24),type:'normal',images_list:[{}]},'other');await expect(makeImageAdapter(null,null).query(p,job)).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});});
});


describe('code-optional XHS receipt compatibility after first live publication',()=>{
 const entry=body=>({url:'https://creator.xiaohongshu.com/web_api/sns/v2/note',method:'POST',responseStatus:200,responsePreview:JSON.stringify(body)});
 it('accepts only literal success=true when the business code is absent',()=>{expect(parseReceipt('xiaohongshu',entry({success:true,data:{id:'a'.repeat(24)},msg:'ok'}))).toMatchObject({status:'accepted',contentId:'a'.repeat(24),code:null,businessCodePresent:false,successSignal:'explicit_success_without_code'});});
 it.each([1,'true',null])('does not treat a nonboolean success flag %j as acceptance',success=>expect(parseReceipt('xiaohongshu',entry({success,data:{id:'a'.repeat(24)}})).status).toBe('result_unknown'));
 it('rejects explicit failure without code and preserves contradictory code as unknown',()=>{expect(parseReceipt('xiaohongshu',entry({success:false,data:{}}))).toMatchObject({status:'rejected',platformSuccess:false,businessCodePresent:false});expect(parseReceipt('xiaohongshu',entry({code:400,success:true,data:{id:'a'.repeat(24)}})).status).toBe('result_unknown');});
 it('keeps safe diagnostics without persisting arbitrary data',()=>{const r=parseReceipt('xiaohongshu',entry({data:{id:'a'.repeat(24),token:'secret'},success:null}));expect(r).toMatchObject({status:'result_unknown',dataFields:['id'],platformSuccess:null});expect(JSON.stringify(r)).not.toContain('secret');});
});
