import {cli,Strategy} from '@sovovs/bycli/registry';
import {CliError} from '@sovovs/bycli/errors';
import {openManagerPage} from '../_shared/video-site-submit.js';
import {statsAccount} from '../_shared/video-stats.js';
import {startReadCapture} from '../_shared/read-response-capture.js';
import {waitFor} from '../_shared/video-prepare.js';
import {searchArgs,ownerTypes,ownerStatuses,parseOwnerResponse} from './_search.js';

export function ownerSnapshot(expected,parse){
 const captures=(window.__bycliReadCapture?.entries||[]).map(e=>parse(e,expected)).filter(Boolean);
 const dom=[...document.querySelectorAll('.content-item')].map(row=>{const r=[row,...row.querySelectorAll('*')].map(e=>e.__vue__?._props?.article).find(Boolean);return {id:r?String(r.id??r.newsId):null,title:row.querySelector('h3.title a')?.innerText.trim()}});
 const totalMatch=document.querySelector('.mt-pagination__total')?.innerText.match(/共\s*(\d+)\s*条/);
 return {domTotal:totalMatch?Number(totalMatch[1]):null,response:captures.at(-1),dom,input:document.querySelector('input[placeholder="请输入关键词"]')?.value,activeType:document.querySelector('.tab_header_current')?.getAttribute('href'),activeStatus:document.querySelector('.status-control.status-active')?.getAttribute('report-attr'),empty:document.body.innerText.includes('搜索结果为空')||document.body.innerText.includes('这里空空如也'),activePage:document.querySelector('.mt-pager .active')?.innerText.trim()||null,nextDisabled:!document.querySelector('.mt-pagination .btn-next')||document.querySelector('.mt-pagination .btn-next').disabled};
}
export function ownerSnapshotMatches(state,expected){
 const response=state.response;
 if(!response||response.error||state.input!==expected.keyword||!state.activeType)return false;
 let type;try{type=new URL(state.activeType,'https://mp.sohu.com').searchParams.get('newsType')}catch{return false}
 if(type!==expected.newsType)return false;
 const statusCode={1:'all',2:'published',6:'draft'}[expected.statusType];
 if(!state.activeStatus?.includes('content-tabs-'+statusCode))return false;
 if(response.total!==null&&state.domTotal!==null&&state.domTotal!==undefined&&response.total!==state.domTotal)return false;
 if(response.results.length===0)return state.dom.length===0&&state.empty&&(state.activePage===null||state.activePage===String(expected.page));
 return state.activePage===String(expected.page)&&state.dom.length===response.results.length&&response.results.every((r,i)=>r.content_id===state.dom[i]?.id&&r.title===state.dom[i]?.title);
}
async function settledOwner(page,expected,timeoutMs=20000){
 const end=Date.now()+timeoutMs;let state;
 do{
  state=await page.evaluate(`(${ownerSnapshot.toString()})(${JSON.stringify(expected)},(${parseOwnerResponse.toString()}))`);
  if(ownerSnapshotMatches(state,expected))return state;
  await page.wait({time:.25});
 }while(Date.now()<end);
 throw new CliError(state?.response?.error||'SEARCH_TIMEOUT','Keyword/filter response and visible owner search rows did not agree');
}
export async function searchOwn(page,args){
 const options=searchArgs(args,'own'),config=ownerTypes[options.type],status=ownerStatuses[options.status];
 await openManagerPage(page,'sohu');await page.focusWindow();
 await waitFor(page,`!!document.querySelector('input[placeholder="请输入关键词"]')&&!!document.querySelector('.tab_header_0')`,'logged-in content search',30000);
 const account=await statsAccount(page,'sohu',options.accountId);
 // Clear the prior query before selecting type/status, then capture only the final search.
 await page.typeText('input[placeholder="请输入关键词"]','');
 await page.click('.tab_header_'+config.newsType);
 await waitFor(page,`!!document.querySelector(${JSON.stringify(status.selector)})`,'content status filter',15000);
 // Type navigation can finish after its tab becomes active and reset status to ALL.
 // Wait for the selected status to remain stable before submitting the query.
 const statusCode={1:'all',2:'published',6:'draft'}[status.statusType];
 let selected=false;
 for(let attempt=0;attempt<4;attempt++){
  await page.click(status.selector);
  const active=()=>page.evaluate(`(()=>{const a=document.querySelector('.tab_header_current');return !!a&&new URL(a.getAttribute('href'),location.origin).searchParams.get('newsType')===${JSON.stringify(config.newsType)}&&!!document.querySelector('.status-control.status-active')?.getAttribute('report-attr')?.includes(${JSON.stringify('content-tabs-'+statusCode)})})()`);
  await page.wait({time:.3});
  if(await active()){await page.wait({time:.3});if(await active()){selected=true;break}}
 }
 if(!selected)throw new CliError('SEARCH_FILTER_UNAVAILABLE','Requested owner type/status did not settle; no other status queried');
 await page.typeText('input[placeholder="请输入关键词"]',options.keyword);
 await startReadCapture(page,'/mpbp/bp/news/v4/users/news?');
 await page.click('.article-header_search button');
 const expected={...config,...status,accountId:account.id,keyword:options.keyword,page:1};
 let state=await settledOwner(page,expected);
 for(let n=2;n<=options.page;n++){
  if(state.nextDisabled)throw new CliError('SEARCH_PAGE_OUT_OF_RANGE','Requested page exceeds the current matching owner results');
  await startReadCapture(page,'/mpbp/bp/news/v4/users/news?');
  await page.click('.mt-pagination .btn-next');expected.page=n;state=await settledOwner(page,expected);
 }
 await statsAccount(page,'sohu',account.id);
 const candidates=state.response.results.map(r=>({...r,match:{title_contains_keyword:r.title.toLocaleLowerCase().includes(options.keyword.toLocaleLowerCase()),title_equals_keyword:r.title.toLocaleLowerCase()===options.keyword.toLocaleLowerCase(),query_highlighted:null,recommendation:'unconfirmed'},warnings:r.content_type==='other'?['UNKNOWN_PLATFORM_TYPE']:[]}));
 const matching=options.exactTitle?candidates.filter(r=>r.match.title_equals_keyword):candidates;
 const results=matching.slice(0,options.limit),backendTotal=state.response.total;
 const total=options.exactTitle?(options.page===1&&state.nextDisabled&&backendTotal===candidates.length?matching.length:null):backendTotal;
 return [{collected_at:new Date().toISOString(),scope:'own',keyword:options.keyword,exact_title:options.exactTitle,type:options.type,status:options.status,account,page:options.page,page_size:10,total,backend_total:backendTotal,candidates_on_page:candidates.length,excluded_nonmatching:candidates.length-matching.length,returned:results.length,has_next_page:!state.nextDisabled,remaining_on_page:matching.length-results.length,has_more:matching.length>results.length||!state.nextDisabled,results,source:{kind:'owner_title_search_response_and_dom',url:'https://mp.sohu.com/mpfe/v4/contentManagement/first/page',endpoint:'/mpbp/bp/news/v4/users/news'},limitations:['默认保留平台候选，可能分词召回；match字段是匹配证据，相关性由调用方判断','--exact-title显式按完整标题相等筛选，不区分大小写','page是平台候选页；显式过滤后可能为空，has_next_page仅表示还有候选页','全部内容/已发布/草稿为独立状态；公开链接仅返回已发布作品',...(options.exactTitle&&total===null?['精确匹配总数未知；backend_total仅为平台候选数']:[])]}];
}
export const command=cli({site:'sohu',name:'search',access:'read',description:'按关键词搜索当前搜狐号账号的文章、视频或图集，核对所属账号和精确ID',domain:'mp.sohu.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,siteSession:'persistent',args:[{name:'keyword',positional:true,required:true,help:'关键词；账号检索匹配标题，公开检索使用搜狐综合搜索'},{name:'exact-title',type:'boolean',default:false,help:'Explicitly keep only case-insensitive full-title equality'},{name:'type',default:'all',choices:['all','article','video','gallery']},{name:'status',default:'published',choices:['published','all','draft']},{name:'account-id',valueRequired:true,help:'Expected current Sohu account ID'},{name:'page',type:'int',default:1,help:'Backend page 1–50; 10 records per page'},{name:'limit',type:'int',default:10,help:'Return 1–10 records from this page'},{name:'timeout',type:'int',default:180}],columns:['collected_at','scope','keyword','exact_title','account','type','status','page','page_size','total','backend_total','candidates_on_page','excluded_nonmatching','returned','has_next_page','remaining_on_page','has_more','results','source','limitations'],func:searchOwn});
