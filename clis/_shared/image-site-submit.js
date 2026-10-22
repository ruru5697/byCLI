import {CliError} from '@sovovs/bycli/errors';
import {digest} from './video-submit.js';
import {managerAccount,makeVideoAdapter} from './video-site-submit.js';

/** Hash only selected publishing settings; raw values never leave browser memory. */
export async function imageSubmitSettings() {
    const pi=window.publish?.pluginInstance,s=pi?.ImagePreview?._?.props?.state;
    if(!s)throw Error('Image preview publishing state unavailable');
    const names=['collectionId','collectionContext','groupBind','postLoc','liveNoticeBind','liveReservationBind','liveContext','privacyInfo','userDeclaration','goodsContext','bizRelationContext','fileRelate','original','audioFile','skillBind','skillContext','appBind','appContext','voteBind','gameBind','gameContext','redCircleBind','publishType'];
    const values=Object.fromEntries(names.map(k=>[k,s[k]?.value??null]));
    const editor=pi['content-editor']?._?.props?.state;
    values.ats=editor?.ats?.value??null;values.hashTag=editor?.hashTag?.value??null;
    values.scheduled=pi.postTime?._?.props?.state?.postTiming?.value;
    const data=new TextEncoder().encode(JSON.stringify(values));
    const settingsHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
    return {settingsHash,url:location.origin+location.pathname,publishHandlerAvailable:typeof document.querySelector('xhs-publish-btn')?._onPublish==='function'};
}
export function makeImageAdapter(snapshot,assertChecks) {
    const common=makeVideoAdapter('xiaohongshu',null);
    return {
        async inspect(page,job){
            const s=await page.evaluate(`(${snapshot.toString()})()`);
            assertChecks(s,job.manifest,job.assets);
            const {account}=await page.evaluate(`(${managerAccount.toString()})('xiaohongshu')`);
            if(!account?.id||!account.name||account.id!==job.preparedAccount?.id||job.manifest.accountId&&account.id!==job.manifest.accountId)throw new CliError('ACCOUNT_CHANGED','Current account differs from the prepared image account');
            if(s.images.some((v,i)=>v.uploadIdSha256!==job.checks?.images?.[i]?.uploadIdSha256))throw new CliError('UPLOADED_IMAGES_CHANGED','Uploaded image identities changed after preparation');
            const c=await page.evaluate(`(${imageSubmitSettings.toString()})()`);
            if(c.url!=='https://creator.xiaohongshu.com/publish/publish'||!c.publishHandlerAvailable||!/^[a-f0-9]{64}$/.test(c.settingsHash))throw new CliError('EDITOR_UNVERIFIED','Cannot verify the image publishing page and control');
            return {account,title:job.manifest.title,body:job.manifest.body,url:c.url,mediaHash:digest({images:s.images,coverMode:'first_original_image'}),settingsHash:digest({settings:c.settingsHash,declarations:s.declarations,public:s.visibilityPublic,scheduled:s.scheduled})};
        },
        trigger:common.trigger,
        async query(page,job){
            const state=await common.query(page,job);
            if(['published','reviewing','rejected'].includes(state.status)&&state.contentType!=='image')return {status:'query_unavailable',contentId:state.contentId,reason:'Exact ID record does not verify image content type'};
            return state;
        }
    };
}
