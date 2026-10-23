import {cli,Strategy} from '@sovovs/bycli/registry';
import {CliError} from '@sovovs/bycli/errors';
import {searchArgs,publicSearchSnapshot,publicResults} from './_search.js';
import {editorType,editorInUse} from './_editor.js';

export async function settledPublic(page,keyword,timeoutMs=20000){
 const deadline=Date.now()+timeoutMs;let last;
 do{
  const state=await page.evaluate(`(${publicSearchSnapshot.toString()})()`);
  if(!state.unavailable){
   try{const r=publicResults(state,keyword);if(r)return r}catch(e){if(e.code!=='SEARCH_DOM_PENDING')throw e;last=e}
  }
  await page.wait({time:.25});
 }while(Date.now()<deadline);
 throw new CliError(last?.code||'SEARCH_TIMEOUT','Public search results did not finish loading; no empty result assumed');
}
export async function searchPublic(page,args){
 const options=searchArgs(args,'public');
 const tabs=await page.tabs();const editor=tabs.find(t=>editorType(t.url));if(editor)throw editorInUse(editor);
 if(tabs.some(t=>{try{return t.url!=='about:blank'&&new URL(t.url).origin!=='https://search.sohu.com'}catch{return true}}))throw new CliError('SEARCH_PAGE_IN_USE','Retain the current owned page; public search requires its own ephemeral query tab');
 await page.goto('https://search.sohu.com/?keyword='+encodeURIComponent(options.keyword),{stealth:false});
 let data=await settledPublic(page,options.keyword),stopReason='limit_reached';
 const warnings=[];
 const selected=d=>options.exactTitle?d.results.filter(r=>r.match.title_equals_keyword):d.results;
 // Use the real infinite-scroll UI. Bounded attempts prevent endless recommendation loops.
 for(let attempt=0;selected(data).length<options.limit&&!data.finished&&attempt<7;attempt++){
  try{
  const before=data.nextPage,count=data.results.length;
  await page.evaluate(`(()=>{window.scrollTo(0,0);window.scrollTo(0,document.body.scrollHeight);return true})()`);
  const end=Date.now()+12000;let progressed=false;
  do{
   const next=await settledPublic(page,options.keyword,5000);
   if(next.nextPage>before||next.results.length>count||next.finished){data=next;progressed=true;break}
   await page.wait({time:.25});
  }while(Date.now()<end);
  if(!progressed){stopReason='scroll_no_progress';break}
  }catch(e){stopReason='scroll_failed';warnings.push({code:typeof e.code==='string'?e.code:'SCROLL_FAILED',phase:'scroll'});break}
 }
 if(data.finished&&selected(data).length<=options.limit)stopReason='platform_finished';
 else if(selected(data).length<options.limit&&stopReason==='limit_reached')stopReason='scroll_bound_reached';
 const matching=selected(data),results=matching.slice(0,options.limit);
 const rowWarnings=data.results.some(r=>r.warnings.includes('VISIBLE_CARD_UNVERIFIED'));
 const partial=['scroll_no_progress','scroll_bound_reached','scroll_failed'].includes(stopReason)||data.skipped>0||rowWarnings;
 return [{collected_at:new Date().toISOString(),scope:'public',keyword:options.keyword,exact_title:options.exactTitle,total:null,candidates_loaded:data.results.length,excluded_nonmatching:data.results.length-matching.length,returned:results.length,has_more:matching.length>results.length||!data.finished,partial,stop_reason:stopReason,excluded_recommendations:0,observed_recommendations:data.recommendations,excluded_injected:data.injected,skipped_invalid:data.skipped,warnings:[...data.warnings,...warnings],results,source:{kind:'public_comprehensive_search_model_and_dom',url:'https://search.sohu.com/?keyword='+encodeURIComponent(options.keyword)},limitations:['搜狐综合公开搜索索引，不保证收录全部公开作品','默认保留平台候选和疑似推荐，match仅提供证据，相关性由调用方判断','--exact-title显式按完整标题相等筛选；滚动失败保留已加载候选','公开搜索未提供可验证的独立文章/视频/图集筛选，/a/链接类型标为article_or_video','平台没有提供可靠命中总数，total为null；使用实际页面滚动加载更多结果']}];
}
export const command=cli({site:'sohu',name:'search-public',access:'read',description:'搜索搜狐全站公开候选，保留匹配证据和异常，以真实页面滚动加载结果',domain:'search.sohu.com',strategy:Strategy.PUBLIC,browser:true,navigateBefore:false,siteSession:'ephemeral',args:[{name:'keyword',positional:true,required:true,help:'关键词；账号检索匹配标题，公开检索使用搜狐综合搜索'},{name:'exact-title',type:'boolean',default:false,help:'Explicitly keep only case-insensitive full-title equality'},{name:'limit',type:'int',default:10,help:'Return up to 50 platform candidates using real infinite scroll'},{name:'timeout',type:'int',default:180}],columns:['collected_at','scope','keyword','exact_title','total','candidates_loaded','excluded_nonmatching','returned','has_more','partial','stop_reason','excluded_recommendations','observed_recommendations','excluded_injected','skipped_invalid','warnings','results','source','limitations'],func:searchPublic});
