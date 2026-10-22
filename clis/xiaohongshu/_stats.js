import { makeVideoAdapter, openManagerPage } from '../_shared/video-site-submit.js';
import { CliError } from '@sovovs/bycli/errors';
import { waitFor } from '../_shared/video-prepare.js';
import { metricValue, metricLabels, validateStatsArgs, statsAccount } from '../_shared/video-stats.js';

export function noteMetrics(type, rows) {
    const labels=Object.fromEntries(Object.entries(metricLabels.xiaohongshu).filter(([key])=>type==='video'||!['completionRate','exitRate2s'].includes(key)));
    if(!Array.isArray(rows) || Object.values(labels).some(label=>rows.filter(row=>row.label===label).length!==1))throw new CliError('METRICS_UNAVAILABLE','Expected analytics labels are missing or duplicated; no partial metrics returned');
    return Object.fromEntries(Object.entries(labels).map(([key,label])=>[key,metricValue(label,rows.find(row=>row.label===label).value)]));
}

export async function collectNoteStats(page,kwargs) {
    const contentId=validateStatsArgs('xiaohongshu',kwargs);
    const type=kwargs.type||'video';
    const url=`https://creator.xiaohongshu.com/statistics/note-detail?noteId=${contentId}`;
    await openManagerPage(page,'xiaohongshu');
    await waitFor(page,`document.querySelectorAll('.tab-list .tab-item').length>=4`,'owner content manager',30000);
    const account=await statsAccount(page,'xiaohongshu',kwargs['account-id']);
    const identity=await makeVideoAdapter('xiaohongshu',()=>{}).query(page,{receipt:{contentId},review:{account}});
    if(identity.contentType!==type)throw new CliError('CONTENT_TYPE_UNVERIFIED',`Exact owner ID must be verified as ${type}; found ${identity.contentType||'unknown'}`);
    await page.goto(url,{stealth:false});await page.focusWindow();
    await waitFor(page,`!!document.querySelector('.note-info-content') && document.querySelectorAll('.block-container.block').length>=5`,'note analytics',30000);
    await statsAccount(page,'xiaohongshu',account.id);
    const data=await page.evaluate(String.raw`(()=>({id:new URL(location.href).searchParams.get('noteId'),title:document.querySelector('.note-title')?.innerText||document.querySelector('.note-info-content')?.innerText.split('\n')[0],info:document.querySelector('.note-info-content')?.innerText,metrics:[...document.querySelectorAll('.shell-container .block-container.block')].map(b=>({label:b.querySelector('.des')?.innerText.trim(),value:b.querySelector('.content')?.innerText.trim()})),text:document.body.innerText}))()`);
    if(data.id!==contentId || !data.title || !data.info?.includes('笔记状态正常'))throw new CliError('CONTENT_UNVERIFIED','Note detail identity or normal state could not be verified');
    const metrics=noteMetrics(type,data.metrics);
    const finalAccount=await statsAccount(page,'xiaohongshu',account.id);
    return [{platform:'xiaohongshu',contentId,contentType:type,scope:'content',account:finalAccount,title:data.title,period:{kind:'platform_detail_current',description:'单篇详情当前展示值；趋势数据另按天更新'},dataAsOf:null,collectedAt:new Date().toISOString(),source:{kind:'owner_analytics_dom',url,identity:`exact_owner_${type}_record`},publishedAt:data.info.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0]||null,limitations:data.text.includes('观看数不足100')?['观看数不足100，部分分析不可用；后台未提供统一更新时间']:['后台未提供统一更新时间'],metrics}];
}
// Preserve the existing video-only programmatic entry point.
export const collectVideoStats=(page,kwargs)=>collectNoteStats(page,{...kwargs,type:'video'});
