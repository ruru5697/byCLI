import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {JSDOM} from 'jsdom';
import {draftReceipt,saveControl,draftAction} from './_draft.js';
import {digest,managers} from '../_shared/video-submit.js';
const dirs=[];afterEach(async()=>{vi.unstubAllEnvs();vi.useRealTimers();for(const d of dirs.splice(0))await fs.rm(d,{recursive:true,force:true})});
const id='11111111-1111-4111-8111-111111111111';
const entry=(patch={})=>({url:'https://mp.sohu.com/mpbp/bp/news/v4/news/save/v2',method:'POST',responseStatus:200,responsePreview:JSON.stringify({code:2000000,success:true,data:{id:'99',token:'secret'}}),...patch});
async function fixture(type='article',options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-draft-'));dirs.push(dir);vi.stubEnv('BYCLI_CONFIG_DIR',dir);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-22T09:00:00Z'));
 const asset=path.join(dir,'image.png');await fs.writeFile(asset,'fixture');
 const {createHash}=await import('node:crypto');const a={path:asset,sha256:createHash('sha256').update('fixture').digest('hex')};
 const job={jobId:id,platform:'sohu',contentType:type,status:'ready_for_confirmation',pageTarget:'editor',preparedAccount:{id:'123',name:'account'},manifest:{title:'一个草稿标题',cover:asset,images:type==='gallery'?[{path:asset,description:'配文'}]:[asset]},assets:{images:[a],cover:a}};
 job.inputSha256=digest({manifest:job.manifest,assets:job.assets});const d=path.join(dir,'publish-jobs/sohu',id);await fs.mkdir(d,{recursive:true});const file=path.join(d,'job.json');await fs.writeFile(file,JSON.stringify(job));
 let afterClick=false,current='editor',closed=false;
 const page={tabs:vi.fn(async()=>closed?[]:[{page:'editor',url:afterClick?managers.sohu:'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle'}]),setActivePage:vi.fn(),getActivePage:()=>current,focusWindow:vi.fn(),goto:vi.fn(async()=>{current='restored'}),wait:async()=>vi.setSystemTime(Date.now()+500),nativeClickOnce:vi.fn(async()=>{expect(JSON.parse(await fs.readFile(file)).draftSaveAttempt).toBeTruthy();afterClick=true;if(options.gestureError)throw Error('lost response')}),evaluate:vi.fn(async code=>{
  if(code.includes('function saveControl'))return {x:10,y:20,draftId:null};
  if(code.includes('ids:'))return {url:options.noAck?'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle':managers.sohu,draftId:null,ids:options.noAck?[]:['99']};
  if(code.includes('records.find'))return {id:'99',type:options.wrongType?4:type==='gallery'?3:2,status:options.published?4:1};
  if(code.includes('managerAccount'))return {account:{id:options.wrongAccount?'456':'123',name:'account'}};
  return true;
 })};
 const adapter={inspect:vi.fn(async(p,j)=>{if(options.changedRestore&&j.draftVerification)throw Error('changed image');return {account:{id:'123',name:'account'},draftId:j.remoteDraftId||null,mediaHash:'media',settingsHash:'settings'}})};
 return {page,adapter,job,file,read:async()=>JSON.parse(await fs.readFile(file)),close:()=>{closed=true},action:args=>draftAction(page,args,type,adapter)};
}
describe('draft save response identity',()=>{
 it('returns only an exact ID, never response secrets',()=>{expect(draftReceipt(entry())).toEqual({draftId:'99'});const dom=new JSDOM('',{runScripts:'outside-only'});try{expect(dom.window.eval(`(${draftReceipt.toString()})(${JSON.stringify(entry())})`)).toEqual({draftId:'99'})}finally{dom.window.close()}});
 it.each([{url:'https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2'},{url:'https://evil.test/mpbp/bp/news/v4/news/save/v2'},{method:'GET'},{responseStatus:500},{responseBodyTruncated:true},{responsePreview:JSON.stringify({code:2000000,success:true,data:9007199254740992})},{responsePreview:JSON.stringify({code:2000000,data:'99'})}])('rejects untrusted/ambiguous receipt %j',patch=>expect(draftReceipt(entry(patch))).toBeNull());
});
describe.each(['article','gallery'])('%s draft lifecycle',type=>{
 it('persists before one native click, verifies owner draft status and reopens exact ID',async()=>{const f=await fixture(type);expect(await f.action({saveDraft:id})).toMatchObject([{status:'draft_saved',remote_draft_id:'99',submitted:false}]);expect(f.page.nativeClickOnce).toHaveBeenCalledTimes(1);expect(f.page.goto).toHaveBeenCalledWith(expect.stringContaining('?id=99'),{stealth:false});expect((await f.read()).pageTarget).toBe('restored');expect((await f.action({saveDraft:id}))[0]).toMatchObject({status:'draft_saved',remote_draft_id:'99'});expect(f.page.nativeClickOnce).toHaveBeenCalledTimes(1);expect(JSON.stringify(await f.read())).not.toContain('secret')});
 it('reconciles a lost native click response without replay',async()=>{const f=await fixture(type,{gestureError:true});expect((await f.action({saveDraft:id}))[0].status).toBe('draft_saved');expect((await f.read()).draftSaveAttempt.gestureUncertain).toBe(true);expect(f.page.nativeClickOnce).toHaveBeenCalledTimes(1)});
 it.each([{wrongType:true},{published:true},{wrongAccount:true},{changedRestore:true}])('does not claim saved content for %j',async patch=>{const f=await fixture(type,patch);expect((await f.action({saveDraft:id}))[0].status).toBe('draft_save_unknown');expect((await f.read()).remoteDraftId).toBeUndefined()});
 it('retains an unconfirmed editor, and status reconciliation never repeats the click',async()=>{const f=await fixture(type,{noAck:true});expect((await f.action({saveDraft:id}))[0].status).toBe('draft_save_unknown');expect(f.page.goto).not.toHaveBeenCalled();await expect(f.action({saveDraft:id})).rejects.toMatchObject({code:'DRAFT_SAVE_ALREADY_ATTEMPTED'});expect((await f.action({draftStatus:id}))[0].status).toBe('draft_save_unknown');expect(f.page.nativeClickOnce).toHaveBeenCalledTimes(1)});
 it('rejects publication attempts and mixed modes before input',async()=>{const f=await fixture(type);await fs.writeFile(f.file,JSON.stringify({...f.job,attempt:{id:'published'}}));await expect(f.action({saveDraft:id})).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});await expect(f.action({saveDraft:id,submit:id})).rejects.toThrow();expect(f.page.nativeClickOnce).not.toHaveBeenCalled()});
 it('reopens a verified draft after closing the old editor',async()=>{const f=await fixture(type);await f.action({saveDraft:id});f.close();expect((await f.action({openDraft:id}))[0]).toMatchObject({status:'draft_saved',remote_draft_id:'99'});expect(f.page.nativeClickOnce).toHaveBeenCalledTimes(1)});
});
describe('exact native draft save target',()=>{
 function fixtureDom(blocked=false){
  const dom=new JSDOM('<div id="app"></div><input placeholder="请输入标题（5-72字）" value="一个草稿标题"><ul class="bottom-button"><li>发布</li><li>存草稿</li><li>预览</li></ul>',{url:'https://mp.sohu.com/mpfe/v4/contentManagement/news/addatlas',runScripts:'outside-only'});const w=dom.window;w.document.querySelector('#app').__vue__={$store:{state:{app:{userInfo:{id:'123'}}}}};Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:30,left:10,top:20});w.HTMLElement.prototype.scrollIntoView=vi.fn();w.document.elementFromPoint=()=>blocked?w.document.querySelector('.bottom-button li'):w.document.querySelectorAll('.bottom-button li')[1];return dom;
 }
 it('measures only 存草稿 and does not dispatch any DOM click',()=>{const d=fixtureDom(),click=vi.fn();d.window.document.querySelectorAll('li').forEach(e=>e.addEventListener('click',click));try{expect(d.window.eval(`(${saveControl.toString()})(${JSON.stringify({url:'https://mp.sohu.com/mpfe/v4/contentManagement/news/addatlas',account:'123',title:'一个草稿标题'})})`)).toMatchObject({x:60,y:35});expect(click).not.toHaveBeenCalled()}finally{d.window.close()}});
 it('refuses a save button obscured by the publish button',()=>{const d=fixtureDom(true);try{expect(()=>d.window.eval(`(${saveControl.toString()})(${JSON.stringify({url:'https://mp.sohu.com/mpfe/v4/contentManagement/news/addatlas',account:'123',title:'一个草稿标题'})})`)).toThrow(/obscured/)}finally{d.window.close()}});
});

describe('draft status preserves subsequent editor changes',()=>{
 it('does not navigate away from changed content during reconciliation',async()=>{
  const f=await fixture('article',{noAck:true});await f.action({saveDraft:id});
  const j=await f.read();j.draftSaveAttempt.candidateId='99';j.draftSaveAttempt.acknowledged=true;await fs.writeFile(f.file,JSON.stringify(j));
  f.adapter.inspect.mockResolvedValue({account:{id:'123'},mediaHash:'media',settingsHash:'changed'});
  expect((await f.action({draftStatus:id}))[0].status).toBe('draft_save_unknown');
  expect(f.page.goto).not.toHaveBeenCalled();expect(f.page.nativeClickOnce).toHaveBeenCalledTimes(1);
  expect((await f.read()).draftSaveError.code).toBe('EDITOR_CHANGED');
 });
});
