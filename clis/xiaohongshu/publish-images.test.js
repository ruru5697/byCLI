import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,webcrypto} from 'node:crypto';
import {validateImageManifest,imageDimensions,readImageManifest,prepareImages} from '../_shared/image-prepare.js';
import {assertImageChecks,prepareXhsImages,imageSnapshot} from './publish-images.js';
import {withJob} from '../_shared/video-submit.js';
const manifest={images:['a.png'],title:'杯总的面试',body:'第一段\n\n第二段',declaration:'笔记含AI合成内容',visibility:'public',accountId:'123'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=','base64');
const dirs=[];afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const d of dirs.splice(0))await fs.rm(d,{recursive:true,force:true});});
async function fixture(){const d=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-image-'));dirs.push(d);await fs.writeFile(path.join(d,'a.png'),png);const input=path.join(d,'input.json');await fs.writeFile(input,JSON.stringify(manifest));return{d,input};}
describe('image manifest preflight',()=>{
 it('supports ordered 1–18 images and rejects zero/19',()=>{expect(validateImageManifest({...manifest,images:Array.from({length:18},(_,i)=>`${i}.png`)}).images).toHaveLength(18);for(const images of [[],Array(19).fill('a.png')])expect(()=>validateImageManifest({...manifest,images})).toThrow();});
 it.each([{title:'a\nb'},{title:'a'.repeat(21)},{body:' '},{body:'a'.repeat(1001)},{declaration:undefined},{declaration:'unknown'},{visibility:'private'},{accountId:123},{topics:['tag']},{cropRatio:'1:1'}])('refuses unsupported or ambiguous input %j',patch=>expect(()=>validateImageManifest({...manifest,...patch})).toThrow());
 it('resolves relative paths and fingerprints actual image bytes',async()=>{const f=await fixture(),r=await readImageManifest(f.input);expect(r.manifest.images).toEqual([path.join(f.d,'a.png')]);expect(r.assets[0]).toMatchObject({order:1,width:1,height:1,format:'png',sha256:createHash('sha256').update(png).digest('hex')});});
 it('rejects duplicate image content before any upload',async()=>{const f=await fixture();await fs.copyFile(path.join(f.d,'a.png'),path.join(f.d,'copy.png'));await fs.writeFile(f.input,JSON.stringify({...manifest,images:['a.png','copy.png']}));await expect(readImageManifest(f.input)).rejects.toThrow(/Duplicate/);});
 it('rejects GIF, spoofed extensions and truncated files',()=>{expect(imageDimensions(png,'.png')).toMatchObject({width:1,height:1});for(const [b,ext]of [[Buffer.from('GIF89a'),'.gif'],[png,'.jpg'],[png.subarray(0,-12),'.png'],[Buffer.from('<html>'),'.png']])expect(()=>imageDimensions(b,ext)).toThrow();});
 it('supports static WebP dimensions and rejects animated WebP',()=>{const b=Buffer.alloc(30);b.write('RIFF');b.writeUInt32LE(22,4);b.write('WEBP',8);b.write('VP8X',12);b.writeUInt32LE(10,16);b.writeUIntLE(1079,24,3);b.writeUIntLE(1439,27,3);expect(imageDimensions(b,'.webp')).toMatchObject({width:1080,height:1440});b[20]=2;expect(()=>imageDimensions(b,'.webp')).toThrow(/Animated/);});
});
const assets=[{bytes:10,sha256:'hash1',width:1080,height:1440},{bytes:20,sha256:'hash2',width:1080,height:1440}];
const ready=()=>({publishType:1,images:[{order:1,bytes:10,sha256:'hash1',status:2,progress:1,uploadIdSha256:'upload1'},{order:2,bytes:20,sha256:'hash2',status:2,progress:1,uploadIdSha256:'upload2'}],previewImages:[{order:1,width:1080,height:1440,matches:true},{order:2,width:1080,height:1440,matches:true}],thumbnailCount:2,thumbnailOrderMatches:true,firstImageIsPreview:true,firstImageIsCover:true,customCoverPresent:false,previewDimensions:{width:1080,height:1440},title:manifest.title,body:manifest.body,declarations:[manifest.declaration],visibilityPublic:true,scheduled:false,cropDialogClosed:true,publishEnabled:true});
describe('image completion guards',()=>{
 it('checks actual ordered content rather than only thumbnail count',()=>{expect(()=>assertImageChecks(ready(),manifest,assets)).not.toThrow();const s=ready();[s.images[0],s.images[1]]=[s.images[1],s.images[0]];expect(()=>assertImageChecks(s,manifest,assets)).toThrow(/differs/);});
 it('rejects a pending/failed item or changed file even when the publish button is enabled',()=>{for(const patch of [{status:1},{progress:.5},{sha256:'changed'},{uploadIdSha256:null}]){const s=ready();Object.assign(s.images[1],patch);expect(()=>assertImageChecks(s,manifest,assets)).toThrow();}});
 it.each([{previewImages:[]},{previewImages:[{order:1,width:1,height:1,matches:true}]},{thumbnailOrderMatches:false},{firstImageIsCover:false},{firstImageIsPreview:false},{customCoverPresent:true},{previewDimensions:{width:1,height:1}},{scheduled:true},{scheduled:undefined},{visibilityPublic:false},{cropDialogClosed:false},{declarations:[]},{body:'第一段第二段'}])('refuses incompatible preview/settings %j',patch=>expect(()=>assertImageChecks({...ready(),...patch},manifest,assets)).toThrow());
 it('blocks another preparation before navigating away from an existing editor',async()=>{const p={tabs:vi.fn(async()=>[{page:'prepared',url:'https://creator.xiaohongshu.com/publish/publish?target=image'}]),setActivePage:vi.fn(),evaluate:vi.fn(async()=>true),goto:vi.fn(),setFileInput:vi.fn()};await expect(prepareXhsImages(p,manifest,assets,vi.fn())).rejects.toMatchObject({code:'EXISTING_EDITOR'});expect(p.goto).not.toHaveBeenCalled();expect(p.setFileInput).not.toHaveBeenCalled();});
});
describe('prepare-only image jobs',()=>{
 it('writes a protected image job with no attempt, and video submit refuses it',async()=>{const f=await fixture();vi.stubEnv('BYCLI_CONFIG_DIR',f.d);const p={getActivePage:()=> 'tab',screenshot:async({path:p})=>fs.writeFile(p,'preview')};const [row]=await prepareImages(p,{prepare:true,input:f.input},async()=>({account:{id:'123',name:'测试'}}));const j=JSON.parse(await fs.readFile(row.report,'utf8'));expect(j).toMatchObject({contentType:'image',submitted:false,status:'ready_for_confirmation',finalPublishAction:'requires_confirmation'});expect(j).not.toHaveProperty('attempt');expect(j).not.toHaveProperty('review');if(process.platform!=='win32') expect((await fs.stat(row.report)).mode&0o777).toBe(0o600);await expect(withJob('xiaohongshu',j.jobId,vi.fn())).rejects.toMatchObject({code:'INVALID_JOB'});});
 it('detects a local image changed while preparation was running',async()=>{const f=await fixture();vi.stubEnv('BYCLI_CONFIG_DIR',f.d);await expect(prepareImages({}, {prepare:true,input:f.input},async()=>{await fs.appendFile(path.join(f.d,'a.png'),'changed');return{};})).rejects.toMatchObject({code:'ASSET_CHANGED'});});
 it('requires explicit preparation mode before touching the browser',async()=>{await expect(prepareImages({}, {input:'anything'},vi.fn())).rejects.toThrow(/--prepare/);});
});


describe('bounded-memory image fingerprints',()=>{
 it('does not read the second image until the first image fingerprint is complete',async()=>{
  let resolveFirst;const first=vi.fn(()=>new Promise(resolve=>resolveFirst=resolve)),second=vi.fn(async()=>new Uint8Array([2]).buffer);
  const images=[{file:{name:'a.png',size:1,arrayBuffer:first},status:2,progress:1},{file:{name:'b.png',size:1,arrayBuffer:second},status:2,progress:1}];
  vi.stubGlobal('window',{publish:{pluginInstance:{'content-editor':{_:{props:{state:{imgList:{value:images}}}}}}}});
  vi.stubGlobal('document',{querySelector:()=>null,querySelectorAll:()=>[]});vi.stubGlobal('crypto',webcrypto);
  const pending=imageSnapshot();expect(first).toHaveBeenCalledOnce();expect(second).not.toHaveBeenCalled();
  resolveFirst(new Uint8Array([1]).buffer);const result=await pending;
  expect(second).toHaveBeenCalledOnce();expect(result.images.map(i=>i.sha256)).toEqual([createHash('sha256').update(Buffer.from([1])).digest('hex'),createHash('sha256').update(Buffer.from([2])).digest('hex')]);
 });
});
