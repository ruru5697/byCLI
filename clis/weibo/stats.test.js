import { describe, expect, it, vi } from 'vitest';
import {runInNewContext} from 'node:vm';
import { getRegistry } from '@sovovs/bycli/registry';
import { AuthRequiredError, EmptyResultError } from '@sovovs/bycli/errors';
import { runWeiboStats } from './stats.js';
import './stats.js';

describe('weibo stats commands', () => {
    it('registers all content-specific stats commands', () => {
        for (const name of ['short-stats', 'image-stats', 'video-stats', 'article-stats']) {
            const command = getRegistry().get(`weibo/${name}`);
            expect(command?.access).toBe('read');
            expect(command?.browser).toBe(true);
            expect(command?.columns).toContain('likes');
        }
    });

    it('maps stable engagement fields from the status endpoint', async () => {
        const page = {
            goto: vi.fn(), wait: vi.fn(),
            evaluate: vi.fn().mockResolvedValue({
                session: 'test',
                data: {
                    id: '123', url: 'https://weibo.com/u/m', author: 'alice',
                    created_at: 'today', content_type: 'video', reposts: 2,
                    comments: 3, likes: 4, collects: 5, views: null,
                },
            }),
        };
        await expect(runWeiboStats(page, { id: '123' }, 'video')).resolves.toEqual([expect.objectContaining({ id: '123', likes: 4, content_type: 'video' })]);
        expect(page.goto).toHaveBeenCalledWith('https://weibo.com');
    });

    it('surfaces authentication and missing-post states', async () => {
        const authPage = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ auth: true }) };
        await expect(runWeiboStats(authPage, { id: '1' })).rejects.toBeInstanceOf(AuthRequiredError);
        const missingPage = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ missing: true }) };
        await expect(runWeiboStats(missingPage, { id: '1' })).rejects.toBeInstanceOf(EmptyResultError);
    });
    it.each([
        [{}, {reposts:null,comments:null,likes:null,collects:null,views:null,video_plays:null}],
        [{reposts_count:0,comments_count:'0',attitudes_count:0,collect_count:0,read_count:0,play_count:0}, {reposts:0,comments:0,likes:0,collects:0,views:0,video_plays:0}],
        [{reposts_count:-1,comments_count:'',attitudes_count:true,collect_count:1.5,read_count:'1.2万',play_count:'bad'}, {reposts:null,comments:null,likes:null,collects:null,views:null,video_plays:null}],
        [{favorites_count:12,video_play_count:'123'}, {collects:12,video_plays:123}],
    ])('keeps endpoint metric absence distinct from real zero: %j', async (fields,expected) => {
        const status={idstr:'123',mblogid:'abc',user:{id:1,screen_name:'测试账号'},...fields};
        const page={goto:vi.fn(),wait:vi.fn(),evaluate:code=>runInNewContext(code,{fetch:async()=>({ok:true,status:200,json:async()=>status})})};
        const [row]=await runWeiboStats(page,{id:'123'});
        expect(row).toMatchObject(expected);
    });

    it.each([['video',{}],['image',{}],['article',{}],['video',{pic_num:1}]])('does not label another content type as requested %s', async (type,fields) => {
        const status={idstr:'123',mblogid:'abc',user:{id:1},...fields};
        const page={goto:vi.fn(),wait:vi.fn(),evaluate:code=>runInNewContext(code,{fetch:async()=>({ok:true,status:200,json:async()=>status})})};
        await expect(runWeiboStats(page,{id:'123'},type)).rejects.toMatchObject({code:'CONTENT_TYPE_MISMATCH'});
    });
    it.each([
        [{online_users:'4.3万次观看',online_users_number:43817},43817],
        [{online_users:'1.2万次观看',online_users_number:12272},12272],
        [{online_users:'0次观看',online_users_number:0},0],
        [{online_users:'当前在线人数',online_users_number:12272},null],
        [{online_users_number:12272},null],
        [{online_users:'4.3万次观看',online_users_number:'4.3万'},null],
    ])('uses the numeric video viewing counter only with its observed display label: %j', async (mediaInfo, expected) => {
        const status={idstr:'123',user:{id:1},page_info:{type:'video',media_info:mediaInfo}};
        const page={goto:vi.fn(),wait:vi.fn(),evaluate:code=>runInNewContext(code,{fetch:async()=>({ok:true,status:200,json:async()=>status})})};
        const [row]=await runWeiboStats(page,{id:'123'},'video');
        expect(row.video_plays).toBe(expected);
    });
    it.each([['video',{page_info:{type:'video'}},'video'],['image',{pic_num:1},'image'],['article',{isLongText:true},'article'],['short',{pic_num:1},'image']])('reports actual media for %s metrics', async (type,fields,actual) => {
        const status={idstr:'123',mblogid:'abc',user:{id:1},...fields};
        const page={goto:vi.fn(),wait:vi.fn(),evaluate:code=>runInNewContext(code,{fetch:async()=>({ok:true,status:200,json:async()=>status})})};
        const [row]=await runWeiboStats(page,{id:'123'},type);
        expect(row.content_type).toBe(actual);
    });

});
