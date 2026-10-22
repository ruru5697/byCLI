import {describe,it,expect,vi} from 'vitest';import {parseArticleReceipt,PUBLISH_PATH,articleJobAction} from './_article-submit.js';
const entry=(body,patch={})=>({url:'https://api.juejin.cn'+PUBLISH_PATH,method:'POST',responseStatus:200,responsePreview:JSON.stringify(body),...patch});
describe('Juejin article receipts',()=>{
 it('requires explicit business success and preserves exact long IDs',()=>expect(parseArticleReceipt(entry({err_no:0,data:{article_id:'7698184228387405858',user_id:'3260521601040640'}}))).toMatchObject({status:'accepted',contentId:'7698184228387405858',accountId:'3260521601040640'}));
 it.each([{url:'https://evil.example'+PUBLISH_PATH},{url:'https://api.juejin.cn.evil.example'+PUBLISH_PATH},{url:'http://api.juejin.cn'+PUBLISH_PATH},{method:'GET'},{url:'https://api.juejin.cn/content_api/v1/article_draft/update'}])('ignores unrelated request %j',patch=>expect(parseArticleReceipt(entry({err_no:0},patch))).toBeNull());
 it.each([{},[],null,{success:true},{err_no:'0'}])('keeps unknown envelope unknown %j',b=>expect(parseArticleReceipt(entry(b)).status).toBe('result_unknown'));
 it('treats explicit error as rejected',()=>expect(parseArticleReceipt(entry({err_no:1001})).status).toBe('rejected'));
 it('does not trust HTTP failure even with err_no=0',()=>expect(parseArticleReceipt(entry({err_no:0},{responseStatus:500})).status).toBe('result_unknown'));
 it('does not invent an ID from an unsafe number',()=>expect(parseArticleReceipt(entry({err_no:0,data:{article_id:7698184228387405858}})).contentId).toBeNull());
 it('does not parse truncated data',()=>expect(parseArticleReceipt(entry({err_no:0},{responseBodyTruncated:true})).status).toBe('result_unknown'));
 it.each([{}, {review:'x',submit:'y'},{prepare:true,review:'x'},{review:'x',confirm:'token'}])('rejects ambiguous command before browser use %j',async a=>{const p={goto:vi.fn()};await expect(articleJobAction(p,a,vi.fn())).rejects.toThrow();expect(p.goto).not.toHaveBeenCalled()});
});

describe('single final gesture',()=>{
 it('validates exact account, body and control before clicking once',async()=>{
  const {finalArticleGesture}=await import('./_article-submit.js');const click=vi.fn(),expected={url:'https://juejin.cn/editor/drafts/123',accountId:'456',title:'title',body:'body',attemptId:'attempt'};
  const vm={active:true,post:{title:'title',markdown:'body'}},root={$store:{state:{auth:{user:{user_id:'456'}}}}};
  vi.stubGlobal('window',{});vi.stubGlobal('location',{origin:'https://juejin.cn',pathname:'/editor/drafts/123'});
  vi.stubGlobal('document',{querySelector:s=>s==='.publish-popup'?{__vue__:vm}:{__vue__:root},querySelectorAll:()=>[{innerText:'确定并发布',getBoundingClientRect:()=>({width:100}),disabled:false,click}]});
  try{expect(finalArticleGesture(expected,true)).toMatchObject({valid:true});expect(click).not.toHaveBeenCalled();finalArticleGesture(expected);expect(click).toHaveBeenCalledTimes(1);expect(window.__bycliArticleGesture.phase).toBe('dispatched');vm.active=false;expect(()=>finalArticleGesture(expected)).toThrow('before dispatch');expect(click).toHaveBeenCalledTimes(1);expect(window.__bycliArticleGesture.phase).toBe('preflight_failed');}finally{vi.unstubAllGlobals()}
 });
});

// Exercise the durable boundary with a real private job file and controlled browser failures.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function publishingFixture(action){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-juejin-submit-'));vi.stubEnv('BYCLI_CONFIG_DIR',dir);
 try{
  const id='11111111-1111-4111-8111-111111111111',jobDir=path.join(dir,'publish-jobs','juejin',id);await fs.mkdir(jobDir,{recursive:true});const cover=path.join(dir,'cover.png');await fs.writeFile(cover,'cover');
  const manifest={title:'测试文章',body:'## body',summary:'这是一篇用于验证发布边界的文章，检查本地记录是否先于最终动作写入，以及网络异常时是否会阻止再次提交。',cover,category:'代码人生',tags:['程序员'],columns:[],topics:[],visibility:'public',accountId:'456'};
  const job={jobId:id,platform:'juejin',contentType:'article',draftId:'789',status:'ready_for_confirmation',submitted:false,manifest,assets:{cover:{path:cover,sha256:sha('cover'),bytes:5,width:1200,height:800}},upload:{sha256:sha('cover'),bytes:5,hash:'cover-binding'},inputSha256:sha(JSON.stringify(manifest))};
  const file=path.join(jobDir,'job.json');await fs.writeFile(file,JSON.stringify(job));
  const snapshot={draftId:'789',url:'https://juejin.cn/editor/drafts/789',account:{id:'456',name:'test'},title:manifest.title,body:manifest.body,bodySha256:sha(manifest.body),modelMatches:true,category:manifest.category,categoryId:'100',categorySelected:[manifest.category],tags:[{id:'200',title:'程序员'}],summary:manifest.summary,modelSummary:manifest.summary,columns:[],topics:[],topicState:[],syncToOrg:false,cover:{present:true,visible:true,loaded:true,matchesModel:true,width:1200,height:800,updating:false,hash:'cover-binding'},panelOpen:true,finalControlPresent:true,finalControlDisabled:false,status:'editing'};
  const page={tabs:async()=>[{page:'one'}],setActivePage:vi.fn(),focusWindow:vi.fn(),evaluate:vi.fn(async code=>code.includes('articleSnapshot')?structuredClone(snapshot):code==='location.origin+location.pathname'?snapshot.url:code.includes('const p=document.querySelector')?'extra-hash':true),startNetworkCapture:vi.fn(async()=>true),evaluateOnce:vi.fn(async()=>{const current=JSON.parse(await fs.readFile(file));expect(current.status).toBe('submitting');expect(current.attempt.id).toBeTruthy();return true}),wait:vi.fn(),readNetworkCapture:vi.fn(async()=>[entry({err_no:0,data:{article_id:'123',user_id:'456'}})])};
  const reviewed=await articleJobAction(page,{review:id},vi.fn());await action({id,file,page,snapshot,token:reviewed[0].confirmation,job});
 }finally{vi.unstubAllEnvs();await fs.rm(dir,{recursive:true,force:true})}
}
describe('durable article submit lifecycle',()=>{
 it('writes attempt before exactly one final gesture and never resubmits accepted tasks',()=>publishingFixture(async f=>{const r=await articleJobAction(f.page,{submit:f.id,confirm:f.token},vi.fn());expect(r[0]).toMatchObject({status:'accepted',submitted:true,content_id:'123'});await expect(articleJobAction(f.page,{submit:f.id,confirm:f.token},vi.fn())).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});expect(f.page.evaluateOnce).toHaveBeenCalledTimes(1);}));
 it('blocks wrong confirmation without consuming an attempt',()=>publishingFixture(async f=>{await expect(articleJobAction(f.page,{submit:f.id,confirm:'wrong'},vi.fn())).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});expect(JSON.parse(await fs.readFile(f.file)).attempt).toBeUndefined();expect(f.page.evaluateOnce).not.toHaveBeenCalled();}));
 it.each(['2000-01-01T00:00:00Z','invalid'])('blocks expired or invalid confirmation %s',expires=>publishingFixture(async f=>{const j=JSON.parse(await fs.readFile(f.file));j.review.expiresAt=expires;await fs.writeFile(f.file,JSON.stringify(j));await expect(articleJobAction(f.page,{submit:f.id,confirm:f.token},vi.fn())).rejects.toMatchObject({code:'CONFIRMATION_EXPIRED'});expect(f.page.evaluateOnce).not.toHaveBeenCalled();}));
 it('blocks modified cover bytes',()=>publishingFixture(async f=>{await fs.writeFile(f.job.manifest.cover,'changed');await expect(articleJobAction(f.page,{submit:f.id,confirm:f.token},vi.fn())).rejects.toMatchObject({code:'ASSET_CHANGED'});expect(f.page.evaluateOnce).not.toHaveBeenCalled();}));
 it('retains unknown after final transport failure and forbids retry',()=>publishingFixture(async f=>{f.page.evaluateOnce.mockRejectedValue(new Error('transport disconnected'));const r=await articleJobAction(f.page,{submit:f.id,confirm:f.token},vi.fn());expect(r[0].status).toBe('result_unknown');await expect(articleJobAction(f.page,{review:f.id},vi.fn())).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});expect(f.page.evaluateOnce).toHaveBeenCalledTimes(1);}));
 it('does not treat capture failure as a submission attempt',()=>publishingFixture(async f=>{f.page.startNetworkCapture.mockResolvedValue(false);await expect(articleJobAction(f.page,{submit:f.id,confirm:f.token},vi.fn())).rejects.toMatchObject({code:'CAPTURE_UNAVAILABLE'});expect(JSON.parse(await fs.readFile(f.file)).attempt).toBeUndefined();expect(f.page.evaluateOnce).not.toHaveBeenCalled();}));
});
