import{describe,it,expect,vi}from'vitest';import{createHash}from'node:crypto';import{validateCsdnManifest,assertCsdnChecks,fillCsdnTitle,csdnClick,csdnText,readCsdnManifest,prepareCsdnEditor,prepareCsdnArticle,retainedEditorError,tagMissMessage}from'./_article-prepare.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const manifest=()=>({title:'JavaScript重试边界实验',body:'## 实验\n\n```js\nconsole.log(1);\n```',summary:'验证结果未知时的重复写入与去重边界。',cover:'cover.png',tags:['javascript','前端'],articleType:'original',visibility:'public',declaration:'部分内容由AI辅助生成',accountId:'weixin_123',columns:[],backupToGitCode:false,multiPlatform:false,template:'默认模板',activities:[],topics:[]});
function fixture(){const m=manifest(),a={cover:{sha256:'source',bytes:12}},b={sourceSha256:'source',sourceBytes:12,remoteHash:'remote',crop:{width:356,height:200,sha256:'a'.repeat(64)}},s={url:'https://editor.csdn.net/md/',account:{id:m.accountId},title:m.title,modelTitle:m.title,body:m.body,bodySha256:hash(m.body),modalTypes:['publishArticle'],panelOpen:true,tags:m.tags,tagLabels:m.tags,summary:m.summary,modelSummary:m.summary,articleType:'original',visibility:'public',declaration:1,declarationLabel:m.declaration,quota:2,cover:{width:356,height:200,present:true,loaded:true,uploading:false,cropOpen:false,hashes:['remote'],displayedHash:'remote'},finalControlPresent:true,finalControlDisabled:false,checkedRadios:['original','public'],backupToGitCode:false,multiPlatform:false,selectedPlatforms:[],columns:[],activityId:'',topicId:'',scheduledTime:'',templateId:-1};return{m,a,b,s}}
const check=f=>assertCsdnChecks(f.s,f.m,f.a,f.b);
describe('CSDN article input contract',()=>{
 it('preserves literal Markdown and explicit safe settings',()=>expect(validateCsdnManifest(manifest())).toEqual(manifest()));
 it.each([{title:'短'},{title:'a'.repeat(101)},{title:'a\nb'},{body:''},{body:'a\rb'},{summary:''},{summary:'x'.repeat(257)},{cover:''},{accountId:'https://example.org'},{tags:[]},{tags:['a','a']},{tags:[1]},{tags:['a,b']},{articleType:'repost'},{visibility:'private'},{declaration:'无声明'},{backupToGitCode:true},{multiPlatform:true},{columns:['a']},{activities:['a']},{topics:['a']},{template:'简洁模板'},{submit:true},{body:'![image](https://example.org/x)'},{body:'<script>x</script>'}])('rejects unsupported settings %j',p=>expect(()=>validateCsdnManifest({...manifest(),...p})).toThrow());
});
describe('CSDN prepare consistency and final boundary',()=>{
 it('accepts fully verified candidate',()=>expect(()=>check(fixture())).not.toThrow());
 it.each([{account:{id:'wrong'}},{title:'changed'},{modelTitle:'changed'},{body:'changed'},{bodySha256:'changed'},{panelOpen:false},{modalTypes:['publishArticle','tpl']},{quota:0},{tags:['前端','javascript']},{summary:'changed'},{modelSummary:'changed'},{articleType:'repost'},{visibility:'private'},{declaration:0},{declarationLabel:'无声明'},{backupToGitCode:true},{multiPlatform:true},{selectedPlatforms:['other']},{columns:['x']},{activityId:'x'},{topicId:'x'},{scheduledTime:'tomorrow'},{templateId:4},{finalControlPresent:false},{finalControlDisabled:true},{checkedRadios:['original']}])('refuses inconsistent settings %j',p=>{const f=fixture();Object.assign(f.s,p);expect(()=>check(f)).toThrow()});
 it.each([{loaded:false},{present:false},{cropOpen:true},{uploading:true},{hashes:[]},{hashes:['other']},{displayedHash:'other'}])('requires verified final cover %j',p=>{const f=fixture();Object.assign(f.s.cover,p);expect(()=>check(f)).toThrow()});
 it('binds original selected File bytes before crop',()=>{const f=fixture();f.b.sourceSha256='other';expect(()=>check(f)).toThrow();f.b.sourceSha256='source';f.b.sourceBytes=13;expect(()=>check(f)).toThrow()});
 it('retains any existing owned editor before new preparation',async()=>{const p={tabs:async()=>[{page:'one'}],setActivePage:vi.fn(),goto:vi.fn(),setFileInput:vi.fn()};await expect(prepareCsdnEditor(p,manifest(),{},'file',vi.fn())).rejects.toMatchObject({code:'EXISTING_EDITOR'});expect(p.goto).not.toHaveBeenCalled();expect(p.setFileInput).not.toHaveBeenCalled()});
 it('requires an existing retained page to resume',async()=>expect(prepareCsdnEditor({tabs:async()=>[]},manifest(),{},'file',vi.fn(),'file-id')).rejects.toMatchObject({code:'EDITOR_MISSING'}));
 it('has no final submit mode',async()=>expect(prepareCsdnArticle({}, {input:'file',submit:'job'})).rejects.toThrow('no final submit mode'));
});

describe('hidden title focus and forbidden controls',()=>{
 it('enters title editing before typing, preserving the active Markdown body',async()=>{
  const {JSDOM}=await import('jsdom'),dom=new JSDOM('<div class="app"></div><div class="article-bar__title-display">candidate</div><input class="article-bar__title--input"><pre>unchanged Markdown</pre>');
  const doc=dom.window.document,input=doc.querySelector('input'),display=doc.querySelector('.article-bar__title-display');let visible=false;const file={name:'candidate'};
  doc.querySelector('.app').__vue__={$store:{getters:{'file/current':file}}};input.getBoundingClientRect=()=>({width:visible?300:0});display.getBoundingClientRect=()=>({width:300});display.addEventListener('click',()=>{visible=true;input.focus()});input.addEventListener('blur',()=>{file.name=input.value;visible=false});
  const page={evaluate:async code=>dom.window.eval(code),typeText:vi.fn(async(selector,text)=>{if(!visible)throw Error('Would paste into active Markdown instead');input.value=text;input.dispatchEvent(new dom.window.Event('input'));}),wait:vi.fn()};
  // jsdom eval uses its own document only when script execution is enabled.
  page.evaluate=async code=>Function('document','window',`return ${code}`)(doc,dom.window);
  await fillCsdnTitle(page,'正确标题');expect(file.name).toBe('正确标题');expect(doc.querySelector('pre').textContent).toBe('unchanged Markdown');expect(page.typeText).toHaveBeenCalledTimes(1);dom.window.close();
 });
 it.each(['发布文章','定时发布'])('refuses final text action %s before browser access',async text=>{const p={evaluate:vi.fn()};await expect(csdnText(p,text)).rejects.toMatchObject({code:'FINAL_PUBLISH_FORBIDDEN'});expect(p.evaluate).not.toHaveBeenCalled()});
 it('also rejects a final button supplied by selector',async()=>{const click=vi.fn(),element={getBoundingClientRect:()=>({width:100}),closest:()=>({}),innerText:'发布文章',click};vi.stubGlobal('document',{querySelectorAll:()=>[element]});try{await expect(csdnClick({evaluate:async code=>eval(code)},'button')).rejects.toThrow('forbidden');expect(click).not.toHaveBeenCalled()}finally{vi.unstubAllGlobals()}});
});

import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{deflateSync}from'node:zlib';
function png(w,h){const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return(n^0xffffffff)>>>0};const chunk=(kind,data)=>{const name=Buffer.from(kind),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum])};const hdr=Buffer.alloc(13);hdr.writeUInt32BE(w);hdr.writeUInt32BE(h,4);hdr[8]=8;hdr[9]=2;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',hdr),chunk('IDAT',deflateSync(Buffer.alloc((w*3+1)*h))),chunk('IEND',Buffer.alloc(0))]);}
async function local(action){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-csdn-'));try{const input=path.join(dir,'article.json');await fs.writeFile(input,JSON.stringify(manifest()));await fs.writeFile(path.join(dir,'cover.png'),png(356,200));await action({dir,input});}finally{vi.unstubAllEnvs();await fs.rm(dir,{recursive:true,force:true})}}
describe('CSDN files and preparation job protection',()=>{
 it('reads a relative PNG cover with exact bytes and dimensions',()=>local(async({dir,input})=>{const r=await readCsdnManifest(input);expect(r.assets.cover).toMatchObject({path:path.join(dir,'cover.png'),width:356,height:200,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});}));
 it.each([[356,201],[178,100]])('rejects unsupported crop input %i × %i',(w,h)=>local(async({dir,input})=>{await fs.writeFile(path.join(dir,'cover.png'),png(w,h));await expect(readCsdnManifest(input)).rejects.toThrow('89:50')}));
 it('rejects malformed bytes',()=>local(async({dir,input})=>{await fs.writeFile(path.join(dir,'cover.png'),'broken');await expect(readCsdnManifest(input)).rejects.toThrow()}));
 it('preserves a ready report and releases the lock after refusing resume',()=>local(async({dir,input})=>{vi.stubEnv('BYCLI_CONFIG_DIR',dir);const id='11111111-1111-4111-8111-111111111111',d=path.join(dir,'publish-jobs','csdn',id);await fs.mkdir(d,{recursive:true});const file=path.join(d,'job.json'),old=JSON.stringify({jobId:id,platform:'csdn',contentType:'article',status:'ready_for_confirmation'});await fs.writeFile(file,old);const p={tabs:vi.fn()};await expect(prepareCsdnArticle(p,{prepare:true,input,resume:id})).rejects.toMatchObject({code:'RESUME_MISMATCH'});expect(await fs.readFile(file,'utf8')).toBe(old);expect(p.tabs).not.toHaveBeenCalled();await expect(fs.stat(file+'.lock')).rejects.toMatchObject({code:'ENOENT'});}));
 it('does not take an existing job lock',()=>local(async({dir,input})=>{vi.stubEnv('BYCLI_CONFIG_DIR',dir);const id='11111111-1111-4111-8111-111111111111',d=path.join(dir,'publish-jobs','csdn',id);await fs.mkdir(d,{recursive:true});const file=path.join(d,'job.json.lock');await fs.writeFile(file,'owner');await expect(prepareCsdnArticle({}, {prepare:true,input,resume:id})).rejects.toMatchObject({code:'JOB_BUSY'});expect(await fs.readFile(file,'utf8')).toBe('owner');}));
 it('rejects submission mixed into prepare before file or browser access',async()=>expect(prepareCsdnArticle({}, {prepare:true,input:'missing',submit:'id'})).rejects.toThrow('no final submit mode'));
});

describe('CSDN retained-editor recovery guidance',()=>{
 it('names the exact tab target so the operator can close it',()=>{const err=retainedEditorError({page:'ABC123',url:'https://editor.csdn.net/md/'});expect(err.code).toBe('EXISTING_EDITOR');expect(err.message).toContain('target ABC123');expect(err.message).toContain('manually');expect(err.message).not.toContain('bycli browser <session>');expect(err.message).toContain('https://editor.csdn.net/md/');});
 it('still refuses to prepare a new article while a retained page exists',async()=>{const p={tabs:async()=>[{page:'ABC123'}],setActivePage:vi.fn(),goto:vi.fn(),setFileInput:vi.fn()};await expect(prepareCsdnEditor(p,manifest(),{},'file',vi.fn())).rejects.toMatchObject({code:'EXISTING_EDITOR'});expect(p.goto).not.toHaveBeenCalled();});
 it('lists platform suggestions when a tag does not exist',()=>{const msg=tagMissMessage('CSDN','AI Agent',['人工智能','云计算']);expect(msg).toContain('AI Agent');expect(msg).toContain('云计算');});
});


describe('CSDN command-level recovery guidance',()=>{
 it('retains the target and manual close instruction through the job error wrapper',()=>local(async({dir,input})=>{
  vi.stubEnv('BYCLI_CONFIG_DIR',dir);
  const page={tabs:async()=>[{page:'ABC123',url:'https://editor.csdn.net/md/'}],setActivePage:vi.fn(),goto:vi.fn(),evaluate:async()=>{throw Error('not available');}};
  await expect(prepareCsdnArticle(page,{prepare:true,input})).rejects.toThrow('target ABC123');
  const root=path.join(dir,'publish-jobs','csdn'),[id]=await fs.readdir(root);
  const job=JSON.parse(await fs.readFile(path.join(root,id,'job.json'),'utf8'));
  expect(job.error.message).toContain('manually');expect(job.error.message).not.toContain('bycli browser <session>');
  expect(page.goto).not.toHaveBeenCalled();
 }));
});
