import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const {select}=vi.hoisted(()=>({select:vi.fn()}));
vi.mock('./_category.js',()=>({selectSohuCategory:select}));
import {resumeCategory} from './_resume.js';
import {digest} from '../_shared/video-submit.js';
const dirs=[],id='11111111-1111-4111-8111-111111111111';
afterEach(async()=>{vi.unstubAllEnvs();vi.clearAllMocks();for(const d of dirs.splice(0))await fs.rm(d,{recursive:true,force:true})});
async function fixture(){
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-resume-'));dirs.push(d);vi.stubEnv('BYCLI_CONFIG_DIR',d);
 const asset=path.join(d,'v.mp4');await fs.writeFile(asset,'media');const hash=createHash('sha256').update('media').digest('hex');
 const context={account:{id:'123',name:'account'},uploadIdentity:'upload-1',cover:'cover-url',video:[{duration:30,src:'blob:one'}]};
 const job={jobId:id,platform:'sohu',contentType:'video',status:'category_required',stage:'selecting_category',pageTarget:'editor',manifest:{video:asset,cover:asset,title:'一条视频标题',body:'一段简介文字',declaration:'含有AI生成内容',visibility:'public'},assets:{video:{path:asset,sha256:hash},cover:{path:asset,sha256:hash}},preparationCheckpoint:{account:context.account,mediaHash:digest({upload:context.uploadIdentity,cover:context.cover,video:context.video})}};job.inputSha256=digest({manifest:job.manifest,assets:job.assets});const dir=path.join(d,'publish-jobs/sohu',id);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'job.json');await fs.writeFile(file,JSON.stringify(job));
 const p={tabs:vi.fn(async()=>[{page:'editor'}]),setActivePage:vi.fn(),focusWindow:vi.fn(),evaluate:vi.fn(async code=>code.includes('function liveContext')?context:code.includes('videoSnapshot')?{title:job.manifest.title,body:job.manifest.body,videoUploaded:true,customCoverPresent:true}:1),click:vi.fn(),screenshot:async({path:p})=>fs.writeFile(p,'png'),setFileInput:vi.fn(),goto:vi.fn(),getActivePage:()=> 'editor'};
 const adapter={inspect:vi.fn(async(p,j)=>{expect(j.manifest.category).toEqual(['科技','黑科技']);return {account:{id:'123',name:'account'},mediaHash:'bound',settingsHash:'settings'}})};
 function videoSnapshot(){}
 return {p,context,job,file,adapter,read:async()=>JSON.parse(await fs.readFile(file)),action:args=>resumeCategory(p,{resume:id,category:'["科技","黑科技"]',...args},'video',adapter,videoSnapshot)};
}
describe('category checkpoint recovery without duplicate uploads',()=>{
 it('updates the same job after checking original media/account and verified selection',async()=>{const f=await fixture();expect(await f.action()).toMatchObject([{job_id:id,status:'ready_for_confirmation',submitted:false}]);const j=await f.read();expect(j.manifest.category).toEqual(['科技','黑科技']);expect(j.inputSha256).toBe(digest({manifest:j.manifest,assets:j.assets}));expect(j.preparedAccount.id).toBe('123');expect(select).toHaveBeenCalledWith(f.p,'video',['科技','黑科技']);expect(f.p.goto).not.toHaveBeenCalled();expect(f.p.setFileInput).not.toHaveBeenCalled()});
 it.each(['account','media'])('refuses changed %s before selection',async kind=>{const f=await fixture();if(kind==='account')f.context.account.id='456';else f.context.uploadIdentity='replacement';await expect(f.action()).rejects.toMatchObject({code:'MEDIA_OR_ACCOUNT_CHANGED'});expect(select).not.toHaveBeenCalled();expect((await f.read()).status).toBe('category_required')});
 it('refuses changed local assets and a missing editor',async()=>{const f=await fixture();await fs.writeFile(f.job.manifest.video,'changed');await expect(f.action()).rejects.toMatchObject({code:'ASSET_CHANGED'});expect(select).not.toHaveBeenCalled();f.p.tabs.mockResolvedValue([]);await expect(f.action()).rejects.toMatchObject({code:'EDITOR_MISSING'})});
 it('does not reopen successful or submitted work via resume',async()=>{const f=await fixture();await fs.writeFile(f.file,JSON.stringify({...f.job,attempt:{id:'once'}}));await expect(f.action()).rejects.toMatchObject({code:'RESUME_UNAVAILABLE'});expect(f.p.evaluate).not.toHaveBeenCalled()});
 it('rejects malformed categories and mixed commands before touching the editor',async()=>{const f=await fixture();await expect(f.action({category:'科技/黑科技'})).rejects.toThrow(/JSON/);await expect(f.action({submit:id})).rejects.toThrow();expect(f.p.evaluate).not.toHaveBeenCalled()});
});

describe('gallery category recovery keeps uploaded assets',()=>{
 it('binds ordered images, captions and cover before resuming the same gallery job',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-gallery-resume-'));dirs.push(d);vi.stubEnv('BYCLI_CONFIG_DIR',d);
  const images=[];for(let i=0;i<3;i++){const p=path.join(d,i+'.png'),data='image'+i;await fs.writeFile(p,data);images.push({path:p,name:i+'.png',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),width:900,height:1200})}
  const manifest={title:'咖啡成为我的经理',images:images.map((a,i)=>({path:a.path,description:'配文'+i})),cover:images[0].path,declaration:'含有AI生成内容',accountId:'123',visibility:'public'};
  const checks={url:'https://mp.sohu.com/mpfe/v4/contentManagement/news/addatlas',title:manifest.title,pictures:images.map((a,i)=>({...a,status:'resolved',uploadHash:'remote'+i,description:'配文'+i})),descriptions:manifest.images.map(i=>i.description),category:['科技','综合'],cover:{present:true,binding:'cover'},declarations:[],dialogsClosed:true,quota:5,publishControlPresent:true,publishControlDisabled:false};
  const upload={images:checks.pictures.map(p=>p.uploadHash),coverSha256:images[0].sha256,coverBinding:'cover'};
  const job={jobId:id,platform:'sohu',contentType:'gallery',status:'failed',stage:'selecting_category',pageTarget:'editor',manifest,assets:{images,cover:images[0]},preparationCheckpoint:{checks,upload,account:{id:'123',name:'account'}}};job.inputSha256=digest({manifest,assets:job.assets});
  const dir=path.join(d,'publish-jobs/sohu',id);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'job.json');await fs.writeFile(file,JSON.stringify(job));
  const p={tabs:async()=>[{page:'editor'}],setActivePage:vi.fn(),focusWindow:vi.fn(),goto:vi.fn(),setFileInput:vi.fn(),screenshot:async({path:p})=>fs.writeFile(p,'png'),evaluate:async code=>code.includes('contentSnapshot')?structuredClone(checks):code.includes('managerAccount')?{account:{id:'123',name:'account'}}:1,click:async()=>{checks.declarations=[manifest.declaration]}};
  select.mockImplementation(async()=>{checks.category=['搞笑','综合']});
  const adapter={inspect:async(p,j)=>{expect(j.checks.pictures.map(p=>p.uploadHash)).toEqual(['remote0','remote1','remote2']);expect(j.checks.upload.coverSha256).toBe(images[0].sha256);return {account:{id:'123',name:'account'},mediaHash:'bound',settingsHash:'settings'}}};
  expect((await resumeCategory(p,{resume:id,category:'["搞笑","综合"]'},'gallery',adapter))[0].status).toBe('ready_for_confirmation');
  const saved=JSON.parse(await fs.readFile(file));expect(saved.manifest.category).toEqual(['搞笑','综合']);expect(saved.checks.descriptions).toEqual(manifest.images.map(i=>i.description));expect(p.goto).not.toHaveBeenCalled();expect(p.setFileInput).not.toHaveBeenCalled();
 });
});
