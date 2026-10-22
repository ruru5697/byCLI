import {CliError} from '@sovovs/bycli/errors';
import {waitFor,fillVerified,clickText} from '../_shared/video-prepare.js';
import {managerAccount} from '../_shared/video-site-submit.js';
export const IMAGE_PUBLISH_URL='https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image';

/** Read only public fields and fingerprints; never return signed image URLs or raw upload IDs. */
export async function imageSnapshot() {
    const pi=window.publish?.pluginInstance, state=pi?.['content-editor']?._?.props?.state;
    const list=state?.imgList?.value||[];
    const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    // Hash one file at a time so an 18-image job does not allocate all image buffers together.
    const images=[];
    for(const [i,v] of list.entries())images.push({order:i+1,name:v.file?.name||null,bytes:v.file?.size??null,status:v.status,progress:v.progress,sha256:v.file?.arrayBuffer?await hash(await v.file.arrayBuffer()):null,uploadIdSha256:v.fileId?await hash(new TextEncoder().encode(v.fileId)):null});
    const visible=e=>!!e&&e.getBoundingClientRect().width>0;
    const editor=document.querySelector('.tiptap.ProseMirror'),paragraphs=editor?.children.length>0&&[...editor.children].every(e=>e.tagName==='P');
    const thumbNodes=[...document.querySelectorAll('.img-preview-area .img-container .img.preview')];
    const preview=document.querySelector('#creator-preview-image-0'),slides=[...document.querySelectorAll('.preivew-image')],covers=[...document.querySelectorAll('img.cover')].filter(e=>e.naturalWidth>0);
    const cover=pi?.CoverPreview?._?.props?.state?.cover?.value;
    const host=document.querySelector('xhs-publish-btn');
    return {publishType:state?.publishType?.value,images,thumbnailCount:thumbNodes.length,thumbnailOrderMatches:thumbNodes.length===list.length&&thumbNodes.every((e,i)=>e.src===list[i]?.url&&e.naturalWidth>0),
        previewImages:slides.map((e,i)=>({order:i+1,width:e.naturalWidth,height:e.naturalHeight,matches:e.src===list[i]?.url})),firstImageIsPreview:!!list[0]?.url&&preview?.src===list[0].url,firstImageIsCover:!!list[0]?.url&&covers.some(e=>e.src===list[0].url),customCoverPresent:!!cover?.fileid,
        previewDimensions:preview?{width:preview.naturalWidth,height:preview.naturalHeight}:null,
        title:document.querySelector('input[placeholder="填写标题会有更多赞哦"]')?.value,
        body:(paragraphs?[...editor.children].map(e=>e.textContent).join('\n'):editor?.innerText)?.trim(),
        declarations:[...document.querySelectorAll('.d-select')].filter(visible).map(e=>e.innerText.trim()),
        visibilityPublic:pi?.permission?._?.props?.state?.privacyInfo?.value?.type===0 && [...document.querySelectorAll('*')].some(e=>!e.children.length&&e.textContent.trim()==='公开可见'&&visible(e)),
        scheduled:pi?.postTime?._?.props?.state?.postTiming?.value,
        cropDialogClosed:![...document.querySelectorAll('.el-dialog,[role=dialog]')].some(visible),
        publishEnabled:!!host&&host.getAttribute('submit-disabled')==='false'&&host.getAttribute('submit-loading')!=='true'};
}
export function assertImageChecks(checks,manifest,assets) {
    if(checks.publishType!==1||checks.images.length!==assets.length)throw new CliError('IMAGE_COUNT_MISMATCH','Uploaded image count or content type does not match');
    for(const [i,asset] of assets.entries()){
        const image=checks.images[i];
        if(image.status!==2||image.progress!==1||!image.uploadIdSha256)throw new CliError('IMAGE_NOT_READY',`Image ${i+1} has not completed upload`);
        if(image.order!==i+1||image.sha256!==asset.sha256||image.bytes!==asset.bytes)throw new CliError('IMAGE_ORDER_OR_CONTENT_CHANGED',`Image ${i+1} differs from the ordered input`);
    }
    if(checks.previewImages?.length!==assets.length||checks.previewImages.some((v,i)=>!v.matches||v.order!==i+1||v.width!==assets[i].width||v.height!==assets[i].height))throw new CliError('PREVIEW_MISMATCH','Full image previews differ from the original ordered images');
    if(new Set(checks.images.map(i=>i.uploadIdSha256)).size!==assets.length)throw new CliError('DUPLICATE_UPLOAD_ID','Distinct images must have distinct upload identities');
    if(!checks.thumbnailOrderMatches||checks.thumbnailCount!==assets.length)throw new CliError('THUMBNAIL_MISMATCH','Visible thumbnails differ from the ordered editor image list');
    if(!checks.firstImageIsPreview||!checks.firstImageIsCover||checks.customCoverPresent||checks.previewDimensions?.width!==assets[0].width||checks.previewDimensions?.height!==assets[0].height)throw new CliError('COVER_MISMATCH','First original image must be the default preview and cover');
    if(checks.title!==manifest.title||checks.body!==manifest.body.replace(/\r\n/g,'\n').trim())throw new CliError('FIELD_MISMATCH','Title or body changed');
    const declaration=checks.declarations.join(' ');
    if(manifest.declaration==='none'?!declaration.includes('添加内容类型声明'):!declaration.includes(manifest.declaration))throw new CliError('DECLARATION_MISMATCH','Content declaration changed');
    if(!checks.visibilityPublic||checks.scheduled!==false||!checks.cropDialogClosed||!checks.publishEnabled)throw new CliError('EDITOR_NOT_READY','Public immediate editor is not ready');
}
export async function prepareXhsImages(page,manifest,assets,stage) {
    await stage('opening_editor');
    const tabs=await page.tabs();
    for(const tab of tabs.filter(t=>t.url?.startsWith('https://creator.xiaohongshu.com/publish/'))){
        page.setActivePage(tab.page);
        if(await page.evaluate(`!!document.querySelector('input[placeholder="填写标题会有更多赞哦"],.tiptap.ProseMirror')`))throw new CliError('EXISTING_EDITOR','A prepared editor is open; inspect it before starting another image job');
    }
    await page.goto(IMAGE_PUBLISH_URL,{stealth:false});await page.focusWindow();
    await waitFor(page,`!!document.querySelector('input.upload-input[multiple][accept*=".png"]')`,'logged-in image uploader',30000);
    const context=await page.evaluate(`(${managerAccount.toString()})('xiaohongshu')`);
    if(!context.account||manifest.accountId&&context.account.id!==manifest.accountId)throw new CliError('ACCOUNT_CHANGED','Creator account missing or differs from accountId');
    const observed=[];
    for(const [index,asset] of assets.entries()){
        await stage(`uploading_image_${index+1}`);
        const selector=index===0?'input.upload-input[multiple]':'input[type=file][multiple][accept*=".png"]';
        await page.setFileInput([asset.path],selector);
        const checks=await waitFor(page,`(async()=>{const s=await (${imageSnapshot.toString()})();return s.images.length===${index+1}&&s.images.every(i=>i.status===2&&i.progress===1&&i.uploadIdSha256)?s:false})()`,`completed image ${index+1}`,120000);
        if(checks.images.length!==index+1||checks.images.some((v,i)=>v.sha256!==assets[i].sha256))throw new CliError('IMAGE_ORDER_OR_CONTENT_CHANGED','Uploaded file identity/order differs from manifest');
        observed.push({order:index+1,sha256:checks.images[index].sha256,uploadIdSha256:checks.images[index].uploadIdSha256});
    }
    await stage('filling_fields');
    await fillVerified(page,'input[placeholder="填写标题会有更多赞哦"]',manifest.title);
    await fillVerified(page,'.tiptap.ProseMirror',manifest.body);
    await page.click('input[placeholder="填写标题会有更多赞哦"]');
    if(manifest.declaration!=='none'){
        await clickText(page,'添加内容类型声明');
        await waitFor(page,`[...document.querySelectorAll('*')].some(e=>!e.children.length&&e.textContent.trim()===${JSON.stringify(manifest.declaration)}&&e.getBoundingClientRect().width>0)`,'declaration option',10000);
        await clickText(page,manifest.declaration);
    }
    await stage('verifying_required_fields');
    const checks=await waitFor(page,`(async()=>{const s=await (${imageSnapshot.toString()})();return s.publishEnabled&&s.cropDialogClosed?s:false})()`,'ready image editor',30000);
    assertImageChecks(checks,manifest,assets);
    const finalContext=await page.evaluate(`(${managerAccount.toString()})('xiaohongshu')`);
    if(finalContext.account?.id!==context.account.id)throw new CliError('ACCOUNT_CHANGED','Creator changed during image preparation');
    return {...checks,account:context.account,uploadSequence:observed,cropMode:'original_images_unchanged',coverMode:'first_image_default',finalPublishClicked:false};
}
