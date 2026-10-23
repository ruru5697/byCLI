import {randomUUID} from 'node:crypto';
import {ArgumentError,CliError} from '@sovovs/bycli/errors';
import {waitFor} from '../_shared/video-prepare.js';

// Run in the current editor only. Video and gallery controls are intentionally distinct.
export function categoryState(type,index){
 const selector=type==='video'?'.channel-select-row .select':'.select.plugin-dropdown';
 const control=document.querySelectorAll(selector)[index];
 if(!control)return null;
 const list=control.querySelector('.select-list');
 const options=list?[...list.querySelectorAll('*')].filter(e=>!e.children.length&&e.textContent.trim()&&e.getBoundingClientRect().width>0).map(e=>e.textContent.trim()):[];
 const catalog=list?[...list.querySelectorAll('li')].map(e=>e.textContent.trim()).filter(Boolean):[];
 return {listOpen:!!list&&list.getBoundingClientRect().width>0&&list.getBoundingClientRect().height>0,selected:control.querySelector('.select-main .select-text,.select-text')?.innerText.trim()||'',options:[...new Set(options)],catalog:[...new Set(catalog)],loading:control.getAttribute('aria-busy')==='true'||!!control.querySelector('.loading,.el-loading-mask')?.getBoundingClientRect().width};
}
export async function openCategory(page,type,index){
 if(!['video','gallery'].includes(type)||![0,1].includes(index))throw new ArgumentError('Expected video/gallery category index 0/1');
 const scope=`[data-bycli-category="${index}"]`;
 const exists=await page.evaluate(`(()=>{const e=document.querySelectorAll(${JSON.stringify(type==='video'?'.channel-select-row .select':'.select.plugin-dropdown')})[${index}];e?.setAttribute('data-bycli-category','${index}');return !!e})()`);
 if(!exists)throw new CliError('CATEGORY_UNAVAILABLE','Category controls are not loaded in this content editor');
 const before=await page.evaluate(`(${categoryState.toString()})(${JSON.stringify(type)},${index})`);
 if(!before?.listOpen)await page.click(scope+' .select-main');
 const state=await waitFor(page,`(()=>{const s=(${categoryState.toString()})(${JSON.stringify(type)},${index});return s&&s.listOpen&&!s.loading&&s.options.length?s:false})()`,'current editor category options',15000);
 return {scope,...state};
}
export async function chooseCategory(page,type,index,label){
 const current=await page.evaluate(`(${categoryState.toString()})(${JSON.stringify(type)},${index})`);
 if(current?.selected===label)return;
 const state=await openCategory(page,type,index);
 if(!state.options.includes(label))throw new CliError('CATEGORY_NOT_FOUND',`Category ${label} is unavailable for ${type}; options: ${state.options.join(' / ')}`,'Use bycli sohu editor --categories to inspect this retained editor');
 const token=randomUUID();
 const count=await page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(state.scope+' .select-list')});const nodes=[...root.querySelectorAll('*')].filter(e=>!e.children.length&&e.textContent.trim()===${JSON.stringify(label)}&&e.getBoundingClientRect().width>0);if(nodes.length===1){nodes[0].setAttribute('data-bycli-category-option',${JSON.stringify(token)});nodes[0].scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});}return nodes.length})()`);
 if(count!==1)throw new CliError('CATEGORY_AMBIGUOUS','Expected exactly one matching category option');
 // Generic click scrolls the element again before measuring it. In the gallery's
 // scrolling dropdown that can move the menu after the option was positioned.
 // Keep the verified point and dispatch mouse input without another scroll.
 if(typeof page.nativeClickOnce==='function'||typeof page.nativeClick==='function'){
  const point=await page.evaluate(`(${categoryOptionPoint.toString()})(${JSON.stringify(state.scope)},${JSON.stringify(token)},${JSON.stringify(label)})`);
  if(!point)throw new CliError('CATEGORY_TARGET_OBSCURED','Category option is hidden, clipped, or covered; retained editor has not been clicked');
  if(typeof page.nativeClickOnce==='function')await page.nativeClickOnce(point.x,point.y);else await page.nativeClick(point.x,point.y);
 }else await page.click(`[data-bycli-category-option="${token}"]`);
 await waitFor(page,`(${categoryState.toString()})(${JSON.stringify(type)},${index})?.selected===${JSON.stringify(label)}`,'verified category selection',15000);
}
export function categoryOptionPoint(scope,token,label){
 const nodes=document.querySelectorAll(scope+' .select-list [data-bycli-category-option="'+token+'"]');
 if(nodes.length!==1||nodes[0].textContent.trim()!==label)return null;
 const e=nodes[0],r=e.getBoundingClientRect();
 if(r.width<=0||r.height<=0)return null;
 let left=Math.max(0,r.left),right=Math.min(innerWidth,r.left+r.width),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.top+r.height);
 for(let p=e.parentElement;p;p=p.parentElement){
  const style=getComputedStyle(p),box=p.getBoundingClientRect();
  if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,box.top);bottom=Math.min(bottom,box.top+box.height)}
  if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,box.left);right=Math.min(right,box.left+box.width)}
 }
 if(right-left<1||bottom-top<1)return null;
 const x=(left+right)/2;
 for(const y of [(top+bottom)/2,top+Math.min(2,(bottom-top)/4),bottom-Math.min(2,(bottom-top)/4)]){
  const hit=document.elementFromPoint(x,y);if(hit&&(hit===e||e.contains(hit)))return {x,y};
 }
 return null;
}
export async function selectSohuPrimary(page,type,label){
 const before=await page.evaluate(`({primary:(${categoryState.toString()})(${JSON.stringify(type)},0),secondary:(${categoryState.toString()})(${JSON.stringify(type)},1)})`);
 await chooseCategory(page,type,0,label);
 // Opening the dependent dropdown after the primary selection waits for its actual options.
 await page.evaluate(`(async()=>{const e=document.querySelector('[data-bycli-category="0"]');if(typeof e?.__vue__?.$nextTick==='function')await e.__vue__.$nextTick();return true})()`);
 // The dependent catalog can arrive in a later network/DOM update than the
 // primary label. Do not validate a secondary against the previous parent's list.
 if(before.primary?.selected!==label&&before.secondary?.catalog?.length){
  await waitFor(page,`(()=>{const s=(${categoryState.toString()})(${JSON.stringify(type)},1);return s&&!s.loading&&s.catalog.length&&JSON.stringify(s.catalog)!==${JSON.stringify(JSON.stringify(before.secondary.catalog))}})()`,'refreshed secondary category catalog',15000);
 }
}
export async function selectSohuCategory(page,type,labels){
 if(!Array.isArray(labels)||labels.length!==2||labels.some(x=>typeof x!=='string'||!x.trim()))throw new ArgumentError('category requires [primary, secondary]');
 await selectSohuPrimary(page,type,labels[0]);
 await chooseCategory(page,type,1,labels[1]);
}
