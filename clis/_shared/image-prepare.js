import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {XHS_DECLARATIONS} from './video-prepare.js';

export function validateImageManifest(value) {
    if(!value || typeof value!=='object' || Array.isArray(value))throw new ArgumentError('Expected a JSON object');
    const allowed=['images','title','body','declaration','visibility','accountId'];
    for(const key of Object.keys(value))if(!allowed.includes(key))throw new ArgumentError(`Unsupported manifest field: ${key}`);
    if(!Array.isArray(value.images)||value.images.length<1||value.images.length>18||value.images.some(p=>typeof p!=='string'||!p.trim()))throw new ArgumentError('images must contain 1–18 ordered file paths');
    if(typeof value.title!=='string'||!value.title.trim()||value.title.length>20||/[\r\n]/.test(value.title))throw new ArgumentError('title must be a single nonempty line of at most 20 JavaScript character units');
    if(typeof value.body!=='string'||!value.body.trim()||value.body.length>1000)throw new ArgumentError('body must contain 1–1000 JavaScript character units');
    if(!XHS_DECLARATIONS.includes(value.declaration))throw new ArgumentError('Explicit supported declaration is required');
    if(value.visibility!=='public')throw new ArgumentError('Only explicit public visibility is currently supported');
    if(value.accountId!==undefined&&(typeof value.accountId!=='string'||!/^\d{1,30}$/.test(value.accountId)))throw new ArgumentError('accountId must be a public creator account number');
    return {...value,images:[...value.images]};
}
export function imageDimensions(b,ext) {
    let width,height,format;
    if(ext==='.png' && b.length>=45 && b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && b.readUInt32BE(8)===13 && b.toString('ascii',12,16)==='IHDR'){
        let offset=8,hasData=false,hasEnd=false;
        while(offset+12<=b.length){const len=b.readUInt32BE(offset),kind=b.toString('ascii',offset+4,offset+8);if(offset+12+len>b.length)break;if(kind==='acTL')throw new ArgumentError('Animated PNG is not supported');if(kind==='IDAT')hasData=true;if(kind==='IEND'&&len===0&&offset+12===b.length)hasEnd=true;offset+=len+12;}
        if(hasData&&hasEnd){width=b.readUInt32BE(16);height=b.readUInt32BE(20);format='png';}
    } else if(/\.jpe?g$/.test(ext) && b.length>=4 && b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217){
        let scan=false;
        for(let i=2;i+4<b.length;){if(b[i++]!==255)break;while(b[i]===255)i++;const marker=b[i++];if(marker===218){scan=true;break;}if(marker===217)break;if(marker===1||marker>=208&&marker<=215)continue;const size=b.readUInt16BE(i);if(size<2||i+size>b.length)break;if([192,193,194].includes(marker)&&size>=8){height=b.readUInt16BE(i+3);width=b.readUInt16BE(i+5);}i+=size;}
        if(scan)format='jpeg';else{width=height=undefined;}
    } else if(ext==='.webp' && b.length>=30 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP' && b.readUInt32LE(4)+8===b.length){
        const kind=b.toString('ascii',12,16),length=b.readUInt32LE(16);
        if(20+length<=b.length){
            if(kind==='VP8X'&&length>=10){if(b[20]&2)throw new ArgumentError('Animated WebP is not supported');width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
            else if(kind==='VP8 '&&length>=10&&b[23]===157&&b[24]===1&&b[25]===42){width=b.readUInt16LE(26)&16383;height=b.readUInt16LE(28)&16383;}
            else if(kind==='VP8L'&&length>=5&&b[20]===47){const bits=b.readUInt32LE(21);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
            format='webp';
        }
    }
    if(!width||!height||!format)throw new ArgumentError('Image has an unsupported, malformed or truncated PNG/JPEG/WebP structure');
    return {width,height,format};
}
export async function readImageManifest(input) {
    let value;try{value=JSON.parse(await fs.readFile(input,'utf8'));}catch{throw new ArgumentError('Cannot read input JSON manifest');}
    const manifest=validateImageManifest(value),base=path.dirname(path.resolve(input)),assets=[],seen=new Set();
    for(const [index,item] of manifest.images.entries()){
        const file=path.resolve(base,item);let stat;try{stat=await fs.stat(file);}catch{throw new ArgumentError(`Image ${index+1} not found`);}
        if(!stat.isFile()||!stat.size||stat.size>32*1024**2)throw new ArgumentError(`Image ${index+1} must be a nonempty regular file of at most 32 MiB`);
        const data=await fs.readFile(file),sha256=createHash('sha256').update(data).digest('hex');
        if(seen.has(sha256))throw new ArgumentError('Duplicate image content is not supported; provide distinct ordered images');seen.add(sha256);
        const dimensions=imageDimensions(data,path.extname(file).toLowerCase());
        assets.push({order:index+1,path:file,name:path.basename(file),bytes:data.length,sha256,...dimensions});
    }
    manifest.images=assets.map(a=>a.path);return {manifest,assets};
}
export async function prepareImages(page,kwargs,prepare) {
    if(kwargs.prepare!==true||!kwargs.input)throw new ArgumentError('Use --prepare --input MANIFEST; image submission is not implemented in this command');
    const {manifest,assets}=await readImageManifest(kwargs.input),jobId=randomUUID();
    const dir=path.join(process.env.BYCLI_CONFIG_DIR||path.join(os.homedir(),'.bycli'),'publish-jobs','xiaohongshu',jobId);await fs.mkdir(dir,{recursive:true,mode:0o700});
    const report=path.join(dir,'job.json');
    const job={schemaVersion:1,jobId,platform:'xiaohongshu',contentType:'image',createdAt:new Date().toISOString(),status:'preparing',stage:'validated',submitted:false,finalPublishAction:'requires_confirmation',remoteDraftId:null,editorPersistence:'live_browser_editor; remote draft durability not guaranteed',manifest,assets,inputSha256:createHash('sha256').update(JSON.stringify({manifest,assets})).digest('hex'),sideEffects:['Image uploads; platform may automatically save a draft'],report};
    const save=async()=>{job.updatedAt=new Date().toISOString();const temp=path.join(dir,randomUUID()+'.tmp');await fs.writeFile(temp,JSON.stringify(job,null,2),{mode:0o600});await fs.rename(temp,report);};
    await save();
    try{
        job.checks=await prepare(page,manifest,assets,async stage=>{job.stage=stage;await save();});
        for(const asset of assets)if(createHash('sha256').update(await fs.readFile(asset.path)).digest('hex')!==asset.sha256)throw new CliError('ASSET_CHANGED','Local image changed during preparation');
        job.preparedAccount=job.checks.account;job.pageTarget=page.getActivePage?.()??null;job.screenshot=path.join(dir,'preview.png');await page.screenshot({path:job.screenshot,fullPage:true});await fs.chmod(job.screenshot,0o600);
        job.status='ready_for_confirmation';job.stage='ready';await save();
        return [{status:job.status,job_id:jobId,submitted:false,title:manifest.title,image_count:assets.length,account:job.preparedAccount.name,report,preview:job.screenshot}];
    }catch(error){job.status='failed';job.pageTarget=page.getActivePage?.()??null;job.error={code:error.code||'PREPARATION_FAILED',message:String(error.message||error).replace(/https?:\/\/\S+/g,'[url]').slice(0,400)};await save();throw new CliError(job.error.code,job.error.message,`Local image preparation report: ${report}`);}
}
