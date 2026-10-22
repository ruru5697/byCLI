import { ArgumentError, CliError } from '@sovovs/bycli/errors';
import { managerAccount, openManagerPage } from './video-site-submit.js';

export function metricValue(label, raw, reason='not_exposed') {
    const text=raw == null ? null : String(raw).trim();
    if (!text || /^[-—–]+$/.test(text)) return {rawLabel:label,rawValue:text,value:null,availability:'unavailable',precision:null,reason:text?'platform_placeholder':reason};
    const m=text.replace(/,/g,'').match(/^(\d+(?:\.\d+)?)(万|亿|[wW])?(\+)?(%|秒)?$/);
    if (!m) return {rawLabel:label,rawValue:text,value:null,availability:'unavailable',precision:null,reason:'unrecognized_format'};
    const scale=m[2]==='亿'?1e8:m[2]?1e4:1;
    return {rawLabel:label,rawValue:text,value:Number(m[1])*scale,availability:'available',precision:m[3]?'lower_bound':m[2]?'rounded':'exact',unit:m[4]==='%'?'percent':m[4]==='秒'?'seconds':'count',reason:null};
}
export function validateStatsArgs(platform,kwargs) {
    const id=kwargs['content-id'];
    if (!(platform==='sohu'?/^[1-9]\d{0,24}$/:/^[a-f0-9]{24}$/).test(id||'')) throw new ArgumentError('A valid exact platform --content-id is required');
    if (kwargs.scope && kwargs.scope!=='content' || kwargs.type && !(platform==='xiaohongshu'?['video','image']:['video','gallery','article']).includes(kwargs.type)) throw new ArgumentError('Only content scope and supported platform content types are allowed');
    return id;
}
export async function openStatsPage(page,platform,url) {
    await openManagerPage(page,platform);
    await page.goto(url,{stealth:false});
    await page.focusWindow();
}
export async function statsAccount(page,platform,expected) {
    const {account}=await page.evaluate(`(${managerAccount.toString()})(${JSON.stringify(platform)})`);
    if(!account || expected && account.id!==expected)throw new CliError('ACCOUNT_CHANGED','Analytics account is missing or differs from --account-id');
    return account;
}
export const metricLabels = {xiaohongshu:{impressions:'曝光数',views:'观看数',coverClickRate:'封面点击率',averageWatchTime:'平均观看时长',completionRate:'完播率',exitRate2s:'2秒退出率',followers:'涨粉数',likes:'点赞数',comments:'评论数',favorites:'收藏数',shares:'分享数'},sohu:{reads:'阅读数',plays:'访问（播放）数',likes:'点赞数',comments:'评论数',shares:'分享数',votes:'投票数',favorites:'收藏数'}};
