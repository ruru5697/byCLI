import{describe,it,expect}from'vitest';import{validateArticleStatsArgs,verifiedArticleMetrics}from'./stats.js';
const fixture=()=>({id:'123',infoId:'123',accountId:'456',title:'title',headers:['文章标题','发布时间','展现数','阅读数','点赞数','评论数','收藏数','操作'],cells:['title','2026-10-20','0','1','0','0','0','详情'],values:{impressions:0,reads:1,likes:0,comments:0,favorites:0}});
describe('Juejin single article metrics',()=>{
 it('retains exact zeros and missing shares',()=>{const r=verifiedArticleMetrics(fixture(),'123','456');expect(r.metrics.reads.value).toBe(1);expect(r.metrics.likes.value).toBe(0);expect(r.metrics.shares).toMatchObject({value:null,availability:'unavailable',reason:'not_exposed'});});
 it.each([{id:'wrong'},{infoId:'wrong'},{accountId:'wrong'},{matches:0,id:null},{loading:true},{title:'other'}])('rejects missing or inconsistent identity %j',p=>expect(()=>verifiedArticleMetrics({...fixture(),...p},'123','456')).toThrow());
 it('does not compare by column position',()=>{const f=fixture();[f.headers[2],f.headers[3]]=[f.headers[3],f.headers[2]];[f.cells[2],f.cells[3]]=[f.cells[3],f.cells[2]];expect(verifiedArticleMetrics(f,'123','456').metrics.reads.value).toBe(1);});
 it.each(['—','1万','2','bad'])('rejects a placeholder, rounded or mismatching visible value %s',v=>{const f=fixture();f.cells[3]=v;expect(()=>verifiedArticleMetrics(f,'123','456')).toThrow();});
 it('rejects duplicated headers',()=>{const f=fixture();f.headers[4]='阅读数';expect(()=>verifiedArticleMetrics(f,'123','456')).toThrow();});
 it.each([{'content-id':123,'account-id':'456'},{'content-id':'123'},{'content-id':'123','account-id':'456',type:'video'}])('requires safe explicit arguments %j',a=>expect(()=>validateArticleStatsArgs(a)).toThrow());
});
