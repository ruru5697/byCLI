import {ArgumentError,CliError} from '@sovovs/bycli/errors';

export const ownerTypes={all:{newsType:'0',field:'news'},article:{newsType:'1',field:'news',recordType:2},gallery:{newsType:'3',field:'albums',recordType:3},video:{newsType:'4',field:'videos',recordType:4}};
export const ownerStatuses={all:{statusType:'1',selector:'.status-control.total'},published:{statusType:'2',selector:'.status-control.published',recordStatus:4},draft:{statusType:'6',selector:'.status-control[report-attr*="content-tabs-draft"]',recordStatus:1}};
export function searchArgs(args,scope){
 const keyword=args.keyword;
 if(typeof keyword!=='string'||!keyword.trim()||keyword.trim().length>100||/[\r\n\x00-\x1f]/.test(keyword))throw new ArgumentError('keyword requires 1–100 characters on one line');
 const limit=args.limit===undefined?10:Number(args.limit),page=args.page===undefined?1:Number(args.page);
 if(!Number.isInteger(limit)||limit<1||limit>(scope==='own'?10:50))throw new ArgumentError(scope==='own'?'--limit must be 1–10 (one backend page)':'--limit must be 1–50');
 if(!Number.isInteger(page)||page<1||page>50||scope==='public'&&page!==1)throw new ArgumentError('Owner --page must be 1–50; public search uses --limit and scrolling');
 const type=args.type||'all',status=args.status||'published';
 if(!ownerTypes[type]||!ownerStatuses[status])throw new ArgumentError('Expected --type all/article/video/gallery and --status published/all/draft');
 if(scope==='public'&&(args.type&&args.type!=='all'||args.status||args['account-id']))throw new ArgumentError('Public search has no verified content-type, owner-status or account filter');
 if(args['account-id']!==undefined&&(typeof args['account-id']!=='string'||!/^\d{1,30}$/.test(args['account-id'])))throw new ArgumentError('--account-id must be a numeric string');
 if(args['exact-title']!==undefined&&typeof args['exact-title']!=='boolean')throw new ArgumentError('--exact-title must be boolean');
 return {keyword:keyword.trim(),limit,page,type,status,accountId:args['account-id'],exactTitle:args['exact-title']===true};
}
export function publicContentUrl(raw){
 try{const u=new URL(raw,'https://www.sohu.com');if(u.protocol!=='https:'||u.hostname!=='www.sohu.com'||u.username||u.password)return null;
 const article=u.pathname.match(/^\/a\/([1-9]\d*)_([1-9]\d*)$/),gallery=u.pathname.match(/^\/picture\/([1-9]\d*)$/);
 if(article)return {url:u.origin+u.pathname,id:article[1],authorId:article[2],contentType:'article_or_video'};
 if(gallery)return {url:u.origin+u.pathname,id:gallery[1],authorId:null,contentType:'gallery'};
 }catch{}return null;
}
/** Pure and serializable: select safe owner fields before data leaves browser memory. */
export function parseOwnerResponse(entry,expected){
 const fail=error=>({error});let u,b;
 try{u=new URL(entry.url)}catch{return null}
 if(u.username||u.password||u.origin!=='https://mp.sohu.com'||u.pathname!=='/mpbp/bp/news/v4/users/news'||entry.method!=='GET')return null;
 for(const [key,value]of Object.entries({accountId:expected.accountId,titleKeyword:expected.keyword,newsType:expected.newsType,statusType:expected.statusType,pno:String(expected.page),psize:'10'}))if(u.searchParams.getAll(key).length!==1||u.searchParams.get(key)!==value)return null;
 if(entry.responseStatus!==200||entry.responseBodyTruncated)return fail('SEARCH_RESPONSE_UNAVAILABLE');
 try{b=JSON.parse(entry.responsePreview)}catch{return fail('SEARCH_RESPONSE_UNAVAILABLE')}
 if(b.code!==2000000||b.success!==true||!Array.isArray(b.data?.[expected.field]))return fail('SEARCH_RESPONSE_REJECTED');
 const id=value=>typeof value==='string'&&/^[1-9]\d{0,24}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
 const rows=[];
 for(const r of b.data[expected.field]){
  const contentId=id(r.id),accountId=id(r.userId),type=({2:'article',3:'gallery',4:'video'})[r.type]||'other';
  if(!contentId||accountId!==expected.accountId||typeof r.title!=='string'||!r.title.trim()||!Number.isInteger(r.status)||expected.recordType!==undefined&&r.type!==expected.recordType||expected.recordStatus!==undefined&&r.status!==expected.recordStatus)return fail('SEARCH_RESULT_MISMATCH');
  // The backend may tokenize titleKeyword; validate every candidate before local filtering.
  const publicUrl=r.status===4&&type!=='other'?(type==='gallery'?`https://www.sohu.com/picture/${contentId}`:`https://www.sohu.com/a/${contentId}_${accountId}`):null;
  rows.push({content_id:contentId,content_type:type,platform_type:r.type,title:r.title,status:({1:'draft',2:'reviewing',3:'rejected',4:'published',5:'scheduled'})[r.status]||'other',platform_status:r.status,account_id:accountId,url:publicUrl,post_time:Number.isSafeInteger(r.postTime)?r.postTime:null});
 }
 if(rows.length>10||new Set(rows.map(r=>r.content_id)).size!==rows.length)return fail('SEARCH_RESULT_MISMATCH');
 const total=b.data.totalCount;
 if(total!==undefined&&(!Number.isSafeInteger(total)||total<0||total<rows.length))return fail('SEARCH_RESULT_MISMATCH');
 return {results:rows,total:total??null};
}
/** DOM-bound public state. Result type is not a relevance flag: types 1/2/4
 * can all be genuine hits. Inspect query highlights and the observed fallback route. */
export function publicSearchSnapshot(){
 const root=document.querySelector('#news-list'),v=root?.__vue__,u=new URL(location.href);
 if(u.origin!=='https://search.sohu.com'||!v||!Array.isArray(v.searchResultList))return {unavailable:true};
 const cards=[...root.querySelectorAll('[data-spm-type="resource"]')].map(e=>{const item=e.__vue__?.$props?.item;const a=e.querySelector('.cards-content-title a,h4 a');return item&&a?{id:item.id,title:a.textContent.trim(),url:a.href}:null}).filter(Boolean);
 return {keyword:u.searchParams.get('keyword'),input:document.querySelector('#input-text')?.value,active:!!document.querySelector('#nav-left.nav-item-active'),loading:v.isLoading,finished:v.isFinish,nextPage:v.page,size:v.size,
  rows:v.searchResultList.map(r=>{if(!r||typeof r!=='object')return null;const d=document.createElement('div');d.innerHTML=[r.titleHL,r.briefAlgHL].filter(x=>typeof x==='string').join(' ');const query=u.searchParams.get('keyword')?.toLocaleLowerCase()||'';return {id:r.id,type:r.type,insertType:r.insertType,title:r.title,url:r.url,authorId:r.authorId,author:r.authorName,hasHeadVideo:r.hasHeadVideo,imageNews:r.imageNews,postTime:r.postTime,queryHighlighted:[...d.querySelectorAll('b')].some(e=>{const t=e.textContent.trim().toLocaleLowerCase();return t.length>0&&query.includes(t)}),scm:r.scm}}),cards};
}
export function publicResults(state,keyword){
 if(state.unavailable||state.keyword!==keyword||state.input!==keyword||state.active!==true)throw new CliError('PUBLIC_SEARCH_UNVERIFIED','Current public search query/tab cannot be verified');
 if(typeof state.loading!=='boolean'||typeof state.finished!=='boolean'||!Number.isSafeInteger(state.nextPage)||state.nextPage<1||state.size!==10||!Array.isArray(state.rows)||!Array.isArray(state.cards))throw new CliError('PUBLIC_SEARCH_UNVERIFIED','Public search loading/pagination model changed');
 if(state.loading||!state.rows.length&&!state.finished)return null;
 const results=[],seen=new Set(),warnings=[];let recommendations=0,injected=0,skipped=0;
 for(const [index,row]of state.rows.entries()){
  if(!row||typeof row!=='object'){skipped++;warnings.push({code:'PUBLIC_ROW_INVALID',index});continue}
  if(row.insertType&&row.insertType!=='not'){injected++;continue}
  const link=publicContentUrl(row.url),rawId=typeof row.id==='number'&&Number.isSafeInteger(row.id)?String(row.id):row.id;
  if(!link||link.id!==rawId||row.authorId!=null&&link.authorId!=null&&String(row.authorId)!==link.authorId||typeof row.title!=='string'||!row.title.trim()){
   skipped++;warnings.push({code:'PUBLIC_ROW_IDENTITY_UNVERIFIED',index});continue;
  }
  const rowWarnings=[];
  const domVerified=state.cards.some(c=>String(c.id)===rawId&&c.title===row.title&&publicContentUrl(c.url)?.url===link.url);
  if(!domVerified)rowWarnings.push('VISIBLE_CARD_UNVERIFIED');
  const knownType=[1,2,4].includes(row.type);
  if(!knownType)rowWarnings.push('UNKNOWN_PLATFORM_TYPE');
  const fallback=row.scm==='10023.20001_107-20001_107-20001_20001.0-0.0-1-1-0-0.0';
  const recommendation=fallback&&row.queryHighlighted===false?'observed_fallback':'unconfirmed';
  if(recommendation==='observed_fallback')recommendations++;
  if(row.queryHighlighted!==true)rowWarnings.push('QUERY_RELEVANCE_UNCONFIRMED');
  if(seen.has(link.url))continue;seen.add(link.url);
  results.push({content_id:link.id,content_type:knownType?link.contentType:'unknown',platform_type:typeof row.type==='number'||typeof row.type==='string'?row.type:null,title:row.title,url:link.url,author_id:link.authorId||String(row.authorId||'')||null,author:typeof row.author==='string'?row.author:null,has_head_video:typeof row.hasHeadVideo==='boolean'?row.hasHeadVideo:null,image_news:typeof row.imageNews==='boolean'?row.imageNews:null,post_time:Number.isSafeInteger(row.postTime)?row.postTime:null,match:{title_contains_keyword:row.title.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),title_equals_keyword:row.title.toLocaleLowerCase()===keyword.toLocaleLowerCase(),query_highlighted:typeof row.queryHighlighted==='boolean'?row.queryHighlighted:null,recommendation},verification:{source_identity:true,visible_card:domVerified},warnings:rowWarnings});
 }
 // Recommendations remain candidates. They do not prove that later pages are exhausted.
 return {results,recommendations,injected,skipped,warnings,finished:state.finished,nextPage:state.nextPage};
}
