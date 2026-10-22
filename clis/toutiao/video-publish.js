import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';

function prepareVideoFile(video) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', video,
  ], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return video;
  let streams;
  try { streams = JSON.parse(probe.stdout || '{}')?.streams || []; } catch { return video; }
  const videoStreams = streams.filter(x => x?.codec_type === 'video');
  if (videoStreams.length <= 1) return video;
  const normalized = path.join(os.tmpdir(), `bycli-toutiao-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const mux = spawnSync('ffmpeg', [
    '-y', '-i', video, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', normalized,
  ], { encoding: 'utf8', windowsHide: true });
  if (mux.status !== 0 || !fs.existsSync(normalized)) {
    throw new CommandExecutionError('视频包含多个视频流，自动兼容转换失败；请提供仅含一个视频流的 MP4');
  }
  return normalized;
}

export async function runToutiaoVideoPublish(page, kwargs) {
  const video=String(kwargs?.video??'').trim(); const title=String(kwargs?.title??'').trim(); const cover=String(kwargs?.cover??'').trim();
  if(!video||!fs.existsSync(video)) throw new ArgumentError('video file is required and must exist'); if(!title) throw new ArgumentError('title is required');
  if (cover && !fs.existsSync(cover)) throw new ArgumentError('cover file must exist when provided');
  if(!kwargs?.execute) return [{status:'dry-run',title,video,message:'未执行发布；添加 --execute 才提交'}];
  if (!cover) throw new ArgumentError('cover file is required for execute; Toutiao video publishing requires a cover');
  const videoToUpload = prepareVideoFile(video);
  // Toutiao is a micro-frontend SPA. Navigating to the same URL repeatedly can
  // leave old upload components mounted, so clear the document before each
  // command and operate on one fresh publisher instance.
  await page.goto('https://mp.toutiao.com/'); await page.wait({time:1});
  await page.goto('https://mp.toutiao.com/profile_v4/xigua/upload-video'); await page.wait({time:4});
  if (typeof page.uploadFiles !== 'function') throw new CommandExecutionError('browser uploadFiles is unavailable');
  await page.uploadFiles('input[type="file"]', [videoToUpload], { nth: 0 });
  let ready = false;
  for (let i = 0; i < 24; i++) {
    const uploadState = await page.evaluate(`(()=>{
      const text = document.body.innerText.slice(-2000);
      const marker = '已上传:';
      const progress = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length).split('\\n')[0].trim() : '';
      const uploading = text.includes('上传中') || progress.startsWith('0B/');
      const completedBytes = Boolean(progress) && !progress.startsWith('0B/');
      const completedLabel = text.includes('上传成功') || text.includes('上传完成') || text.includes('解析完成');
      return { text, progress, uploading, ready: text.includes('发布设置') && (completedBytes || completedLabel) };
    })()`);
    if (uploadState?.ready && !uploadState?.uploading) { ready = true; break; }
    await page.wait({time:5});
  }
  if (!ready) throw new CommandExecutionError('视频上传未完成（页面仍显示 0B/上传中），未提交发布');
  if (cover) {
    // The second video input is for adding another video, not for the cover.
    // Open the cover editor first; it creates a separate image input only after
    // the user chooses “本地上传”.
    const openedCover = await page.evaluate(`(()=>{
      const visible = [...document.querySelectorAll('*')].filter(x =>
        (x.innerText || '').trim() === '上传封面' &&
        (()=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0})()
      ).pop();
      if (!visible) return false;
      (visible.closest('.fake-upload-trigger') || visible.parentElement || visible).click();
      return true;
    })()`);
    if (!openedCover) throw new CommandExecutionError('未找到上传封面入口');
    await page.wait({time:1});
    const choseLocal = await page.evaluate(`(()=>{
      const e=[...document.querySelectorAll('*')].filter(x =>
        (x.innerText || '').trim() === '本地上传' &&
        (()=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0})()
      ).pop();
      if (!e) return false;
      e.click();
      return true;
    })()`);
    if (!choseLocal) throw new CommandExecutionError('封面上传菜单未出现“本地上传”');
    await page.wait({time:1});
    const imageInput = await page.evaluate(`Boolean(document.querySelector('input[type="file"][accept*="image"]'))`);
    if (!imageInput) throw new CommandExecutionError('未找到封面图片输入框');
    await page.uploadFiles('input[type="file"][accept*="image"]', [cover], { nth: 0 });
    await page.wait({time:2});
    // Toutiao requires an explicit crop confirmation for local covers.
    await page.evaluate(`(()=>{
      const e=[...document.querySelectorAll('*')].filter(x =>
        (x.innerText || '').trim() === '完成裁剪' &&
        (()=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0})()
      ).pop();
      if (!e) return false; e.click(); return true;
    })()`);
    await page.wait({time:1});
    await page.evaluate(`(()=>{
      const buttons=[...document.querySelectorAll('button')].filter(x =>
        (x.innerText || '').trim() === '确定' &&
        (()=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0})()
      );
      const e=buttons[buttons.length-1];
      if (!e) return false; e.click(); return true;
    })()`);
    await page.wait({time:1});
    // Completing the crop opens a second confirmation dialog. Confirm it too;
    // otherwise the cover remains in the editor and the publish action is a
    // no-op.
    await page.evaluate(`(()=>{
      const buttons=[...document.querySelectorAll('button')].filter(x =>
        (x.innerText || '').trim() === '确定' &&
        (()=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0})()
      );
      const e=buttons[buttons.length-1];
      if (!e) return false; e.click(); return true;
    })()`);
    await page.wait({time:2});
  }
  // Toutiao requires a content declaration before accepting a video. For this
  // supplied AI-produced clip, select the AI-generation declaration when it
  // is present; otherwise select the first declaration control.
  await page.evaluate(`(()=>{
    const boxes=[...document.querySelectorAll('input[type="checkbox"]')];
    if (boxes.some(x=>x.checked)) return true;
    const labelText = (x) => [x.closest('label'), x.parentElement, x.parentElement?.parentElement]
      .map(y => y?.innerText || '').join(' ');
    const ai=boxes.find(x=>/AI生成|引用AI/.test(labelText(x)));
    const declaration=boxes.find(x=>!/视频生成图文/.test(labelText(x)));
    (ai||declaration||boxes[0])?.click();
    return Boolean(ai||declaration||boxes[0]);
  })()`);
  await page.wait({time:1});
  if (typeof page.fillText === 'function') await page.fillText('input[placeholder*="请输入 0～30 个字符"]', title, { nth: 0 });
  // Use the last visible native button: stale micro-frontend instances may
  // expose an older “发布” button before the active one.
  const submitted = await page.evaluate(`(()=>{
    const candidates=[...document.querySelectorAll('button,[role="button"]')]
      .filter(x=>(x.innerText||'').trim()==='发布')
      .filter(x=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0&&!x.disabled});
    const target=candidates[candidates.length-1];
    if(!target)return false;
    target.click();
    return true;
  })()`);
  if (!submitted) throw new CommandExecutionError('视频上传完成但发布按钮不可用');
  await page.wait({time:8});
  await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all?enter_from=left_menu');
  await page.wait({time:4});
  const verified = await page.evaluate(`document.body.innerText.includes(${JSON.stringify(title)})`);
  if (!verified) return [{status:'pending',title,video,message:'已完成上传并点击发布，但作品管理暂未出现，需稍后复查'}];
  const normalizedMessage = videoToUpload !== video ? '（已自动移除附加视频流后上传）' : '';
  return [{status:'published',title,video,message:`已发布并在作品管理中核验${normalizedMessage}`}];
}
export const videoPublishCommand=cli({site:'toutiao',name:'video-publish',access:'write',description:'发布今日头条视频（默认 dry-run）',domain:'mp.toutiao.com',strategy:Strategy.UI,browser:true,args:[{name:'title',type:'string',required:true,positional:true,help:'视频标题'},{name:'video',type:'string',required:true,help:'本地视频路径'},{name:'cover',type:'string',required:false,help:'可选封面图片路径'},{name:'execute',type:'boolean',default:false,help:'实际提交发布'}],columns:['status','title','video','message'],func:(page,kwargs)=>runToutiaoVideoPublish(page,kwargs)});
