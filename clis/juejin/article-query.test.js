import {describe,it,expect,vi} from 'vitest';import{ownerArticleSnapshot,selectOwnerArticle,ownerArticleState,openArticleReadPage}from'./_article-query.js';
const row=()=>({id:'123',draftId:'789',accountId:'456',title:'test',url:'https://juejin.cn/post/123',status:1,auditStatus:2,visibleLevel:0});
describe('exact owner article status',()=>{
 it('checks exact account, ID and original draft',()=>expect(selectOwnerArticle([row()],'123','456','789')).toEqual(row()));
 it.each([{accountId:'wrong'},{draftId:'wrong'},{url:'https://evil.example/post/123'}])('rejects identity mismatch %j',patch=>expect(()=>selectOwnerArticle([{...row(),...patch}],'123','456','789')).toThrow());
 it('does not pick a same-title record with a different ID',()=>expect(selectOwnerArticle([{...row(),id:'124'}],'123','456')).toBeNull());
 it('does not claim missing content was deleted',()=>expect(ownerArticleState(null).status).toBe('not_found'));
 it.each([[2,1,0,'published'],[2,2,0,'published'],[1,1,0,'reviewing'],[0,1,0,'reviewing'],[-1,1,0,'rejected'],[3,1,0,'updating'],[2,-1,0,'deleted'],[2,1,1,'query_unavailable'],[42,1,0,'query_unavailable']])('maps audit %s status %s visibility %s to %s',(auditStatus,status,visibleLevel,expected)=>expect(ownerArticleState({...row(),auditStatus,status,visibleLevel}).status).toBe(expected));
 it('does not navigate an owned editor',async()=>{const p={tabs:async()=>[{page:'a'}],setActivePage:vi.fn(),evaluate:async()=> 'https://juejin.cn/editor/drafts/789',goto:vi.fn()};await expect(openArticleReadPage(p,'https://juejin.cn/creator/content/article/essays')).rejects.toMatchObject({code:'EDITOR_IN_USE'});expect(p.goto).not.toHaveBeenCalled()});
});

describe('hydrated NuxtLink record binding',()=>{
 it('uses the owning article component when the link VM is NuxtLink',()=>{
  const info={article_id:'123',user_id:'456',draft_id:'789',title:'test',status:1,audit_status:2,visible_level:0};
  const element={__vue__:{$props:{},$parent:{$props:{data:{article_id:'123',article_info:info}}}},origin:'https://juejin.cn',pathname:'/post/123',innerText:'test'};
  vi.stubGlobal('document',{querySelectorAll:()=>[element]});try{expect(ownerArticleSnapshot()[0]).toMatchObject({id:'123',accountId:'456',draftId:'789',status:1,auditStatus:2})}finally{vi.unstubAllGlobals()}
 });
 it('does not convert missing hydration identity into not_found',()=>expect(()=>selectOwnerArticle([{url:'https://juejin.cn/post/123'}],'123','456')).toThrow('not yet bound'));
});
