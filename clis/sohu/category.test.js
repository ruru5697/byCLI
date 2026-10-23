import {describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {categoryState,selectSohuCategory,chooseCategory,categoryOptionPoint} from './_category.js';
import {validateContentManifest} from './_content-prepare.js';
import {validateManifest} from '../_shared/video-prepare.js';

function fixture(type){
 const dom=new JSDOM(`<div class="channel-select-row">${[0,1].map(i=>`<div class="select"><div class="select-main"><span class="select-text">${i?'请选择':'科技'}</span></div><ul class="select-list"></ul></div>`).join('')}</div><div class="select plugin-dropdown"><div class="select-main"><span class="select-text">搞笑</span></div><ul class="select-list"><li>互联网</li></ul></div>`,{runScripts:'outside-only'});
 const w=dom.window;Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
 const controls=[...w.document.querySelectorAll('.channel-select-row .select')];let scrolled=false;
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {width:100,height:24,left:0,top:this.textContent==='搞笑'&&!scrolled?1017:20}};
 w.HTMLElement.prototype.scrollIntoView=function(){scrolled=true};
 controls[0].querySelector('.select-list').innerHTML='<li>科技</li><li>搞笑</li>';
 controls[1].querySelector('.select-list').innerHTML='<li>手机</li><li>电脑</li><li>黑科技</li>';
 for(const c of controls)c.querySelector('.select-list').addEventListener('click',e=>{if(e.target.tagName!=='LI')return;if(e.target.textContent==='搞笑'&&!scrolled)throw Error('offscreen click');c.querySelector('.select-text').textContent=e.target.textContent;if(c===controls[0])controls[1].querySelector('.select-list').innerHTML=e.target.textContent==='搞笑'?'<li>综合</li>':'<li>手机</li><li>电脑</li><li>黑科技</li>'});
 const page={evaluate:async code=>w.eval(code),click:vi.fn(async selector=>w.document.querySelector(selector).click()),wait:vi.fn()};
 return {dom,page,w};
}
function galleryFixture(covered=false){
 // Structure retained from the real gallery editor's --inspect output.
 const dom=new JSDOM('<div class="select plugin-dropdown"><div class="select-main"><span class="select-text">科技</span><i class="iconfont mp-icon-down"></i></div><div class="select-list" style="display:none"><input placeholder="请搜索" style="display:none"><ul><li>科技</li><li>动漫</li></ul></div></div>',{runScripts:'outside-only'});
 const w=dom.window;let positioned=false;const scroll=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
 w.HTMLElement.prototype.scrollIntoView=function(options){scroll.push(options);positioned=options.behavior==='instant'};
 w.HTMLElement.prototype.getBoundingClientRect=function(){const hidden=this.closest('.select-list')?.style.display==='none';return {width:hidden?0:100,height:hidden?0:24,left:10,top:this.tagName==='LI'&&!positioned?9999:20}};
 const control=w.document.querySelector('.select'),list=control.querySelector('.select-list');
 control.querySelector('.select-main').addEventListener('click',()=>{list.style.display=list.style.display==='none'?'block':'none'});
 list.addEventListener('click',e=>{if(e.target.tagName!=='LI')return;control.querySelector('.select-text').textContent=e.target.textContent;list.style.display='none'});
 w.document.elementFromPoint=()=>covered?w.document.body:list.style.display==='none'?null:list.querySelector('[data-bycli-category-option]');
 const page={evaluate:async code=>w.eval(code),wait:vi.fn(),click:vi.fn(async selector=>{if(!selector.endsWith(' .select-main'))throw Error('generic click would scroll the category option again');w.document.querySelector(selector).click()}),nativeClickOnce:vi.fn(async(x,y)=>{w.document.elementFromPoint(x,y)?.click()})};
 return {dom,w,page,scroll};
}
describe('editor-specific categories and visible native target',()=>{
 it('never borrows the gallery secondary option for a video',async()=>{const f=fixture();try{await expect(selectSohuCategory(f.page,'video',['科技','互联网'])).rejects.toMatchObject({code:'CATEGORY_NOT_FOUND'});expect(f.w.eval(`(${categoryState.toString()})('video',1)`).options).toEqual(['手机','电脑','黑科技'])}finally{f.dom.window.close()}});
 it('scrolls a long-list option into view and then verifies its dependent selection',async()=>{const f=fixture();try{await selectSohuCategory(f.page,'video',['搞笑','综合']);expect(f.w.eval(`(${categoryState.toString()})('video',0)`).selected).toBe('搞笑');expect(f.w.eval(`(${categoryState.toString()})('video',1)`).selected).toBe('综合');expect(f.page.click.mock.calls.some(([selector])=>selector.endsWith(' .select-main'))).toBe(false)}finally{f.dom.window.close()}});
 it('selects a gallery option with one hit-tested mouse gesture and no second scroll',async()=>{const f=galleryFixture();try{await chooseCategory(f.page,'gallery',0,'动漫');expect(f.w.eval(`(${categoryState.toString()})('gallery',0)`).selected).toBe('动漫');expect(f.scroll).toEqual([{behavior:'instant',block:'center',inline:'nearest'}]);expect(f.page.nativeClickOnce).toHaveBeenCalledExactlyOnceWith(60,32);expect(f.page.click).toHaveBeenCalledExactlyOnceWith('[data-bycli-category="0"] .select-main')}finally{f.dom.window.close()}});
 it('leaves the gallery selection unchanged if another element covers the option',async()=>{const f=galleryFixture(true);try{await expect(chooseCategory(f.page,'gallery',0,'动漫')).rejects.toMatchObject({code:'CATEGORY_TARGET_OBSCURED'});expect(f.page.nativeClickOnce).not.toHaveBeenCalled();expect(f.w.eval(`(${categoryState.toString()})('gallery',0)`).selected).toBe('科技')}finally{f.dom.window.close()}});
 it('can click a visible edge when an overlay covers the option center',async()=>{const f=galleryFixture();try{const hit=f.w.document.elementFromPoint;f.w.document.elementFromPoint=(x,y)=>y>=30?f.w.document.body:hit(x,y);await chooseCategory(f.page,'gallery',0,'动漫');expect(f.page.nativeClickOnce).toHaveBeenCalledExactlyOnceWith(60,22);expect(f.w.eval(`(${categoryState.toString()})('gallery',0)`).selected).toBe('动漫')}finally{f.dom.window.close()}});
 it('uses the visible intersection with a clipping dropdown ancestor',()=>{const dom=new JSDOM('<div data-bycli-category="0"><div class="select-list" style="overflow-y:hidden;overflow-x:hidden"><li data-bycli-category-option="token">动漫</li></div></div>',{runScripts:'outside-only'});try{const w=dom.window,e=w.document.querySelector('li'),list=w.document.querySelector('.select-list');e.getBoundingClientRect=()=>({left:10,top:300,width:100,height:24});list.getBoundingClientRect=()=>({left:0,top:300,width:200,height:5});w.document.elementFromPoint=(x,y)=>y>=300&&y<305?e:w.document.body;expect(w.eval(`(${categoryOptionPoint.toString()})('[data-bycli-category="0"]','token','动漫')`)).toEqual({x:60,y:302.5})}finally{dom.window.close()}});
 it('does not click an already selected parent or reset its loaded child catalog',async()=>{const f=galleryFixture();try{await chooseCategory(f.page,'gallery',0,'科技');expect(f.page.click).not.toHaveBeenCalled();expect(f.page.nativeClickOnce).not.toHaveBeenCalled();expect(f.scroll).toEqual([])}finally{f.dom.window.close()}});
 it('waits for the dependent catalog after the primary label changes',async()=>{const dom=new JSDOM('<div class="channel-select-row"><div class="select"><div class="select-main"><span class="select-text">科技</span></div><ul class="select-list"><li>科技</li><li>搞笑</li></ul></div><div class="select"><div class="select-main"><span class="select-text">请选择</span></div><ul class="select-list"><li>科学</li></ul></div></div>',{runScripts:'outside-only'});try{const w=dom.window;Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:24,left:0,top:20});w.HTMLElement.prototype.scrollIntoView=()=>{};const controls=[...w.document.querySelectorAll('.select')];let pending=false;for(const c of controls)c.querySelector('.select-list').addEventListener('click',e=>{c.querySelector('.select-text').textContent=e.target.textContent;if(c===controls[0])pending=true});const p={evaluate:async code=>w.eval(code),click:vi.fn(async selector=>w.document.querySelector(selector).click()),wait:vi.fn(async()=>{if(pending){controls[1].querySelector('.select-list').innerHTML='<li>综合</li>';pending=false}})};await selectSohuCategory(p,'video',['搞笑','综合']);expect(p.wait).toHaveBeenCalled();expect(w.eval(`(${categoryState.toString()})('video',1)`).selected).toBe('综合')}finally{dom.window.close()}});
 it('allows discovery after upload without a guessed category in the input manifest',()=>{
  const m={video:'v.mp4',cover:'c.png',title:'一个视频标题',body:'一条视频简介',declaration:'含有AI生成内容',visibility:'public'};
  expect(validateManifest(m,'sohu').category).toBeUndefined();
  expect(validateContentManifest({title:m.title,cover:m.cover,declaration:m.declaration,visibility:'public',accountId:'1',images:[1,2,3].map(i=>({path:i+'.png',description:'配文'}))},'gallery').category).toBeUndefined();
 });
});
