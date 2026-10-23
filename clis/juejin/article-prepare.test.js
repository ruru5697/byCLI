import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readArticleManifest,coverResourceKey,validateArticleManifest,assertArticleChecks,checkBlankEditor,prepareArticleEditor,prepareArticle,compareMarkdown,normalizeMarkdownForCompare,tagMissMessage} from './_article-prepare.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
const manifest=()=>({title:'发布状态的核对实践',body:'## 标题\n\n```js\nthrow new Error("demo");\n```',summary:'这是一篇讨论浏览器自动化发布状态核对的技术实践文章，说明提交回执与最终作品状态之间的区别，以及重复提交保护。',cover:'cover.png',category:'开发工具',tags:['自动化'],columns:[],topics:[],visibility:'public',accountId:'123456'});
function fixture(){const m=manifest(),a={cover:{sha256:'local-sha',bytes:100,width:1200,height:800}},binding={sha256:'local-sha',bytes:100,hash:'binding'};const s={url:'https://juejin.cn/editor/drafts/987654',draftId:'987654',account:{id:m.accountId},title:m.title,body:m.body,bodySha256:sha(m.body),modelMatches:true,category:m.category,categorySelected:[m.category],tags:[{id:'111',title:m.tags[0]}],summary:m.summary,modelSummary:m.summary,columns:[],topics:[],topicState:[],syncToOrg:false,cover:{present:true,visible:true,loaded:true,matchesModel:true,width:1200,height:800,updating:false,hash:'binding'},panelOpen:true,finalControlPresent:true,finalControlDisabled:false,status:'editing'};return {m,a,s,binding};}
const check=f=>assertArticleChecks(f.s,f.m,f.a,f.binding);
describe('Juejin prepare manifest',()=>{
 it('preserves literal Markdown',()=>expect(validateArticleManifest(manifest()).body).toBe(manifest().body));
 it.each([{title:''},{title:'a'.repeat(101)},{title:'a\nb'},{body:''},{body:'a\rb'},{summary:'短摘要'},{summary:'a'.repeat(101)},{cover:''},{category:'搞笑'},{tags:[]},{tags:['a','b']},{tags:[1]},{columns:['x']},{topics:['x']},{visibility:'private'},{accountId:123},{submit:true},{body:'![image](https://example.org/x)'},{body:'<img src=x>'},{body:'<script>alert(1)</script>'}])('rejects unsupported input %j',p=>expect(()=>validateArticleManifest({...manifest(),...p})).toThrow());
 it('requires explicit empty optional selections',()=>{const m=manifest();delete m.columns;expect(()=>validateArticleManifest(m)).toThrow();});
});
describe('Juejin draft consistency and stop boundary',()=>{
 it('accepts all bound settings',()=>expect(()=>check(fixture())).not.toThrow());
 it.each([{draftId:null},{url:'https://juejin.cn/editor/drafts/other'},{account:{id:'wrong'}},{title:'wrong'},{body:'changed'},{bodySha256:'wrong'},{modelMatches:false},{category:'前端'},{categorySelected:[]},{tags:[{id:'111',title:'错标签'}]},{tags:[{id:111,title:'自动化'}]},{summary:'changed'},{modelSummary:'changed'},{columns:['x']},{topics:['x']},{topicState:['x']},{syncToOrg:true},{panelOpen:false},{finalControlPresent:false},{finalControlDisabled:true},{status:'saving'}])('rejects inconsistent or unsafe state %j',patch=>{const f=fixture();Object.assign(f.s,patch);expect(()=>check(f)).toThrow();});
 it.each([{present:false},{visible:false},{loaded:false},{matchesModel:false},{width:1},{height:1},{updating:true},{hash:'changed'}])('rejects unverified cover %j',patch=>{const f=fixture();Object.assign(f.s.cover,patch);expect(()=>check(f)).toThrow();});
 it('binds local selected cover bytes and hash',()=>{const f=fixture();f.binding.sha256='different';expect(()=>check(f)).toThrow();f.binding.sha256='local-sha';f.binding.bytes=101;expect(()=>check(f)).toThrow();});
 it('preserves an existing draft without navigation',async()=>{const p={tabs:vi.fn(async()=>[{page:'a'}]),setActivePage:vi.fn(),evaluate:vi.fn(async()=> 'https://juejin.cn/editor/drafts/987'),goto:vi.fn(),newTab:vi.fn()};await expect(prepareArticleEditor(p,manifest(),{},vi.fn())).rejects.toMatchObject({code:'EXISTING_EDITOR'});expect(p.goto).not.toHaveBeenCalled();expect(p.newTab).not.toHaveBeenCalled();});
 it.each([{title:'old',body:''},{title:'',body:'old'},{title:'',body:'',cover:true}])('does not overwrite restored content %j',state=>expect(checkBlankEditor({evaluate:async()=>({url:'https://juejin.cn/editor/drafts/new',cover:false,...state})})).rejects.toMatchObject({code:'EXISTING_EDITOR'}));
 it('rejects non-prepare invocation before browser access',async()=>{const p={goto:vi.fn()};await expect(prepareArticle(p,{input:'missing'})).rejects.toThrow('Use --prepare');expect(p.goto).not.toHaveBeenCalled();});
});

describe('signed cover delivery changes',()=>{
 it('compares stable object identity across rotating signatures and delivery hosts',()=>{
 const id='a'.repeat(32),key='tos-cn-i-example/'+id;
 expect(coverResourceKey('https://p0-xtjj-private.juejin.cn/'+key+'~tplv:q75.awebp?sign=one')).toBe(key);
 expect(coverResourceKey('https://p9-juejin.byteimg.com/'+key+'~tplv:q90.webp?sign=two')).toBe(key);
 expect(coverResourceKey('https://p0-xtjj-private.juejin.cn/tos-cn-i-example/'+'b'.repeat(32))).not.toBe(key);
 });
 it.each(['http://p0-xtjj-private.juejin.cn/x','https://juejin.cn.evil.example/x','javascript:alert(1)','https://p0-xtjj-private.juejin.cn/no-object'])('fails closed for unknown resource %s',v=>expect(coverResourceKey(v)).toBeNull());
});

describe('retained preparation ownership',()=>{
 it.each([{draftId:'other'},{title:'edited manually'},{body:'changed body'},{account:{id:'other'}}])('refuses resume of altered draft %j',async patch=>{
 const m=manifest(),p={tabs:async()=>[{page:'one'}],setActivePage:vi.fn(),evaluate:async()=>({draftId:'987654',title:m.title,body:m.body,account:{id:m.accountId},...patch}),goto:vi.fn(),typeText:vi.fn()};
 await expect(prepareArticleEditor(p,m,{},vi.fn(),'987654',m)).rejects.toMatchObject({code:'RESUME_MISMATCH'});expect(p.goto).not.toHaveBeenCalled();expect(p.typeText).not.toHaveBeenCalled();
 });
 it('requires the retained page to exist',async()=>expect(prepareArticleEditor({tabs:async()=>[]},manifest(),{},vi.fn(),'987654')).rejects.toMatchObject({code:'RESUME_MISMATCH'}));
});

function png(w,h){
 const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return (n^0xffffffff)>>>0};
 const chunk=(kind,data)=>{const name=Buffer.from(kind),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum])};
 const hdr=Buffer.alloc(13);hdr.writeUInt32BE(w);hdr.writeUInt32BE(h,4);hdr[8]=8;hdr[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',hdr),chunk('IDAT',deflateSync(Buffer.alloc((w*3+1)*h))),chunk('IEND',Buffer.alloc(0))]);
}
async function localFixture(action){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-juejin-'));try{const input=path.join(dir,'article.json');await fs.writeFile(input,JSON.stringify(manifest()));await fs.writeFile(path.join(dir,'cover.png'),png(192,128));await action({dir,input});}finally{vi.unstubAllEnvs();await fs.rm(dir,{recursive:true,force:true})}}
describe('local input and job isolation',()=>{
 it('resolves cover relative to manifest and fingerprints bytes',()=>localFixture(async({dir,input})=>{const r=await readArticleManifest(input);expect(r.assets.cover).toMatchObject({width:192,height:128,sha256:expect.stringMatching(/^[a-f0-9]{64}$/),path:path.join(dir,'cover.png')});expect(r.manifest.body).toBe(manifest().body);}));
 it.each([[193,128],[180,120]])('rejects unsupported cover dimensions %j x %j',(w,h)=>localFixture(async({dir,input})=>{await fs.writeFile(path.join(dir,'cover.png'),png(w,h));await expect(readArticleManifest(input)).rejects.toThrow('3:2');}));
 it('rejects malformed cover bytes',()=>localFixture(async({dir,input})=>{await fs.writeFile(path.join(dir,'cover.png'),'not a png');await expect(readArticleManifest(input)).rejects.toThrow();}));
 it('does not resume a ready task or modify its report',()=>localFixture(async({dir,input})=>{vi.stubEnv('BYCLI_CONFIG_DIR',dir);const id='11111111-1111-4111-8111-111111111111',jobDir=path.join(dir,'publish-jobs','juejin',id),file=path.join(jobDir,'job.json');await fs.mkdir(jobDir,{recursive:true});const original=JSON.stringify({jobId:id,platform:'juejin',contentType:'article',status:'ready_for_confirmation'});await fs.writeFile(file,original);const p={tabs:vi.fn()};await expect(prepareArticle(p,{prepare:true,input,resume:id})).rejects.toMatchObject({code:'RESUME_MISMATCH'});expect(await fs.readFile(file,'utf8')).toBe(original);expect(p.tabs).not.toHaveBeenCalled();await expect(fs.stat(file+'.lock')).rejects.toMatchObject({code:'ENOENT'});}));
 it('does not take over an existing job lock',()=>localFixture(async({dir,input})=>{vi.stubEnv('BYCLI_CONFIG_DIR',dir);const id='11111111-1111-4111-8111-111111111111',jobDir=path.join(dir,'publish-jobs','juejin',id);await fs.mkdir(jobDir,{recursive:true});const file=path.join(jobDir,'job.json.lock');await fs.writeFile(file,'owner');await expect(prepareArticle({}, {prepare:true,input,resume:id})).rejects.toMatchObject({code:'JOB_BUSY'});expect(await fs.readFile(file,'utf8')).toBe('owner');}));
});

describe('Juejin Markdown write comparison',()=>{
 it('accepts byte-identical Markdown',()=>expect(compareMarkdown('a\nb','a\nb')).toMatchObject({ok:true,cosmetic:false}));
 it('accepts padding in a recognized table',()=>{const r=compareMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |','|a|b|\n|---|---|\n|1|2|');expect(r).toMatchObject({ok:true,cosmetic:true});});
 it('tolerates a trailing newline difference',()=>expect(compareMarkdown('a\n','a')).toMatchObject({ok:true,cosmetic:true}));
 it('reports the first real difference instead of waiting for a timeout',()=>{const r=compareMarkdown('hello world','hello there');expect(r.ok).toBe(false);expect(r.offset).toBe(6);expect(r.context).toContain('there');});
 it('does not treat code fences as table padding',()=>expect(compareMarkdown('```\na  b\n```','```\na b\n```').ok).toBe(false));
 it('keeps non-table body text byte-exact',()=>expect(normalizeMarkdownForCompare('a  b')).toBe('a  b'));
 it('lists platform suggestions when a tag does not exist',()=>{const msg=tagMissMessage('Juejin','AI Agent',['人工智能','前端']);expect(msg).toContain('AI Agent');expect(msg).toContain('人工智能');});
 it('degrades when no suggestion list is visible',()=>expect(tagMissMessage('Juejin','x',[])).toContain('no suggestion list was visible'));
});


describe('Markdown semantic preservation and persistence',()=>{
 it.each([
  ['| hello world |','| helloworld |'],
  ['| a |\n| --- |\n| hello world |','|a|\n|---|\n|helloworld|'],
  ['```\n| a |\n| --- |\n| a  b |\n```','```\n|a|\n|---|\n|ab|\n```'],
  ['~~~md\n| a |\n| --- |\n~~~','~~~md\n|a|\n|---|\n~~~'],
  ['line  \nnext','line\nnext'],
  ['```\ncode\n','```\ncode'],
 ])('rejects meaningful whitespace drift in %s',(a,b)=>expect(compareMarkdown(a,b).ok).toBe(false));
 it('accepts line ending differences',()=>expect(compareMarkdown('a\r\nb\r\n','a\nb').ok).toBe(true));
 it('carries the stored Markdown through close and reopen checks',async()=>{
  const {m,a,s,binding}=fixture();
  m.body='| a | b |\n| --- | --- |\n| 1 | 2 |';
  const stored='|a|b|\n|---|---|\n|1|2|';
  s.body=stored;s.bodySha256=sha(stored);
  const stage=vi.fn(),snapshot=vi.fn(()=>structuredClone(s));
  const page={tabs:vi.fn(async()=>[{page:'owned'}]),setActivePage:vi.fn(),focusWindow:vi.fn(),goto:vi.fn(),closeTab:vi.fn(),click:vi.fn(),typeText:vi.fn(),setFileInput:vi.fn(),wait:vi.fn(),evaluate:vi.fn(async code=>{
   if(code.includes('articleSnapshot'))return snapshot();
   if(code.includes("title:document.querySelector('.title-input')"))return {url:'https://juejin.cn/editor/drafts/new',title:'',body:'',cover:false};
   if(code==='location.origin+location.pathname')return 'https://juejin.cn/';
   if(code===`document.querySelector('.CodeMirror').CodeMirror.getValue()`)return stored;
   if(code.includes('post.tags.map'))return m.tags;
   if(code==='window.__bycliJuejinCover')return binding;
   if(code.includes('return nodes.length'))return 1;
   return true;
  })};
  const result=await prepareArticleEditor(page,m,a,stage);
  expect(result).toMatchObject({bodyAsStored:stored,persistence:'verified_after_close_and_reopen'});
  expect(page.closeTab).toHaveBeenCalledWith('owned');
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(stage).toHaveBeenCalledWith('markdown_normalized',{bodyAsStored:stored});
  expect(m.body).toContain('| a |');
 });
 it('detects changes after reopening even when they would be cosmetic',()=>{
  const {m,a,s,binding}=fixture();
  const stored=m.body+'\n';s.body=stored;s.bodySha256=sha(stored);
  expect(()=>assertArticleChecks(s,m,a,binding,stored)).not.toThrow();
  s.body=m.body;s.bodySha256=sha(m.body);
  expect(()=>assertArticleChecks(s,m,a,binding,stored)).toThrow('Markdown differs');
 });
});


describe('preparation error diagnostics',()=>{
 it('preserves useful tag diagnostics in the command error and private job report',()=>localFixture(async({dir,input})=>{
  vi.stubEnv('BYCLI_CONFIG_DIR',dir);
  const {CliError}=await import('@sovovs/bycli/errors');
  const page={tabs:async()=>{throw new CliError('TAG_NOT_FOUND','Juejin has no existing tag "missing"; visible suggestions: "前端"');},evaluate:async()=>{throw Error('not available');}};
  await expect(prepareArticle(page,{prepare:true,input})).rejects.toThrow('visible suggestions: "前端"');
  const root=path.join(dir,'publish-jobs','juejin'),[id]=await fs.readdir(root);
  const job=JSON.parse(await fs.readFile(path.join(root,id,'job.json'),'utf8'));
  expect(job.error).toMatchObject({code:'TAG_NOT_FOUND',message:expect.stringContaining('visible suggestions')});
 }));
});
