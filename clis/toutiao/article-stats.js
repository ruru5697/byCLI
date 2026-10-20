import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, EmptyResultError } from '@sovovs/bycli/errors';

export async function runToutiaoArticleStats(page, kwargs) {
  const query = String(kwargs?.article ?? '').trim();
  if (!query) throw new ArgumentError('article URL, ID, or title is required');
  await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all?page=1');
  await page.wait({ time: 4 });
  const result = await page.evaluate(`
    (() => {
      const query = ${JSON.stringify(query)};
      const text = document.body.innerText || '';
      if (/登录|立即登录/.test(text) && !/作品管理/.test(text)) return { auth: false };
      const titleEl = [...document.querySelectorAll('*')].find(x => (x.innerText || '').trim() === query);
      const card = titleEl?.parentElement?.parentElement;
      const t = card?.innerText?.trim() || (text.includes(query) ? text.slice(Math.max(0, text.indexOf(query)), text.indexOf(query) + 220) : '');
      if (!t) return { found: false };
      const pick = (re) => (t.match(re)?.[1] ?? null);
      return { found: true, title: query, text: t, status: /审核中/.test(t)?'审核中':(/已发布/.test(t)?'已发布':null), impressions: pick(/展现[^0-9]*([0-9][0-9,]*)/), views: pick(/播放[^0-9]*([0-9][0-9,]*)/) || pick(/阅读[^0-9]*([0-9][0-9,]*)/), likes: pick(/点赞[^0-9]*([0-9][0-9,]*)/), comments: pick(/评论[^0-9]*([0-9][0-9,]*)/) };
    })()
  `);
  if (result?.auth === false) throw new AuthRequiredError('mp.toutiao.com');
  if (!result?.found) throw new EmptyResultError('toutiao article-stats', `No article matched: ${query}`);
  return [result];
}

export const articleStatsCommand = cli({ site:'toutiao', name:'article-stats', access:'read', description:'获取今日头条文章统计数据', domain:'mp.toutiao.com', strategy:Strategy.UI, browser:true, args:[{name:'article',type:'string',required:true,positional:true,help:'文章 URL、ID 或标题'}], columns:['title','status','impressions','views','likes','comments','text'], func:(page,kwargs)=>runToutiaoArticleStats(page,kwargs) });
