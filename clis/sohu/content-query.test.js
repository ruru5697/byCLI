import {describe,it,expect,vi,beforeEach} from 'vitest';
import vm from 'node:vm';import {webcrypto} from 'node:crypto';
vi.mock('../_shared/video-stats.js',()=>({statsAccount:vi.fn()}));
vi.mock('../_shared/video-site-submit.js',()=>({openManagerPage:vi.fn()}));
vi.mock('../_shared/video-prepare.js',async original=>({...await original(),waitFor:vi.fn()}));
import {statsAccount} from '../_shared/video-stats.js';import {openManagerPage} from '../_shared/video-site-submit.js';
import {querySohuContent,selectedContentSettings} from './_content-submit.js';
const job={contentType:'article',preparedAccount:{id:'456',name:'账号'},receipt:{contentId:'123'}};
const row={contentId:'123',contentType:2,platformStatus:4,title:'story',link:'https://www.sohu.com/a/123_456'};
const page=()=>({goto:vi.fn(),focusWindow:vi.fn(),click:vi.fn(),wait:vi.fn(),evaluate:vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce([row])});
beforeEach(()=>{vi.clearAllMocks();statsAccount.mockResolvedValue({id:'456',name:'账号'});openManagerPage.mockResolvedValue(undefined)});
describe('owner content query account and editor guards',()=>{
 it('queries an exact historical submitted article without a review object',async()=>{const p=page();expect(await querySohuContent(p,job)).toMatchObject({status:'published',contentId:'123',contentType:'article',publicUrl:row.link});expect(statsAccount).toHaveBeenCalledTimes(2);});
 it('rejects an account switch before requesting a filter or reading any record',async()=>{const p=page();statsAccount.mockRejectedValue(Object.assign(Error('changed'),{code:'ACCOUNT_CHANGED'}));await expect(querySohuContent(p,job)).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});expect(p.click).not.toHaveBeenCalled();expect(p.evaluate).not.toHaveBeenCalled();});
 it('rejects an account switch after reading the records',async()=>{const p=page();statsAccount.mockResolvedValueOnce({id:'456'}).mockRejectedValueOnce(Object.assign(Error('changed'),{code:'ACCOUNT_CHANGED'}));await expect(querySohuContent(p,job)).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});});
 it('retains an editor when manager restoration refuses navigation',async()=>{const p=page();openManagerPage.mockRejectedValue(Object.assign(Error('retain'),{code:'EDITOR_IN_USE'}));await expect(querySohuContent(p,job)).rejects.toMatchObject({code:'EDITOR_IN_USE'});expect(p.goto).not.toHaveBeenCalled();});
 it('requires a verified receipt ID, account and all-content control',async()=>{const p=page();await expect(querySohuContent(p,{...job,receipt:{}})).rejects.toMatchObject({code:'CONTENT_ID_MISSING'});expect(p.goto).not.toHaveBeenCalled();const q=page();q.evaluate.mockReset().mockResolvedValue(0);await expect(querySohuContent(q,job)).rejects.toMatchObject({code:'MANAGER_UNAVAILABLE'});expect(q.click).not.toHaveBeenCalled();});
 it('does not turn a missing or wrong-type record into success',async()=>{const p=page();p.evaluate.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce([{...row,contentType:3}]);expect((await querySohuContent(p,job)).status).toBe('query_unavailable');});
});
describe('selected settings fingerprint',()=>{
 it('changes on selected settings without returning raw URLs or input values',async()=>{const option={__vue__:{sourceUrl:'https://cdn.test/?secret=value',topicIds:['topic']}},input={type:'text',value:'title',checked:false},editor={innerHTML:'<p>story</p>'};const context=vm.createContext({URL,TextEncoder,crypto:webcrypto,location:{href:'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?id=123'},document:{querySelector:()=>editor,querySelectorAll:selector=>selector==='.select-option'?[option]:selector==='.mp-check'?[]:[input]}});
 const first=await vm.runInContext(`(${selectedContentSettings.toString()})()`,context);expect(first.draftId).toBe('123');expect(first.settingsHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(first)).not.toContain('secret');option.__vue__.topicIds=['other'];const second=await vm.runInContext(`(${selectedContentSettings.toString()})()`,context);expect(second.settingsHash).not.toBe(first.settingsHash);editor.innerHTML='<p><a href="https://example.test">story</a></p>';const third=await vm.runInContext(`(${selectedContentSettings.toString()})()`,context);expect(third.settingsHash).not.toBe(second.settingsHash);});
});
