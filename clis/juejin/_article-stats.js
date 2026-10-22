import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {openArticleReadPage,ownerAccount} from './_article-query.js';import {waitFor} from '../_shared/video-prepare.js';import {metricValue} from '../_shared/video-stats.js';
export const ANALYTICS_URL='https://juejin.cn/creator/data/content/article/single';
export const ARTICLE_METRICS={impressions:['展现数','display_count'],reads:['阅读数','view_count'],likes:['点赞数','digg_count'],comments:['评论数','comment_count'],favorites:['收藏数','collect_count']};
export function validateArticleStatsArgs(a){if(typeof a['content-id']!=='string'||!/^[1-9]\d{0,29}$/.test(a['content-id'])||typeof a['account-id']!=='string'||!/^\d{1,30}$/.test(a['account-id'])||a.type&&a.type!=='article'||a.scope&&a.scope!=='content')throw new ArgumentError('Exact article --content-id and public --account-id required; only article/content supported');return a['content-id'];}
/** Bind the rendered row to its article ID via Vue VNode key, never by title or row position. */
export function articleAnalyticsSnapshot(id){
 const vm=document.querySelector('.alone-container')?.__vue__;if(!vm||vm.loading||!Array.isArray(vm.dataList))return {loading:true};
 const records=vm.dataList.filter(r=>r.article_id===id);if(records.length!==1)return {matches:records.length,page:vm.pageNo,total:vm.total};
 const r=records[0],info=r.article_info,rows=[];
 const visit=n=>{if(!n)return;if(n.tag==='tr'&&n.key===id&&n.elm)rows.push(n.elm);for(const c of n.children||[])visit(c);if(n.componentInstance)visit(n.componentInstance._vnode)};visit(vm._vnode);
 if(rows.length!==1)return {rowMatches:rows.length};const row=rows[0];
 return {id:r.article_id,infoId:info?.article_id,accountId:info?.user_id,title:info?.title,page:vm.pageNo,total:vm.total,headers:[...row.closest('table').querySelectorAll('thead th')].map(e=>e.innerText.trim()),cells:[...row.querySelectorAll('td')].map(e=>e.innerText.trim()),values:{impressions:info?.display_count,reads:info?.view_count,likes:info?.digg_count,comments:info?.comment_count,favorites:info?.collect_count},overviewDate:document.body.innerText.match(/(\d{4}-\d{2}-\d{2}) 数据表现/)?.[1]||null};
}
export function verifiedArticleMetrics(s,id,accountId){
 if(s.loading)throw new CliError('METRICS_UNAVAILABLE','Analytics is still loading');
 if(s.id!==id||s.infoId!==id||s.accountId!==accountId)throw new CliError('CONTENT_NOT_FOUND','Exact article absent or ambiguous in the loaded first analytics page, or owner differs; no zero values inferred');
 if(!Array.isArray(s.headers)||!Array.isArray(s.cells))throw new CliError('DOM_ID_UNVERIFIED','Exact keyed analytics row unavailable');
 const column=label=>{const indices=s.headers.flatMap((h,i)=>h===label?[i]:[]);if(indices.length!==1)throw new CliError('METRICS_UNAVAILABLE','Required analytics header missing or duplicated');return indices[0]};
 if(s.cells[column('文章标题')]!==s.title)throw new CliError('DOM_ID_UNVERIFIED','Rendered article title differs from exact record');
 const metrics={};for(const [key,[label]]of Object.entries(ARTICLE_METRICS)){
  const n=s.values[key],visible=metricValue(label,s.cells[column(label)]);
  if(!Number.isSafeInteger(n)||n<0||visible.availability!=='available'||visible.precision!=='exact'||visible.value!==n)throw new CliError('METRIC_MISMATCH',`Visible ${key} differs from its exact model value`);
  metrics[key]=visible;
 }
 metrics.shares=metricValue('分享数',undefined,'not_exposed');return {metrics,publishedAt:s.cells[column('发布时间')]};
}
export async function collectArticleStats(page,args){
 const id=validateArticleStatsArgs(args);await openArticleReadPage(page,ANALYTICS_URL);
 await waitFor(page,`performance.getEntriesByType('resource').some(r=>r.name.includes('/content_api/v1/article/list_by_user')&&r.responseEnd>0)`,'completed single-article analytics response',45000);
 await waitFor(page,`!!document.querySelector('.alone-container')?.__vue__&&!document.querySelector('.alone-container').__vue__.loading`,'rendered article analytics',45000);
 const account=await ownerAccount(page,args['account-id']),snapshot=await page.evaluate(`(${articleAnalyticsSnapshot.toString()})(${JSON.stringify(id)})`),result=verifiedArticleMetrics(snapshot,id,account.id);await ownerAccount(page,account.id);
 return [{platform:'juejin',contentType:'article',scope:'content',contentId:id,title:snapshot.title,account,publishedAt:result.publishedAt,collectedAt:new Date().toISOString(),dataAsOf:null,period:{kind:'content_cumulative',description:'单篇分析列表当前累计值；不是顶部昨日概览或趋势新增量'},source:{kind:'owner_analytics_model_and_keyed_dom',url:ANALYTICS_URL,page:snapshot.page,overviewDate:snapshot.overviewDate},metrics:result.metrics,limitations:['当前第一页，未命中明确报错','单篇表提供展现、阅读、点赞、评论、收藏，未提供分享数','顶部数据表现日期属于整体概览，不作为单篇指标更新时间','没有精确更新时刻，指标可能延迟；本次公开页验证可能产生一次阅读']}];
}
