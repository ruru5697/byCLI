import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runWeiboImageDownload } from './image-download.js';
import {resolveWeiboImages} from './_image-download.js';
import {runInNewContext} from 'node:vm';
import './image-download.js';

describe('weibo image-download', () => {
  it('downloads every original image exposed by the status payload', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-weibo-images-'));
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ session: 'x', data: { id: '1', mblogid: 'A', urls: ['https://img.example/a.jpg', 'https://img.example/b.png'] } }) };
    const fetch = vi.fn().mockImplementation(async (url) => ({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer, headers: { get: () => url.endsWith('.png') ? 'image/png' : 'image/jpeg' } }));
    const rows = await runWeiboImageDownload(page, { id: 'A', output }, { fetch });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ index: 1, bytes: 3, contentType: 'image/jpeg' });
    expect(rows[1]).toMatchObject({ index: 2, contentType: 'image/png' });
    await fs.rm(output, { recursive: true, force: true });
  });
  it('resolves the observed mixed-media shape without downloading four video posters or claiming fourteen images', async () => {
    const pictures = Array.from({length:5},(_,i)=>({type:'pic',id:String(i),data:{original:{url:'https://wx1.sinaimg.cn/large/p'+i+'.jpg'}}}));
    const videos = Array.from({length:4},()=>({type:'video',data:{page_pic:{url:'https://wx1.sinaimg.cn/video-cover.jpg'},pic_info:{pic_big:{url:'https://wx1.sinaimg.cn/poster.jpg'}}}}));
    const status={idstr:'123',mblogid:'Rnwrr0kJy',pic_num:14,pic_ids:['0','1','2','3','4'],mix_media_info:{items:[...pictures.slice(0,4),videos[0],pictures[4],...videos.slice(1)]}};
    const output=await fs.mkdtemp(path.join(os.tmpdir(),'bycli-weibo-mixed-'));
    try {
      const page={goto:vi.fn(),wait:vi.fn(),evaluate:code=>runInNewContext(code,{fetch:async()=>({ok:true,status:200,json:async()=>status})})};
      const fetch=vi.fn(async()=>({ok:true,arrayBuffer:async()=>Uint8Array.from([0xff,0xd8,0xff,0xd9]).buffer,headers:{get:()=> 'image/jpeg'}}));
      const rows=await runWeiboImageDownload(page,{id:'Rnwrr0kJy',output},{fetch});
      expect(rows).toHaveLength(5);
      expect(fetch.mock.calls.map(([url])=>url)).toEqual(pictures.map(p=>p.data.original.url));
      expect(rows[0]).toMatchObject({resolved_image_count:5,reported_pic_num:14,mixed_video_count:4,count_matches_reported:false});
      expect(await fs.readdir(output)).toHaveLength(5);
    } finally { await fs.rm(output,{recursive:true,force:true}); }
  });
  it('keeps mixed picture order, deduplicates legacy entries, and handles an empty pic_ids array', () => {
    const a={original:{url:'https://wx1.sinaimg.cn/a.jpg'}},b={large:{url:'https://wx1.sinaimg.cn/b.jpg'}};
    expect(resolveWeiboImages({pic_ids:[],pic_infos:{a,b}}).urls).toEqual([a.original.url,b.large.url]);
    expect(resolveWeiboImages({pic_num:2,pic_ids:['a','b'],pic_infos:{a,b},mix_media_info:{items:[{type:'pic',data:b},{type:'pic',data:a}]}})).toMatchObject({urls:[b.large.url,a.original.url],resolved_image_count:2,count_matches_reported:true});
    expect(resolveWeiboImages({pic_num:1,mix_media_info:{items:[{type:'video',data:{original:{url:'https://wx1.sinaimg.cn/poster.jpg'}}}]}}).urls).toEqual([]);
  });

});
