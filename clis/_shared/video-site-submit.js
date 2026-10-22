import { startReadCapture, waitReadCapture } from './read-response-capture.js';
import { CliError } from '@sovovs/bycli/errors';
import { digest, managers, sohuStatuses } from './video-submit.js';
import { clickText, waitFor } from './video-prepare.js';

// Executed in the platform page. Read only selected public account identity and UI state.
export async function liveContext(platform) {
    const controls=[...document.querySelectorAll('input,textarea,select,[role=switch]')].filter(e=>e.type!=='file' && e.type!=='hidden').map(e=>({type:e.type||e.getAttribute('role'),value:e.value||'',checked:!!e.checked,aria:e.getAttribute('aria-checked')}));
    const cover=document.querySelector(platform==='sohu'?'.pic-cover':'.cover--row > .default, .cover--column > .default')?.style.backgroundImage || '';
    let account, uploadIdentity, scheduled=false;
    if(platform==='sohu'){
        const u=document.querySelector('#app')?.__vue__?.$store?.state?.app?.userInfo;
        if(u?.id && u.nickName) account={id:String(u.id),name:u.nickName};
        const stores=[...new Set([...document.querySelectorAll('*')].map(e=>e.__vue__?.$store).filter(Boolean))];
        const videos=stores.find(s=>s.state.AddVideoState)?.state.AddVideoState?.filter(v=>v.videoId) || [];
        if(videos.length===1) uploadIdentity=String(videos[0].videoId);
    } else {
        const r=await fetch('/api/galaxy/creator/home/personal_info',{credentials:'include'}).then(r=>r.json());
        if(r.success===true && r.data?.red_num && r.data?.name) account={id:String(r.data.red_num),name:r.data.name};
        const state=window.publish?.pluginInstance?.video?._?.props?.state;
        const video=state?.video?.value, cover=state?.cover?.value;
        scheduled=window.publish?.pluginInstance?.postTime?._?.props?.state?.postTiming?.value;
        if(video?.fileid && cover?.fileid) uploadIdentity=String(video.fileid)+':'+String(cover.fileid);
    }
    const video=[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc||v.src,duration:Number.isFinite(v.duration)?v.duration:null}));
    const editorText=document.querySelector(platform==='sohu'?'.main-container':'.publish-video-container')?.innerText || document.body.innerText;
    return {account,uploadIdentity,scheduled,cover,video,controls,editorText,url:location.origin+location.pathname};
}
export function makeVideoAdapter(platform, snapshot) {
    return {
        async inspect(page,job){
            const s=await page.evaluate(`(${snapshot.toString()})()`);
            const m=job.manifest;
            const norm=t=>(t||'').replace(/\r\n/g,'\n').trim();
            if(s.title!==m.title || norm(s.body)!==norm(m.body)) throw new CliError('FIELD_MISMATCH','Title or body differs from the confirmed manifest');
            const ready=platform==='sohu' ? s.videoUploaded && s.customCoverPresent && s.coverDialogClosed && s.quota>0 && s.publishControlPresent && !s.publishControlDisabled && JSON.stringify(s.category)===JSON.stringify(m.category) && s.declarations.includes(m.declaration)
                : s.videoReady && s.customCoverPresent && s.coverDialogClosed && s.publishEnabled && s.visibilityPublic && (m.declaration==='none'?s.declarationLabels.join(' ').includes('添加内容类型声明'):s.declarationLabels.join(' ').includes(m.declaration));
            if(!ready) throw new CliError('EDITOR_NOT_READY','Video, cover, visibility or required fields are not ready');
            const c=await page.evaluate(`(${liveContext.toString()})(${JSON.stringify(platform)})`);
            const origin=platform==='sohu'?'https://mp.sohu.com':'https://creator.xiaohongshu.com';
            if(c.scheduled!==false) throw new CliError('SCHEDULE_UNSUPPORTED','Only immediate public publication is supported; disable scheduling');
            if(!c.account?.id || !c.account.name || !c.url.startsWith(origin+'/') || !c.cover || !c.uploadIdentity) throw new CliError('ACCOUNT_UNVERIFIED','Cannot verify the current publisher account and cover');
            // Keep signed URLs and transient blob URLs out of durable reports.
            return {account:c.account,mediaHash:digest({upload:c.uploadIdentity,cover:c.cover,video:c.video}),settingsHash:digest({controls:c.controls,text:c.editorText,scheduled:c.scheduled}),title:m.title,body:m.body,url:c.url};
        },
        async trigger(page){
            if(platform==='sohu') return clickText(page,'发布');
            // One known web-component handler, no alternative invocation or retry.
            if(typeof page.evaluateOnce!=='function')throw new CliError('ONE_SHOT_UNAVAILABLE','Publishing requires the no-retry browser capability');
            return page.evaluateOnce(`(()=>{const h=document.querySelector('xhs-publish-btn');if(!h || h.getAttribute('submit-disabled')!=='false' || typeof h._onPublish!=='function') throw Error('Publish control unavailable');h._onPublish();return true})()`);
        },
        async query(page,job){
            const contentId=job.receipt?.contentId || job.reconciliation?.contentId;
            if(!contentId) throw new CliError('CONTENT_ID_MISSING','No verified platform content ID is available');
            await openManagerPage(page, platform, job.pageTarget);
            await page.focusWindow();
            await waitFor(page, platform==='sohu'?`!!document.querySelector('.tab_header')`:`document.querySelectorAll('.tab-list .tab-item').length>=4`, 'content manager filters',30000);
            if(platform==='sohu'){ await clickText(page,'文章','.tab_header'); await page.wait({time:1}); await waitFor(page, `![...document.querySelectorAll('.el-loading-mask')].some(e=>e.getBoundingClientRect().width>0)`, 'manager filter settled',15000); }
            else { await page.click('.tab-list .tab-item:first-child'); await page.wait({time:0.5}); }
            const context=await page.evaluate(`(${managerAccount.toString()})(${JSON.stringify(platform)})`);
            if(!context.account || context.account.id!==job.review.account.id) throw new CliError('ACCOUNT_CHANGED','Current manager account differs from the submitted account');
            const filters=platform==='xiaohongshu' ? [['已发布','published','1'],['审核中','reviewing','2'],['未通过','rejected','3']] : [['视频',null,null]];
            let validLists=0;
            for(const [label,status,tab] of filters){
                const endpoint=platform==='sohu'?'/mpbp/bp/news/v4/users/news':'/api/galaxy/v2/creator/note/user/posted';
                await startReadCapture(page,endpoint);
                await clickText(page,label,platform==='xiaohongshu'?'.tab-list':'.tab_header');
                const lists=await waitReadCapture(page,e=>parseManagerList(platform,e,{accountId:job.review.account.id,tab}));
                if(!lists.length) continue;
                validLists++;
                const record=lists.flat().find(n=>String(n.note_id??n.noteId??n.id)===contentId);
                if(record) return {status:status||sohuStatuses[record.status]||'query_unavailable',contentId:contentId,contentType:platform==='xiaohongshu'?xhsManagerRecordType(record):(record.type===4?'video':null),platformStatus:platform==='sohu'?record.status:null,label};
            }
            return {status:validLists===filters.length?'not_found':'query_unavailable',reason:'Exact ID absent from loaded first-page lists; older pages and unavailable records are not assumed deleted'};
        }
    };
}
export async function managerAccount(platform){
    if(platform==='sohu'){
        const u=document.querySelector('#app')?.__vue__?.$store?.state?.app?.userInfo;
        return {account:u?.id?{id:String(u.id),name:u.nickName}:null};
    }
    const r=await fetch('/api/galaxy/creator/home/personal_info',{credentials:'include'}).then(r=>r.json());
    return {account:r.success && r.data?.red_num?{id:String(r.data.red_num),name:r.data.name}:null};
}

/** Strict GET manager responses, bound to the selected account/filter. Never infer by title. */
export function parseManagerList(platform,entry,{accountId,tab}){
    let url;try{url=new URL(entry.url)}catch{return null}
    if(entry.method!=='GET' || entry.responseStatus!==200 || entry.responseBodyTruncated || !entry.responsePreview) return null;
    const expected=platform==='sohu'?'/mpbp/bp/news/v4/users/news':'/api/galaxy/v2/creator/note/user/posted';
    if(url.protocol!=='https:' || url.hostname!==(platform==='sohu'?'mp.sohu.com':'creator.xiaohongshu.com') || url.pathname!==expected) return null;
    if(platform==='xiaohongshu' && url.searchParams.get('tab')!==tab) return null;
    if(platform==='sohu' && (url.searchParams.get('accountId')!==accountId || url.searchParams.get('newsType')!=='4')) return null;
    try{const b=JSON.parse(entry.responsePreview);if(b.code!==(platform==='sohu'?2000000:0) || b.success!==true) return null;const rows=platform==='sohu'?b.data?.videos:b.data?.notes;return Array.isArray(rows)?rows:null}catch{return null}
}

/** A persistent adapter lease owns one preferred tab. Never replace a live editor with a query tab. */
export async function openManagerPage(page, platform, originalPage) {
    const tabs = await page.tabs();
    if(platform==='sohu'&&tabs.some(t=>{try{const u=new URL(t.url);return u.origin==='https://mp.sohu.com'&&/^\/mpfe\/v4\/contentManagement\/news\/add(?:article|atlas|video)$/.test(u.pathname)}catch{return false}}))throw new CliError('EDITOR_IN_USE','Retain the existing Sohu article, gallery or video editor before querying');
    const manager = tabs.find(t => { try { const u=new URL(t.url); return u.origin+u.pathname===managers[platform]; } catch { return false; } });
    const analytics = tabs.find(t => { try { const u=new URL(t.url); return u.origin===new URL(managers[platform]).origin && (platform==='xiaohongshu' ? /^\/statistics(?:\/|$)/.test(u.pathname) : u.pathname==='/mpfe/v4/data/analysis'); } catch { return false; } });
    const target = manager || tabs.find(t => t.page === originalPage) || analytics || tabs.find(t=>t.url==='about:blank');
    if (target) {
        page.setActivePage(target.page);
        const editor = await page.evaluate(`!!document.querySelector(${JSON.stringify(platform==='sohu'?'input.titleErrorInput':'input[placeholder="填写标题会有更多赞哦"]')})`);
        if (editor) throw new CliError('EDITOR_IN_USE','An editor is open; retain it and finish or close it before querying another work');
        if (!manager) await page.goto(managers[platform], {stealth:false});
        return;
    }
    if (tabs.length) throw new CliError('MANAGER_UNAVAILABLE','Current owned page is not a verified manager or safe reusable page; retain it');
    page.setActivePage(undefined); await page.goto(managers[platform], {stealth:false});
}

export function xhsManagerRecordType(record) {
    if(record.type==='video')return 'video';
    if(record.type==='normal'&&Array.isArray(record.images_list)&&record.images_list.length>0)return 'image';
    return null;
}
