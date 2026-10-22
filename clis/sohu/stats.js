import {startReadCapture,waitReadCapture} from '../_shared/read-response-capture.js';
import {cli,Strategy} from '@sovovs/bycli/registry';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {waitFor} from '../_shared/video-prepare.js';
import {metricValue,metricLabels,validateStatsArgs,openStatsPage,statsAccount} from '../_shared/video-stats.js';

const endpoint='/mpbp/bp/news/v4/users/stat/single/list';
export function statsConfig(type='video'){
 if(!['video','gallery','article'].includes(type))throw new ArgumentError('Expected --type video, gallery or article');
 const labels=Object.fromEntries(Object.entries(metricLabels.sohu).map(([key,label])=>[key==='plays'&&type!=='video'?'visits':key,label]));
 return {tab:type==='video'?'2':'1',recordType:type==='video'?4:type==='gallery'?3:2,labels};
}
export function parseSingleList(entry,accountId,type='video'){
 if(!['video','gallery','article'].includes(type))return null;
 let u;try{u=new URL(entry.url)}catch{return null}
 if(u.origin!=='https://mp.sohu.com'||u.pathname!==endpoint||u.searchParams.get('accountId')!==accountId||u.searchParams.get('type')!==statsConfig(type).tab||entry.method!=='GET'||entry.responseStatus!==200||entry.responseBodyTruncated)return null;
 const start=u.searchParams.get('startDate'),end=u.searchParams.get('endDate'),page=Number(u.searchParams.get('page'));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start||'')||!/^\d{4}-\d{2}-\d{2}$/.test(end||'')||start>end||!Number.isSafeInteger(page)||page<1)return null;
 try{const b=JSON.parse(entry.responsePreview);if(b.code!==2000000||b.success!==true||!Array.isArray(b.data?.news))return null;return {records:b.data.news,period:{kind:'publication_date_filter',start,end,description:'所选发布日期内内容的实时累计统计；不是区间内新增量'},page,total:b.data.totalCount}}catch{return null}
}
export function selectStatsRecord(lists,contentId,type){
 const matches=lists.flatMap(list=>list.records.filter(r=>(typeof r.newsId==='string'||Number.isSafeInteger(r.newsId))&&String(r.newsId)===contentId).map(record=>({record,list})));
 if(matches.length!==1)throw new CliError('CONTENT_NOT_IN_RANGE','Exact ID is absent or ambiguous in the loaded first page / current publication-date range; no zero metrics inferred');
 if(matches[0].record.type!==statsConfig(type).recordType)throw new CliError('CONTENT_TYPE_UNVERIFIED','Exact analytics ID belongs to another content type');
 return matches[0];
}
const fields={reads:'pv',plays:'pvValid',visits:'pvValid',likes:'likeCount',comments:'commentCount',shares:'shareCount',votes:'voteCount'};
export function verifiedMetrics(record,dom,type){
 const config=statsConfig(type);
 if(!dom||String(record.newsId)!==dom.id||dom.type!==config.recordType)throw new CliError('DOM_ID_UNVERIFIED','Visible row must match the exact response ID and content type');
 const metrics={};
 for(const [key,label]of Object.entries(config.labels)){
  if(key==='favorites'){metrics[key]=metricValue(label,undefined);continue}
  const columns=dom.headers.map((h,i)=>h===label?i:-1).filter(i=>i>=0);
  if(columns.length!==1)throw new CliError('METRICS_UNAVAILABLE','Expected analytics header missing or duplicated');
  const metric=metricValue(label,record[fields[key]]),visible=metricValue(label,dom.cells[columns[0]]);
  if(visible.value!==metric.value||visible.precision!==metric.precision||visible.availability!==metric.availability)throw new CliError('METRIC_MISMATCH',`Visible ${key} differs from the signed analytics response`);
  metrics[key]={...metric,rawValue:visible.rawValue,reason:visible.reason??metric.reason};
 }
 return metrics;
}
export async function collectContentStats(page,kwargs){
 const contentId=validateStatsArgs('sohu',kwargs),type=kwargs.type||'video',config=statsConfig(type),url='https://mp.sohu.com/mpfe/v4/data/analysis';
 await openStatsPage(page,'sohu',url);
 await waitFor(page,`!!document.querySelector('[report-attr*="data-tab-analysissingle"]')`,'analytics tabs',30000);
 const account=await statsAccount(page,'sohu',kwargs['account-id']);
 await page.click('[report-attr*="data-tab-analysissingle"]');
 await waitFor(page,`document.body.innerText.includes('单篇内容实时统计数据')`,'single-content analytics',45000);
 // Select a neutral type before capturing the target filter's normal signed request.
 await page.click('#tab-0');await page.wait({time:1});await startReadCapture(page,endpoint);await page.click('#tab-'+config.tab);
 const lists=await waitReadCapture(page,e=>parseSingleList(e,account.id,type));
 await statsAccount(page,'sohu',account.id);
 const {record,list}=selectStatsRecord(lists,contentId,type);
 await waitFor(page,`[...document.querySelectorAll('.el-table__row')].some(e=>String(e.__vue__?.$props?.row?.newsId)===${JSON.stringify(contentId)}&&e.__vue__.$props.row.type===${config.recordType})`,'rendered exact analytics row',10000);
 const dom=await page.evaluate(`(()=>{const rows=[...document.querySelectorAll('.el-table__row')].filter(e=>String(e.__vue__?.$props?.row?.newsId)===${JSON.stringify(contentId)});if(rows.length!==1)return null;const row=rows[0];return {cells:[...row.querySelectorAll('td')].map(e=>e.innerText.trim()),headers:[...row.closest('.el-table').querySelectorAll('.el-table__header-wrapper th')].map(e=>e.innerText.trim()),id:String(row.__vue__.$props.row.newsId),type:row.__vue__.$props.row.type}})()`);
 const metrics=verifiedMetrics(record,dom,type);
 await statsAccount(page,'sohu',account.id);
 return [{platform:'sohu',contentId,contentType:type,scope:'content',account,title:record.title,period:list.period,dataAsOf:null,collectedAt:new Date().toISOString(),source:{kind:'owner_analytics_response_and_dom',url,endpoint,filterType:config.tab,recordType:config.recordType},publishedAt:record.date,limitations:['后台标注实时统计但未提供精确更新时间','收藏数未在该表提供','当前默认发布日期范围及第一页，未命中明确报错',...(type==='video'?[]:['访问（播放）数按后台原标签保留，不解释为独立访客数或视频播放量'])],metrics}];
}
// Preserve the original video-only programmatic entry point.
export const collectVideoStats=(page,kwargs)=>collectContentStats(page,{...kwargs,type:'video'});
cli({site:'sohu',name:'stats',access:'read',description:'按精确ID采集搜狐号视频、图集或文章单篇实时数据，并核对后台表格',domain:'mp.sohu.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,siteSession:'persistent',args:[{name:'content-id',required:true},{name:'account-id',help:'Expected Sohu account ID'},{name:'type',default:'video',choices:['video','gallery','article']},{name:'scope',default:'content',choices:['content']},{name:'timeout',type:'int',default:180,help:'Overall browser command timeout in seconds'}],columns:['platform','contentId','contentType','title','collectedAt','metrics'],func:collectContentStats});
