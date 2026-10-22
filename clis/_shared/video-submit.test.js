import { describe,it,expect,vi,afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { digest, parseReceipt, videoJobAction, withJob, sohuStatuses } from './video-submit.js';
const id='8e30aadf-ab81-43db-9e02-3de24d9fb02a';
const dirs=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const d of dirs.splice(0))await fs.rm(d,{recursive:true,force:true});});
async function fixture(){
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-submit-'));dirs.push(d);vi.stubEnv('BYCLI_CONFIG_DIR',d);
 const manifest={video:path.join(d,'v.mp4'),cover:path.join(d,'c.png'),title:'发布验证',body:'合成素材测试',visibility:'public',declaration:'none'};
 const assets={};for(const key of ['video','cover']){await fs.writeFile(manifest[key],key);assets[key]={sha256:createHash('sha256').update(key).digest('hex')};}
 const dir=path.join(d,'publish-jobs/xiaohongshu',id);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'job.json');
 const job={jobId:id,platform:'xiaohongshu',contentType:'video',status:'ready_for_confirmation',submitted:false,pageTarget:'target',manifest,assets,inputSha256:digest({manifest,assets})};
 await fs.writeFile(file,JSON.stringify(job));
 const live={account:{id:'123',name:'测试账号'},mediaHash:'media',settingsHash:'settings'};
 const adapter={inspect:vi.fn(async()=>live),trigger:vi.fn(),query:vi.fn()};
 const entry={url:'https://creator.xiaohongshu.com/web_api/sns/v2/note',method:'POST',responseStatus:200,responsePreview:JSON.stringify({code:0,success:true,data:{id:'a'.repeat(24)}})};
 const page={tabs:async()=>[{page:'target'}],setActivePage:vi.fn(),focusWindow:vi.fn(),screenshot:async({path:p})=>fs.writeFile(p,'preview'),startNetworkCapture:vi.fn(async()=>true),readNetworkCapture:vi.fn(async()=>[entry]),wait:vi.fn()};
 return {file,job,adapter,page,live,entry,read:async()=>JSON.parse(await fs.readFile(file,'utf8'))};
}
const response=(body,patch={})=>({url:'https://mp.sohu.com/mpbp/bp/news/v4/news/publishVideo/v2',method:'POST',responseStatus:200,responsePreview:JSON.stringify(body),...patch});
describe('strict publish receipts',()=>{
 it('accepts only exact POST endpoint and allowed origin',()=>{for(const patch of [{method:'GET'},{url:'https://evil.test/mpbp/bp/news/v4/news/publishVideo/v2'},{url:'https://mp.sohu.com/wrong'},{url:'http://mp.sohu.com/mpbp/bp/news/v4/news/publishVideo/v2'}])expect(parseReceipt('sohu',response({code:2000000,data:123},patch))).toBeNull();});
 it('waits for response and treats incomplete, malformed and HTTP failures as unknown',()=>{expect(parseReceipt('sohu',response({}, {responseStatus:undefined}))).toBeNull();for(const patch of [{responseBodyTruncated:true},{responsePreview:'<html>error'},{responseStatus:500}])expect(parseReceipt('sohu',response({code:2000000,data:123},patch)).status).toBe('result_unknown');});
 it('distinguishes acceptance from publication and preserves only whitelisted fields',()=>{const r=parseReceipt('sohu',response({code:2000000,data:123,token:'secret'}));expect(r).toMatchObject({status:'accepted',contentId:'123'});expect(JSON.stringify(r)).not.toContain('secret');});
 it('does not use unsafe numeric IDs or unknown response IDs',()=>{expect(parseReceipt('sohu',response({code:2000000,data:9007199254740992})).contentId).toBeNull();expect(parseReceipt('sohu',response({code:2000000,data:{videoId:123}})).contentId).toBeNull();});
 it('distinguishes explicit business failure from unknown JSON',()=>{expect(parseReceipt('sohu',response({code:4003003})).status).toBe('rejected');expect(parseReceipt('sohu',response({message:'ok'})).status).toBe('result_unknown');});
 it('uses per-record Sohu status definitions rather than filter numbers',()=>{expect(sohuStatuses[4]).toBe('published');expect(sohuStatuses[2]).toBe('reviewing');expect(sohuStatuses[1]).toBe('draft');});
});
describe('review and one-shot submission',()=>{
 it('reviews without clicking, records account/content and owner-only preview',async()=>{const f=await fixture();const [r]=await videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter);expect(r.confirmation).toBeTruthy();expect(f.adapter.trigger).not.toHaveBeenCalled();const j=await f.read();expect(j.review.content.title).toBe(f.job.manifest.title);if(process.platform!=='win32') expect((await fs.stat(j.review.preview)).mode&0o777).toBe(0o600);});
 it('requires exact confirmation before capturing or clicking',async()=>{const f=await fixture();await expect(videoJobAction(f.page,{submit:id,confirm:'wrong'},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});expect(f.page.startNetworkCapture).not.toHaveBeenCalled();expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('persists attempt before gesture, captures ID and refuses repeat even on success',async()=>{const f=await fixture();const [r]=await videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter);f.adapter.trigger.mockImplementation(async()=>{expect((await f.read()).attempt.id).toBeTruthy();});const [s]=await videoJobAction(f.page,{submit:id,confirm:r.confirmation},'xiaohongshu',f.adapter);expect(s).toMatchObject({status:'accepted',submitted:true,content_id:'a'.repeat(24)});await expect(videoJobAction(f.page,{submit:id,confirm:r.confirmation},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});expect(f.adapter.trigger).toHaveBeenCalledTimes(1);});
 it('records unknown if gesture throws after possible dispatch and never retries',async()=>{const f=await fixture();const [r]=await videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter);f.adapter.trigger.mockRejectedValue(new Error('disconnected'));expect((await videoJobAction(f.page,{submit:id,confirm:r.confirmation},'xiaohongshu',f.adapter))[0].status).toBe('result_unknown');expect(f.adapter.trigger).toHaveBeenCalledTimes(1);expect((await f.read()).attempt).toBeTruthy();});
 it.each(['account','mediaHash','settingsHash'])('rejects changed %s after review',async(key)=>{const f=await fixture();const [r]=await videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter);f.live[key]=key==='account'?{id:'other',name:'other'}:'changed';await expect(videoJobAction(f.page,{submit:id,confirm:r.confirmation},'xiaohongshu',f.adapter)).rejects.toThrow();expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('rejects expired confirmation and unavailable capture',async()=>{const f=await fixture();const [r]=await videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter);let j=await f.read();j.review.expiresAt='2000-01-01';await fs.writeFile(f.file,JSON.stringify(j));await expect(videoJobAction(f.page,{submit:id,confirm:r.confirmation},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'CONFIRMATION_EXPIRED'});const [r2]=await videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter);f.page.startNetworkCapture.mockResolvedValue(false);await expect(videoJobAction(f.page,{submit:id,confirm:r2.confirmation},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'CAPTURE_UNAVAILABLE'});expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('detects changed local assets and missing editor',async()=>{const f=await fixture();await fs.appendFile(f.job.manifest.video,'changed');await expect(videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'ASSET_CHANGED'});f.page.tabs=async()=>[];await expect(videoJobAction(f.page,{review:id},'xiaohongshu',f.adapter)).rejects.toMatchObject({code:'EDITOR_MISSING'});});
 it('status never clicks and preserves accepted state on list miss',async()=>{const f=await fixture();const j={...f.job,status:'accepted',submitted:true,receipt:{contentId:'a'.repeat(24)}};await fs.writeFile(f.file,JSON.stringify(j));f.adapter.query.mockResolvedValue({status:'not_found'});const [r]=await videoJobAction(f.page,{status:id},'xiaohongshu',f.adapter);expect(r.status).toBe('accepted');expect((await f.read()).lastQuery.status).toBe('not_found');expect(f.adapter.trigger).not.toHaveBeenCalled();});
 it('recovers interrupted durable attempt as unknown and never queries by title',async()=>{const f=await fixture();await fs.writeFile(f.file,JSON.stringify({...f.job,status:'submitting',attempt:{id:'attempt'}}));expect((await videoJobAction(f.page,{status:id},'xiaohongshu',f.adapter))[0].status).toBe('result_unknown');expect(f.adapter.query).not.toHaveBeenCalled();});
 it('enforces job lock and prevents traversal',async()=>{const f=await fixture();await fs.writeFile(f.file+'.lock','');await expect(withJob('xiaohongshu',id,vi.fn())).rejects.toMatchObject({code:'JOB_BUSY'});await expect(withJob('xiaohongshu','../../x',vi.fn())).rejects.toThrow();});
});

// Real manager endpoints were observed with empty lists; record fixtures remain synthetic.
import { parseManagerList, makeVideoAdapter } from './video-site-submit.js';
describe('manager list isolation and final gesture',()=>{
 it('requires the exact account/video list and explicit platform success',()=>{
  const e={url:'https://mp.sohu.com/mpbp/bp/news/v4/users/news?newsType=4&accountId=123',method:'GET',responseStatus:200,responsePreview:JSON.stringify({code:2000000,success:true,data:{videos:[{id:456,status:2}]}})};
  expect(parseManagerList('sohu',e,{accountId:'123'})).toEqual([{id:456,status:2}]);
  expect(parseManagerList('sohu',e,{accountId:'other'})).toBeNull();
  expect(parseManagerList('sohu',{...e,url:e.url.replace('newsType=4','newsType=3')},{accountId:'123'})).toBeNull();
  expect(parseManagerList('sohu',{...e,responseBodyTruncated:true},{accountId:'123'})).toBeNull();
 });
 it('binds XHS status to the actual selected tab, without guessing numeric note states',()=>{
  const e={url:'https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted?tab=2&page=0',method:'GET',responseStatus:200,responsePreview:JSON.stringify({code:0,success:true,data:{notes:[{note_id:'a'.repeat(24)}]}})};
  expect(parseManagerList('xiaohongshu',e,{tab:'2'})).toHaveLength(1);
  expect(parseManagerList('xiaohongshu',e,{tab:'1'})).toBeNull();
 });
 it('never tries another publish method after an invocation failure',async()=>{
  const p={evaluateOnce:vi.fn().mockRejectedValue(new Error('possibly dispatched')),click:vi.fn()};
  await expect(makeVideoAdapter('xiaohongshu',()=>{}).trigger(p)).rejects.toThrow();
  expect(p.evaluateOnce).toHaveBeenCalledTimes(1);expect(p.click).not.toHaveBeenCalled();
 });
});
describe('live submission preflight',()=>{
 const manifest={title:'测试发布',body:'合成素材',declaration:'none'};
 const snapshot={title:manifest.title,body:manifest.body,videoReady:true,customCoverPresent:true,coverDialogClosed:true,publishEnabled:true,visibilityPublic:true,declarationLabels:['添加内容类型声明']};
 const context={account:{id:'123',name:'账号'},url:'https://creator.xiaohongshu.com/publish/publish',scheduled:false,cover:'url(https://cdn.test/signed?secret=1)',uploadIdentity:'video:cover',video:[],controls:[],editorText:'editor'};
 it.each([{scheduled:true},{scheduled:undefined},{uploadIdentity:null},{account:null}])('rejects unverified required context %j',async(patch)=>{
  const p={evaluate:vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce({...context,...patch})};
  await expect(makeVideoAdapter('xiaohongshu',()=>{}).inspect(p,{manifest})).rejects.toThrow();
 });
 it('returns hashes and public account identity without signed URLs',async()=>{
  const p={evaluate:vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(context)};
  const r=await makeVideoAdapter('xiaohongshu',()=>{}).inspect(p,{manifest});
  expect(r.account.id).toBe('123');expect(r.mediaHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(r)).not.toContain('secret');
 });
});
describe('verified manager reconciliation',()=>{
 it('queries a separately verified ID while retaining the original unknown receipt',async()=>{
  const f=await fixture();const receipt={status:'result_unknown',code:null};
  await fs.writeFile(f.file,JSON.stringify({...f.job,status:'reviewing',submitted:true,attempt:{id:'one'},receipt,reconciliation:{contentId:'b'.repeat(24),source:'verified_manager_record'}}));
  f.adapter.query.mockResolvedValue({status:'reviewing',contentId:'b'.repeat(24)});
  const [r]=await videoJobAction(f.page,{status:id},'xiaohongshu',f.adapter);
  expect(r).toMatchObject({status:'reviewing',content_id:'b'.repeat(24),receipt_status:'result_unknown',identity_source:'verified_manager_record'});
  expect((await f.read()).receipt).toEqual(receipt);expect(f.adapter.trigger).not.toHaveBeenCalled();
 });
});
