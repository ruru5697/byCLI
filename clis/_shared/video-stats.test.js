import {describe,it,expect,vi} from 'vitest';
import {metricValue,validateStatsArgs,statsAccount,openStatsPage} from './video-stats.js';
import {parseSingleList} from '../sohu/stats.js';
import {openManagerPage} from './video-site-submit.js';
import {parseReceipt} from './video-submit.js';
describe('metric semantics',()=>{
 it('preserves actual zero and does not turn unavailable into zero',()=>{expect(metricValue('点赞数','0')).toMatchObject({value:0,precision:'exact',availability:'available'});for(const raw of [null,undefined,'-','—',''])expect(metricValue('曝光数',raw).value).toBeNull();});
 it('distinguishes rounded counts, lower bounds and rates',()=>{expect(metricValue('阅读','1.2万')).toMatchObject({value:12000,precision:'rounded'});expect(metricValue('阅读','10w+')).toMatchObject({value:100000,precision:'lower_bound'});expect(metricValue('完播率','12.3%')).toMatchObject({value:12.3,unit:'percent'});expect(metricValue('观看时长','3.2秒')).toMatchObject({value:3.2,unit:'seconds'});expect(metricValue('阅读','暂无')).toMatchObject({value:null,reason:'unrecognized_format'});});
 it('rejects unsupported scope, content types and malformed IDs',()=>{expect(()=>validateStatsArgs('sohu',{'content-id':'1',type:'image'})).toThrow();expect(()=>validateStatsArgs('xiaohongshu',{'content-id':'wrong'})).toThrow();expect(()=>validateStatsArgs('xiaohongshu',{'content-id':'a'.repeat(24),scope:'account'})).toThrow();});
 it('refuses another account before returning metrics',async()=>{await expect(statsAccount({evaluate:vi.fn(async()=>({account:{id:'2'}}))},'sohu','1')).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});});
});
describe('signed Sohu single-video data isolation',()=>{
 const e={url:'https://mp.sohu.com/mpbp/bp/news/v4/users/stat/single/list?type=2&accountId=123&startDate=2026-10-12&endDate=2026-10-19&page=1',method:'GET',responseStatus:200,responsePreview:JSON.stringify({code:2000000,success:true,data:{news:[{newsId:456,type:4,pv:0}],totalCount:1}})};
 it('records the publication-date filter without claiming interval increments',()=>{expect(parseSingleList(e,'123')).toMatchObject({page:1,records:[{newsId:456,pv:0}],period:{kind:'publication_date_filter',start:'2026-10-12',end:'2026-10-19'}});});
 it.each([{method:'POST'},{responseStatus:403},{responseBodyTruncated:true},{url:e.url.replace('mp.sohu.com','evil.test')},{url:e.url.replace('type=2','type=0')},{responsePreview:'null'},{responsePreview:'{}'}])('rejects invalid captures %j',patch=>expect(parseSingleList({...e,...patch},'123')).toBeNull());
 it('refuses another account',()=>expect(parseSingleList(e,'other')).toBeNull());
});
describe('safe manager restoration',()=>{
 it('reopens from no remaining tabs without requiring the old editor',async()=>{const p={tabs:vi.fn(async()=>[]),setActivePage:vi.fn(),goto:vi.fn()};await openManagerPage(p,'sohu','old');expect(p.goto).toHaveBeenCalledWith('https://mp.sohu.com/mpfe/v4/contentManagement/first/page',{stealth:false});});
 it('does not navigate or replace the lease of a prepared editor',async()=>{const p={tabs:vi.fn(async()=>[{page:'editor',url:'https://mp.sohu.com/editor'}]),setActivePage:vi.fn(),evaluate:vi.fn(async()=>true),newTab:vi.fn(),goto:vi.fn()};await expect(openManagerPage(p,'sohu','editor')).rejects.toMatchObject({code:'EDITOR_IN_USE'});expect(p.goto).not.toHaveBeenCalled();expect(p.newTab).not.toHaveBeenCalled();});
 it('reuses an already open manager',async()=>{const p={tabs:vi.fn(async()=>[{page:'manager',url:'https://mp.sohu.com/mpfe/v4/contentManagement/first/page?x=1'}]),setActivePage:vi.fn(),evaluate:vi.fn(async()=>false),goto:vi.fn(),newTab:vi.fn()};await openManagerPage(p,'sohu','old');expect(p.goto).not.toHaveBeenCalled();expect(p.newTab).not.toHaveBeenCalled();});
});
describe('privacy-preserving receipt diagnosis',()=>{
 const entry=body=>({url:'https://creator.xiaohongshu.com/web_api/sns/v2/note',method:'POST',responseStatus:200,responsePreview:JSON.stringify(body)});
 it.each([null,[],true,'ok',123])('handles unexpected JSON without crashing or assuming acceptance: %j',body=>expect(parseReceipt('xiaohongshu',entry(body)).status).toBe('result_unknown'));
 it('retains only known structural keys and HTTP status',()=>{const result=parseReceipt('xiaohongshu',entry({data:{token:'secret'},access_token:'secret'}));expect(result).toMatchObject({status:'result_unknown',httpStatus:200,envelope:['data'],dataShape:'object'});expect(JSON.stringify(result)).not.toContain('secret');expect(JSON.stringify(result)).not.toContain('access_token');});
});

import vm from 'node:vm';
import {startReadCapture,waitReadCapture} from './read-response-capture.js';
describe('non-draining read-only observer',()=>{
 it('keeps a delayed response available across reads without duplicating requests',async()=>{
  let resolveBody;const pending=new Promise(resolve=>resolveBody=resolve);
  const fetch=vi.fn(async()=>({status:200,clone:()=>({text:()=>pending})}));
  class XHR{open(){}send(){}}
  const window={fetch};const context=vm.createContext({window,XMLHttpRequest:XHR,URL,location:{href:'https://mp.sohu.com/'}});
  const page={evaluate:async code=>vm.runInContext(code,context),wait:vi.fn()};
  await startReadCapture(page,'/single/list');
  await window.fetch('/single/list?accountId=123');
  expect(await page.evaluate('window.__bycliReadCapture.entries.length')).toBe(0);
  expect(await page.evaluate('window.__bycliReadCapture.entries.length')).toBe(0);
  resolveBody('{"value":0}');await Promise.resolve();await Promise.resolve();
  const rows=await waitReadCapture(page,e=>JSON.parse(e.responsePreview));
  expect(rows).toEqual([{value:0}]);expect(fetch).toHaveBeenCalledOnce();
  expect(await page.evaluate('window.__bycliReadCapture.entries.length')).toBe(1);
 });
 it('does not stack wrappers when resetting the capture buffer',async()=>{
  class XHR{open(){}send(){}}
  const native=vi.fn(async()=>({status:200,clone:()=>({text:async()=>'{"ok":true}'})}));const window={fetch:native};
  const context=vm.createContext({window,XMLHttpRequest:XHR,URL,location:{href:'https://mp.sohu.com/'}});
  const page={evaluate:async code=>vm.runInContext(code,context)};
  await startReadCapture(page,'/first');const wrapped=window.fetch;
  await startReadCapture(page,'/second');expect(window.fetch).toBe(wrapped);
  await window.fetch('/first');await Promise.resolve();expect(await page.evaluate('window.__bycliReadCapture.entries.length')).toBe(0);
  await window.fetch('/second');await Promise.resolve();await Promise.resolve();expect(await page.evaluate('window.__bycliReadCapture.entries.length')).toBe(1);
 });
});

describe('Sohu content editor retention for analytics',()=>{
 it.each(['addarticle','addatlas','addvideo'])('retains %s without replacing the lease',async suffix=>{const p={tabs:vi.fn(async()=>[{page:'editor',url:'https://mp.sohu.com/mpfe/v4/contentManagement/news/'+suffix}]),setActivePage:vi.fn(),goto:vi.fn(),newTab:vi.fn()};await expect(openStatsPage(p,'sohu','https://mp.sohu.com/mpfe/v4/data/analysis')).rejects.toMatchObject({code:'EDITOR_IN_USE'});expect(p.goto).not.toHaveBeenCalled();expect(p.newTab).not.toHaveBeenCalled();});
});
