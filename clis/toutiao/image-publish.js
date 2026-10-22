import fs from 'node:fs';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
const WEITOUTIAO_MAX_CHARS = 2000;
function loadArticleContent(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/m, '');
  text = text
    .replace(/^!\[[^\]]*\]\([^)]*\)\s*$/gm, '')
    .replace(/^!.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/[\*_`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new ArgumentError('content file is empty');
  return text;
}
function fitWeitoutiaoContent(text) {
  if (text.length <= WEITOUTIAO_MAX_CHARS) return { text, truncated: false };
  const initial = text.slice(0, WEITOUTIAO_MAX_CHARS);
  const boundary = Math.max(initial.lastIndexOf('\n\n'), initial.lastIndexOf('\n'));
  const fitted = (boundary > 800 ? initial.slice(0, boundary) : initial).trim();
  return { text: fitted, truncated: true };
}
function applyWeitoutiaoTitle(text, title) {
  const first = text.search(/\S/);
  if (first < 0) return title;
  const lineEnd = text.indexOf('\n', first);
  if (lineEnd < 0) return title;
  return `${title}${text.slice(lineEnd)}`.trim();
}
export async function runToutiaoImagePublish(page, kwargs) {
  const image = String(kwargs?.image ?? '').trim(); const title = String(kwargs?.title ?? '').trim(); const content = String(kwargs?.content ?? '').trim();
  if (!image || !fs.existsSync(image)) throw new ArgumentError('image file is required and must exist');
  if (!title) throw new ArgumentError('title is required');
  if (kwargs?.execute && (!content || !fs.existsSync(content))) throw new ArgumentError('content file is required for execute and must exist');
  const loadedBody = content ? loadArticleContent(content) : '';
  const fittedBody = fitWeitoutiaoContent(loadedBody);
  const body = applyWeitoutiaoTitle(fittedBody.text, title);
  if (!kwargs?.execute) return [{status:'dry-run',title,image,message:'未执行发布；添加 --execute 才提交'}];
  await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all?enter_from=left_menu');
  await page.wait({time:3});
  const beforeCount = await page.evaluate(`(()=>{const t=document.body.innerText; let n=0,i=0; while((i=t.indexOf(${JSON.stringify(title)},i))>=0){n++;i+=${JSON.stringify(title)}.length;} return n;})()`);
  await page.goto('https://mp.toutiao.com/profile_v4/weitoutiao/publish'); await page.wait({time:3});
  if (typeof page.fillText !== 'function') throw new CommandExecutionError('browser fillText is unavailable');
  await page.fillText('[contenteditable="true"]', body);
  const imageButtonClicked = await page.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].filter(x=>(x.innerText||'').trim()==='图片').filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0}).pop(); if(!e)return false; e.click(); return true})()`);
  if (!imageButtonClicked) throw new CommandExecutionError('微头条图片按钮不可用');
  await page.wait({time:1});
  if (typeof page.uploadFiles !== 'function') throw new CommandExecutionError('browser uploadFiles is unavailable');
  const fileInputCount = await page.evaluate(`document.querySelectorAll('input[type="file"]').length`);
  if (!fileInputCount) throw new CommandExecutionError('微头条图片选择器未打开；请在 Chrome 扩展详情中开启“允许访问文件网址”，重启 Chrome 后重试');
  await page.uploadFiles('input[type="file"]', [image], { nth: 0 });
  await page.wait({time:3});
  const submitted = await page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>(x.innerText||'').trim()==='发布'&&!x.disabled).filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0}).pop(); if(!b)return false; b.click(); return true})()`);
  if (!submitted) throw new CommandExecutionError('微头条发布按钮不可用，可能仍在上传图片或需要人工确认');
  await page.wait({time:6});
  await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all?enter_from=left_menu');
  await page.wait({time:4});
  const afterCount = await page.evaluate(`(()=>{const t=document.body.innerText; let n=0,i=0; while((i=t.indexOf(${JSON.stringify(title)},i))>=0){n++;i+=${JSON.stringify(title)}.length;} return n;})()`);
  if (afterCount <= beforeCount) return [{status:'pending',title,image,contentChars:body.length,message:'已点击发布，但作品管理暂未出现，未确认成功'}];
  const excerptMessage = fittedBody.truncated ? `（原文超过微头条 ${WEITOUTIAO_MAX_CHARS} 字限制，已按段落截取原文）` : '';
  return [{status:'published',title,image,contentChars:body.length,message:`已提交原文图文并在作品管理中核验${excerptMessage}`}];
}
export const imagePublishCommand=cli({site:'toutiao',name:'image-publish',access:'write',description:'发布今日头条原文图文（默认 dry-run）',domain:'mp.toutiao.com',strategy:Strategy.UI,browser:true,args:[{name:'title',type:'string',required:true,positional:true,help:'图文标题'},{name:'image',type:'string',required:true,help:'本地封面图片路径'},{name:'content',type:'string',required:false,help:'原始 Markdown 文章路径（execute 时必填）'},{name:'execute',type:'boolean',default:false,help:'实际提交发布'}],columns:['status','title','image','contentChars','message'],func:(page,kwargs)=>runToutiaoImagePublish(page,kwargs)});
