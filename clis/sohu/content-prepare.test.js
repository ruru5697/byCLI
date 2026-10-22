import {describe,it,expect,vi} from 'vitest';
import {deflateSync} from 'node:zlib';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {validateContentManifest,readContentManifest,assertContentChecks,prepareContentEditor,prepareSohuContent,contentUrl} from './_content-prepare.js';

// Small valid PNG fixtures keep file validation tests independent of local story artifacts.
function png(width,height,shade){
 const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let j=0;j<8;j++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return (n^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const name=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const row=Buffer.concat([Buffer.alloc(1),Buffer.alloc(width*3,shade)]);
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);
}

const common={title:'咖啡成为我的经理',cover:'01.png',declaration:'含有AI生成内容',visibility:'public',accountId:'123'};
const gallery=()=>({...common,images:[1,2,3].map(i=>({path:i+'.png',description:'第'+i+'页'})),category:['搞笑','综合']});
const article=()=>({...common,images:['01.png'],body:'第一段\n\n第二段',summary:'这是摘要',attribute:'none'});
describe('Sohu content preparation input contract',()=>{
 it('retains ordered gallery captions and literal article text',()=>{expect(validateContentManifest(gallery(),'gallery').images.map(x=>x.description)).toEqual(['第1页','第2页','第3页']);expect(validateContentManifest(article(),'article').body).toBe('第一段\n\n第二段');});
 it.each([{title:'短'},{title:'a'.repeat(73)},{title:'换行标题\n正文'},{visibility:'private'},{accountId:123},{declaration:'auto'},{cover:''},{submit:true}])('rejects invalid common settings %j',patch=>expect(()=>validateContentManifest({...gallery(),...patch},'gallery')).toThrow());
 it.each([{images:[]},{images:['x','y','z']},{images:[{path:'x',description:'a'.repeat(201)}]},{category:['搞笑']},{body:'not-supported'}])('rejects gallery shape %j',patch=>expect(()=>validateContentManifest({...gallery(),...patch},'gallery')).toThrow());
 it.each([{body:''},{body:'a'.repeat(20001)},{body:'a\r\nb'},{summary:'a'.repeat(121)},{summary:'换行\n摘要'},{attribute:'原创'},{images:[]},{images:[{path:'x'}]},{html:'<p>x</p>'}])('rejects unsupported article input %j',patch=>expect(()=>validateContentManifest({...article(),...patch},'article')).toThrow());
 it('accepts local count boundaries and rejects beyond them',()=>{const g=gallery();g.images=Array.from({length:40},(_,i)=>({path:i+'.png',description:'配文'}));expect(validateContentManifest(g,'gallery').images).toHaveLength(40);g.images.push(g.images[0]);expect(()=>validateContentManifest(g,'gallery')).toThrow();const a=article();a.images=Array.from({length:20},(_,i)=>i+'.png');expect(validateContentManifest(a,'article').images).toHaveLength(20);a.images.push('x');expect(()=>validateContentManifest(a,'article')).toThrow();});
 it('reads actual PNG structure and ordered local fingerprints',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-sohu-'));try{const src=dir;await fs.writeFile(path.join(src,'01.png'),png(512,512,255));await fs.writeFile(path.join(src,'02.png'),png(512,640,180));const a=article();a.cover=path.join(src,'01.png');a.images=[path.join(src,'02.png')];await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(a));const r=await readContentManifest(path.join(dir,'manifest.json'),'article');expect(r.assets.images[0]).toMatchObject({width:512,height:640,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});a.images=[a.cover,a.cover];await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(a));await expect(readContentManifest(path.join(dir,'manifest.json'),'article')).rejects.toThrow(/Repeated|distinct file names/);}finally{await fs.rm(dir,{recursive:true,force:true});}});
});
function fixture(type='gallery'){
 const manifest=type==='gallery'?gallery():article(),assets={images:manifest.images.map((_,i)=>({sha256:'sha'+i,bytes:100+i,width:1080,height:1440,name:i+'.png'})),cover:{sha256:'cover'}};
 const upload={images:assets.images.map((_,i)=>'remote'+i),coverSha256:'cover',coverBinding:'binding',sourceImages:assets.images.map(a=>({sha256:a.sha256,bytes:a.bytes,name:a.name,status:'resolved'}))};
 const checks={url:contentUrl(type),title:manifest.title,pictures:assets.images.map((a,i)=>({...a,status:'resolved',description:manifest.images[i].description,uploadHash:upload.images[i],loaded:true,resourceReady:true})),descriptions:manifest.images.map(x=>x.description),category:manifest.category,body:manifest.body,summary:manifest.summary,attribute:'属性\n\n未选择',cover:{present:true,binding:'binding'},declarations:[manifest.declaration],dialogsClosed:true,quota:5,publishControlPresent:true,publishControlDisabled:false,loginGate:type==='article'?{visible:true,checked:false}:null};return {manifest,assets,upload,checks,type};
}
function check(f){return assertContentChecks(f.checks,f.manifest,f.assets,f.type,f.upload)}
describe('prepared model and page checks',()=>{
 it.each(['gallery','article'])('verifies complete %s input binding',type=>expect(()=>check(fixture(type))).not.toThrow());
 it.each(['sha256','bytes','status','width','height','description','uploadHash'])('refuses changed gallery %s',key=>{const f=fixture();f.checks.pictures[0][key]='changed';expect(()=>check(f)).toThrow();});
 it.each([{quota:0},{dialogsClosed:false},{publishControlPresent:false},{publishControlDisabled:true},{loginGate:{checked:true}},{cover:{present:false,binding:'binding'}},{declarations:[]},{title:'changed'},{category:['科技','综合']},{descriptions:['wrong']}])('refuses missing or changed required settings %j',patch=>{const f=fixture();Object.assign(f.checks,patch);expect(()=>check(f)).toThrow();});
 it('refuses a swapped gallery despite same count',()=>{const f=fixture();f.checks.pictures.reverse();expect(()=>check(f)).toThrow();});
 it.each(['body','summary','attribute'])('refuses changed article %s',key=>{const f=fixture('article');f.checks[key]='changed';expect(()=>check(f)).toThrow();});
 it('refuses another inserted article image and a changed cover binding',()=>{const f=fixture('article');f.checks.pictures[0].uploadHash='another';expect(()=>check(f)).toThrow();const g=fixture();g.checks.cover.binding='changed';expect(()=>check(g)).toThrow();});
 it('retains an existing owned editor without navigation or opening a second tab',async()=>{const p={tabs:vi.fn(async()=>[{page:'p',url:contentUrl('gallery')}]),setActivePage:vi.fn(),evaluate:vi.fn(async()=>false),goto:vi.fn(),newTab:vi.fn()};await expect(prepareContentEditor(p,gallery(),{},'gallery',vi.fn())).rejects.toMatchObject({code:'EXISTING_EDITOR'});expect(p.goto).not.toHaveBeenCalled();expect(p.newTab).not.toHaveBeenCalled();});
 it('requires prepare and refuses submission before touching browser or filesystem',async()=>{const p={goto:vi.fn()};await expect(prepareSohuContent(p,{input:'x',prepare:true,submit:'id'},'gallery')).rejects.toThrow('Preparation requires');expect(p.goto).not.toHaveBeenCalled();});
});

describe('article upload and visibility completion',()=>{
 it.each([{resourceReady:false},{loaded:false},{width:1},{height:1}])('requires final image completion %j',patch=>{const f=fixture('article');Object.assign(f.checks.pictures[0],patch);expect(()=>check(f)).toThrow();});
 it('requires recorded local source identity and an explicit unrestricted visibility control',()=>{const f=fixture('article');f.upload.sourceImages=[];expect(()=>check(f)).toThrow();const g=fixture('article');g.checks.loginGate=null;expect(()=>check(g)).toThrow();});
});
